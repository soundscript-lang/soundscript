import ts from 'typescript';
import { dirname, isAbsolute, join } from '../platform/path.ts';

import {
  createSoundStdlibCompilerHost,
  resolveBundledTypesDirectory,
} from '../bundled/sound_stdlib.ts';
import {
  type BuiltinExpandedTsDiagnosticProgram,
  createBuiltinExpandedProgram,
} from '../frontend/builtin_macro_support.ts';
import type {
  MacroModuleCacheStats,
  ProjectMacroEnvironment,
} from '../frontend/project_macro_support.ts';
import {
  sourceTextLooksLikeMacroModule,
  usesLegacyDefineMacroAuthoring,
} from '../frontend/macro_factory_support.ts';
import {
  clearPreparedCompilerHostReuseState,
  emitProjectedDeclarations,
  getLineAndCharacterOfPosition,
  getPositionOfLineAndCharacter,
  isProjectedSoundscriptDeclarationFile,
  isSoundscriptSourceFile,
  mapProgramEnclosingRangeToSource,
  mapProgramPositionToSource,
  type PreparedCompilerHostReuseState,
  type PreparedProgram,
  type PreparedSourceFile,
  toProjectedDeclarationFileName,
  toProjectedDeclarationSourceFileName,
  toSourceFileName,
} from '../frontend/project_frontend.ts';
import { collectSoundscriptRootNames, loadConfig } from '../config.ts';
import {
  findNearestPackageJsonPath,
  getSoundScriptPackageInfoForResolvedModule,
  resolveSoundScriptAwareModule,
} from '../soundscript_packages.ts';
import {
  hasErrorDiagnostics,
  remapDiagnosticFilePaths,
  toMergedDiagnostic,
} from './diagnostics.ts';
import { SOUND_DIAGNOSTIC_CODES } from './engine/diagnostic_codes.ts';
import { createAnalysisContext } from './engine/context.ts';
import { runSoundAnalysis } from './rules/index.ts';
import {
  runSourceSupplementalPolicyAnalysis,
  runUniversalPolicyAnalysis,
} from './rules/universal.ts';
import { measureCheckerTiming } from './timing.ts';

import type { AnalyzeProjectOptions, AnalyzeProjectResult } from '../service/types.ts';
import type {
  DiagnosticRelatedInformation,
  MergedDiagnostic,
  SoundDiagnostic,
} from './diagnostics.ts';
import type { AnalysisContext } from './engine/types.ts';

export interface PreparedAnalysisView {
  analysisContext: AnalysisContext;
  analysisPreparedProgram: PreparedProgram;
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>;
  frontendDiagnostics: readonly MergedDiagnostic[];
  macroEnvironment: ProjectMacroEnvironment;
  macroCacheStats: MacroModuleCacheStats;
  preparedProgram: PreparedProgram;
  program: ts.Program;
  runSound: boolean;
  tsDiagnosticPrograms: readonly BuiltinExpandedTsDiagnosticProgram[];
  universalPolicyScope: 'full' | 'sourceSupplemental';
}

export interface PreparedAnalysisProject {
  analyzeOptions: AnalyzeProjectOptions;
  configReuseSignature: string;
  configuredSoundscriptRootNames: readonly string[];
  isSoundscriptSourceFile(fileName: string): boolean;
  localProjectedDeclarationOverrides: ReadonlyMap<string, string> | undefined;
  packageSourcePolicyContentSignature: string;
  packageSourcePolicyCompilerHostReuseState: PreparedCompilerHostReuseState | undefined;
  packageSourcePolicyView: PreparedAnalysisView | null;
  soundscriptRootContentSignature: string;
  soundscriptConfiguredFileNames: ReadonlySet<string>;
  soundscriptRootDiscoverySignature: string;
  stsCompilerHostReuseState: PreparedCompilerHostReuseState | undefined;
  soundscriptFileOverridesSignature: string;
  stsProgramRootNames: readonly string[];
  soundscriptRootNames: readonly string[];
  stsView: PreparedAnalysisView | null;
  tsCompilerHostReuseState: PreparedCompilerHostReuseState | undefined;
  tsView: PreparedAnalysisView | null;
}

interface AnalyzedProgramResult {
  frontendDiagnostics: readonly MergedDiagnostic[];
  soundDiagnostics: readonly SoundDiagnostic[];
  tsDiagnostics: readonly MergedDiagnostic[];
}

const fileScopedAnalysisContextCache = new WeakMap<
  PreparedAnalysisView,
  Map<string, AnalysisContext | null>
>();
const IGNORED_GENERATED_TOP_LEVEL_IMPORT_SPECIFIERS = new Set(['sts:prelude']);
const BUNDLED_TYPES_DIRECTORY = ts.sys.resolvePath(resolveBundledTypesDirectory()).replaceAll(
  '\\',
  '/',
);

interface PrepareProjectAnalysisOptions {
  deferTypescriptView?: boolean;
}

function combineRootNames(
  rootNames: readonly string[],
  additionalRootNames: readonly string[] = [],
): string[] {
  return [...new Set([...rootNames, ...additionalRootNames])];
}

function rootNamesEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function createFileOverrideSignature(
  fileOverrides: ReadonlyMap<string, string> | undefined,
  includeFileName: (fileName: string) => boolean,
): string {
  if (!fileOverrides || fileOverrides.size === 0) {
    return '';
  }

  return [...fileOverrides.entries()]
    .filter(([fileName]) => includeFileName(fileName))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fileName, text]) => `${fileName}:${text.length}:${text}`)
    .join('|');
}

function createSoundscriptRootDiscoverySignature(
  projectPath: string,
  loadedConfig: ReturnType<typeof loadConfig>,
): string {
  const basePath = dirname(projectPath);
  const rawConfig = loadedConfig.commandLine.raw as {
    exclude?: readonly string[];
    files?: readonly string[];
    include?: readonly string[];
  } | undefined;
  const explicitFiles = (rawConfig?.files ?? [])
    .map((fileName) => isAbsolute(fileName) ? fileName : join(basePath, fileName))
    .map((fileName) => ts.sys.resolvePath(fileName))
    .filter(isSoundscriptSourceFile)
    .sort()
    .join('\u0000');
  const includePatterns = rawConfig?.include
    ? [...rawConfig.include]
    : rawConfig?.files
    ? []
    : ['**/*'];
  const excludePatterns = rawConfig?.exclude
    ? [...rawConfig.exclude]
    : ['node_modules', 'bower_components', 'jspm_packages', '.git'];

  return [
    basePath,
    explicitFiles,
    includePatterns.join('\u0001'),
    excludePatterns.join('\u0001'),
    (loadedConfig.soundscript.include ?? []).join('\u0001'),
  ].join('\u0002');
}

function stableConfigSignature(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (
      currentValue !== null &&
      typeof currentValue === 'object' &&
      !Array.isArray(currentValue)
    ) {
      return Object.fromEntries(
        Object.entries(currentValue as Record<string, unknown>).sort(([left], [right]) =>
          left.localeCompare(right)
        ),
      );
    }

    return currentValue;
  });
}

function createProjectConfigReuseSignature(
  projectPath: string,
  loadedConfig: ReturnType<typeof loadConfig>,
): string {
  return [
    projectPath,
    stableConfigSignature(loadedConfig.commandLine.raw),
    stableConfigSignature(loadedConfig.commandLine.options),
    stableConfigSignature(loadedConfig.commandLine.projectReferences ?? []),
    stableConfigSignature(loadedConfig.runtime),
  ].join('\u0003');
}

function createModuleResolutionHostWithOverrides(
  fileOverrides: ReadonlyMap<string, string> | undefined,
): ts.ModuleResolutionHost {
  const normalizedOverrides = fileOverrides
    ? new Map(
      [...fileOverrides.entries()].map(([fileName, text]) => [ts.sys.resolvePath(fileName), text]),
    )
    : new Map<string, string>();

  return {
    directoryExists(directoryName) {
      const normalizedDirectoryName = ts.sys.resolvePath(directoryName);
      if (
        [...normalizedOverrides.keys()].some((fileName) =>
          fileName === normalizedDirectoryName ||
          fileName.startsWith(`${normalizedDirectoryName}/`) ||
          fileName.startsWith(`${normalizedDirectoryName}\\`)
        )
      ) {
        return true;
      }
      return ts.sys.directoryExists?.(directoryName) ?? false;
    },
    fileExists(fileName) {
      return normalizedOverrides.has(ts.sys.resolvePath(fileName)) || ts.sys.fileExists(fileName);
    },
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getDirectories: ts.sys.getDirectories,
    readFile(fileName) {
      return normalizedOverrides.get(ts.sys.resolvePath(fileName)) ?? ts.sys.readFile(fileName);
    },
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
}

function isDeclarationRootFileName(fileName: string): boolean {
  return fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts');
}

function isRelativeOrAbsoluteModuleSpecifier(moduleSpecifier: string): boolean {
  return moduleSpecifier.startsWith('.') ||
    moduleSpecifier.startsWith('/') ||
    /^[A-Za-z]:[/\\]/u.test(moduleSpecifier);
}

function resolveRelativeSoundscriptDependency(
  containingFileName: string,
  moduleSpecifier: string,
  host: ts.ModuleResolutionHost,
): string | undefined {
  if (!isRelativeOrAbsoluteModuleSpecifier(moduleSpecifier)) {
    return undefined;
  }

  const explicitNonSoundscriptExtensionPattern = /\.(?:[cm]?[jt]sx?|[cm]?js)$/u;
  if (explicitNonSoundscriptExtensionPattern.test(moduleSpecifier)) {
    return undefined;
  }

  const candidateBase = ts.sys.resolvePath(
    isAbsolute(moduleSpecifier)
      ? moduleSpecifier
      : join(dirname(containingFileName), moduleSpecifier),
  );
  const candidates = moduleSpecifier.endsWith('.sts')
    ? [candidateBase]
    : [`${candidateBase}.sts`, join(candidateBase, 'index.sts')];

  for (const candidate of candidates) {
    if (host.fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function collectReachableSoundscriptDependencyFiles(
  rootNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
  fileOverrides: ReadonlyMap<string, string> | undefined,
  isSoundscriptFile: (fileName: string) => boolean,
): readonly string[] {
  const host = createModuleResolutionHostWithOverrides(fileOverrides);
  const visited = new Set<string>();
  const reachableFiles: string[] = [];

  function visit(fileName: string): void {
    const sourceFileName = ts.sys.resolvePath(toSourceFileName(fileName));
    if (!isSoundscriptFile(sourceFileName) || visited.has(sourceFileName)) {
      return;
    }

    visited.add(sourceFileName);
    reachableFiles.push(sourceFileName);

    const sourceText = host.readFile(sourceFileName);
    if (!sourceText) {
      return;
    }

    for (const importedFile of ts.preProcessFile(sourceText, true, true).importedFiles) {
      const resolvedDependency = resolveRelativeSoundscriptDependency(
        sourceFileName,
        importedFile.fileName,
        host,
      );
      if (resolvedDependency) {
        visit(resolvedDependency);
        continue;
      }

      const resolvedModule = resolveSoundScriptAwareModule(
        importedFile.fileName,
        sourceFileName,
        compilerOptions,
        host,
      );
      if (resolvedModule) {
        visit(resolvedModule.resolvedFileName);
      }
    }
  }

  for (const rootName of rootNames) {
    visit(rootName);
  }

  reachableFiles.sort();
  return reachableFiles;
}

function createSoundscriptRootContentSignature(
  rootNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
  fileOverrides: ReadonlyMap<string, string> | undefined,
  isSoundscriptFile: (fileName: string) => boolean,
): string {
  const host = createModuleResolutionHostWithOverrides(fileOverrides);
  const declarationRootNames = rootNames
    .map((fileName) => ts.sys.resolvePath(fileName))
    .filter(isDeclarationRootFileName);

  return [...new Set([
    ...collectReachableSoundscriptDependencyFiles(
      rootNames,
      compilerOptions,
      fileOverrides,
      isSoundscriptFile,
    ),
    ...declarationRootNames,
  ])]
    .sort()
    .map((fileName) => {
      const text = host.readFile(fileName) ?? '';
      return `${fileName}\u0001${text.length}\u0001${text}`;
    })
    .join('\u0002');
}

function getConfigFileParsingDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  additionalRootNames: readonly string[] = [],
): readonly ts.Diagnostic[] {
  if (additionalRootNames.length === 0) {
    return diagnostics;
  }

  return diagnostics.filter((diagnostic) => diagnostic.code !== 18003);
}

function remapDiagnostics<T extends MergedDiagnostic>(diagnostics: readonly T[]): T[] {
  return diagnostics.map((diagnostic) => remapDiagnosticFilePaths(diagnostic, toSourceFileName));
}

function remapPreparedSoundDiagnosticRange<
  T extends MergedDiagnostic | DiagnosticRelatedInformation,
>(
  diagnostic: T,
  preparedFile: PreparedSourceFile | undefined,
): T {
  if (
    !preparedFile ||
    !diagnostic.filePath ||
    diagnostic.line === undefined ||
    diagnostic.column === undefined
  ) {
    return diagnostic;
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

  return {
    ...diagnostic,
    line: mappedStart.line + 1,
    column: mappedStart.character + 1,
    endLine: mappedEnd.line + 1,
    endColumn: mappedEnd.character + 1,
  } as T;
}

function remapSoundDiagnostics(
  diagnostics: readonly SoundDiagnostic[],
  diagnosticPreparedFiles: ReadonlyMap<string, PreparedSourceFile>,
): SoundDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const preparedFile = diagnostic.filePath
      ? diagnosticPreparedFiles.get(toSourceFileName(diagnostic.filePath))
      : undefined;
    const remapped = remapPreparedSoundDiagnosticRange(diagnostic, preparedFile);
    return {
      ...remapped,
      relatedInformation: remapped.relatedInformation?.map((relatedInformation) => {
        const relatedPreparedFile = relatedInformation.filePath
          ? diagnosticPreparedFiles.get(toSourceFileName(relatedInformation.filePath))
          : undefined;
        return remapPreparedSoundDiagnosticRange(relatedInformation, relatedPreparedFile);
      }),
    };
  });
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
    line: mappedStart.line + 1,
    column: mappedStart.character + 1,
    endLine: mappedEnd.line + 1,
    endColumn: mappedEnd.character + 1,
  } as T;
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

function mergeProjectedDeclarationOverrides(
  first: ReadonlyMap<string, string> | undefined,
  second: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> | undefined {
  if (!first && !second) {
    return undefined;
  }

  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }

  const merged = new Map(first);
  for (const [fileName, text] of second) {
    merged.set(fileName, text);
  }

  return merged;
}

function filterProjectedDeclarationOverridesToRootNames(
  projectedDeclarationOverrides: ReadonlyMap<string, string> | undefined,
  rootNames: readonly string[],
): ReadonlyMap<string, string> | undefined {
  if (!projectedDeclarationOverrides) {
    return undefined;
  }

  const normalizedRootNames = new Set(rootNames.map((rootName) => ts.sys.resolvePath(rootName)));
  const filtered = new Map<string, string>();

  for (const [fileName, text] of projectedDeclarationOverrides) {
    if (normalizedRootNames.has(ts.sys.resolvePath(fileName))) {
      filtered.set(fileName, text);
    }
  }

  return filtered;
}

function projectedDeclarationOverridesDiffer(
  first: ReadonlyMap<string, string> | undefined,
  second: ReadonlyMap<string, string> | undefined,
): boolean {
  if (!first && !second) {
    return false;
  }

  if (!first || !second) {
    return true;
  }

  if (first.size !== second.size) {
    return true;
  }

  for (const [fileName, text] of first) {
    if (second.get(fileName) !== text) {
      return true;
    }
  }

  return false;
}

function collectProjectedDeclarationCandidateRootNames(
  program: ts.Program,
  existingOverrides: ReadonlyMap<string, string> | undefined,
  projectPackageJsonPath: string | undefined,
): readonly string[] {
  const rootNames = new Set<string>();

  for (const sourceFile of program.getSourceFiles()) {
    const sourceFileName = toSourceFileName(sourceFile.fileName);
    if (!isSoundscriptSourceFile(sourceFileName)) {
      continue;
    }
    if (isInstalledSoundStdlibSourceFileName(sourceFileName)) {
      continue;
    }
    if (existingOverrides?.has(sourceFileName)) {
      continue;
    }
    if (!isSupplementalPackageSourceCandidate(sourceFileName, projectPackageJsonPath)) {
      continue;
    }

    rootNames.add(sourceFileName);
  }

  return [...rootNames].sort();
}

function hasNonRootProjectedDeclarationCandidates(
  program: ts.Program,
  soundscriptRootNameSet: ReadonlySet<string>,
  projectPackageJsonPath: string | undefined,
): boolean {
  return program.getSourceFiles().some((sourceFile) => {
    const sourceFileName = toSourceFileName(sourceFile.fileName);
    return isSoundscriptSourceFile(sourceFileName) &&
      !isInstalledSoundStdlibSourceFileName(sourceFileName) &&
      isSupplementalPackageSourceCandidate(sourceFileName, projectPackageJsonPath) &&
      !soundscriptRootNameSet.has(ts.sys.resolvePath(sourceFileName));
  });
}

function collectProjectedDeclarationCandidateRootNamesFromPrograms(
  programs: readonly (ts.Program | null | undefined)[],
  existingOverrides: ReadonlyMap<string, string> | undefined,
  projectPackageJsonPath: string | undefined,
): readonly string[] {
  const rootNames = new Set<string>();

  for (const program of programs) {
    if (!program) {
      continue;
    }

    for (
      const rootName of collectProjectedDeclarationCandidateRootNames(
        program,
        existingOverrides,
        projectPackageJsonPath,
      )
    ) {
      rootNames.add(rootName);
    }
  }

  return [...rootNames].sort();
}

function isInstalledSoundStdlibSourceFileName(fileName: string): boolean {
  const normalizedFileName = toSourceFileName(fileName).replaceAll('\\', '/');
  return normalizedFileName.includes('/node_modules/@soundscript/soundscript/soundscript/') &&
    normalizedFileName.endsWith('.sts');
}

function isNodeModulesPath(fileName: string): boolean {
  const normalizedFileName = toSourceFileName(fileName).replaceAll('\\', '/');
  return normalizedFileName.includes('/node_modules/');
}

function shouldAnalyzeSoundscriptSourceFile(
  sourceFile: ts.SourceFile,
  preparedProgram: PreparedProgram,
): boolean {
  const sourceFileName = toSourceFileName(sourceFile.fileName);
  return preparedProgram.isSoundscriptSourceFile(sourceFileName) &&
    !isInstalledSoundStdlibSourceFileName(sourceFileName) &&
    !isMacroAuthoringSourceFile(sourceFile, preparedProgram);
}

function normalizeOptionalResolvedPath(path: string | undefined): string | undefined {
  return path ? ts.sys.resolvePath(path) : undefined;
}

function isSupplementalPackageSourceCandidate(
  fileName: string,
  projectPackageJsonPath: string | undefined,
): boolean {
  if (!isSoundscriptSourceFile(fileName) || isInstalledSoundStdlibSourceFileName(fileName)) {
    return false;
  }

  const packageInfo = getSoundScriptPackageInfoForResolvedModule(fileName, ts.sys);
  if (!packageInfo) {
    return false;
  }

  const normalizedProjectPackageJsonPath = normalizeOptionalResolvedPath(projectPackageJsonPath);
  const normalizedFilePackageJsonPath = normalizeOptionalResolvedPath(packageInfo.packageJsonPath);
  return normalizedProjectPackageJsonPath === undefined ||
    normalizedFilePackageJsonPath !== normalizedProjectPackageJsonPath;
}

function shouldAnalyzeProjectSoundscriptSourceFile(
  sourceFile: ts.SourceFile,
  preparedProgram: PreparedProgram,
  projectPackageJsonPath: string | undefined,
): boolean {
  const sourceFileName = toSourceFileName(sourceFile.fileName);
  return shouldAnalyzeSoundscriptSourceFile(sourceFile, preparedProgram) &&
    !isSupplementalPackageSourceCandidate(sourceFileName, projectPackageJsonPath);
}

function shouldAnalyzeTypescriptViewSourceFile(
  sourceFile: ts.SourceFile,
  isSoundscriptFile: (fileName: string) => boolean,
): boolean {
  const sourceFileName = toSourceFileName(sourceFile.fileName);
  if (isSoundscriptFile(sourceFileName)) {
    return false;
  }

  const normalizedSourceFileName = ts.sys.resolvePath(sourceFileName).replaceAll('\\', '/');
  return !normalizedSourceFileName.startsWith(`${BUNDLED_TYPES_DIRECTORY}/`);
}

function isIgnorableGeneratedTopLevelStatement(statement: ts.Statement): boolean {
  return ts.isImportDeclaration(statement) &&
    ts.isStringLiteralLike(statement.moduleSpecifier) &&
    IGNORED_GENERATED_TOP_LEVEL_IMPORT_SPECIFIERS.has(statement.moduleSpecifier.text);
}

function hasGeneratedTopLevelStatements(
  sourceFile: ts.SourceFile,
  isGeneratedNode: (node: ts.Node) => boolean,
): boolean {
  return sourceFile.statements.some((statement) =>
    isGeneratedNode(statement) && !isIgnorableGeneratedTopLevelStatement(statement)
  );
}

function createOriginalSourceFileForPreparedSource(
  fileName: string,
  preparedSource: PreparedSourceFile,
): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    preparedSource.originalText,
    ts.ScriptTarget.Latest,
    true,
    /\.(?:[cm]?tsx|jsx|sts)$/iu.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function findInnermostNodeContainingPosition(
  root: ts.Node,
  position: number,
): ts.Node | undefined {
  if (position < root.getFullStart() || position >= root.getEnd()) {
    return undefined;
  }

  let best: ts.Node = root;
  const visit = (node: ts.Node): void => {
    if (position < node.getFullStart() || position >= node.getEnd()) {
      return;
    }
    best = node;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return best;
}

function isTopLevelMacroReplacement(
  originalSourceFile: ts.SourceFile,
  preparedSource: PreparedSourceFile,
  replacementId: number,
): boolean {
  const macroInvocation = preparedSource.rewriteResult.macrosById.get(replacementId);
  if (!macroInvocation) {
    return false;
  }

  const anchorPosition = macroInvocation.declarationSpan?.start ?? macroInvocation.span.start;
  const anchorNode = findInnermostNodeContainingPosition(originalSourceFile, anchorPosition);
  if (!anchorNode || ts.isSourceFile(anchorNode)) {
    return false;
  }

  let current: ts.Node | undefined = anchorNode;
  while (current?.parent && !ts.isSourceFile(current.parent)) {
    if (
      ts.isBlock(current.parent) ||
      ts.isFunctionLike(current.parent) ||
      ts.isModuleBlock(current.parent)
    ) {
      return false;
    }
    current = current.parent;
  }

  return current !== undefined && ts.isSourceFile(current.parent);
}

function hasTopLevelMacroReplacements(
  fileName: string,
  preparedSource: PreparedSourceFile | undefined,
): boolean {
  if (!preparedSource || preparedSource.rewriteResult.replacements.length === 0) {
    return false;
  }

  const originalSourceFile = createOriginalSourceFileForPreparedSource(fileName, preparedSource);
  return preparedSource.rewriteResult.replacements.some((replacement) =>
    isTopLevelMacroReplacement(originalSourceFile, preparedSource, replacement.id)
  );
}

function prepareAnalysisView(
  options: AnalyzeProjectOptions,
  loadedConfig: ReturnType<typeof loadConfig>,
  rootNames: readonly string[],
  baseHost: ts.CompilerHost,
  configFileParsingDiagnostics: readonly ts.Diagnostic[],
  includeSourceFile:
    | ((sourceFile: ts.SourceFile, preparedProgram: PreparedProgram) => boolean)
    | undefined,
  projectedDeclarationOverrides: ReadonlyMap<string, string> | undefined,
  runSound: boolean,
  universalPolicyScope: 'full' | 'sourceSupplemental' = 'full',
  reusableCompilerHostState?: PreparedCompilerHostReuseState,
  oldProgram?: ts.Program,
): PreparedAnalysisView | null {
  if (rootNames.length === 0) {
    return null;
  }

  const expandedProgram = createBuiltinExpandedProgram({
    allowSupplementalDiagnosticPrograms: true,
    baseHost,
    configFileParsingDiagnostics,
    configuredSoundscriptFileNames: loadedConfig.soundscriptConfiguredFileNames,
    fileOverrides: options.fileOverrides ?? new Map(),
    oldProgram,
    options: loadedConfig.commandLine.options,
    projectReferences: loadedConfig.commandLine.projectReferences,
    projectedDeclarationOverrides,
    runtime: loadedConfig.runtime,
    reusableCompilerHostState,
    rootNames,
  });
  const program = expandedProgram.program;
  const isGeneratedNode = createPreparedProgramGeneratedNodeDetector(
    expandedProgram.analysisPreparedProgram,
  );
  const sourceFileHasTopLevelMacroReplacements = (sourceFile: ts.SourceFile): boolean => {
    const sourceFileName = expandedProgram.analysisPreparedProgram.toSourceFileName(
      sourceFile.fileName,
    );
    const preparedSource = expandedProgram.preparedProgram.preparedHost.getPreparedSourceFile(
      sourceFileName,
    );
    return hasTopLevelMacroReplacements(sourceFileName, preparedSource);
  };
  const analysisContext = createAnalysisContext({
    includeSourceFile: includeSourceFile
      ? (sourceFile) =>
        !sourceFileHasTopLevelMacroReplacements(sourceFile) &&
        !hasGeneratedTopLevelStatements(sourceFile, isGeneratedNode) &&
        includeSourceFile(sourceFile, expandedProgram.analysisPreparedProgram)
      : (sourceFile) =>
        !sourceFileHasTopLevelMacroReplacements(sourceFile) &&
        !hasGeneratedTopLevelStatements(sourceFile, isGeneratedNode),
    isSoundscriptSourceFile: expandedProgram.analysisPreparedProgram.isSoundscriptSourceFile,
    isGeneratedNode,
    program,
    runtime: loadedConfig.runtime,
    workingDirectory: options.workingDirectory,
  });

  return {
    analysisContext,
    analysisPreparedProgram: expandedProgram.analysisPreparedProgram,
    diagnosticPreparedFiles: expandedProgram.diagnosticPreparedFiles,
    frontendDiagnostics: remapDiagnostics(expandedProgram.frontendDiagnostics()),
    macroEnvironment: expandedProgram.macroEnvironment,
    macroCacheStats: expandedProgram.macroEnvironment.cacheStats(),
    preparedProgram: expandedProgram.preparedProgram,
    program,
    runSound,
    tsDiagnosticPrograms: expandedProgram.tsDiagnosticPrograms,
    universalPolicyScope,
  };
}

function analyzePreparedView(
  preparedView: PreparedAnalysisView | null,
): AnalyzedProgramResult {
  if (!preparedView) {
    return {
      frontendDiagnostics: [],
      tsDiagnostics: [],
      soundDiagnostics: [],
    };
  }

  const frontendDiagnostics = [...preparedView.frontendDiagnostics];
  const tsDiagnostics = collectPreparedViewTsDiagnostics(
    preparedView,
    frontendDiagnostics,
  );
  const hasFrontendErrors = hasErrorDiagnostics(frontendDiagnostics);
  const hasTsErrors = hasErrorDiagnostics(tsDiagnostics);
  const universalDiagnostics = hasFrontendErrors ? [] : collectPreparedViewUniversalDiagnostics(
    preparedView,
    preparedView.analysisContext,
  );
  const soundDiagnostics = hasFrontendErrors ? [] : collectPreparedViewSoundDiagnostics(
    preparedView,
    preparedView.analysisContext,
  );

  return {
    frontendDiagnostics,
    tsDiagnostics,
    soundDiagnostics: hasTsErrors
      ? retainSoundDiagnosticsAlongsideTsErrors([...universalDiagnostics, ...soundDiagnostics])
      : [...universalDiagnostics, ...soundDiagnostics],
  };
}

function emitProjectedDeclarationsFailClosed(
  preparedView: PreparedAnalysisView | null,
  rootNames?: readonly string[],
): ReadonlyMap<string, string> | undefined {
  if (!preparedView) {
    return undefined;
  }

  try {
    return emitProjectedDeclarations(preparedView.analysisPreparedProgram, rootNames);
  } catch (error) {
    const analyzedView = analyzePreparedView(preparedView);
    if (
      hasErrorDiagnostics([
        ...analyzedView.frontendDiagnostics,
        ...analyzedView.tsDiagnostics,
        ...analyzedView.soundDiagnostics,
      ])
    ) {
      return undefined;
    }

    throw error;
  }
}

function analyzePreparedViewForFile(
  preparedView: PreparedAnalysisView | null,
  filePath: string,
): AnalyzedProgramResult {
  if (!preparedView) {
    return {
      frontendDiagnostics: [],
      tsDiagnostics: [],
      soundDiagnostics: [],
    };
  }

  const frontendDiagnosticPaths = collectPreparedViewFrontendDiagnosticPaths(
    preparedView,
    filePath,
  );
  const frontendDiagnostics = preparedView.frontendDiagnostics.filter((diagnostic) =>
    matchesPreparedAnalysisAnyFilePath(diagnostic.filePath, frontendDiagnosticPaths)
  );
  const tsDiagnostics = collectPreparedViewTsDiagnostics(
    preparedView,
    frontendDiagnostics,
    filePath,
    true,
  );
  const hasFrontendErrors = hasErrorDiagnostics(frontendDiagnostics);
  const hasTsErrors = hasErrorDiagnostics(tsDiagnostics);
  const fileScopedAnalysisContext = getFileScopedAnalysisContext(preparedView, filePath);
  const universalDiagnostics = !fileScopedAnalysisContext || hasFrontendErrors
    ? []
    : filterAnalyzedDiagnosticsForFile(
      collectPreparedViewUniversalDiagnostics(
        preparedView,
        fileScopedAnalysisContext,
        filePath,
      ),
      filePath,
    );
  const soundDiagnostics = !fileScopedAnalysisContext ||
      hasFrontendErrors
    ? []
    : filterAnalyzedDiagnosticsForFile(
      collectPreparedViewSoundDiagnostics(
        preparedView,
        fileScopedAnalysisContext,
        filePath,
      ),
      filePath,
    );

  return {
    frontendDiagnostics,
    tsDiagnostics,
    soundDiagnostics: hasTsErrors
      ? retainSoundDiagnosticsAlongsideTsErrors([...universalDiagnostics, ...soundDiagnostics])
      : [...universalDiagnostics, ...soundDiagnostics],
  };
}

function analyzePreparedViewForDiagnosticPaths(
  preparedView: PreparedAnalysisView | null,
  diagnosticPaths: readonly string[],
): AnalyzedProgramResult {
  if (!preparedView || diagnosticPaths.length === 0) {
    return {
      frontendDiagnostics: [],
      tsDiagnostics: [],
      soundDiagnostics: [],
    };
  }

  const frontendDiagnostics = preparedView.frontendDiagnostics.filter((diagnostic) =>
    matchesPreparedAnalysisAnyFilePath(diagnostic.filePath, diagnosticPaths)
  );
  const tsDiagnostics = hasErrorDiagnostics(frontendDiagnostics)
    ? []
    : collectPreparedViewTsDiagnostics(preparedView, frontendDiagnostics).filter((diagnostic) =>
      matchesPreparedAnalysisAnyFilePath(diagnostic.filePath, diagnosticPaths)
    );
  const hasFrontendErrors = hasErrorDiagnostics(frontendDiagnostics);
  const hasTsErrors = hasErrorDiagnostics(tsDiagnostics);
  const universalDiagnostics = hasFrontendErrors
    ? []
    : collectPreparedViewUniversalDiagnostics(preparedView, preparedView.analysisContext).filter(
      (diagnostic) => matchesPreparedAnalysisAnyFilePath(diagnostic.filePath, diagnosticPaths),
    );
  const soundDiagnostics = hasFrontendErrors
    ? []
    : collectPreparedViewSoundDiagnostics(preparedView, preparedView.analysisContext).filter(
      (diagnostic) => matchesPreparedAnalysisAnyFilePath(diagnostic.filePath, diagnosticPaths),
    );

  return {
    frontendDiagnostics,
    tsDiagnostics,
    soundDiagnostics: hasTsErrors
      ? retainSoundDiagnosticsAlongsideTsErrors([...universalDiagnostics, ...soundDiagnostics])
      : [...universalDiagnostics, ...soundDiagnostics],
  };
}

function retainSoundDiagnosticsAlongsideTsErrors(
  diagnostics: readonly MergedDiagnostic[],
): readonly SoundDiagnostic[] {
  return diagnostics.filter((diagnostic): diagnostic is SoundDiagnostic =>
    diagnostic.source === 'sound' &&
    (diagnostic.code === SOUND_DIAGNOSTIC_CODES.constructionLifecycleViolation ||
      diagnostic.code === SOUND_DIAGNOSTIC_CODES.fieldReadBeforeInitialization)
  );
}

function matchesPreparedAnalysisAnyFilePath(
  candidateFilePath: string | undefined,
  expectedFilePaths: readonly string[],
): boolean {
  return expectedFilePaths.some((expectedFilePath) =>
    matchesPreparedAnalysisFilePath(candidateFilePath, expectedFilePath)
  );
}

function collectPreparedViewFrontendDiagnosticPaths(
  preparedView: PreparedAnalysisView,
  filePath: string,
): readonly string[] {
  const diagnosticPaths = new Set<string>();
  const addDiagnosticPath = (candidateFilePath: string): void => {
    for (const variant of collectPreparedAnalysisFilePathCandidates(candidateFilePath)) {
      diagnosticPaths.add(variant);
    }
    if (isSoundscriptSourceFile(candidateFilePath)) {
      for (
        const variant of collectPreparedAnalysisFilePathCandidates(
          toProjectedDeclarationFileName(candidateFilePath),
        )
      ) {
        diagnosticPaths.add(variant);
      }
    }
  };

  addDiagnosticPath(filePath);

  const traversalRoots: Array<{
    readonly key: string;
    readonly program: ts.Program;
    readonly sourceFile: ts.SourceFile;
  }> = [];
  const addTraversalRoot = (
    key: string,
    program: ts.Program,
    sourceFile: ts.SourceFile | null,
  ): void => {
    if (!sourceFile || traversalRoots.some((root) => root.key === key)) {
      return;
    }
    traversalRoots.push({ key, program, sourceFile });
  };

  const sourceFileMatch = getPreparedViewSourceFileMatch(preparedView, filePath);
  addTraversalRoot('prepared', preparedView.program, sourceFileMatch?.sourceFile ?? null);

  const tsDiagnosticProgramMatch = getPreparedViewTsDiagnosticProgramMatch(preparedView, filePath);
  addTraversalRoot(
    `ts:${tsDiagnosticProgramMatch?.diagnosticProgram.filePaths?.join(',') ?? 'all'}`,
    tsDiagnosticProgramMatch?.diagnosticProgram.program ?? preparedView.program,
    tsDiagnosticProgramMatch?.sourceFile ?? null,
  );

  if (traversalRoots.length === 0) {
    return [...diagnosticPaths];
  }

  const visitedSourceFiles = new Set<string>();
  const getTraversalSourceFile = (
    program: ts.Program,
    candidateFilePath: string,
  ): ts.SourceFile | null => {
    for (const candidate of collectPreparedAnalysisFilePathCandidates(candidateFilePath)) {
      const sourceFile = program.getSourceFile(
        preparedView.preparedProgram.toProgramFileName(candidate),
      );
      if (sourceFile) {
        return sourceFile;
      }

      if (isSoundscriptSourceFile(candidate)) {
        const projectedCandidate = toProjectedDeclarationFileName(candidate);
        const projectedSourceFile = program.getSourceFile(
          preparedView.preparedProgram.toProgramFileName(projectedCandidate),
        );
        if (projectedSourceFile) {
          return projectedSourceFile;
        }
      }
    }

    return null;
  };

  const visit = (programKey: string, program: ts.Program, sourceFile: ts.SourceFile): void => {
    const sourceFilePath = preparedView.preparedProgram.toSourceFileName(sourceFile.fileName);
    const visitKey = `${programKey}:${sourceFilePath}`;
    if (visitedSourceFiles.has(visitKey)) {
      return;
    }
    visitedSourceFiles.add(visitKey);
    addDiagnosticPath(sourceFilePath);

    for (const moduleSpecifier of getStaticSourceFileModuleSpecifiers(sourceFile)) {
      const resolvedModule = resolveSoundScriptAwareModule(
        moduleSpecifier,
        sourceFilePath,
        preparedView.preparedProgram.options,
        preparedView.preparedProgram.preparedHost.host,
      );
      if (!resolvedModule) {
        continue;
      }

      const resolvedSourcePath = preparedView.preparedProgram.toSourceFileName(
        resolvedModule.resolvedFileName,
      );
      if (
        !isSoundscriptSourceFile(resolvedSourcePath) &&
        !isProjectedSoundscriptDeclarationFile(resolvedSourcePath)
      ) {
        continue;
      }

      addDiagnosticPath(resolvedSourcePath);
      const dependencySourceFile = getTraversalSourceFile(program, resolvedSourcePath);
      if (dependencySourceFile) {
        visit(programKey, program, dependencySourceFile);
      }
    }
  };

  for (const traversalRoot of traversalRoots) {
    visit(traversalRoot.key, traversalRoot.program, traversalRoot.sourceFile);
  }
  return [...diagnosticPaths];
}

function getStaticSourceFileModuleSpecifiers(sourceFile: ts.SourceFile): readonly string[] {
  const moduleSpecifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      moduleSpecifiers.push(statement.moduleSpecifier.text);
      continue;
    }

    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      moduleSpecifiers.push(statement.moduleReference.expression.text);
    }
  }

  return moduleSpecifiers;
}

function getPreparedViewTsDiagnosticProgramMatch(
  preparedView: PreparedAnalysisView,
  filePath: string,
): {
  readonly diagnosticProgram: BuiltinExpandedTsDiagnosticProgram;
  readonly matchedFilePath: string;
  readonly sourceFile: ts.SourceFile;
} | null {
  const preferredPrograms = [
    ...preparedView.tsDiagnosticPrograms.filter((program) => program.filePaths !== undefined),
    ...preparedView.tsDiagnosticPrograms.filter((program) => program.filePaths === undefined),
  ];

  for (const candidateFilePath of collectPreparedAnalysisFilePathCandidates(filePath)) {
    const programFileName = preparedView.preparedProgram.toProgramFileName(candidateFilePath);
    for (const diagnosticProgram of preferredPrograms) {
      if (
        diagnosticProgram.filePaths !== undefined &&
        !diagnosticProgram.filePaths.includes(candidateFilePath)
      ) {
        continue;
      }

      const sourceFile = diagnosticProgram.program.getSourceFile(programFileName);
      if (!sourceFile) {
        continue;
      }

      return {
        diagnosticProgram,
        matchedFilePath: candidateFilePath,
        sourceFile,
      };
    }
  }

  return null;
}

function collectPreparedViewTsDiagnostics(
  preparedView: PreparedAnalysisView,
  frontendDiagnostics: readonly MergedDiagnostic[],
  filePath?: string,
  requireSourceFile = false,
): readonly MergedDiagnostic[] {
  if (
    preparedView.universalPolicyScope === 'sourceSupplemental' ||
    hasErrorDiagnostics(frontendDiagnostics) ||
    (requireSourceFile && !filePath)
  ) {
    return [];
  }

  const sourceFileMatch = filePath
    ? getPreparedViewTsDiagnosticProgramMatch(preparedView, filePath)
    : null;
  if (requireSourceFile && !sourceFileMatch) {
    return [];
  }

  const metadata: Record<string, boolean | number | string | undefined> = {
    fileScoped: filePath !== undefined,
    requireSourceFile,
    rootCount: sourceFileMatch
      ? sourceFileMatch.diagnosticProgram.program.getRootFileNames().length
      : preparedView.program.getRootFileNames().length,
    universalPolicyScope: preparedView.universalPolicyScope,
  };
  if (sourceFileMatch) {
    metadata.filePath = sourceFileMatch.matchedFilePath;
  }
  const diagnostics = measureCheckerTiming(
    'project.analyze.tsDiagnostics',
    metadata,
    () => {
      const handledFilePaths = new Set(
        preparedView.tsDiagnosticPrograms.flatMap((diagnosticProgram) =>
          diagnosticProgram.filePaths ? [...diagnosticProgram.filePaths] : []
        ),
      );
      const collectedDiagnostics = sourceFileMatch
        ? ts.getPreEmitDiagnostics(
          sourceFileMatch.diagnosticProgram.program,
          sourceFileMatch.sourceFile,
        )
        : preparedView.tsDiagnosticPrograms.flatMap((diagnosticProgram) => {
          if (!diagnosticProgram.filePaths || diagnosticProgram.filePaths.length === 0) {
            return ts.getPreEmitDiagnostics(diagnosticProgram.program).filter((diagnostic) =>
              !diagnostic.file ||
              !handledFilePaths.has(toSourceFileName(diagnostic.file.fileName))
            );
          }

          return diagnosticProgram.filePaths.flatMap((diagnosticFilePath) => {
            const programFileName = preparedView.preparedProgram.toProgramFileName(
              diagnosticFilePath,
            );
            const diagnosticSourceFile = diagnosticProgram.program.getSourceFile(programFileName);
            return diagnosticSourceFile
              ? ts.getPreEmitDiagnostics(diagnosticProgram.program, diagnosticSourceFile)
              : [];
          });
        });
      metadata.diagnostics = collectedDiagnostics.length;
      return collectedDiagnostics;
    },
    { always: true },
  );

  return remapDiagnostics(
    diagnostics.map((diagnostic) =>
      toMappedMergedDiagnostic(diagnostic, preparedView.diagnosticPreparedFiles)
    ),
  );
}

function collectPreparedViewUniversalDiagnostics(
  preparedView: PreparedAnalysisView,
  analysisContext: AnalysisContext,
  filePath?: string,
): readonly SoundDiagnostic[] {
  const metadata: Record<string, boolean | number | string | undefined> = {
    fileScoped: filePath !== undefined,
    rootCount: preparedView.program.getRootFileNames().length,
    universalPolicyScope: preparedView.universalPolicyScope,
  };
  if (filePath) {
    metadata.filePath = filePath;
  }
  return measureCheckerTiming(
    'project.analyze.universalPolicy',
    metadata,
    () => {
      const diagnostics = remapDiagnostics(
        remapSoundDiagnostics(
          preparedView.universalPolicyScope === 'sourceSupplemental'
            ? runSourceSupplementalPolicyAnalysis(analysisContext)
            : runUniversalPolicyAnalysis(analysisContext),
          preparedView.diagnosticPreparedFiles,
        ),
      );
      metadata.diagnostics = diagnostics.length;
      return diagnostics;
    },
    { always: true },
  );
}

function collectPreparedViewSoundDiagnostics(
  preparedView: PreparedAnalysisView,
  analysisContext: AnalysisContext,
  filePath?: string,
): readonly SoundDiagnostic[] {
  const metadata: Record<string, boolean | number | string | undefined> = {
    fileScoped: filePath !== undefined,
    rootCount: preparedView.program.getRootFileNames().length,
    runSound: preparedView.runSound,
  };
  if (filePath) {
    metadata.filePath = filePath;
  }
  return measureCheckerTiming(
    'project.analyze.soundRules',
    metadata,
    () => {
      const diagnostics = remapDiagnostics(
        remapSoundDiagnostics(
          preparedView.runSound ? runSoundAnalysis(analysisContext) : [],
          preparedView.diagnosticPreparedFiles,
        ),
      );
      metadata.diagnostics = diagnostics.length;
      return diagnostics;
    },
    { always: true },
  );
}

function getFileScopedAnalysisContext(
  preparedView: PreparedAnalysisView,
  filePath: string,
): AnalysisContext | null {
  let byFile = fileScopedAnalysisContextCache.get(preparedView);
  if (!byFile) {
    byFile = new Map<string, AnalysisContext | null>();
    fileScopedAnalysisContextCache.set(preparedView, byFile);
  }

  const cached = byFile.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  const sourceFileMatch = getPreparedViewSourceFileMatch(preparedView, filePath);
  if (!sourceFileMatch) {
    byFile.set(filePath, null);
    return null;
  }
  const sourceFile = sourceFileMatch.sourceFile;
  const preparedSource = preparedView.preparedProgram.preparedHost.getPreparedSourceFile(
    sourceFileMatch.matchedFilePath,
  );
  if (
    hasTopLevelMacroReplacements(sourceFileMatch.matchedFilePath, preparedSource) ||
    hasGeneratedTopLevelStatements(sourceFile, preparedView.analysisContext.isGeneratedNode)
  ) {
    byFile.set(filePath, null);
    return null;
  }

  const analysisContext = createAnalysisContext({
    includeSourceFile: (candidate) =>
      matchesPreparedAnalysisFilePath(toSourceFileName(candidate.fileName), filePath) &&
      !isMacroAuthoringSourceFile(candidate, preparedView.analysisPreparedProgram),
    isSoundscriptSourceFile: preparedView.analysisPreparedProgram.isSoundscriptSourceFile,
    isGeneratedNode: createPreparedProgramGeneratedNodeDetector(
      preparedView.analysisPreparedProgram,
    ),
    program: preparedView.program,
    runtime: preparedView.analysisContext.runtime,
    workingDirectory: preparedView.analysisContext.workingDirectory,
  });
  byFile.set(filePath, analysisContext);
  return analysisContext;
}

function createSummary(diagnostics: readonly { category: 'error' | 'warning' | 'message' }[]) {
  return {
    total: diagnostics.length,
    errors: diagnostics.filter((diagnostic) => diagnostic.category === 'error').length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.category === 'warning').length,
    messages: diagnostics.filter((diagnostic) => diagnostic.category === 'message').length,
  };
}

function isMacroAuthoringSourceFile(
  sourceFile: ts.SourceFile,
  preparedProgram?: PreparedProgram,
): boolean {
  const sourceText = preparedProgram?.preparedHost.getPreparedSourceFile(
    toSourceFileName(sourceFile.fileName),
  )?.originalText ?? sourceFile.text;
  return sourceTextLooksLikeMacroModule(sourceText) ||
    usesLegacyDefineMacroAuthoring(sourceText);
}

function applyMacroCacheStatsToMetadata(
  metadata: Record<string, string | number>,
  macroCacheStats: MacroModuleCacheStats,
): void {
  metadata.macroCacheHits = macroCacheStats.moduleCacheHits;
  metadata.macroCacheMisses = macroCacheStats.moduleCacheMisses;
  metadata.macroCacheInvalidations = macroCacheStats.moduleCacheInvalidations;
  metadata.macroModulesEvaluated = macroCacheStats.evaluatedModules;
}

function createPreparedProgramGeneratedNodeDetector(
  preparedProgram: PreparedProgram,
): (node: ts.Node) => boolean {
  const preparedFileCache = new Map<string, PreparedSourceFile | null>();

  function getPreparedFile(sourceFile: ts.SourceFile | undefined): PreparedSourceFile | undefined {
    if (!sourceFile) {
      return undefined;
    }

    const sourceFileName = toSourceFileName(sourceFile.fileName);
    if (preparedFileCache.has(sourceFileName)) {
      return preparedFileCache.get(sourceFileName) ?? undefined;
    }

    const preparedFile = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
    preparedFileCache.set(sourceFileName, preparedFile ?? null);
    return preparedFile;
  }

  return (node: ts.Node): boolean => {
    if (ts.isSourceFile(node)) {
      return false;
    }

    const sourceFile = node.getSourceFile();
    const preparedFile = getPreparedFile(sourceFile);
    if (!preparedFile) {
      return false;
    }

    const programStart = node.getStart(sourceFile, false);
    const programEnd = node.getEnd();
    if (programEnd <= programStart) {
      return false;
    }

    const startMapping = mapProgramPositionToSource(preparedFile, programStart);
    const endMapping = mapProgramPositionToSource(
      preparedFile,
      Math.max(programStart, programEnd - 1),
    );
    return startMapping.insideReplacement && endMapping.insideReplacement;
  };
}

function aggregateMacroCacheStats(
  preparedProject: PreparedAnalysisProject,
): MacroModuleCacheStats {
  const aggregated: MacroModuleCacheStats = {
    evaluatedModules: 0,
    moduleCacheHits: 0,
    moduleCacheInvalidations: 0,
    moduleCacheMisses: 0,
  };

  for (
    const view of [
      preparedProject.tsView,
      preparedProject.stsView,
      preparedProject.packageSourcePolicyView,
    ]
  ) {
    if (!view) {
      continue;
    }

    aggregated.evaluatedModules += view.macroCacheStats.evaluatedModules;
    aggregated.moduleCacheHits += view.macroCacheStats.moduleCacheHits;
    aggregated.moduleCacheInvalidations += view.macroCacheStats.moduleCacheInvalidations;
    aggregated.moduleCacheMisses += view.macroCacheStats.moduleCacheMisses;
  }

  return aggregated;
}

function collectPreparedProjectViews(
  preparedProject: PreparedAnalysisProject | null | undefined,
): readonly PreparedAnalysisView[] {
  if (!preparedProject) {
    return [];
  }

  return [
    preparedProject.tsView,
    preparedProject.stsView,
    preparedProject.packageSourcePolicyView,
  ].filter((view): view is PreparedAnalysisView => view !== null);
}

export function disposePreparedAnalysisProject(
  preparedProject: PreparedAnalysisProject | null | undefined,
  retainedProject?: PreparedAnalysisProject | null,
): void {
  const retainedViews = new Set(collectPreparedProjectViews(retainedProject));
  const retainedPreparedPrograms = new Set<PreparedProgram>(
    collectPreparedProjectViews(retainedProject).flatMap((view) => [
      view.analysisPreparedProgram,
      view.preparedProgram,
    ]),
  );
  const retainedReuseStates = new Set<PreparedCompilerHostReuseState>(
    [...retainedPreparedPrograms].map((preparedProgram) => preparedProgram.preparedHost.reuseState),
  );
  const disposedMacroEnvironments = new Set<object>();
  const disposedPreparedPrograms = new Set<PreparedProgram>();

  for (const view of collectPreparedProjectViews(preparedProject)) {
    if (retainedViews.has(view)) {
      continue;
    }
    const macroEnvironment = view.macroEnvironment as object;
    if (disposedMacroEnvironments.has(macroEnvironment)) {
      continue;
    }
    disposedMacroEnvironments.add(macroEnvironment);
    view.macroEnvironment.dispose();

    for (const preparedProgram of [view.analysisPreparedProgram, view.preparedProgram]) {
      if (
        disposedPreparedPrograms.has(preparedProgram) ||
        retainedPreparedPrograms.has(preparedProgram)
      ) {
        continue;
      }
      disposedPreparedPrograms.add(preparedProgram);
      const reuseState = preparedProgram.preparedHost.reuseState;
      preparedProgram.dispose(false);
      if (!retainedReuseStates.has(reuseState)) {
        clearPreparedCompilerHostReuseState(reuseState);
      }
    }
  }
}

export function analyzeProject(options: AnalyzeProjectOptions): AnalyzeProjectResult {
  const preparedProject = prepareProjectAnalysis(options);
  try {
    return analyzePreparedProject(preparedProject);
  } finally {
    disposePreparedAnalysisProject(preparedProject);
  }
}

export function prepareProjectAnalysis(
  options: AnalyzeProjectOptions,
  reusableProject?: PreparedAnalysisProject,
  prepareOptions: PrepareProjectAnalysisOptions = {},
): PreparedAnalysisProject {
  const prepareMetadata: Record<string, string | number> = {
    projectPath: options.projectPath,
  };
  return measureCheckerTiming(
    'project.prepareProjectAnalysis',
    prepareMetadata,
    () => {
      const loadedConfig = loadConfig(
        options.projectPath,
        { target: options.target },
        options.additionalRootNames,
      );
      const projectPackageJsonPath = findNearestPackageJsonPath(options.projectPath, ts.sys);
      const configReuseSignature = createProjectConfigReuseSignature(
        options.projectPath,
        loadedConfig,
      );
      const soundscriptRootDiscoverySignature = createSoundscriptRootDiscoverySignature(
        options.projectPath,
        loadedConfig,
      );
      // Same-stem .sts roots are discovered from the current filesystem, so
      // reusing a previous discovered-root list can keep removed files alive
      // across prepared-project rebuilds.
      const configuredSoundscriptRootNames = collectSoundscriptRootNames(
        options.projectPath,
        loadedConfig,
      );
      const allRootNames = combineRootNames(
        combineRootNames(
          loadedConfig.commandLine.fileNames,
          configuredSoundscriptRootNames,
        ),
        options.additionalRootNames,
      );
      const soundscriptRootNames = allRootNames.filter(loadedConfig.isSoundscriptSourceFile);
      const declarationRootNames = allRootNames.filter(isDeclarationRootFileName);
      const stsProgramRootNames = combineRootNames(soundscriptRootNames, declarationRootNames);
      const typescriptRootNames = allRootNames.filter((fileName) =>
        !loadedConfig.isSoundscriptSourceFile(fileName) && !isDeclarationRootFileName(fileName)
      );
      const configFileParsingDiagnostics = getConfigFileParsingDiagnostics(
        loadedConfig.diagnostics,
        options.additionalRootNames,
      );
      const soundscriptFileOverridesSignature = createFileOverrideSignature(
        options.fileOverrides,
        loadedConfig.isSoundscriptSourceFile,
      );
      const soundscriptRootContentSignature = createSoundscriptRootContentSignature(
        stsProgramRootNames,
        loadedConfig.commandLine.options,
        options.fileOverrides,
        loadedConfig.isSoundscriptSourceFile,
      );
      const canReuseConfigArtifacts = reusableProject !== undefined &&
        reusableProject.analyzeOptions.projectPath === options.projectPath &&
        reusableProject.configReuseSignature === configReuseSignature;
      const canReuseStsArtifacts = canReuseConfigArtifacts &&
        rootNamesEqual(reusableProject.stsProgramRootNames, stsProgramRootNames) &&
        reusableProject.soundscriptRootContentSignature === soundscriptRootContentSignature &&
        reusableProject.soundscriptFileOverridesSignature === soundscriptFileOverridesSignature;
      const soundscriptRootNameSet = new Set(
        soundscriptRootNames.map((rootName) => ts.sys.resolvePath(rootName)),
      );
      const stsView = canReuseStsArtifacts ? reusableProject.stsView : (() => {
        const metadata: Record<string, string | number> = {
          rootCount: stsProgramRootNames.length,
        };
        return measureCheckerTiming(
          'project.prepare.stsView',
          metadata,
          () => {
            const preparedView = prepareAnalysisView(
              options,
              loadedConfig,
              stsProgramRootNames,
              createSoundStdlibCompilerHost(
                loadedConfig.commandLine.options,
                dirname(options.projectPath),
              ),
              [],
              (sourceFile, preparedProgram) =>
                shouldAnalyzeProjectSoundscriptSourceFile(
                  sourceFile,
                  preparedProgram,
                  projectPackageJsonPath,
                ),
              undefined,
              true,
              'full',
              canReuseConfigArtifacts ? reusableProject?.stsCompilerHostReuseState : undefined,
              canReuseConfigArtifacts ? reusableProject?.stsView?.program : undefined,
            );
            if (preparedView) {
              applyMacroCacheStatsToMetadata(metadata, preparedView.macroCacheStats);
            }
            return preparedView;
          },
          { always: true },
        );
      })();
      const shouldDeferTypescriptView = prepareOptions.deferTypescriptView === true;
      if (shouldDeferTypescriptView) {
        const canReuseLocalProjectedDeclarationOverrides = canReuseStsArtifacts &&
          reusableProject?.localProjectedDeclarationOverrides !== undefined;
        const localProjectedDeclarationOverrides = !canReuseLocalProjectedDeclarationOverrides
          ? undefined
          : reusableProject.localProjectedDeclarationOverrides;
        const preparedProject = {
          analyzeOptions: { ...options },
          configReuseSignature,
          configuredSoundscriptRootNames,
          isSoundscriptSourceFile: loadedConfig.isSoundscriptSourceFile,
          localProjectedDeclarationOverrides,
          packageSourcePolicyContentSignature: '',
          packageSourcePolicyCompilerHostReuseState: canReuseConfigArtifacts
            ? reusableProject?.packageSourcePolicyCompilerHostReuseState
            : undefined,
          packageSourcePolicyView: null,
          soundscriptConfiguredFileNames: loadedConfig.soundscriptConfiguredFileNames,
          soundscriptRootContentSignature,
          soundscriptRootDiscoverySignature,
          stsCompilerHostReuseState: stsView?.preparedProgram.preparedHost.reuseState,
          soundscriptFileOverridesSignature,
          stsProgramRootNames,
          soundscriptRootNames,
          stsView,
          tsCompilerHostReuseState: canReuseConfigArtifacts
            ? reusableProject?.tsCompilerHostReuseState
            : undefined,
          tsView: null,
        };
        applyMacroCacheStatsToMetadata(prepareMetadata, aggregateMacroCacheStats(preparedProject));
        return preparedProject;
      }
      const needsSupplementalProjectionViews = typescriptRootNames.length > 0 ||
        (stsView !== null &&
          hasNonRootProjectedDeclarationCandidates(
            stsView.program,
            soundscriptRootNameSet,
            projectPackageJsonPath,
          ));
      if (!needsSupplementalProjectionViews) {
        const preparedProject = {
          analyzeOptions: { ...options },
          configReuseSignature,
          configuredSoundscriptRootNames,
          isSoundscriptSourceFile: loadedConfig.isSoundscriptSourceFile,
          localProjectedDeclarationOverrides: undefined,
          packageSourcePolicyContentSignature: '',
          packageSourcePolicyCompilerHostReuseState: canReuseConfigArtifacts
            ? reusableProject?.packageSourcePolicyCompilerHostReuseState
            : undefined,
          packageSourcePolicyView: null,
          soundscriptConfiguredFileNames: loadedConfig.soundscriptConfiguredFileNames,
          soundscriptRootContentSignature,
          soundscriptRootDiscoverySignature,
          stsCompilerHostReuseState: stsView?.preparedProgram.preparedHost.reuseState,
          soundscriptFileOverridesSignature,
          stsProgramRootNames,
          soundscriptRootNames,
          stsView,
          tsCompilerHostReuseState: canReuseConfigArtifacts
            ? reusableProject?.tsCompilerHostReuseState
            : undefined,
          tsView: null,
        };
        applyMacroCacheStatsToMetadata(prepareMetadata, aggregateMacroCacheStats(preparedProject));
        return preparedProject;
      }

      const canReuseLocalProjectedDeclarationOverrides = canReuseStsArtifacts &&
        reusableProject?.localProjectedDeclarationOverrides !== undefined;
      const localProjectedDeclarationOverrides = canReuseLocalProjectedDeclarationOverrides
        ? reusableProject.localProjectedDeclarationOverrides
        : measureCheckerTiming(
          'project.prepare.localProjection',
          {
            hasStsView: stsView !== null,
            rootCount: soundscriptRootNames.length,
          },
          () =>
            filterProjectedDeclarationOverridesToRootNames(
              emitProjectedDeclarationsFailClosed(stsView, soundscriptRootNames),
              soundscriptRootNames,
            ),
          { always: true },
        );

      const preliminaryTsView = (() => {
        const metadata: Record<string, string | number> = {
          rootCount: typescriptRootNames.length,
          localProjectionCount: localProjectedDeclarationOverrides?.size ?? 0,
        };
        return measureCheckerTiming(
          'project.prepare.preliminaryTsView',
          metadata,
          () => {
            const preparedView = prepareAnalysisView(
              options,
              loadedConfig,
              typescriptRootNames,
              createSoundStdlibCompilerHost(
                loadedConfig.commandLine.options,
                dirname(options.projectPath),
              ),
              configFileParsingDiagnostics,
              (sourceFile) =>
                shouldAnalyzeTypescriptViewSourceFile(
                  sourceFile,
                  loadedConfig.isSoundscriptSourceFile,
                ),
              localProjectedDeclarationOverrides,
              false,
              'full',
              canReuseConfigArtifacts ? reusableProject?.tsCompilerHostReuseState : undefined,
              canReuseConfigArtifacts ? reusableProject?.tsView?.program : undefined,
            );
            if (preparedView) {
              applyMacroCacheStatsToMetadata(metadata, preparedView.macroCacheStats);
            }
            return preparedView;
          },
          { always: true },
        );
      })();
      const packageProjectedDeclarationRootNames = collectProjectedDeclarationCandidateRootNamesFromPrograms(
        [preliminaryTsView?.program, stsView?.program],
        localProjectedDeclarationOverrides,
        projectPackageJsonPath,
      );
      const packageSourcePolicyContentSignature = packageProjectedDeclarationRootNames.length === 0
        ? ''
        : createSoundscriptRootContentSignature(
          packageProjectedDeclarationRootNames,
          loadedConfig.commandLine.options,
          options.fileOverrides,
          loadedConfig.isSoundscriptSourceFile,
        );
      const packageProjectedDeclarationOverrides = measureCheckerTiming(
        'project.prepare.packageProjection',
        {
          candidateCount: packageProjectedDeclarationRootNames.length,
        },
        () => {
          if (packageProjectedDeclarationRootNames.length === 0 || !preliminaryTsView) {
            return undefined;
          }

          const expandedProgram = createBuiltinExpandedProgram({
            baseHost: createSoundStdlibCompilerHost(
              loadedConfig.commandLine.options,
              dirname(options.projectPath),
            ),
            configFileParsingDiagnostics: [],
            configuredSoundscriptFileNames: loadedConfig.soundscriptConfiguredFileNames,
            fileOverrides: options.fileOverrides ?? new Map(),
            options: loadedConfig.commandLine.options,
            projectReferences: loadedConfig.commandLine.projectReferences,
            projectedDeclarationOverrides: localProjectedDeclarationOverrides,
            runtime: loadedConfig.runtime,
            rootNames: packageProjectedDeclarationRootNames,
          });
          try {
            return emitProjectedDeclarations(
              expandedProgram.analysisPreparedProgram,
              packageProjectedDeclarationRootNames,
            );
          } finally {
            expandedProgram.dispose();
          }
        },
        { always: true },
      );
      const projectedDeclarationOverrides = mergeProjectedDeclarationOverrides(
        localProjectedDeclarationOverrides,
        packageProjectedDeclarationOverrides,
      );
      const canReusePackageSourcePolicyView = canReuseConfigArtifacts &&
        rootNamesEqual(
          reusableProject.packageSourcePolicyView?.program.getRootFileNames().map(
            toSourceFileName,
          ) ?? [],
          packageProjectedDeclarationRootNames,
        ) &&
        reusableProject.packageSourcePolicyContentSignature ===
          packageSourcePolicyContentSignature &&
        !projectedDeclarationOverridesDiffer(
          reusableProject.localProjectedDeclarationOverrides,
          localProjectedDeclarationOverrides,
        );
      const shouldRebuildTsView = projectedDeclarationOverridesDiffer(
        localProjectedDeclarationOverrides,
        projectedDeclarationOverrides,
      );

      const preparedProject = {
        analyzeOptions: { ...options },
        configReuseSignature,
        configuredSoundscriptRootNames,
        isSoundscriptSourceFile: loadedConfig.isSoundscriptSourceFile,
        localProjectedDeclarationOverrides,
        packageSourcePolicyContentSignature,
        packageSourcePolicyCompilerHostReuseState: canReusePackageSourcePolicyView
          ? reusableProject?.packageSourcePolicyCompilerHostReuseState
          : undefined,
        packageSourcePolicyView: canReusePackageSourcePolicyView
          ? reusableProject?.packageSourcePolicyView ?? null
          : measureCheckerTiming(
            'project.prepare.packageSourcePolicyView',
            {
              rootCount: packageProjectedDeclarationRootNames.length,
            },
            () =>
              prepareAnalysisView(
                options,
                loadedConfig,
                packageProjectedDeclarationRootNames,
                createSoundStdlibCompilerHost(
                  loadedConfig.commandLine.options,
                  dirname(options.projectPath),
                ),
                [],
                shouldAnalyzeSoundscriptSourceFile,
                localProjectedDeclarationOverrides,
                true,
                'sourceSupplemental',
                canReusePackageSourcePolicyView
                  ? reusableProject?.packageSourcePolicyCompilerHostReuseState
                  : undefined,
                canReusePackageSourcePolicyView
                  ? reusableProject?.packageSourcePolicyView?.program
                  : undefined,
              ),
            { always: true },
          ),
        soundscriptConfiguredFileNames: loadedConfig.soundscriptConfiguredFileNames,
        soundscriptRootContentSignature,
        soundscriptRootDiscoverySignature,
        stsCompilerHostReuseState: stsView?.preparedProgram.preparedHost.reuseState,
        soundscriptFileOverridesSignature,
        stsProgramRootNames,
        soundscriptRootNames,
        stsView,
        tsCompilerHostReuseState: preliminaryTsView?.preparedProgram.preparedHost.reuseState,
        tsView: shouldRebuildTsView
          ? (() => {
            const metadata: Record<string, string | number> = {
              rootCount: typescriptRootNames.length,
              projectionCount: projectedDeclarationOverrides?.size ?? 0,
            };
            return measureCheckerTiming(
              'project.prepare.finalTsView',
              metadata,
              () => {
                const preparedView = prepareAnalysisView(
                  options,
                  loadedConfig,
                  typescriptRootNames,
                  ts.createCompilerHost(loadedConfig.commandLine.options),
                  configFileParsingDiagnostics,
                  (sourceFile) =>
                    shouldAnalyzeTypescriptViewSourceFile(
                      sourceFile,
                      loadedConfig.isSoundscriptSourceFile,
                    ),
                  projectedDeclarationOverrides,
                  false,
                  'full',
                  preliminaryTsView?.preparedProgram.preparedHost.reuseState ??
                    reusableProject?.tsCompilerHostReuseState,
                  preliminaryTsView?.program,
                );
                if (preparedView) {
                  applyMacroCacheStatsToMetadata(metadata, preparedView.macroCacheStats);
                }
                return preparedView;
              },
              { always: true },
            );
          })()
          : preliminaryTsView,
      };
      applyMacroCacheStatsToMetadata(prepareMetadata, aggregateMacroCacheStats(preparedProject));
      return preparedProject;
    },
    { always: true },
  );
}

export function getPreparedAnalysisViewForFile(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
): PreparedAnalysisView | null {
  if (preparedProject.isSoundscriptSourceFile(filePath)) {
    const packageSourceView = preparedProject.packageSourcePolicyView;
    if (
      packageSourceView &&
      isNodeModulesPath(filePath) &&
      getPreparedViewSourceFileMatch(packageSourceView, filePath)
    ) {
      return packageSourceView;
    }
    const stsView = preparedProject.stsView;
    if (stsView && getPreparedViewSourceFileMatch(stsView, filePath)) {
      return stsView;
    }
    if (packageSourceView && getPreparedViewSourceFileMatch(packageSourceView, filePath)) {
      return packageSourceView;
    }
    return stsView;
  }

  return preparedProject.tsView;
}

function getPreparedAnalysisSupplementalViewsForFile(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
  primaryView: PreparedAnalysisView | null,
): readonly PreparedAnalysisView[] {
  const supplementalViews: PreparedAnalysisView[] = [];

  const addView = (view: PreparedAnalysisView | null): void => {
    if (!view || view === primaryView || supplementalViews.includes(view)) {
      return;
    }
    supplementalViews.push(view);
  };

  if (preparedProject.isSoundscriptSourceFile(filePath)) {
    addView(preparedProject.packageSourcePolicyView);
    return supplementalViews;
  }

  addView(preparedProject.stsView);
  addView(preparedProject.packageSourcePolicyView);
  return supplementalViews;
}

export function analyzePreparedProjectForFile(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
): AnalyzeProjectResult {
  return measureCheckerTiming(
    'project.analyzePreparedProjectForFile',
    {
      filePath,
      hasTsView: preparedProject.tsView !== null,
      hasStsView: preparedProject.stsView !== null,
    },
    () => {
      const primaryView = getPreparedAnalysisViewForFile(preparedProject, filePath);
      const primaryAnalysis = analyzePreparedViewForFile(primaryView, filePath);
      const diagnosticPaths = primaryView
        ? collectPreparedViewFrontendDiagnosticPaths(primaryView, filePath)
        : [filePath];
      const primaryDependencyAnalysis = analyzePreparedViewForDiagnosticPaths(
        primaryView,
        diagnosticPaths,
      );
      const supplementalAnalyses = getPreparedAnalysisSupplementalViewsForFile(
        preparedProject,
        filePath,
        primaryView,
      ).map((view) => analyzePreparedViewForDiagnosticPaths(view, diagnosticPaths));
      const diagnostics = dedupeMergedDiagnostics([
        ...primaryAnalysis.frontendDiagnostics,
        ...primaryAnalysis.tsDiagnostics,
        ...primaryAnalysis.soundDiagnostics,
        ...primaryDependencyAnalysis.frontendDiagnostics,
        ...primaryDependencyAnalysis.tsDiagnostics,
        ...primaryDependencyAnalysis.soundDiagnostics,
        ...supplementalAnalyses.flatMap((analyzedProgram) => [
          ...analyzedProgram.frontendDiagnostics,
          ...analyzedProgram.tsDiagnostics,
          ...analyzedProgram.soundDiagnostics,
        ]),
      ]);

      return {
        diagnostics,
        summary: createSummary(diagnostics),
      };
    },
    { always: true },
  );
}

function collectPreparedAnalysisFilePathCandidates(filePath: string): readonly string[] {
  const candidates = new Set<string>();
  const addCandidate = (candidate: string | undefined): void => {
    if (candidate) {
      candidates.add(candidate);
    }
  };

  addCandidate(filePath);
  if (isProjectedSoundscriptDeclarationFile(filePath)) {
    addCandidate(toProjectedDeclarationSourceFileName(filePath));
  }
  addCandidate(ts.sys.resolvePath(filePath));
  if (isProjectedSoundscriptDeclarationFile(filePath)) {
    addCandidate(ts.sys.resolvePath(toProjectedDeclarationSourceFileName(filePath)));
  }

  try {
    const realPath = ts.sys.realpath?.(filePath);
    addCandidate(realPath);
    if (realPath) {
      addCandidate(ts.sys.resolvePath(realPath));
      if (isProjectedSoundscriptDeclarationFile(realPath)) {
        const sourcePath = toProjectedDeclarationSourceFileName(realPath);
        addCandidate(sourcePath);
        addCandidate(ts.sys.resolvePath(sourcePath));
      }
    }
  } catch {
    // Ignore realpath failures for virtual or missing paths and fall back to the raw path.
  }

  return [...candidates];
}

function matchesPreparedAnalysisFilePath(
  candidateFilePath: string | undefined,
  expectedFilePath: string,
): boolean {
  if (!candidateFilePath) {
    return false;
  }

  if (candidateFilePath === expectedFilePath) {
    return true;
  }

  const expectedCandidates = new Set(collectPreparedAnalysisFilePathCandidates(expectedFilePath));
  if (expectedCandidates.has(candidateFilePath)) {
    return true;
  }

  return collectPreparedAnalysisFilePathCandidates(candidateFilePath).some((candidate) =>
    expectedCandidates.has(candidate)
  );
}

export function filterAnalyzedDiagnosticsForFile<T extends MergedDiagnostic>(
  diagnostics: readonly T[],
  filePath: string,
): T[] {
  return diagnostics.filter((diagnostic) =>
    matchesPreparedAnalysisFilePath(diagnostic.filePath, filePath)
  );
}

function getPreparedViewSourceFileMatch(
  preparedView: PreparedAnalysisView,
  filePath: string,
): { readonly matchedFilePath: string; readonly sourceFile: ts.SourceFile } | null {
  for (const candidateFilePath of collectPreparedAnalysisFilePathCandidates(filePath)) {
    const programFileName = preparedView.preparedProgram.toProgramFileName(candidateFilePath);
    const sourceFile = preparedView.program.getSourceFile(programFileName);
    if (sourceFile) {
      return {
        matchedFilePath: candidateFilePath,
        sourceFile,
      };
    }
  }

  return null;
}

export function analyzePreparedProject(
  preparedProject: PreparedAnalysisProject,
): AnalyzeProjectResult {
  return measureCheckerTiming(
    'project.analyzePreparedProject',
    {
      hasTsView: preparedProject.tsView !== null,
      hasStsView: preparedProject.stsView !== null,
    },
    () => {
      const analyzedPrograms = [
        analyzePreparedView(preparedProject.tsView),
        analyzePreparedView(preparedProject.stsView),
        analyzePreparedView(preparedProject.packageSourcePolicyView),
      ];
      const diagnostics = dedupeMergedDiagnostics(analyzedPrograms.flatMap((programResult) => [
        ...programResult.frontendDiagnostics,
        ...programResult.tsDiagnostics,
        ...programResult.soundDiagnostics,
      ]));

      return {
        diagnostics,
        summary: createSummary(diagnostics),
      };
    },
    { always: true },
  );
}

function dedupeMergedDiagnostics<T extends MergedDiagnostic>(diagnostics: readonly T[]): T[] {
  const deduped: T[] = [];
  const seen = new Set<string>();

  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.source,
      diagnostic.code,
      diagnostic.filePath ?? '',
      diagnostic.line ?? 0,
      diagnostic.column ?? 0,
      diagnostic.endLine ?? 0,
      diagnostic.endColumn ?? 0,
      diagnostic.message,
    ].join('\u0000');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(diagnostic);
  }

  return deduped;
}
