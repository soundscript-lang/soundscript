import { assertEquals } from '@std/assert';
import ts from 'typescript';

import { createPreparedProgramForMacroTest } from './macro_test_helpers.ts';

Deno.test('checked-in stdlib declarations expose callable macro and DSL surfaces to TypeScript', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { ok, Try } from 'sts:prelude';",
      "import { Match, where } from 'sts:match';",
      "import * as async from 'sts:async';",
      "import * as codec from 'sts:codec';",
      "import * as compare from 'sts:compare';",
      "import * as decode from 'sts:decode';",
      "import * as encode from 'sts:encode';",
      "import { codec as deriveCodec, decode as deriveDecode, encode as deriveEncode, eq, hash as deriveHash, tagged } from 'sts:derive';",
      "import * as hash from 'sts:hash';",
      "import * as json from 'sts:json';",
      "import * as metadata from 'sts:metadata';",
      "import * as result from 'sts:result';",
      '',
      'const unwrapped: number = Try(ok(1));',
      'const matched: number = Match(1, [',
      '  where((value: number) => value + 1, (value) => value > 0),',
      ']);',
      'const UserDecoder = decode.object({',
      '  id: decode.string,',
      '  tags: decode.array(decode.string),',
      '});',
      'const DeferredUserDecoder = decode.lazy(() => UserDecoder);',
      'const NullableNameDecoder = decode.nullable(decode.string);',
      'const DefaultNickname = decode.defaulted(decode.optionalField("nickname", decode.string), "anon");',
      'const FeatureFlags = decode.readonlyRecord(decode.string);',
      'const decoded = UserDecoder.decode({ id: "user-1", tags: ["a"] });',
      'const BigDecoder = decode.object({ total: decode.bigint });',
      'const UserEq = compare.lazyEq(() => compare.stringEq);',
      'const UserArrayEq = compare.arrayEq(UserEq);',
      'const UserHash = hash.contramap(hash.stringHash, (user: { id: string }) => user.id);',
      'const UserArrayHash = hash.arrayHash(UserHash);',
      'const UserIdCodec = codec.imap(',
      '  codec.stringCodec,',
      '  (value: string) => ({ value }),',
      '  (id: { value: string }) => id.value,',
      ');',
      'const encoded = UserIdCodec.encode({ value: "user-1" });',
      'const DeferredUserEncoder = encode.lazy(() => encode.stringEncoder);',
      'const StringArrayEncoder = encode.array(encode.stringEncoder);',
      'const JsonEncoder = encode.object({ total: encode.bigintEncoder, nickname: encode.optional(encode.stringEncoder) });',
      'const JsonRecord = json.copyJsonRecord({ ok: true });',
      'const MergedJsonRecord = json.mergeJsonRecords(json.emptyJsonRecord(), JsonRecord, { extra: false });',
      'const IsJsonRecord = json.isJsonObject(MergedJsonRecord);',
      'const jsonText = json.encodeJson({ total: 12n, nickname: undefined }, JsonEncoder, { bigint: "number" });',
      'const decodedJson = json.decodeJson("{\\"total\\":9007199254740993}", BigDecoder);',
      'const mappedErr = result.mapErr(result.err("boom"), (error: string) => error.length);',
      'const collectedResults = result.collect([result.ok(1), result.ok(2)]);',
      'const observedErr = result.tapErr(result.err("boom"), (error: string) => error.length);',
      'const fallbackValue = result.unwrapOr(result.err("boom"), 0);',
      'const fallbackValueFromFn = result.unwrapOrElse(result.err("boom"), (error: string) => error.length);',
      'const thrownValue = result.unwrapOrThrow(result.ok(1));',
      'const thrownSomeValue = result.unwrapOrThrow(result.some(1));',
      'const task = async.map(async.succeed(1), (value: number) => value + 1);',
      'const hashCode: number = UserHash.hash({ id: "user-1" });',
      'const encodedText: string = encoded.tag === "ok" ? encoded.value : "nope";',
      'void matched;',
      'void decoded;',
      'void decodedJson;',
      'void eq;',
      'void deriveCodec;',
      'void deriveDecode;',
      'void deriveEncode;',
      'void deriveHash;',
      'void DefaultNickname;',
      'void DeferredUserDecoder;',
      'void DeferredUserEncoder;',
      'void FeatureFlags;',
      'void IsJsonRecord;',
      'void JsonRecord;',
      'void MergedJsonRecord;',
      'void NullableNameDecoder;',
      'void StringArrayEncoder;',
      'void UserArrayEq;',
      'void UserArrayHash;',
      'void collectedResults;',
      'void fallbackValue;',
      'void fallbackValueFromFn;',
      'void thrownSomeValue;',
      'void thrownValue;',
      'void mappedErr;',
      'void observedErr;',
      'void tagged;',
      'void hashCode;',
      'void encodedText;',
      'void jsonText;',
      'void metadata;',
      'void task;',
      '',
    ].join('\n'),
  });

  assertEquals(preparedProgram.frontendDiagnostics(), []);
  assertEquals(
    ts.getPreEmitDiagnostics(preparedProgram.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('stdlib object helpers preserve optional properties under exactOptionalPropertyTypes', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import * as decode from 'sts:decode';",
      "import * as encode from 'sts:encode';",
      "import type { Result } from 'sts:result';",
      '',
      'type User = {',
      '  readonly id: string;',
      '  readonly nickname?: string;',
      '};',
      '',
      'const UserDecoder = decode.object({',
      '  id: decode.string,',
      '  nickname: decode.optional(decode.string),',
      '});',
      'const UserEncoder = encode.object({',
      '  id: encode.stringEncoder,',
      '  nickname: encode.optional(encode.stringEncoder),',
      '});',
      '',
      "const decoded: Result<User, unknown> = UserDecoder.decode({ id: 'user-1' });",
      "const encoded = UserEncoder.encode({ id: 'user-1' } satisfies User);",
      'void decoded;',
      'void encoded;',
      '',
    ].join('\n'),
  }, {
    compilerOptions: {
      exactOptionalPropertyTypes: true,
    },
  });

  assertEquals(preparedProgram.frontendDiagnostics(), []);
  assertEquals(
    ts.getPreEmitDiagnostics(preparedProgram.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('encode contramap preserves sync mode for exact-optional object projections', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import * as encode from 'sts:encode';",
      "import type { Result } from 'sts:result';",
      '',
      'type User = {',
      '  readonly id: string;',
      '  readonly nickname?: string;',
      '};',
      '',
      'const UserEncoder = encode.contramap(',
      '  encode.object({',
      '    id: encode.stringEncoder,',
      '    nickname: encode.optional(encode.stringEncoder),',
      '  }),',
      '  (value: User) => ({',
      '    id: value.id,',
      '    ...(value.nickname === undefined ? {} : { nickname: value.nickname }),',
      '  }),',
      ');',
      '',
      "const encoded: Result<{ readonly id: string; readonly nickname?: string }, unknown> = UserEncoder.encode({ id: 'user-1' } satisfies User);",
      'void encoded;',
      '',
    ].join('\n'),
  }, {
    compilerOptions: {
      exactOptionalPropertyTypes: true,
    },
  });

  assertEquals(preparedProgram.frontendDiagnostics(), []);
  assertEquals(
    ts.getPreEmitDiagnostics(preparedProgram.program).map((diagnostic) => diagnostic.code),
    [],
  );
});
