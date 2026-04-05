import { assertEquals } from '@std/assert';

import {
  arrayEq,
  fromCompare,
  lazyEq,
  optionEq,
  type Ordering,
  resultEq,
  reverse,
  stringEq,
  thenBy,
  tupleEq,
} from './compare.ts';
import { err, none, ok, some } from './result.ts';

Deno.test('compare fromCompare normalizes JS-style comparator results', () => {
  const order = fromCompare<number>((left: number, right: number) => left - right);

  assertEquals(order.compare(1, 2), -1);
  assertEquals(order.compare(2, 2), 0);
  assertEquals(order.compare(3, 2), 1);
  assertEquals(order.equals(2, 2), true);
  assertEquals(order.equals(1, 2), false);
});

Deno.test('compare reverse flips an existing order', () => {
  const ascending = fromCompare<number>((left: number, right: number) => left - right);
  const descending = reverse(ascending);

  assertEquals(descending.compare(1, 2), 1);
  assertEquals(descending.compare(2, 1), -1);
  assertEquals(descending.compare(2, 2), 0);
});

Deno.test('compare thenBy uses the secondary comparator when the primary ties', () => {
  const byRank = fromCompare<{ rank: number; name: string }>((
    left: { rank: number; name: string },
    right: { rank: number; name: string },
  ) => left.rank - right.rank);
  const byName = fromCompare<{ rank: number; name: string }>((
    left: { rank: number; name: string },
    right: { rank: number; name: string },
  ) => left.name.localeCompare(right.name));
  const combined = thenBy(byRank, byName);

  assertEquals(
    combined.compare({ rank: 1, name: 'a' }, { rank: 2, name: 'z' }),
    -1,
  );
  assertEquals(
    combined.compare({ rank: 1, name: 'a' }, { rank: 1, name: 'z' }),
    -1,
  );
  assertEquals(
    combined.compare({ rank: 1, name: 'z' }, { rank: 1, name: 'a' }),
    1,
  );
});

Deno.test('compare Ordering remains the normalized compare output type', () => {
  const order = fromCompare<string>((left: string, right: string) => left.length - right.length);
  const value: Ordering = order.compare('aa', 'b');

  assertEquals(value, 1);
});

Deno.test('compare arrayEq compares arrays elementwise', () => {
  const eq = arrayEq(stringEq);

  assertEquals(eq.equals(['a', 'b'], ['a', 'b']), true);
  assertEquals(eq.equals(['a', 'b'], ['a']), false);
  assertEquals(eq.equals(['a', 'b'], ['a', 'c']), false);
});

Deno.test('compare lazyEq resolves the underlying helper at use time', () => {
  let calls = 0;
  const eq = lazyEq(() => {
    calls += 1;
    return stringEq;
  });

  assertEquals(eq.equals('a', 'a'), true);
  assertEquals(eq.equals('a', 'b'), false);
  assertEquals(calls, 2);
});

Deno.test('compare optionEq and resultEq compare tagged result-family values', () => {
  const optionalUsers = optionEq(stringEq);
  const resultUsers = resultEq(stringEq, stringEq);

  assertEquals(optionalUsers.equals(some('a'), some('a')), true);
  assertEquals(optionalUsers.equals(some('a'), some('b')), false);
  assertEquals(optionalUsers.equals(none(), none()), true);
  assertEquals(optionalUsers.equals(some('a'), none()), false);

  assertEquals(resultUsers.equals(ok('a'), ok('a')), true);
  assertEquals(resultUsers.equals(ok('a'), err('x')), false);
  assertEquals(resultUsers.equals(err('x'), err('x')), true);
  assertEquals(resultUsers.equals(err('x'), err('y')), false);
});

Deno.test('compare tupleEq compares fixed tuples elementwise', () => {
  const eq = tupleEq(stringEq, stringEq);

  assertEquals(eq.equals(['a', 'b'], ['a', 'b']), true);
  assertEquals(eq.equals(['a', 'b'], ['a', 'c']), false);
  assertEquals(eq.equals(['a', 'b'], ['a'] as unknown as [string, string]), false);
});
