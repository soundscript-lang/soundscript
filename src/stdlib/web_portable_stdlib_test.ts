import { assertEquals } from '@std/assert';

import { decodeUtf8, encodeUtf8 } from './text.ts';
import { fromBytes, readAllBytes, readAllText, writeAllBytes } from './streams.ts';
import { Bytes } from './bytes.ts';
import { readBytes, readJson, readText, request } from './fetch.ts';
import { hasCapability } from './capabilities.ts';
import { fillRandom, randomBytes, uuidV4 } from './random.ts';
import { format, parse, posix, relative, windows } from './path.ts';
import { canParseUrl, fileUrlToPath, parseUrl, pathToFileUrl, URL } from './url.ts';
import { ok } from './result.ts';

Deno.test('streams helpers read and write Web byte streams', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Bytes.fromString('sound'));
      controller.enqueue(Bytes.fromString('script'));
      controller.close();
    },
  });

  const bytes = await readAllBytes(stream);
  assertEquals(bytes.tag === 'ok' ? Bytes.toString(bytes.value) : undefined, 'soundscript');

  const text = await readAllText(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Bytes.fromString('portable'));
        controller.close();
      },
    }),
  );
  assertEquals(text, ok('portable'));

  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });

  assertEquals((await writeAllBytes(writable, Bytes.fromString('io'))).tag, 'ok');
  assertEquals(Bytes.toString(Bytes.concat(written)), 'io');
});

Deno.test('streams helpers normalize low-level byte views', async () => {
  const buffer = new ArrayBuffer(6);
  Bytes.copyTo(Bytes.fromString('prefix'), Bytes.view(buffer));
  const bytes = await readAllBytes(fromBytes(new DataView(buffer, 3, 3)));

  assertEquals(bytes.tag === 'ok' ? Bytes.toString(bytes.value) : undefined, 'fix');

  if (typeof SharedArrayBuffer === 'function') {
    const shared = Bytes.view(new SharedArrayBuffer(2));
    Bytes.copyTo(Bytes.fromString('sh'), shared);
    const sharedBytes = await readAllBytes(fromBytes(shared.buffer));
    assertEquals(sharedBytes.tag === 'ok' ? Bytes.toString(sharedBytes.value) : undefined, 'sh');
  }
});

Deno.test('fetch helpers normalize Web Response reads to AsyncResult values', async () => {
  const response = new Response('sound');

  assertEquals(await readText(response), ok('sound'));

  const bytes = await readBytes(new Response('bytes'));
  assertEquals(bytes.tag === 'ok' ? Bytes.toString(bytes.value) : undefined, 'bytes');

  const json = await readJson(new Response('{"ok":true}'), {
    decode(value: unknown) {
      return ok((value as { ok: boolean }).ok);
    },
    validateDecode(value: unknown) {
      return ok((value as { ok: boolean }).ok);
    },
  });
  assertEquals(json, ok(true));
});

Deno.test('request helper normalizes failed fetch calls to Result failures', async () => {
  const result = await request('http://127.0.0.1:1/__soundscript_unreachable__');

  assertEquals(result.tag, 'err');
});

Deno.test('text helpers encode and decode utf8 with Result errors', () => {
  const encoded = encodeUtf8('hello');
  assertEquals(encoded.tag === 'ok' ? Bytes.toString(encoded.value) : undefined, 'hello');

  const decoded = decodeUtf8(Bytes.fromString('world'));
  assertEquals(decoded, ok('world'));
});

Deno.test('url helpers expose result-oriented parsing', () => {
  const parsed = parseUrl('/api', 'https://example.com/root/');
  assertEquals(parsed.tag === 'ok' ? parsed.value.href : undefined, 'https://example.com/api');
  assertEquals(canParseUrl('/api', 'https://example.com/root/'), true);
  assertEquals(parseUrl('http://[').tag, 'err');
  assertEquals(canParseUrl('http://['), false);
});

Deno.test('url file path helpers fail explicitly until target path providers own them', () => {
  const fileUrl = new URL('file:///tmp/sound.txt');

  assertEquals(fileUrlToPath(fileUrl).tag, 'err');
  assertEquals(pathToFileUrl('/tmp/sound.txt').tag, 'err');
});

Deno.test('random helpers expose crypto random bytes and uuids', () => {
  const bytes = randomBytes(16);
  assertEquals(bytes.tag === 'ok' ? bytes.value.byteLength : undefined, 16);

  const target = new Uint8Array(8);
  assertEquals(fillRandom(target).tag, 'ok');
  assertEquals(target.byteLength, 8);

  const uuid = uuidV4();
  assertEquals(uuid.tag, 'ok');
  if (uuid.tag === 'ok') {
    assertEquals(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        uuid.value,
      ),
      true,
    );
  }
});

Deno.test('path helpers expose posix and windows APIs', () => {
  assertEquals(relative('/tmp/app/src', '/tmp/app/test/spec.ts'), '../test/spec.ts');
  assertEquals(posix.join('/tmp', 'sound', '..', 'script.ts'), '/tmp/script.ts');
  assertEquals(windows.normalize('C:\\tmp\\sound\\..\\script.ts'), 'C:\\tmp\\script.ts');

  const parsed = parse('/tmp/archive.tar.gz');
  assertEquals(parsed, {
    root: '/',
    dir: '/tmp',
    base: 'archive.tar.gz',
    ext: '.gz',
    name: 'archive.tar',
  });
  assertEquals(format(parsed), '/tmp/archive.tar.gz');
});

Deno.test('capabilities expose web platform style names', () => {
  assertEquals(hasCapability('platform.console'), true);
  assertEquals(hasCapability('platform.streams'), true);
  assertEquals(hasCapability('platform.text'), true);
  assertEquals(hasCapability('platform.crypto.random'), true);
});
