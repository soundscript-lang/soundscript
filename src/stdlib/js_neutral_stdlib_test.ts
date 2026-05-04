import { assertEquals } from '@std/assert';

import { Bytes } from './bytes.ts';
import { hasCapability, requireCapability } from './capabilities.ts';
import { log } from './console.ts';
import { Crypto } from './crypto.ts';
import { Digest } from './crypto/digest.ts';
import { Hmac } from './crypto/hmac.ts';
import { basename, dirname, join, normalize } from './path.ts';
import { Duration, monotonic, sleep, wall } from './time.ts';

function toHex(bytes: Bytes): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.test('bytes helpers encode concatenate and compare byte arrays', () => {
  const left = Bytes.fromString('sound');
  const right = Bytes.fromString('script');
  const joined = Bytes.concat([left, right]);

  assertEquals(Bytes.toString(joined), 'soundscript');
  assertEquals(Bytes.equals(joined, Bytes.fromString('soundscript')), true);
});

Deno.test('path helpers normalize portable posix paths', () => {
  assertEquals(join('/tmp', 'sound', '..', 'script.ts'), '/tmp/script.ts');
  assertEquals(normalize('a//b/../c'), 'a/c');
  assertEquals(dirname('/tmp/script.ts'), '/tmp');
  assertEquals(basename('/tmp/script.ts'), 'script.ts');
});

Deno.test('time helpers expose clocks and cancellable sleep', async () => {
  const before = monotonic.now();
  const wallNow = wall.now();
  const slept = await sleep(Duration.milliseconds(0));

  assertEquals(before.tag, 'ok');
  assertEquals(wallNow.tag, 'ok');
  assertEquals(slept.tag, 'ok');
});

Deno.test('capability manifest exposes known portable modules', () => {
  assertEquals(hasCapability('console'), true);
  assertEquals(hasCapability('crypto.digest'), true);
  assertEquals(requireCapability('console').tag, 'ok');
  assertEquals(requireCapability('__missing__').tag, 'err');
});

Deno.test('console module forwards to a stable console surface', () => {
  log('soundscript console smoke');
});

Deno.test('crypto helpers digest hmac random and compare bytes', async () => {
  const input = Bytes.fromString('soundscript');
  const digest = await Crypto.digest('SHA-256', input);
  const hmac = await Crypto.hmac('SHA-256', Bytes.fromString('key'), input);
  const submoduleDigest = await Digest.digest('SHA-256', input);
  const submoduleHmac = await Hmac.hmac('SHA-256', Bytes.fromString('key'), input);
  const random = Crypto.randomBytes(16);

  assertEquals(digest.tag, 'ok');
  assertEquals(
    digest.tag === 'ok' ? toHex(digest.value) : undefined,
    'ed8cc2f301c46ea8443caed6825e9a9f8fbacd9b7703e27d3e82c18c3ff483ce',
  );
  assertEquals(hmac.tag, 'ok');
  assertEquals(
    hmac.tag === 'ok' ? toHex(hmac.value) : undefined,
    '1cbabb825d89715618fed01085095c8d137c396058db97a715c328f138f28ff8',
  );
  assertEquals(submoduleDigest, digest);
  assertEquals(submoduleHmac, hmac);
  assertEquals(random.tag, 'ok');
  assertEquals(random.tag === 'ok' ? random.value.byteLength : undefined, 16);
  const equal = Crypto.timingSafeEqual(input, Bytes.fromString('soundscript'));
  const different = Crypto.timingSafeEqual(input, Bytes.fromString('soundstage'));
  assertEquals(equal.tag, 'ok');
  assertEquals(equal.tag === 'ok' ? equal.value : undefined, true);
  assertEquals(different.tag, 'ok');
  assertEquals(different.tag === 'ok' ? different.value : undefined, false);
});
