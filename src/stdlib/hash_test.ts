import { assertEquals } from '@std/assert';

import {
  arrayHash,
  booleanHash,
  contramap,
  fromHashEq,
  lazyHashEq,
  numberHash,
  optionHash,
  resultHash,
  stringHash,
  tupleHash,
} from './hash.ts';
import { err, none, ok, some } from './result.ts';

Deno.test('hash fromHashEq returns a shared hash and equality contract', () => {
  const byLength = fromHashEq<string>(
    (value: string) => value.length,
    (left: string, right: string) => left.length === right.length,
  );

  assertEquals(byLength.hash('aa'), 2);
  assertEquals(byLength.equals('aa', 'bb'), true);
  assertEquals(byLength.equals('aa', 'bbb'), false);
});

Deno.test('hash contramap projects a HashEq across a key function', () => {
  const byId = contramap(stringHash, (value: { id: string; name: string }) => value.id);

  assertEquals(
    byId.hash({ id: 'user-1', name: 'A' }),
    stringHash.hash('user-1'),
  );
  assertEquals(
    byId.equals(
      { id: 'user-1', name: 'A' },
      { id: 'user-1', name: 'B' },
    ),
    true,
  );
  assertEquals(
    byId.equals(
      { id: 'user-1', name: 'A' },
      { id: 'user-2', name: 'A' },
    ),
    false,
  );
});

Deno.test('hash primitive helpers stay stable for equal primitive values', () => {
  assertEquals(stringHash.hash('same'), stringHash.hash('same'));
  assertEquals(numberHash.hash(42), numberHash.hash(42));
  assertEquals(booleanHash.hash(true), booleanHash.hash(true));
  assertEquals(booleanHash.equals(true, true), true);
  assertEquals(booleanHash.equals(true, false), false);
});

Deno.test('hash arrayHash combines array item hashes and equality', () => {
  const hashEq = arrayHash(stringHash);

  assertEquals(hashEq.equals(['a', 'b'], ['a', 'b']), true);
  assertEquals(hashEq.equals(['a', 'b'], ['b', 'a']), false);
  assertEquals(hashEq.hash(['a', 'b']), hashEq.hash(['a', 'b']));
});

Deno.test('hash lazyHashEq resolves the underlying helper at use time', () => {
  let calls = 0;
  const hashEq = lazyHashEq(() => {
    calls += 1;
    return stringHash;
  });

  assertEquals(hashEq.equals('a', 'a'), true);
  assertEquals(hashEq.hash('a'), stringHash.hash('a'));
  assertEquals(calls, 2);
});

Deno.test('hash optionHash and resultHash preserve tagged result-family equality', () => {
  const optionalUsers = optionHash(stringHash);
  const resultUsers = resultHash(stringHash, stringHash);

  assertEquals(optionalUsers.equals(some('a'), some('a')), true);
  assertEquals(optionalUsers.equals(some('a'), none()), false);
  assertEquals(optionalUsers.equals(none(), none()), true);
  assertEquals(optionalUsers.hash(some('a')), optionalUsers.hash(some('a')));

  assertEquals(resultUsers.equals(ok('a'), ok('a')), true);
  assertEquals(resultUsers.equals(err('x'), err('x')), true);
  assertEquals(resultUsers.equals(err('x'), ok('x')), false);
  assertEquals(resultUsers.hash(ok('a')), resultUsers.hash(ok('a')));
  assertEquals(resultUsers.hash(err('x')), resultUsers.hash(err('x')));
});

Deno.test('hash tupleHash preserves tuple length and element order', () => {
  const hashEq = tupleHash(stringHash, stringHash);

  assertEquals(hashEq.equals(['a', 'b'], ['a', 'b']), true);
  assertEquals(hashEq.equals(['a', 'b'], ['b', 'a']), false);
  assertEquals(hashEq.equals(['a', 'b'], ['a'] as unknown as [string, string]), false);
  assertEquals(hashEq.hash(['a', 'b']), hashEq.hash(['a', 'b']));
});
