import { assertEquals } from '@std/assert';

import { detectRuntimeTypeScriptSupport } from './transform.ts';

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
