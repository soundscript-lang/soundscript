import ts from 'typescript';

import { directoryExistsSync, readTextFileSync, runtimeExecPath } from '../platform/host.ts';
import { basename, dirname, fromFileUrl, join, normalize } from '../platform/path.ts';

// These overrides vendor the builtin-only ES2024 lib closure for the currently pinned
// TypeScript release, plus the decorator support files referenced from `lib.es5.d.ts`.
// When `deno.json` upgrades `typescript`, re-copy the matching upstream lib files
// and re-apply the sound patches in `src/bundled/sound-libs/`.
const SOUND_STDLIB_FILE_NAMES = [
  'lib.decorators.d.ts',
  'lib.decorators.legacy.d.ts',
  'lib.dom.d.ts',
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
    join(dirname(fromFileUrl(importMetaUrl)), 'sound-libs'),
    join(dirname(execPath), '..', 'src', 'bundled', 'sound-libs'),
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

export function createSoundStdlibCompilerHost(
  options: ts.CompilerOptions,
  currentDirectory?: string,
): ts.CompilerHost {
  const baseHost = ts.createCompilerHost(options, true);
  const overrideContents = loadOverrideContents();
  const normalizedDefaultLibDirectory = normalizePathForComparison(
    dirname(ts.getDefaultLibFilePath(options)),
  );

  return {
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
  };
}
