import { assertEquals, assertStringIncludes } from '@std/assert';
import ts from 'typescript';

import {
  createSoundStdlibCompilerHost,
  resolveBundledTypesDirectory,
} from '../bundled/sound_stdlib.ts';
import {
  ASYNC_STDLIB_DECLARATION_FILE,
  ASYNC_STDLIB_DECLARATION_TEXT,
  ASYNC_STDLIB_MODULE_SPECIFIER,
  CODEC_STDLIB_DECLARATION_FILE,
  CODEC_STDLIB_DECLARATION_TEXT,
  CODEC_STDLIB_MODULE_SPECIFIER,
  COMPARE_STDLIB_DECLARATION_FILE,
  COMPARE_STDLIB_DECLARATION_TEXT,
  COMPARE_STDLIB_MODULE_SPECIFIER,
  DEBUG_STDLIB_DECLARATION_TEXT,
  DECODE_STDLIB_DECLARATION_FILE,
  DECODE_STDLIB_DECLARATION_TEXT,
  DECODE_STDLIB_MODULE_SPECIFIER,
  FETCH_STDLIB_DECLARATION_FILE,
  FETCH_STDLIB_DECLARATION_TEXT,
  FETCH_STDLIB_MODULE_SPECIFIER,
  HASH_STDLIB_DECLARATION_FILE,
  HASH_STDLIB_DECLARATION_TEXT,
  HASH_STDLIB_MODULE_SPECIFIER,
  HKT_STDLIB_DECLARATION_FILE,
  HKT_STDLIB_DECLARATION_TEXT,
  HKT_STDLIB_MODULE_SPECIFIER,
  JSON_STDLIB_DECLARATION_FILE,
  JSON_STDLIB_DECLARATION_TEXT,
  JSON_STDLIB_MODULE_SPECIFIER,
  MATCH_STDLIB_DECLARATION_FILE,
  MATCH_STDLIB_DECLARATION_TEXT,
  MATCH_STDLIB_MODULE_SPECIFIER,
  NUMERICS_STDLIB_DECLARATION_FILE,
  NUMERICS_STDLIB_DECLARATION_TEXT,
  NUMERICS_STDLIB_MODULE_SPECIFIER,
  RANDOM_STDLIB_DECLARATION_FILE,
  RANDOM_STDLIB_DECLARATION_TEXT,
  RANDOM_STDLIB_MODULE_SPECIFIER,
  resolveStdlibDeclarationRuntimePath,
  RESULT_STDLIB_DECLARATION_FILE,
  RESULT_STDLIB_DECLARATION_TEXT,
  RESULT_STDLIB_MODULE_SPECIFIER,
  STDLIB_DECLARATION_FILE,
  STDLIB_DECLARATION_TEXT,
  STDLIB_MODULE_SPECIFIER,
  TEXT_STDLIB_DECLARATION_FILE,
  TEXT_STDLIB_DECLARATION_TEXT,
  TEXT_STDLIB_MODULE_SPECIFIER,
  URL_STDLIB_DECLARATION_FILE,
  URL_STDLIB_DECLARATION_TEXT,
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
    asyncResolved,
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
        ASYNC_STDLIB_MODULE_SPECIFIER,
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
  assertEquals(asyncResolved?.resolvedFileName, ASYNC_STDLIB_DECLARATION_FILE);
  assertEquals(numericsResolved?.resolvedFileName, NUMERICS_STDLIB_DECLARATION_FILE);
});

Deno.test(
  'std package support preserves bundled type-module resolution for resolveModuleNameLiterals',
  () => {
    const compilerOptions = {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      types: ['node'],
    };
    const host = withStdPackageModuleResolution(createSoundStdlibCompilerHost(compilerOptions));
    const containingFile = `${resolveBundledTypesDirectory()}/node/http.d.ts`;
    const resolved = host.resolveModuleNameLiterals?.(
      [{ text: 'undici-types' } as ts.StringLiteralLike],
      containingFile,
      undefined,
      compilerOptions,
      ts.createSourceFile(containingFile, '', ts.ScriptTarget.ES2022, true),
      undefined,
    );

    assertEquals(
      resolved?.[0]?.resolvedModule?.resolvedFileName.endsWith(
        '/node_modules/undici-types/index.d.ts',
      ),
      true,
    );
  },
);

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

Deno.test('std package support projects implementation effects onto generated async overload declarations', () => {
  assertStringIncludes(ASYNC_STDLIB_DECLARATION_TEXT, '// #[effects(add: [])]');
  assertStringIncludes(
    ASYNC_STDLIB_DECLARATION_TEXT,
    'export declare function fromPromise<T>(fn: (signal?: AbortSignalLike) => Promise<T>): Task<T, Error>;',
  );
});

Deno.test('std package support rewrites generated relative stdlib declaration imports away from .ts sources', () => {
  assertStringIncludes(JSON_STDLIB_DECLARATION_TEXT, "import { type Numeric } from './numerics';");
});

Deno.test('stdlib source tree no longer carries checked-in .d.ts files', async () => {
  const declarationFileNames: string[] = [];
  for await (const entry of Deno.readDir(new URL('../stdlib', import.meta.url))) {
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
    const fallbackFilePath = `${tempDirectory}/bin/src/stdlib/host/dom.d.ts`;
    await Deno.mkdir(`${tempDirectory}/bin/src/stdlib/host`, { recursive: true });
    await Deno.writeTextFile(fallbackFilePath, 'export type RuntimeHostDom = true;\n');

    const resolved = resolveStdlibDeclarationRuntimePath(
      '/missing/source/tree/src/stdlib/host/dom.d.ts',
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
