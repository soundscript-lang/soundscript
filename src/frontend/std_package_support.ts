import ts from 'typescript';

import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import {
  STS_BYTES_MODULE_SPECIFIER,
  STS_CAPABILITIES_MODULE_SPECIFIER,
  STS_CLI_MODULE_SPECIFIER,
  STS_CODEC_MODULE_SPECIFIER,
  STS_COMPARE_MODULE_SPECIFIER,
  STS_CONCURRENCY_ATOMICS_MODULE_SPECIFIER,
  STS_CONCURRENCY_MODULE_SPECIFIER,
  STS_CONCURRENCY_PARALLEL_MODULE_SPECIFIER,
  STS_CONCURRENCY_RUNTIME_MODULE_SPECIFIER,
  STS_CONCURRENCY_SYNC_MODULE_SPECIFIER,
  STS_CONCURRENCY_TASK_MODULE_SPECIFIER,
  STS_CONSOLE_MODULE_SPECIFIER,
  STS_DECODE_MODULE_SPECIFIER,
  STS_DERIVE_MODULE_SPECIFIER,
  STS_ENCODE_MODULE_SPECIFIER,
  STS_ENV_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_COMPONENT_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_CSS_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_DEBUG_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_GRAPHQL_MODULE_SPECIFIER,
  STS_EXPERIMENTAL_SQL_MODULE_SPECIFIER,
  STS_FAILURES_MODULE_SPECIFIER,
  STS_FETCH_MODULE_SPECIFIER,
  STS_FS_MODULE_SPECIFIER,
  STS_HASH_MODULE_SPECIFIER,
  STS_HKT_MODULE_SPECIFIER,
  STS_HTTP_MODULE_SPECIFIER,
  STS_JSON_MODULE_SPECIFIER,
  STS_MATCH_MODULE_SPECIFIER,
  STS_METADATA_MODULE_SPECIFIER,
  STS_NET_MODULE_SPECIFIER,
  STS_NUMERICS_MODULE_SPECIFIER,
  STS_PATH_MODULE_SPECIFIER,
  STS_PRELUDE_MODULE_SPECIFIER,
  STS_PROCESS_MODULE_SPECIFIER,
  STS_RANDOM_MODULE_SPECIFIER,
  STS_RESULT_MODULE_SPECIFIER,
  STS_STREAMS_MODULE_SPECIFIER,
  STS_TEXT_MODULE_SPECIFIER,
  STS_THUNK_MODULE_SPECIFIER,
  STS_TIME_MODULE_SPECIFIER,
  STS_TYPECLASSES_MODULE_SPECIFIER,
  STS_URL_MODULE_SPECIFIER,
  STS_VALUE_MODULE_SPECIFIER,
} from '../project/soundscript_runtime_specifiers.ts';
import { captureTypeScriptDeclarationOutputs } from './typescript_effect_declarations.ts';
import {
  resolveHostDeclarationFile,
  WEB_DOM_DECLARATION_FILE,
  WEB_DOM_MODULE_SPECIFIER,
} from './host_declaration_resolution.ts';
import { fileExistsSync, readTextFileSync, runtimeExecPath } from '../platform/host.ts';
import { basename, dirname, fromFileUrl, join, relative } from '../platform/path.ts';

export {
  resolveHostDeclarationFile,
  WEB_DOM_DECLARATION_FILE,
  WEB_DOM_MODULE_SPECIFIER,
} from './host_declaration_resolution.ts';

export const STDLIB_MODULE_SPECIFIER = STS_PRELUDE_MODULE_SPECIFIER;
export const HKT_STDLIB_MODULE_SPECIFIER = STS_HKT_MODULE_SPECIFIER;
export const TYPECLASSES_STDLIB_MODULE_SPECIFIER = STS_TYPECLASSES_MODULE_SPECIFIER;
export const RESULT_STDLIB_MODULE_SPECIFIER = STS_RESULT_MODULE_SPECIFIER;
export const VALUE_STDLIB_MODULE_SPECIFIER = STS_VALUE_MODULE_SPECIFIER;
export const MATCH_STDLIB_MODULE_SPECIFIER = STS_MATCH_MODULE_SPECIFIER;
export const FAILURES_STDLIB_MODULE_SPECIFIER = STS_FAILURES_MODULE_SPECIFIER;
export const URL_STDLIB_MODULE_SPECIFIER = STS_URL_MODULE_SPECIFIER;
export const FETCH_STDLIB_MODULE_SPECIFIER = STS_FETCH_MODULE_SPECIFIER;
export const STREAMS_STDLIB_MODULE_SPECIFIER = STS_STREAMS_MODULE_SPECIFIER;
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
export const CONCURRENCY_STDLIB_MODULE_SPECIFIER = STS_CONCURRENCY_MODULE_SPECIFIER;
export const CONCURRENCY_TASK_STDLIB_MODULE_SPECIFIER = STS_CONCURRENCY_TASK_MODULE_SPECIFIER;
export const CONCURRENCY_RUNTIME_STDLIB_MODULE_SPECIFIER = STS_CONCURRENCY_RUNTIME_MODULE_SPECIFIER;
export const CONCURRENCY_PARALLEL_STDLIB_MODULE_SPECIFIER =
  STS_CONCURRENCY_PARALLEL_MODULE_SPECIFIER;
export const CONCURRENCY_SYNC_STDLIB_MODULE_SPECIFIER = STS_CONCURRENCY_SYNC_MODULE_SPECIFIER;
export const CONCURRENCY_ATOMICS_STDLIB_MODULE_SPECIFIER = STS_CONCURRENCY_ATOMICS_MODULE_SPECIFIER;
export const CAPABILITIES_STDLIB_MODULE_SPECIFIER = STS_CAPABILITIES_MODULE_SPECIFIER;
export const TIME_STDLIB_MODULE_SPECIFIER = STS_TIME_MODULE_SPECIFIER;
export const CONSOLE_STDLIB_MODULE_SPECIFIER = STS_CONSOLE_MODULE_SPECIFIER;
export const PATH_STDLIB_MODULE_SPECIFIER = STS_PATH_MODULE_SPECIFIER;
export const BYTES_STDLIB_MODULE_SPECIFIER = STS_BYTES_MODULE_SPECIFIER;
export const FS_STDLIB_MODULE_SPECIFIER = STS_FS_MODULE_SPECIFIER;
export const ENV_STDLIB_MODULE_SPECIFIER = STS_ENV_MODULE_SPECIFIER;
export const CLI_STDLIB_MODULE_SPECIFIER = STS_CLI_MODULE_SPECIFIER;
export const PROCESS_STDLIB_MODULE_SPECIFIER = STS_PROCESS_MODULE_SPECIFIER;
export const HTTP_STDLIB_MODULE_SPECIFIER = STS_HTTP_MODULE_SPECIFIER;
export const NET_STDLIB_MODULE_SPECIFIER = STS_NET_MODULE_SPECIFIER;
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
export const STREAMS_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/streams.d.ts', import.meta.url),
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
export const CONCURRENCY_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/concurrency.d.ts', import.meta.url),
);
export const CONCURRENCY_TASK_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/concurrency/task.d.ts', import.meta.url),
);
export const CONCURRENCY_RUNTIME_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/concurrency/runtime.d.ts', import.meta.url),
);
export const CONCURRENCY_PARALLEL_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/concurrency/parallel.d.ts', import.meta.url),
);
export const CONCURRENCY_SYNC_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/concurrency/sync.d.ts', import.meta.url),
);
export const CONCURRENCY_ATOMICS_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/concurrency/atomics.d.ts', import.meta.url),
);
export const CAPABILITIES_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/capabilities.d.ts', import.meta.url),
);
export const TIME_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/time.d.ts', import.meta.url),
);
export const CONSOLE_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/console.d.ts', import.meta.url),
);
export const PATH_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/path.d.ts', import.meta.url),
);
export const BYTES_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/bytes.d.ts', import.meta.url),
);
export const FS_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/fs.d.ts', import.meta.url),
);
export const ENV_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/env.d.ts', import.meta.url),
);
export const CLI_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/cli.d.ts', import.meta.url),
);
export const PROCESS_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/process.d.ts', import.meta.url),
);
export const HTTP_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/http.d.ts', import.meta.url),
);
export const NET_STDLIB_DECLARATION_FILE = fromFileUrl(
  new URL('../stdlib/net.d.ts', import.meta.url),
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

const GENERATED_STDLIB_DECLARATION_OUT_DIR = '/__soundscript_stdlib_types__';

interface MacroStdlibDeclarationGlobal {
  __STS_STDLIB_DECLARATION_TEXTS__?: Readonly<Record<string, string>>;
}

let generatedStdlibDeclarationTextsCache: ReadonlyMap<string, string> | undefined;
const STDLIB_DECLARATION_ROOT = dirname(STDLIB_DECLARATION_FILE);

function fileExists(path: string): boolean {
  return fileExistsSync(path);
}

function toRuntimeStdlibRelativePath(sourceFilePath: string): string {
  const relativeStdlibPath = relative(STDLIB_DECLARATION_ROOT, sourceFilePath);
  if (!relativeStdlibPath.startsWith('..')) {
    return relativeStdlibPath;
  }

  const extractedStdlibMatch = sourceFilePath.match(
    /(?:^|[/\\])(?:src[/\\])?stdlib[/\\](.+)$/u,
  );
  if (extractedStdlibMatch?.[1]) {
    return extractedStdlibMatch[1];
  }

  return basename(sourceFilePath);
}

export function resolveStdlibDeclarationRuntimePath(
  sourceFilePath: string,
  {
    execPath = runtimeExecPath(),
  }: {
    execPath?: string;
  } = {},
): string {
  const runtimeRelativePath = toRuntimeStdlibRelativePath(sourceFilePath);
  const candidatePaths = [
    sourceFilePath,
    join(dirname(execPath), 'src', 'stdlib', runtimeRelativePath),
    join(dirname(execPath), '..', 'src', 'stdlib', runtimeRelativePath),
  ];

  for (const candidatePath of candidatePaths) {
    if (fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  return sourceFilePath;
}

function toStdlibSourceFilePath(declarationFilePath: string): string {
  return declarationFilePath.replace(/\.d\.ts$/u, '.ts');
}

function createStdlibSourceFileByDeclarationFile(): ReadonlyMap<string, string> {
  const entries: [string, string][] = [];
  const declarationFiles = [
    STDLIB_DECLARATION_FILE,
    HKT_STDLIB_DECLARATION_FILE,
    TYPECLASSES_STDLIB_DECLARATION_FILE,
    RESULT_STDLIB_DECLARATION_FILE,
    VALUE_STDLIB_DECLARATION_FILE,
    MATCH_STDLIB_DECLARATION_FILE,
    FAILURES_STDLIB_DECLARATION_FILE,
    URL_STDLIB_DECLARATION_FILE,
    FETCH_STDLIB_DECLARATION_FILE,
    STREAMS_STDLIB_DECLARATION_FILE,
    TEXT_STDLIB_DECLARATION_FILE,
    RANDOM_STDLIB_DECLARATION_FILE,
    JSON_STDLIB_DECLARATION_FILE,
    METADATA_STDLIB_DECLARATION_FILE,
    COMPARE_STDLIB_DECLARATION_FILE,
    HASH_STDLIB_DECLARATION_FILE,
    DERIVE_STDLIB_DECLARATION_FILE,
    DECODE_STDLIB_DECLARATION_FILE,
    ENCODE_STDLIB_DECLARATION_FILE,
    CODEC_STDLIB_DECLARATION_FILE,
    CONCURRENCY_STDLIB_DECLARATION_FILE,
    CONCURRENCY_TASK_STDLIB_DECLARATION_FILE,
    CONCURRENCY_RUNTIME_STDLIB_DECLARATION_FILE,
    CONCURRENCY_PARALLEL_STDLIB_DECLARATION_FILE,
    CONCURRENCY_SYNC_STDLIB_DECLARATION_FILE,
    CONCURRENCY_ATOMICS_STDLIB_DECLARATION_FILE,
    CAPABILITIES_STDLIB_DECLARATION_FILE,
    TIME_STDLIB_DECLARATION_FILE,
    CONSOLE_STDLIB_DECLARATION_FILE,
    PATH_STDLIB_DECLARATION_FILE,
    BYTES_STDLIB_DECLARATION_FILE,
    FS_STDLIB_DECLARATION_FILE,
    ENV_STDLIB_DECLARATION_FILE,
    CLI_STDLIB_DECLARATION_FILE,
    PROCESS_STDLIB_DECLARATION_FILE,
    HTTP_STDLIB_DECLARATION_FILE,
    NET_STDLIB_DECLARATION_FILE,
    THUNK_STDLIB_DECLARATION_FILE,
    SQL_STDLIB_DECLARATION_FILE,
    CSS_STDLIB_DECLARATION_FILE,
    GRAPHQL_STDLIB_DECLARATION_FILE,
    COMPONENT_STDLIB_DECLARATION_FILE,
    DEBUG_STDLIB_DECLARATION_FILE,
    NUMERICS_STDLIB_DECLARATION_FILE,
  ];

  for (const declarationFile of declarationFiles) {
    const sourceFile = toStdlibSourceFilePath(declarationFile);
    if (fileExists(sourceFile)) {
      entries.push([declarationFile, sourceFile]);
    }
  }

  return new Map(entries);
}

const STDLIB_SOURCE_FILE_BY_DECLARATION_FILE = createStdlibSourceFileByDeclarationFile();

function getGeneratedStdlibDeclarationTexts(): ReadonlyMap<string, string> {
  const cached = generatedStdlibDeclarationTextsCache;
  if (cached) {
    return cached;
  }

  const rootNames = [...new Set(STDLIB_SOURCE_FILE_BY_DECLARATION_FILE.values())];
  const options: ts.CompilerOptions = {
    declaration: true,
    emitDeclarationOnly: true,
    lib: ['lib.es2024.d.ts', 'lib.dom.d.ts', 'lib.dom.asynciterable.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    outDir: GENERATED_STDLIB_DECLARATION_OUT_DIR,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const baseHost = createSoundStdlibCompilerHost(options, dirname(STDLIB_DECLARATION_FILE));
  const sourceFileBySpecifier = new Map<string, string>([
    [STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(STDLIB_DECLARATION_FILE)],
    [HKT_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(HKT_STDLIB_DECLARATION_FILE)],
    [
      TYPECLASSES_STDLIB_MODULE_SPECIFIER,
      toStdlibSourceFilePath(TYPECLASSES_STDLIB_DECLARATION_FILE),
    ],
    [RESULT_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(RESULT_STDLIB_DECLARATION_FILE)],
    [VALUE_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(VALUE_STDLIB_DECLARATION_FILE)],
    [MATCH_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(MATCH_STDLIB_DECLARATION_FILE)],
    [FAILURES_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(FAILURES_STDLIB_DECLARATION_FILE)],
    [URL_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(URL_STDLIB_DECLARATION_FILE)],
    [FETCH_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(FETCH_STDLIB_DECLARATION_FILE)],
    [STREAMS_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(STREAMS_STDLIB_DECLARATION_FILE)],
    [TEXT_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(TEXT_STDLIB_DECLARATION_FILE)],
    [RANDOM_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(RANDOM_STDLIB_DECLARATION_FILE)],
    [JSON_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(JSON_STDLIB_DECLARATION_FILE)],
    [METADATA_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(METADATA_STDLIB_DECLARATION_FILE)],
    [COMPARE_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(COMPARE_STDLIB_DECLARATION_FILE)],
    [HASH_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(HASH_STDLIB_DECLARATION_FILE)],
    [DERIVE_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(DERIVE_STDLIB_DECLARATION_FILE)],
    [DECODE_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(DECODE_STDLIB_DECLARATION_FILE)],
    [ENCODE_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(ENCODE_STDLIB_DECLARATION_FILE)],
    [CODEC_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(CODEC_STDLIB_DECLARATION_FILE)],
    [
      CONCURRENCY_STDLIB_MODULE_SPECIFIER,
      toStdlibSourceFilePath(CONCURRENCY_STDLIB_DECLARATION_FILE),
    ],
    [
      CONCURRENCY_TASK_STDLIB_MODULE_SPECIFIER,
      toStdlibSourceFilePath(CONCURRENCY_TASK_STDLIB_DECLARATION_FILE),
    ],
    [
      CONCURRENCY_RUNTIME_STDLIB_MODULE_SPECIFIER,
      toStdlibSourceFilePath(CONCURRENCY_RUNTIME_STDLIB_DECLARATION_FILE),
    ],
    [
      CONCURRENCY_PARALLEL_STDLIB_MODULE_SPECIFIER,
      toStdlibSourceFilePath(CONCURRENCY_PARALLEL_STDLIB_DECLARATION_FILE),
    ],
    [
      CONCURRENCY_SYNC_STDLIB_MODULE_SPECIFIER,
      toStdlibSourceFilePath(CONCURRENCY_SYNC_STDLIB_DECLARATION_FILE),
    ],
    [
      CONCURRENCY_ATOMICS_STDLIB_MODULE_SPECIFIER,
      toStdlibSourceFilePath(CONCURRENCY_ATOMICS_STDLIB_DECLARATION_FILE),
    ],
    [
      CAPABILITIES_STDLIB_MODULE_SPECIFIER,
      toStdlibSourceFilePath(CAPABILITIES_STDLIB_DECLARATION_FILE),
    ],
    [TIME_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(TIME_STDLIB_DECLARATION_FILE)],
    [CONSOLE_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(CONSOLE_STDLIB_DECLARATION_FILE)],
    [PATH_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(PATH_STDLIB_DECLARATION_FILE)],
    [BYTES_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(BYTES_STDLIB_DECLARATION_FILE)],
    [FS_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(FS_STDLIB_DECLARATION_FILE)],
    [ENV_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(ENV_STDLIB_DECLARATION_FILE)],
    [CLI_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(CLI_STDLIB_DECLARATION_FILE)],
    [PROCESS_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(PROCESS_STDLIB_DECLARATION_FILE)],
    [HTTP_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(HTTP_STDLIB_DECLARATION_FILE)],
    [NET_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(NET_STDLIB_DECLARATION_FILE)],
    [THUNK_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(THUNK_STDLIB_DECLARATION_FILE)],
    [SQL_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(SQL_STDLIB_DECLARATION_FILE)],
    [CSS_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(CSS_STDLIB_DECLARATION_FILE)],
    [GRAPHQL_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(GRAPHQL_STDLIB_DECLARATION_FILE)],
    ...(
      fileExists(toStdlibSourceFilePath(COMPONENT_STDLIB_DECLARATION_FILE))
        ? [
          [
            COMPONENT_STDLIB_MODULE_SPECIFIER,
            toStdlibSourceFilePath(COMPONENT_STDLIB_DECLARATION_FILE),
          ] as const,
        ]
        : []
    ),
    [DEBUG_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(DEBUG_STDLIB_DECLARATION_FILE)],
    [NUMERICS_STDLIB_MODULE_SPECIFIER, toStdlibSourceFilePath(NUMERICS_STDLIB_DECLARATION_FILE)],
  ]);

  const host: ts.CompilerHost = {
    ...baseHost,
    resolveModuleNames(
      moduleNames,
      containingFile,
      reusedNames,
      redirectedReference,
      compilerOptions,
    ) {
      const delegated = baseHost.resolveModuleNames?.(
        moduleNames,
        containingFile,
        reusedNames,
        redirectedReference,
        compilerOptions,
      );
      const fallbackHost = createModuleResolutionHost(baseHost);

      return moduleNames.map((moduleName, index) => {
        const sourceFile = sourceFileBySpecifier.get(moduleName);
        if (sourceFile) {
          return {
            resolvedFileName: sourceFile,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: true,
          };
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
  };

  const program = ts.createProgram(rootNames, options, host);
  const emitted = captureTypeScriptDeclarationOutputs(program);
  const texts = new Map<string, string>();

  for (const [declarationFile, sourceFile] of STDLIB_SOURCE_FILE_BY_DECLARATION_FILE.entries()) {
    const generatedPath = join(
      GENERATED_STDLIB_DECLARATION_OUT_DIR,
      toRuntimeStdlibRelativePath(sourceFile).replace(/\.ts$/u, '.d.ts'),
    );
    const generatedText = emitted.get(generatedPath);
    if (generatedText === undefined) {
      throw new Error(`Missing generated stdlib declaration for ${sourceFile}.`);
    }
    texts.set(declarationFile, generatedText);
  }

  generatedStdlibDeclarationTextsCache = texts;
  return texts;
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
  if (fileExists(resolvedPath)) {
    return readTextFileSync(resolvedPath);
  }

  const generatedText = getGeneratedStdlibDeclarationTexts().get(sourceFilePath);
  if (generatedText !== undefined) {
    return generatedText;
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
export const STREAMS_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  STREAMS_STDLIB_DECLARATION_FILE,
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
export const CONCURRENCY_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  CONCURRENCY_STDLIB_DECLARATION_FILE,
);
export const CONCURRENCY_TASK_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  CONCURRENCY_TASK_STDLIB_DECLARATION_FILE,
);
export const CONCURRENCY_RUNTIME_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  CONCURRENCY_RUNTIME_STDLIB_DECLARATION_FILE,
);
export const CONCURRENCY_PARALLEL_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  CONCURRENCY_PARALLEL_STDLIB_DECLARATION_FILE,
);
export const CONCURRENCY_SYNC_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  CONCURRENCY_SYNC_STDLIB_DECLARATION_FILE,
);
export const CONCURRENCY_ATOMICS_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  CONCURRENCY_ATOMICS_STDLIB_DECLARATION_FILE,
);
export const CAPABILITIES_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  CAPABILITIES_STDLIB_DECLARATION_FILE,
);
export const TIME_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  TIME_STDLIB_DECLARATION_FILE,
);
export const CONSOLE_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  CONSOLE_STDLIB_DECLARATION_FILE,
);
export const PATH_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  PATH_STDLIB_DECLARATION_FILE,
);
export const BYTES_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  BYTES_STDLIB_DECLARATION_FILE,
);
export const FS_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(FS_STDLIB_DECLARATION_FILE);
export const ENV_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(ENV_STDLIB_DECLARATION_FILE);
export const CLI_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(CLI_STDLIB_DECLARATION_FILE);
export const PROCESS_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  PROCESS_STDLIB_DECLARATION_FILE,
);
export const HTTP_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(
  HTTP_STDLIB_DECLARATION_FILE,
);
export const NET_STDLIB_DECLARATION_TEXT = readStdlibDeclarationText(NET_STDLIB_DECLARATION_FILE);
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
export const WEB_DOM_DECLARATION_TEXT = readStdlibDeclarationText(WEB_DOM_DECLARATION_FILE);

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
  [STREAMS_STDLIB_MODULE_SPECIFIER, STREAMS_STDLIB_DECLARATION_FILE],
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
  [CONCURRENCY_STDLIB_MODULE_SPECIFIER, CONCURRENCY_STDLIB_DECLARATION_FILE],
  [CONCURRENCY_TASK_STDLIB_MODULE_SPECIFIER, CONCURRENCY_TASK_STDLIB_DECLARATION_FILE],
  [CONCURRENCY_RUNTIME_STDLIB_MODULE_SPECIFIER, CONCURRENCY_RUNTIME_STDLIB_DECLARATION_FILE],
  [CONCURRENCY_PARALLEL_STDLIB_MODULE_SPECIFIER, CONCURRENCY_PARALLEL_STDLIB_DECLARATION_FILE],
  [CONCURRENCY_SYNC_STDLIB_MODULE_SPECIFIER, CONCURRENCY_SYNC_STDLIB_DECLARATION_FILE],
  [CONCURRENCY_ATOMICS_STDLIB_MODULE_SPECIFIER, CONCURRENCY_ATOMICS_STDLIB_DECLARATION_FILE],
  [CAPABILITIES_STDLIB_MODULE_SPECIFIER, CAPABILITIES_STDLIB_DECLARATION_FILE],
  [TIME_STDLIB_MODULE_SPECIFIER, TIME_STDLIB_DECLARATION_FILE],
  [CONSOLE_STDLIB_MODULE_SPECIFIER, CONSOLE_STDLIB_DECLARATION_FILE],
  [PATH_STDLIB_MODULE_SPECIFIER, PATH_STDLIB_DECLARATION_FILE],
  [BYTES_STDLIB_MODULE_SPECIFIER, BYTES_STDLIB_DECLARATION_FILE],
  [FS_STDLIB_MODULE_SPECIFIER, FS_STDLIB_DECLARATION_FILE],
  [ENV_STDLIB_MODULE_SPECIFIER, ENV_STDLIB_DECLARATION_FILE],
  [CLI_STDLIB_MODULE_SPECIFIER, CLI_STDLIB_DECLARATION_FILE],
  [PROCESS_STDLIB_MODULE_SPECIFIER, PROCESS_STDLIB_DECLARATION_FILE],
  [HTTP_STDLIB_MODULE_SPECIFIER, HTTP_STDLIB_DECLARATION_FILE],
  [NET_STDLIB_MODULE_SPECIFIER, NET_STDLIB_DECLARATION_FILE],
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
const HOST_DECLARATION_FILES = new Map<string, string>([
  [WEB_DOM_MODULE_SPECIFIER, WEB_DOM_DECLARATION_FILE],
]);
const VIRTUAL_DECLARATION_FILE_SET = new Set([
  ...STDLIB_DECLARATION_FILES.values(),
  ...HOST_DECLARATION_FILES.values(),
]);
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
  [STREAMS_STDLIB_DECLARATION_FILE, STREAMS_STDLIB_DECLARATION_TEXT],
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
  [CONCURRENCY_STDLIB_DECLARATION_FILE, CONCURRENCY_STDLIB_DECLARATION_TEXT],
  [CONCURRENCY_TASK_STDLIB_DECLARATION_FILE, CONCURRENCY_TASK_STDLIB_DECLARATION_TEXT],
  [CONCURRENCY_RUNTIME_STDLIB_DECLARATION_FILE, CONCURRENCY_RUNTIME_STDLIB_DECLARATION_TEXT],
  [CONCURRENCY_PARALLEL_STDLIB_DECLARATION_FILE, CONCURRENCY_PARALLEL_STDLIB_DECLARATION_TEXT],
  [CONCURRENCY_SYNC_STDLIB_DECLARATION_FILE, CONCURRENCY_SYNC_STDLIB_DECLARATION_TEXT],
  [CONCURRENCY_ATOMICS_STDLIB_DECLARATION_FILE, CONCURRENCY_ATOMICS_STDLIB_DECLARATION_TEXT],
  [CAPABILITIES_STDLIB_DECLARATION_FILE, CAPABILITIES_STDLIB_DECLARATION_TEXT],
  [TIME_STDLIB_DECLARATION_FILE, TIME_STDLIB_DECLARATION_TEXT],
  [CONSOLE_STDLIB_DECLARATION_FILE, CONSOLE_STDLIB_DECLARATION_TEXT],
  [PATH_STDLIB_DECLARATION_FILE, PATH_STDLIB_DECLARATION_TEXT],
  [BYTES_STDLIB_DECLARATION_FILE, BYTES_STDLIB_DECLARATION_TEXT],
  [FS_STDLIB_DECLARATION_FILE, FS_STDLIB_DECLARATION_TEXT],
  [ENV_STDLIB_DECLARATION_FILE, ENV_STDLIB_DECLARATION_TEXT],
  [CLI_STDLIB_DECLARATION_FILE, CLI_STDLIB_DECLARATION_TEXT],
  [PROCESS_STDLIB_DECLARATION_FILE, PROCESS_STDLIB_DECLARATION_TEXT],
  [HTTP_STDLIB_DECLARATION_FILE, HTTP_STDLIB_DECLARATION_TEXT],
  [NET_STDLIB_DECLARATION_FILE, NET_STDLIB_DECLARATION_TEXT],
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
  [WEB_DOM_DECLARATION_FILE, WEB_DOM_DECLARATION_TEXT],
]);

function resolveRelativeStdlibDeclarationFile(
  containingFile: string,
  moduleName: string,
): string | undefined {
  if (
    !STDLIB_DECLARATION_FILE_SET.has(containingFile) ||
    !(moduleName.startsWith('./') || moduleName.startsWith('../'))
  ) {
    return undefined;
  }

  const declarationBasePath = join(dirname(containingFile), moduleName);
  const candidateDeclarationFiles = [
    declarationBasePath.endsWith('.d.ts') ? declarationBasePath : `${declarationBasePath}.d.ts`,
    join(declarationBasePath, 'index.d.ts'),
  ];
  return candidateDeclarationFiles.find((candidate) => STDLIB_DECLARATION_FILE_SET.has(candidate));
}

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

export function withStdPackageModuleResolution(
  baseHost: ts.CompilerHost,
  defaultOptions: ts.CompilerOptions = {},
): ts.CompilerHost {
  return {
    ...baseHost,
    fileExists(fileName: string): boolean {
      return VIRTUAL_DECLARATION_FILE_SET.has(fileName) || baseHost.fileExists(fileName);
    },
    getSourceFile(
      fileName: string,
      languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): ts.SourceFile | undefined {
      const virtualText = STDLIB_DECLARATION_TEXTS.get(fileName);
      if (virtualText !== undefined) {
        return ts.createSourceFile(
          fileName,
          virtualText,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        );
      }

      return baseHost.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    readFile(fileName: string): string | undefined {
      if (VIRTUAL_DECLARATION_FILE_SET.has(fileName)) {
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
        options ?? defaultOptions,
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

        const hostDeclarationFile = resolveHostDeclarationFile(moduleName, options ?? {});
        if (hostDeclarationFile) {
          return {
            resolvedFileName: hostDeclarationFile,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: true,
          };
        }

        const relativeStdlibDeclarationFile = resolveRelativeStdlibDeclarationFile(
          containingFile,
          moduleName,
        );
        if (relativeStdlibDeclarationFile) {
          return {
            resolvedFileName: relativeStdlibDeclarationFile,
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
          options ?? defaultOptions,
          fallbackHost,
          undefined,
          redirectedReference,
        ).resolvedModule;
        if (resolved && STDLIB_DECLARATION_FILE_SET.has(resolved.resolvedFileName)) {
          return resolved;
        }

        return resolved;
      });
    },
  };
}
