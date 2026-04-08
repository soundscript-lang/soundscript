import { assertEquals } from '@std/assert';

import { err, isErr, isOk, ok } from '@soundscript/soundscript/result';

import {
  array,
  bigint,
  defaulted,
  DecodeFailure,
  type DecodeIssue,
  endsWith,
  field,
  format,
  integer,
  lazy,
  literal,
  max,
  maxLength,
  min,
  minLength,
  multipleOf,
  nullable,
  number,
  object,
  option as decodeOption,
  optional,
  optionalField,
  passthroughObject,
  pattern,
  preprocess,
  refine,
  readonlyRecord,
  result as decodeResult,
  startsWith,
  strictObject,
  string,
  tuple,
  union,
  undefinedValue,
  undefinedable,
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

Deno.test('decode defaulted supports promise-returning fallback helpers', async () => {
  const Nickname = defaulted(optional(string), async () => 'anon');

  assertTaggedEquals(await Nickname.decode(undefined), { tag: 'ok', value: 'anon' });
  assertTaggedEquals(await Nickname.validateDecode(undefined), { tag: 'ok', value: 'anon' });
});

Deno.test('decode preprocess runs before structural decode and supports async helpers', async () => {
  const Stringified = preprocess(string, (value) => String(value));
  const Uppercased = preprocess(string, async (value) => String(value).toUpperCase());

  assertTaggedEquals(Stringified.decode(42), { tag: 'ok', value: '42' });
  assertTaggedEquals(await Uppercased.decode('hello'), { tag: 'ok', value: 'HELLO' });
  assertTaggedEquals(await Uppercased.validateDecode('hello'), { tag: 'ok', value: 'HELLO' });
});

Deno.test('decode scalar constraint helpers validate numbers, lengths, patterns, and formats', () => {
  const PositiveInteger = min(integer(number), 1);
  const Username = maxLength(minLength(pattern(string, /^[a-z]+$/u), 3), 8);
  const Email = format(string, 'email');
  const PrefixedEmail = endsWith(startsWith(string, 'user:'), '@example.com');
  const BatchSize = multipleOf(number, 8);
  const BigChunk = multipleOf(bigint, 16n);

  assertTaggedEquals(PositiveInteger.decode(4), { tag: 'ok', value: 4 });
  assertTaggedEquals(Username.decode('alice'), { tag: 'ok', value: 'alice' });
  assertTaggedEquals(Email.decode('alice@example.com'), { tag: 'ok', value: 'alice@example.com' });
  assertTaggedEquals(PrefixedEmail.decode('user:alice@example.com'), {
    tag: 'ok',
    value: 'user:alice@example.com',
  });
  assertTaggedEquals(BatchSize.decode(16), { tag: 'ok', value: 16 });
  assertTaggedEquals(BigChunk.decode(32n), { tag: 'ok', value: 32n });

  const badPositiveInteger = PositiveInteger.validateDecode(1.5);
  const badUsername = Username.validateDecode('Al');
  const badEmail = Email.validateDecode('alice');
  const badPrefixedEmail = PrefixedEmail.validateDecode('guest:alice@example.com');
  const badBatchSize = BatchSize.validateDecode(10);
  const badBigChunk = BigChunk.validateDecode(18n);

  assertEquals(isErr(badPositiveInteger), true);
  if (isOk(badPositiveInteger)) {
    throw new Error('expected integer constraint failure');
  }
  assertEquals(badPositiveInteger.error[0]?.code, 'decode_integer');

  assertEquals(isErr(badUsername), true);
  if (isOk(badUsername)) {
    throw new Error('expected username constraint failure');
  }
  assertEquals(badUsername.error[0]?.code, 'decode_pattern');

  assertEquals(isErr(badEmail), true);
  if (isOk(badEmail)) {
    throw new Error('expected email constraint failure');
  }
  assertEquals(badEmail.error[0]?.code, 'decode_format');

  assertEquals(isErr(badPrefixedEmail), true);
  if (isOk(badPrefixedEmail)) {
    throw new Error('expected startsWith constraint failure');
  }
  assertEquals(badPrefixedEmail.error[0]?.code, 'decode_starts_with');

  assertEquals(isErr(badBatchSize), true);
  if (isOk(badBatchSize)) {
    throw new Error('expected multipleOf constraint failure');
  }
  assertEquals(badBatchSize.error[0]?.code, 'decode_multiple_of');

  assertEquals(isErr(badBigChunk), true);
  if (isOk(badBigChunk)) {
    throw new Error('expected bigint multipleOf constraint failure');
  }
  assertEquals(badBigChunk.error[0]?.code, 'decode_multiple_of');
});

Deno.test('decode object key policy strips by default, rejects in strict mode, and preserves in passthrough mode', () => {
  const StrippingUser = object({
    id: string,
  });
  const StrictUser = strictObject({
    id: string,
  });
  const PassthroughUser = passthroughObject({
    id: string,
  });

  assertTaggedEquals(StrippingUser.decode({ extra: true, id: 'user-1' }), {
    tag: 'ok',
    value: {
      id: 'user-1',
    },
  });

  const strictDecoded = StrictUser.validateDecode({ extra: true, id: 'user-1' });
  assertEquals(isErr(strictDecoded), true);
  if (isOk(strictDecoded)) {
    throw new Error('expected strict object decode to reject unknown key');
  }
  assertEquals(strictDecoded.error[0], {
    code: 'decode_unknown_key',
    input: true,
    message: 'Unknown field "extra".',
    path: ['extra'],
  });

  assertTaggedEquals(PassthroughUser.decode({ extra: true, id: 'user-1' }), {
    tag: 'ok',
    value: {
      extra: true,
      id: 'user-1',
    },
  });
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

Deno.test('decode validateDecode prefers issues from the best-matching union branch', () => {
  const Payload = union(
    object({
      tag: literal('user'),
      id: string,
    }),
    object({
      tag: literal('group'),
      members: array(string),
    }),
  );

  const decoded = Payload.validateDecode({
    tag: 'user',
    id: 123,
  });

  assertEquals(isErr(decoded), true);
  if (isOk(decoded)) {
    throw new Error('expected validateDecode to fail');
  }

  assertEquals(decoded.error, [{
    code: 'decode_failure',
    input: 123,
    message: 'Expected string.',
    path: ['id'],
  }] satisfies readonly DecodeIssue[]);
});

Deno.test('decode async validateDecode prefers issues from the best-matching union branch', async () => {
  const AsyncUser = {
    async decode(value: unknown) {
      return object({
        tag: literal('user'),
        id: string,
      }).decode(value);
    },
    async validateDecode(value: unknown) {
      return object({
        tag: literal('user'),
        id: string,
      }).validateDecode(value);
    },
  };
  const Payload = union(
    AsyncUser,
    object({
      tag: literal('group'),
      members: array(string),
    }),
  );

  const decoded = await Payload.validateDecode({
    tag: 'user',
    id: 123,
  });

  assertEquals(isErr(decoded), true);
  if (isOk(decoded)) {
    throw new Error('expected async validateDecode to fail');
  }

  assertEquals(decoded.error, [{
    code: 'decode_failure',
    input: 123,
    message: 'Expected string.',
    path: ['id'],
  }] satisfies readonly DecodeIssue[]);
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

Deno.test('decode validateDecode accumulates nested object and array issues', () => {
  const UserDecoder = object({
    id: string,
    tags: array(string),
  });

  const decoded = UserDecoder.validateDecode({
    id: 123,
    tags: ['ok', 456, false],
  });

  assertEquals(isErr(decoded), true);
  if (isOk(decoded)) {
    throw new Error('expected validateDecode to fail');
  }

  assertEquals(decoded.error, [
    {
      code: 'decode_failure',
      input: 123,
      message: 'Expected string.',
      path: ['id'],
    },
    {
      code: 'decode_failure',
      input: 456,
      message: 'Expected string.',
      path: ['tags', 1],
    },
    {
      code: 'decode_failure',
      input: false,
      message: 'Expected string.',
      path: ['tags', 2],
    },
  ] satisfies readonly DecodeIssue[]);
});

Deno.test('decode refine supports promise-returning predicates and promotes decode to async', async () => {
  const AsyncPositiveInt = refine(
    number,
    async (value: number): Promise<boolean> => value > 0,
    'Expected a positive integer.',
  );

  assertTaggedEquals(await AsyncPositiveInt.decode(12), { tag: 'ok', value: 12 });

  const badValue = await AsyncPositiveInt.decode(-1);
  assertEquals(isErr(badValue), true);
  if (isOk(badValue)) {
    throw new Error('expected async refine decode to fail');
  }
  assertEquals(badValue.error instanceof DecodeFailure, true);
  assertEquals(badValue.error.message, 'Expected a positive integer.');
});

Deno.test('decode refine supports string and issue-returning predicate failures', () => {
  const SlugDecoder = refine(
    string,
    (value: string) =>
      value === value.toLowerCase()
        ? true
        : {
          code: 'custom_slug',
          input: value,
          message: 'Expected lowercase slug.',
          path: [],
        },
    'Expected lowercase slug.',
  );

  const badValue = SlugDecoder.decode('Hello');
  assertEquals(isErr(badValue), true);
  if (isOk(badValue)) {
    throw new Error('expected issue-returning refine decode to fail');
  }
  assertEquals(badValue.error instanceof DecodeFailure, true);
  assertEquals(badValue.error.message, 'Expected lowercase slug.');

  const validated = SlugDecoder.validateDecode('Hello');
  assertEquals(isErr(validated), true);
  if (isOk(validated)) {
    throw new Error('expected issue-returning refine validateDecode to fail');
  }
  assertEquals(validated.error, [{
    code: 'custom_slug',
    input: 'Hello',
    message: 'Expected lowercase slug.',
    path: [],
  }] satisfies readonly DecodeIssue[]);
});

Deno.test('decode object becomes async when a nested child decoder is async', async () => {
  const AsyncStringDecoder = {
    async decode(value: unknown) {
      return typeof value === 'string'
        ? ok(value.toUpperCase())
        : err(new DecodeFailure('Expected string.', { cause: value }));
    },
    async validateDecode(value: unknown) {
      return typeof value === 'string'
        ? ok(value.toUpperCase())
        : err([{
          code: 'decode_failure',
          input: value,
          message: 'Expected string.',
          path: [],
        }] satisfies readonly DecodeIssue[]);
    },
  };

  const UserDecoder = object({
    id: AsyncStringDecoder,
    nickname: optional(string),
  });

  assertTaggedEquals(
    await UserDecoder.decode({ id: 'user-1' }),
    {
      tag: 'ok',
      value: {
        id: 'USER-1',
        nickname: undefined,
      },
    },
  );
});

Deno.test('decode async container helpers reuse the first pending child result', async () => {
  const makeAsyncStringDecoder = () => {
    let decodeCalls = 0;
    let validateCalls = 0;
    const helper = {
      async decode(value: unknown) {
        decodeCalls += 1;
        return typeof value === 'string'
          ? ok(value.toUpperCase())
          : err(new DecodeFailure('Expected string.', { cause: value }));
      },
      async validateDecode(value: unknown) {
        validateCalls += 1;
        return typeof value === 'string'
          ? ok(value.toUpperCase())
          : err([{
            code: 'decode_failure',
            input: value,
            message: 'Expected string.',
            path: [],
          }] satisfies readonly DecodeIssue[]);
      },
      get counts() {
        return { decodeCalls, validateCalls };
      },
    };
    return helper;
  };

  const arrayItem = makeAsyncStringDecoder();
  assertTaggedEquals(await array(arrayItem).decode(['a', 'b']), {
    tag: 'ok',
    value: ['A', 'B'],
  });
  assertEquals(arrayItem.counts, { decodeCalls: 2, validateCalls: 0 });

  const tupleItem = makeAsyncStringDecoder();
  assertTaggedEquals(await tuple(tupleItem, string).decode(['a', 'b']), {
    tag: 'ok',
    value: ['A', 'b'],
  });
  assertEquals(tupleItem.counts, { decodeCalls: 1, validateCalls: 0 });

  const objectField = makeAsyncStringDecoder();
  assertTaggedEquals(await object({ id: objectField, tag: string }).decode({ id: 'a', tag: 'b' }), {
    tag: 'ok',
    value: { id: 'A', tag: 'b' },
  });
  assertEquals(objectField.counts, { decodeCalls: 1, validateCalls: 0 });

  const recordValue = makeAsyncStringDecoder();
  assertTaggedEquals(await readonlyRecord(recordValue).decode({ first: 'a', second: 'b' }), {
    tag: 'ok',
    value: { first: 'A', second: 'B' },
  });
  assertEquals(recordValue.counts, { decodeCalls: 2, validateCalls: 0 });

  const validateArrayItem = makeAsyncStringDecoder();
  assertTaggedEquals(await array(validateArrayItem).validateDecode(['a', 'b']), {
    tag: 'ok',
    value: ['A', 'B'],
  });
  assertEquals(validateArrayItem.counts, { decodeCalls: 0, validateCalls: 2 });

  const validateTupleItem = makeAsyncStringDecoder();
  assertTaggedEquals(await tuple(validateTupleItem, string).validateDecode(['a', 'b']), {
    tag: 'ok',
    value: ['A', 'b'],
  });
  assertEquals(validateTupleItem.counts, { decodeCalls: 0, validateCalls: 1 });

  const validateObjectField = makeAsyncStringDecoder();
  assertTaggedEquals(
    await object({ id: validateObjectField, tag: string }).validateDecode({ id: 'a', tag: 'b' }),
    {
      tag: 'ok',
      value: { id: 'A', tag: 'b' },
    },
  );
  assertEquals(validateObjectField.counts, { decodeCalls: 0, validateCalls: 1 });

  const validateRecordValue = makeAsyncStringDecoder();
  assertTaggedEquals(await readonlyRecord(validateRecordValue).validateDecode({ first: 'a', second: 'b' }), {
    tag: 'ok',
    value: { first: 'A', second: 'B' },
  });
  assertEquals(validateRecordValue.counts, { decodeCalls: 0, validateCalls: 2 });
});

Deno.test('decode undefinedValue and undefinedable distinguish missing from explicit undefined', () => {
  assertTaggedEquals(undefinedValue.decode(undefined), { tag: 'ok', value: undefined });

  const ExplicitMaybeDecoder = object({
    maybe: undefinedable(string),
  });

  assertTaggedEquals(ExplicitMaybeDecoder.decode({ maybe: undefined }), {
    tag: 'ok',
    value: { maybe: undefined },
  });

  const missing = ExplicitMaybeDecoder.decode({});
  assertEquals(isErr(missing), true);
  if (isOk(missing)) {
    throw new Error('expected required undefinedable field to reject missing key');
  }
  assertEquals(missing.error instanceof DecodeFailure, true);
  assertEquals(missing.error.message, 'Missing field "maybe".');
});
