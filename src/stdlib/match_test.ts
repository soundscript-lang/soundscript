import { assertEquals, assertThrows } from '@std/assert';

import { where } from './match.ts';

Deno.test('match where returns a guarded arm wrapper', () => {
  const guarded = where(
    (value: number) => value * 2,
    (value) => value > 1,
  );

  assertEquals(guarded(2), 4);
});

Deno.test('match where throws when evaluated outside Match guard lowering', () => {
  const guarded = where(
    (value: number) => value * 2,
    (value) => value > 10,
  );

  assertThrows(
    () => guarded(2),
    Error,
    'where(...) is intended for Match(...) guard arms',
  );
});
