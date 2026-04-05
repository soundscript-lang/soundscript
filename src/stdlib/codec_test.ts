import { assertEquals } from '@std/assert';

import { isOk, ok } from '@soundscript/soundscript/result';

import { string } from './decode.ts';
import {
  codec,
  codecInvariant,
  contramap,
  imap,
  numberEncoder,
  stringCodec,
  stringEncoder,
} from './codec.ts';

Deno.test('codec primitive codecs expose both decode and encode', () => {
  assertEquals(stringCodec.decode('user-1'), ok('user-1'));
  assertEquals(stringCodec.encode('user-1'), ok('user-1'));
});

Deno.test('codec imap lifts a base codec into a richer shape', () => {
  type UserId = { readonly value: string };

  const UserIdCodec = imap(
    stringCodec,
    (value: string): UserId => ({ value }),
    (id: UserId) => id.value,
  );

  assertEquals(UserIdCodec.decode('user-1'), ok({ value: 'user-1' }));
  assertEquals(UserIdCodec.encode({ value: 'user-1' }), ok('user-1'));
});

Deno.test('codec contramap projects an encoder input before encoding', () => {
  type UserId = { readonly value: string };

  const UserIdEncoder = contramap(
    stringEncoder,
    (id: UserId) => id.value,
  );

  assertEquals(UserIdEncoder.encode({ value: 'user-1' }), ok('user-1'));
});

Deno.test('codec invariant instance maps both decode and encode directions', () => {
  type UserId = { readonly value: string };

  const UserIdCodec = codecInvariant<string>().imap(
    stringCodec,
    (value: string): UserId => ({ value }),
    (id: UserId) => id.value,
  );

  assertEquals(UserIdCodec.decode('user-1'), ok({ value: 'user-1' }));
  assertEquals(UserIdCodec.encode({ value: 'user-1' }), ok('user-1'));
});

Deno.test('codec combines a separate decoder and encoder contract', () => {
  const LengthCodec = codec(
    string,
    contramap(numberEncoder, (value: string) => value.length),
  );

  const decoded = LengthCodec.decode('abcd');
  const encoded = LengthCodec.encode('abcd');

  assertEquals(isOk(decoded), true);
  assertEquals(encoded, ok(4));
});
