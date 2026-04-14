import ts from 'typescript';

import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import { loadConfig, type LoadedConfig } from '../project/config.ts';
import { createBuiltinExpandedProgram } from '../frontend/builtin_macro_support.ts';
import { dirname, join } from '../platform/path.ts';
import { toSourceFileName } from '../frontend/project_frontend.ts';
import { resolveSoundScriptAwareModule } from '../project/soundscript_packages.ts';
import { type RuntimeTransformArtifact, transpileTypeScriptModuleToEsm } from './transform.ts';

const PROJECT_CONFIG_CANDIDATES = ['tsconfig.soundscript.json', 'tsconfig.json'] as const;
const LOCAL_CODE_EXTENSIONS = ['.sts', '.ts', '.tsx', '.mts', '.cts', '.jsx'] as const;

interface TransformProjectContext {
  readonly compilerOptions: ts.CompilerOptions;
  readonly loadedConfig: LoadedConfig;
  readonly projectPath: string;
}

export interface OnDemandTransformResult extends RuntimeTransformArtifact {
  projectPath: string;
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

function getProjectContext(
  fileName: string,
  explicitProjectPath: string | undefined,
): TransformProjectContext | undefined {
  const projectPath = explicitProjectPath ?? findNearestProjectPath(fileName);
  if (!projectPath) {
    return undefined;
  }

  const loadedConfig = loadConfig(projectPath);
  return {
    compilerOptions: loadedConfig.commandLine.options,
    loadedConfig,
    projectPath,
  };
}

function createExpandedRuntimeProgram(
  projectContext: TransformProjectContext,
  rootNames: readonly string[],
) {
  return createBuiltinExpandedProgram({
    baseHost: createSoundStdlibCompilerHost(
      projectContext.loadedConfig.commandLine.options,
      dirname(projectContext.projectPath),
    ),
    configuredSoundscriptFileNames: projectContext.loadedConfig.soundscriptConfiguredFileNames,
    options: projectContext.loadedConfig.commandLine.options,
    projectReferences: projectContext.loadedConfig.commandLine.projectReferences,
    rootNames,
    runtime: projectContext.loadedConfig.runtime,
  });
}

export function createOnDemandTransformer(
  options: OnDemandTransformerOptions = {},
): SyncOnDemandTransformer {
  const soundscriptCache = new Map<string, OnDemandTransformResult>();
  const typeScriptCache = new Map<string, OnDemandTransformResult>();

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
      const fullCacheKey =
        `${projectContext.projectPath}\u0000full\u0000${fileName}\u0000${sourceHash}`;
      const cachedFull = soundscriptCache.get(fullCacheKey);
      if (cachedFull) {
        return cachedFull;
      }
      const expandedProgram = createExpandedRuntimeProgram(projectContext, [fileName]);
      try {
        const transpileExpanded = (): OnDemandTransformResult => {
          const programFileName = expandedProgram.preparedProgram.toProgramFileName(fileName);
          const sourceFile = expandedProgram.program.getSourceFile(programFileName);
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
            projectPath: projectContext.projectPath,
          };
        };

        const result = transpileExpanded();
        soundscriptCache.set(fullCacheKey, result);
        return result;
      } finally {
        expandedProgram.dispose();
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
