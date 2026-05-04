import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, fromFileUrl, join } from '@std/path';

import {
  createInstalledStdlibPackageFiles,
  writeInstalledStdlibPackage,
} from './test_installed_stdlib.ts';

const textDecoder = new TextDecoder();
const typescriptCliPath = fromFileUrl(
  new URL('../../node_modules/typescript/bin/tsc', import.meta.url),
);

interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

async function writeProjectFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const filePath = join(root, relativePath);
  await Deno.mkdir(dirname(filePath), { recursive: true });
  await Deno.writeTextFile(filePath, contents);
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const output = await new Deno.Command(command, {
    args: [...args],
    cwd,
    stderr: 'piped',
    stdout: 'piped',
  }).output();

  return {
    code: output.code,
    stderr: textDecoder.decode(output.stderr),
    stdout: textDecoder.decode(output.stdout),
  };
}

function assertCommandSucceeded(label: string, result: CommandResult): void {
  assertEquals(
    result.code,
    0,
    `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

Deno.test('installed stdlib package hides experimental and thunk module exports', () => {
  const files = createInstalledStdlibPackageFiles('/virtual');
  const packageJsonText = files.get('/virtual/node_modules/@soundscript/soundscript/package.json');

  assert(packageJsonText);

  const packageJson = JSON.parse(packageJsonText) as {
    exports?: Record<string, unknown>;
    soundscript?: {
      exports?: Record<string, unknown>;
    };
  };

  assertEquals(packageJson.exports?.['./thunk'], undefined);
  assertEquals(packageJson.exports?.['./experimental/thunk'], undefined);
  assertEquals(packageJson.exports?.['./experimental/sql'], undefined);
  assertEquals(packageJson.exports?.['./experimental/css'], undefined);
  assertEquals(packageJson.exports?.['./experimental/graphql'], undefined);
  assertEquals(packageJson.exports?.['./experimental/component'], undefined);
  assertEquals(packageJson.exports?.['./experimental/debug'], undefined);

  assertEquals(packageJson.soundscript?.exports?.['./thunk'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/thunk'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/sql'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/css'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/graphql'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/component'], undefined);
  assertEquals(packageJson.soundscript?.exports?.['./experimental/debug'], undefined);

  assert(
    files.has('/virtual/node_modules/@soundscript/soundscript/soundscript/experimental/thunk.sts'),
  );
  assert(
    files.has('/virtual/node_modules/@soundscript/soundscript/soundscript/experimental/sql.sts'),
  );
});

Deno.test('installed stdlib package exposes runnable stable runtime entrypoints', () => {
  const files = createInstalledStdlibPackageFiles('/virtual');
  const packageJsonText = files.get('/virtual/node_modules/@soundscript/soundscript/package.json');

  assert(packageJsonText);

  const packageJson = JSON.parse(packageJsonText) as {
    exports?: Record<string, { import?: string; types?: string }>;
  };

  assertEquals(packageJson.exports?.['.']?.import, './index.js');
  assertEquals(packageJson.exports?.['./result']?.import, './result.js');
  assertEquals(packageJson.exports?.['./crypto']?.import, './crypto.js');
  assertEquals(packageJson.exports?.['./crypto']?.types, './crypto.d.ts');
  assertEquals(packageJson.exports?.['./crypto/digest']?.import, './crypto/digest.js');
  assertEquals(packageJson.exports?.['./crypto/hmac']?.import, './crypto/hmac.js');
  assertEquals(packageJson.exports?.['./process/command']?.import, './process/command.js');
  assertEquals(packageJson.exports?.['./process/signals']?.import, './process/signals.js');
  assertEquals(packageJson.exports?.['./net/tcp']?.import, './net/tcp.js');
  assertEquals(packageJson.exports?.['./net/tcp']?.types, './net/tcp.d.ts');
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/index.js'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/result.js'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/crypto.js'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/crypto.d.ts'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/crypto/digest.js'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/crypto/hmac.js'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/process/command.js'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/process/signals.js'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/net/tcp.js'));
  assert(files.has('/virtual/node_modules/@soundscript/soundscript/net/tcp.d.ts'));
});

Deno.test('installed stdlib package emits parser-stable soundscript sources for typeclasses', () => {
  const files = createInstalledStdlibPackageFiles('/virtual');
  const publishedTypeclasses = files.get(
    '/virtual/node_modules/@soundscript/soundscript/soundscript/typeclasses.sts',
  );

  assert(publishedTypeclasses);
  assertEquals(publishedTypeclasses.includes('constructor(readonly effect'), false);
  assertEquals(publishedTypeclasses.includes('= <A>('), false);
  assertStringIncludes(publishedTypeclasses, 'function bind<A>(effect: BoundEffect<F, A>): A {');
  assertStringIncludes(publishedTypeclasses, 'function runtime<F extends TypeLambda, T>(');
});

Deno.test('installed stdlib package resolves stable runtime subpaths from plain Node ESM consumers', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-installed-runtime-' });
  await writeInstalledStdlibPackage(root);
  await writeProjectFile(
    root,
    'consumer.mjs',
    [
      "import { defaulted, nullable, optional, readonlyRecord, string } from '@soundscript/soundscript/decode';",
      "import { Crypto } from '@soundscript/soundscript/crypto';",
      "import { Digest } from '@soundscript/soundscript/crypto/digest';",
      "import { Hmac } from '@soundscript/soundscript/crypto/hmac';",
      "import { emptyJsonRecord, isJsonObject, mergeJsonRecords } from '@soundscript/soundscript/json';",
      "import { Tcp } from '@soundscript/soundscript/net/tcp';",
      "import { Command } from '@soundscript/soundscript/process/command';",
      "import { Signals } from '@soundscript/soundscript/process/signals';",
      "import { collect, err, mapErr, ok, some, tapErr, unwrapOr, unwrapOrElse, unwrapOrThrow } from '@soundscript/soundscript/result';",
      '',
      "const decodedName = defaulted(optional(string), 'anon').decode(undefined);",
      "if (decodedName.tag !== 'ok' || decodedName.value !== 'anon') {",
      "  throw new Error('defaulted decoder did not provide its fallback.');",
      '}',
      '',
      "const decodedRecord = readonlyRecord(nullable(string)).decode({ first: 'ok', second: null });",
      "if (decodedRecord.tag !== 'ok') {",
      '  throw decodedRecord.error;',
      '}',
      '',
      "const digest = await Crypto.digest('SHA-256', new TextEncoder().encode('soundscript'));",
      "if (digest.tag !== 'ok' || digest.value.byteLength !== 32) {",
      "  throw new Error('expected SHA-256 digest bytes.');",
      '}',
      'void Digest;',
      'void Hmac;',
      'void Tcp;',
      'void Command;',
      'void Signals;',
      '',
      'const merged = mergeJsonRecords(emptyJsonRecord(), { tags: decodedRecord.value });',
      'if (!isJsonObject(merged)) {',
      "  throw new Error('expected merged json object.');",
      '}',
      '',
      'const collected = collect([ok(1), ok(2)]);',
      "if (collected.tag !== 'ok') {",
      '  throw collected.error;',
      '}',
      '',
      "let tapped = '';",
      "tapErr(err('bad'), (error) => {",
      '  tapped = error;',
      '});',
      "const mapped = mapErr(err('bad'), (error) => `ERR:${error}`);",
      "if (mapped.tag !== 'err') {",
      "  throw new Error('expected mapped err result.');",
      '}',
      '',
      'console.log(JSON.stringify({',
      '  collected: collected.value,',
      "  fallback: unwrapOr(err('missing'), 7),",
      "  recovered: unwrapOrElse(err('boom'), (error) => error.length),",
      '  required: unwrapOrThrow(ok(9)),',
      '  present: unwrapOrThrow(some("user")),',
      '  keys: Object.keys(merged).sort(),',
      '  mapped: mapped.error,',
      '  tapped,',
      '}));',
      '',
    ].join('\n'),
  );

  const result = await runCommand('node', ['consumer.mjs'], root);
  assertCommandSucceeded('node consumer should resolve installed stdlib runtime subpaths', result);
  assertStringIncludes(result.stdout, '"keys":["tags"]');
  assertStringIncludes(result.stdout, '"mapped":"ERR:bad"');
  assertStringIncludes(result.stdout, '"tapped":"bad"');
});

Deno.test('installed stdlib package declarations resolve from plain TypeScript NodeNext consumers', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-installed-types-' });
  await writeInstalledStdlibPackage(root);
  await writeProjectFile(
    root,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          target: 'ES2022',
          verbatimModuleSyntax: true,
        },
        include: ['consumer.mts'],
      },
      null,
      2,
    ),
  );
  await writeProjectFile(
    root,
    'consumer.mts',
    [
      "import { defaulted, nullable, optional, readonlyRecord, string } from '@soundscript/soundscript/decode';",
      "import { Crypto, type DigestAlgorithm } from '@soundscript/soundscript/crypto';",
      "import { copyJsonRecord, emptyJsonRecord, isJsonObject, mergeJsonRecords, type JsonValue } from '@soundscript/soundscript/json';",
      "import { collect, err, mapErr, ok, some, tapErr, unwrapOr, unwrapOrElse, unwrapOrThrow, type Result } from '@soundscript/soundscript/result';",
      '',
      "const decodedName = defaulted(optional(string), 'anon').decode(undefined);",
      "const decodedRecord = readonlyRecord(nullable(string)).decode({ first: 'ok', second: null });",
      'const sourceJson: Readonly<Record<string, JsonValue>> = { feature: true };',
      "const digestAlgorithm: DigestAlgorithm = 'SHA-256';",
      'const digest = Crypto.digest(digestAlgorithm, new Uint8Array());',
      'const copiedJson = copyJsonRecord(sourceJson);',
      'const mergedJson = mergeJsonRecords(emptyJsonRecord(), copiedJson);',
      'const collected = collect([ok(1), ok(2)] as const);',
      "const mapped = mapErr(err('bad'), (error) => error.length);",
      'const seen: string[] = [];',
      "const tapped: Result<number, string> = tapErr(err('bad'), (error) => {",
      '  seen.push(error);',
      '});',
      "const fallback = unwrapOr(err('bad'), 0);",
      "const recovered = unwrapOrElse(err('bad'), (error) => error.length);",
      'const required = unwrapOrThrow(ok(1));',
      'const present = unwrapOrThrow(some("user"));',
      '',
      'if (isJsonObject(mergedJson)) {',
      '  const feature: JsonValue | undefined = mergedJson.feature;',
      '  void feature;',
      '}',
      '',
      'void decodedName;',
      'void decodedRecord;',
      'void digest;',
      'void collected;',
      'void mapped;',
      'void tapped;',
      'void fallback;',
      'void recovered;',
      'void required;',
      'void present;',
      'void seen;',
      '',
    ].join('\n'),
  );

  const result = await runCommand(
    'node',
    [typescriptCliPath, '--project', join(root, 'tsconfig.json')],
    root,
  );
  assertCommandSucceeded(
    'TypeScript NodeNext consumer should resolve installed stdlib declarations',
    result,
  );
});
