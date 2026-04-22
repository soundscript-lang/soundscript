import ts from 'typescript';

import { measureCheckerTiming } from '../checker/timing.ts';
import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import { loadConfig, type LoadedConfig } from '../project/config.ts';
import { withBuiltinMacroSupport } from '../frontend/builtin_macro_support.ts';
import { dirname, join } from '../platform/path.ts';
import {
  createPreparedProgram,
  type PreparedProgram,
  toSourceFileName,
} from '../frontend/project_frontend.ts';
import { resolveSoundScriptAwareModule } from '../project/soundscript_packages.ts';
import {
  detectRuntimeTypeScriptSupport,
  emitPreparedSoundscriptModuleDirect,
  emitTypeScriptModuleDirect,
  runtimeRequiresJavaScriptFallback,
  type RuntimeTransformArtifact,
  transpilePreparedSoundscriptModuleToEsm,
  transpileTypeScriptModuleToEsm,
} from './transform.ts';
import { collectRuntimeSemanticClosure } from './semantic_closure.ts';
import {
  createDeferredRuntimeExpansion,
  createPreparedRuntimeProgram,
  createSemanticRuntimeExpansion,
  type DeferredRuntimeExpansion,
  expandSemanticPlaceholdersOnDeferredSourceFile,
  finalizeRuntimeExpandedSourceFile,
  type SemanticRuntimeExpansion,
} from './runtime_macro_pipeline.ts';

const PROJECT_CONFIG_CANDIDATES = ['tsconfig.soundscript.json', 'tsconfig.json'] as const;
const LOCAL_CODE_EXTENSIONS = ['.sts', '.ts', '.tsx', '.mts', '.cts', '.jsx'] as const;
const MAX_CACHED_SEMANTIC_RUNTIME_PROGRAMS = 4;

interface TransformProjectContext {
  readonly compilerOptions: ts.CompilerOptions;
  readonly loadedConfig: LoadedConfig;
  readonly projectPath: string;
}

interface TransformProjectSession {
  deferredExpansion?: DeferredRuntimeExpansion;
  macroModeHintsByFile: Map<string, { mode: 'deferred' | 'semantic'; sourceHash: string }>;
  preparedProgram?: PreparedProgram;
  preparedRoots: Set<string>;
  projectContext: TransformProjectContext;
  semanticEmittedArtifactsBySignature: Map<
    string,
    Map<string, { result: OnDemandTransformResult; sourceHash: string }>
  >;
  semanticClosureRootsBySignature: Map<string, readonly string[]>;
  semanticLastUsedSignature?: string;
  semanticExpansionsBySignature: Map<string, SemanticRuntimeExpansion>;
  semanticRequiredSourceHashes: Map<string, string>;
}

export type OnDemandTransformMode =
  | 'soundscript-deferred-macro'
  | 'soundscript-prepared'
  | 'soundscript-semantic-macro'
  | 'typescript';

export interface OnDemandTransformResult extends RuntimeTransformArtifact {
  projectPath: string;
  transformMode: OnDemandTransformMode;
}

export interface OnDemandTransformer {
  resolveImportSpecifier(specifier: string, importer: string): string | undefined;
  shouldTransformFile(fileName: string): boolean;
  transformModule(fileName: string): Promise<OnDemandTransformResult>;
}

export interface SyncOnDemandTransformer extends OnDemandTransformer {
  transformModuleSync(fileName: string): OnDemandTransformResult;
}

export interface OnDemandTransformerOptions {
  projectPath?: string;
  workingDirectory?: string;
}

function fileExists(path: string): boolean {
  return ts.sys.fileExists(path);
}

function directoryExists(path: string): boolean {
  return ts.sys.directoryExists?.(path) === true;
}

function isRelativeOrAbsoluteSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

function isTypeScriptLikeFile(fileName: string): boolean {
  const lowered = fileName.toLowerCase();
  return (
    lowered.endsWith('.ts') ||
    lowered.endsWith('.tsx') ||
    lowered.endsWith('.mts') ||
    lowered.endsWith('.cts') ||
    lowered.endsWith('.jsx')
  ) && !(
    lowered.endsWith('.d.ts') ||
    lowered.endsWith('.d.mts') ||
    lowered.endsWith('.d.cts')
  );
}

function isTransformableRuntimeFile(fileName: string): boolean {
  return fileName.endsWith('.sts') || isTypeScriptLikeFile(fileName);
}

function resolvePathWithExtensions(basePath: string): string | undefined {
  for (const extension of LOCAL_CODE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`;
    if (fileExists(candidate)) {
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
  if (fileExists(candidateBase)) {
    return candidateBase;
  }

  const directMatch = resolvePathWithExtensions(candidateBase);
  if (directMatch) {
    return directMatch;
  }

  if (directoryExists(candidateBase)) {
    const indexMatch = resolvePathWithExtensions(join(candidateBase, 'index'));
    if (indexMatch) {
      return indexMatch;
    }
  }

  return undefined;
}

function findNearestProjectPath(startPath: string): string | undefined {
  const initialDirectory = fileExists(startPath) ? dirname(startPath) : startPath;
  let currentDirectory = initialDirectory;

  while (true) {
    for (const candidate of PROJECT_CONFIG_CANDIDATES) {
      const projectPath = join(currentDirectory, candidate);
      if (fileExists(projectPath)) {
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

function loadProjectContext(projectPath: string): TransformProjectContext {
  const loadedConfig = loadConfig(projectPath);
  return {
    compilerOptions: loadedConfig.frontierCommandLine.options,
    loadedConfig,
    projectPath,
  };
}

function getPreparedOriginalText(
  preparedProgram: Pick<PreparedProgram, 'preparedHost' | 'toProgramFileName'>,
  fileName: string,
): string | undefined {
  const programFileName = preparedProgram.toProgramFileName(fileName);
  return preparedProgram.preparedHost.getPreparedSourceFile(programFileName)
    ?.originalText;
}

function getPreparedSourceFile(
  preparedProgram: PreparedProgram,
  fileName: string,
) {
  return preparedProgram.preparedHost.getPreparedSourceFile(
    preparedProgram.toProgramFileName(fileName),
  );
}

function assertPreparedSourceFileHasNoBlockingDiagnostics(
  fileName: string,
  preparedFile: NonNullable<ReturnType<typeof getPreparedSourceFile>>,
): void {
  const diagnostics = preparedFile.diagnostics.filter((diagnostic) =>
    diagnostic.category === 'error'
  );
  if (diagnostics.length === 0) {
    return;
  }

  const detail = diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join(
    '\n',
  );
  throw new Error(
    `Cannot transform ${fileName} because Soundscript preparation failed.\n${detail}`,
  );
}

function preparedProgramIncludesFile(
  preparedProgram: PreparedProgram,
  fileName: string,
): boolean {
  return preparedProgram.program.getSourceFile(preparedProgram.toProgramFileName(fileName)) !==
    undefined;
}

function transpileSemanticSourceFile(
  sourceFile: ts.SourceFile,
  fileName: string,
  projectPath: string,
  compilerOptions: ts.CompilerOptions,
  runtimeTypeScriptSupport: ReturnType<typeof detectRuntimeTypeScriptSupport>,
): OnDemandTransformResult {
  return measureCheckerTiming(
    'runtime.onDemand.semanticEmit',
    { fileName },
    () => {
      const sourceText = ts.createPrinter().printFile(sourceFile);
      const artifact = runtimeTypeScriptSupport !== false &&
          !runtimeRequiresJavaScriptFallback(sourceText, fileName)
        ? emitTypeScriptModuleDirect(
          fileName,
          sourceText,
          {
            moduleSpecifierMode: 'preserve',
            target: ts.ScriptTarget.ES2022,
            jsxImportSource: compilerOptions.jsxImportSource,
          },
        )
        : transpileTypeScriptModuleToEsm(
          fileName,
          `${fileName}.js`,
          sourceText,
          {
            module: ts.ModuleKind.ES2022,
            moduleSpecifierMode: 'preserve',
            target: ts.ScriptTarget.ES2022,
            jsxImportSource: compilerOptions.jsxImportSource,
          },
        );
      return {
        ...artifact,
        projectPath,
        transformMode: 'soundscript-semantic-macro',
      };
    },
    { always: true },
  );
}

function resolveProjectPath(
  fileName: string,
  explicitProjectPath: string | undefined,
): string | undefined {
  const projectPath = explicitProjectPath ?? findNearestProjectPath(fileName);
  if (!projectPath) {
    return undefined;
  }

  return projectPath;
}

function createIsolatedPreparedRuntimeProgram(
  projectContext: TransformProjectContext,
  fileName: string,
): PreparedProgram {
  return createPreparedProgram(withBuiltinMacroSupport({
    baseHost: createSoundStdlibCompilerHost(
      projectContext.loadedConfig.frontierCommandLine.options,
      dirname(projectContext.projectPath),
    ),
    configuredSoundscriptFileNames: projectContext.loadedConfig.frontierConfiguredFileNames,
    options: {
      ...projectContext.loadedConfig.frontierCommandLine.options,
      noResolve: true,
    },
    rootNames: [fileName],
    runtime: projectContext.loadedConfig.runtime,
  }));
}

function disposeSemanticPrograms(session: TransformProjectSession): void {
  for (const expansion of session.semanticExpansionsBySignature.values()) {
    expansion.dispose();
  }
  session.semanticEmittedArtifactsBySignature.clear();
  session.semanticExpansionsBySignature.clear();
  session.semanticClosureRootsBySignature.clear();
  session.semanticLastUsedSignature = undefined;
}

function trimSemanticProgramCache(session: TransformProjectSession): void {
  while (session.semanticExpansionsBySignature.size > MAX_CACHED_SEMANTIC_RUNTIME_PROGRAMS) {
    const oldestSignature = session.semanticExpansionsBySignature.keys().next().value;
    if (!oldestSignature) {
      break;
    }
    const oldestProgram = session.semanticExpansionsBySignature.get(oldestSignature);
    oldestProgram?.dispose();
    session.semanticEmittedArtifactsBySignature.delete(oldestSignature);
    session.semanticExpansionsBySignature.delete(oldestSignature);
    session.semanticClosureRootsBySignature.delete(oldestSignature);
    if (session.semanticLastUsedSignature === oldestSignature) {
      session.semanticLastUsedSignature = undefined;
    }
  }
}

function transpilePreparedSourceFile(
  preparedProgram: PreparedProgram,
  fileName: string,
  projectPath: string,
  compilerOptions: ts.CompilerOptions,
  runtimeTypeScriptSupport: ReturnType<typeof detectRuntimeTypeScriptSupport>,
): OnDemandTransformResult {
  const preparedFile = getPreparedSourceFile(preparedProgram, fileName);
  if (!preparedFile) {
    throw new Error(`Missing prepared source file for ${fileName}.`);
  }
  assertPreparedSourceFileHasNoBlockingDiagnostics(fileName, preparedFile);

  const artifact = runtimeTypeScriptSupport !== false &&
      !runtimeRequiresJavaScriptFallback(preparedFile.rewrittenText, fileName)
    ? emitPreparedSoundscriptModuleDirect(
      fileName,
      preparedFile,
      {
        moduleSpecifierMode: 'preserve',
        target: ts.ScriptTarget.ES2022,
        jsxImportSource: compilerOptions.jsxImportSource,
      },
    )
    : transpilePreparedSoundscriptModuleToEsm(
      fileName,
      `${fileName}.js`,
      preparedFile,
      {
        module: ts.ModuleKind.ES2022,
        moduleSpecifierMode: 'preserve',
        target: ts.ScriptTarget.ES2022,
        jsxImportSource: compilerOptions.jsxImportSource,
      },
    );
  return {
    ...artifact,
    projectPath,
    transformMode: 'soundscript-prepared',
  };
}

function transpileDeferredExpandedSourceFile(
  expansion: DeferredRuntimeExpansion,
  fileName: string,
  projectPath: string,
  compilerOptions: ts.CompilerOptions,
  runtimeTypeScriptSupport: ReturnType<typeof detectRuntimeTypeScriptSupport>,
): OnDemandTransformResult {
  const cachedArtifact = expansion.emittedArtifactsByFile.get(fileName);
  if (cachedArtifact) {
    return cachedArtifact as OnDemandTransformResult;
  }

  const result = measureCheckerTiming(
    'runtime.onDemand.deferredEmit',
    { fileName },
    () => {
      const sourceFile = expansion.expandedFiles.get(
        expansion.preparedProgram.toProgramFileName(fileName),
      );
      if (!sourceFile) {
        throw new Error(`Missing deferred expanded source file for ${fileName}.`);
      }

      const sourceText = ts.createPrinter().printFile(
        finalizeRuntimeExpandedSourceFile(expansion.preparedProgram, sourceFile),
      );
      const artifact = runtimeTypeScriptSupport !== false &&
          !runtimeRequiresJavaScriptFallback(sourceText, fileName)
        ? emitTypeScriptModuleDirect(
          fileName,
          sourceText,
          {
            moduleSpecifierMode: 'preserve',
            target: ts.ScriptTarget.ES2022,
            jsxImportSource: compilerOptions.jsxImportSource,
          },
        )
        : transpileTypeScriptModuleToEsm(
          fileName,
          `${fileName}.js`,
          sourceText,
          {
            module: ts.ModuleKind.ES2022,
            moduleSpecifierMode: 'preserve',
            target: ts.ScriptTarget.ES2022,
            jsxImportSource: compilerOptions.jsxImportSource,
          },
        );
      return {
        ...artifact,
        projectPath,
        transformMode: 'soundscript-deferred-macro' as const,
      };
    },
    { always: true },
  );
  expansion.emittedArtifactsByFile.set(fileName, result);
  return result;
}

export function createOnDemandTransformer(
  options: OnDemandTransformerOptions = {},
): SyncOnDemandTransformer {
  const soundscriptCache = new Map<string, OnDemandTransformResult>();
  const typeScriptCache = new Map<string, OnDemandTransformResult>();
  const projectContextByPath = new Map<string, TransformProjectContext>();
  const projectPathByFileName = new Map<string, string | undefined>();
  const projectSessionsByPath = new Map<string, TransformProjectSession>();
  const runtimeTypeScriptSupport = detectRuntimeTypeScriptSupport();

  function getProjectContext(
    fileName: string,
    explicitProjectPath: string | undefined,
  ): TransformProjectContext | undefined {
    const cachedProjectPath = explicitProjectPath === undefined
      ? projectPathByFileName.get(fileName)
      : undefined;
    const projectPath = cachedProjectPath !== undefined
      ? cachedProjectPath
      : resolveProjectPath(fileName, explicitProjectPath);
    if (explicitProjectPath === undefined) {
      projectPathByFileName.set(fileName, projectPath);
    }
    if (!projectPath) {
      return undefined;
    }

    const cachedContext = projectContextByPath.get(projectPath);
    if (cachedContext) {
      return cachedContext;
    }

    const projectContext = loadProjectContext(projectPath);
    projectContextByPath.set(projectPath, projectContext);
    return projectContext;
  }

  function getProjectSession(projectContext: TransformProjectContext): TransformProjectSession {
    const cachedSession = projectSessionsByPath.get(projectContext.projectPath);
    if (cachedSession) {
      return cachedSession;
    }

    const session: TransformProjectSession = {
      macroModeHintsByFile: new Map(),
      preparedRoots: new Set(),
      projectContext,
      semanticEmittedArtifactsBySignature: new Map(),
      semanticClosureRootsBySignature: new Map(),
      semanticExpansionsBySignature: new Map(),
      semanticRequiredSourceHashes: new Map(),
    };
    projectSessionsByPath.set(projectContext.projectPath, session);
    return session;
  }

  function ensureSemanticRuntimeExpansionForFile(
    session: TransformProjectSession,
    fileNames: readonly string[],
  ): { expansion: SemanticRuntimeExpansion; signature: string } {
    const closure = collectRuntimeSemanticClosure(session.projectContext, fileNames);
    const cachedProgram = session.semanticExpansionsBySignature.get(closure.signature);
    if (cachedProgram) {
      session.semanticExpansionsBySignature.delete(closure.signature);
      session.semanticExpansionsBySignature.set(closure.signature, cachedProgram);
      session.semanticLastUsedSignature = closure.signature;
      return { expansion: cachedProgram, signature: closure.signature };
    }

    const previousProgram = session.semanticLastUsedSignature
      ? session.semanticExpansionsBySignature.get(session.semanticLastUsedSignature)
      : undefined;
    const nextProgram = createSemanticRuntimeExpansion(
      session.projectContext,
      closure.rootNames,
      previousProgram,
    );
    session.semanticExpansionsBySignature.set(closure.signature, nextProgram);
    session.semanticClosureRootsBySignature.set(closure.signature, closure.rootNames);
    session.semanticLastUsedSignature = closure.signature;
    trimSemanticProgramCache(session);
    return { expansion: nextProgram, signature: closure.signature };
  }

  function ensurePreparedProgramForFile(
    session: TransformProjectSession,
    fileName: string,
    sourceText: string,
  ): PreparedProgram {
    const currentProgram = session.preparedProgram;
    if (
      currentProgram &&
      preparedProgramIncludesFile(currentProgram, fileName) &&
      getPreparedOriginalText(currentProgram, fileName) === sourceText
    ) {
      return currentProgram;
    }

    if (!currentProgram || !preparedProgramIncludesFile(currentProgram, fileName)) {
      session.preparedRoots.add(fileName);
    }

    const nextProgram = createPreparedRuntimeProgram(
      session.projectContext,
      [...session.preparedRoots],
      currentProgram,
    );
    session.deferredExpansion?.dispose();
    session.deferredExpansion = undefined;
    currentProgram?.dispose(false);
    session.preparedProgram = nextProgram;
    return nextProgram;
  }

  function ensureDeferredExpansionForPreparedProgram(
    session: TransformProjectSession,
  ): DeferredRuntimeExpansion {
    const currentExpansion = session.deferredExpansion;
    const preparedProgram = session.preparedProgram;
    if (!preparedProgram) {
      throw new Error('Missing prepared program for deferred runtime expansion.');
    }
    if (currentExpansion?.preparedProgram === preparedProgram) {
      return currentExpansion;
    }

    const nextExpansion = createDeferredRuntimeExpansion(preparedProgram);
    currentExpansion?.dispose();
    session.deferredExpansion = nextExpansion;
    return nextExpansion;
  }

  function transformModuleSync(fileName: string): OnDemandTransformResult {
    const projectContext = getProjectContext(fileName, options.projectPath);
    const isSoundscriptRuntimeSource = fileName.endsWith('.sts') ||
      (projectContext?.loadedConfig.isSoundscriptSourceFile(fileName) ?? false);

    if (projectContext && isSoundscriptRuntimeSource) {
      const sourceText = ts.sys.readFile(fileName);
      if (sourceText === undefined) {
        throw new Error(`Could not read source file ${fileName}.`);
      }
      const sourceHash = ts.sys.createHash?.(sourceText) ?? sourceText;
      const session = getProjectSession(projectContext);
      const jsxImportSourceSignature = projectContext.compilerOptions.jsxImportSource ?? '';
      const preparedCacheKey =
        `${projectContext.projectPath}\u0000prepared\u0000${fileName}\u0000${sourceHash}\u0000${jsxImportSourceSignature}`;
      const cachedPrepared = soundscriptCache.get(preparedCacheKey);
      if (cachedPrepared) {
        return cachedPrepared;
      }
      const macroModeHint = session.macroModeHintsByFile.get(fileName);
      if (macroModeHint && macroModeHint.sourceHash !== sourceHash) {
        session.macroModeHintsByFile.delete(fileName);
      }
      if (!session.macroModeHintsByFile.has(fileName)) {
        const isolatedPreparedProgram = measureCheckerTiming(
          'runtime.onDemand.isolatedPreparedProbe',
          { fileName },
          () => createIsolatedPreparedRuntimeProgram(projectContext, fileName),
          { always: true },
        );
        try {
          const isolatedPreparedFile = getPreparedSourceFile(isolatedPreparedProgram, fileName);
          if (!isolatedPreparedFile) {
            throw new Error(`Missing prepared source file for ${fileName}.`);
          }

          if (isolatedPreparedFile.rewriteResult.macrosById.size === 0) {
            session.macroModeHintsByFile.delete(fileName);
            const result = transpilePreparedSourceFile(
              isolatedPreparedProgram,
              fileName,
              projectContext.projectPath,
              projectContext.compilerOptions,
              runtimeTypeScriptSupport,
            );
            soundscriptCache.set(preparedCacheKey, result);
            return result;
          }
        } finally {
          isolatedPreparedProgram.dispose(true);
        }
      }
      try {
        const preparedProgram = ensurePreparedProgramForFile(session, fileName, sourceText);
        const preparedFile = getPreparedSourceFile(preparedProgram, fileName);
        if (!preparedFile) {
          throw new Error(`Missing prepared source file for ${fileName}.`);
        }

        if (preparedFile.rewriteResult.macrosById.size === 0) {
          session.macroModeHintsByFile.delete(fileName);
          session.semanticRequiredSourceHashes.delete(fileName);
          const result = transpilePreparedSourceFile(
            preparedProgram,
            fileName,
            projectContext.projectPath,
            projectContext.compilerOptions,
            runtimeTypeScriptSupport,
          );
          soundscriptCache.set(preparedCacheKey, result);
          return result;
        }

        const knownSemanticSourceHash = session.semanticRequiredSourceHashes.get(fileName);
        if (knownSemanticSourceHash !== undefined && knownSemanticSourceHash !== sourceHash) {
          session.semanticRequiredSourceHashes.delete(fileName);
        }

        if (session.semanticRequiredSourceHashes.get(fileName) !== sourceHash) {
          const deferredExpansion = ensureDeferredExpansionForPreparedProgram(session);
          const semanticRequiredPlaceholders = deferredExpansion
            .semanticRequiredPlaceholderIdsByFile
            .get(preparedProgram.toProgramFileName(fileName));
          if (!semanticRequiredPlaceholders || semanticRequiredPlaceholders.size === 0) {
            session.macroModeHintsByFile.set(fileName, { mode: 'deferred', sourceHash });
            session.semanticRequiredSourceHashes.delete(fileName);
            return transpileDeferredExpandedSourceFile(
              deferredExpansion,
              fileName,
              projectContext.projectPath,
              projectContext.compilerOptions,
              runtimeTypeScriptSupport,
            );
          }

          session.macroModeHintsByFile.set(fileName, { mode: 'semantic', sourceHash });
          session.semanticRequiredSourceHashes.set(fileName, sourceHash);
        }

        const semanticRuntime = ensureSemanticRuntimeExpansionForFile(
          session,
          [fileName],
        );
        let emittedArtifactsForSignature = session.semanticEmittedArtifactsBySignature.get(
          semanticRuntime.signature,
        );
        if (!emittedArtifactsForSignature) {
          emittedArtifactsForSignature = new Map();
          session.semanticEmittedArtifactsBySignature.set(
            semanticRuntime.signature,
            emittedArtifactsForSignature,
          );
        }
        const cachedSemanticArtifact = emittedArtifactsForSignature.get(fileName);
        if (cachedSemanticArtifact?.sourceHash === sourceHash) {
          return cachedSemanticArtifact.result;
        }

        const semanticSourceFile = expandSemanticPlaceholdersOnDeferredSourceFile(
          ensureDeferredExpansionForPreparedProgram(session),
          semanticRuntime.expansion,
          fileName,
        );
        const result = transpileSemanticSourceFile(
          semanticSourceFile,
          fileName,
          projectContext.projectPath,
          projectContext.compilerOptions,
          runtimeTypeScriptSupport,
        );
        emittedArtifactsForSignature.set(fileName, { result, sourceHash });
        return result;
      } finally {
        projectSessionsByPath.set(projectContext.projectPath, session);
      }
    }

    if (!projectContext && fileName.endsWith('.sts')) {
      throw new Error(
        `Could not find a tsconfig.soundscript.json or tsconfig.json for ${fileName}.`,
      );
    }

    if (!isTypeScriptLikeFile(fileName)) {
      throw new Error(`Only local .sts/.ts sources can be transformed on demand: ${fileName}`);
    }

    const sourceText = ts.sys.readFile(fileName);
    if (sourceText === undefined) {
      throw new Error(`Could not read source file ${fileName}.`);
    }

    const projectPath = projectContext?.projectPath ??
      options.projectPath ??
      findNearestProjectPath(fileName) ??
      (options.workingDirectory ? join(options.workingDirectory, 'tsconfig.json') : fileName);
    const sourceHash = ts.sys.createHash?.(sourceText) ?? sourceText;
    const jsxImportSourceSignature = projectContext?.compilerOptions.jsxImportSource ?? '';
    const cacheKey =
      `${projectPath}\u0000${fileName}\u0000${sourceHash}\u0000${jsxImportSourceSignature}`;
    const cached = typeScriptCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const artifact = runtimeTypeScriptSupport !== false &&
        !runtimeRequiresJavaScriptFallback(sourceText, fileName)
      ? emitTypeScriptModuleDirect(
        fileName,
        sourceText,
        {
          moduleSpecifierMode: 'preserve',
          target: ts.ScriptTarget.ES2022,
          jsxImportSource: projectContext?.compilerOptions.jsxImportSource,
        },
      )
      : transpileTypeScriptModuleToEsm(
        fileName,
        `${fileName}.js`,
        sourceText,
        {
          module: ts.ModuleKind.ES2022,
          moduleSpecifierMode: 'preserve',
          target: ts.ScriptTarget.ES2022,
          jsxImportSource: projectContext?.compilerOptions.jsxImportSource,
        },
      );
    const result = {
      ...artifact,
      projectPath,
      transformMode: 'typescript' as const,
    };
    typeScriptCache.set(cacheKey, result);
    return result;
  }

  return {
    resolveImportSpecifier(specifier: string, importer: string): string | undefined {
      const localResolved = resolveLocalDependency(importer, specifier);
      if (localResolved) {
        return localResolved;
      }

      if (isRelativeOrAbsoluteSpecifier(specifier)) {
        return undefined;
      }

      const projectContext = getProjectContext(importer, options.projectPath);
      if (!projectContext) {
        return undefined;
      }

      const resolved = resolveSoundScriptAwareModule(
        specifier,
        importer,
        projectContext.compilerOptions,
        ts.sys,
      );
      return resolved && isTransformableRuntimeFile(resolved.resolvedFileName)
        ? toSourceFileName(resolved.resolvedFileName)
        : undefined;
    },

    shouldTransformFile(fileName: string): boolean {
      const projectContext = getProjectContext(fileName, options.projectPath);
      return projectContext?.loadedConfig.isSoundscriptSourceFile(fileName) ??
        isTransformableRuntimeFile(fileName);
    },

    transformModule(fileName: string): Promise<OnDemandTransformResult> {
      return Promise.resolve(transformModuleSync(fileName));
    },
    transformModuleSync,
  };
}
