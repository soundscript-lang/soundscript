import { assertEquals } from '@std/assert';

import { isErr, isOk, ok } from '@soundscript/soundscript/result';

import { string } from './decode.ts';
import {
  codec,
  codecInvariant,
  contramap,
  imap,
  isoDate,
  numberEncoder,
  stringCodec,
  stringEncoder,
  url,
} from './codec.ts';
import { URL } from './url.ts';

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

Deno.test('codec isoDate decodes ISO strings to Date values and encodes back to strings', () => {
  const decoded = isoDate.decode('2024-01-02T03:04:05.000Z');
  const encoded = isoDate.encode(new Date('2024-01-02T03:04:05.000Z'));

  assertEquals(isOk(decoded), true);
  if (isErr(decoded)) {
    throw new Error('expected isoDate decode to succeed');
  }
  assertEquals(decoded.value.toISOString(), '2024-01-02T03:04:05.000Z');
  assertEquals(encoded, ok('2024-01-02T03:04:05.000Z'));
});

Deno.test('codec url decodes URL strings to URL values and encodes back to href', () => {
  const decoded = url.decode('https://example.com/path?q=1');
  const encoded = url.encode(new URL('https://example.com/path?q=1'));

  assertEquals(isOk(decoded), true);
  if (isErr(decoded)) {
    throw new Error('expected url decode to succeed');
  }
  assertEquals(decoded.value.href, 'https://example.com/path?q=1');
  assertEquals(encoded, ok('https://example.com/path?q=1'));
});
