import { createHash } from 'node:crypto';

import ts from 'typescript';

import { collectSoundscriptRootNames, loadConfig, type RuntimeTarget } from '../project/config.ts';
import { emitProjectedDeclarations } from '../frontend/project_frontend.ts';
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
  collectPreparedAnalysisProjectFileMetadata,
  collectPreparedAnalysisProjectTrackedFilePaths,
  disposePreparedAnalysisProject,
  filterAnalyzedDiagnosticsForFile,
  matchesPreparedAnalysisAnyFilePath,
  prepareProjectAnalysis,
  type AnalyzePreparedProjectWithArtifactsResult,
  type PreparedAnalysisProject,
  type PreparedAnalysisProjectFileMetadata,
  type PreparedProjectAnalysisArtifacts,
} from './analyze_project.ts';
import { measureCheckerTiming } from './timing.ts';
import type { MergedDiagnostic } from './diagnostics.ts';
import type { FlowFileRuleCache } from './rules/flow.ts';

const CHECKER_CACHE_SCHEMA_VERSION = 3;
const CHECKER_CACHE_ROOT_DIRECTORY = '.soundscript-cache';
const CHECKER_CACHE_SUBDIRECTORY = 'checker';
const dependencySignaturePrinter = ts.createPrinter({
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
}

interface CheckerCacheFileEntry extends PreparedAnalysisProjectFileMetadata {
  flowCache?: FlowFileRuleCache;
  result: AnalyzeProjectResult;
}

interface CheckerCacheManifest {
  cachedAt: string;
  dependencySignatures: Readonly<Record<string, string>>;
  files: readonly CheckerCacheFileEntry[];
  header: CheckerCacheHeader;
  result: AnalyzeProjectResult;
  schemaVersion: number;
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

const UNDEFINED_JSON_SENTINEL_KEY = '__soundscriptUndefined';
const undefinedJsonSentinel = { [UNDEFINED_JSON_SENTINEL_KEY]: true } as const;

export interface PersistentCheckerRunOptions extends AnalyzeProjectOptions {
  cacheDir?: string;
  useCache?: boolean;
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
    .filter((fileName) => fileName.endsWith('.sts'))
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
  };
}

function checkerCacheHeadersEqual(
  left: CheckerCacheHeader,
  right: CheckerCacheHeader,
): boolean {
  return left.projectPath === right.projectPath &&
    left.targetOverride === right.targetOverride &&
    left.runtimeTarget === right.runtimeTarget &&
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

function createPreparedProjectDependencySignatures(
  preparedProject: PreparedAnalysisProject,
  fileMetadata: readonly PreparedAnalysisProjectFileMetadata[],
): Readonly<Record<string, string>> {
  const signatures: Record<string, string> = {};
  const addProjectedDeclarationSignatures = (
    view: PreparedAnalysisProject['stsView'] | PreparedAnalysisProject['packageSourcePolicyView'],
    viewKind: PreparedAnalysisProjectFileMetadata['view'],
  ): void => {
    if (!view) {
      return;
    }

    const rootNames = fileMetadata
      .filter((metadata) => metadata.view === viewKind && metadata.filePath.endsWith('.sts'))
      .map((metadata) => metadata.filePath);
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

  addProjectedDeclarationSignatures(preparedProject.stsView, 'sts');
  addProjectedDeclarationSignatures(preparedProject.packageSourcePolicyView, 'packageSource');

  return signatures;
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

function getDependencySignatureForFilePath(
  dependencySignatures: Readonly<Record<string, string>>,
  filePath: string,
): string | undefined {
  const directMatch = dependencySignatures[filePath];
  if (directMatch !== undefined) {
    return directMatch;
  }

  for (const [candidateFilePath, signature] of Object.entries(dependencySignatures)) {
    if (matchesPreparedAnalysisAnyFilePath(filePath, [candidateFilePath])) {
      return signature;
    }
  }

  return undefined;
}

function collectChangedDependencyFilePaths(
  changedTrackedFiles: readonly string[],
  previousDependencySignatures: Readonly<Record<string, string>>,
  nextDependencySignatures: Readonly<Record<string, string>>,
): readonly string[] {
  return changedTrackedFiles.filter((filePath) => {
    const previousSignature = getDependencySignatureForFilePath(previousDependencySignatures, filePath);
    const nextSignature = getDependencySignatureForFilePath(nextDependencySignatures, filePath);
    return previousSignature === undefined ||
      nextSignature === undefined ||
      previousSignature !== nextSignature;
  });
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
  flowCache: FlowFileRuleCache | undefined,
): PreparedProjectAnalysisArtifacts {
  return {
    flowByFile: flowCache ? new Map([[filePath, flowCache]]) : new Map(),
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
  trackedFiles: Readonly<Record<string, string>>,
  dependencySignatures: Readonly<Record<string, string>>,
  analysis: AnalyzePreparedProjectWithArtifactsResult,
): CheckerCacheManifest {
  const splitDiagnostics = splitDiagnosticsByFileOwnership(
    analysis.result.diagnostics,
    preparedProjectFileMetadata,
  );
  return {
    cachedAt: new Date().toISOString(),
    dependencySignatures,
    files: preparedProjectFileMetadata.map((metadata) => {
      const diagnostics = [...(splitDiagnostics.byFile.get(metadata.filePath) ?? [])];
      return {
        ...metadata,
        flowCache: analysis.artifacts.flowByFile.get(metadata.filePath),
        result: {
          diagnostics,
          summary: createSummary(diagnostics),
        },
      };
    }),
    header,
    result: analysis.result,
    schemaVersion: CHECKER_CACHE_SCHEMA_VERSION,
    trackedFiles,
    unownedDiagnostics: splitDiagnostics.unowned,
  };
}

function createIncrementalCheckerCacheManifest(
  header: CheckerCacheHeader,
  trackedFiles: Readonly<Record<string, string>>,
  dependencySignatures: Readonly<Record<string, string>>,
  files: readonly CheckerCacheFileEntry[],
  unownedDiagnostics: readonly MergedDiagnostic[],
): CheckerCacheManifest {
  return {
    cachedAt: new Date().toISOString(),
    dependencySignatures,
    files,
    header,
    result: combineCachedFileResults(files, unownedDiagnostics),
    schemaVersion: CHECKER_CACHE_SCHEMA_VERSION,
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
  preparedProjectDependencySignatures: Readonly<Record<string, string>>,
  analyzeFile: (filePath: string, flowCache: FlowFileRuleCache | undefined) => CheckerCacheFileEntry,
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
        flowCache: previousFile.flowCache,
        result: previousFile.result,
      });
      reusedFiles += 1;
      continue;
    }

    if (!previousFile.fileScopedAnalysis || !metadata.fileScopedAnalysis) {
      return null;
    }

    nextFiles.push(analyzeFile(metadata.filePath, previousFile.flowCache));
    refreshedFiles += 1;
  }

  return {
    manifest: createIncrementalCheckerCacheManifest(
      header,
      createTrackedFileHashes(preparedProjectTrackedFilePaths),
      preparedProjectDependencySignatures,
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

export function analyzeProjectWithPersistentCache(
  options: PersistentCheckerRunOptions,
): AnalyzeProjectResult {
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
    return cacheReadResult.result;
  }

  const preparedProject = prepareProjectAnalysis(options);
  try {
    const preparedProjectFileMetadata = collectPreparedAnalysisProjectFileMetadata(preparedProject);
    const preparedProjectTrackedFilePaths = collectPreparedAnalysisProjectTrackedFilePaths(
      preparedProject,
    );
    const preparedProjectDependencySignatures = createPreparedProjectDependencySignatures(
      preparedProject,
      preparedProjectFileMetadata,
    );

    if (useCache && header && cacheReadResult.kind === 'stale') {
      const changedDependencyFiles = collectChangedDependencyFilePaths(
        cacheReadResult.changedTrackedFiles,
        cacheReadResult.manifest.dependencySignatures,
        preparedProjectDependencySignatures,
      );
      const incrementalReuse = measureCheckerTiming(
        'project.cache.incremental',
        {
          cacheDir: cacheProjectDirectory,
          changedDependencyFiles: changedDependencyFiles.length,
          changedTrackedFiles: cacheReadResult.changedTrackedFiles.length,
          projectPath: options.projectPath,
        },
        () =>
          tryReusePartialCheckerCacheManifest(
            header,
            cacheReadResult.manifest,
            cacheReadResult.changedTrackedFiles,
            changedDependencyFiles,
            preparedProjectFileMetadata,
            preparedProjectTrackedFilePaths,
            preparedProjectDependencySignatures,
            (filePath, flowCache) => {
              const analysis = analyzePreparedProjectOwnedDiagnosticsForFileWithArtifacts(
                preparedProject,
                filePath,
                createPreparedProjectAnalysisArtifactsByFilePath(filePath, flowCache),
              );
              const ownedDiagnostics = filterAnalyzedDiagnosticsForFile(
                analysis.result.diagnostics,
                filePath,
              );
              const metadata = preparedProjectFileMetadata.find((entry) => entry.filePath === filePath)!;
              return {
                ...metadata,
                flowCache: analysis.artifacts.flowByFile.get(filePath),
                result: {
                  diagnostics: ownedDiagnostics,
                  summary: createSummary(ownedDiagnostics),
                },
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
        return incrementalReuse.manifest.result;
      }
    }

    const analysis = analyzePreparedProjectWithArtifacts(preparedProject);
    if (useCache && header) {
      const manifest = createCheckerCacheManifestFromFullAnalysis(
        header,
        preparedProjectFileMetadata,
        createTrackedFileHashes(preparedProjectTrackedFilePaths),
        preparedProjectDependencySignatures,
        analysis,
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
    }

    return analysis.result;
  } finally {
    disposePreparedAnalysisProject(preparedProject);
  }
}
