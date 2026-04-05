import ts from 'typescript';
import { dirname, relative } from '../platform/path.ts';

import { createAnnotationLookup } from '../annotation_syntax.ts';
import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import {
  type CompilerDiagnostic,
  type DiagnosticRelatedInformation,
  formatDiagnostics,
  getNodeDiagnosticRange,
  hasErrorDiagnostics,
  type MergedDiagnostic,
  remapDiagnosticFilePaths,
  toMergedDiagnostic,
} from '../checker/diagnostics.ts';
import {
  COMPILER_DIAGNOSTIC_CODES,
  COMPILER_DIAGNOSTIC_MESSAGES,
} from '../checker/engine/diagnostic_codes.ts';
import { createAnalysisContext } from '../checker/engine/context.ts';
import { runSoundAnalysis } from '../checker/rules/index.ts';
import { runUniversalPolicyAnalysis } from '../checker/rules/universal.ts';
import {
  collectSoundscriptRootNames,
  getConfigFileParsingDiagnostics,
  loadConfig,
  type RuntimeContext,
  type RuntimeTarget,
} from '../config.ts';
import { createBuiltinExpandedProgram } from '../frontend/builtin_macro_support.ts';
import {
  getLineAndCharacterOfPosition,
  getPositionOfLineAndCharacter,
  mapProgramEnclosingRangeToSource,
  type PreparedSourceFile,
  toSourceFileName,
} from '../frontend/project_frontend.ts';
import { CompilerUnsupportedError } from './errors.ts';
import { lowerProgramToCompilerIR, validateHonestHeapBoundarySurfaces } from './lower.ts';
import {
  CompilerToolchainError,
  type CompilerToolchainResult,
  packageCompilerOutput,
} from './toolchain.ts';
import { emitCompilerModuleToWat } from './wat_emitter.ts';

export interface CompileProjectOptions {
  projectPath: string;
  target?: RuntimeTarget;
  workingDirectory: string;
}

export interface CompileProjectResult {
  artifacts?: CompileArtifacts;
  diagnostics: MergedDiagnostic[];
  output: string;
  exitCode: number;
}

export interface CompileArtifacts {
  declarationsPath?: string;
  runtimePath?: string;
  wasmPath?: string;
  watPath: string;
  wrapperPath?: string;
}

function renderCompilerToolchainOutput(
  toolchain: CompilerToolchainResult,
  projectPath: string,
): string {
  const artifactBaseDirectory = dirname(projectPath);
  const lines = [`WAT: ${relative(artifactBaseDirectory, toolchain.watPath)}`];
  if (toolchain.wasmPath) {
    lines.push(`WASM: ${relative(artifactBaseDirectory, toolchain.wasmPath)}`);
  }
  if (toolchain.runtimePath) {
    lines.push(`Runtime: ${relative(artifactBaseDirectory, toolchain.runtimePath)}`);
  }
  if (toolchain.wrapperPath) {
    lines.push(`Wrapper: ${relative(artifactBaseDirectory, toolchain.wrapperPath)}`);
  }
  if (toolchain.declarationsPath) {
    lines.push(`Types: ${relative(artifactBaseDirectory, toolchain.declarationsPath)}`);
  }
  return `${lines.join('\n')}\n`;
}

function createCompilerDiagnostic(
  projectPath: string,
  overrides?: Partial<Pick<CompilerDiagnostic, 'code' | 'message' | 'hint' | 'notes'>>,
): CompilerDiagnostic {
  return {
    source: 'compiler',
    code: overrides?.code ?? COMPILER_DIAGNOSTIC_CODES.unsupportedCompilerSubset,
    category: 'error',
    message: overrides?.message ?? COMPILER_DIAGNOSTIC_MESSAGES.unsupportedCompilerSubset,
    hint: overrides?.hint,
    notes: overrides?.notes,
    filePath: projectPath,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function createCompilerDiagnosticForNode(
  node: ts.Node,
  overrides?: Partial<Pick<CompilerDiagnostic, 'code' | 'message' | 'hint' | 'notes'>>,
): CompilerDiagnostic {
  return {
    source: 'compiler',
    code: overrides?.code ?? COMPILER_DIAGNOSTIC_CODES.unsupportedCompilerSubset,
    category: 'error',
    message: overrides?.message ?? COMPILER_DIAGNOSTIC_MESSAGES.unsupportedCompilerSubset,
    hint: overrides?.hint,
    notes: overrides?.notes,
    ...getNodeDiagnosticRange(node),
  };
}

function remapDiagnostics<T extends MergedDiagnostic>(diagnostics: readonly T[]): T[] {
  return diagnostics.map((diagnostic) => remapDiagnosticFilePaths(diagnostic, toSourceFileName));
}

function hasRelatedInformation(
  diagnostic: MergedDiagnostic | DiagnosticRelatedInformation,
): diagnostic is MergedDiagnostic {
  return 'relatedInformation' in diagnostic;
}

function remapPreparedDiagnosticRange<T extends MergedDiagnostic | DiagnosticRelatedInformation>(
  diagnostic: T,
  preparedFile: PreparedSourceFile | undefined,
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>,
): T {
  const remappedFilePath = diagnostic.filePath
    ? toSourceFileName(diagnostic.filePath)
    : diagnostic.filePath;

  if (
    !preparedFile ||
    !diagnostic.filePath ||
    diagnostic.line === undefined ||
    diagnostic.column === undefined
  ) {
    const remappedDiagnostic = {
      ...diagnostic,
      filePath: remappedFilePath,
    } as T;
    if (hasRelatedInformation(diagnostic)) {
      (remappedDiagnostic as MergedDiagnostic).relatedInformation = diagnostic.relatedInformation?.map(
        (relatedInformation) =>
          remapPreparedDiagnosticRange(
            relatedInformation,
            relatedInformation.filePath
              ? diagnosticPreparedFiles.get(toSourceFileName(relatedInformation.filePath))
              : undefined,
            diagnosticPreparedFiles,
          ),
      );
    }
    return remappedDiagnostic;
  }

  const programStart = getPositionOfLineAndCharacter(
    preparedFile.rewrittenText,
    diagnostic.line - 1,
    diagnostic.column - 1,
  );
  const programEnd = diagnostic.endLine !== undefined && diagnostic.endColumn !== undefined
    ? getPositionOfLineAndCharacter(
      preparedFile.rewrittenText,
      diagnostic.endLine - 1,
      diagnostic.endColumn - 1,
    )
    : programStart;
  const mappedRange = mapProgramEnclosingRangeToSource(preparedFile, programStart, programEnd);
  const mappedStart = getLineAndCharacterOfPosition(preparedFile.originalText, mappedRange.start);
  const mappedEnd = getLineAndCharacterOfPosition(preparedFile.originalText, mappedRange.end);

  const remappedDiagnostic = {
    ...diagnostic,
    filePath: remappedFilePath,
    line: mappedStart.line + 1,
    column: mappedStart.character + 1,
    endLine: mappedEnd.line + 1,
    endColumn: mappedEnd.character + 1,
  } as T;
  if (hasRelatedInformation(diagnostic)) {
    (remappedDiagnostic as MergedDiagnostic).relatedInformation = diagnostic.relatedInformation?.map(
      (relatedInformation) => {
        const relatedPreparedFile = relatedInformation.filePath
          ? diagnosticPreparedFiles.get(toSourceFileName(relatedInformation.filePath))
          : undefined;
        return remapPreparedDiagnosticRange(
          relatedInformation,
          relatedPreparedFile,
          diagnosticPreparedFiles,
        );
      },
    );
  }
  return remappedDiagnostic;
}

function remapSoundDiagnostics<T extends MergedDiagnostic>(
  diagnostics: readonly T[],
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>,
): T[] {
  return diagnostics.map((diagnostic) => {
    const preparedFile = diagnostic.filePath
      ? diagnosticPreparedFiles.get(toSourceFileName(diagnostic.filePath))
      : undefined;
    return remapPreparedDiagnosticRange(diagnostic, preparedFile, diagnosticPreparedFiles);
  });
}

function remapCompilerDiagnostics<T extends MergedDiagnostic>(
  diagnostics: readonly T[],
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>,
): T[] {
  return diagnostics.map((diagnostic) => {
    const preparedFile = diagnostic.filePath
      ? diagnosticPreparedFiles.get(toSourceFileName(diagnostic.filePath))
      : undefined;
    return remapPreparedDiagnosticRange(diagnostic, preparedFile, diagnosticPreparedFiles);
  });
}

function createProgram(options: CompileProjectOptions): {
  analysisPreparedProgram: {
    toProgramFileName(fileName: string): string;
  };
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>;
  dispose: () => void;
  frontendDiagnostics: readonly MergedDiagnostic[];
  program: ts.Program;
  runtime: RuntimeContext;
  tsDiagnosticPrograms: readonly {
    filePaths?: readonly string[];
    program: ts.Program;
  }[];
} {
  const loadedConfig = loadConfig(options.projectPath, { target: options.target });
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
    numericLoweringTarget: 'wasm',
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

  return {
    analysisPreparedProgram: expandedProgram.analysisPreparedProgram,
    diagnosticPreparedFiles: expandedProgram.diagnosticPreparedFiles,
    dispose: () => expandedProgram.dispose(),
    frontendDiagnostics: remapDiagnostics(expandedProgram.frontendDiagnostics()),
    program: expandedProgram.program,
    runtime: loadedConfig.runtime,
    tsDiagnosticPrograms: expandedProgram.tsDiagnosticPrograms,
  };
}

function refineMappedRangeToMatchingText(
  originalText: string,
  mappedRange: { intersectsReplacement: boolean; start: number; end: number },
  diagnosticText: string,
  rawLineText: string,
): { intersectsReplacement: boolean; start: number; end: number } {
  if (
    mappedRange.intersectsReplacement ||
    diagnosticText.length === 0 ||
    diagnosticText.includes('\n') ||
    diagnosticText.includes('\r')
  ) {
    return mappedRange;
  }

  if (originalText.slice(mappedRange.start, mappedRange.end) === diagnosticText) {
    return mappedRange;
  }

  const lineStart = originalText.lastIndexOf('\n', mappedRange.start - 1) + 1;
  const nextNewline = originalText.indexOf('\n', mappedRange.start);
  const lineEnd = nextNewline === -1 ? originalText.length : nextNewline;
  const lineText = originalText.slice(lineStart, lineEnd);
  if (lineText !== rawLineText) {
    return mappedRange;
  }

  let bestStart: number | undefined;
  let searchIndex = lineText.indexOf(diagnosticText);
  while (searchIndex !== -1) {
    const candidateStart = lineStart + searchIndex;
    if (
      bestStart === undefined ||
      Math.abs(candidateStart - mappedRange.start) < Math.abs(bestStart - mappedRange.start)
    ) {
      bestStart = candidateStart;
    }
    searchIndex = lineText.indexOf(diagnosticText, searchIndex + 1);
  }

  if (bestStart === undefined) {
    return mappedRange;
  }

  return {
    intersectsReplacement: false,
    start: bestStart,
    end: bestStart + diagnosticText.length,
  };
}

function remapMergedDiagnosticRange<T extends MergedDiagnostic | DiagnosticRelatedInformation>(
  mergedDiagnostic: T,
  diagnostic: ts.Diagnostic | ts.DiagnosticRelatedInformation,
  preparedFile: PreparedSourceFile | undefined,
): T {
  if (!preparedFile || !diagnostic.file || diagnostic.start === undefined) {
    return mergedDiagnostic;
  }

  const diagnosticLength = diagnostic.length ?? 0;
  const diagnosticText = diagnostic.file.text.slice(
    diagnostic.start,
    diagnostic.start + diagnosticLength,
  );
  const rawLineStartsAt = diagnostic.file.text.lastIndexOf('\n', diagnostic.start - 1) + 1;
  const rawNextNewline = diagnostic.file.text.indexOf('\n', diagnostic.start);
  const rawLineEndsAt = rawNextNewline === -1 ? diagnostic.file.text.length : rawNextNewline;
  const rawLineText = diagnostic.file.text.slice(rawLineStartsAt, rawLineEndsAt);
  const mappedRange = mapProgramEnclosingRangeToSource(
    preparedFile,
    diagnostic.start,
    diagnostic.start + diagnosticLength,
  );
  const refinedRange = refineMappedRangeToMatchingText(
    preparedFile.originalText,
    mappedRange,
    diagnosticText,
    rawLineText,
  );
  const mappedStart = getLineAndCharacterOfPosition(preparedFile.originalText, refinedRange.start);
  const mappedEnd = getLineAndCharacterOfPosition(preparedFile.originalText, refinedRange.end);

  return {
    ...mergedDiagnostic,
    filePath: mergedDiagnostic.filePath
      ? toSourceFileName(mergedDiagnostic.filePath)
      : mergedDiagnostic.filePath,
    line: mappedStart.line + 1,
    column: mappedStart.character + 1,
    endLine: mappedEnd.line + 1,
    endColumn: mappedEnd.character + 1,
  } as T;
}

function toMappedMergedDiagnostic(
  diagnostic: ts.Diagnostic,
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>,
): MergedDiagnostic {
  const mergedDiagnostic = toMergedDiagnostic(diagnostic);
  const preparedFile = diagnostic.file
    ? diagnosticPreparedFiles.get(toSourceFileName(diagnostic.file.fileName))
    : undefined;
  const remapped = remapMergedDiagnosticRange(mergedDiagnostic, diagnostic, preparedFile);
  if (!mergedDiagnostic.relatedInformation || !diagnostic.relatedInformation) {
    return remapped as MergedDiagnostic;
  }

  return {
    ...(remapped as MergedDiagnostic),
    relatedInformation: mergedDiagnostic.relatedInformation.map((relatedInformation, index) => {
      const relatedDiagnostic = diagnostic.relatedInformation?.[index];
      const relatedPreparedFile = relatedDiagnostic?.file
        ? diagnosticPreparedFiles.get(toSourceFileName(relatedDiagnostic.file.fileName))
        : undefined;
      return remapMergedDiagnosticRange(
        relatedInformation,
        relatedDiagnostic ?? diagnostic,
        relatedPreparedFile,
      ) as DiagnosticRelatedInformation;
    }),
  };
}

function collectTsDiagnostics(
  analysisPreparedProgram: {
    toProgramFileName(fileName: string): string;
  },
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>,
  tsDiagnosticPrograms: readonly {
    filePaths?: readonly string[];
    program: ts.Program;
  }[],
): readonly MergedDiagnostic[] {
  const handledFilePaths = new Set(
    tsDiagnosticPrograms.flatMap((diagnosticProgram) =>
      diagnosticProgram.filePaths ? [...diagnosticProgram.filePaths] : []
    ),
  );
  const diagnostics = tsDiagnosticPrograms.flatMap((diagnosticProgram) => {
    if (!diagnosticProgram.filePaths || diagnosticProgram.filePaths.length === 0) {
      return ts.getPreEmitDiagnostics(diagnosticProgram.program).filter((diagnostic) =>
        !diagnostic.file ||
        !handledFilePaths.has(toSourceFileName(diagnostic.file.fileName))
      );
    }

    return diagnosticProgram.filePaths.flatMap((diagnosticFilePath) => {
      const programFileName = analysisPreparedProgram.toProgramFileName(diagnosticFilePath);
      const diagnosticSourceFile = diagnosticProgram.program.getSourceFile(programFileName);
      return diagnosticSourceFile
        ? ts.getPreEmitDiagnostics(diagnosticProgram.program, diagnosticSourceFile)
        : [];
    });
  });

  return diagnostics.map((diagnostic) =>
    toMappedMergedDiagnostic(diagnostic, diagnosticPreparedFiles)
  );
}

function collectDiagnostics(
  analysisPreparedProgram: {
    toProgramFileName(fileName: string): string;
  },
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>,
  program: ts.Program,
  runtime: RuntimeContext,
  tsDiagnosticPrograms: readonly {
    filePaths?: readonly string[];
    program: ts.Program;
  }[],
  workingDirectory: string,
  frontendDiagnostics: readonly MergedDiagnostic[],
): MergedDiagnostic[] {
  if (hasErrorDiagnostics(frontendDiagnostics)) {
    return [...frontendDiagnostics];
  }

  const tsDiagnostics = collectTsDiagnostics(
    analysisPreparedProgram,
    diagnosticPreparedFiles,
    tsDiagnosticPrograms,
  );
  const analysisContext = createAnalysisContext({
    program,
    runtime,
    workingDirectory,
    includeSourceFile: (sourceFile) => !sourceFile.isDeclarationFile,
  });
  const universalDiagnostics = remapSoundDiagnostics(
    runUniversalPolicyAnalysis(analysisContext),
    diagnosticPreparedFiles,
  );
  if (hasErrorDiagnostics(tsDiagnostics)) {
    return [...frontendDiagnostics, ...tsDiagnostics, ...universalDiagnostics];
  }

  return [
    ...frontendDiagnostics,
    ...tsDiagnostics,
    ...universalDiagnostics,
    ...remapSoundDiagnostics(runSoundAnalysis(analysisContext), diagnosticPreparedFiles),
  ];
}

function findUnsupportedValueClass(program: ts.Program): ts.ClassDeclaration | undefined {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }

    const annotationLookup = createAnnotationLookup(sourceFile);
    let found: ts.ClassDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (found) {
        return;
      }
      if (
        ts.isClassDeclaration(node) &&
        annotationLookup.hasAttachedAnnotation(node, 'value')
      ) {
        found = node;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (found) {
      return found;
    }
  }

  return undefined;
}

export function compileProject(options: CompileProjectOptions): CompileProjectResult {
  const {
    analysisPreparedProgram,
    diagnosticPreparedFiles,
    frontendDiagnostics,
    program,
    runtime,
    dispose,
    tsDiagnosticPrograms,
  } = createProgram(options);
  try {
    const diagnostics = collectDiagnostics(
      analysisPreparedProgram,
      diagnosticPreparedFiles,
      program,
      runtime,
      tsDiagnosticPrograms,
      options.workingDirectory,
      frontendDiagnostics,
    );

    if (hasErrorDiagnostics(diagnostics)) {
      return {
        diagnostics,
        output: formatDiagnostics(diagnostics, options.workingDirectory),
        exitCode: 1,
      };
    }

    const unsupportedValueClass = findUnsupportedValueClass(program);
    if (unsupportedValueClass) {
      const compilerDiagnostics = remapCompilerDiagnostics([
        createCompilerDiagnosticForNode(unsupportedValueClass, {
          code: COMPILER_DIAGNOSTIC_CODES.valueClassesRequireJsEmit,
          message: COMPILER_DIAGNOSTIC_MESSAGES.valueClassesRequireJsEmit,
          hint:
            'Use `soundscript build`, `soundscript node`, or another JS emit path for `#[value]`, or remove the annotation before compiling to Wasm.',
        }),
      ], diagnosticPreparedFiles);
      return {
        diagnostics: compilerDiagnostics,
        output: formatDiagnostics(compilerDiagnostics, options.workingDirectory),
        exitCode: 1,
      };
    }

    try {
      validateHonestHeapBoundarySurfaces(program);
      const module = lowerProgramToCompilerIR(program, dirname(options.projectPath));
      const wat = emitCompilerModuleToWat(module);
      const toolchain = packageCompilerOutput({
        jsHostImports: module.jsHostImports,
        projectPath: options.projectPath,
        runtimeTarget: runtime.target,
        wat,
      });
      return {
        artifacts: {
          declarationsPath: toolchain.declarationsPath,
          runtimePath: toolchain.runtimePath,
          wasmPath: toolchain.wasmPath,
          watPath: toolchain.watPath,
          wrapperPath: toolchain.wrapperPath,
        },
        diagnostics: [],
        output: renderCompilerToolchainOutput(toolchain, options.projectPath),
        exitCode: 0,
      };
    } catch (error) {
      if (error instanceof CompilerUnsupportedError) {
        const diagnosticOverrides = {
          code: error.diagnosticCode,
          message: error.diagnosticMessage,
          hint: error.diagnosticHint,
          notes: error.diagnosticNotes,
        };
        const compilerDiagnostics = remapCompilerDiagnostics([
          error.node
            ? createCompilerDiagnosticForNode(error.node, diagnosticOverrides)
            : createCompilerDiagnostic(options.projectPath, diagnosticOverrides),
        ], diagnosticPreparedFiles);
        return {
          diagnostics: compilerDiagnostics,
          output: formatDiagnostics(compilerDiagnostics, options.workingDirectory),
          exitCode: 1,
        };
      }
      if (error instanceof CompilerToolchainError) {
        const compilerDiagnostics = [
          createCompilerDiagnostic(options.projectPath, {
            hint: error.hint,
            message: error.message,
          }),
        ];
        return {
          diagnostics: compilerDiagnostics,
          output: formatDiagnostics(compilerDiagnostics, options.workingDirectory),
          exitCode: 1,
        };
      }

      throw error;
    }
  } finally {
    dispose();
  }
}
