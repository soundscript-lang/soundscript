import { assertEquals } from '@std/assert';

import { isErr, isOk } from '@soundscript/soundscript/result';

import {
  array,
  bigint,
  defaulted,
  DecodeFailure,
  field,
  lazy,
  literal,
  nullable,
  number,
  object,
  option as decodeOption,
  optional,
  optionalField,
  refine,
  readonlyRecord,
  result as decodeResult,
  string,
  tuple,
  union,
} from './decode.ts';

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

Deno.test('decode object decodes nested shapes and optional properties', () => {
  const UserDecoder = object({
    id: string,
    tags: array(string),
    nickname: optional(string),
  });

  const decoded = UserDecoder.decode({
    id: 'user-1',
    tags: ['one', 'two'],
  });

  assertTaggedEquals(decoded, {
    tag: 'ok',
    value: {
      id: 'user-1',
      tags: ['one', 'two'],
      nickname: undefined,
    },
  });
});

Deno.test('decode object prepends property and array path segments', () => {
  const UserDecoder = object({
    id: string,
    tags: array(string),
  });

  const decoded = UserDecoder.decode({
    id: 'user-1',
    tags: ['ok', 2],
  });

  assertEquals(isErr(decoded), true);
  if (isOk(decoded)) {
    throw new Error('expected nested decode failure');
  }

  assertEquals(decoded.error instanceof DecodeFailure, true);
  assertEquals(decoded.error.path, ['tags', 1]);
});

Deno.test('decode field and optionalField read object members directly', () => {
  const name = field('name', string).decode({ name: 'ok' });
  const nickname = optionalField('nickname', string).decode({});
  const nicknameWithDefault = defaulted(optionalField('nickname', string), 'anon').decode({});
  const missing = field('name', string).decode({});

  assertTaggedEquals(name, { tag: 'ok', value: 'ok' });
  assertTaggedEquals(nickname, { tag: 'ok', value: undefined });
  assertTaggedEquals(nicknameWithDefault, { tag: 'ok', value: 'anon' });
  assertEquals(isErr(missing), true);
  if (isOk(missing)) {
    throw new Error('expected required field failure');
  }

  assertEquals(missing.error instanceof DecodeFailure, true);
  assertEquals(missing.error.path, ['name']);
});

Deno.test('decode union and refine reject unmatched values with DecodeFailure', () => {
  const Status = union(literal('ok'), literal('err'));
  const PositiveInt = refine(
    number,
    (value: number): value is number => Number.isInteger(value) && value > 0,
    'Expected a positive integer.',
  );

  assertTaggedEquals(Status.decode('ok'), { tag: 'ok', value: 'ok' });

  const badStatus = Status.decode('maybe');
  const badNumber = PositiveInt.decode(-1);

  assertEquals(isErr(badStatus), true);
  if (isOk(badStatus)) {
    throw new Error('expected union failure');
  }
  assertEquals(badStatus.error instanceof DecodeFailure, true);

  assertEquals(isErr(badNumber), true);
  if (isOk(badNumber)) {
    throw new Error('expected refine failure');
  }
  assertEquals(badNumber.error instanceof DecodeFailure, true);
  assertEquals(badNumber.error.message, 'Expected a positive integer.');
});

Deno.test('decode nullable accepts null and readonlyRecord decodes record values with key paths', () => {
  assertTaggedEquals(nullable(string).decode(null), { tag: 'ok', value: null });
  assertTaggedEquals(nullable(string).decode('ok'), { tag: 'ok', value: 'ok' });

  const decoded = readonlyRecord(string).decode({ first: 'ok', second: 'yep' });
  assertTaggedEquals(decoded, {
    tag: 'ok',
    value: { first: 'ok', second: 'yep' },
  });

  const badRecord = readonlyRecord(string).decode({ first: 1 });
  assertEquals(isErr(badRecord), true);
  if (isOk(badRecord)) {
    throw new Error('expected readonly record decode failure');
  }
  assertEquals(badRecord.error instanceof DecodeFailure, true);
  assertEquals(badRecord.error.path, ['first']);
});

Deno.test('decode bigint accepts bigint values plus integer strings and safe integers', () => {
  assertTaggedEquals(bigint.decode(12n), { tag: 'ok', value: 12n });
  assertTaggedEquals(bigint.decode('12'), { tag: 'ok', value: 12n });
  assertTaggedEquals(bigint.decode(12), { tag: 'ok', value: 12n });

  const badString = bigint.decode('12.5');
  const unsafeNumber = bigint.decode(Number.MAX_SAFE_INTEGER + 1);

  assertEquals(isErr(badString), true);
  assertEquals(isErr(unsafeNumber), true);
});

Deno.test('decode lazy resolves the underlying helper at decode time', () => {
  let calls = 0;
  const decoder = lazy(() => {
    calls += 1;
    return string;
  });

  assertTaggedEquals(decoder.decode('ok'), { tag: 'ok', value: 'ok' });
  assertEquals(calls, 1);
});

Deno.test('decode option and result decode tagged result-family values', () => {
  const UserOption = decodeOption(string);
  const UserResult = decodeResult(string, number);

  assertTaggedEquals(UserOption.decode({ tag: 'some', value: 'user-1' }), {
    tag: 'ok',
    value: { tag: 'some', value: 'user-1' },
  });
  assertTaggedEquals(UserOption.decode({ tag: 'none' }), {
    tag: 'ok',
    value: { tag: 'none' },
  });

  assertTaggedEquals(UserResult.decode({ tag: 'ok', value: 'user-1' }), {
    tag: 'ok',
    value: { tag: 'ok', value: 'user-1' },
  });
  assertTaggedEquals(UserResult.decode({ tag: 'err', error: 404 }), {
    tag: 'ok',
    value: { tag: 'err', error: 404 },
  });
});

Deno.test('decode tuple decodes fixed heterogeneous arrays', () => {
  const Pair = tuple(string, bigint);

  assertTaggedEquals(Pair.decode(['user-1', '12']), {
    tag: 'ok',
    value: ['user-1', 12n],
  });

  const badLength = Pair.decode(['user-1']);
  assertEquals(isErr(badLength), true);
  if (isOk(badLength)) {
    throw new Error('expected tuple length failure');
  }
  assertEquals(badLength.error instanceof DecodeFailure, true);
});
