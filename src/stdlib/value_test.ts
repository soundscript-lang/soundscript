import { assertEquals, assertNotStrictEquals, assertStrictEquals } from '@std/assert';

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

Deno.test('value factory canonicalizes shallow runtime tokens without collapsing distinct references', () => {
  const makeBox = __valueFactory<Box, [unknown]>(
    (value) => __valueKey('Box', __valueShallowToken(value)),
    () => Object.create(Box.prototype) as Box,
    (instance, value) => {
      __valueReadonly(instance, 'value', value);
    },
  );

  class Box {
    readonly value!: unknown;

    constructor(value: unknown) {
      return makeBox(value);
    }
  }

  const sharedObject = {};
  const sharedFunction = () => 1;
  const sharedSymbol = Symbol('shared');

  assertStrictEquals(new Box(NaN), new Box(NaN));
  assertStrictEquals(new Box(-0), new Box(0));
  assertStrictEquals(new Box(sharedObject), new Box(sharedObject));
  assertStrictEquals(new Box(sharedFunction), new Box(sharedFunction));
  assertStrictEquals(new Box(sharedSymbol), new Box(sharedSymbol));
  assertStrictEquals(new Box(Symbol.for('stable')), new Box(Symbol.for('stable')));

  assertNotStrictEquals(new Box({}), new Box({}));
  assertNotStrictEquals(new Box(() => 1), new Box(() => 1));
  assertNotStrictEquals(new Box(Symbol('shared')), new Box(Symbol('shared')));
});

Deno.test('value factory canonicalizes nested value instances by modeled value identity', () => {
  const makeLeaf = __valueFactory<Leaf, [number]>(
    (value) => __valueKey('Leaf', __valueShallowToken(value)),
    () => Object.create(Leaf.prototype) as Leaf,
    (instance, value) => {
      __valueReadonly(instance, 'value', value);
    },
  );
  const makeBox = __valueFactory<Box, [Leaf]>(
    (leaf) => __valueKey('Box', __valueShallowToken(leaf)),
    () => Object.create(Box.prototype) as Box,
    (instance, leaf) => {
      __valueReadonly(instance, 'leaf', leaf);
    },
  );

  class Leaf {
    readonly value!: number;

    constructor(value: number) {
      return makeLeaf(value);
    }
  }

  class Box {
    readonly leaf!: Leaf;

    constructor(leaf: Leaf) {
      return makeBox(leaf);
    }
  }

  assertStrictEquals(new Leaf(1), new Leaf(1));
  assertStrictEquals(new Box(new Leaf(1)), new Box(new Leaf(1)));
  assertNotStrictEquals(new Box(new Leaf(1)), new Box(new Leaf(2)));
});
