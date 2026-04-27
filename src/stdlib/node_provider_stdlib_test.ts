import { assertEquals } from '@std/assert';

import { Env } from './env.ts';
import { Fs } from './fs.ts';
import { Http } from './http.ts';
import { Net } from './net.ts';
import { Process } from './process.ts';

Deno.test('node provider fs reads and writes AsyncResult values', async () => {
  const tempDirectory = await Deno.makeTempDir();
  const path = `${tempDirectory}/nested/value.txt`;
  try {
    assertEquals((await Fs.writeText(path, 'sound', { createParentDirectories: true })).tag, 'ok');
    const read = await Fs.readText(path);
    const exists = await Fs.exists(path);

    assertEquals(read.tag === 'ok' ? read.value : undefined, 'sound');
    assertEquals(exists.tag === 'ok' ? exists.value : undefined, true);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true });
  }
});

Deno.test('node provider env and process expose host state through Result', () => {
  const variable = `SOUNDSCRIPT_TEST_${Date.now()}`;

  assertEquals(Env.set(variable, 'ok').tag, 'ok');
  const required = Env.require(variable);
  assertEquals(required.tag === 'ok' ? required.value : undefined, 'ok');
  assertEquals(Env.remove(variable).tag, 'ok');
  assertEquals(Process.cwd().tag, 'ok');
  assertEquals(Process.pid().tag, 'ok');
});

Deno.test('node provider net resolves localhost', async () => {
  const result = await Net.lookup('localhost');

  assertEquals(result.tag, 'ok');
});

Deno.test('node provider http serves and closes a loopback server', async () => {
  const serverResult = await Http.serve(
    { hostname: '127.0.0.1', port: 0 },
    (_request, response) => {
      response.statusCode = 200;
      response.end('ok');
    },
  );

  assertEquals(serverResult.tag, 'ok');
  if (serverResult.tag === 'err') {
    return;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${serverResult.value.port}/`);
    assertEquals(await response.text(), 'ok');
  } finally {
    assertEquals((await serverResult.value.close()).tag, 'ok');
  }
});
