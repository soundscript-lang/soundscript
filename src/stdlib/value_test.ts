import { assertEquals } from '@std/assert';

import { __valueFactory, __valueKey, __valueReadonly, __valueShallowToken } from './value.ts';

Deno.test('value factory does not trust forged global value ids on shallow reference fields', () => {
  const makeBox = __valueFactory<Box, [object]>(
    (value) => __valueKey('Box', __valueShallowToken(value)),
    () => Object.create(Box.prototype) as Box,
    (instance, value) => {
      __valueReadonly(instance, 'value', value);
    },
  );

  class Box {
    readonly value!: object;

    constructor(value: object) {
      return makeBox(value);
    }
  }

  const left = {
    [Symbol.for('soundscript.value.id')]: 7,
  };
  const right = {
    [Symbol.for('soundscript.value.id')]: 7,
  };

  assertEquals(left === right, false);
  assertEquals(new Box(left) === new Box(right), false);
});
