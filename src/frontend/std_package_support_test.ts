import { assertEquals, assertStringIncludes } from '@std/assert';
import ts from 'typescript';

import {
  BYTES_STDLIB_DECLARATION_FILE,
  BYTES_STDLIB_DECLARATION_TEXT,
  BYTES_STDLIB_MODULE_SPECIFIER,
  CAPABILITIES_STDLIB_DECLARATION_FILE,
  CAPABILITIES_STDLIB_DECLARATION_TEXT,
  CAPABILITIES_STDLIB_MODULE_SPECIFIER,
  CLI_STDLIB_DECLARATION_FILE,
  CLI_STDLIB_DECLARATION_TEXT,
  CLI_STDLIB_MODULE_SPECIFIER,
  CODEC_STDLIB_DECLARATION_FILE,
  CODEC_STDLIB_MODULE_SPECIFIER,
  COMPARE_STDLIB_DECLARATION_FILE,
  COMPARE_STDLIB_MODULE_SPECIFIER,
  CONCURRENCY_ATOMICS_STDLIB_DECLARATION_FILE,
  CONCURRENCY_ATOMICS_STDLIB_MODULE_SPECIFIER,
  CONCURRENCY_PARALLEL_STDLIB_DECLARATION_FILE,
  CONCURRENCY_PARALLEL_STDLIB_MODULE_SPECIFIER,
  CONCURRENCY_RUNTIME_STDLIB_DECLARATION_FILE,
  CONCURRENCY_RUNTIME_STDLIB_MODULE_SPECIFIER,
  CONCURRENCY_STDLIB_DECLARATION_FILE,
  CONCURRENCY_STDLIB_DECLARATION_TEXT,
  CONCURRENCY_STDLIB_MODULE_SPECIFIER,
  CONCURRENCY_SYNC_STDLIB_DECLARATION_FILE,
  CONCURRENCY_SYNC_STDLIB_MODULE_SPECIFIER,
  CONCURRENCY_TASK_STDLIB_DECLARATION_FILE,
  CONCURRENCY_TASK_STDLIB_DECLARATION_TEXT,
  CONCURRENCY_TASK_STDLIB_MODULE_SPECIFIER,
  CONSOLE_STDLIB_DECLARATION_FILE,
  CONSOLE_STDLIB_DECLARATION_TEXT,
  CONSOLE_STDLIB_MODULE_SPECIFIER,
  DEBUG_STDLIB_DECLARATION_TEXT,
  DECODE_STDLIB_DECLARATION_FILE,
  DECODE_STDLIB_MODULE_SPECIFIER,
  ENV_STDLIB_DECLARATION_FILE,
  ENV_STDLIB_DECLARATION_TEXT,
  ENV_STDLIB_MODULE_SPECIFIER,
  FETCH_STDLIB_DECLARATION_FILE,
  FETCH_STDLIB_MODULE_SPECIFIER,
  FS_STDLIB_DECLARATION_FILE,
  FS_STDLIB_DECLARATION_TEXT,
  FS_STDLIB_MODULE_SPECIFIER,
  HASH_STDLIB_DECLARATION_FILE,
  HASH_STDLIB_MODULE_SPECIFIER,
  HKT_STDLIB_DECLARATION_FILE,
  HKT_STDLIB_MODULE_SPECIFIER,
  HTTP_STDLIB_DECLARATION_FILE,
  HTTP_STDLIB_DECLARATION_TEXT,
  HTTP_STDLIB_MODULE_SPECIFIER,
  JSON_STDLIB_DECLARATION_FILE,
  JSON_STDLIB_DECLARATION_TEXT,
  JSON_STDLIB_MODULE_SPECIFIER,
  MATCH_STDLIB_DECLARATION_FILE,
  MATCH_STDLIB_MODULE_SPECIFIER,
  NET_STDLIB_DECLARATION_FILE,
  NET_STDLIB_DECLARATION_TEXT,
  NET_STDLIB_MODULE_SPECIFIER,
  NUMERICS_STDLIB_DECLARATION_FILE,
  NUMERICS_STDLIB_MODULE_SPECIFIER,
  PATH_STDLIB_DECLARATION_FILE,
  PATH_STDLIB_DECLARATION_TEXT,
  PATH_STDLIB_MODULE_SPECIFIER,
  PROCESS_STDLIB_DECLARATION_FILE,
  PROCESS_STDLIB_DECLARATION_TEXT,
  PROCESS_STDLIB_MODULE_SPECIFIER,
  RANDOM_STDLIB_DECLARATION_FILE,
  RANDOM_STDLIB_DECLARATION_TEXT,
  RANDOM_STDLIB_MODULE_SPECIFIER,
  resolveStdlibDeclarationRuntimePath,
  RESULT_STDLIB_DECLARATION_FILE,
  RESULT_STDLIB_MODULE_SPECIFIER,
  STDLIB_DECLARATION_FILE,
  STDLIB_DECLARATION_TEXT,
  STDLIB_MODULE_SPECIFIER,
  TEXT_STDLIB_DECLARATION_FILE,
  TEXT_STDLIB_MODULE_SPECIFIER,
  TIME_STDLIB_DECLARATION_FILE,
  TIME_STDLIB_DECLARATION_TEXT,
  TIME_STDLIB_MODULE_SPECIFIER,
  URL_STDLIB_DECLARATION_FILE,
  URL_STDLIB_MODULE_SPECIFIER,
  withStdPackageModuleResolution,
} from './std_package_support.ts';

Deno.test('std package support resolves root and stdlib leaf specifiers to virtual stdlib files', () => {
  const host = withStdPackageModuleResolution(ts.createCompilerHost({
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  }));

  const [
    rootResolved,
    hktResolved,
    resultResolved,
    matchResolved,
    urlResolved,
    fetchResolved,
    textResolved,
    randomResolved,
    jsonResolved,
    compareResolved,
    hashResolved,
    decodeResolved,
    codecResolved,
    concurrencyResolved,
    concurrencyTaskResolved,
    concurrencyRuntimeResolved,
    concurrencyParallelResolved,
    concurrencySyncResolved,
    concurrencyAtomicsResolved,
    capabilitiesResolved,
    timeResolved,
    consoleResolved,
    pathResolved,
    bytesResolved,
    fsResolved,
    envResolved,
    cliResolved,
    processResolved,
    httpResolved,
    netResolved,
    numericsResolved,
  ] = host
    .resolveModuleNames!(
      [
        STDLIB_MODULE_SPECIFIER,
        HKT_STDLIB_MODULE_SPECIFIER,
        RESULT_STDLIB_MODULE_SPECIFIER,
        MATCH_STDLIB_MODULE_SPECIFIER,
        URL_STDLIB_MODULE_SPECIFIER,
        FETCH_STDLIB_MODULE_SPECIFIER,
        TEXT_STDLIB_MODULE_SPECIFIER,
        RANDOM_STDLIB_MODULE_SPECIFIER,
        JSON_STDLIB_MODULE_SPECIFIER,
        COMPARE_STDLIB_MODULE_SPECIFIER,
        HASH_STDLIB_MODULE_SPECIFIER,
        DECODE_STDLIB_MODULE_SPECIFIER,
        CODEC_STDLIB_MODULE_SPECIFIER,
        CONCURRENCY_STDLIB_MODULE_SPECIFIER,
        CONCURRENCY_TASK_STDLIB_MODULE_SPECIFIER,
        CONCURRENCY_RUNTIME_STDLIB_MODULE_SPECIFIER,
        CONCURRENCY_PARALLEL_STDLIB_MODULE_SPECIFIER,
        CONCURRENCY_SYNC_STDLIB_MODULE_SPECIFIER,
        CONCURRENCY_ATOMICS_STDLIB_MODULE_SPECIFIER,
        CAPABILITIES_STDLIB_MODULE_SPECIFIER,
        TIME_STDLIB_MODULE_SPECIFIER,
        CONSOLE_STDLIB_MODULE_SPECIFIER,
        PATH_STDLIB_MODULE_SPECIFIER,
        BYTES_STDLIB_MODULE_SPECIFIER,
        FS_STDLIB_MODULE_SPECIFIER,
        ENV_STDLIB_MODULE_SPECIFIER,
        CLI_STDLIB_MODULE_SPECIFIER,
        PROCESS_STDLIB_MODULE_SPECIFIER,
        HTTP_STDLIB_MODULE_SPECIFIER,
        NET_STDLIB_MODULE_SPECIFIER,
        NUMERICS_STDLIB_MODULE_SPECIFIER,
      ],
      '/virtual/index.ts',
      undefined,
      undefined,
      {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    );

  assertEquals(rootResolved?.resolvedFileName, STDLIB_DECLARATION_FILE);
  assertEquals(hktResolved?.resolvedFileName, HKT_STDLIB_DECLARATION_FILE);
  assertEquals(resultResolved?.resolvedFileName, RESULT_STDLIB_DECLARATION_FILE);
  assertEquals(matchResolved?.resolvedFileName, MATCH_STDLIB_DECLARATION_FILE);
  assertEquals(urlResolved?.resolvedFileName, URL_STDLIB_DECLARATION_FILE);
  assertEquals(fetchResolved?.resolvedFileName, FETCH_STDLIB_DECLARATION_FILE);
  assertEquals(textResolved?.resolvedFileName, TEXT_STDLIB_DECLARATION_FILE);
  assertEquals(randomResolved?.resolvedFileName, RANDOM_STDLIB_DECLARATION_FILE);
  assertEquals(jsonResolved?.resolvedFileName, JSON_STDLIB_DECLARATION_FILE);
  assertEquals(compareResolved?.resolvedFileName, COMPARE_STDLIB_DECLARATION_FILE);
  assertEquals(hashResolved?.resolvedFileName, HASH_STDLIB_DECLARATION_FILE);
  assertEquals(decodeResolved?.resolvedFileName, DECODE_STDLIB_DECLARATION_FILE);
  assertEquals(codecResolved?.resolvedFileName, CODEC_STDLIB_DECLARATION_FILE);
  assertEquals(concurrencyResolved?.resolvedFileName, CONCURRENCY_STDLIB_DECLARATION_FILE);
  assertEquals(concurrencyTaskResolved?.resolvedFileName, CONCURRENCY_TASK_STDLIB_DECLARATION_FILE);
  assertEquals(
    concurrencyRuntimeResolved?.resolvedFileName,
    CONCURRENCY_RUNTIME_STDLIB_DECLARATION_FILE,
  );
  assertEquals(
    concurrencyParallelResolved?.resolvedFileName,
    CONCURRENCY_PARALLEL_STDLIB_DECLARATION_FILE,
  );
  assertEquals(concurrencySyncResolved?.resolvedFileName, CONCURRENCY_SYNC_STDLIB_DECLARATION_FILE);
  assertEquals(
    concurrencyAtomicsResolved?.resolvedFileName,
    CONCURRENCY_ATOMICS_STDLIB_DECLARATION_FILE,
  );
  assertEquals(capabilitiesResolved?.resolvedFileName, CAPABILITIES_STDLIB_DECLARATION_FILE);
  assertEquals(timeResolved?.resolvedFileName, TIME_STDLIB_DECLARATION_FILE);
  assertEquals(consoleResolved?.resolvedFileName, CONSOLE_STDLIB_DECLARATION_FILE);
  assertEquals(pathResolved?.resolvedFileName, PATH_STDLIB_DECLARATION_FILE);
  assertEquals(bytesResolved?.resolvedFileName, BYTES_STDLIB_DECLARATION_FILE);
  assertEquals(fsResolved?.resolvedFileName, FS_STDLIB_DECLARATION_FILE);
  assertEquals(envResolved?.resolvedFileName, ENV_STDLIB_DECLARATION_FILE);
  assertEquals(cliResolved?.resolvedFileName, CLI_STDLIB_DECLARATION_FILE);
  assertEquals(processResolved?.resolvedFileName, PROCESS_STDLIB_DECLARATION_FILE);
  assertEquals(httpResolved?.resolvedFileName, HTTP_STDLIB_DECLARATION_FILE);
  assertEquals(netResolved?.resolvedFileName, NET_STDLIB_DECLARATION_FILE);
  assertEquals(numericsResolved?.resolvedFileName, NUMERICS_STDLIB_DECLARATION_FILE);
});

Deno.test('std package support root text is generated from stdlib sources', () => {
  assertStringIncludes(
    STDLIB_DECLARATION_TEXT,
    "export type { Err, None, Ok, Option, Result, Some } from 'sts:result';",
  );
});

Deno.test('std package support preserves inferred effects in generated debug declarations', () => {
  assertStringIncludes(
    DEBUG_STDLIB_DECLARATION_TEXT,
    '// #[effects(add: [fails.throws], unknown: [direct])]',
  );
  assertStringIncludes(DEBUG_STDLIB_DECLARATION_TEXT, '// #[effects(add: [host.ffi])]');
});

Deno.test('std package support preserves inferred effects in generated random declarations', () => {
  assertStringIncludes(RANDOM_STDLIB_DECLARATION_TEXT, '// #[effects(add: [host.random, mut])]');
});

Deno.test('std package support projects generated Task object declarations', () => {
  assertStringIncludes(
    CONCURRENCY_TASK_STDLIB_DECLARATION_TEXT,
    'export declare const Task: Readonly<{',
  );
  assertStringIncludes(CONCURRENCY_STDLIB_DECLARATION_TEXT, "from 'sts:concurrency/task';");
  assertStringIncludes(CAPABILITIES_STDLIB_DECLARATION_TEXT, 'export declare function list()');
  assertStringIncludes(TIME_STDLIB_DECLARATION_TEXT, 'export declare class Duration');
  assertStringIncludes(CONSOLE_STDLIB_DECLARATION_TEXT, 'export declare const console');
  assertStringIncludes(PATH_STDLIB_DECLARATION_TEXT, 'export declare function join');
  assertStringIncludes(BYTES_STDLIB_DECLARATION_TEXT, 'export declare const Bytes');
  assertStringIncludes(FS_STDLIB_DECLARATION_TEXT, 'export declare function readText');
  assertStringIncludes(ENV_STDLIB_DECLARATION_TEXT, 'export declare function get');
  assertStringIncludes(CLI_STDLIB_DECLARATION_TEXT, 'export declare function args');
  assertStringIncludes(PROCESS_STDLIB_DECLARATION_TEXT, 'export declare function cwd');
  assertStringIncludes(HTTP_STDLIB_DECLARATION_TEXT, 'export declare function serve');
  assertStringIncludes(NET_STDLIB_DECLARATION_TEXT, 'export declare function lookup');
});

Deno.test('std package support rewrites generated relative stdlib declaration imports away from .ts sources', () => {
  assertStringIncludes(JSON_STDLIB_DECLARATION_TEXT, "import { type Numeric } from './numerics';");
});

Deno.test('stdlib source tree no longer carries checked-in .d.ts files', async () => {
  const declarationFileNames: string[] = [];
  for await (const entry of Deno.readDir(new URL('../stdlib/', import.meta.url))) {
    if (entry.isFile && entry.name.endsWith('.d.ts')) {
      declarationFileNames.push(entry.name);
    }
  }
  assertEquals(declarationFileNames, []);
});

Deno.test('std package support resolves declaration runtime paths relative to locally staged compiled binaries', async () => {
  const tempDirectory = await Deno.makeTempDir();
  try {
    const execPath = `${tempDirectory}/bin/soundscript`;
    const fallbackFilePath = `${tempDirectory}/bin/src/stdlib/index.d.ts`;
    await Deno.mkdir(`${tempDirectory}/bin/src/stdlib`, { recursive: true });
    await Deno.writeTextFile(fallbackFilePath, 'export type RuntimePrelude = true;\n');

    const resolved = resolveStdlibDeclarationRuntimePath('/missing/source/tree/index.d.ts', {
      execPath,
    });

    assertEquals(resolved, fallbackFilePath);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true });
  }
});

Deno.test('std package support resolves nested stdlib declaration runtime paths without dropping subdirectories', async () => {
  const tempDirectory = await Deno.makeTempDir();
  try {
    const execPath = `${tempDirectory}/bin/soundscript`;
    const fallbackFilePath = `${tempDirectory}/bin/src/stdlib/web/dom.d.ts`;
    await Deno.mkdir(`${tempDirectory}/bin/src/stdlib/web`, { recursive: true });
    await Deno.writeTextFile(fallbackFilePath, 'export type RuntimeWebDom = true;\n');

    const resolved = resolveStdlibDeclarationRuntimePath(
      '/missing/source/tree/src/stdlib/web/dom.d.ts',
      {
        execPath,
      },
    );

    assertEquals(resolved, fallbackFilePath);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true });
  }
});

Deno.test('std package support still resolves declaration runtime paths relative to packaged cli targets', async () => {
  const tempDirectory = await Deno.makeTempDir();
  try {
    const execPath = `${tempDirectory}/bin/soundscript`;
    const fallbackFilePath = `${tempDirectory}/src/stdlib/index.d.ts`;
    await Deno.mkdir(`${tempDirectory}/src/stdlib`, { recursive: true });
    await Deno.writeTextFile(fallbackFilePath, 'export type PackagedPrelude = true;\n');

    const resolved = resolveStdlibDeclarationRuntimePath('/missing/source/tree/index.d.ts', {
      execPath,
    });

    assertEquals(resolved, fallbackFilePath);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true });
  }
});
