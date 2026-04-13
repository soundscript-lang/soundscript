import { dirname, extname, join, relative } from '../platform/path.ts';
import ts from 'typescript';

import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import {
  formatDiagnostics,
  hasErrorDiagnostics,
  type MergedDiagnostic,
  toMergedDiagnostic,
} from '../checker/diagnostics.ts';
import {
  collectSoundscriptRootNames,
  getConfigFileParsingDiagnostics,
  loadConfig,
  resolveExpansionEnabled,
  type RuntimeTarget,
} from '../project/config.ts';
import { createBuiltinExpandedProgram } from './builtin_macro_support.ts';
import {
  createMacroDebugSnapshot,
  type MacroDebugStage,
  readMacroDebugStageText,
} from './macro_debug.ts';
import { MacroError } from './macro_errors.ts';
import { makeDirectory, writeTextFile } from '../platform/host.ts';
import { toSourceFileName } from './project_frontend.ts';

export interface ExpandProjectOptions {
  expansionEnabled?: boolean;
  filePath?: string;
  outDir: string;
  projectPath: string;
  stage?: MacroDebugStage;
  target?: RuntimeTarget;
  trace?: boolean;
  workingDirectory: string;
}

export interface ExpandProjectArtifacts {
  emittedFiles: string[];
  outDir: string;
}

export interface ExpandProjectResult {
  artifacts?: ExpandProjectArtifacts;
  diagnostics: MergedDiagnostic[];
  exitCode: number;
  output: string;
}

function createCliDiagnostic(
  code: string,
  message: string,
  filePath?: string,
  hint?: string,
): MergedDiagnostic {
  return {
    source: 'cli',
    code,
    category: 'error',
    message,
    hint,
    filePath,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function createMacroDiagnostic(error: MacroError): MergedDiagnostic {
  return {
    source: 'cli',
    code: error.code,
    category: 'error',
    message: error.message,
    filePath: error.filePath,
    line: error.line,
    column: error.column,
    endLine: error.endLine,
    endColumn: error.endColumn,
  };
}

function toOutputPath(projectDirectory: string, fileName: string, outDir: string): string {
  const relativePath = relative(projectDirectory, fileName);
  const safeRelativePath = relativePath.startsWith('..')
    ? fileName.split('/').at(-1)!
    : relativePath;
  const extension = extname(safeRelativePath);
  const outputRelativePath = extension === '.sts'
    ? `${safeRelativePath.slice(0, -extension.length)}.ts`
    : safeRelativePath;
  return join(outDir, outputRelativePath);
}

function renderExpandOutput(artifacts: ExpandProjectArtifacts, projectPath: string): string {
  const artifactBaseDirectory = dirname(projectPath);
  const renderedFiles = artifacts.emittedFiles
    .map((filePath) => `  ${relative(artifactBaseDirectory, filePath)}`)
    .join('\n');

  return [
    `Expanded TypeScript: ${relative(artifactBaseDirectory, artifacts.outDir)}`,
    renderedFiles,
    '',
  ].join('\n');
}

function renderExpandedFileDebugOutput(
  expandedProgram: ReturnType<typeof createBuiltinExpandedProgram>,
  options: ExpandProjectOptions,
): ExpandProjectResult {
  const requestedFilePath = options.filePath!;
  const snapshot = createMacroDebugSnapshot({
    diagnosticPreparedFiles: expandedProgram.diagnosticPreparedFiles,
    filePath: requestedFilePath,
    macroEnvironment: expandedProgram.macroEnvironment,
    preparedProgram: expandedProgram.preparedProgram,
    program: expandedProgram.program,
  });
  if (!snapshot) {
    const diagnostics = [
      createCliDiagnostic(
        'SOUNDSCRIPT_CLI_EXPAND_FILE_NOT_FOUND',
        `File is not part of the expanded project: ${requestedFilePath}`,
        requestedFilePath,
        'Pass a file that is included by the selected tsconfig.json, or update the project include/files settings first.',
      ),
    ];
    return {
      diagnostics,
      exitCode: 1,
      output: formatDiagnostics(diagnostics, options.workingDirectory),
    };
  }

  const stage = options.stage ?? 'expanded';
  const stageText = readMacroDebugStageText(snapshot, stage);
  return {
    diagnostics: [],
    exitCode: 0,
    output: options.trace
      ? `${
        JSON.stringify(
          {
            filePath: requestedFilePath,
            stage,
            text: stageText,
            traces: snapshot.traces,
          },
          null,
          2,
        )
      }\n`
      : `${stageText}${stageText.endsWith('\n') ? '' : '\n'}`,
  };
}

export async function expandProject(options: ExpandProjectOptions): Promise<ExpandProjectResult> {
  const loadedConfig = loadConfig(options.projectPath, { target: options.target });
  const expansionEnabled = resolveExpansionEnabled(
    options.expansionEnabled,
    loadedConfig.soundscript,
  );
  const soundscriptRootNames = collectSoundscriptRootNames(options.projectPath, loadedConfig);
  const expandedProgram = createBuiltinExpandedProgram({
    baseHost: createSoundStdlibCompilerHost(
      loadedConfig.commandLine.options,
      dirname(options.projectPath),
    ),
    configFileParsingDiagnostics: getConfigFileParsingDiagnostics(
      loadedConfig.diagnostics,
      soundscriptRootNames,
    ),
    configuredSoundscriptFileNames: loadedConfig.soundscriptConfiguredFileNames,
    expansionEnabled,
    options: loadedConfig.commandLine.options,
    projectReferences: loadedConfig.commandLine.projectReferences,
    runtime: loadedConfig.runtime,
    rootNames: [
      ...new Set([
        ...loadedConfig.commandLine.fileNames,
        ...soundscriptRootNames,
      ]),
    ],
  });
  try {
    const diagnostics: MergedDiagnostic[] = [
      ...expandedProgram.frontendDiagnostics(),
      ...ts.getPreEmitDiagnostics(expandedProgram.program).map(toMergedDiagnostic),
    ];
    if (hasErrorDiagnostics(diagnostics)) {
      return {
        diagnostics,
        exitCode: 1,
        output: formatDiagnostics(diagnostics, options.workingDirectory),
      };
    }

    try {
      void expandedProgram.program.getTypeChecker();
    } catch (error) {
      const macroDiagnostics = error instanceof MacroError ? [createMacroDiagnostic(error)] : [];
      const merged = [...diagnostics, ...macroDiagnostics];
      return {
        diagnostics: merged,
        exitCode: 1,
        output: error instanceof MacroError
          ? formatDiagnostics(merged, options.workingDirectory)
          : String(error),
      };
    }

    if (options.filePath) {
      return renderExpandedFileDebugOutput(expandedProgram, options);
    }

    await makeDirectory(options.outDir);
    const projectDirectory = dirname(options.projectPath);
    const printer = ts.createPrinter();
    const emittedFiles: string[] = [];

    for (const sourceFile of expandedProgram.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) {
        continue;
      }

      const sourceFileName = toSourceFileName(sourceFile.fileName);
      const outputPath = toOutputPath(projectDirectory, sourceFileName, options.outDir);
      await makeDirectory(dirname(outputPath));
      const outputText = printer.printFile(sourceFile);
      await writeTextFile(outputPath, outputText);
      emittedFiles.push(outputPath);
    }

    return {
      artifacts: {
        emittedFiles,
        outDir: options.outDir,
      },
      diagnostics,
      exitCode: 0,
      output: renderExpandOutput({ emittedFiles, outDir: options.outDir }, options.projectPath),
    };
  } finally {
    expandedProgram.dispose();
  }
}
