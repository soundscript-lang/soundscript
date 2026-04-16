import ts from 'typescript';
import { dirname, isAbsolute, join } from '../platform/path.ts';

import {
  createProjectCompilerHost,
  createSoundStdlibCompilerHost,
  resolveBundledTypesDirectory,
} from '../bundled/sound_stdlib.ts';
import {
  type BuiltinDiagnosticProgram,
  type BuiltinExpandedTsDiagnosticProgram,
  createBuiltinDiagnosticProgram,
} from '../frontend/builtin_macro_support.ts';
import {
  capturePersistentProjectMacroEnvironmentReuseSnapshot,
  hydratePersistentProjectMacroEnvironmentReuseSnapshot,
} from '../frontend/project_macro_support.ts';
import type {
  MacroModuleCacheStats,
  PersistentProjectMacroEnvironmentReuseSnapshot,
  ProjectMacroEnvironment,
} from '../frontend/project_macro_support.ts';
import {
  sourceTextLooksLikeMacroModule,
  usesLegacyDefineMacroAuthoring,
} from '../frontend/macro_factory_support.ts';
import {
  capturePersistentPreparedCompilerHostReuseSnapshot,
  clearPreparedCompilerHostReuseState,
  createPreparedProgram,
  emitProjectedDeclarations,
  getLineAndCharacterOfPosition,
  getPositionOfLineAndCharacter,
  hydratePersistentPreparedCompilerHostReuseSnapshot,
  isProjectedSoundscriptDeclarationFile,
  isSoundscriptSourceFile,
  mapProgramEnclosingRangeToSource,
  mapProgramPositionToSource,
  type PersistentPreparedCompilerHostReuseSnapshot,
  persistPreparedProgramBuildInfo,
  type PreparedCompilerHostReuseState,
  type PreparedProgram,
  type PreparedSourceFile,
  toProjectedDeclarationFileName,
  toProjectedDeclarationSourceFileName,
  toSourceFileName,
} from '../frontend/project_frontend.ts';
import { collectSoundscriptRootNames, loadConfig } from '../project/config.ts';
import {
  findNearestPackageJsonPath,
  getSoundScriptPackageInfoForResolvedModule,
  resolveSoundScriptAwareModule,
} from '../project/soundscript_packages.ts';
import {
  hasErrorDiagnostics,
  remapDiagnosticFilePaths,
  toMergedDiagnostic,
} from './diagnostics.ts';
import { SOUND_DIAGNOSTIC_CODES } from './engine/diagnostic_codes.ts';
import { createAnalysisContext } from './engine/context.ts';
import {
  type FileDiagnosticRuleCacheEntry,
  runSoundAnalysis,
  type SoundAnalysisArtifacts,
  type SoundAnalysisRuleCache,
} from './rules/index.ts';
import type { FlowFileRuleCache } from './rules/flow.ts';
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
  runUniversalPolicy: boolean;
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

export interface PreparedAnalysisProjectFileMetadata {
  cacheDependencyPaths: readonly string[];
  directDependencyPaths: readonly string[];
  diagnosticPaths: readonly string[];
  filePath: string;
  fileScopedAnalysis: boolean;
  view: 'packageSource' | 'sts' | 'ts';
}

export interface PreparedProjectAnalysisArtifacts {
  effectsByFile: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
  flowByFile: ReadonlyMap<string, FlowFileRuleCache>;
  relationsByFile: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
  valueTypesByFile: ReadonlyMap<string, FileDiagnosticRuleCacheEntry>;
}

export interface AnalyzePreparedProjectWithArtifactsResult {
  artifacts: PreparedProjectAnalysisArtifacts;
  result: AnalyzeProjectResult;
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
const fileScopedAnalysisEligibilityCache = new WeakMap<
  PreparedAnalysisView,
  Map<string, boolean>
>();
const IGNORED_GENERATED_TOP_LEVEL_IMPORT_SPECIFIERS = new Set(['sts:prelude']);
const BUNDLED_TYPES_DIRECTORY = ts.sys.resolvePath(resolveBundledTypesDirectory()).replaceAll(
  '\\',
  '/',
);
const soundRuleCacheKeyPrinter = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

interface PrepareProjectAnalysisOptions {
  deferTypescriptView?: boolean;
  persistentBuildInfoDirectory?: string;
  persistentReuseSnapshots?: PersistentPreparedAnalysisProjectReuseSnapshots;
}

type PreparePersistentBuildInfoKey = 'package-projection' | 'package-source-policy' | 'sts' | 'ts';

export interface PersistentPreparedAnalysisViewReuseSnapshot {
  compilerHost: PersistentPreparedCompilerHostReuseSnapshot;
  macroEnvironment: PersistentProjectMacroEnvironmentReuseSnapshot;
}

export interface PersistentPreparedAnalysisProjectReuseSnapshots {
  packageSourcePolicy?: PersistentPreparedAnalysisViewReuseSnapshot;
  sts?: PersistentPreparedAnalysisViewReuseSnapshot;
  ts?: PersistentPreparedAnalysisViewReuseSnapshot;
}

const EMPTY_MACRO_CACHE_STATS: MacroModuleCacheStats = {
  bindingPlanCacheHits: 0,
  bindingPlanCacheInvalidations: 0,
  bindingPlanCacheMisses: 0,
  expandedFileCacheHits: 0,
  expandedFileCacheInvalidations: 0,
  expandedFileCacheMisses: 0,
  evaluatedModules: 0,
  moduleCacheHits: 0,
  moduleCacheInvalidations: 0,
  moduleCacheMisses: 0,
};

const NOOP_PROJECT_MACRO_ENVIRONMENT: ProjectMacroEnvironment = {
  cacheStats(): MacroModuleCacheStats {
    return EMPTY_MACRO_CACHE_STATS;
  },
  definitionsForFile(): ReadonlyMap<string, never> {
    return new Map<string, never>();
  },
  dispose(): void {
  },
  expandPreparedProgram(): ReadonlyMap<string, ts.SourceFile> {
    return new Map();
  },
  registriesForFile(): {
    advancedRegistry: ReadonlyMap<string, never>;
    registry: ReadonlyMap<string, never>;
  } {
    return {
      advancedRegistry: new Map<string, never>(),
      registry: new Map<string, never>(),
    };
  },
  siteKindsBySpecifierForFile(): ReadonlyMap<string, ReadonlyMap<string, never>> {
    return new Map<string, ReadonlyMap<string, never>>();
  },
  trackedDependencyFiles(): readonly string[] {
    return [];
  },
};

function createDiagnosticPreparedFileMap(
  preparedProgram: PreparedProgram,
): ReadonlyMap<string, PreparedSourceFile> {
  void preparedProgram;
  return new Map<string, PreparedSourceFile>();
}

function createPreparePersistentBuildInfoPath(
  persistentBuildInfoDirectory: string | undefined,
  key: PreparePersistentBuildInfoKey | undefined,
  kind: 'declarations' | 'semantic',
): string | undefined {
  if (!persistentBuildInfoDirectory || !key) {
    return undefined;
  }

  return join(persistentBuildInfoDirectory, `${key}.${kind}.tsbuildinfo`);
}

function capturePersistentPreparedAnalysisViewReuseSnapshot(
  view: PreparedAnalysisView | null,
): PersistentPreparedAnalysisViewReuseSnapshot | undefined {
  if (!view) {
    return undefined;
  }

  const preparedReuseState = view.preparedProgram.preparedHost.reuseState;
  return {
    compilerHost: capturePersistentPreparedCompilerHostReuseSnapshot(preparedReuseState),
    macroEnvironment: capturePersistentProjectMacroEnvironmentReuseSnapshot(
      preparedReuseState,
    ),
  };
}

export function capturePersistentPreparedAnalysisProjectReuseSnapshots(
  preparedProject: PreparedAnalysisProject,
  options: { includeTypescriptView?: boolean } = {},
): PersistentPreparedAnalysisProjectReuseSnapshots {
  const snapshots: PersistentPreparedAnalysisProjectReuseSnapshots = {
    packageSourcePolicy: capturePersistentPreparedAnalysisViewReuseSnapshot(
      preparedProject.packageSourcePolicyView,
    ),
    sts: capturePersistentPreparedAnalysisViewReuseSnapshot(preparedProject.stsView),
  };
  if (options.includeTypescriptView !== false) {
    snapshots.ts = capturePersistentPreparedAnalysisViewReuseSnapshot(preparedProject.tsView);
  }
  return snapshots;
}

function hydratePersistentPreparedAnalysisViewReuseSnapshot(
  snapshot: PersistentPreparedAnalysisViewReuseSnapshot | undefined,
  currentDirectory: string,
): PreparedCompilerHostReuseState | undefined {
  if (!snapshot) {
    return undefined;
  }

  const reuseState = hydratePersistentPreparedCompilerHostReuseSnapshot(
    snapshot.compilerHost,
    currentDirectory,
  );
  hydratePersistentProjectMacroEnvironmentReuseSnapshot(
    reuseState,
    snapshot.macroEnvironment,
  );
  return reuseState;
}

interface AnalyzeProjectOptionsSnapshot {
  additionalRootNames: readonly string[];
  fileOverrides: ReadonlyMap<string, string>;
  projectPath: string;
  target: AnalyzeProjectOptions['target'];
  workingDirectory: string;
}

interface CachedFileAnalysisResult {
  artifacts: PreparedProjectAnalysisArtifacts;
  cacheDependencyPaths: readonly string[];
  result: AnalyzeProjectResult;
  supportsSelectiveReuse: boolean;
}

function cloneFileOverrides(
  fileOverrides: ReadonlyMap<string, string> | undefined,
): ReadonlyMap<string, string> {
  return new Map(fileOverrides ?? []);
}

function snapshotAnalyzeProjectOptions(
  options: AnalyzeProjectOptions,
): AnalyzeProjectOptionsSnapshot {
  return {
    additionalRootNames: [...(options.additionalRootNames ?? [])],
    fileOverrides: cloneFileOverrides(options.fileOverrides),
    projectPath: options.projectPath,
    target: options.target,
    workingDirectory: options.workingDirectory,
  };
}

function fileOverridesEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [filePath, text] of left.entries()) {
    if (right.get(filePath) !== text) {
      return false;
    }
  }

  return true;
}

function analyzeProjectOptionsEqual(
  left: AnalyzeProjectOptionsSnapshot,
  right: AnalyzeProjectOptions,
): boolean {
  return left.projectPath === right.projectPath &&
    left.workingDirectory === right.workingDirectory &&
    left.target === right.target &&
    rootNamesEqual(left.additionalRootNames, right.additionalRootNames ?? []) &&
    fileOverridesEqual(left.fileOverrides, cloneFileOverrides(right.fileOverrides));
}

function prepareProjectAnalysisOptionsEqual(
  left: PrepareProjectAnalysisOptions,
  right: PrepareProjectAnalysisOptions,
): boolean {
  return (left.deferTypescriptView ?? false) === (right.deferTypescriptView ?? false);
}

function collectChangedFileOverridePaths(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): readonly string[] {
  const changedPaths = new Set<string>();
  for (const filePath of new Set([...left.keys(), ...right.keys()])) {
    if (left.get(filePath) !== right.get(filePath)) {
      changedPaths.add(filePath);
    }
  }

  return [...changedPaths];
}

function canRetainCachedFileAnalysisResult(
  filePath: string,
  cachedResult: CachedFileAnalysisResult,
  changedOverridePaths: readonly string[],
  previousOptions: AnalyzeProjectOptionsSnapshot,
  nextOptions: AnalyzeProjectOptionsSnapshot,
  previousPrepareOptions: PrepareProjectAnalysisOptions,
  nextPrepareOptions: PrepareProjectAnalysisOptions,
  previousPreparedProject: PreparedAnalysisProject,
  nextPreparedProject: PreparedAnalysisProject,
): boolean {
  if (!cachedResult.supportsSelectiveReuse) {
    return false;
  }

  if (
    !prepareProjectAnalysisOptionsEqual(previousPrepareOptions, nextPrepareOptions) ||
    previousOptions.projectPath !== nextOptions.projectPath ||
    previousOptions.workingDirectory !== nextOptions.workingDirectory ||
    previousOptions.target !== nextOptions.target ||
    !rootNamesEqual(previousOptions.additionalRootNames, nextOptions.additionalRootNames) ||
    previousPreparedProject.configReuseSignature !== nextPreparedProject.configReuseSignature ||
    previousPreparedProject.soundscriptRootDiscoverySignature !==
      nextPreparedProject.soundscriptRootDiscoverySignature
  ) {
    return false;
  }

  if (changedOverridePaths.length === 0) {
    return false;
  }

  if (
    changedOverridePaths.some((changedFilePath) =>
      !isPreparedAnalysisProjectSourceFile(nextPreparedProject, changedFilePath)
    )
  ) {
    return false;
  }

  return !changedOverridePaths.some((changedFilePath) =>
    matchesPreparedAnalysisAnyFilePath(changedFilePath, cachedResult.cacheDependencyPaths)
  );
}

function isPreparedAnalysisProjectSourceFile(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
): boolean {
  const preparedView = getPreparedAnalysisViewForFile(preparedProject, filePath);
  return preparedView !== null && getPreparedViewSourceFileMatch(preparedView, filePath) !== null;
}

export class IncrementalProjectSession {
  #analyzedProject: AnalyzeProjectResult | null = null;
  #analyzedResultsByFile = new Map<string, CachedFileAnalysisResult>();
  #optionsSnapshot: AnalyzeProjectOptionsSnapshot | null = null;
  #prepareOptions: PrepareProjectAnalysisOptions = {};
  #preparedProject: PreparedAnalysisProject | null = null;

  get preparedProject(): PreparedAnalysisProject | null {
    return this.#preparedProject;
  }

  hasAnalyzedFile(filePath: string): boolean {
    return this.#analyzedResultsByFile.has(filePath);
  }

  hasAnalyzedProject(): boolean {
    return this.#analyzedProject !== null;
  }

  analyzeFile(filePath: string): AnalyzeProjectResult {
    const cached = this.#analyzedResultsByFile.get(filePath);
    if (cached) {
      return cached.result;
    }

    const preparedProject = this.#requirePreparedProject();
    const analysis = analyzePreparedProjectForFileWithArtifacts(preparedProject, filePath);
    this.#analyzedResultsByFile.set(filePath, {
      artifacts: analysis.artifacts,
      cacheDependencyPaths: collectPreparedProjectCacheDependencyPathsForFile(
        preparedProject,
        filePath,
      ),
      result: analysis.result,
      supportsSelectiveReuse: true,
    });
    return analysis.result;
  }

  analyzeProject(): AnalyzeProjectResult {
    this.#analyzedProject ??= analyzePreparedProject(this.#requirePreparedProject());
    return this.#analyzedProject;
  }

  dispose(): void {
    disposePreparedAnalysisProject(this.#preparedProject);
    this.#analyzedProject = null;
    this.#analyzedResultsByFile.clear();
    this.#optionsSnapshot = null;
    this.#prepareOptions = {};
    this.#preparedProject = null;
  }

  prepare(
    options: AnalyzeProjectOptions,
    prepareOptions: PrepareProjectAnalysisOptions = {},
    reusableProject?: PreparedAnalysisProject,
  ): PreparedAnalysisProject {
    if (
      this.#preparedProject &&
      this.#optionsSnapshot &&
      analyzeProjectOptionsEqual(this.#optionsSnapshot, options) &&
      prepareProjectAnalysisOptionsEqual(this.#prepareOptions, prepareOptions)
    ) {
      return this.#preparedProject;
    }

    const previousPreparedProject = this.#preparedProject;
    const previousOptionsSnapshot = this.#optionsSnapshot;
    const previousPrepareOptions = this.#prepareOptions;
    const preparedProject = prepareProjectAnalysis(
      options,
      previousPreparedProject ?? reusableProject,
      prepareOptions,
    );
    const nextOptionsSnapshot = snapshotAnalyzeProjectOptions(options);

    this.#preparedProject = preparedProject;
    this.#optionsSnapshot = nextOptionsSnapshot;
    this.#prepareOptions = { ...prepareOptions };
    this.#invalidateAnalysisCaches(
      previousPreparedProject,
      previousOptionsSnapshot,
      previousPrepareOptions,
      nextOptionsSnapshot,
      prepareOptions,
    );
    disposePreparedAnalysisProject(previousPreparedProject, preparedProject);
    return preparedProject;
  }

  #invalidateAnalysisCaches(
    previousPreparedProject: PreparedAnalysisProject | null,
    previousOptionsSnapshot: AnalyzeProjectOptionsSnapshot | null,
    previousPrepareOptions: PrepareProjectAnalysisOptions,
    nextOptionsSnapshot: AnalyzeProjectOptionsSnapshot,
    nextPrepareOptions: PrepareProjectAnalysisOptions,
  ): void {
    this.#analyzedProject = null;

    if (!previousPreparedProject || !previousOptionsSnapshot || !this.#preparedProject) {
      this.#analyzedResultsByFile.clear();
      return;
    }

    const changedOverridePaths = collectChangedFileOverridePaths(
      previousOptionsSnapshot.fileOverrides,
      nextOptionsSnapshot.fileOverrides,
    );
    if (changedOverridePaths.length === 0) {
      this.#analyzedResultsByFile.clear();
      return;
    }

    const retainedResultsByFile = new Map<string, CachedFileAnalysisResult>();
    for (const [filePath, cachedResult] of this.#analyzedResultsByFile.entries()) {
      if (
        canRetainCachedFileAnalysisResult(
          filePath,
          cachedResult,
          changedOverridePaths,
          previousOptionsSnapshot,
          nextOptionsSnapshot,
          previousPrepareOptions,
          nextPrepareOptions,
          previousPreparedProject,
          this.#preparedProject,
        )
      ) {
        retainedResultsByFile.set(filePath, cachedResult);
      }
    }

    this.#analyzedResultsByFile = retainedResultsByFile;
  }

  #requirePreparedProject(): PreparedAnalysisProject {
    if (!this.#preparedProject) {
      throw new Error('IncrementalProjectSession.prepare() must be called before analysis.');
    }

    return this.#preparedProject;
  }
}

export function collectPreparedAnalysisProjectTrackedFilePaths(
  preparedProject: PreparedAnalysisProject,
): readonly string[] {
  const trackedPaths = new Set<string>();
  const addTrackedPath = (candidateFilePath: string | undefined): void => {
    if (!candidateFilePath) {
      return;
    }

    const normalizedFilePath = ts.sys.resolvePath(toSourceFileName(candidateFilePath));
    if (!ts.sys.fileExists(normalizedFilePath)) {
      return;
    }
    if (trackedPaths.has(normalizedFilePath)) {
      return;
    }

    trackedPaths.add(normalizedFilePath);
    addTrackedPath(findNearestPackageJsonPath(normalizedFilePath, ts.sys));
  };
  const addViewTrackedPaths = (view: PreparedAnalysisView | null): void => {
    if (!view) {
      return;
    }

    for (const sourceFile of view.program.getSourceFiles()) {
      if (view.program.isSourceFileDefaultLibrary(sourceFile)) {
        continue;
      }

      addTrackedPath(view.preparedProgram.toSourceFileName(sourceFile.fileName));
    }
    for (const macroDependencyFile of view.macroEnvironment.trackedDependencyFiles()) {
      addTrackedPath(macroDependencyFile);
    }
  };

  addTrackedPath(preparedProject.analyzeOptions.projectPath);
  addViewTrackedPaths(preparedProject.tsView);
  addViewTrackedPaths(preparedProject.stsView);
  addViewTrackedPaths(preparedProject.packageSourcePolicyView);

  return [...trackedPaths].sort();
}

export function collectPreparedAnalysisProjectFileMetadata(
  preparedProject: PreparedAnalysisProject,
  previousMetadataByFilePath: ReadonlyMap<string, PreparedAnalysisProjectFileMetadata> = new Map(),
  changedTrackedFiles: readonly string[] = [],
  previousCandidateFilePaths: readonly string[] = [],
  options: { includeTypescriptView?: boolean } = {},
): readonly PreparedAnalysisProjectFileMetadata[] {
  const dependencyTraversalCaches = new WeakMap<
    PreparedAnalysisView,
    PreparedViewDependencyTraversalCache
  >();
  const candidateCollectionStartTime = performance.now();
  const candidateFilePaths = previousCandidateFilePaths.length > 0
    ? new Set(previousCandidateFilePaths)
    : new Set<string>();
  const projectPackageJsonPath = findNearestPackageJsonPath(
    preparedProject.analyzeOptions.projectPath,
    ts.sys,
  );
  const addCandidateFiles = (
    view: PreparedAnalysisView | null,
    includeSourceFile: (sourceFile: ts.SourceFile) => boolean,
  ): void => {
    if (!view) {
      return;
    }

    for (const sourceFile of view.program.getSourceFiles()) {
      if (view.program.isSourceFileDefaultLibrary(sourceFile) || !includeSourceFile(sourceFile)) {
        continue;
      }
      candidateFilePaths.add(view.preparedProgram.toSourceFileName(sourceFile.fileName));
    }
  };

  const includeTypescriptView = options.includeTypescriptView ?? true;
  if (previousCandidateFilePaths.length === 0) {
    if (includeTypescriptView) {
      addCandidateFiles(
        preparedProject.tsView,
        (sourceFile) =>
          shouldAnalyzeTypescriptViewSourceFile(
            sourceFile,
            preparedProject.isSoundscriptSourceFile,
          ),
      );
    }
    addCandidateFiles(
      preparedProject.stsView,
      (sourceFile) =>
        shouldAnalyzeProjectSoundscriptSourceFile(
          sourceFile,
          preparedProject.stsView!.analysisPreparedProgram,
          projectPackageJsonPath,
        ),
    );
    addCandidateFiles(
      preparedProject.packageSourcePolicyView,
      (sourceFile) =>
        shouldAnalyzeSoundscriptSourceFile(
          sourceFile,
          preparedProject.packageSourcePolicyView!.analysisPreparedProgram,
        ) &&
        isSupplementalPackageSourceCandidate(
          toSourceFileName(sourceFile.fileName),
          projectPackageJsonPath,
        ),
    );
  }
  const candidateCollectionDurationMs = performance.now() - candidateCollectionStartTime;
  let diagnosticPathCollectionDurationMs = 0;
  let cacheDependencyPathCollectionDurationMs = 0;
  let fileScopedEligibilityDurationMs = 0;
  let viewLookupDurationMs = 0;

  const fileMetadata: PreparedAnalysisProjectFileMetadata[] = [...candidateFilePaths].sort()
    .flatMap((filePath) => {
      const viewLookupStartTime = performance.now();
      const view = getPreparedAnalysisViewForFile(preparedProject, filePath);
      viewLookupDurationMs += performance.now() - viewLookupStartTime;
      if (!view) {
        return [];
      }
      const viewKind: PreparedAnalysisProjectFileMetadata['view'] = view === preparedProject.tsView
        ? 'ts'
        : view === preparedProject.packageSourcePolicyView
        ? 'packageSource'
        : 'sts';
      const previousMetadata = previousMetadataByFilePath.get(filePath);
      const fileChanged = changedTrackedFiles.some((changedFilePath) =>
        matchesPreparedAnalysisAnyFilePath(changedFilePath, [filePath])
      );
      if (previousMetadata && previousMetadata.view === viewKind && !fileChanged) {
        return [previousMetadata];
      }

      const directDependencyPaths = collectPreparedViewDirectDependencyPaths(view, filePath);
      const fileScopedEligibilityStartTime = performance.now();
      const fileScopedAnalysis = supportsFileScopedAnalysisContext(view, filePath);
      fileScopedEligibilityDurationMs += performance.now() - fileScopedEligibilityStartTime;
      if (
        previousMetadata &&
        canReusePreparedAnalysisProjectFileMetadata(
          viewKind,
          previousMetadata,
          directDependencyPaths,
          fileScopedAnalysis,
        )
      ) {
        return [previousMetadata];
      }

      const diagnosticPathStartTime = performance.now();
      const diagnosticPathCollection = collectPreparedViewDependencyPathCollection(
        view,
        filePath,
        {},
        getPreparedViewDependencyTraversalCache(dependencyTraversalCaches, view),
      );
      diagnosticPathCollectionDurationMs += performance.now() - diagnosticPathStartTime;
      const diagnosticPaths = diagnosticPathCollection.paths;
      let cacheDependencyPaths = diagnosticPaths;
      if (diagnosticPathCollection.encounteredNonDeclarationTypeScriptDependency) {
        const cacheDependencyPathStartTime = performance.now();
        cacheDependencyPaths = collectPreparedViewDependencyPaths(
          view,
          filePath,
          {
            includeNonDeclarationTypeScriptDependencies: true,
          },
          getPreparedViewDependencyTraversalCache(dependencyTraversalCaches, view),
        );
        cacheDependencyPathCollectionDurationMs += performance.now() - cacheDependencyPathStartTime;
      }

      return [{
        cacheDependencyPaths,
        directDependencyPaths,
        diagnosticPaths,
        filePath,
        fileScopedAnalysis,
        view: viewKind,
      }];
    });

  measureCheckerTiming(
    'project.cache.fileMetadata.breakdown',
    {
      cacheDependencyPathCollectionMs: Number(cacheDependencyPathCollectionDurationMs.toFixed(1)),
      candidateCollectionMs: Number(candidateCollectionDurationMs.toFixed(1)),
      diagnosticPathCollectionMs: Number(diagnosticPathCollectionDurationMs.toFixed(1)),
      fileCount: fileMetadata.length,
      fileScopedEligibilityMs: Number(fileScopedEligibilityDurationMs.toFixed(1)),
      projectPath: preparedProject.analyzeOptions.projectPath,
      viewLookupMs: Number(viewLookupDurationMs.toFixed(1)),
    },
    () => undefined,
    { always: true },
  );

  return fileMetadata;
}

function canReusePreparedAnalysisProjectFileMetadata(
  viewKind: PreparedAnalysisProjectFileMetadata['view'],
  previousMetadata: PreparedAnalysisProjectFileMetadata,
  directDependencyPaths: readonly string[],
  fileScopedAnalysis: boolean,
): boolean {
  if (previousMetadata.view !== viewKind) {
    return false;
  }

  return previousMetadata.fileScopedAnalysis === fileScopedAnalysis &&
    stringArraysEqual(previousMetadata.directDependencyPaths, directDependencyPaths);
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

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
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
    stableConfigSignature(loadedConfig.frontierCommandLine.options),
    stableConfigSignature(loadedConfig.frontierCommandLine.projectReferences ?? []),
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

  return [
    ...new Set([
      ...collectReachableSoundscriptDependencyFiles(
        rootNames,
        compilerOptions,
        fileOverrides,
        isSoundscriptFile,
      ),
      ...declarationRootNames,
    ]),
  ]
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
  commandLine: ts.ParsedCommandLine,
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
  persistentBuildInfoKey?: PreparePersistentBuildInfoKey,
  persistentBuildInfoDirectory?: string,
): PreparedAnalysisView | null {
  if (rootNames.length === 0) {
    return null;
  }

  const expandedProgram = createBuiltinDiagnosticProgram({
    allowSupplementalDiagnosticPrograms: true,
    baseHost,
    configFileParsingDiagnostics,
    configuredSoundscriptFileNames: loadedConfig.soundscriptConfiguredFileNames,
    fileOverrides: options.fileOverrides ?? new Map(),
    oldProgram,
    options: commandLine.options,
    persistentProjectedDeclarationBuildInfoPath: createPreparePersistentBuildInfoPath(
      persistentBuildInfoDirectory,
      persistentBuildInfoKey,
      'declarations',
    ),
    persistentSemanticDiagnosticsBuildInfoPath: createPreparePersistentBuildInfoPath(
      persistentBuildInfoDirectory,
      persistentBuildInfoKey,
      'semantic',
    ),
    projectReferences: commandLine.projectReferences,
    projectedDeclarationOverrides,
    runtime: loadedConfig.runtime,
    reusableCompilerHostState,
    rootNames,
  });
  persistPreparedProgramBuildInfo(expandedProgram.analysisPreparedProgram);
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
    runUniversalPolicy: true,
    tsDiagnosticPrograms: expandedProgram.tsDiagnosticPrograms,
    universalPolicyScope,
  };
}

function prepareHostAnalysisView(
  options: AnalyzeProjectOptions,
  loadedConfig: ReturnType<typeof loadConfig>,
  rootNames: readonly string[],
  configFileParsingDiagnostics: readonly ts.Diagnostic[],
  projectedDeclarationOverrides: ReadonlyMap<string, string> | undefined,
  reusableCompilerHostState?: PreparedCompilerHostReuseState,
  oldProgram?: ts.Program,
  persistentBuildInfoDirectory?: string,
): PreparedAnalysisView | null {
  if (rootNames.length === 0) {
    return null;
  }

  const preparedProgram = createPreparedProgram({
    allowSoundscriptProgramFileResolution: false,
    baseHost: createProjectCompilerHost(
      loadedConfig.commandLine.options,
      dirname(options.projectPath),
    ),
    configFileParsingDiagnostics,
    configuredSoundscriptFileNames: loadedConfig.soundscriptConfiguredFileNames,
    expansionEnabled: false,
    fileOverrides: options.fileOverrides ?? new Map(),
    oldProgram,
    options: loadedConfig.commandLine.options,
    persistentSemanticDiagnosticsBuildInfoPath: createPreparePersistentBuildInfoPath(
      persistentBuildInfoDirectory,
      'ts',
      'semantic',
    ),
    projectReferences: loadedConfig.commandLine.projectReferences,
    projectedDeclarationOverrides,
    runtime: loadedConfig.runtime,
    reusableCompilerHostState,
    rootNames,
  });
  persistPreparedProgramBuildInfo(preparedProgram);
  const program = preparedProgram.program;
  const analysisContext = createAnalysisContext({
    includeSourceFile: (sourceFile) =>
      shouldAnalyzeTypescriptViewSourceFile(sourceFile, loadedConfig.isSoundscriptSourceFile),
    isSoundscriptSourceFile: preparedProgram.isSoundscriptSourceFile,
    isGeneratedNode: () => false,
    program,
    runtime: loadedConfig.runtime,
    workingDirectory: options.workingDirectory,
  });

  return {
    analysisContext,
    analysisPreparedProgram: preparedProgram,
    diagnosticPreparedFiles: createDiagnosticPreparedFileMap(preparedProgram),
    frontendDiagnostics: remapDiagnostics(preparedProgram.frontendDiagnostics()),
    macroEnvironment: NOOP_PROJECT_MACRO_ENVIRONMENT,
    macroCacheStats: EMPTY_MACRO_CACHE_STATS,
    preparedProgram,
    program,
    runSound: false,
    runUniversalPolicy: false,
    tsDiagnosticPrograms: [{ program }],
    universalPolicyScope: 'full',
  };
}

export function createPreparedAnalysisProjectFromBuiltinExpandedProgram(
  options: AnalyzeProjectOptions,
  loadedConfig: ReturnType<typeof loadConfig>,
  expandedProgram: BuiltinDiagnosticProgram,
): PreparedAnalysisProject {
  const program = expandedProgram.program;
  const analysisPreparedProgram = expandedProgram.analysisPreparedProgram;
  const preparedProgram = expandedProgram.preparedProgram;
  const isGeneratedNode = createPreparedProgramGeneratedNodeDetector(analysisPreparedProgram);
  const remappedFrontendDiagnostics = remapDiagnostics(expandedProgram.frontendDiagnostics());
  const macroEnvironment = expandedProgram.macroEnvironment;
  const macroCacheStats = macroEnvironment.cacheStats();
  const projectPackageJsonPath = findNearestPackageJsonPath(options.projectPath, ts.sys);
  const soundscriptRootNames = collectSoundscriptRootNames(options.projectPath, loadedConfig);
  const sourceFileHasTopLevelMacroReplacements = (sourceFile: ts.SourceFile): boolean => {
    const sourceFileName = analysisPreparedProgram.toSourceFileName(sourceFile.fileName);
    const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
    return hasTopLevelMacroReplacements(sourceFileName, preparedSource);
  };
  const createView = (
    includeSourceFile:
      | ((sourceFile: ts.SourceFile, preparedProgram: PreparedProgram) => boolean)
      | undefined,
    runSound: boolean,
    runUniversalPolicy: boolean,
    universalPolicyScope: 'full' | 'sourceSupplemental',
  ): PreparedAnalysisView => {
    const analysisContext = createAnalysisContext({
      includeSourceFile: includeSourceFile
        ? (sourceFile) =>
          !sourceFileHasTopLevelMacroReplacements(sourceFile) &&
          !hasGeneratedTopLevelStatements(sourceFile, isGeneratedNode) &&
          includeSourceFile(sourceFile, analysisPreparedProgram)
        : (sourceFile) =>
          !sourceFileHasTopLevelMacroReplacements(sourceFile) &&
          !hasGeneratedTopLevelStatements(sourceFile, isGeneratedNode),
      isSoundscriptSourceFile: analysisPreparedProgram.isSoundscriptSourceFile,
      isGeneratedNode,
      program,
      runtime: loadedConfig.runtime,
      workingDirectory: options.workingDirectory,
    });

    return {
      analysisContext,
      analysisPreparedProgram,
      diagnosticPreparedFiles: expandedProgram.diagnosticPreparedFiles,
      frontendDiagnostics: remappedFrontendDiagnostics,
      macroEnvironment,
      macroCacheStats,
      preparedProgram,
      program,
      runSound,
      runUniversalPolicy,
      tsDiagnosticPrograms: expandedProgram.tsDiagnosticPrograms,
      universalPolicyScope,
    };
  };

  const hasTypescriptCandidates = program.getSourceFiles().some((sourceFile) =>
    shouldAnalyzeTypescriptViewSourceFile(sourceFile, loadedConfig.isSoundscriptSourceFile)
  );
  const hasProjectSoundscriptCandidates = program.getSourceFiles().some((sourceFile) =>
    shouldAnalyzeProjectSoundscriptSourceFile(
      sourceFile,
      analysisPreparedProgram,
      projectPackageJsonPath,
    )
  );
  const hasSupplementalPackageSourceCandidates = program.getSourceFiles().some((sourceFile) => {
    const sourceFileName = toSourceFileName(sourceFile.fileName);
    return shouldAnalyzeSoundscriptSourceFile(sourceFile, analysisPreparedProgram) &&
      isSupplementalPackageSourceCandidate(sourceFileName, projectPackageJsonPath);
  });

  return {
    analyzeOptions: { ...options },
    configReuseSignature: '',
    configuredSoundscriptRootNames: soundscriptRootNames,
    isSoundscriptSourceFile: loadedConfig.isSoundscriptSourceFile,
    localProjectedDeclarationOverrides: undefined,
    packageSourcePolicyContentSignature: '',
    packageSourcePolicyCompilerHostReuseState: analysisPreparedProgram.preparedHost.reuseState,
    packageSourcePolicyView: hasSupplementalPackageSourceCandidates
      ? createView(
        (sourceFile, viewPreparedProgram) =>
          shouldAnalyzeSoundscriptSourceFile(sourceFile, viewPreparedProgram) &&
          isSupplementalPackageSourceCandidate(
            toSourceFileName(sourceFile.fileName),
            projectPackageJsonPath,
          ),
        true,
        true,
        'sourceSupplemental',
      )
      : null,
    soundscriptRootContentSignature: '',
    soundscriptConfiguredFileNames: loadedConfig.soundscriptConfiguredFileNames,
    soundscriptRootDiscoverySignature: '',
    stsCompilerHostReuseState: analysisPreparedProgram.preparedHost.reuseState,
    soundscriptFileOverridesSignature: '',
    stsProgramRootNames: soundscriptRootNames,
    soundscriptRootNames,
    stsView: hasProjectSoundscriptCandidates
      ? createView(
        (sourceFile, viewPreparedProgram) =>
          shouldAnalyzeProjectSoundscriptSourceFile(
            sourceFile,
            viewPreparedProgram,
            projectPackageJsonPath,
          ),
        true,
        true,
        'full',
      )
      : null,
    tsCompilerHostReuseState: analysisPreparedProgram.preparedHost.reuseState,
    tsView: hasTypescriptCandidates
      ? createView(
        (sourceFile) =>
          shouldAnalyzeTypescriptViewSourceFile(sourceFile, loadedConfig.isSoundscriptSourceFile),
        false,
        false,
        'full',
      )
      : null,
  };
}

interface AnalyzePreparedViewOptions {
  captureArtifacts?: PreparedProjectAnalysisArtifacts;
  reuseRuleCache?: SoundAnalysisRuleCache;
  ruleCacheKeysByFile?: ReadonlyMap<string, string>;
}

function analyzePreparedView(
  preparedView: PreparedAnalysisView | null,
  options: AnalyzePreparedViewOptions = {},
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
    undefined,
    {
      captureArtifacts: options.captureArtifacts,
      reuseRuleCache: options.reuseRuleCache,
      ruleCacheKeysByFile: options.ruleCacheKeysByFile,
    },
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
  options: AnalyzePreparedViewOptions = {},
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
        {
          captureArtifacts: options.captureArtifacts,
          reuseRuleCache: options.reuseRuleCache,
          ruleCacheKeysByFile: new Map([[
            filePath,
            createPreparedViewSoundRuleCacheKey(
              preparedView,
              filePath,
            ),
          ]]),
        },
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
  options: AnalyzePreparedViewOptions = {},
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
  const soundDiagnostics = hasFrontendErrors ? [] : collectPreparedViewSoundDiagnostics(
    preparedView,
    preparedView.analysisContext,
    undefined,
    {
      captureArtifacts: options.captureArtifacts,
      reuseRuleCache: options.reuseRuleCache,
      ruleCacheKeysByFile: options.ruleCacheKeysByFile,
    },
  ).filter((diagnostic) =>
    matchesPreparedAnalysisAnyFilePath(diagnostic.filePath, diagnosticPaths)
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

export function matchesPreparedAnalysisAnyFilePath(
  candidateFilePath: string | undefined,
  expectedFilePaths: readonly string[],
): boolean {
  return expectedFilePaths.some((expectedFilePath) =>
    matchesPreparedAnalysisFilePath(candidateFilePath, expectedFilePath)
  );
}

interface CollectPreparedViewDependencyPathOptions {
  includeNonDeclarationTypeScriptDependencies?: boolean;
}

interface PreparedViewDependencyPathCollection {
  encounteredNonDeclarationTypeScriptDependency: boolean;
  paths: readonly string[];
}

interface PreparedViewResolvedDependency {
  dependencySourceFile: ts.SourceFile | null;
  isNonDeclarationTypeScriptDependency: boolean;
  resolvedSourcePath: string;
}

interface PreparedViewDependencyTraversalProgramCache {
  dependencyPathCollectionsBySourcePath: Map<string, PreparedViewDependencyPathCollection>;
  dependencyPathCollectionsWithTypeScriptBySourcePath: Map<
    string,
    PreparedViewDependencyPathCollection
  >;
  resolvedDependenciesBySourcePath: Map<string, readonly PreparedViewResolvedDependency[]>;
  traversalSourceFileByPath: Map<string, ts.SourceFile | null>;
}

interface PreparedViewDependencyTraversalCache {
  programCaches: Map<string, PreparedViewDependencyTraversalProgramCache>;
}

function createPreparedViewDependencyTraversalCache(): PreparedViewDependencyTraversalCache {
  return {
    programCaches: new Map(),
  };
}

function getPreparedViewDependencyTraversalCache(
  caches: WeakMap<PreparedAnalysisView, PreparedViewDependencyTraversalCache>,
  preparedView: PreparedAnalysisView,
): PreparedViewDependencyTraversalCache {
  let cache = caches.get(preparedView);
  if (!cache) {
    cache = createPreparedViewDependencyTraversalCache();
    caches.set(preparedView, cache);
  }
  return cache;
}

function getPreparedViewDependencyTraversalProgramCache(
  cache: PreparedViewDependencyTraversalCache,
  programKey: string,
): PreparedViewDependencyTraversalProgramCache {
  let programCache = cache.programCaches.get(programKey);
  if (!programCache) {
    programCache = {
      dependencyPathCollectionsBySourcePath: new Map(),
      dependencyPathCollectionsWithTypeScriptBySourcePath: new Map(),
      resolvedDependenciesBySourcePath: new Map(),
      traversalSourceFileByPath: new Map(),
    };
    cache.programCaches.set(programKey, programCache);
  }
  return programCache;
}

function collectPreparedViewDirectDependencyPaths(
  preparedView: PreparedAnalysisView,
  filePath: string,
): readonly string[] {
  const directDependencyPaths = new Set<string>();
  const addDirectDependencyPath = (candidateFilePath: string): void => {
    for (const variant of collectPreparedAnalysisFilePathCandidates(candidateFilePath)) {
      directDependencyPaths.add(variant);
    }
    if (isSoundscriptSourceFile(candidateFilePath)) {
      for (
        const variant of collectPreparedAnalysisFilePathCandidates(
          toProjectedDeclarationFileName(candidateFilePath),
        )
      ) {
        directDependencyPaths.add(variant);
      }
    }
  };

  const rootSourceFiles: ts.SourceFile[] = [];
  const addRootSourceFile = (sourceFile: ts.SourceFile | null): void => {
    if (!sourceFile || rootSourceFiles.some((root) => root.fileName === sourceFile.fileName)) {
      return;
    }
    rootSourceFiles.push(sourceFile);
  };

  const sourceFileMatch = getPreparedViewSourceFileMatch(preparedView, filePath);
  addRootSourceFile(sourceFileMatch?.sourceFile ?? null);

  const tsDiagnosticProgramMatch = getPreparedViewTsDiagnosticProgramMatch(preparedView, filePath);
  addRootSourceFile(tsDiagnosticProgramMatch?.sourceFile ?? null);

  for (const sourceFile of rootSourceFiles) {
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

      const resolvedSourcePath = preparedView.preparedProgram.toSourceFileName(
        resolvedModule.resolvedFileName,
      );
      const dependencySourceFile = preparedView.program.getSourceFile(
        preparedView.preparedProgram.toProgramFileName(resolvedSourcePath),
      );
      const isNonDeclarationTypeScriptDependency = dependencySourceFile !== undefined &&
        !dependencySourceFile.isDeclarationFile &&
        !isSoundscriptSourceFile(resolvedSourcePath) &&
        !isProjectedSoundscriptDeclarationFile(resolvedSourcePath);
      if (
        isSoundscriptSourceFile(resolvedSourcePath) ||
        isProjectedSoundscriptDeclarationFile(resolvedSourcePath) ||
        isNonDeclarationTypeScriptDependency
      ) {
        addDirectDependencyPath(resolvedSourcePath);
      }
    }
  }

  return [...directDependencyPaths].sort();
}

function collectPreparedViewDependencyPaths(
  preparedView: PreparedAnalysisView,
  filePath: string,
  options: CollectPreparedViewDependencyPathOptions = {},
  traversalCache: PreparedViewDependencyTraversalCache =
    createPreparedViewDependencyTraversalCache(),
): readonly string[] {
  return collectPreparedViewDependencyPathCollection(
    preparedView,
    filePath,
    options,
    traversalCache,
  ).paths;
}

function collectPreparedViewDependencyPathCollection(
  preparedView: PreparedAnalysisView,
  filePath: string,
  options: CollectPreparedViewDependencyPathOptions = {},
  traversalCache: PreparedViewDependencyTraversalCache =
    createPreparedViewDependencyTraversalCache(),
): PreparedViewDependencyPathCollection {
  const addDiagnosticPath = (candidateFilePath: string): void => {
    for (const variant of collectPreparedAnalysisFilePathCandidates(candidateFilePath)) {
      paths.add(variant);
    }
    if (isSoundscriptSourceFile(candidateFilePath)) {
      for (
        const variant of collectPreparedAnalysisFilePathCandidates(
          toProjectedDeclarationFileName(candidateFilePath),
        )
      ) {
        paths.add(variant);
      }
    }
  };
  const includeNonDeclarationTypeScriptDependencies =
    options.includeNonDeclarationTypeScriptDependencies === true;
  const paths = new Set<string>();

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
    addDiagnosticPath(filePath);
    return {
      encounteredNonDeclarationTypeScriptDependency: false,
      paths: [...paths],
    };
  }

  const getTraversalSourceFile = (
    programKey: string,
    program: ts.Program,
    candidateFilePath: string,
  ): ts.SourceFile | null => {
    const programCache = getPreparedViewDependencyTraversalProgramCache(traversalCache, programKey);
    if (programCache.traversalSourceFileByPath.has(candidateFilePath)) {
      return programCache.traversalSourceFileByPath.get(candidateFilePath) ?? null;
    }

    for (const candidate of collectPreparedAnalysisFilePathCandidates(candidateFilePath)) {
      const sourceFile = program.getSourceFile(
        preparedView.preparedProgram.toProgramFileName(candidate),
      );
      if (sourceFile) {
        programCache.traversalSourceFileByPath.set(candidateFilePath, sourceFile);
        return sourceFile;
      }

      if (isSoundscriptSourceFile(candidate)) {
        const projectedCandidate = toProjectedDeclarationFileName(candidate);
        const projectedSourceFile = program.getSourceFile(
          preparedView.preparedProgram.toProgramFileName(projectedCandidate),
        );
        if (projectedSourceFile) {
          programCache.traversalSourceFileByPath.set(candidateFilePath, projectedSourceFile);
          return projectedSourceFile;
        }
      }
    }

    programCache.traversalSourceFileByPath.set(candidateFilePath, null);
    return null;
  };

  const getResolvedDependencies = (
    programKey: string,
    program: ts.Program,
    sourceFile: ts.SourceFile,
  ): readonly PreparedViewResolvedDependency[] => {
    const sourceFilePath = preparedView.preparedProgram.toSourceFileName(sourceFile.fileName);
    const programCache = getPreparedViewDependencyTraversalProgramCache(traversalCache, programKey);
    const cachedDependencies = programCache.resolvedDependenciesBySourcePath.get(sourceFilePath);
    if (cachedDependencies) {
      return cachedDependencies;
    }

    const resolvedDependencies = getStaticSourceFileModuleSpecifiers(sourceFile).flatMap(
      (moduleSpecifier) => {
        const resolvedModule = resolveSoundScriptAwareModule(
          moduleSpecifier,
          sourceFilePath,
          preparedView.preparedProgram.options,
          preparedView.preparedProgram.preparedHost.host,
        );
        if (!resolvedModule) {
          return [];
        }

        const resolvedSourcePath = preparedView.preparedProgram.toSourceFileName(
          resolvedModule.resolvedFileName,
        );
        const dependencySourceFile = getTraversalSourceFile(
          programKey,
          program,
          resolvedSourcePath,
        );
        const isNonDeclarationTypeScriptDependency = dependencySourceFile !== null &&
          !dependencySourceFile.isDeclarationFile &&
          !isSoundscriptSourceFile(resolvedSourcePath) &&
          !isProjectedSoundscriptDeclarationFile(resolvedSourcePath);

        return [{
          dependencySourceFile,
          isNonDeclarationTypeScriptDependency,
          resolvedSourcePath,
        }];
      },
    );

    programCache.resolvedDependenciesBySourcePath.set(sourceFilePath, resolvedDependencies);
    return resolvedDependencies;
  };

  const inProgressCollectionKeys = new Set<string>();
  const collectSourceFilePathCollection = (
    programKey: string,
    program: ts.Program,
    sourceFile: ts.SourceFile,
  ): PreparedViewDependencyPathCollection => {
    const sourceFilePath = preparedView.preparedProgram.toSourceFileName(sourceFile.fileName);
    const programCache = getPreparedViewDependencyTraversalProgramCache(traversalCache, programKey);
    const collectionCache = includeNonDeclarationTypeScriptDependencies
      ? programCache.dependencyPathCollectionsWithTypeScriptBySourcePath
      : programCache.dependencyPathCollectionsBySourcePath;
    const cachedCollection = collectionCache.get(sourceFilePath);
    if (cachedCollection) {
      return cachedCollection;
    }
    const collectionKey = `${programKey}:${
      includeNonDeclarationTypeScriptDependencies ? 'all' : 'diagnostic'
    }:${sourceFilePath}`;
    if (inProgressCollectionKeys.has(collectionKey)) {
      const cyclicPaths = new Set<string>();
      for (const variant of collectPreparedAnalysisFilePathCandidates(sourceFilePath)) {
        cyclicPaths.add(variant);
      }
      if (isSoundscriptSourceFile(sourceFilePath)) {
        for (
          const variant of collectPreparedAnalysisFilePathCandidates(
            toProjectedDeclarationFileName(sourceFilePath),
          )
        ) {
          cyclicPaths.add(variant);
        }
      }
      return {
        encounteredNonDeclarationTypeScriptDependency: false,
        paths: [...cyclicPaths],
      };
    }
    inProgressCollectionKeys.add(collectionKey);

    const dependencyPaths = new Set<string>();
    let encounteredNonDeclarationTypeScriptDependency = false;
    for (const variant of collectPreparedAnalysisFilePathCandidates(sourceFilePath)) {
      dependencyPaths.add(variant);
    }
    if (isSoundscriptSourceFile(sourceFilePath)) {
      for (
        const variant of collectPreparedAnalysisFilePathCandidates(
          toProjectedDeclarationFileName(sourceFilePath),
        )
      ) {
        dependencyPaths.add(variant);
      }
    }

    for (const dependency of getResolvedDependencies(programKey, program, sourceFile)) {
      const {
        dependencySourceFile,
        isNonDeclarationTypeScriptDependency,
        resolvedSourcePath,
      } = dependency;
      if (isNonDeclarationTypeScriptDependency) {
        encounteredNonDeclarationTypeScriptDependency = true;
      }
      const shouldIncludeDependency = isSoundscriptSourceFile(resolvedSourcePath) ||
        isProjectedSoundscriptDeclarationFile(resolvedSourcePath) ||
        (options.includeNonDeclarationTypeScriptDependencies === true &&
          isNonDeclarationTypeScriptDependency);
      if (!shouldIncludeDependency) {
        continue;
      }

      for (const variant of collectPreparedAnalysisFilePathCandidates(resolvedSourcePath)) {
        dependencyPaths.add(variant);
      }
      if (isSoundscriptSourceFile(resolvedSourcePath)) {
        for (
          const variant of collectPreparedAnalysisFilePathCandidates(
            toProjectedDeclarationFileName(resolvedSourcePath),
          )
        ) {
          dependencyPaths.add(variant);
        }
      }
      if (dependencySourceFile) {
        const nestedCollection = collectSourceFilePathCollection(
          programKey,
          program,
          dependencySourceFile,
        );
        if (nestedCollection.encounteredNonDeclarationTypeScriptDependency) {
          encounteredNonDeclarationTypeScriptDependency = true;
        }
        for (const nestedPath of nestedCollection.paths) {
          dependencyPaths.add(nestedPath);
        }
      }
    }

    const collection = {
      encounteredNonDeclarationTypeScriptDependency,
      paths: [...dependencyPaths],
    };
    collectionCache.set(sourceFilePath, collection);
    inProgressCollectionKeys.delete(collectionKey);
    return collection;
  };

  for (const traversalRoot of traversalRoots) {
    const collection = collectSourceFilePathCollection(
      traversalRoot.key,
      traversalRoot.program,
      traversalRoot.sourceFile,
    );
    for (const path of collection.paths) {
      paths.add(path);
    }
  }
  addDiagnosticPath(filePath);

  const encounteredNonDeclarationTypeScriptDependency = traversalRoots.some((traversalRoot) =>
    collectSourceFilePathCollection(
      traversalRoot.key,
      traversalRoot.program,
      traversalRoot.sourceFile,
    ).encounteredNonDeclarationTypeScriptDependency
  );
  return {
    encounteredNonDeclarationTypeScriptDependency,
    paths: [...paths],
  };
}

function collectPreparedViewFrontendDiagnosticPaths(
  preparedView: PreparedAnalysisView,
  filePath: string,
): readonly string[] {
  return collectPreparedViewDependencyPaths(preparedView, filePath);
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
        ? collectTsDiagnosticsFromDiagnosticProgram(
          preparedView,
          sourceFileMatch.diagnosticProgram,
          sourceFileMatch.sourceFile,
        )
        : preparedView.tsDiagnosticPrograms.flatMap((diagnosticProgram) => {
          if (!diagnosticProgram.filePaths || diagnosticProgram.filePaths.length === 0) {
            return collectTsDiagnosticsFromDiagnosticProgram(
              preparedView,
              diagnosticProgram,
            ).filter((diagnostic) =>
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
              ? collectTsDiagnosticsFromDiagnosticProgram(
                preparedView,
                diagnosticProgram,
                diagnosticSourceFile,
              )
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

function collectTsDiagnosticsFromDiagnosticProgram(
  preparedView: PreparedAnalysisView,
  diagnosticProgram: BuiltinExpandedTsDiagnosticProgram,
  sourceFile?: ts.SourceFile,
): readonly ts.Diagnostic[] {
  const builderProgram = diagnosticProgram.program === preparedView.program
    ? preparedView.preparedProgram.preparedHost.reuseState.semanticDiagnosticsBuilderProgram
    : undefined;
  if (!builderProgram || sourceFile) {
    return ts.getPreEmitDiagnostics(diagnosticProgram.program, sourceFile);
  }

  const diagnostics = [
    ...builderProgram.getConfigFileParsingDiagnostics(),
    ...builderProgram.getOptionsDiagnostics(),
    ...builderProgram.getGlobalDiagnostics(),
    ...builderProgram.getSyntacticDiagnostics(),
    ...builderProgram.getSemanticDiagnostics(),
    ...(shouldCollectDeclarationDiagnostics(builderProgram.getCompilerOptions())
      ? builderProgram.getDeclarationDiagnostics()
      : []),
  ];
  persistPreparedProgramBuildInfo(preparedView.preparedProgram);
  return diagnostics;
}

function shouldCollectDeclarationDiagnostics(options: ts.CompilerOptions): boolean {
  return options.declaration === true || options.composite === true;
}

function collectPreparedViewUniversalDiagnostics(
  preparedView: PreparedAnalysisView,
  analysisContext: AnalysisContext,
  filePath?: string,
): readonly SoundDiagnostic[] {
  if (!preparedView.runUniversalPolicy) {
    return [];
  }

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

interface CollectPreparedViewSoundDiagnosticsOptions {
  captureArtifacts?: PreparedProjectAnalysisArtifacts;
  reuseRuleCache?: SoundAnalysisRuleCache;
  ruleCacheKeysByFile?: ReadonlyMap<string, string>;
}

function createEmptyPreparedProjectAnalysisArtifacts(): PreparedProjectAnalysisArtifacts {
  return {
    effectsByFile: new Map<string, FileDiagnosticRuleCacheEntry>(),
    flowByFile: new Map<string, FlowFileRuleCache>(),
    relationsByFile: new Map<string, FileDiagnosticRuleCacheEntry>(),
    valueTypesByFile: new Map<string, FileDiagnosticRuleCacheEntry>(),
  };
}

function mergeSoundAnalysisArtifacts(
  target: PreparedProjectAnalysisArtifacts,
  artifacts: SoundAnalysisArtifacts,
): void {
  for (const [filePath, cache] of artifacts.effectsByFile.entries()) {
    (target.effectsByFile as Map<string, FileDiagnosticRuleCacheEntry>).set(filePath, cache);
  }
  for (const [filePath, cache] of artifacts.flowByFile.entries()) {
    (target.flowByFile as Map<string, FlowFileRuleCache>).set(filePath, cache);
  }
  for (const [filePath, cache] of artifacts.relationsByFile.entries()) {
    (target.relationsByFile as Map<string, FileDiagnosticRuleCacheEntry>).set(filePath, cache);
  }
  for (const [filePath, cache] of artifacts.valueTypesByFile.entries()) {
    (target.valueTypesByFile as Map<string, FileDiagnosticRuleCacheEntry>).set(filePath, cache);
  }
}

function remapFileDiagnosticRuleCacheToProgramFiles(
  preparedView: PreparedAnalysisView,
  cacheByFile: ReadonlyMap<string, FileDiagnosticRuleCacheEntry> | undefined,
): ReadonlyMap<string, FileDiagnosticRuleCacheEntry> | undefined {
  if (!cacheByFile || cacheByFile.size === 0) {
    return cacheByFile;
  }

  return new Map(
    [...cacheByFile.entries()].map(([filePath, cache]) => [
      preparedView.preparedProgram.toProgramFileName(filePath),
      cache,
    ]),
  );
}

function remapSoundAnalysisRuleCacheToProgramFiles(
  preparedView: PreparedAnalysisView,
  ruleCache: SoundAnalysisRuleCache | undefined,
): SoundAnalysisRuleCache | undefined {
  if (!ruleCache) {
    return ruleCache;
  }

  return {
    effectsByFile: remapFileDiagnosticRuleCacheToProgramFiles(
      preparedView,
      ruleCache.effectsByFile,
    ),
    flowByFile: ruleCache.flowByFile
      ? new Map(
        [...ruleCache.flowByFile.entries()].map(([filePath, cache]) => [
          preparedView.preparedProgram.toProgramFileName(filePath),
          cache,
        ]),
      )
      : undefined,
    relationsByFile: remapFileDiagnosticRuleCacheToProgramFiles(
      preparedView,
      ruleCache.relationsByFile,
    ),
    valueTypesByFile: remapFileDiagnosticRuleCacheToProgramFiles(
      preparedView,
      ruleCache.valueTypesByFile,
    ),
  };
}

function remapSoundAnalysisArtifactsToSourceFiles(
  preparedView: PreparedAnalysisView,
  artifacts: SoundAnalysisArtifacts,
): SoundAnalysisArtifacts {
  return {
    effectsByFile: new Map(
      [...artifacts.effectsByFile.entries()].map(([filePath, cache]) => [
        preparedView.preparedProgram.toSourceFileName(filePath),
        cache,
      ]),
    ),
    flowByFile: new Map(
      [...artifacts.flowByFile.entries()].map(([filePath, cache]) => [
        preparedView.preparedProgram.toSourceFileName(filePath),
        cache,
      ]),
    ),
    relationsByFile: new Map(
      [...artifacts.relationsByFile.entries()].map(([filePath, cache]) => [
        preparedView.preparedProgram.toSourceFileName(filePath),
        cache,
      ]),
    ),
    valueTypesByFile: new Map(
      [...artifacts.valueTypesByFile.entries()].map(([filePath, cache]) => [
        preparedView.preparedProgram.toSourceFileName(filePath),
        cache,
      ]),
    ),
  };
}

function getPreparedViewSourceTextForRuleCacheKey(
  preparedView: PreparedAnalysisView,
  filePath: string,
): string {
  const sourceFileMatch = getPreparedViewSourceFileMatch(preparedView, filePath);
  if (sourceFileMatch) {
    try {
      return soundRuleCacheKeyPrinter.printFile(sourceFileMatch.sourceFile);
    } catch {
      return sourceFileMatch.sourceFile.text;
    }
  }

  const diagnosticProgramMatch = getPreparedViewTsDiagnosticProgramMatch(preparedView, filePath);
  if (diagnosticProgramMatch) {
    try {
      return soundRuleCacheKeyPrinter.printFile(diagnosticProgramMatch.sourceFile);
    } catch {
      return diagnosticProgramMatch.sourceFile.text;
    }
  }

  return ts.sys.readFile(filePath) ?? '';
}

function createPreparedViewSoundRuleCacheKey(
  preparedView: PreparedAnalysisView,
  filePath: string,
): string {
  const parts = [
    `file:${filePath}`,
    `view:${preparedView.universalPolicyScope}`,
    `sound:${preparedView.runSound ? '1' : '0'}`,
    `source:${getPreparedViewSourceTextForRuleCacheKey(preparedView, filePath)}`,
  ];
  for (const dependencyPath of collectPreparedViewDirectDependencyPaths(preparedView, filePath)) {
    parts.push(
      `dep:${dependencyPath}:${
        getPreparedViewSourceTextForRuleCacheKey(preparedView, dependencyPath)
      }`,
    );
  }
  return ts.sys.createHash?.(parts.join('\u0000')) ?? parts.join('\u0000');
}

function collectPreparedViewSoundDiagnostics(
  preparedView: PreparedAnalysisView,
  analysisContext: AnalysisContext,
  filePath?: string,
  options: CollectPreparedViewSoundDiagnosticsOptions = {},
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
      const collectedArtifacts = createEmptyPreparedProjectAnalysisArtifacts();
      const diagnostics = remapDiagnostics(
        remapSoundDiagnostics(
          preparedView.runSound
            ? runSoundAnalysis(analysisContext, {
              onArtifacts: (artifacts) =>
                mergeSoundAnalysisArtifacts(
                  collectedArtifacts,
                  remapSoundAnalysisArtifactsToSourceFiles(preparedView, artifacts),
                ),
              fileScopedRuleCacheKeysByFile: options.ruleCacheKeysByFile
                ? new Map(
                  [...options.ruleCacheKeysByFile.entries()].map(([sourceFilePath, cacheKey]) => [
                    preparedView.preparedProgram.toProgramFileName(sourceFilePath),
                    cacheKey,
                  ]),
                )
                : undefined,
              ruleCache: remapSoundAnalysisRuleCacheToProgramFiles(
                preparedView,
                options.reuseRuleCache,
              ),
            })
            : [],
          preparedView.diagnosticPreparedFiles,
        ),
      );
      if (options.captureArtifacts) {
        mergeSoundAnalysisArtifacts(options.captureArtifacts, collectedArtifacts);
      }
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

  if (!supportsFileScopedAnalysisContext(preparedView, filePath)) {
    byFile.set(filePath, null);
    return null;
  }
  const sourceFileMatch = getPreparedViewSourceFileMatch(preparedView, filePath);
  if (!sourceFileMatch) {
    byFile.set(filePath, null);
    return null;
  }
  const sourceFile = sourceFileMatch.sourceFile;

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

function supportsFileScopedAnalysisContext(
  preparedView: PreparedAnalysisView,
  filePath: string,
): boolean {
  let byFile = fileScopedAnalysisEligibilityCache.get(preparedView);
  if (!byFile) {
    byFile = new Map<string, boolean>();
    fileScopedAnalysisEligibilityCache.set(preparedView, byFile);
  }

  const cached = byFile.get(filePath);
  if (cached !== undefined) {
    return cached;
  }

  const sourceFileMatch = getPreparedViewSourceFileMatch(preparedView, filePath);
  if (!sourceFileMatch) {
    byFile.set(filePath, false);
    return false;
  }
  const sourceFile = sourceFileMatch.sourceFile;
  const preparedSource = preparedView.preparedProgram.preparedHost.getPreparedSourceFile(
    sourceFileMatch.matchedFilePath,
  );
  const supported =
    !hasTopLevelMacroReplacements(sourceFileMatch.matchedFilePath, preparedSource) &&
    !hasGeneratedTopLevelStatements(sourceFile, preparedView.analysisContext.isGeneratedNode);
  byFile.set(filePath, supported);
  return supported;
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
  metadata.macroBindingPlanHits = macroCacheStats.bindingPlanCacheHits;
  metadata.macroBindingPlanMisses = macroCacheStats.bindingPlanCacheMisses;
  metadata.macroBindingPlanInvalidations = macroCacheStats.bindingPlanCacheInvalidations;
  metadata.macroExpandedFileHits = macroCacheStats.expandedFileCacheHits;
  metadata.macroExpandedFileMisses = macroCacheStats.expandedFileCacheMisses;
  metadata.macroExpandedFileInvalidations = macroCacheStats.expandedFileCacheInvalidations;
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
    bindingPlanCacheHits: 0,
    bindingPlanCacheInvalidations: 0,
    bindingPlanCacheMisses: 0,
    expandedFileCacheHits: 0,
    expandedFileCacheInvalidations: 0,
    expandedFileCacheMisses: 0,
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

    aggregated.bindingPlanCacheHits += view.macroCacheStats.bindingPlanCacheHits;
    aggregated.bindingPlanCacheInvalidations += view.macroCacheStats.bindingPlanCacheInvalidations;
    aggregated.bindingPlanCacheMisses += view.macroCacheStats.bindingPlanCacheMisses;
    aggregated.expandedFileCacheHits += view.macroCacheStats.expandedFileCacheHits;
    aggregated.expandedFileCacheInvalidations +=
      view.macroCacheStats.expandedFileCacheInvalidations;
    aggregated.expandedFileCacheMisses += view.macroCacheStats.expandedFileCacheMisses;
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
      const projectDirectory = dirname(options.projectPath);
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
        !loadedConfig.isSoundscriptSourceFile(fileName)
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
        loadedConfig.frontierCommandLine.options,
        options.fileOverrides,
        loadedConfig.isSoundscriptSourceFile,
      );
      const canReuseConfigArtifacts = reusableProject !== undefined &&
        reusableProject.analyzeOptions.projectPath === options.projectPath &&
        reusableProject.configReuseSignature === configReuseSignature;
      const persistentReuseSnapshots = !canReuseConfigArtifacts
        ? prepareOptions.persistentReuseSnapshots
        : undefined;
      const persistentStsCompilerHostReuseState =
        hydratePersistentPreparedAnalysisViewReuseSnapshot(
          persistentReuseSnapshots?.sts,
          projectDirectory,
        );
      const persistentTsCompilerHostReuseState = hydratePersistentPreparedAnalysisViewReuseSnapshot(
        persistentReuseSnapshots?.ts,
        projectDirectory,
      );
      const persistentPackageSourcePolicyCompilerHostReuseState =
        hydratePersistentPreparedAnalysisViewReuseSnapshot(
          persistentReuseSnapshots?.packageSourcePolicy,
          projectDirectory,
        );
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
              loadedConfig.frontierCommandLine,
              stsProgramRootNames,
              createSoundStdlibCompilerHost(
                loadedConfig.frontierCommandLine.options,
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
              canReuseConfigArtifacts
                ? reusableProject?.stsCompilerHostReuseState
                : persistentStsCompilerHostReuseState,
              canReuseConfigArtifacts ? reusableProject?.stsView?.program : undefined,
              'sts',
              prepareOptions.persistentBuildInfoDirectory,
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
            : persistentPackageSourcePolicyCompilerHostReuseState,
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
            : persistentTsCompilerHostReuseState,
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
            : persistentPackageSourcePolicyCompilerHostReuseState,
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
            : persistentTsCompilerHostReuseState,
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
      const packageProjectedDeclarationRootNames =
        collectProjectedDeclarationCandidateRootNamesFromPrograms(
          [stsView?.program],
          localProjectedDeclarationOverrides,
          projectPackageJsonPath,
        );
      const packageSourcePolicyContentSignature = packageProjectedDeclarationRootNames.length === 0
        ? ''
        : createSoundscriptRootContentSignature(
          packageProjectedDeclarationRootNames,
          loadedConfig.frontierCommandLine.options,
          options.fileOverrides,
          loadedConfig.isSoundscriptSourceFile,
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
      const canReuseTsView = canReuseConfigArtifacts &&
        rootNamesEqual(
          reusableProject.tsView?.program.getRootFileNames().map(toSourceFileName) ?? [],
          typescriptRootNames,
        ) &&
        !projectedDeclarationOverridesDiffer(
          reusableProject.localProjectedDeclarationOverrides,
          localProjectedDeclarationOverrides,
        );

      const tsView = canReuseTsView ? reusableProject?.tsView ?? null : measureCheckerTiming(
        'project.prepare.hostView',
        {
          projectionCount: localProjectedDeclarationOverrides?.size ?? 0,
          rootCount: typescriptRootNames.length,
        },
        () =>
          prepareHostAnalysisView(
            options,
            loadedConfig,
            typescriptRootNames,
            configFileParsingDiagnostics,
            localProjectedDeclarationOverrides,
            canReuseConfigArtifacts
              ? reusableProject?.tsCompilerHostReuseState
              : persistentTsCompilerHostReuseState,
            canReuseConfigArtifacts ? reusableProject?.tsView?.program : undefined,
            prepareOptions.persistentBuildInfoDirectory,
          ),
        { always: true },
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
          : persistentPackageSourcePolicyCompilerHostReuseState,
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
                loadedConfig.frontierCommandLine,
                packageProjectedDeclarationRootNames,
                createSoundStdlibCompilerHost(
                  loadedConfig.frontierCommandLine.options,
                  dirname(options.projectPath),
                ),
                [],
                shouldAnalyzeSoundscriptSourceFile,
                localProjectedDeclarationOverrides,
                true,
                'sourceSupplemental',
                canReusePackageSourcePolicyView
                  ? reusableProject?.packageSourcePolicyCompilerHostReuseState
                  : persistentPackageSourcePolicyCompilerHostReuseState,
                canReusePackageSourcePolicyView
                  ? reusableProject?.packageSourcePolicyView?.program
                  : undefined,
                'package-source-policy',
                prepareOptions.persistentBuildInfoDirectory,
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
        tsCompilerHostReuseState: tsView?.preparedProgram.preparedHost.reuseState,
        tsView,
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
  return supplementalViews;
}

export function analyzePreparedProjectForFile(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
): AnalyzeProjectResult {
  return analyzePreparedProjectForFileWithArtifacts(preparedProject, filePath).result;
}

export function analyzePreparedProjectOwnedDiagnosticsForFile(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
): AnalyzeProjectResult {
  return analyzePreparedProjectOwnedDiagnosticsForFileWithArtifacts(
    preparedProject,
    filePath,
  ).result;
}

export function analyzePreparedProjectOwnedDiagnosticsForFileWithArtifacts(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
  reuseArtifacts: PreparedProjectAnalysisArtifacts = createEmptyPreparedProjectAnalysisArtifacts(),
): AnalyzePreparedProjectWithArtifactsResult {
  return measureCheckerTiming(
    'project.analyzePreparedProjectOwnedDiagnosticsForFile',
    {
      filePath,
      hasTsView: preparedProject.tsView !== null,
      hasStsView: preparedProject.stsView !== null,
    },
    () => {
      const artifacts = createEmptyPreparedProjectAnalysisArtifacts();
      const flowRuleCache: SoundAnalysisRuleCache = {
        effectsByFile: reuseArtifacts.effectsByFile,
        flowByFile: reuseArtifacts.flowByFile,
        relationsByFile: reuseArtifacts.relationsByFile,
        valueTypesByFile: reuseArtifacts.valueTypesByFile,
      };
      const primaryView = getPreparedAnalysisViewForFile(preparedProject, filePath);
      const primaryAnalysis = analyzePreparedViewForFile(primaryView, filePath, {
        captureArtifacts: artifacts,
        reuseRuleCache: flowRuleCache,
      });
      const diagnostics = dedupeMergedDiagnostics([
        ...primaryAnalysis.frontendDiagnostics,
        ...primaryAnalysis.tsDiagnostics,
        ...primaryAnalysis.soundDiagnostics,
      ]);

      return {
        artifacts,
        result: {
          diagnostics,
          summary: createSummary(diagnostics),
        },
      };
    },
    { always: true },
  );
}

export function analyzePreparedProjectForFileWithArtifacts(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
  reuseArtifacts: PreparedProjectAnalysisArtifacts = createEmptyPreparedProjectAnalysisArtifacts(),
): AnalyzePreparedProjectWithArtifactsResult {
  return measureCheckerTiming(
    'project.analyzePreparedProjectForFile',
    {
      filePath,
      hasTsView: preparedProject.tsView !== null,
      hasStsView: preparedProject.stsView !== null,
    },
    () => {
      const artifacts = createEmptyPreparedProjectAnalysisArtifacts();
      const flowRuleCache: SoundAnalysisRuleCache = {
        effectsByFile: reuseArtifacts.effectsByFile,
        flowByFile: reuseArtifacts.flowByFile,
        relationsByFile: reuseArtifacts.relationsByFile,
        valueTypesByFile: reuseArtifacts.valueTypesByFile,
      };
      const primaryView = getPreparedAnalysisViewForFile(preparedProject, filePath);
      const primaryAnalysis = analyzePreparedViewForFile(primaryView, filePath, {
        captureArtifacts: artifacts,
        reuseRuleCache: flowRuleCache,
      });
      const diagnosticPaths = collectPreparedProjectDiagnosticPathsForFile(
        preparedProject,
        filePath,
      );
      const supplementalViews = getPreparedAnalysisSupplementalViewsForFile(
        preparedProject,
        filePath,
        primaryView,
      );
      const requiresDependencyAnalysis = supplementalViews.length > 0 ||
        diagnosticPaths.some((diagnosticPath) =>
          !matchesPreparedAnalysisFilePath(diagnosticPath, filePath)
        );
      const primaryDependencyAnalysis = requiresDependencyAnalysis
        ? analyzePreparedViewForDiagnosticPaths(
          primaryView,
          diagnosticPaths,
          {
            captureArtifacts: artifacts,
            reuseRuleCache: flowRuleCache,
          },
        )
        : {
          frontendDiagnostics: [],
          tsDiagnostics: [],
          soundDiagnostics: [],
        };
      const supplementalAnalyses = requiresDependencyAnalysis
        ? supplementalViews.map((view) =>
          analyzePreparedViewForDiagnosticPaths(view, diagnosticPaths, {
            captureArtifacts: artifacts,
            reuseRuleCache: flowRuleCache,
          })
        )
        : [];
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
        artifacts,
        result: {
          diagnostics,
          summary: createSummary(diagnostics),
        },
      };
    },
    { always: true },
  );
}

function collectPreparedProjectDiagnosticPathsForFile(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
): readonly string[] {
  const primaryView = getPreparedAnalysisViewForFile(preparedProject, filePath);
  return primaryView
    ? collectPreparedViewFrontendDiagnosticPaths(primaryView, filePath)
    : [filePath];
}

function collectPreparedProjectCacheDependencyPathsForFile(
  preparedProject: PreparedAnalysisProject,
  filePath: string,
): readonly string[] {
  const primaryView = getPreparedAnalysisViewForFile(preparedProject, filePath);
  return primaryView
    ? collectPreparedViewDependencyPaths(primaryView, filePath, {
      includeNonDeclarationTypeScriptDependencies: true,
    })
    : [filePath];
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
  return analyzePreparedProjectWithArtifacts(preparedProject).result;
}

export function analyzePreparedProjectWithArtifacts(
  preparedProject: PreparedAnalysisProject,
  reuseArtifacts: PreparedProjectAnalysisArtifacts = createEmptyPreparedProjectAnalysisArtifacts(),
): AnalyzePreparedProjectWithArtifactsResult {
  return measureCheckerTiming(
    'project.analyzePreparedProject',
    {
      hasTsView: preparedProject.tsView !== null,
      hasStsView: preparedProject.stsView !== null,
    },
    () => {
      const artifacts = createEmptyPreparedProjectAnalysisArtifacts();
      const flowRuleCache: SoundAnalysisRuleCache = {
        effectsByFile: reuseArtifacts.effectsByFile,
        flowByFile: reuseArtifacts.flowByFile,
        relationsByFile: reuseArtifacts.relationsByFile,
        valueTypesByFile: reuseArtifacts.valueTypesByFile,
      };
      const analyzedPrograms = [
        analyzePreparedView(preparedProject.tsView, {
          captureArtifacts: artifacts,
          reuseRuleCache: flowRuleCache,
        }),
        analyzePreparedView(preparedProject.stsView, {
          captureArtifacts: artifacts,
          reuseRuleCache: flowRuleCache,
        }),
        analyzePreparedView(preparedProject.packageSourcePolicyView, {
          captureArtifacts: artifacts,
          reuseRuleCache: flowRuleCache,
        }),
      ];
      const diagnostics = dedupeMergedDiagnostics(analyzedPrograms.flatMap((programResult) => [
        ...programResult.frontendDiagnostics,
        ...programResult.tsDiagnostics,
        ...programResult.soundDiagnostics,
      ]));

      return {
        artifacts,
        result: {
          diagnostics,
          summary: createSummary(diagnostics),
        },
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
