import ts from 'typescript';

import {
  STS_ASYNC_MODULE_SPECIFIER,
  STS_CODEC_MODULE_SPECIFIER,
  STS_COMPARE_MODULE_SPECIFIER,
  STS_DECODE_MODULE_SPECIFIER,
  STS_DERIVE_MODULE_SPECIFIER,
  STS_ENCODE_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_COMPONENT_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_CSS_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_DEBUG_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_GRAPHQL_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_SQL_MODULE_SPECIFIER,
  STS_FAILURES_MODULE_SPECIFIER,
  STS_FETCH_MODULE_SPECIFIER,
  STS_HASH_MODULE_SPECIFIER,
  STS_HKT_MODULE_SPECIFIER,
  STS_JSON_MODULE_SPECIFIER,
  STS_METADATA_MODULE_SPECIFIER,
  STS_MATCH_MODULE_SPECIFIER,
  STS_NUMERICS_MODULE_SPECIFIER,
  STS_PRELUDE_MODULE_SPECIFIER,
  STS_RANDOM_MODULE_SPECIFIER,
  STS_RESULT_MODULE_SPECIFIER,
  STS_TEXT_MODULE_SPECIFIER,
  STS_THUNK_MODULE_SPECIFIER,
  STS_TYPECLASSES_MODULE_SPECIFIER,
  STS_URL_MODULE_SPECIFIER,
  STS_VALUE_MODULE_SPECIFIER,
} from '../soundscript_runtime_specifiers.ts';
import { fileExistsSync, readTextFileSync, runtimeExecPath } from '../platform/host.ts';
import { basename, dirname, fromFileUrl, join } from '../platform/path.ts';

export const STDLIB_MODULE_SPECIFIER = STS_PRELUDE_MODULE_SPECIFIER;
export const HKT_STDLIB_MODULE_SPECIFIER = STS_HKT_MODULE_SPECIFIER;
export const TYPECLASSES_STDLIB_MODULE_SPECIFIER = STS_TYPECLASSES_MODULE_SPECIFIER;
export const RESULT_STDLIB_MODULE_SPECIFIER = STS_RESULT_MODULE_SPECIFIER;
export const VALUE_STDLIB_MODULE_SPECIFIER = STS_VALUE_MODULE_SPECIFIER;
export const MATCH_STDLIB_MODULE_SPECIFIER = STS_MATCH_MODULE_SPECIFIER;
export const FAILURES_STDLIB_MODULE_SPECIFIER = STS_FAILURES_MODULE_SPECIFIER;
export const URL_STDLIB_MODULE_SPECIFIER = STS_URL_MODULE_SPECIFIER;
export const FETCH_STDLIB_MODULE_SPECIFIER = STS_FETCH_MODULE_SPECIFIER;
export const TEXT_STDLIB_MODULE_SPECIFIER = STS_TEXT_MODULE_SPECIFIER;
export const RANDOM_STDLIB_MODULE_SPECIFIER = STS_RANDOM_MODULE_SPECIFIER;
export const JSON_STDLIB_MODULE_SPECIFIER = STS_JSON_MODULE_SPECIFIER;
export const METADATA_STDLIB_MODULE_SPECIFIER = STS_METADATA_MODULE_SPECIFIER;
export const COMPARE_STDLIB_MODULE_SPECIFIER = STS_COMPARE_MODULE_SPECIFIER;
export const HASH_STDLIB_MODULE_SPECIFIER = STS_HASH_MODULE_SPECIFIER;
export const DERIVE_STDLIB_MODULE_SPECIFIER = STS_DERIVE_MODULE_SPECIFIER;
export const DECODE_STDLIB_MODULE_SPECIFIER = STS_DECODE_MODULE_SPECIFIER;
export const ENCODE_STDLIB_MODULE_SPECIFIER = STS_ENCODE_MODULE_SPECIFIER;
export const CODEC_STDLIB_MODULE_SPECIFIER = STS_CODEC_MODULE_SPECIFIER;
export const ASYNC_STDLIB_MODULE_SPECIFIER = STS_ASYNC_MODULE_SPECIFIER;
export const THUNK_STDLIB_MODULE_SPECIFIER = STS_THUNK_MODULE_SPECIFIER;
export const SQL_STDLIB_MODULE_SPECIFIER = STS_EXPERIMENTAL_SQL_MODULE_SPECIFIER;
export const CSS_STDLIB_MODULE_SPECIFIER = STS_EXPERIMENTAL_CSS_MODULE_SPECIFIER;
export const GRAPHQL_STDLIB_MODULE_SPECIFIER = STS_EXPERIMENTAL_GRAPHQL_MODULE_SPECIFIER;
export const COMPONENT_STDLIB_MODULE_SPECIFIER = STS_EXPERIMENTAL_COMPONENT_MODULE_SPECIFIER;
export const DEBUG_STDLIB_MODULE_SPECIFIER = STS_EXPERIMENTAL_DEBUG_MODULE_SPECIFIER;
export const NUMERICS_STDLIB_MODULE_SPECIFIER = STS_NUMERICS_MODULE_SPECIFIER;

export const STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/index.d.ts', import.meta.url),
);
export const HKT_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/hkt.d.ts', import.meta.url),
);
export const TYPECLASSES_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/typeclasses.d.ts', import.meta.url),
);
export const RESULT_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/result.d.ts', import.meta.url),
);
export const VALUE_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/value.d.ts', import.meta.url),
);
export const MATCH_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/match.d.ts', import.meta.url),
);
export const FAILURES_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/failures.d.ts', import.meta.url),
);
export const URL_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/url.d.ts', import.meta.url),
);
export const FETCH_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/fetch.d.ts', import.meta.url),
);
export const TEXT_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/text.d.ts', import.meta.url),
);
export const RANDOM_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/random.d.ts', import.meta.url),
);
export const JSON_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/json.d.ts', import.meta.url),
);
export const METADATA_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/metadata.d.ts', import.meta.url),
);
export const COMPARE_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/compare.d.ts', import.meta.url),
);
export const HASH_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/hash.d.ts', import.meta.url),
);
export const DERIVE_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/derive.d.ts', import.meta.url),
);
export const DECODE_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/decode.d.ts', import.meta.url),
);
export const ENCODE_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/encode.d.ts', import.meta.url),
);
export const CODEC_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/codec.d.ts', import.meta.url),
);
export const ASYNC_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/async.d.ts', import.meta.url),
);
export const THUNK_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/thunk.d.ts', import.meta.url),
);
export const SQL_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/sql.d.ts', import.meta.url),
);
export const CSS_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/css.d.ts', import.meta.url),
);
export const GRAPHQL_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/graphql.d.ts', import.meta.url),
);
export const COMPONENT_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/component.d.ts', import.meta.url),
);
export const DEBUG_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/debug.d.ts', import.meta.url),
);
export const NUMERICS_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/numerics.d.ts', import.meta.url),
);

interface MacroStdlibDeclarationGlobal {
  __STS_STDLIB_DECLARATION_TEXTS__?: Readonly<Record<string, string>>;
}

function fileExists(path: string): boolean {
  return fileExistsSync(path);
}

export function resolveStdlibDeclarationRuntimePath(
  sourceFilePath: string,
  {
    execPath = runtimeExecPath(),
  }: {
    execPath?: string;
  } = {},
): string {
  const fileName = basename(sourceFilePath);
  const candidatePaths = [
    sourceFilePath,
    join(dirname(execPath), '..', 'src', 'stdlib', fileName),
  ];

  for (const candidatePath of candidatePaths) {
    if (fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  return sourceFilePath;
}

function readStdlibDeclarationText(sourceFilePath: string): string {
  const resolvedPath = resolveStdlibDeclarationRuntimePath(sourceFilePath);
  const overrideTexts = (globalThis as typeof globalThis & MacroStdlibDeclarationGlobal)
    .__STS_STDLIB_DECLARATION_TEXTS__;
  const overrideText = overrideTexts?.[sourceFilePath] ??
    overrideTexts?.[resolvedPath] ??
    overrideTexts?.[basename(sourceFilePath)];
  if (overrideText !== undefined) {
    return overrideText;
  }
  return readTextFileSync(resolvedPath);
}

export const STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(STDLIB_DECLARATION_FILE);
export const HKT_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(HKT_STDLIB_DECLARATION_FILE);
export const TYPECLASSES_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  TYPECLASSES_STDLIB_DECLARATION_FILE,
);
export const RESULT_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  RESULT_STDLIB_DECLARATION_FILE,
);
export const VALUE_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  VALUE_STDLIB_DECLARATION_FILE,
);
export const MATCH_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  MATCH_STDLIB_DECLARATION_FILE,
);
export const FAILURES_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  FAILURES_STDLIB_DECLARATION_FILE,
);
export const URL_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(URL_STDLIB_DECLARATION_FILE);
export const FETCH_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  FETCH_STDLIB_DECLARATION_FILE,
);
export const TEXT_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(TEXT_STDLIB_DECLARATION_FILE);
export const RANDOM_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  RANDOM_STDLIB_DECLARATION_FILE,
);
export const JSON_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(JSON_STDLIB_DECLARATION_FILE);
export const METADATA_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  METADATA_STDLIB_DECLARATION_FILE,
);
export const COMPARE_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  COMPARE_STDLIB_DECLARATION_FILE,
);
export const HASH_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(HASH_STDLIB_DECLARATION_FILE);
export const DERIVE_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  DERIVE_STDLIB_DECLARATION_FILE,
);
export const DECODE_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  DECODE_STDLIB_DECLARATION_FILE,
);
export const ENCODE_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  ENCODE_STDLIB_DECLARATION_FILE,
);
export const CODEC_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  CODEC_STDLIB_DECLARATION_FILE,
);
export const ASYNC_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  ASYNC_STDLIB_DECLARATION_FILE,
);
export const THUNK_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  THUNK_STDLIB_DECLARATION_FILE,
);
export const SQL_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(SQL_STDLIB_DECLARATION_FILE);
export const CSS_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(CSS_STDLIB_DECLARATION_FILE);
export const GRAPHQL_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  GRAPHQL_STDLIB_DECLARATION_FILE,
);
export const COMPONENT_STDLIB_DECLARATION_TEXT = fileExists(COMPONENT_STDLIB_DECLARATION_FILE)
  ? readStdlibDeclarationText(COMPONENT_STDLIB_DECLARATION_FILE)
  : undefined;
export const DEBUG_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  DEBUG_STDLIB_DECLARATION_FILE,
);
export const NUMERICS_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  NUMERICS_STDLIB_DECLARATION_FILE,
);

const STDLIB_DECLARATION_FILES = new Map<string, string>([
  [STDLIB_MODULE_SPECIFIER, STDLIB_DECLARATION_FILE],
  [HKT_STDLIB_MODULE_SPECIFIER, HKT_STDLIB_DECLARATION_FILE],
  [TYPECLASSES_STDLIB_MODULE_SPECIFIER, TYPECLASSES_STDLIB_DECLARATION_FILE],
  [RESULT_STDLIB_MODULE_SPECIFIER, RESULT_STDLIB_DECLARATION_FILE],
  [VALUE_STDLIB_MODULE_SPECIFIER, VALUE_STDLIB_DECLARATION_FILE],
  [MATCH_STDLIB_MODULE_SPECIFIER, MATCH_STDLIB_DECLARATION_FILE],
  [FAILURES_STDLIB_MODULE_SPECIFIER, FAILURES_STDLIB_DECLARATION_FILE],
  [URL_STDLIB_MODULE_SPECIFIER, URL_STDLIB_DECLARATION_FILE],
  [FETCH_STDLIB_MODULE_SPECIFIER, FETCH_STDLIB_DECLARATION_FILE],
  [TEXT_STDLIB_MODULE_SPECIFIER, TEXT_STDLIB_DECLARATION_FILE],
  [RANDOM_STDLIB_MODULE_SPECIFIER, RANDOM_STDLIB_DECLARATION_FILE],
  [JSON_STDLIB_MODULE_SPECIFIER, JSON_STDLIB_DECLARATION_FILE],
  [METADATA_STDLIB_MODULE_SPECIFIER, METADATA_STDLIB_DECLARATION_FILE],
  [COMPARE_STDLIB_MODULE_SPECIFIER, COMPARE_STDLIB_DECLARATION_FILE],
  [HASH_STDLIB_MODULE_SPECIFIER, HASH_STDLIB_DECLARATION_FILE],
  [DERIVE_STDLIB_MODULE_SPECIFIER, DERIVE_STDLIB_DECLARATION_FILE],
  [DECODE_STDLIB_MODULE_SPECIFIER, DECODE_STDLIB_DECLARATION_FILE],
  [ENCODE_STDLIB_MODULE_SPECIFIER, ENCODE_STDLIB_DECLARATION_FILE],
  [CODEC_STDLIB_MODULE_SPECIFIER, CODEC_STDLIB_DECLARATION_FILE],
  [ASYNC_STDLIB_MODULE_SPECIFIER, ASYNC_STDLIB_DECLARATION_FILE],
  [THUNK_STDLIB_MODULE_SPECIFIER, THUNK_STDLIB_DECLARATION_FILE],
  [SQL_STDLIB_MODULE_SPECIFIER, SQL_STDLIB_DECLARATION_FILE],
  [CSS_STDLIB_MODULE_SPECIFIER, CSS_STDLIB_DECLARATION_FILE],
  [GRAPHQL_STDLIB_MODULE_SPECIFIER, GRAPHQL_STDLIB_DECLARATION_FILE],
  ...(
    COMPONENT_STDLIB_DECLARATION_TEXT === undefined
      ? []
      : [[COMPONENT_STDLIB_MODULE_SPECIFIER, COMPONENT_STDLIB_DECLARATION_FILE] as const]
  ),
  [DEBUG_STDLIB_MODULE_SPECIFIER, DEBUG_STDLIB_DECLARATION_FILE],
  [NUMERICS_STDLIB_MODULE_SPECIFIER, NUMERICS_STDLIB_DECLARATION_FILE],
]);
const STDLIB_DECLARATION_FILE_SET = new Set(STDLIB_DECLARATION_FILES.values());
const STDLIB_DECLARATION_TEXTS = new Map<string, string>([
  [STDLIB_DECLARATION_FILE, STDLIB_DECLARATION_TEXT],
  [HKT_STDLIB_DECLARATION_FILE, HKT_STDLIB_DECLARATION_TEXT],
  [TYPECLASSES_STDLIB_DECLARATION_FILE, TYPECLASSES_STDLIB_DECLARATION_TEXT],
  [RESULT_STDLIB_DECLARATION_FILE, RESULT_STDLIB_DECLARATION_TEXT],
  [VALUE_STDLIB_DECLARATION_FILE, VALUE_STDLIB_DECLARATION_TEXT],
  [MATCH_STDLIB_DECLARATION_FILE, MATCH_STDLIB_DECLARATION_TEXT],
  [FAILURES_STDLIB_DECLARATION_FILE, FAILURES_STDLIB_DECLARATION_TEXT],
  [URL_STDLIB_DECLARATION_FILE, URL_STDLIB_DECLARATION_TEXT],
  [FETCH_STDLIB_DECLARATION_FILE, FETCH_STDLIB_DECLARATION_TEXT],
  [TEXT_STDLIB_DECLARATION_FILE, TEXT_STDLIB_DECLARATION_TEXT],
  [RANDOM_STDLIB_DECLARATION_FILE, RANDOM_STDLIB_DECLARATION_TEXT],
  [JSON_STDLIB_DECLARATION_FILE, JSON_STDLIB_DECLARATION_TEXT],
  [METADATA_STDLIB_DECLARATION_FILE, METADATA_STDLIB_DECLARATION_TEXT],
  [COMPARE_STDLIB_DECLARATION_FILE, COMPARE_STDLIB_DECLARATION_TEXT],
  [HASH_STDLIB_DECLARATION_FILE, HASH_STDLIB_DECLARATION_TEXT],
  [DERIVE_STDLIB_DECLARATION_FILE, DERIVE_STDLIB_DECLARATION_TEXT],
  [DECODE_STDLIB_DECLARATION_FILE, DECODE_STDLIB_DECLARATION_TEXT],
  [ENCODE_STDLIB_DECLARATION_FILE, ENCODE_STDLIB_DECLARATION_TEXT],
  [CODEC_STDLIB_DECLARATION_FILE, CODEC_STDLIB_DECLARATION_TEXT],
  [ASYNC_STDLIB_DECLARATION_FILE, ASYNC_STDLIB_DECLARATION_TEXT],
  [THUNK_STDLIB_DECLARATION_FILE, THUNK_STDLIB_DECLARATION_TEXT],
  [SQL_STDLIB_DECLARATION_FILE, SQL_STDLIB_DECLARATION_TEXT],
  [CSS_STDLIB_DECLARATION_FILE, CSS_STDLIB_DECLARATION_TEXT],
  [GRAPHQL_STDLIB_DECLARATION_FILE, GRAPHQL_STDLIB_DECLARATION_TEXT],
  ...(
    COMPONENT_STDLIB_DECLARATION_TEXT === undefined
      ? []
      : [[COMPONENT_STDLIB_DECLARATION_FILE, COMPONENT_STDLIB_DECLARATION_TEXT] as const]
  ),
  [DEBUG_STDLIB_DECLARATION_FILE, DEBUG_STDLIB_DECLARATION_TEXT],
  [NUMERICS_STDLIB_DECLARATION_FILE, NUMERICS_STDLIB_DECLARATION_TEXT],
]);
const STDLIB_DECLARATION_ENTRIES_BY_SPECIFIER = new Map<
  string,
  { fileName: string; text: string }
>(
  [...STDLIB_DECLARATION_FILES.entries()].flatMap(([specifier, fileName]) => {
    const text = STDLIB_DECLARATION_TEXTS.get(fileName);
    return text === undefined ? [] : [[specifier, { fileName, text }] as const];
  }),
);

export function getStdlibDeclarationTexts(): ReadonlyMap<string, string> {
  return STDLIB_DECLARATION_TEXTS;
}

export function getStdlibDeclarationEntriesBySpecifier(): ReadonlyMap<
  string,
  { fileName: string; text: string }
> {
  return STDLIB_DECLARATION_ENTRIES_BY_SPECIFIER;
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

export function withStdPackageModuleResolution(baseHost: ts.CompilerHost): ts.CompilerHost {
  return {
    ...baseHost,
    fileExists(fileName: string): boolean {
      return STDLIB_DECLARATION_FILE_SET.has(fileName) || baseHost.fileExists(fileName);
    },
    readFile(fileName: string): string | undefined {
      if (STDLIB_DECLARATION_FILE_SET.has(fileName)) {
        return STDLIB_DECLARATION_TEXTS.get(fileName);
      }
      return baseHost.readFile(fileName);
    },
    resolveModuleNames(
      moduleNames: string[],
      containingFile: string,
      reusedNames?: string[],
      redirectedReference?: ts.ResolvedProjectReference,
      options?: ts.CompilerOptions,
    ): (ts.ResolvedModule | undefined)[] {
      const fallbackHost = createModuleResolutionHost(baseHost);
      const delegated = baseHost.resolveModuleNames?.(
        moduleNames,
        containingFile,
        reusedNames,
        redirectedReference,
        options ?? {},
      );

      return moduleNames.map((moduleName, index) => {
        const stdlibDeclarationFile = STDLIB_DECLARATION_FILES.get(moduleName);
        if (stdlibDeclarationFile) {
          return {
            resolvedFileName: stdlibDeclarationFile,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: true,
          };
        }

        if (delegated?.[index]) {
          return delegated[index];
        }

        const resolved = ts.resolveModuleName(
          moduleName,
          containingFile,
          options ?? {},
          fallbackHost,
          undefined,
          redirectedReference,
        );
        return resolved.resolvedModule;
      });
    },
  };
}
