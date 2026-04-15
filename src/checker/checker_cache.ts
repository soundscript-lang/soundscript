import { createHash } from 'node:crypto';

import ts from 'typescript';

import { collectSoundscriptRootNames, loadConfig, type RuntimeTarget } from '../project/config.ts';
import { emitProjectedDeclarations } from '../frontend/project_frontend.ts';
import { resolveSoundScriptAwareModule } from '../project/soundscript_packages.ts';
import {
  basename,
  dirname,
  join,
} from '../platform/path.ts';
import {
  makeDirectorySync,
  pathExistsSync,
  readTextFileSync,
  removePathSync,
  renamePathSync,
  writeTextFileSync,
} from '../platform/host.ts';
import type { AnalyzeProjectOptions, AnalyzeProjectResult } from '../service/types.ts';
import {
  analyzePreparedProjectWithArtifacts,
  analyzePreparedProjectOwnedDiagnosticsForFileWithArtifacts,
  capturePersistentPreparedAnalysisProjectReuseSnapshots,
  collectPreparedAnalysisProjectFileMetadata,
  collectPreparedAnalysisProjectTrackedFilePaths,
  disposePreparedAnalysisProject,
  filterAnalyzedDiagnosticsForFile,
  matchesPreparedAnalysisAnyFilePath,
  prepareProjectAnalysis,
  type AnalyzePreparedProjectWithArtifactsResult,
  type PersistentPreparedAnalysisProjectReuseSnapshots,
  type PreparedAnalysisProject,
  type PreparedAnalysisProjectFileMetadata,
  type PreparedProjectAnalysisArtifacts,
} from './analyze_project.ts';
import { measureCheckerTiming } from './timing.ts';
import type { MergedDiagnostic } from './diagnostics.ts';
import type { FlowFileRuleCache } from './rules/flow.ts';
import type { FileDiagnosticRuleCacheEntry } from './rules/index.ts';
import { getSoundscriptToolFingerprint } from '../version.ts';

const CHECKER_CACHE_SCHEMA_VERSION = 8;
const CHECKER_CACHE_ROOT_DIRECTORY = '.soundscript-cache';
const CHECKER_CACHE_SUBDIRECTORY = 'checker';
const CHECKER_CACHE_BUILD_INFO_SUBDIRECTORY = 'buildinfo';
const dependencySignaturePrinter = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});
const sourceSurfaceSignaturePrinter = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

interface CheckerCacheHeader {
  configDiagnosticsSignature: string;
  configSignature: string;
  projectFileHash: string;
  projectPath: string;
  rootNames: readonly string[];
  runtimeTarget: RuntimeTarget;
  soundscriptRootDiscoverySignature: string;
  targetOverride?: RuntimeTarget;
  toolFingerprint: string;
}

interface CheckerCacheFileEntry extends PreparedAnalysisProjectFileMetadata {
  effectCache?: FileDiagnosticRuleCacheEntry;
  flowCache?: FlowFileRuleCache;
  relationCache?: FileDiagnosticRuleCacheEntry;
  result: AnalyzeProjectResult;
  valueTypeCache?: FileDiagnosticRuleCacheEntry;
}

interface CheckerCacheManifest {
  cachedAt: string;
  dependencyDependents: Readonly<Record<string, readonly string[]>>;
  dependencySignatures: Readonly<Record<string, string>>;
  files: readonly CheckerCacheFileEntry[];
  header: CheckerCacheHeader;
  prepareArtifacts?: PersistentPreparedAnalysisProjectReuseSnapshots;
  result: AnalyzeProjectResult;
  schemaVersion: number;
  sourceSurfaceSignatures: Readonly<Record<string, string>>;
  trackedFiles: Readonly<Record<string, string>>;
  unownedDiagnostics: readonly MergedDiagnostic[];
}

type CheckerCacheReadResult =
  | {
    kind: 'hit';
    manifest: CheckerCacheManifest;
    result: AnalyzeProjectResult;
  }
  | {
    changedTrackedFiles: readonly string[];
    kind: 'stale';
    manifest: CheckerCacheManifest;
  }
  | {
    kind: 'miss';
  };

interface IncrementalCheckerCacheReuseResult {
  manifest: CheckerCacheManifest;
  refreshedFiles: number;
  reusedFiles: number;
}

interface DependencySignatureUpdateResult {
  changedDependencyFiles: readonly string[];
  dependencySignatureFilesEmitted: number;
  dependencySignatureWaves: number;
  dependencySignatures: Readonly<Record<string, string>>;
}

interface DependencySignatureTrackedFileSelection {
  changedTrackedFiles: readonly string[];
  exportedSurfaceChangedFiles: number;
  exportedSurfaceReusedFiles: number;
}

const UNDEFINED_JSON_SENTINEL_KEY = '__soundscriptUndefined';
const undefinedJsonSentinel = { [UNDEFINED_JSON_SENTINEL_KEY]: true } as const;

export interface PersistentCheckerRunOptions extends AnalyzeProjectOptions {
  cacheDir?: string;
  useCache?: boolean;
}

export interface PersistentCheckerAnalysisWithReuseResult {
  prepareArtifacts?: PersistentPreparedAnalysisProjectReuseSnapshots;
  result: AnalyzeProjectResult;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const recordValue = value as Record<string, unknown>;
  const entries = Object.keys(recordValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(recordValue[key])}`);
  return `{${entries.join(',')}}`;
}

function hashText(text: string): string {
  return ts.sys.createHash?.(text) ?? createHash('sha256').update(text).digest('hex');
}

function hashPath(path: string): string {
  return createHash('sha256').update(ts.sys.resolvePath(path)).digest('hex').slice(0, 16);
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
    .map((fileName) => fileName.startsWith('/') ? fileName : join(basePath, fileName))
    .map((fileName) => ts.sys.resolvePath(fileName))
    .filter(loadedConfig.isSoundscriptSourceFile)
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

function createConfigDiagnosticsSignature(
  loadedConfig: ReturnType<typeof loadConfig>,
): string {
  return loadedConfig.diagnostics.map((diagnostic: ts.Diagnostic) =>
    [
      diagnostic.code,
      String(diagnostic.category),
      diagnostic.file?.fileName ?? '',
      diagnostic.start ?? '',
      diagnostic.length ?? '',
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ].join('\u0001')
  ).join('\u0002');
}

function createCheckerCacheHeader(
  options: PersistentCheckerRunOptions,
): CheckerCacheHeader {
  const projectPath = ts.sys.resolvePath(options.projectPath);
  const loadedConfig = loadConfig(projectPath, { target: options.target });
  const rootNames = [
    ...new Set([
      ...loadedConfig.commandLine.fileNames,
      ...collectSoundscriptRootNames(projectPath, loadedConfig),
    ]),
  ].sort();

  return {
    configDiagnosticsSignature: createConfigDiagnosticsSignature(loadedConfig),
    configSignature: stableStringify({
      commandLineOptions: loadedConfig.commandLine.options,
      frontierCommandLineOptions: loadedConfig.frontierCommandLine.options,
      frontierProjectReferences: loadedConfig.frontierCommandLine.projectReferences ?? [],
      projectReferences: loadedConfig.commandLine.projectReferences ?? [],
      raw: loadedConfig.commandLine.raw,
      runtime: loadedConfig.runtime,
    }),
    projectFileHash: hashText(ts.sys.readFile(projectPath) ?? ''),
    projectPath,
    rootNames,
    runtimeTarget: loadedConfig.runtime.target,
    soundscriptRootDiscoverySignature: createSoundscriptRootDiscoverySignature(
      projectPath,
      loadedConfig,
    ),
    targetOverride: options.target,
    toolFingerprint: getSoundscriptToolFingerprint(),
  };
}

function checkerCacheHeadersEqual(
  left: CheckerCacheHeader,
  right: CheckerCacheHeader,
): boolean {
  return left.projectPath === right.projectPath &&
    left.targetOverride === right.targetOverride &&
    left.runtimeTarget === right.runtimeTarget &&
    left.toolFingerprint === right.toolFingerprint &&
    left.projectFileHash === right.projectFileHash &&
    left.configSignature === right.configSignature &&
    left.configDiagnosticsSignature === right.configDiagnosticsSignature &&
    left.soundscriptRootDiscoverySignature === right.soundscriptRootDiscoverySignature &&
    left.rootNames.length === right.rootNames.length &&
    left.rootNames.every((rootName, index) => rootName === right.rootNames[index]);
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function checkerCacheFileMetadataEqual(
  left: PreparedAnalysisProjectFileMetadata,
  right: PreparedAnalysisProjectFileMetadata,
): boolean {
  return left.filePath === right.filePath &&
    left.fileScopedAnalysis === right.fileScopedAnalysis &&
    left.view === right.view &&
    stringArraysEqual(left.directDependencyPaths, right.directDependencyPaths) &&
    stringArraysEqual(left.cacheDependencyPaths, right.cacheDependencyPaths) &&
    stringArraysEqual(left.diagnosticPaths, right.diagnosticPaths);
}

function dedupeDiagnostics<T extends MergedDiagnostic>(diagnostics: readonly T[]): T[] {
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

function createSummary(diagnostics: readonly MergedDiagnostic[]) {
  return {
    total: diagnostics.length,
    errors: diagnostics.filter((diagnostic) => diagnostic.category === 'error').length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.category === 'warning').length,
    messages: diagnostics.filter((diagnostic) => diagnostic.category === 'message').length,
  };
}

function createTrackedFileHashes(
  trackedFilePaths: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(trackedFilePaths.map((filePath) => [
    filePath,
    hashText(ts.sys.readFile(filePath) ?? ''),
  ]));
}

function collectChangedTrackedFilePaths(
  trackedFiles: Readonly<Record<string, string>>,
): readonly string[] {
  const changedFilePaths: string[] = [];
  for (const [filePath, cachedHash] of Object.entries(trackedFiles)) {
    const currentText = ts.sys.readFile(filePath);
    if (currentText === undefined || hashText(currentText) !== cachedHash) {
      changedFilePaths.push(filePath);
    }
  }

  changedFilePaths.sort();
  return changedFilePaths;
}

function trackedFilePathKeys(
  trackedFiles: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.keys(trackedFiles).sort();
}

function isDependencySignatureFileMetadata(
  metadata: PreparedAnalysisProjectFileMetadata,
): boolean {
  return metadata.filePath.endsWith('.sts') &&
    (metadata.view === 'sts' || metadata.view === 'packageSource');
}

function createDependencySignatureViewByFilePath(
  fileMetadata: readonly PreparedAnalysisProjectFileMetadata[],
): ReadonlyMap<string, PreparedAnalysisProjectFileMetadata['view']> {
  return new Map(
    fileMetadata
      .filter(isDependencySignatureFileMetadata)
      .map((metadata) => [metadata.filePath, metadata.view]),
  );
}

function hasExportLikeModifier(statement: ts.Statement): boolean {
  return (ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined)?.some((modifier) =>
    modifier.kind === ts.SyntaxKind.DefaultKeyword ||
    modifier.kind === ts.SyntaxKind.ExportKeyword
  ) ?? false;
}

function getSurfaceSignatureScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createSourceSurfaceSignature(
  filePath: string,
  text: string,
): string {
  try {
    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      getSurfaceSignatureScriptKind(filePath),
    );

    const parts: string[] = [];
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement) ||
        ts.isExportAssignment(statement) ||
        ts.isExportDeclaration(statement)
      ) {
        parts.push(sourceSurfaceSignaturePrinter.printNode(ts.EmitHint.Unspecified, statement, sourceFile));
        continue;
      }
      if (!hasExportLikeModifier(statement)) {
        continue;
      }
      parts.push(sourceSurfaceSignaturePrinter.printNode(ts.EmitHint.Unspecified, statement, sourceFile));
    }

    return hashText(parts.join('\u0000'));
  } catch {
    return hashText(text);
  }
}

function getPreparedProjectDependencySignatureView(
  preparedProject: PreparedAnalysisProject,
  viewKind: PreparedAnalysisProjectFileMetadata['view'],
): PreparedAnalysisProject['stsView'] | PreparedAnalysisProject['packageSourcePolicyView'] {
  return viewKind === 'packageSource' ? preparedProject.packageSourcePolicyView : preparedProject.stsView;
}

function createPreparedProjectSourceSurfaceSignatures(
  preparedProject: PreparedAnalysisProject,
  fileMetadata: readonly PreparedAnalysisProjectFileMetadata[],
): Readonly<Record<string, string>> {
  const fileViewByFilePath = createDependencySignatureViewByFilePath(fileMetadata);
  return Object.fromEntries(
    [...fileViewByFilePath.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, viewKind]) => {
        const preparedView = getPreparedProjectDependencySignatureView(preparedProject, viewKind);
        const sourceFile = preparedView?.program.getSourceFile(
          preparedView.preparedProgram.toProgramFileName(filePath),
        );
        const text = sourceFile?.text ?? ts.sys.readFile(filePath) ?? '';
        return [filePath, createSourceSurfaceSignature(filePath, text)] as const;
      }),
  );
}

function selectTrackedFilesForDependencySignatureUpdate(
  changedTrackedFiles: readonly string[],
  fileViewByFilePath: ReadonlyMap<string, PreparedAnalysisProjectFileMetadata['view']>,
  previousSourceSurfaceSignatures: Readonly<Record<string, string>>,
  nextSourceSurfaceSignatures: Readonly<Record<string, string>>,
): DependencySignatureTrackedFileSelection {
  const selectedTrackedFiles: string[] = [];
  let exportedSurfaceChangedFiles = 0;
  let exportedSurfaceReusedFiles = 0;

  for (const changedTrackedFilePath of changedTrackedFiles) {
    const dependencyFilePath = findDependencySignatureFilePath(changedTrackedFilePath, fileViewByFilePath);
    if (!dependencyFilePath) {
      selectedTrackedFiles.push(changedTrackedFilePath);
      continue;
    }

    const previousSignature = previousSourceSurfaceSignatures[dependencyFilePath];
    const nextSignature = nextSourceSurfaceSignatures[dependencyFilePath];
    if (
      previousSignature !== undefined &&
      nextSignature !== undefined &&
      previousSignature === nextSignature
    ) {
      exportedSurfaceReusedFiles += 1;
      continue;
    }

    selectedTrackedFiles.push(changedTrackedFilePath);
    exportedSurfaceChangedFiles += 1;
  }

  return {
    changedTrackedFiles: selectedTrackedFiles,
    exportedSurfaceChangedFiles,
    exportedSurfaceReusedFiles,
  };
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

function collectPreparedViewDependencyDependents(
  preparedView: PreparedAnalysisProject['stsView'] | PreparedAnalysisProject['packageSourcePolicyView'],
  filePaths: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  if (!preparedView || filePaths.length === 0) {
    return new Map();
  }

  const filePathSet = new Set(filePaths);
  const dependentsByFilePath = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    dependentsByFilePath.set(filePath, new Set());
  }

  for (const filePath of filePaths) {
    const sourceFile = preparedView.program.getSourceFile(
      preparedView.preparedProgram.toProgramFileName(filePath),
    );
    if (!sourceFile) {
      continue;
    }

    for (const moduleSpecifier of getStaticSourceFileModuleSpecifiers(sourceFile)) {
      const resolvedModule = resolveSoundScriptAwareModule(
        moduleSpecifier,
        filePath,
        preparedView.preparedProgram.options,
        preparedView.preparedProgram.preparedHost.host,
      );
      if (!resolvedModule) {
        continue;
      }

      const dependencyFilePath = preparedView.preparedProgram.toSourceFileName(
        resolvedModule.resolvedFileName,
      );
      if (!filePathSet.has(dependencyFilePath)) {
        continue;
      }

      dependentsByFilePath.get(dependencyFilePath)?.add(filePath);
    }
  }

  return new Map(
    [...dependentsByFilePath.entries()].map(([filePath, dependents]) => [
      filePath,
      [...dependents].sort(),
    ]),
  );
}

function collectPreparedProjectDependencyDependents(
  preparedProject: PreparedAnalysisProject,
  fileViewByFilePath: ReadonlyMap<string, PreparedAnalysisProjectFileMetadata['view']>,
): ReadonlyMap<string, readonly string[]> {
  const stsFilePaths = [...fileViewByFilePath.entries()]
    .filter(([, view]) => view === 'sts')
    .map(([filePath]) => filePath);
  const packageSourceFilePaths = [...fileViewByFilePath.entries()]
    .filter(([, view]) => view === 'packageSource')
    .map(([filePath]) => filePath);
  const dependents = new Map<string, Set<string>>();

  const addDependents = (entries: ReadonlyMap<string, readonly string[]>): void => {
    for (const [filePath, fileDependents] of entries) {
      const target = dependents.get(filePath) ?? new Set<string>();
      for (const dependent of fileDependents) {
        target.add(dependent);
      }
      dependents.set(filePath, target);
    }
  };

  addDependents(collectPreparedViewDependencyDependents(preparedProject.stsView, stsFilePaths));
  addDependents(
    collectPreparedViewDependencyDependents(
      preparedProject.packageSourcePolicyView,
      packageSourceFilePaths,
    ),
  );

  return new Map(
    [...dependents.entries()].map(([filePath, fileDependents]) => [
      filePath,
      [...fileDependents].sort(),
    ]),
  );
}

function serializeDependencyDependents(
  dependencyDependents: ReadonlyMap<string, readonly string[]>,
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    [...dependencyDependents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, fileDependents]) => [filePath, [...fileDependents].sort()]),
  );
}

function restoreDependencyDependents(
  dependencyDependents: Readonly<Record<string, readonly string[]>>,
): ReadonlyMap<string, readonly string[]> {
  return new Map(
    Object.entries(dependencyDependents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, fileDependents]) => [filePath, [...fileDependents].sort()]),
  );
}

function collectPreparedViewDirectDependencyImports(
  preparedView: PreparedAnalysisProject['stsView'] | PreparedAnalysisProject['packageSourcePolicyView'],
  importerFilePaths: readonly string[],
  allowedDependencyFilePaths: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  if (!preparedView || importerFilePaths.length === 0) {
    return new Map();
  }

  const dependenciesByFilePath = new Map<string, Set<string>>();
  for (const filePath of importerFilePaths) {
    dependenciesByFilePath.set(filePath, new Set());
  }

  for (const filePath of importerFilePaths) {
    const sourceFile = preparedView.program.getSourceFile(
      preparedView.preparedProgram.toProgramFileName(filePath),
    );
    if (!sourceFile) {
      continue;
    }

    for (const moduleSpecifier of getStaticSourceFileModuleSpecifiers(sourceFile)) {
      const resolvedModule = resolveSoundScriptAwareModule(
        moduleSpecifier,
        filePath,
        preparedView.preparedProgram.options,
        preparedView.preparedProgram.preparedHost.host,
      );
      if (!resolvedModule) {
        continue;
      }

      const dependencyFilePath = preparedView.preparedProgram.toSourceFileName(
        resolvedModule.resolvedFileName,
      );
      if (!allowedDependencyFilePaths.has(dependencyFilePath)) {
        continue;
      }

      dependenciesByFilePath.get(filePath)?.add(dependencyFilePath);
    }
  }

  return new Map(
    [...dependenciesByFilePath.entries()].map(([filePath, dependencies]) => [
      filePath,
      [...dependencies].sort(),
    ]),
  );
}

function updatePreparedProjectDependencyDependents(
  preparedProject: PreparedAnalysisProject,
  fileMetadata: readonly PreparedAnalysisProjectFileMetadata[],
  changedTrackedFiles: readonly string[],
  previousDependencyDependents: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const fileViewByFilePath = createDependencySignatureViewByFilePath(fileMetadata);
  const changedDependencyFilePaths = changedTrackedFiles
    .map((changedTrackedFilePath) =>
      findDependencySignatureFilePath(changedTrackedFilePath, fileViewByFilePath)
    )
    .filter((filePath): filePath is string => filePath !== undefined);
  if (changedDependencyFilePaths.length === 0) {
    return serializeDependencyDependents(restoreDependencyDependents(previousDependencyDependents));
  }

  const dependencyDependents = new Map<string, Set<string>>();
  for (const filePath of fileViewByFilePath.keys()) {
    dependencyDependents.set(filePath, new Set(previousDependencyDependents[filePath] ?? []));
  }

  for (const dependents of dependencyDependents.values()) {
    for (const changedFilePath of changedDependencyFilePaths) {
      dependents.delete(changedFilePath);
    }
  }

  const changedFilePathSet = new Set(changedDependencyFilePaths);
  const allowedDependencyFilePaths = new Set(fileViewByFilePath.keys());
  const directImportsByFilePath = new Map<string, readonly string[]>();
  const collectImportsForView = (
    view: PreparedAnalysisProject['stsView'] | PreparedAnalysisProject['packageSourcePolicyView'],
    viewKind: PreparedAnalysisProjectFileMetadata['view'],
  ): void => {
    const viewFilePaths = changedDependencyFilePaths.filter((filePath) =>
      fileViewByFilePath.get(filePath) === viewKind
    );
    const imports = collectPreparedViewDirectDependencyImports(
      view,
      [...changedFilePathSet].filter((filePath) => fileViewByFilePath.get(filePath) === viewKind),
      allowedDependencyFilePaths,
    );
    for (const [filePath, directImports] of imports) {
      directImportsByFilePath.set(filePath, directImports);
    }
    for (const filePath of viewFilePaths) {
      if (!directImportsByFilePath.has(filePath)) {
        directImportsByFilePath.set(filePath, []);
      }
    }
  };

  collectImportsForView(preparedProject.stsView, 'sts');
  collectImportsForView(preparedProject.packageSourcePolicyView, 'packageSource');

  for (const [filePath, directImports] of directImportsByFilePath) {
    for (const dependencyFilePath of directImports) {
      const dependents = dependencyDependents.get(dependencyFilePath) ?? new Set<string>();
      dependents.add(filePath);
      dependencyDependents.set(dependencyFilePath, dependents);
    }
  }

  return serializeDependencyDependents(
    new Map(
      [...dependencyDependents.entries()].map(([filePath, dependents]) => [
        filePath,
        [...dependents].sort(),
      ]),
    ),
  );
}

function emitPreparedProjectDependencySignatureHashes(
  preparedProject: PreparedAnalysisProject,
  fileViewByFilePath: ReadonlyMap<string, PreparedAnalysisProjectFileMetadata['view']>,
  filePaths: readonly string[],
): Readonly<Record<string, string>> {
  const signatures: Record<string, string> = {};
  const emitForView = (
    view: PreparedAnalysisProject['stsView'] | PreparedAnalysisProject['packageSourcePolicyView'],
    viewKind: PreparedAnalysisProjectFileMetadata['view'],
  ): void => {
    if (!view) {
      return;
    }

    const rootNames = filePaths.filter((filePath) => fileViewByFilePath.get(filePath) === viewKind);
    if (rootNames.length === 0) {
      return;
    }

    let projectedDeclarations: ReadonlyMap<string, string>;
    try {
      projectedDeclarations = emitProjectedDeclarations(view.analysisPreparedProgram, rootNames);
    } catch {
      return;
    }

    for (const [filePath, projectedDeclarationText] of projectedDeclarations) {
      signatures[filePath] = hashText(
        normalizeProjectedDeclarationTextForDependencySignature(projectedDeclarationText),
      );
    }
  };

  emitForView(preparedProject.stsView, 'sts');
  emitForView(preparedProject.packageSourcePolicyView, 'packageSource');
  return signatures;
}

function createPreparedProjectDependencySignatures(
  preparedProject: PreparedAnalysisProject,
  fileMetadata: readonly PreparedAnalysisProjectFileMetadata[],
): Readonly<Record<string, string>> {
  const fileViewByFilePath = createDependencySignatureViewByFilePath(fileMetadata);
  return emitPreparedProjectDependencySignatureHashes(
    preparedProject,
    fileViewByFilePath,
    [...fileViewByFilePath.keys()],
  );
}

function normalizeProjectedDeclarationTextForDependencySignature(text: string): string {
  try {
    const sourceFile = ts.createSourceFile(
      'dependency-signature.d.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    return dependencySignaturePrinter.printFile(sourceFile);
  } catch {
    return text;
  }
}

function findDependencySignatureFilePath(
  changedFilePath: string,
  fileViewByFilePath: ReadonlyMap<string, PreparedAnalysisProjectFileMetadata['view']>,
): string | undefined {
  for (const filePath of fileViewByFilePath.keys()) {
    if (matchesPreparedAnalysisAnyFilePath(changedFilePath, [filePath])) {
      return filePath;
    }
  }

  return undefined;
}

function updatePreparedProjectDependencySignatures(
  preparedProject: PreparedAnalysisProject,
  fileMetadata: readonly PreparedAnalysisProjectFileMetadata[],
  changedTrackedFiles: readonly string[],
  dependencyDependents: Readonly<Record<string, readonly string[]>>,
  previousDependencySignatures: Readonly<Record<string, string>>,
): DependencySignatureUpdateResult {
  const fileViewByFilePath = createDependencySignatureViewByFilePath(fileMetadata);
  const dependencySignatures: Record<string, string> = {
    ...previousDependencySignatures,
  };
  const changedDependencyFiles = new Set<string>();
  const queuedFilePaths = new Set<string>();
  let pendingFilePaths: string[] = [];
  let dependencySignatureFilesEmitted = 0;
  let dependencySignatureWaves = 0;

  for (const changedTrackedFilePath of changedTrackedFiles) {
    const dependencyFilePath = findDependencySignatureFilePath(changedTrackedFilePath, fileViewByFilePath);
    if (!dependencyFilePath) {
      changedDependencyFiles.add(changedTrackedFilePath);
      continue;
    }
    if (queuedFilePaths.has(dependencyFilePath)) {
      continue;
    }
    queuedFilePaths.add(dependencyFilePath);
    pendingFilePaths.push(dependencyFilePath);
  }

  while (pendingFilePaths.length > 0) {
    const currentWaveFilePaths = pendingFilePaths;
    pendingFilePaths = [];
    dependencySignatureWaves += 1;

    const emittedSignatures = emitPreparedProjectDependencySignatureHashes(
      preparedProject,
      fileViewByFilePath,
      currentWaveFilePaths,
    );
    dependencySignatureFilesEmitted += currentWaveFilePaths.length;

    for (const filePath of currentWaveFilePaths) {
      const previousSignature = dependencySignatures[filePath];
      const nextSignature = emittedSignatures[filePath];
      const changed = previousSignature !== nextSignature;

      if (nextSignature === undefined) {
        delete dependencySignatures[filePath];
      } else {
        dependencySignatures[filePath] = nextSignature;
      }

      if (!changed) {
        continue;
      }

      changedDependencyFiles.add(filePath);
      for (const dependentFilePath of dependencyDependents[filePath] ?? []) {
        if (queuedFilePaths.has(dependentFilePath)) {
          continue;
        }
        queuedFilePaths.add(dependentFilePath);
        pendingFilePaths.push(dependentFilePath);
      }
    }
  }

  const nextDependencySignatures = Object.fromEntries(
    [...fileViewByFilePath.keys()]
      .sort()
      .flatMap((filePath) => {
        const signature = dependencySignatures[filePath];
        return signature === undefined ? [] : [[filePath, signature] as const];
      }),
  );

  return {
    changedDependencyFiles: [...changedDependencyFiles].sort(),
    dependencySignatureFilesEmitted,
    dependencySignatureWaves,
    dependencySignatures: nextDependencySignatures,
  };
}

function readCheckerCacheManifest(
  manifestPath: string,
): CheckerCacheManifest | null {
  if (!pathExistsSync(manifestPath)) {
    return null;
  }

  try {
    const parsed = restoreUndefinedJsonValues(
      JSON.parse(readTextFileSync(manifestPath)),
    ) as CheckerCacheManifest;
    return parsed.schemaVersion === CHECKER_CACHE_SCHEMA_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function replaceUndefinedJsonValues(value: unknown): unknown {
  if (value === undefined) {
    return undefinedJsonSentinel;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceUndefinedJsonValues(entry));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      replaceUndefinedJsonValues(entryValue),
    ]),
  );
}

function restoreUndefinedJsonValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => restoreUndefinedJsonValues(entry));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const recordValue = value as Record<string, unknown>;
  if (
    Object.keys(recordValue).length === 1 &&
    recordValue[UNDEFINED_JSON_SENTINEL_KEY] === true
  ) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(recordValue).map(([key, entryValue]) => [
      key,
      restoreUndefinedJsonValues(entryValue),
    ]),
  );
}

function splitDiagnosticsByFileOwnership(
  diagnostics: readonly MergedDiagnostic[],
  fileMetadata: readonly PreparedAnalysisProjectFileMetadata[],
): {
  readonly byFile: ReadonlyMap<string, readonly MergedDiagnostic[]>;
  readonly unowned: readonly MergedDiagnostic[];
} {
  const diagnosticsByFile = new Map<string, MergedDiagnostic[]>(
    fileMetadata.map((metadata) => [metadata.filePath, []]),
  );
  const unowned: MergedDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const owner = fileMetadata.find((metadata) =>
      filterAnalyzedDiagnosticsForFile([diagnostic], metadata.filePath).length > 0
    );
    if (!owner) {
      unowned.push(diagnostic);
      continue;
    }

    diagnosticsByFile.get(owner.filePath)!.push(diagnostic);
  }

  return {
    byFile: diagnosticsByFile,
    unowned,
  };
}

function createPreparedProjectAnalysisArtifactsByFilePath(
  filePath: string,
  effectCache: FileDiagnosticRuleCacheEntry | undefined,
  flowCache: FlowFileRuleCache | undefined,
  relationCache: FileDiagnosticRuleCacheEntry | undefined,
  valueTypeCache: FileDiagnosticRuleCacheEntry | undefined,
): PreparedProjectAnalysisArtifacts {
  return {
    effectsByFile: effectCache ? new Map([[filePath, effectCache]]) : new Map(),
    flowByFile: flowCache ? new Map([[filePath, flowCache]]) : new Map(),
    relationsByFile: relationCache ? new Map([[filePath, relationCache]]) : new Map(),
    valueTypesByFile: valueTypeCache ? new Map([[filePath, valueTypeCache]]) : new Map(),
  };
}

function combineCachedFileResults(
  files: readonly CheckerCacheFileEntry[],
  unownedDiagnostics: readonly MergedDiagnostic[],
): AnalyzeProjectResult {
  const diagnostics = dedupeDiagnostics([
    ...unownedDiagnostics,
    ...files.flatMap((file) => file.result.diagnostics),
  ]);
  return {
    diagnostics,
    summary: createSummary(diagnostics),
  };
}

function createCheckerCacheManifestFromFullAnalysis(
  header: CheckerCacheHeader,
  preparedProjectFileMetadata: readonly PreparedAnalysisProjectFileMetadata[],
  dependencyDependents: Readonly<Record<string, readonly string[]>>,
  trackedFiles: Readonly<Record<string, string>>,
  dependencySignatures: Readonly<Record<string, string>>,
  sourceSurfaceSignatures: Readonly<Record<string, string>>,
  prepareArtifacts: PersistentPreparedAnalysisProjectReuseSnapshots,
  analysis: AnalyzePreparedProjectWithArtifactsResult,
): CheckerCacheManifest {
  const splitDiagnostics = splitDiagnosticsByFileOwnership(
    analysis.result.diagnostics,
    preparedProjectFileMetadata,
  );
  return {
    cachedAt: new Date().toISOString(),
    dependencyDependents,
    dependencySignatures,
    files: preparedProjectFileMetadata.map((metadata) => {
      const diagnostics = [...(splitDiagnostics.byFile.get(metadata.filePath) ?? [])];
      return {
        ...metadata,
        effectCache: analysis.artifacts.effectsByFile.get(metadata.filePath),
        flowCache: analysis.artifacts.flowByFile.get(metadata.filePath),
        relationCache: analysis.artifacts.relationsByFile.get(metadata.filePath),
        result: {
          diagnostics,
          summary: createSummary(diagnostics),
        },
        valueTypeCache: analysis.artifacts.valueTypesByFile.get(metadata.filePath),
      };
    }),
    header,
    prepareArtifacts,
    result: analysis.result,
    schemaVersion: CHECKER_CACHE_SCHEMA_VERSION,
    sourceSurfaceSignatures,
    trackedFiles,
    unownedDiagnostics: splitDiagnostics.unowned,
  };
}

function createIncrementalCheckerCacheManifest(
  header: CheckerCacheHeader,
  trackedFiles: Readonly<Record<string, string>>,
  dependencyDependents: Readonly<Record<string, readonly string[]>>,
  dependencySignatures: Readonly<Record<string, string>>,
  sourceSurfaceSignatures: Readonly<Record<string, string>>,
  prepareArtifacts: PersistentPreparedAnalysisProjectReuseSnapshots,
  files: readonly CheckerCacheFileEntry[],
  unownedDiagnostics: readonly MergedDiagnostic[],
): CheckerCacheManifest {
  return {
    cachedAt: new Date().toISOString(),
    dependencyDependents,
    dependencySignatures,
    files,
    header,
    prepareArtifacts,
    result: combineCachedFileResults(files, unownedDiagnostics),
    schemaVersion: CHECKER_CACHE_SCHEMA_VERSION,
    sourceSurfaceSignatures,
    trackedFiles,
    unownedDiagnostics,
  };
}

function createCheckerCacheProjectDirectory(
  projectPath: string,
  cacheDir: string | undefined,
): string {
  const cacheBaseDirectory = cacheDir ??
    join(dirname(projectPath), CHECKER_CACHE_ROOT_DIRECTORY, CHECKER_CACHE_SUBDIRECTORY);
  return join(cacheBaseDirectory, hashPath(projectPath));
}

function createCheckerCacheBuildInfoDirectory(
  projectPath: string,
  cacheDir: string | undefined,
): string {
  return join(
    createCheckerCacheProjectDirectory(projectPath, cacheDir),
    CHECKER_CACHE_BUILD_INFO_SUBDIRECTORY,
  );
}

export function resolveCheckerCacheDirectory(
  projectPath: string,
  cacheDir?: string,
): string {
  return createCheckerCacheProjectDirectory(projectPath, cacheDir);
}

function createCheckerCacheManifestPath(
  projectPath: string,
  cacheDir: string | undefined,
): string {
  return join(createCheckerCacheProjectDirectory(projectPath, cacheDir), 'manifest.json');
}

function readCheckerCacheResult(
  options: PersistentCheckerRunOptions,
  header: CheckerCacheHeader,
): CheckerCacheReadResult {
  const manifestPath = createCheckerCacheManifestPath(options.projectPath, options.cacheDir);
  const manifest = readCheckerCacheManifest(manifestPath);
  if (!manifest) {
    return { kind: 'miss' };
  }
  if (!checkerCacheHeadersEqual(manifest.header, header)) {
    return { kind: 'miss' };
  }
  const changedTrackedFiles = collectChangedTrackedFilePaths(manifest.trackedFiles);
  if (changedTrackedFiles.length === 0) {
    return {
      kind: 'hit',
      manifest,
      result: manifest.result,
    };
  }

  return {
    changedTrackedFiles,
    kind: 'stale',
    manifest,
  };
}

function tryReusePartialCheckerCacheManifest(
  header: CheckerCacheHeader,
  manifest: CheckerCacheManifest,
  changedTrackedFiles: readonly string[],
  changedDependencyFiles: readonly string[],
  preparedProjectFileMetadata: readonly PreparedAnalysisProjectFileMetadata[],
  preparedProjectTrackedFilePaths: readonly string[],
  dependencyDependents: Readonly<Record<string, readonly string[]>>,
  preparedProjectDependencySignatures: Readonly<Record<string, string>>,
  sourceSurfaceSignatures: Readonly<Record<string, string>>,
  prepareArtifacts: PersistentPreparedAnalysisProjectReuseSnapshots,
  analyzeFile: (
    filePath: string,
    caches: {
      effectCache: FileDiagnosticRuleCacheEntry | undefined;
      flowCache: FlowFileRuleCache | undefined;
      relationCache: FileDiagnosticRuleCacheEntry | undefined;
      valueTypeCache: FileDiagnosticRuleCacheEntry | undefined;
    },
  ) => CheckerCacheFileEntry,
): IncrementalCheckerCacheReuseResult | null {
  if (manifest.unownedDiagnostics.length > 0) {
    return null;
  }
  if (
    !stringArraysEqual(
      manifest.files.map((file) => file.filePath),
      preparedProjectFileMetadata.map((file) => file.filePath),
    ) ||
    !stringArraysEqual(
      trackedFilePathKeys(manifest.trackedFiles),
      preparedProjectTrackedFilePaths,
    )
  ) {
    return null;
  }

  const previousFilesByPath = new Map(manifest.files.map((file) => [file.filePath, file]));
  const nextFiles: CheckerCacheFileEntry[] = [];
  let refreshedFiles = 0;
  let reusedFiles = 0;

  for (const metadata of preparedProjectFileMetadata) {
    const previousFile = previousFilesByPath.get(metadata.filePath);
    if (!previousFile) {
      return null;
    }

    const fileChanged = changedTrackedFiles.some((changedFilePath) =>
      matchesPreparedAnalysisAnyFilePath(changedFilePath, [previousFile.filePath]) ||
      matchesPreparedAnalysisAnyFilePath(changedFilePath, [metadata.filePath])
    );
    const shouldRefresh = !checkerCacheFileMetadataEqual(previousFile, metadata) ||
      fileChanged ||
      changedDependencyFiles.some((changedFilePath) =>
        matchesPreparedAnalysisAnyFilePath(changedFilePath, previousFile.cacheDependencyPaths) ||
        matchesPreparedAnalysisAnyFilePath(changedFilePath, metadata.cacheDependencyPaths)
      );
    if (!shouldRefresh) {
      nextFiles.push({
        ...metadata,
        effectCache: previousFile.effectCache,
        flowCache: previousFile.flowCache,
        relationCache: previousFile.relationCache,
        result: previousFile.result,
        valueTypeCache: previousFile.valueTypeCache,
      });
      reusedFiles += 1;
      continue;
    }

    if (!previousFile.fileScopedAnalysis || !metadata.fileScopedAnalysis) {
      return null;
    }

    nextFiles.push(analyzeFile(metadata.filePath, {
      effectCache: previousFile.effectCache,
      flowCache: previousFile.flowCache,
      relationCache: previousFile.relationCache,
      valueTypeCache: previousFile.valueTypeCache,
    }));
    refreshedFiles += 1;
  }

  return {
    manifest: createIncrementalCheckerCacheManifest(
      header,
      createTrackedFileHashes(preparedProjectTrackedFilePaths),
      dependencyDependents,
      preparedProjectDependencySignatures,
      sourceSurfaceSignatures,
      prepareArtifacts,
      nextFiles,
      manifest.unownedDiagnostics,
    ),
    refreshedFiles,
    reusedFiles,
  };
}

function writeCheckerCacheManifest(
  options: PersistentCheckerRunOptions,
  manifest: CheckerCacheManifest,
): void {
  const cacheProjectDirectory = createCheckerCacheProjectDirectory(options.projectPath, options.cacheDir);
  makeDirectorySync(cacheProjectDirectory);
  const manifestPath = join(cacheProjectDirectory, 'manifest.json');
  const temporaryPath = join(
    cacheProjectDirectory,
    `${basename(manifestPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  writeTextFileSync(
    temporaryPath,
    `${JSON.stringify(replaceUndefinedJsonValues(manifest), null, 2)}\n`,
  );
  try {
    renamePathSync(temporaryPath, manifestPath);
  } catch (error) {
    removePathSync(temporaryPath);
    throw error;
  }
}

export function writePreparedProjectToPersistentCheckerCache(
  options: PersistentCheckerRunOptions,
  preparedProject: PreparedAnalysisProject,
  analysis: AnalyzePreparedProjectWithArtifactsResult,
  prepareArtifacts?: PersistentPreparedAnalysisProjectReuseSnapshots,
): PersistentPreparedAnalysisProjectReuseSnapshots | undefined {
  const useCache = options.useCache ?? true;
  if (!useCache) {
    return prepareArtifacts;
  }

  const cacheProjectDirectory = createCheckerCacheProjectDirectory(options.projectPath, options.cacheDir);
  const header = measureCheckerTiming(
    'project.cache.preflight',
    {
      cacheDir: cacheProjectDirectory,
      projectPath: options.projectPath,
    },
    () => createCheckerCacheHeader(options),
    { always: true },
  );
  const preparedProjectTrackedFilePaths = measureCheckerTiming(
    'project.cache.trackedFiles',
    {
      projectPath: options.projectPath,
    },
    () => collectPreparedAnalysisProjectTrackedFilePaths(preparedProject),
    { always: true },
  );
  const preparedProjectFileMetadata = measureCheckerTiming(
    'project.cache.fileMetadata',
    {
      projectPath: options.projectPath,
    },
    () => collectPreparedAnalysisProjectFileMetadata(preparedProject),
    { always: true },
  );
  const dependencyDependents = measureCheckerTiming(
    'project.cache.dependencyDependents',
    {
      changedTrackedFiles: preparedProjectTrackedFilePaths.length,
      projectPath: options.projectPath,
    },
    () =>
      serializeDependencyDependents(
        collectPreparedProjectDependencyDependents(
          preparedProject,
          createDependencySignatureViewByFilePath(preparedProjectFileMetadata),
        ),
      ),
    { always: true },
  );
  const preparedProjectDependencySignatures = measureCheckerTiming(
    'project.cache.dependencySignatures',
    {
      changedTrackedFiles: preparedProjectTrackedFilePaths.length,
      projectPath: options.projectPath,
    },
    () =>
      createPreparedProjectDependencySignatures(
        preparedProject,
        preparedProjectFileMetadata,
      ),
    { always: true },
  );
  const sourceSurfaceSignatures = measureCheckerTiming(
    'project.cache.sourceSurfaceSignatures',
    {
      changedTrackedFiles: preparedProjectTrackedFilePaths.length,
      projectPath: options.projectPath,
    },
    () =>
      createPreparedProjectSourceSurfaceSignatures(
        preparedProject,
        preparedProjectFileMetadata,
      ),
    { always: true },
  );
  const nextPrepareArtifacts = prepareArtifacts ??
    measureCheckerTiming(
      'project.cache.prepareArtifacts',
      {
        projectPath: options.projectPath,
      },
      () => capturePersistentPreparedAnalysisProjectReuseSnapshots(preparedProject),
      { always: true },
    );
  const manifest = measureCheckerTiming(
    'project.cache.fullManifest',
    {
      files: preparedProjectTrackedFilePaths.length,
      projectPath: options.projectPath,
    },
    () =>
      createCheckerCacheManifestFromFullAnalysis(
        header,
        preparedProjectFileMetadata,
        dependencyDependents,
        createTrackedFileHashes(preparedProjectTrackedFilePaths),
        preparedProjectDependencySignatures,
        sourceSurfaceSignatures,
        nextPrepareArtifacts,
        analysis,
      ),
    { always: true },
  );
  try {
    measureCheckerTiming(
      'project.cache.write',
      {
        cacheDir: cacheProjectDirectory,
        files: Object.keys(manifest.trackedFiles).length,
        projectPath: options.projectPath,
      },
      () => writeCheckerCacheManifest(options, manifest),
      { always: true },
    );
  } catch {
    // Cache write failures must not change checker behavior.
  }

  return nextPrepareArtifacts;
}

export function analyzeProjectWithPersistentCacheForReuse(
  options: PersistentCheckerRunOptions,
): PersistentCheckerAnalysisWithReuseResult {
  const useCache = options.useCache ?? true;
  const cacheProjectDirectory = createCheckerCacheProjectDirectory(options.projectPath, options.cacheDir);
  const header = useCache
    ? measureCheckerTiming(
      'project.cache.preflight',
      {
        cacheDir: cacheProjectDirectory,
        projectPath: options.projectPath,
      },
      () => createCheckerCacheHeader(options),
      { always: true },
    )
    : null;
  const cacheReadResult = useCache && header
    ? measureCheckerTiming(
      'project.cache.read',
      {
        cacheDir: cacheProjectDirectory,
        projectPath: options.projectPath,
      },
      () => readCheckerCacheResult(options, header),
      { always: true },
    )
    : { kind: 'miss' } as CheckerCacheReadResult;

  if (cacheReadResult.kind === 'hit') {
    return {
      prepareArtifacts: cacheReadResult.manifest.prepareArtifacts,
      result: cacheReadResult.result,
    };
  }

  const persistentBuildInfoDirectory = useCache
    ? createCheckerCacheBuildInfoDirectory(options.projectPath, options.cacheDir)
    : undefined;
  const preparedProject = prepareProjectAnalysis(options, undefined, {
    persistentBuildInfoDirectory,
    persistentReuseSnapshots: cacheReadResult.kind === 'stale'
      ? cacheReadResult.manifest.prepareArtifacts
      : undefined,
  });
  try {
    const previousMetadataByFilePath = cacheReadResult.kind === 'stale'
      ? new Map(
        cacheReadResult.manifest.files.map((file) => [
          file.filePath,
          {
            cacheDependencyPaths: file.cacheDependencyPaths,
            directDependencyPaths: file.directDependencyPaths,
            diagnosticPaths: file.diagnosticPaths,
            filePath: file.filePath,
            fileScopedAnalysis: file.fileScopedAnalysis,
            view: file.view,
          },
        ]),
      )
      : new Map();
    const preparedProjectTrackedFilePaths = measureCheckerTiming(
      'project.cache.trackedFiles',
      {
        projectPath: options.projectPath,
      },
      () => collectPreparedAnalysisProjectTrackedFilePaths(preparedProject),
      { always: true },
    );
    const reusedCandidateFilePaths = cacheReadResult.kind === 'stale' &&
        stringArraysEqual(
          trackedFilePathKeys(cacheReadResult.manifest.trackedFiles),
          preparedProjectTrackedFilePaths,
        )
      ? cacheReadResult.manifest.files.map((file) => file.filePath)
      : [];
    const preparedProjectFileMetadata = measureCheckerTiming(
      'project.cache.fileMetadata',
      {
        projectPath: options.projectPath,
      },
      () =>
        collectPreparedAnalysisProjectFileMetadata(
          preparedProject,
          previousMetadataByFilePath,
          cacheReadResult.kind === 'stale' ? cacheReadResult.changedTrackedFiles : [],
          reusedCandidateFilePaths,
        ),
      { always: true },
    );

    if (useCache && header && cacheReadResult.kind === 'stale') {
      const sourceSurfaceSignatures = measureCheckerTiming(
        'project.cache.sourceSurfaceSignatures',
        {
          changedTrackedFiles: cacheReadResult.changedTrackedFiles.length,
          projectPath: options.projectPath,
        },
        () =>
          createPreparedProjectSourceSurfaceSignatures(
            preparedProject,
            preparedProjectFileMetadata,
          ),
        { always: true },
      );
      const dependencyDependents = measureCheckerTiming(
        'project.cache.dependencyDependents',
        {
          changedTrackedFiles: cacheReadResult.changedTrackedFiles.length,
          projectPath: options.projectPath,
        },
        () =>
          updatePreparedProjectDependencyDependents(
            preparedProject,
            preparedProjectFileMetadata,
            cacheReadResult.changedTrackedFiles,
            cacheReadResult.manifest.dependencyDependents,
          ),
        { always: true },
      );
      const dependencySignatureTrackedFiles = selectTrackedFilesForDependencySignatureUpdate(
        cacheReadResult.changedTrackedFiles,
        createDependencySignatureViewByFilePath(preparedProjectFileMetadata),
        cacheReadResult.manifest.sourceSurfaceSignatures ?? {},
        sourceSurfaceSignatures,
      );
      const dependencySignatureUpdate = measureCheckerTiming(
        'project.cache.dependencySignatures',
        {
          changedTrackedFiles: dependencySignatureTrackedFiles.changedTrackedFiles.length,
          exportedSurfaceChangedFiles: dependencySignatureTrackedFiles.exportedSurfaceChangedFiles,
          exportedSurfaceReusedFiles: dependencySignatureTrackedFiles.exportedSurfaceReusedFiles,
          projectPath: options.projectPath,
        },
        () =>
          updatePreparedProjectDependencySignatures(
            preparedProject,
            preparedProjectFileMetadata,
            dependencySignatureTrackedFiles.changedTrackedFiles,
            dependencyDependents,
            cacheReadResult.manifest.dependencySignatures,
          ),
        { always: true },
      );
      const preparedProjectReuseSnapshots = measureCheckerTiming(
        'project.cache.prepareArtifacts',
        {
          projectPath: options.projectPath,
        },
        () => capturePersistentPreparedAnalysisProjectReuseSnapshots(preparedProject),
        { always: true },
      );
      const incrementalReuse = measureCheckerTiming(
        'project.cache.incremental',
        {
          cacheDir: cacheProjectDirectory,
          changedDependencyFiles: dependencySignatureUpdate.changedDependencyFiles.length,
          changedTrackedFiles: cacheReadResult.changedTrackedFiles.length,
          dependencySignatureFilesEmitted: dependencySignatureUpdate.dependencySignatureFilesEmitted,
          dependencySignatureWaves: dependencySignatureUpdate.dependencySignatureWaves,
          exportedSurfaceChangedFiles: dependencySignatureTrackedFiles.exportedSurfaceChangedFiles,
          exportedSurfaceReusedFiles: dependencySignatureTrackedFiles.exportedSurfaceReusedFiles,
          projectPath: options.projectPath,
        },
        () =>
          tryReusePartialCheckerCacheManifest(
            header,
            cacheReadResult.manifest,
            cacheReadResult.changedTrackedFiles,
            dependencySignatureUpdate.changedDependencyFiles,
            preparedProjectFileMetadata,
            preparedProjectTrackedFilePaths,
            dependencyDependents,
            dependencySignatureUpdate.dependencySignatures,
            sourceSurfaceSignatures,
            preparedProjectReuseSnapshots,
            (filePath, caches) => {
              const analysis = analyzePreparedProjectOwnedDiagnosticsForFileWithArtifacts(
                preparedProject,
                filePath,
                createPreparedProjectAnalysisArtifactsByFilePath(
                  filePath,
                  caches.effectCache,
                  caches.flowCache,
                  caches.relationCache,
                  caches.valueTypeCache,
                ),
              );
              const ownedDiagnostics = filterAnalyzedDiagnosticsForFile(
                analysis.result.diagnostics,
                filePath,
              );
              const metadata = preparedProjectFileMetadata.find((entry) => entry.filePath === filePath)!;
              return {
                ...metadata,
                effectCache: analysis.artifacts.effectsByFile.get(filePath),
                flowCache: analysis.artifacts.flowByFile.get(filePath),
                relationCache: analysis.artifacts.relationsByFile.get(filePath),
                result: {
                  diagnostics: ownedDiagnostics,
                  summary: createSummary(ownedDiagnostics),
                },
                valueTypeCache: analysis.artifacts.valueTypesByFile.get(filePath),
              };
            },
          ),
        { always: true },
      );
      if (incrementalReuse) {
        const incrementalMetadata: Record<string, number | string> = {
          cacheDir: cacheProjectDirectory,
          projectPath: options.projectPath,
          refreshedFiles: incrementalReuse.refreshedFiles,
          reusedFiles: incrementalReuse.reusedFiles,
        };
        measureCheckerTiming(
          'project.cache.incremental.result',
          incrementalMetadata,
          () => undefined,
          { always: true },
        );
        try {
          measureCheckerTiming(
            'project.cache.write',
            {
              cacheDir: cacheProjectDirectory,
              files: Object.keys(incrementalReuse.manifest.trackedFiles).length,
              projectPath: options.projectPath,
            },
            () => writeCheckerCacheManifest(options, incrementalReuse.manifest),
            { always: true },
          );
        } catch {
          // Cache write failures must not change checker behavior.
        }
        return {
          prepareArtifacts: incrementalReuse.manifest.prepareArtifacts,
          result: incrementalReuse.manifest.result,
        };
      }
    }

    const analysis = analyzePreparedProjectWithArtifacts(preparedProject);
    if (useCache && header) {
      const dependencyDependents = measureCheckerTiming(
        'project.cache.dependencyDependents',
        {
          changedTrackedFiles: preparedProjectTrackedFilePaths.length,
          projectPath: options.projectPath,
        },
        () =>
          serializeDependencyDependents(
            collectPreparedProjectDependencyDependents(
              preparedProject,
              createDependencySignatureViewByFilePath(preparedProjectFileMetadata),
            ),
          ),
        { always: true },
      );
      const preparedProjectDependencySignatures = measureCheckerTiming(
        'project.cache.dependencySignatures',
        {
          changedTrackedFiles: preparedProjectTrackedFilePaths.length,
          projectPath: options.projectPath,
        },
        () =>
          createPreparedProjectDependencySignatures(
            preparedProject,
            preparedProjectFileMetadata,
          ),
        { always: true },
      );
      const sourceSurfaceSignatures = measureCheckerTiming(
        'project.cache.sourceSurfaceSignatures',
        {
          changedTrackedFiles: preparedProjectTrackedFilePaths.length,
          projectPath: options.projectPath,
        },
        () =>
          createPreparedProjectSourceSurfaceSignatures(
            preparedProject,
            preparedProjectFileMetadata,
          ),
        { always: true },
      );
      const preparedProjectReuseSnapshots = measureCheckerTiming(
        'project.cache.prepareArtifacts',
        {
          projectPath: options.projectPath,
        },
        () => capturePersistentPreparedAnalysisProjectReuseSnapshots(preparedProject),
        { always: true },
      );
      const manifest = measureCheckerTiming(
        'project.cache.fullManifest',
        {
          files: preparedProjectTrackedFilePaths.length,
          projectPath: options.projectPath,
        },
        () =>
          createCheckerCacheManifestFromFullAnalysis(
            header,
            preparedProjectFileMetadata,
            dependencyDependents,
            createTrackedFileHashes(preparedProjectTrackedFilePaths),
            preparedProjectDependencySignatures,
            sourceSurfaceSignatures,
            preparedProjectReuseSnapshots,
            analysis,
          ),
        { always: true },
      );
      try {
        measureCheckerTiming(
          'project.cache.write',
          {
            cacheDir: cacheProjectDirectory,
            files: Object.keys(manifest.trackedFiles).length,
            projectPath: options.projectPath,
          },
          () => writeCheckerCacheManifest(options, manifest),
          { always: true },
        );
      } catch {
        // Cache write failures must not change checker behavior.
      }
      return {
        prepareArtifacts: preparedProjectReuseSnapshots,
        result: analysis.result,
      };
    }

    return {
      result: analysis.result,
    };
  } finally {
    disposePreparedAnalysisProject(preparedProject);
  }
}

export function analyzeProjectWithPersistentCache(
  options: PersistentCheckerRunOptions,
): AnalyzeProjectResult {
  return analyzeProjectWithPersistentCacheForReuse(options).result;
}
