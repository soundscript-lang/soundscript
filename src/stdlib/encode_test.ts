import { assertEquals } from '@std/assert';

import { err, isErr, isOk, ok } from '@soundscript/soundscript/result';

import {
  array,
  bigintEncoder,
  booleanEncoder,
  contramap,
  type Encoder,
  EncodeFailure,
  type EncodeIssue,
  type EncodeMode,
  encoderContravariant,
  fromEncode,
  jsonArray,
  jsonObject,
  jsonValue,
  lazy,
  literal,
  mapError,
  nullable,
  numberEncoder,
  object,
  option as encodeOption,
  optional,
  passthroughObject,
  record,
  refine,
  result as encodeResult,
  strictObject,
  stringEncoder,
  tuple,
  undefinedEncoder,
  undefinedable,
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

Deno.test('encode object key policy strips by default, rejects in strict mode, and preserves in passthrough mode', () => {
  const StrippingUser = object({
    id: stringEncoder,
  });
  const StrictUser = strictObject({
    id: stringEncoder,
  });
  const PassthroughUser = passthroughObject({
    id: stringEncoder,
  });

  assertTaggedEquals(StrippingUser.encode({ extra: true, id: 'user-1' } as never), {
    tag: 'ok',
    value: {
      id: 'user-1',
    },
  });

  const strictEncoded = StrictUser.validateEncode({ extra: true, id: 'user-1' } as never);
  assertEquals(isErr(strictEncoded), true);
  if (isOk(strictEncoded)) {
    throw new Error('expected strict object encode to reject unknown key');
  }
  assertEquals(strictEncoded.error[0], {
    code: 'encode_unknown_key',
    input: true,
    message: 'Unknown field "extra".',
    path: ['extra'],
  });

  assertTaggedEquals(PassthroughUser.encode({ extra: true, id: 'user-1' } as never), {
    tag: 'ok',
    value: {
      extra: true,
      id: 'user-1',
    },
  });
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
  const RejectingBigintEncoder = fromEncode((value: bigint) =>
    value < 0n ? err(new Error('negative')) : ok(value)
  );

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

Deno.test('encode json helpers validate recursive JSON structures', () => {
  assertTaggedEquals(jsonValue.encode({
    nested: {
      count: 1,
      ok: true,
    },
    tags: ['a', null],
  }), {
    tag: 'ok',
    value: {
      nested: {
        count: 1,
        ok: true,
      },
      tags: ['a', null],
    },
  });
  assertTaggedEquals(jsonObject.encode({ nested: { id: 'node-1' } }), {
    tag: 'ok',
    value: { nested: { id: 'node-1' } },
  });
  assertTaggedEquals(jsonArray.encode([{ id: 'node-1' }, false, null]), {
    tag: 'ok',
    value: [{ id: 'node-1' }, false, null],
  });

  const badValue = jsonValue.validateEncode({ nested: { missing: undefined } } as never);
  const badObject = jsonObject.validateEncode(['not', 'an', 'object'] as never);
  const badArray = jsonArray.validateEncode({ not: 'an array' } as never);

  assertEquals(isErr(badValue), true);
  if (isOk(badValue)) {
    throw new Error('expected invalid json value failure');
  }
  assertEquals(badValue.error[0]?.code, 'encode_failure');

  assertEquals(isErr(badObject), true);
  if (isOk(badObject)) {
    throw new Error('expected invalid json object failure');
  }
  assertEquals(badObject.error[0]?.message, 'Expected JSON object.');

  assertEquals(isErr(badArray), true);
  if (isOk(badArray)) {
    throw new Error('expected invalid json array failure');
  }
  assertEquals(badArray.error[0]?.message, 'Expected JSON array.');
});

Deno.test('encode mapError remaps sync and async encode failures while leaving validateEncode untouched', async () => {
  const Rejecting = fromEncode((value: string) =>
    value.length > 0 ? ok(value) : err(new EncodeFailure('Expected non-empty string.', { cause: value }))
  );
  const RejectingAsync = fromEncode(async (value: string) =>
    value.length > 0 ? ok(value) : err(new EncodeFailure('Expected non-empty string.', { cause: value }))
  );
  const SyncMapped = mapError(
    Rejecting,
    (error: EncodeFailure) => ({ code: 'mapped', message: error.message }),
  );
  const AsyncMapped = mapError(
    RejectingAsync,
    (error: EncodeFailure) => ({ code: 'mapped_async', message: error.message }),
  );

  assertTaggedEquals(SyncMapped.encode(''), {
    error: {
      code: 'mapped',
      message: 'Expected non-empty string.',
    },
    tag: 'err',
  });
  assertTaggedEquals(await AsyncMapped.encode(''), {
    error: {
      code: 'mapped_async',
      message: 'Expected non-empty string.',
    },
    tag: 'err',
  });

  const validated = await AsyncMapped.validateEncode('');
  assertEquals(isErr(validated), true);
  if (isOk(validated)) {
    throw new Error('expected validateEncode failure');
  }
  assertEquals(validated.error[0]?.code, 'encode_failure');
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

Deno.test('encode validateEncode accumulates nested object and array issues', () => {
  const NonEmptyStringEncoder = fromEncode<string, string, EncodeFailure>(
    (value) =>
      value.length > 0
        ? ok(value)
        : err(new EncodeFailure('Expected non-empty string.', { cause: value })),
    (value) =>
      value.length > 0
        ? ok(value)
        : err([{
          code: 'encode_failure',
          input: value,
          message: 'Expected non-empty string.',
          path: [],
        }] satisfies readonly EncodeIssue[]),
  );

  const UserEncoder = object({
    id: NonEmptyStringEncoder,
    tags: array(NonEmptyStringEncoder),
  });

  const encoded = UserEncoder.validateEncode({
    id: '',
    tags: ['ok', ''],
  });

  assertEquals(isErr(encoded), true);
  if (isOk(encoded)) {
    throw new Error('expected validateEncode to fail');
  }

  assertEquals(encoded.error, [
    {
      code: 'encode_failure',
      input: '',
      message: 'Expected non-empty string.',
      path: ['id'],
    },
    {
      code: 'encode_failure',
      input: '',
      message: 'Expected non-empty string.',
      path: ['tags', 1],
    },
  ] satisfies readonly EncodeIssue[]);
});

Deno.test('encode contramap supports promise-returning projections and promotes encode to async', async () => {
  type UserId = { readonly value: string };

  const AsyncUserIdEncoder = contramap(
    stringEncoder,
    async (id: UserId) => id.value.toUpperCase(),
  );

  assertTaggedEquals(
    await AsyncUserIdEncoder.encode({ value: 'user-1' }),
    {
      tag: 'ok',
      value: 'USER-1',
    },
  );
});

Deno.test('encode refine supports string and issue-returning predicate failures', () => {
  const SlugEncoder = refine(
    stringEncoder,
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

  const badValue = SlugEncoder.encode('Hello');
  assertEquals(isErr(badValue), true);
  if (isOk(badValue)) {
    throw new Error('expected issue-returning refine encode to fail');
  }
  assertEquals(badValue.error instanceof EncodeFailure, true);
  assertEquals(badValue.error.message, 'Expected lowercase slug.');

  const validated = SlugEncoder.validateEncode('Hello');
  assertEquals(isErr(validated), true);
  if (isOk(validated)) {
    throw new Error('expected issue-returning refine validateEncode to fail');
  }
  assertEquals(validated.error, [{
    code: 'custom_slug',
    input: 'Hello',
    message: 'Expected lowercase slug.',
    path: [],
  }] satisfies readonly EncodeIssue[]);
});

Deno.test('encode object becomes async when a nested child encoder is async', async () => {
  const AsyncStringEncoder = {
    async encode(value: string) {
      return ok(value.toUpperCase());
    },
    async validateEncode(value: string) {
      return ok(value.toUpperCase());
    },
  };

  const UserEncoder = object({
    id: AsyncStringEncoder,
    total: bigintEncoder,
  });

  assertTaggedEquals(
    await UserEncoder.encode({
      id: 'user-1',
      total: 12n,
    }),
    {
      tag: 'ok',
      value: {
        id: 'USER-1',
        total: 12n,
      },
    },
  );
});

Deno.test('encode async container helpers reuse the first pending child result', async () => {
  const makeAsyncStringEncoder = () => {
    let encodeCalls = 0;
    let validateCalls = 0;
    const helper = {
      async encode(value: string) {
        encodeCalls += 1;
        return ok(value.toUpperCase());
      },
      async validateEncode(value: string) {
        validateCalls += 1;
        return ok(value.toUpperCase());
      },
      get counts() {
        return { encodeCalls, validateCalls };
      },
    };
    return helper;
  };

  const arrayItem = makeAsyncStringEncoder();
  assertTaggedEquals(await array(arrayItem).encode(['a', 'b']), {
    tag: 'ok',
    value: ['A', 'B'],
  });
  assertEquals(arrayItem.counts, { encodeCalls: 2, validateCalls: 0 });

  const tupleItem = makeAsyncStringEncoder();
  assertTaggedEquals(await tuple(tupleItem, stringEncoder).encode(['a', 'b']), {
    tag: 'ok',
    value: ['A', 'b'],
  });
  assertEquals(tupleItem.counts, { encodeCalls: 1, validateCalls: 0 });

  const objectField = makeAsyncStringEncoder();
  assertTaggedEquals(await object({ id: objectField, tag: stringEncoder }).encode({ id: 'a', tag: 'b' }), {
    tag: 'ok',
    value: { id: 'A', tag: 'b' },
  });
  assertEquals(objectField.counts, { encodeCalls: 1, validateCalls: 0 });

  const recordValue = makeAsyncStringEncoder();
  assertTaggedEquals(await record(recordValue).encode({ first: 'a', second: 'b' }), {
    tag: 'ok',
    value: { first: 'A', second: 'B' },
  });
  assertEquals(recordValue.counts, { encodeCalls: 2, validateCalls: 0 });

  const validateArrayItem = makeAsyncStringEncoder();
  assertTaggedEquals(await array(validateArrayItem).validateEncode(['a', 'b']), {
    tag: 'ok',
    value: ['A', 'B'],
  });
  assertEquals(validateArrayItem.counts, { encodeCalls: 0, validateCalls: 2 });

  const validateTupleItem = makeAsyncStringEncoder();
  assertTaggedEquals(await tuple(validateTupleItem, stringEncoder).validateEncode(['a', 'b']), {
    tag: 'ok',
    value: ['A', 'b'],
  });
  assertEquals(validateTupleItem.counts, { encodeCalls: 0, validateCalls: 1 });

  const validateObjectField = makeAsyncStringEncoder();
  assertTaggedEquals(
    await object({ id: validateObjectField, tag: stringEncoder }).validateEncode({ id: 'a', tag: 'b' }),
    {
      tag: 'ok',
      value: { id: 'A', tag: 'b' },
    },
  );
  assertEquals(validateObjectField.counts, { encodeCalls: 0, validateCalls: 1 });

  const validateRecordValue = makeAsyncStringEncoder();
  assertTaggedEquals(await record(validateRecordValue).validateEncode({ first: 'a', second: 'b' }), {
    tag: 'ok',
    value: { first: 'A', second: 'B' },
  });
  assertEquals(validateRecordValue.counts, { encodeCalls: 0, validateCalls: 2 });
});

Deno.test('encode undefinedEncoder and undefinedable distinguish missing from explicit undefined', () => {
  assertTaggedEquals(undefinedEncoder.encode(undefined), { tag: 'ok', value: undefined });

  const ExplicitMaybeEncoder = object({
    maybe: undefinedable(stringEncoder),
  });

  assertTaggedEquals(ExplicitMaybeEncoder.encode({ maybe: undefined }), {
    tag: 'ok',
    value: { maybe: undefined },
  });

  const missing = ExplicitMaybeEncoder.encode({} as { maybe: string | undefined });
  assertEquals(isErr(missing), true);
  if (isOk(missing)) {
    throw new Error('expected required undefinedable field to reject missing key');
  }
  assertEquals(missing.error instanceof EncodeFailure, true);
  assertEquals(missing.error.message, 'Missing field "maybe".');
});

Deno.test('encode record encodes keyed values and accumulates nested issues', () => {
  const NonEmptyStringEncoder = fromEncode<string, string, EncodeFailure>(
    (value) =>
      value.length > 0
        ? ok(value)
        : err(new EncodeFailure('Expected non-empty string.', { cause: value })),
    (value) =>
      value.length > 0
        ? ok(value)
        : err([{
          code: 'encode_failure',
          input: value,
          message: 'Expected non-empty string.',
          path: [],
        }] satisfies readonly EncodeIssue[]),
  );

  assertTaggedEquals(record(NonEmptyStringEncoder).encode({ first: 'ok', second: 'yep' }), {
    tag: 'ok',
    value: { first: 'ok', second: 'yep' },
  });

  const badRecord = record(NonEmptyStringEncoder).validateEncode({ first: '' });
  assertEquals(isErr(badRecord), true);
  if (isOk(badRecord)) {
    throw new Error('expected record validateEncode failure');
  }
  assertEquals(badRecord.error, [{
    code: 'encode_failure',
    input: '',
    message: 'Expected non-empty string.',
    path: ['first'],
  }] satisfies readonly EncodeIssue[]);
});

Deno.test('encode lazy recursive encoders reject cyclic object graphs', async () => {
  type Node = {
    readonly id: string;
    readonly next?: Node;
  };

  const NodeEncoder: Encoder<Node, { readonly id: string; readonly next?: unknown }, EncodeFailure, EncodeMode> = lazy(() =>
    object({
      id: stringEncoder,
      next: optional(NodeEncoder),
    })
  );

  const acyclic: Node = {
    id: 'root',
    next: {
      id: 'child',
    },
  };
  assertTaggedEquals(await NodeEncoder.encode(acyclic), {
    tag: 'ok',
    value: {
      id: 'root',
      next: {
        id: 'child',
        next: undefined,
      },
    },
  });

  const cyclic = { id: 'root' } as Node;
  (cyclic as { next?: Node }).next = cyclic;

  const encoded = await NodeEncoder.encode(cyclic);
  assertEquals(isErr(encoded), true);
  if (isOk(encoded)) {
    throw new Error('expected cyclic encode failure');
  }
  assertEquals(encoded.error instanceof EncodeFailure, true);
  assertEquals(encoded.error.message, 'Cyclic value encountered during encode.');
  assertEquals(encoded.error.path, ['next']);

  const validated = await NodeEncoder.validateEncode(cyclic);
  assertEquals(isErr(validated), true);
  if (isOk(validated)) {
    throw new Error('expected cyclic validateEncode failure');
  }
  assertEquals(validated.error[0]?.message, 'Cyclic value encountered during encode.');
  assertEquals(validated.error[0]?.path, ['next']);
});
