import { assertEquals } from '@std/assert';

import { err, isErr, isOk, ok } from '@soundscript/soundscript/result';

import {
  array,
  bigintEncoder,
  booleanEncoder,
  EncodeFailure,
  encoderContravariant,
  lazy,
  literal,
  nullable,
  numberEncoder,
  object,
  option as encodeOption,
  optional,
  result as encodeResult,
  stringEncoder,
  tuple,
} from './encode.ts';
import { none, some } from './result.ts';

function toTaggedPlain(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const candidate = value as { error?: unknown; tag?: string; value?: unknown };
  if (candidate.tag === 'ok') {
    return { tag: 'ok', value: toTaggedPlain(candidate.value) };
  }
  if (candidate.tag === 'err') {
    return { tag: 'err', error: toTaggedPlain(candidate.error) };
  }
  if (candidate.tag === 'some') {
    return { tag: 'some', value: toTaggedPlain(candidate.value) };
  }
  if (candidate.tag === 'none') {
    return { tag: 'none' };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toTaggedPlain(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toTaggedPlain(entry)]),
    );
  }
  return value;
}

function assertTaggedEquals(actual: unknown, expected: unknown): void {
  assertEquals(toTaggedPlain(actual), toTaggedPlain(expected));
}

Deno.test('encode array and object combinators encode structured values', () => {
  const UserEncoder = object({
    age: optional(numberEncoder),
    id: stringEncoder,
    nickname: nullable(stringEncoder),
    tags: array(stringEncoder),
  });

  assertTaggedEquals(
    UserEncoder.encode({
      age: undefined,
      id: 'user-1',
      nickname: null,
      tags: ['a', 'b'],
    }),
    {
      tag: 'ok',
      value: {
        age: undefined,
        id: 'user-1',
        nickname: null,
        tags: ['a', 'b'],
      },
    },
  );
});

Deno.test('encode object encodes nested shapes and optional properties', () => {
  const UserEncoder = object({
    active: booleanEncoder,
    id: stringEncoder,
    nickname: optional(stringEncoder),
    total: bigintEncoder,
  });

  assertTaggedEquals(
    UserEncoder.encode({
      active: true,
      id: 'user-1',
      nickname: undefined,
      total: 12n,
    }),
    {
      tag: 'ok',
      value: {
        active: true,
        id: 'user-1',
        nickname: undefined,
        total: 12n,
      },
    },
  );
});

Deno.test('encode literal rejects mismatched values with EncodeFailure', () => {
  const encoder = literal('user');

  const result = encoder.encode('admin' as unknown as 'user');

  assertEquals(isErr(result), true);
  if (isOk(result)) {
    throw new Error('expected literal encoder to fail');
  }

  assertEquals(result.error instanceof EncodeFailure, true);
  assertEquals(result.error.message, 'Expected literal "user".');
});

Deno.test('encode contravariant instance adapts encoder inputs', () => {
  type UserId = { readonly value: string };

  const UserIdEncoder = encoderContravariant<string>().contramap(
    stringEncoder,
    (id: UserId) => id.value,
  );

  assertTaggedEquals(UserIdEncoder.encode({ value: 'user-1' }), {
    tag: 'ok',
    value: 'user-1',
  });
});

Deno.test('encode object forwards field encoder failures', () => {
  const RejectingBigintEncoder = {
    encode(value: bigint) {
      return value < 0n ? err(new Error('negative')) : ok(value);
    },
  };

  const UserEncoder = object({
    total: RejectingBigintEncoder,
  });

  const result = UserEncoder.encode({ total: -1n });
  assertEquals(isErr(result), true);
});

Deno.test('encode array encodes each entry through the item encoder', () => {
  const result = array(stringEncoder).encode(['a', 'b']);

  assertTaggedEquals(result, { tag: 'ok', value: ['a', 'b'] });
});

Deno.test('encode lazy resolves the underlying helper at encode time', () => {
  let calls = 0;
  const encoder = lazy(() => {
    calls += 1;
    return stringEncoder;
  });

  assertTaggedEquals(encoder.encode('ok'), { tag: 'ok', value: 'ok' });
  assertEquals(calls, 1);
});

Deno.test('encode option and result encode tagged result-family values', () => {
  const UserOption = encodeOption(stringEncoder);
  const UserResult = encodeResult(stringEncoder, bigintEncoder);

  assertTaggedEquals(UserOption.encode(some('user-1')), {
    tag: 'ok',
    value: {
      tag: 'some',
      value: 'user-1',
    },
  });
  assertTaggedEquals(UserOption.encode(none()), {
    tag: 'ok',
    value: {
      tag: 'none',
    },
  });
  assertTaggedEquals(UserResult.encode(ok('user-1')), {
    tag: 'ok',
    value: {
      tag: 'ok',
      value: 'user-1',
    },
  });
  assertTaggedEquals(UserResult.encode(err(12n)), {
    tag: 'ok',
    value: {
      error: 12n,
      tag: 'err',
    },
  });
});

Deno.test('encode tuple encodes fixed heterogeneous arrays', () => {
  const Pair = tuple(stringEncoder, bigintEncoder);

  assertTaggedEquals(Pair.encode(['user-1', 12n]), {
    tag: 'ok',
    value: ['user-1', 12n],
  });
});
