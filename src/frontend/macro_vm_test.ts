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
