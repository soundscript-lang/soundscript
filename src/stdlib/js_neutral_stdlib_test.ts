import { assertEquals } from '@std/assert';

import { Bytes } from './bytes.ts';
import { hasCapability, requireCapability } from './capabilities.ts';
import { log } from './console.ts';
import { basename, dirname, join, normalize } from './path.ts';
import { Duration, monotonic, sleep, wall } from './time.ts';

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
  assertEquals(requireCapability('console').tag, 'ok');
  assertEquals(requireCapability('__missing__').tag, 'err');
});

Deno.test('console module forwards to a stable console surface', () => {
  log('soundscript console smoke');
});
