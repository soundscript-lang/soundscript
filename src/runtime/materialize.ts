import { dirname, extname, join, relative } from '../platform/path.ts';
import ts from 'typescript';

import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import {
  formatDiagnostics,
  hasErrorDiagnostics,
  type MergedDiagnostic,
  toMergedDiagnostic,
} from '../checker/diagnostics.ts';
import { createBuiltinRuntimeProgram } from '../frontend/builtin_macro_support.ts';
import { MacroError } from '../frontend/macro_errors.ts';
import { isSoundscriptSourceFile } from '../frontend/project_frontend.ts';
import {
  copyFile,
  createSymlink,
  directoryExistsSync,
  fileExistsSync,
  makeDirectory,
  readDirectory,
  readLink,
  readTextFileSync,
  removePath,
  writeTextFile,
} from '../platform/host.ts';
import { loadRuntimeProgramConfig } from './project_roots.ts';
import { inlineSourceMapComment, stripTrailingSourceMapComment } from './source_maps.ts';
import { type RuntimeTransformArtifact, transpileTypeScriptModuleToEsm } from './transform.ts';

const PROJECT_CONFIG_CANDIDATES = ['tsconfig.soundscript.json', 'tsconfig.json'] as const;
const LOCAL_CODE_EXTENSIONS = [
  '.sts',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;
const LOCAL_ASSET_EXTENSIONS = ['.json', '.css', '.wasm'] as const;

export interface MaterializeRuntimeGraphOptions {
  entryPaths: readonly string[];
  outDir: string;
  projectPath?: string;
  workingDirectory: string;
}

export interface MaterializeRuntimeGraphArtifacts {
  emittedFiles: string[];
  entryOutputPaths: string[];
  outDir: string;
  projectPath: string;
}

export interface MaterializeRuntimeGraphResult {
  artifacts?: MaterializeRuntimeGraphArtifacts;
  diagnostics: MergedDiagnostic[];
  exitCode: number;
  output: string;
}

async function copyDirectory(sourcePath: string, destinationPath: string): Promise<void> {
  await makeDirectory(destinationPath);

  for (const entry of await readDirectory(sourcePath)) {
    const sourceEntryPath = join(sourcePath, entry.name);
    const destinationEntryPath = join(destinationPath, entry.name);

    if (entry.isDirectory) {
      await copyDirectory(sourceEntryPath, destinationEntryPath);
    } else if (entry.isFile) {
      await copyFile(sourceEntryPath, destinationEntryPath);
    } else if (entry.isSymlink) {
      const targetPath = await readLink(sourceEntryPath);
      await createSymlink(targetPath, destinationEntryPath, 'dir');
    }
  }
}

async function ensureRuntimePackageBoundary(outDir: string): Promise<void> {
  await writeTextFile(
    join(outDir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  );
}

function findNearestRuntimeNodeModules(projectRoot: string): string | undefined {
  let currentDirectory = projectRoot;

  while (true) {
    const sourceNodeModules = join(currentDirectory, 'node_modules');
    if (fileExistsSync(join(sourceNodeModules, '@soundscript', 'soundscript', 'package.json'))) {
      return sourceNodeModules;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

async function ensureRuntimeNodeModules(
  projectRoot: string,
  outDir: string,
): Promise<MergedDiagnostic | null> {
  const sourceNodeModules = findNearestRuntimeNodeModules(projectRoot);
  if (!sourceNodeModules) {
    return {
      source: 'cli',
      code: 'SOUNDSCRIPT_RUNTIME_PACKAGE_MISSING',
      category: 'error',
      message: 'Could not find @soundscript/soundscript in node_modules for runtime execution.',
      filePath: projectRoot,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
      hint:
        'Install @soundscript/soundscript in this project or an ancestor workspace before using soundscript deno.',
    };
  }

  const targetNodeModules = join(outDir, 'node_modules');
  try {
    await createSymlink(sourceNodeModules, targetNodeModules, 'dir');
  } catch {
    await copyDirectory(sourceNodeModules, targetNodeModules);
  }

  return null;
}

function findNearestProjectPath(startPath: string): string | undefined {
  const initialDirectory = fileExistsSync(startPath) ? dirname(startPath) : startPath;
  let currentDirectory = initialDirectory;

  while (true) {
    for (const candidate of PROJECT_CONFIG_CANDIDATES) {
      const projectPath = join(currentDirectory, candidate);
      if (fileExistsSync(projectPath)) {
        return projectPath;
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

function normalizeLocalSpecifierPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function toRuntimeCodeOutputPath(
  projectRoot: string,
  sourceFileName: string,
  outDir: string,
): string {
  const relativePath = normalizeLocalSpecifierPath(relative(projectRoot, sourceFileName));
  const safeRelativePath = relativePath.startsWith('..')
    ? sourceFileName.split(/[\\/]/u).at(-1) ?? sourceFileName
    : relativePath;
  const extension = extname(safeRelativePath);
  return join(
    outDir,
    extension.length > 0
      ? `${safeRelativePath.slice(0, -extension.length)}.js`
      : `${safeRelativePath}.js`,
  );
}

function toRuntimeAssetOutputPath(
  projectRoot: string,
  sourceFileName: string,
  outDir: string,
): string {
  const relativePath = normalizeLocalSpecifierPath(relative(projectRoot, sourceFileName));
  const safeRelativePath = relativePath.startsWith('..')
    ? sourceFileName.split(/[\\/]/u).at(-1) ?? sourceFileName
    : relativePath;
  return join(outDir, safeRelativePath);
}

function collectModuleSpecifiers(sourceText: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  function pushSpecifier(specifier: ts.StringLiteralLike): void {
    specifiers.push(specifier.text);
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      pushSpecifier(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      pushSpecifier(node.arguments[0]!);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolvePathWithExtensions(basePath: string): string | undefined {
  for (const extension of LOCAL_CODE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (fileExistsSync(candidate)) {
      return candidate;
    }
  }
  for (const extension of LOCAL_ASSET_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (fileExistsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveLocalDependency(containingFileName: string, specifier: string): string | undefined {
  if (!isRelativeOrAbsoluteSpecifier(specifier)) {
    return undefined;
  }

  const containingDirectory = dirname(containingFileName);
  const candidateBase = specifier.startsWith('/')
    ? specifier
    : join(containingDirectory, specifier);
  if (fileExistsSync(candidateBase)) {
    return candidateBase;
  }

  const directMatch = resolvePathWithExtensions(candidateBase);
  if (directMatch) {
    return directMatch;
  }

  if (directoryExistsSync(candidateBase)) {
    const indexMatch = resolvePathWithExtensions(join(candidateBase, 'index'));
    if (indexMatch) {
      return indexMatch;
    }
  }

  return undefined;
}

function isRuntimeCodeFile(fileName: string): boolean {
  return LOCAL_CODE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

function isRuntimeAssetFile(fileName: string): boolean {
  return LOCAL_ASSET_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

function createRuntimeMacroDiagnostic(error: MacroError): MergedDiagnostic {
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

function createExpandedProgram(projectPath: string, extraRootNames: readonly string[] = []) {
  const runtimeConfig = loadRuntimeProgramConfig(projectPath, extraRootNames);
  return createBuiltinRuntimeProgram({
    baseHost: createSoundStdlibCompilerHost(
      runtimeConfig.loadedConfig.frontierCommandLine.options,
      dirname(projectPath),
    ),
    configFileParsingDiagnostics: runtimeConfig.configFileParsingDiagnostics,
    configuredSoundscriptFileNames: runtimeConfig.loadedConfig.soundscriptConfiguredFileNames,
    options: runtimeConfig.loadedConfig.frontierCommandLine.options,
    projectReferences: runtimeConfig.loadedConfig.frontierCommandLine.projectReferences,
    rootNames: runtimeConfig.rootNames,
  });
}

function transpileExpandedSoundscriptModuleToEsm(
  expandedProgram: ReturnType<typeof createExpandedProgram>,
  sourceFileName: string,
  outputPath: string,
): RuntimeTransformArtifact {
  const programFileName = expandedProgram.preparedProgram.toProgramFileName(sourceFileName);
  const expandedSourceFile = expandedProgram.program.getSourceFile(programFileName);
  if (!expandedSourceFile) {
    throw new Error(`Missing expanded source file for ${sourceFileName}.`);
  }

  const printer = ts.createPrinter();
  return transpileTypeScriptModuleToEsm(
    sourceFileName,
    outputPath,
    printer.printFile(expandedSourceFile),
    {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  );
}

export async function materializeRuntimeGraph(
  options: MaterializeRuntimeGraphOptions,
): Promise<MaterializeRuntimeGraphResult> {
  if (options.entryPaths.length === 0) {
    const diagnostics: MergedDiagnostic[] = [{
      source: 'cli',
      code: 'SOUNDSCRIPT_RUNTIME_NO_ENTRY',
      category: 'error',
      message: 'No entry file was provided for runtime materialization.',
      filePath: options.workingDirectory,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
    }];
    return {
      diagnostics,
      exitCode: 1,
      output: formatDiagnostics(diagnostics, options.workingDirectory),
    };
  }

  const entryProjectPath = options.projectPath ??
    findNearestProjectPath(options.entryPaths[0]!);
  if (!entryProjectPath) {
    const diagnostics: MergedDiagnostic[] = [{
      source: 'cli',
      code: 'SOUNDSCRIPT_RUNTIME_NO_PROJECT',
      category: 'error',
      message: 'Could not find a tsconfig.soundscript.json or tsconfig.json for the runtime entry.',
      filePath: options.entryPaths[0]!,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
    }];
    return {
      diagnostics,
      exitCode: 1,
      output: formatDiagnostics(diagnostics, options.workingDirectory),
    };
  }

  const expandedProgram = createExpandedProgram(
    entryProjectPath,
    options.entryPaths.filter(isSoundscriptSourceFile),
  );
  const frontendDiagnostics: MergedDiagnostic[] = [
    ...expandedProgram.frontendDiagnostics(),
    ...ts.getPreEmitDiagnostics(expandedProgram.program).map(toMergedDiagnostic),
  ];
  if (hasErrorDiagnostics(frontendDiagnostics)) {
    return {
      diagnostics: frontendDiagnostics,
      exitCode: 1,
      output: formatDiagnostics(frontendDiagnostics, options.workingDirectory),
    };
  }

  try {
    void expandedProgram.program.getTypeChecker();
  } catch (error) {
    const diagnostics = error instanceof MacroError ? [createRuntimeMacroDiagnostic(error)] : [];
    return {
      diagnostics,
      exitCode: 1,
      output: error instanceof MacroError
        ? formatDiagnostics(diagnostics, options.workingDirectory)
        : String(error),
    };
  }

  await removePath(options.outDir);
  await makeDirectory(options.outDir);

  const emittedFiles: string[] = [];
  const writtenSourceFiles = new Set<string>();
  const projectRoot = dirname(entryProjectPath);
  await ensureRuntimePackageBoundary(options.outDir);
  emittedFiles.push(join(options.outDir, 'package.json'));
  const runtimePackageDiagnostic = await ensureRuntimeNodeModules(projectRoot, options.outDir);
  if (runtimePackageDiagnostic) {
    return {
      diagnostics: [runtimePackageDiagnostic],
      exitCode: 1,
      output: formatDiagnostics([runtimePackageDiagnostic], options.workingDirectory),
    };
  }
  const queue = [...options.entryPaths];
  const visited = new Set<string>();
  const entryOutputPaths: string[] = [];

  while (queue.length > 0) {
    const sourceFileName = queue.shift()!;
    if (visited.has(sourceFileName)) {
      continue;
    }
    visited.add(sourceFileName);

    if (isRuntimeAssetFile(sourceFileName)) {
      const outputPath = toRuntimeAssetOutputPath(projectRoot, sourceFileName, options.outDir);
      await makeDirectory(dirname(outputPath));
      await copyFile(sourceFileName, outputPath);
      emittedFiles.push(outputPath);
      continue;
    }

    if (!isRuntimeCodeFile(sourceFileName)) {
      continue;
    }

    const sourceText = readTextFileSync(sourceFileName);
    const outputPath = toRuntimeCodeOutputPath(projectRoot, sourceFileName, options.outDir);
    const artifact = isSoundscriptSourceFile(sourceFileName)
      ? transpileExpandedSoundscriptModuleToEsm(expandedProgram, sourceFileName, outputPath)
      : transpileTypeScriptModuleToEsm(sourceFileName, outputPath, sourceText, {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      });

    await makeDirectory(dirname(outputPath));
    await writeTextFile(
      outputPath,
      `${stripTrailingSourceMapComment(artifact.code)}\n${
        inlineSourceMapComment(artifact.mapText)
      }\n`,
    );
    emittedFiles.push(outputPath);
    writtenSourceFiles.add(sourceFileName);

    if (options.entryPaths.includes(sourceFileName)) {
      entryOutputPaths.push(outputPath);
    }

    for (const specifier of collectModuleSpecifiers(sourceText, sourceFileName)) {
      const dependencyPath = resolveLocalDependency(sourceFileName, specifier);
      if (!dependencyPath || writtenSourceFiles.has(dependencyPath)) {
        continue;
      }
      queue.push(dependencyPath);
    }
  }

  return {
    artifacts: {
      emittedFiles,
      entryOutputPaths,
      outDir: options.outDir,
      projectPath: entryProjectPath,
    },
    diagnostics: [],
    exitCode: 0,
    output: '',
  };
}
