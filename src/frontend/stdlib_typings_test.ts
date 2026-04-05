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
      'const jsonText = json.encodeJson({ total: 12n, nickname: undefined }, JsonEncoder, { bigint: "number" });',
      'const decodedJson = json.decodeJson("{\\"total\\":9007199254740993}", BigDecoder);',
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
      'void DeferredUserDecoder;',
      'void DeferredUserEncoder;',
      'void StringArrayEncoder;',
      'void UserArrayEq;',
      'void UserArrayHash;',
      'void tagged;',
      'void hashCode;',
      'void encodedText;',
      'void jsonText;',
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
