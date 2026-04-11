import ts from 'typescript';

import {
  directoryExistsSync,
  fileExistsSync,
  readTextFileSync,
  runtimeExecPath,
} from '../platform/host.ts';
import { basename, dirname, fromFileUrl, join, normalize } from '../platform/path.ts';

// These overrides vendor the builtin-only ES2024 lib closure for the currently pinned
// TypeScript release, plus the decorator support files referenced from `lib.es5.d.ts`.
// When `deno.json` upgrades `typescript`, re-copy the matching upstream lib files
// and re-apply the sound patches in `src/bundled/typescript/lib/`.
const SOUND_STDLIB_FILE_NAMES = [
  'lib.decorators.d.ts',
  'lib.decorators.legacy.d.ts',
  'lib.dom.d.ts',
  'lib.dom.iterable.d.ts',
  'lib.dom.asynciterable.d.ts',
  'lib.es5.d.ts',
  'lib.es2015.d.ts',
  'lib.es2015.collection.d.ts',
  'lib.es2015.core.d.ts',
  'lib.es2015.generator.d.ts',
  'lib.es2015.iterable.d.ts',
  'lib.es2015.promise.d.ts',
  'lib.es2015.proxy.d.ts',
  'lib.es2015.symbol.wellknown.d.ts',
  'lib.es2015.symbol.d.ts',
  'lib.es2015.reflect.d.ts',
  'lib.es2016.d.ts',
  'lib.es2016.array.include.d.ts',
  'lib.es2017.d.ts',
  'lib.es2017.arraybuffer.d.ts',
  'lib.es2017.date.d.ts',
  'lib.es2017.object.d.ts',
  'lib.es2017.string.d.ts',
  'lib.es2017.typedarrays.d.ts',
  'lib.es2018.d.ts',
  'lib.es2018.asyncgenerator.d.ts',
  'lib.es2018.asynciterable.d.ts',
  'lib.es2018.promise.d.ts',
  'lib.es2018.regexp.d.ts',
  'lib.es2019.d.ts',
  'lib.es2019.array.d.ts',
  'lib.es2019.object.d.ts',
  'lib.es2019.string.d.ts',
  'lib.es2019.symbol.d.ts',
  'lib.es2020.d.ts',
  'lib.es2020.bigint.d.ts',
  'lib.es2020.date.d.ts',
  'lib.es2020.number.d.ts',
  'lib.es2020.promise.d.ts',
  'lib.es2020.string.d.ts',
  'lib.es2020.symbol.wellknown.d.ts',
  'lib.es2021.d.ts',
  'lib.es2021.promise.d.ts',
  'lib.es2021.string.d.ts',
  'lib.es2021.weakref.d.ts',
  'lib.es2022.d.ts',
  'lib.es2022.array.d.ts',
  'lib.es2022.error.d.ts',
  'lib.es2022.object.d.ts',
  'lib.es2022.regexp.d.ts',
  'lib.es2022.string.d.ts',
  'lib.es2023.d.ts',
  'lib.es2023.array.d.ts',
  'lib.es2023.collection.d.ts',
  'lib.es2024.d.ts',
  'lib.es2024.arraybuffer.d.ts',
  'lib.es2024.collection.d.ts',
  'lib.es2024.object.d.ts',
  'lib.es2024.promise.d.ts',
  'lib.es2024.regexp.d.ts',
  'lib.es2024.string.d.ts',
] as const;

const BUNDLED_TYPE_DIRECTIVE_ENTRY_POINTS = new Map<string, string>([
  ['node', join('node', 'index.d.ts')],
]);

const BUNDLED_TYPE_MODULE_ENTRY_POINTS = new Map<string, string>([
  ['undici-types', join('node_modules', 'undici-types', 'index.d.ts')],
]);

const cachedOverrideContentsByDirectory = new Map<string, ReadonlyMap<string, string>>();

function normalizePathForComparison(path: string): string {
  const normalizedPath = normalize(path);
  return ts.sys.useCaseSensitiveFileNames ? normalizedPath : normalizedPath.toLowerCase();
}

function directoryExists(path: string): boolean {
  return directoryExistsSync(path);
}

export function resolveOverrideDirectory(
  {
    importMetaUrl = import.meta.url,
    execPath = runtimeExecPath(),
  }: {
    importMetaUrl?: string;
    execPath?: string;
  } = {},
): string {
  const candidateDirectories = [
    join(dirname(fromFileUrl(importMetaUrl)), 'typescript', 'lib'),
    join(dirname(execPath), '..', 'src', 'bundled', 'typescript', 'lib'),
  ];

  for (const candidateDirectory of candidateDirectories) {
    if (directoryExists(candidateDirectory)) {
      return candidateDirectory;
    }
  }

  return candidateDirectories[0];
}

export function resolveBundledTypesDirectory(
  {
    importMetaUrl = import.meta.url,
    execPath = runtimeExecPath(),
  }: {
    importMetaUrl?: string;
    execPath?: string;
  } = {},
): string {
  const candidateDirectories = [
    join(dirname(fromFileUrl(importMetaUrl)), 'typescript', 'types'),
    join(dirname(execPath), '..', 'src', 'bundled', 'typescript', 'types'),
  ];

  for (const candidateDirectory of candidateDirectories) {
    if (directoryExists(candidateDirectory)) {
      return candidateDirectory;
    }
  }

  return candidateDirectories[0];
}

function loadOverrideContents(): ReadonlyMap<string, string> {
  const overrideDirectory = resolveOverrideDirectory();
  const cached = cachedOverrideContentsByDirectory.get(overrideDirectory);
  if (cached) {
    return cached;
  }
  const entries = new Map<string, string>();

  for (const fileName of SOUND_STDLIB_FILE_NAMES) {
    const filePath = join(overrideDirectory, fileName);
    entries.set(fileName, readTextFileSync(filePath));
  }

  cachedOverrideContentsByDirectory.set(overrideDirectory, entries);
  return entries;
}

function shouldUseOverride(
  fileName: string,
  normalizedDefaultLibDirectory: string,
  overrideContents: ReadonlyMap<string, string>,
): string | undefined {
  const baseName = basename(fileName);
  const overrideText = overrideContents.get(baseName);
  if (!overrideText) {
    return undefined;
  }

  const normalizedFileName = normalizePathForComparison(fileName);
  if (!normalizedFileName.startsWith(normalizedDefaultLibDirectory)) {
    return undefined;
  }

  return overrideText;
}

function getTypeDirectiveName(typeDirectiveName: string | ts.FileReference): string {
  return typeof typeDirectiveName === 'string' ? typeDirectiveName : typeDirectiveName.fileName;
}

function resolveBundledTypeReferenceDirective(
  typeDirectiveName: string,
): ts.ResolvedTypeReferenceDirective | undefined {
  const relativeEntryPoint = BUNDLED_TYPE_DIRECTIVE_ENTRY_POINTS.get(typeDirectiveName);
  if (!relativeEntryPoint) {
    return undefined;
  }

  const resolvedFileName = join(resolveBundledTypesDirectory(), relativeEntryPoint);
  if (!fileExistsSync(resolvedFileName)) {
    return undefined;
  }

  return {
    isExternalLibraryImport: true,
    packageId: {
      name: typeDirectiveName,
      subModuleName: '',
      version: 'sound-bundled',
    },
    primary: true,
    resolvedFileName,
  };
}

function resolveBundledTypeModule(moduleName: string): ts.ResolvedModuleFull | undefined {
  const relativeEntryPoint = BUNDLED_TYPE_MODULE_ENTRY_POINTS.get(moduleName);
  if (!relativeEntryPoint) {
    return undefined;
  }

  const resolvedFileName = join(resolveBundledTypesDirectory(), relativeEntryPoint);
  if (!fileExistsSync(resolvedFileName)) {
    return undefined;
  }

  return {
    extension: ts.Extension.Dts,
    isExternalLibraryImport: true,
    packageId: {
      name: moduleName,
      subModuleName: '',
      version: 'sound-bundled',
    },
    resolvedFileName,
  };
}

function createModuleResolutionHost(baseHost: ts.CompilerHost): ts.ModuleResolutionHost {
  return {
    directoryExists: baseHost.directoryExists?.bind(baseHost),
    fileExists: baseHost.fileExists.bind(baseHost),
    getCurrentDirectory: baseHost.getCurrentDirectory?.bind(baseHost) ??
      (() => ts.sys.getCurrentDirectory()),
    getDirectories: baseHost.getDirectories?.bind(baseHost),
    readFile: baseHost.readFile.bind(baseHost),
    realpath: baseHost.realpath?.bind(baseHost),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
}

export function createSoundStdlibCompilerHost(
  options: ts.CompilerOptions,
  currentDirectory?: string,
): ts.CompilerHost {
  const baseHost = ts.createCompilerHost(options, true);
  const overrideContents = loadOverrideContents();
  const normalizedDefaultLibDirectory = normalizePathForComparison(
    dirname(ts.getDefaultLibFilePath(options)),
  );

  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists(fileName) {
      return shouldUseOverride(fileName, normalizedDefaultLibDirectory, overrideContents) !==
          undefined ||
        baseHost.fileExists(fileName);
    },
    getCurrentDirectory() {
      return currentDirectory ?? baseHost.getCurrentDirectory();
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const overrideText = shouldUseOverride(
        fileName,
        normalizedDefaultLibDirectory,
        overrideContents,
      );
      if (overrideText !== undefined) {
        return ts.createSourceFile(fileName, overrideText, languageVersion, true);
      }

      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    readFile(fileName) {
      return shouldUseOverride(fileName, normalizedDefaultLibDirectory, overrideContents) ??
        baseHost.readFile(fileName);
    },
    resolveModuleNames(
      moduleNames,
      containingFile,
      reusedNames,
      redirectedReference,
      compilerOptions,
      containingSourceFile,
    ) {
      const delegated = baseHost.resolveModuleNames?.(
        moduleNames,
        containingFile,
        reusedNames,
        redirectedReference,
        compilerOptions,
        containingSourceFile,
      );
      const fallbackHost = createModuleResolutionHost(baseHost);

      return moduleNames.map((moduleName, index) => {
        const bundledResolution = resolveBundledTypeModule(moduleName);
        if (bundledResolution) {
          return bundledResolution;
        }
        if (delegated?.[index]) {
          return delegated[index];
        }
        return ts.resolveModuleName(
          moduleName,
          containingFile,
          compilerOptions ?? options,
          fallbackHost,
          undefined,
          redirectedReference,
        ).resolvedModule;
      });
    },
    resolveTypeReferenceDirectives(
      typeReferenceDirectiveNames,
      containingFile,
      redirectedReference,
      compilerOptions,
      containingFileMode,
    ) {
      return typeReferenceDirectiveNames.map((typeReferenceDirectiveName) => {
        const bundledResolution = resolveBundledTypeReferenceDirective(
          getTypeDirectiveName(typeReferenceDirectiveName),
        );
        if (bundledResolution) {
          return bundledResolution;
        }

        return ts.resolveTypeReferenceDirective(
          getTypeDirectiveName(typeReferenceDirectiveName),
          containingFile,
          compilerOptions,
          host,
          redirectedReference,
          undefined,
          containingFileMode,
        ).resolvedTypeReferenceDirective;
      });
    },
  };

  return host;
}
