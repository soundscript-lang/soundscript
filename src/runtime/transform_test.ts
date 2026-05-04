import { assertEquals } from '@std/assert';

import { detectRuntimeTypeScriptSupport, rewriteModuleSpecifiersForEmit } from './transform.ts';

Deno.test('detectRuntimeTypeScriptSupport prefers process.features.typescript when available', () => {
  assertEquals(
    detectRuntimeTypeScriptSupport({
      process: {
        env: {},
        execArgv: [],
        features: { typescript: 'strip' },
        versions: { node: '24.14.0' },
      },
    }),
    'strip',
  );
  assertEquals(
    detectRuntimeTypeScriptSupport({
      process: {
        env: {},
        execArgv: [],
        features: { typescript: 'transform' },
        versions: { node: '24.14.0' },
      },
    }),
    'transform',
  );
  assertEquals(
    detectRuntimeTypeScriptSupport({
      process: {
        env: {},
        execArgv: [],
        features: { typescript: false },
        versions: { node: '24.14.0' },
      },
    }),
    false,
  );
});

Deno.test('detectRuntimeTypeScriptSupport falls back to Node flags and default-enabled releases', () => {
  assertEquals(
    detectRuntimeTypeScriptSupport({
      process: {
        env: {},
        execArgv: ['--experimental-transform-types'],
        versions: { node: '22.17.0' },
      },
    }),
    'transform',
  );
  assertEquals(
    detectRuntimeTypeScriptSupport({
      process: {
        env: { NODE_OPTIONS: '--experimental-strip-types' },
        execArgv: [],
        versions: { node: '22.17.0' },
      },
    }),
    'strip',
  );
  assertEquals(
    detectRuntimeTypeScriptSupport({
      process: {
        env: {},
        execArgv: [],
        versions: { node: '23.6.0' },
      },
    }),
    'strip',
  );
  assertEquals(
    detectRuntimeTypeScriptSupport({
      process: {
        env: {},
        execArgv: [],
        versions: { node: '22.18.0' },
      },
    }),
    'strip',
  );
  assertEquals(
    detectRuntimeTypeScriptSupport({
      process: {
        env: { NODE_OPTIONS: '--no-experimental-strip-types' },
        execArgv: ['--experimental-transform-types'],
        versions: { node: '24.14.0' },
      },
    }),
    false,
  );
});

Deno.test('detectRuntimeTypeScriptSupport treats Deno as direct-TypeScript capable', () => {
  assertEquals(detectRuntimeTypeScriptSupport({ Deno: {} }), 'strip');
});

Deno.test('rewriteModuleSpecifiersForEmit rewrites import type module references', () => {
  const rewritten = rewriteModuleSpecifiersForEmit(
    [
      "import type { Result } from 'sts:result';",
      'export type SyncResult<T> = import("sts:result").Result<T, never>;',
      "export type Decoder<T> = import('sts:decode').Decoder<T>;",
      'export type Plain<T> = Result<T, never>;',
      '',
    ].join('\n'),
    '/virtual/node_modules/@soundscript/soundscript/time.d.ts',
  );

  assertEquals(
    rewritten,
    [
      "import type { Result } from '@soundscript/soundscript/result';",
      'export type SyncResult<T> = import("@soundscript/soundscript/result").Result<T, never>;',
      "export type Decoder<T> = import('@soundscript/soundscript/decode').Decoder<T>;",
      'export type Plain<T> = Result<T, never>;',
      '',
    ].join('\n'),
  );
});

Deno.test('rewriteModuleSpecifiersForEmit lowers extern:globalThis imports to globalThis reads', () => {
  const rewritten = rewriteModuleSpecifiersForEmit(
    [
      '// #[interop]',
      'import { "__app-config__" as config, Deno } from \'extern:globalThis\';',
      '',
      'console.log(config.apiBase, Deno.cwd());',
      '',
    ].join('\n'),
    '/app/index.sts',
  );

  assertEquals(
    rewritten,
    [
      'const config = globalThis["__app-config__"];',
      'const Deno = globalThis.Deno;',
      '',
      'console.log(config.apiBase, Deno.cwd());',
      '',
    ].join('\n'),
  );
});

Deno.test('rewriteModuleSpecifiersForEmit lowers extern:global imports to ambient binding reads', () => {
  const rewritten = rewriteModuleSpecifiersForEmit(
    [
      '// #[interop]',
      "import { __APP_CONFIG__ as config } from 'extern:global';",
      '',
      'console.log(config.apiBase);',
      '',
    ].join('\n'),
    '/app/index.sts',
  );

  assertEquals(
    rewritten,
    [
      'const config = __APP_CONFIG__;',
      '',
      'console.log(config.apiBase);',
      '',
    ].join('\n'),
  );
});
