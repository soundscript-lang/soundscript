import { assertEquals } from '@std/assert';
import ts from 'typescript';

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
  DECODE_STDLIB_DECLARATION_FILE,
  DECODE_STDLIB_DECLARATION_TEXT,
  DECODE_STDLIB_MODULE_SPECIFIER,
  ENCODE_STDLIB_DECLARATION_FILE,
  ENCODE_STDLIB_DECLARATION_TEXT,
  ENCODE_STDLIB_MODULE_SPECIFIER,
  FETCH_STDLIB_DECLARATION_FILE,
  FETCH_STDLIB_DECLARATION_TEXT,
  FETCH_STDLIB_MODULE_SPECIFIER,
  HASH_STDLIB_DECLARATION_FILE,
  HASH_STDLIB_DECLARATION_TEXT,
  HASH_STDLIB_MODULE_SPECIFIER,
  HOST_DOM_DECLARATION_FILE,
  HOST_DOM_MODULE_SPECIFIER,
  HOST_NODE_DECLARATION_FILE,
  HOST_NODE_MODULE_SPECIFIER,
  HKT_STDLIB_DECLARATION_FILE,
  HKT_STDLIB_DECLARATION_TEXT,
  HKT_STDLIB_MODULE_SPECIFIER,
  JSON_STDLIB_DECLARATION_FILE,
  JSON_STDLIB_DECLARATION_TEXT,
  JSON_STDLIB_MODULE_SPECIFIER,
  METADATA_STDLIB_DECLARATION_FILE,
  METADATA_STDLIB_DECLARATION_TEXT,
  METADATA_STDLIB_MODULE_SPECIFIER,
  MATCH_STDLIB_DECLARATION_FILE,
  MATCH_STDLIB_DECLARATION_TEXT,
  MATCH_STDLIB_MODULE_SPECIFIER,
  NUMERICS_STDLIB_DECLARATION_FILE,
  NUMERICS_STDLIB_DECLARATION_TEXT,
  NUMERICS_STDLIB_MODULE_SPECIFIER,
  RANDOM_STDLIB_DECLARATION_FILE,
  RANDOM_STDLIB_DECLARATION_TEXT,
  RANDOM_STDLIB_MODULE_SPECIFIER,
  RESULT_STDLIB_DECLARATION_FILE,
  RESULT_STDLIB_DECLARATION_TEXT,
  RESULT_STDLIB_MODULE_SPECIFIER,
  resolveStdlibDeclarationRuntimePath,
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
    metadataResolved,
    compareResolved,
    hashResolved,
    decodeResolved,
    encodeResolved,
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
        METADATA_STDLIB_MODULE_SPECIFIER,
        COMPARE_STDLIB_MODULE_SPECIFIER,
        HASH_STDLIB_MODULE_SPECIFIER,
        DECODE_STDLIB_MODULE_SPECIFIER,
        ENCODE_STDLIB_MODULE_SPECIFIER,
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
  assertEquals(metadataResolved?.resolvedFileName, METADATA_STDLIB_DECLARATION_FILE);
  assertEquals(compareResolved?.resolvedFileName, COMPARE_STDLIB_DECLARATION_FILE);
  assertEquals(hashResolved?.resolvedFileName, HASH_STDLIB_DECLARATION_FILE);
  assertEquals(decodeResolved?.resolvedFileName, DECODE_STDLIB_DECLARATION_FILE);
  assertEquals(encodeResolved?.resolvedFileName, ENCODE_STDLIB_DECLARATION_FILE);
  assertEquals(codecResolved?.resolvedFileName, CODEC_STDLIB_DECLARATION_FILE);
  assertEquals(asyncResolved?.resolvedFileName, ASYNC_STDLIB_DECLARATION_FILE);
  assertEquals(numericsResolved?.resolvedFileName, NUMERICS_STDLIB_DECLARATION_FILE);
});

Deno.test('std package support resolves host protocol modules only when the underlying host declarations are enabled', () => {
  const host = withStdPackageModuleResolution(ts.createCompilerHost({
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  }));

  const [hostDomResolved, hostNodeResolved] = host.resolveModuleNames!(
    [HOST_DOM_MODULE_SPECIFIER, HOST_NODE_MODULE_SPECIFIER],
    '/virtual/index.ts',
    undefined,
    undefined,
    {
      lib: ['lib.es2024.d.ts', 'lib.dom.d.ts', 'lib.dom.asynciterable.d.ts'],
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      types: ['node'],
    },
  );
  const [hostDomMissing, hostNodeMissing] = host.resolveModuleNames!(
    [HOST_DOM_MODULE_SPECIFIER, HOST_NODE_MODULE_SPECIFIER],
    '/virtual/index.ts',
    undefined,
    undefined,
    {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  );

  assertEquals(hostDomResolved?.resolvedFileName, HOST_DOM_DECLARATION_FILE);
  assertEquals(hostNodeResolved?.resolvedFileName, HOST_NODE_DECLARATION_FILE);
  assertEquals(hostDomMissing, undefined);
  assertEquals(hostNodeMissing, undefined);
});

Deno.test('std package support hkt text stays in sync with the checked-in hkt declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/hkt.d.ts', import.meta.url));
  assertEquals(HKT_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support root text stays in sync with the checked-in root stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/index.d.ts', import.meta.url));
  assertEquals(STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support result text stays in sync with the checked-in result stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/result.d.ts', import.meta.url));
  assertEquals(RESULT_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support match text stays in sync with the checked-in match stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/match.d.ts', import.meta.url));
  assertEquals(MATCH_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support url text stays in sync with the checked-in url stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/url.d.ts', import.meta.url));
  assertEquals(URL_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support fetch text stays in sync with the checked-in fetch stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/fetch.d.ts', import.meta.url));
  assertEquals(FETCH_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support text text stays in sync with the checked-in text stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/text.d.ts', import.meta.url));
  assertEquals(TEXT_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support random text stays in sync with the checked-in random stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/random.d.ts', import.meta.url));
  assertEquals(RANDOM_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support json text stays in sync with the checked-in json stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/json.d.ts', import.meta.url));
  assertEquals(JSON_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support metadata text stays in sync with the checked-in metadata stdlib source file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/metadata.ts', import.meta.url));
  assertEquals(METADATA_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support compare text stays in sync with the checked-in compare stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/compare.d.ts', import.meta.url));
  assertEquals(COMPARE_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support hash text stays in sync with the checked-in hash stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/hash.d.ts', import.meta.url));
  assertEquals(HASH_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support decode text stays in sync with the checked-in decode stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/decode.d.ts', import.meta.url));
  assertEquals(DECODE_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
  assertEquals(fileText.includes('__decodeMode'), false);
});

Deno.test('std package support encode text stays in sync with the checked-in encode stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/encode.d.ts', import.meta.url));
  assertEquals(ENCODE_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
  assertEquals(fileText.includes('__encodeMode'), false);
});

Deno.test('std package support codec text stays in sync with the checked-in codec stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/codec.d.ts', import.meta.url));
  assertEquals(CODEC_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support async text stays in sync with the checked-in async stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/async.d.ts', import.meta.url));
  assertEquals(ASYNC_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support numerics text stays in sync with the checked-in numerics declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/numerics.d.ts', import.meta.url));
  assertEquals(NUMERICS_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});

Deno.test('std package support resolves declaration runtime paths relative to the compiled binary', async () => {
  const tempDirectory = await Deno.makeTempDir();
  try {
    const execPath = `${tempDirectory}/bin/soundscript`;
    const fallbackFilePath = `${tempDirectory}/src/stdlib/index.d.ts`;
    await Deno.mkdir(`${tempDirectory}/src/stdlib`, { recursive: true });
    await Deno.writeTextFile(fallbackFilePath, 'export type RuntimePrelude = true;\n');

    const resolved = resolveStdlibDeclarationRuntimePath('/missing/source/tree/index.d.ts', {
      execPath,
    });

    assertEquals(resolved, fallbackFilePath);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true });
  }
});
