import ts from 'typescript';

import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import { loadConfig, type LoadedConfig } from '../project/config.ts';
import {
  type BuiltinExpandedProgram,
  createBuiltinExpandedProgram,
  getAlwaysAvailableBuiltinMacroDefinitions,
  getAlwaysAvailableBuiltinMacroExports,
  getBuiltinMacroDefinitionsBySpecifier,
  getBuiltinMacroExportsBySpecifier,
  getBuiltinMacroFactoriesBySpecifier,
  withBuiltinMacroSupport,
} from '../frontend/builtin_macro_support.ts';
import { SemanticMacroExpansionRequiredError } from '../frontend/macro_errors.ts';
import {
  createProjectMacroEnvironment,
  type ProjectMacroEnvironment,
} from '../frontend/project_macro_support.ts';
import { dirname, join } from '../platform/path.ts';
import {
  createPreparedProgram,
  type PreparedProgram,
  toSourceFileName,
} from '../frontend/project_frontend.ts';
import { resolveSoundScriptAwareModule } from '../project/soundscript_packages.ts';
import {
  type RuntimeTransformArtifact,
  transpilePreparedSoundscriptModuleToEsm,
  transpileTypeScriptModuleToEsm,
} from './transform.ts';

const PROJECT_CONFIG_CANDIDATES = ['tsconfig.soundscript.json', 'tsconfig.json'] as const;
const LOCAL_CODE_EXTENSIONS = ['.sts', '.ts', '.tsx', '.mts', '.cts', '.jsx'] as const;

interface TransformProjectContext {
  readonly compilerOptions: ts.CompilerOptions;
  readonly loadedConfig: LoadedConfig;
  readonly projectPath: string;
}

interface TransformProjectSession {
  deferredExpansion?: DeferredRuntimeExpansion;
  expandedProgram?: BuiltinExpandedProgram;
  preparedProgram?: PreparedProgram;
  projectContext: TransformProjectContext;
  requestedRuntimeRoots: Set<string>;
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

function preparedProgramIncludesFile(
  preparedProgram: PreparedProgram,
  fileName: string,
): boolean {
  return preparedProgram.program.getSourceFile(preparedProgram.toProgramFileName(fileName)) !== undefined;
}

function getExpandedProgramSourceFile(
  expandedProgram: BuiltinExpandedProgram,
  fileName: string,
): ts.SourceFile | undefined {
  return expandedProgram.program.getSourceFile(
    expandedProgram.preparedProgram.toProgramFileName(fileName),
  );
}

function transpileExpandedSourceFile(
  expandedProgram: BuiltinExpandedProgram,
  fileName: string,
  projectPath: string,
): OnDemandTransformResult {
  const sourceFile = getExpandedProgramSourceFile(expandedProgram, fileName);
  if (!sourceFile) {
    throw new Error(`Missing expanded source file for ${fileName}.`);
  }

  const artifact = transpileTypeScriptModuleToEsm(
    fileName,
    `${fileName}.js`,
    ts.createPrinter().printFile(sourceFile),
    {
      module: ts.ModuleKind.ES2022,
      moduleSpecifierMode: 'preserve',
      target: ts.ScriptTarget.ES2022,
    },
  );
  return {
    ...artifact,
    projectPath,
    transformMode: 'soundscript-semantic-macro',
  };
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

function createExpandedRuntimeProgram(
  projectContext: TransformProjectContext,
  rootNames: readonly string[],
  previousProgram?: BuiltinExpandedProgram,
): BuiltinExpandedProgram {
  return createBuiltinExpandedProgram({
    baseHost: createSoundStdlibCompilerHost(
      projectContext.loadedConfig.frontierCommandLine.options,
      dirname(projectContext.projectPath),
    ),
    configuredSoundscriptFileNames: projectContext.loadedConfig.frontierConfiguredFileNames,
    oldProgram: previousProgram?.preparedProgram.program,
    options: projectContext.loadedConfig.frontierCommandLine.options,
    projectReferences: projectContext.loadedConfig.frontierCommandLine.projectReferences,
    reusableCompilerHostState: previousProgram?.preparedProgram.preparedHost.reuseState,
    rootNames,
    runtime: projectContext.loadedConfig.runtime,
  });
}

interface DeferredRuntimeExpansion {
  expandedFiles: ReadonlyMap<string, ts.SourceFile>;
  macroEnvironment: ProjectMacroEnvironment;
  preparedProgram: PreparedProgram;
  dispose(): void;
}

function createPreparedRuntimeProgram(
  projectContext: TransformProjectContext,
  rootNames: readonly string[],
  previousProgram?: PreparedProgram,
): PreparedProgram {
  return createPreparedProgram(withBuiltinMacroSupport({
    baseHost: createSoundStdlibCompilerHost(
      projectContext.loadedConfig.frontierCommandLine.options,
      dirname(projectContext.projectPath),
    ),
    configuredSoundscriptFileNames: projectContext.loadedConfig.frontierConfiguredFileNames,
    oldProgram: previousProgram?.program,
    options: projectContext.loadedConfig.frontierCommandLine.options,
    projectReferences: projectContext.loadedConfig.frontierCommandLine.projectReferences,
    reusableCompilerHostState: previousProgram?.preparedHost.reuseState,
    rootNames,
    runtime: projectContext.loadedConfig.runtime,
  }));
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

function createDeferredRuntimeExpansion(
  preparedProgram: PreparedProgram,
): DeferredRuntimeExpansion {
  const macroEnvironment = createProjectMacroEnvironment(
    preparedProgram,
    getBuiltinMacroDefinitionsBySpecifier(),
    getBuiltinMacroExportsBySpecifier(undefined, { deferToSemanticExpansion: true }),
    getBuiltinMacroFactoriesBySpecifier(),
    getAlwaysAvailableBuiltinMacroDefinitions(),
    getAlwaysAvailableBuiltinMacroExports(undefined, { deferToSemanticExpansion: true }),
    { deferToSemanticExpansion: true },
  );
  try {
    const expandedFiles = macroEnvironment.expandPreparedProgram();
    return {
      expandedFiles,
      macroEnvironment,
      preparedProgram,
      dispose(): void {
        macroEnvironment.dispose();
      },
    };
  } catch (error) {
    macroEnvironment.dispose();
    throw error;
  }
}

function transpilePreparedSourceFile(
  preparedProgram: PreparedProgram,
  fileName: string,
  projectPath: string,
): OnDemandTransformResult {
  const preparedFile = getPreparedSourceFile(preparedProgram, fileName);
  if (!preparedFile) {
    throw new Error(`Missing prepared source file for ${fileName}.`);
  }

  const artifact = transpilePreparedSoundscriptModuleToEsm(
    fileName,
    `${fileName}.js`,
    preparedFile,
    {
      module: ts.ModuleKind.ES2022,
      moduleSpecifierMode: 'preserve',
      target: ts.ScriptTarget.ES2022,
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
): OnDemandTransformResult {
  const sourceFile = expansion.expandedFiles.get(
    expansion.preparedProgram.toProgramFileName(fileName),
  );
  if (!sourceFile) {
    throw new Error(`Missing deferred expanded source file for ${fileName}.`);
  }

  const artifact = transpileTypeScriptModuleToEsm(
    fileName,
    `${fileName}.js`,
    ts.createPrinter().printFile(sourceFile),
    {
      module: ts.ModuleKind.ES2022,
      moduleSpecifierMode: 'preserve',
      target: ts.ScriptTarget.ES2022,
    },
  );
  return {
    ...artifact,
    projectPath,
    transformMode: 'soundscript-deferred-macro',
  };
}

export function createOnDemandTransformer(
  options: OnDemandTransformerOptions = {},
): SyncOnDemandTransformer {
  const soundscriptCache = new Map<string, OnDemandTransformResult>();
  const typeScriptCache = new Map<string, OnDemandTransformResult>();
  const projectContextByPath = new Map<string, TransformProjectContext>();
  const projectPathByFileName = new Map<string, string | undefined>();
  const projectSessionsByPath = new Map<string, TransformProjectSession>();

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
      projectContext,
      requestedRuntimeRoots: new Set(),
    };
    projectSessionsByPath.set(projectContext.projectPath, session);
    return session;
  }

  function ensureExpandedProgramForFile(
    session: TransformProjectSession,
    fileName: string,
    sourceText: string,
  ): BuiltinExpandedProgram {
    const currentProgram = session.expandedProgram;
    const currentSourceFile = currentProgram && getExpandedProgramSourceFile(currentProgram, fileName);
    if (
      currentProgram &&
      currentSourceFile &&
      getPreparedOriginalText(currentProgram.preparedProgram, fileName) === sourceText
    ) {
      return currentProgram;
    }

    if (!currentSourceFile) {
      session.requestedRuntimeRoots.add(fileName);
    }

    const nextProgram = createExpandedRuntimeProgram(
      session.projectContext,
      [...session.requestedRuntimeRoots],
      currentProgram,
    );
    session.expandedProgram?.dispose();
    session.expandedProgram = nextProgram;
    return nextProgram;
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
      session.requestedRuntimeRoots.add(fileName);
    }

    const nextProgram = createPreparedRuntimeProgram(
      session.projectContext,
      [...session.requestedRuntimeRoots],
      currentProgram,
    );
    session.deferredExpansion?.dispose();
    session.deferredExpansion = undefined;
    session.expandedProgram?.dispose();
    session.expandedProgram = undefined;
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
      const preparedCacheKey =
        `${projectContext.projectPath}\u0000prepared\u0000${fileName}\u0000${sourceHash}`;
      const cachedPrepared = soundscriptCache.get(preparedCacheKey);
      if (cachedPrepared) {
        return cachedPrepared;
      }
      const isolatedPreparedProgram = createIsolatedPreparedRuntimeProgram(projectContext, fileName);
      try {
        const isolatedPreparedFile = getPreparedSourceFile(isolatedPreparedProgram, fileName);
        if (!isolatedPreparedFile) {
          throw new Error(`Missing prepared source file for ${fileName}.`);
        }

        if (isolatedPreparedFile.rewriteResult.macrosById.size === 0) {
          const result = transpilePreparedSourceFile(
            isolatedPreparedProgram,
            fileName,
            projectContext.projectPath,
          );
          soundscriptCache.set(preparedCacheKey, result);
          return result;
        }
      } finally {
        isolatedPreparedProgram.dispose(true);
      }
      try {
        const preparedProgram = ensurePreparedProgramForFile(session, fileName, sourceText);
        const preparedFile = getPreparedSourceFile(preparedProgram, fileName);
        if (!preparedFile) {
          throw new Error(`Missing prepared source file for ${fileName}.`);
        }

        if (preparedFile.rewriteResult.macrosById.size === 0) {
          const result = transpilePreparedSourceFile(
            preparedProgram,
            fileName,
            projectContext.projectPath,
          );
          soundscriptCache.set(preparedCacheKey, result);
          return result;
        }

        try {
          const deferredExpansion = ensureDeferredExpansionForPreparedProgram(session);
          return transpileDeferredExpandedSourceFile(
            deferredExpansion,
            fileName,
            projectContext.projectPath,
          );
        } catch (error) {
          if (!(error instanceof SemanticMacroExpansionRequiredError)) {
            throw error;
          }
        }

        const expandedProgram = ensureExpandedProgramForFile(session, fileName, sourceText);
        return transpileExpandedSourceFile(
          expandedProgram,
          fileName,
          projectContext.projectPath,
        );
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
    const cacheKey = `${projectPath}\u0000${fileName}\u0000${sourceHash}`;
    const cached = typeScriptCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const artifact = transpileTypeScriptModuleToEsm(
      fileName,
      `${fileName}.js`,
      sourceText,
      {
        module: ts.ModuleKind.ES2022,
        moduleSpecifierMode: 'preserve',
        target: ts.ScriptTarget.ES2022,
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
