import { assertEquals } from '@std/assert';

import { isErr, isOk } from '@soundscript/soundscript/result';
import { boolean, bigint as decodeBigint, object as decodeObject, option as decodeOption, result as decodeResult, string as decodeString } from './decode.ts';
import { booleanEncoder, bigintEncoder, object as encodeObject, option as encodeOption, optional as encodeOptional, result as encodeResult, stringEncoder } from './encode.ts';
import { codec as createCodec } from './codec.ts';
import { err, none, ok, some } from './result.ts';

import {
  copyJsonRecord,
  decodeJson,
  emptyJsonRecord,
  encodeAndStringify,
  encodeJson,
  isJsonObject,
  isJsonLikeValue,
  isJsonValue,
  JsonParseFailure,
  JsonStringifyFailure,
  mergeJsonRecords,
  parseAndDecode,
  parseJson,
  parseJsonLike,
  stringifyJson,
  stringifyJsonLike,
  validateDecodeJson,
  validateEncodeJson,
  type MachineJsonLikeValue,
  type JsonValue,
  type JsonStringifyBigintMode,
} from './json.ts';
import { F64, I64, U8 } from './numerics.ts';

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

Deno.test('json parseJson returns ok for valid JSON text', () => {
  const parsed = parseJson('{"ok":true,"items":[1,2,3]}');

  assertEquals(isOk(parsed), true);
  if (isErr(parsed)) {
    throw new Error('expected parseJson to succeed');
  }

  assertEquals(parsed.value, { ok: true, items: [1, 2, 3] });
});

Deno.test('json parseJson returns err for invalid JSON text', () => {
  const parsed = parseJson('{"ok":true');

  assertEquals(isErr(parsed), true);
  if (isOk(parsed)) {
    throw new Error('expected parseJson to fail');
  }

  assertEquals(parsed.error instanceof JsonParseFailure, true);
  assertEquals(parsed.error.name, 'JsonParseFailure');
  assertEquals(parsed.error.cause instanceof Error, true);
});

Deno.test('json stringifyJson returns ok for valid JsonValue input', () => {
  const encoded = stringifyJson({ ok: true, items: [1, 2, 3] });

  assertTaggedEquals(encoded, { tag: 'ok', value: '{"ok":true,"items":[1,2,3]}' });
});

Deno.test('json stringifyJson returns err for non-serializable JsonValue-shaped input', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;

  const encoded = stringifyJson(cycle as JsonValue);

  assertEquals(isErr(encoded), true);
  if (isOk(encoded)) {
    throw new Error('expected stringifyJson to fail');
  }

  assertEquals(encoded.error instanceof JsonStringifyFailure, true);
  assertEquals(encoded.error.name, 'JsonStringifyFailure');
  assertEquals(encoded.error.cause instanceof Error, true);
});

Deno.test('json stringifyJson supports int64 string mode', () => {
  const encoded = stringifyJson({ large: 18446744073709551615n }, { int64: 'string' });

  assertTaggedEquals(encoded, { tag: 'ok', value: '{"large":"18446744073709551615"}' });
});

Deno.test('json stringifyJson supports int64 lossless mode', () => {
  const encoded = stringifyJson({ large: 18446744073709551615n }, { int64: 'lossless' });

  assertTaggedEquals(encoded, { tag: 'ok', value: '{"large":18446744073709551615}' });
});

Deno.test('json parseJson supports int64 lossless mode', () => {
  const parsed = parseJson('{"large":18446744073709551615}', { int64: 'lossless' });

  assertTaggedEquals(parsed, { tag: 'ok', value: { large: 18446744073709551615n } });
});

Deno.test('json isJsonValue accepts nested JSON-like values', () => {
  assertEquals(
    isJsonValue({ ok: true, nested: { values: [1, 'two', null, false] } }),
    true,
  );
});

Deno.test('json isJsonValue rejects undefined and function positions', () => {
  assertEquals(isJsonValue({ ok: undefined }), false);
  assertEquals(isJsonValue({ run: () => 1 }), false);
  assertEquals(isJsonValue(undefined), false);
});

Deno.test('json isJsonObject narrows JSON records and record helpers return fresh objects', () => {
  const source = { ok: true, nested: { count: 1 } } as const;

  assertEquals(isJsonObject(source), true);
  assertEquals(isJsonObject(['nope']), false);
  assertEquals(isJsonObject(null), false);

  const empty = emptyJsonRecord();
  const copied = copyJsonRecord(source);
  const merged = mergeJsonRecords(empty, copied, { extra: false, ok: false });

  assertEquals(empty, {});
  assertEquals(copied, source);
  assertEquals(copied === source, false);
  assertEquals(merged, { ok: false, nested: { count: 1 }, extra: false });
  assertEquals(merged === copied, false);
});

Deno.test('json parseAndDecode composes JSON parsing with a decoder', () => {
  const decoded = parseAndDecode('true', boolean);

  assertTaggedEquals(decoded, { tag: 'ok', value: true });
});

Deno.test('json parseAndDecode and decodeJson mirror async decoder helpers', async () => {
  const AsyncStringDecoder = {
    async decode(value: unknown) {
      return typeof value === 'string'
        ? ok(value.toUpperCase())
        : err(new JsonParseFailure(value));
    },
    async validateDecode(value: unknown) {
      return typeof value === 'string'
        ? ok(value.toUpperCase())
        : err([{
          code: 'decode_failure',
          input: value,
          message: 'Expected string.',
          path: [],
        }] as const);
    },
  };

  assertTaggedEquals(await parseAndDecode('"user-1"', AsyncStringDecoder), {
    tag: 'ok',
    value: 'USER-1',
  });
  assertTaggedEquals(await decodeJson('"user-1"', AsyncStringDecoder), {
    tag: 'ok',
    value: 'USER-1',
  });
});

Deno.test('json encodeAndStringify composes an encoder with JSON serialization', () => {
  const encoded = encodeAndStringify(true, booleanEncoder);

  assertTaggedEquals(encoded, { tag: 'ok', value: 'true' });
});

Deno.test('json encodeAndStringify and encodeJson mirror async encoder helpers', async () => {
  const AsyncStringEncoder = {
    async encode(value: string) {
      return ok(value.toUpperCase());
    },
    async validateEncode(value: string) {
      return ok(value.toUpperCase());
    },
  };

  assertTaggedEquals(await encodeAndStringify('user-1', AsyncStringEncoder), {
    tag: 'ok',
    value: '"USER-1"',
  });
  assertTaggedEquals(await encodeJson('user-1', AsyncStringEncoder), {
    tag: 'ok',
    value: '"USER-1"',
  });
});

Deno.test('json parseJsonLike preserves large integer literals as bigint', () => {
  const parsed = parseJsonLike('{"small":1,"large":9007199254740993,"fraction":1.5}');

  assertEquals(isOk(parsed), true);
  if (isErr(parsed)) {
    throw new Error('expected parseJsonLike to succeed');
  }

  assertEquals(parsed.value, {
    fraction: 1.5,
    large: 9007199254740993n,
    small: 1,
  });
});

Deno.test('json stringifyJsonLike supports bigint modes', () => {
  assertTaggedEquals(
    stringifyJsonLike({ total: 12n }, { bigint: 'string' }),
    { tag: 'ok', value: '{"total":"12"}' },
  );
  assertTaggedEquals(
    stringifyJsonLike({ total: 12n }, { bigint: 'number' }),
    { tag: 'ok', value: '{"total":12}' },
  );

  const rejected = stringifyJsonLike({ total: 12n }, { bigint: 'reject' });
  assertEquals(isErr(rejected), true);
});

Deno.test('json encodeJson stringifies encoder outputs with bigint handling', () => {
  const UserEncoder = encodeObject({
    id: stringEncoder,
    nickname: encodeOptional(stringEncoder),
    total: bigintEncoder,
  });

  const encoded = encodeJson(
    {
      id: 'user-1',
      nickname: undefined,
      total: 12n,
    },
    UserEncoder,
    { bigint: 'number' },
  );

  assertTaggedEquals(encoded, {
    tag: 'ok',
    value: '{"id":"user-1","total":12}',
  });
});

Deno.test('json decodeJson decodes bigint fields from both numeric and string JSON forms', () => {
  const UserDecoder = decodeObject({
    id: decodeString,
    total: decodeBigint,
  });

  assertTaggedEquals(
    decodeJson('{"id":"user-1","total":9007199254740993}', UserDecoder),
    {
      tag: 'ok',
      value: {
        id: 'user-1',
        total: 9007199254740993n,
      },
    },
  );
  assertTaggedEquals(
    decodeJson('{"id":"user-1","total":"9007199254740993"}', UserDecoder),
    {
      tag: 'ok',
      value: {
        id: 'user-1',
        total: 9007199254740993n,
      },
    },
  );
});

Deno.test('json bridge composes with codecs through decodeJson and encodeJson', () => {
  const UserCodec = createCodec(
    decodeObject({
      id: decodeString,
      total: decodeBigint,
    }),
    encodeObject({
      id: stringEncoder,
      total: bigintEncoder,
    }),
  );

  assertTaggedEquals(
    decodeJson('{"id":"user-1","total":12}', UserCodec),
    {
      tag: 'ok',
      value: {
        id: 'user-1',
        total: 12n,
      },
    },
  );
  assertTaggedEquals(
    encodeJson(
      {
        id: 'user-1',
        total: 12n,
      },
      UserCodec,
      { bigint: 'string' satisfies JsonStringifyBigintMode },
    ),
    {
      tag: 'ok',
      value: '{"id":"user-1","total":"12"}',
    },
  );
});

Deno.test('json bridge round-trips Option and Result through tagged result-family shapes', () => {
  assertTaggedEquals(
    encodeJson(none(), encodeOption(stringEncoder), { bigint: 'number' }),
    {
      tag: 'ok',
      value: '{"tag":"none"}',
    },
  );
  assertTaggedEquals(
    encodeJson(ok('user-1'), encodeResult(stringEncoder, bigintEncoder), { bigint: 'number' }),
    {
      tag: 'ok',
      value: '{"tag":"ok","value":"user-1"}',
    },
  );
  assertTaggedEquals(
    encodeJson(err(12n), encodeResult(stringEncoder, bigintEncoder), { bigint: 'number' }),
    {
      tag: 'ok',
      value: '{"tag":"err","error":12}',
    },
  );
  assertTaggedEquals(
    decodeJson('{"tag":"some","value":"user-1"}', decodeOption(decodeString)),
    {
      tag: 'ok',
      value: some('user-1'),
    },
  );
  assertTaggedEquals(
    decodeJson('{"tag":"none"}', decodeOption(decodeString)),
    {
      tag: 'ok',
      value: none(),
    },
  );
  assertTaggedEquals(
    decodeJson('{"tag":"err","error":12}', decodeResult(decodeString, decodeBigint)),
    {
      tag: 'ok',
      value: err(12n),
    },
  );
});

Deno.test('json validateDecodeJson and validateEncodeJson mirror accumulation helpers', () => {
  const UserDecoder = decodeObject({
    id: decodeString,
    active: boolean,
  });
  const UserEncoder = encodeObject({
    id: stringEncoder,
    active: booleanEncoder,
  });

  assertTaggedEquals(
    validateDecodeJson('{"id":1,"active":"yes"}', UserDecoder),
    {
      tag: 'err',
      error: [
        {
          code: 'decode_failure',
          input: 1,
          message: 'Expected string.',
          path: ['id'],
        },
        {
          code: 'decode_failure',
          input: 'yes',
          message: 'Expected boolean.',
          path: ['active'],
        },
      ],
    },
  );

  assertTaggedEquals(
    validateEncodeJson({ id: 'user-1', active: true }, UserEncoder),
    {
      tag: 'ok',
      value: '{"id":"user-1","active":true}',
    },
  );
});

Deno.test('json isJsonLikeValue accepts bigint and optional-encoder shaped values', () => {
  assertEquals(
    isJsonLikeValue({ total: 12n, nickname: undefined, nested: [1, 2n, null] }),
    true,
  );
  assertEquals(isJsonLikeValue({ run: () => 1 }), false);
});

Deno.test('json stringifyJson supports explicit machine numeric encoding modes', () => {
  const value: MachineJsonLikeValue = {
    byte: U8(1),
    nan: F64(NaN),
    wide: I64(7n),
  };

  assertTaggedEquals(
    stringifyJson(value, { numerics: 'tagged' }),
    {
      tag: 'ok',
      value: '{"byte":{"$numeric":"u8","value":"1"},"nan":{"$numeric":"f64","value":"NaN"},"wide":{"$numeric":"i64","value":"7"}}',
    },
  );
  assertTaggedEquals(
    stringifyJson(value, { numerics: 'decimal-string' }),
    {
      tag: 'ok',
      value: '{"byte":"1","nan":"NaN","wide":"7"}',
    },
  );
  assertTaggedEquals(
    stringifyJson({ byte: U8(1), nan: F64(NaN) }, { numerics: 'json-number' }),
    {
      tag: 'ok',
      value: '{"byte":1,"nan":null}',
    },
  );
  assertEquals(
    isErr(stringifyJson(value, { numerics: 'json-number' })),
    true,
  );
});

Deno.test('json parseJson restores tagged machine numerics recursively when requested', () => {
  const parsed = parseJson(
    '{"items":[{"$numeric":"u8","value":"1"},{"$numeric":"f64","value":"NaN"}],"wide":{"$numeric":"i64","value":"7"}}',
    { numerics: 'tagged' },
  );

  assertEquals(isOk(parsed), true);
  if (isErr(parsed)) {
    throw new Error('expected parseJson to succeed');
  }

  const value = parsed.value as {
    items: [unknown, unknown];
    wide: unknown;
  };
  assertEquals(value.items[0], U8(1));
  assertEquals(value.items[1], F64(NaN));
  assertEquals(value.wide, I64(7n));
});
