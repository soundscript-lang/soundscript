import { assertEquals } from '@std/assert';

import { createMacroVmModuleEvaluator } from './macro_vm.ts';

Deno.test('createMacroVmModuleEvaluator evaluates modules in a separate global context', () => {
  const evaluator = createMacroVmModuleEvaluator();
  const exports = evaluator.evaluateCommonJsModule(
    'module.exports.makeArray = () => Array.of(1);',
    {
      crypto,
      exports: {},
      fileName: '/virtual/module.cjs',
      globalThis,
      math: Math,
      require() {
        throw new Error('Unexpected require() in macro vm test.');
      },
    },
  ) as {
    makeArray(): unknown;
  };

  const array = exports.makeArray();
  assertEquals(Array.isArray(array), true);
  assertEquals(array instanceof Array, false);
});

Deno.test('createMacroVmModuleEvaluator rejects constructor-chain string code generation', () => {
  const evaluator = createMacroVmModuleEvaluator();
  const exports = evaluator.evaluateCommonJsModule(
    [
      'function capture(run) {',
      '  try {',
      '    run();',
      "    return 'allowed';",
      '  } catch (error) {',
      '    return error instanceof Error ? error.message : String(error);',
      '  }',
      '}',
      'module.exports.results = [',
      '  capture(() => globalThis.constructor.constructor("return globalThis")()),',
      '  capture(() => Array.constructor("return globalThis")()),',
      '  capture(() => ({}).constructor.constructor("return globalThis")()),',
      '  capture(() => (function () {}).constructor("return globalThis")()),',
      '  capture(() => (async function () {}).constructor("return globalThis")()),',
      '  capture(() => (function* () {}).constructor("return globalThis")()),',
      '  capture(() => (async function* () {}).constructor("return globalThis")()),',
      '];',
    ].join('\n'),
    {
      crypto,
      exports: {},
      fileName: '/virtual/module.cjs',
      globalThis: evaluator.globalObject,
      math: evaluator.globalObject.Math,
      require() {
        throw new Error('Unexpected require() in macro vm test.');
      },
    },
  ) as {
    results: string[];
  };

  assertEquals(
    Array.from(exports.results),
    Array.from(
      { length: 7 },
      () =>
        'Macro module uses unsupported ambient runtime API "Function". Portable macro modules must be deterministic and use ctx.host for explicit IO.',
    ),
  );
});
