import { assertEquals } from '@std/assert';

import { Bytes } from './bytes.ts';
import { hasCapability } from './capabilities.ts';
import { Cli } from './cli.ts';
import { Env } from './env.ts';
import { Failure } from './failures.ts';
import { Fs } from './fs.ts';
import { Http } from './http.ts';
import { Net } from './net.ts';
import { Process } from './process.ts';
import { err, ok } from './result.ts';

Deno.test('node provider fs reads and writes AsyncResult values', async () => {
  const tempDirectory = await Deno.makeTempDir();
  const path = `${tempDirectory}/nested/value.txt`;
  try {
    assertEquals((await Fs.mkdir(`${tempDirectory}/nested`)).tag, 'ok');
    assertEquals((await Fs.writeTextFile(path, 'sound')).tag, 'ok');
    const read = await Fs.readTextFile(path);
    const bytes = await Fs.readFile(path);
    const stat = await Fs.stat(path);
    const entries = await Fs.readDir(`${tempDirectory}/nested`);
    const exists = await Fs.exists(path);
    const noCreate = await Fs.writeTextFile(`${tempDirectory}/nested/no-create.txt`, 'missing', {
      create: false,
    });
    const noTruncatePath = `${tempDirectory}/nested/no-truncate.txt`;
    const latin1Path = `${tempDirectory}/nested/latin1.txt`;
    await Fs.writeTextFile(noTruncatePath, 'abcdef');
    await Fs.writeTextFile(noTruncatePath, 'xy', { truncate: false });
    await Fs.writeTextFile(latin1Path, 'é', { encoding: 'latin1' });
    const noTruncate = await Fs.readTextFile(noTruncatePath);
    const latin1 = await Fs.readFile(latin1Path);

    assertEquals(read.tag === 'ok' ? read.value : undefined, 'sound');
    assertEquals(bytes.tag === 'ok' ? Bytes.toString(bytes.value) : undefined, 'sound');
    assertEquals(stat.tag === 'ok' ? stat.value.type : undefined, 'file');
    assertEquals(entries.tag === 'ok' ? entries.value[0]?.name : undefined, 'value.txt');
    assertEquals(exists.tag === 'ok' ? exists.value : undefined, true);
    assertEquals(noCreate.tag, 'err');
    assertEquals(noTruncate.tag === 'ok' ? noTruncate.value : undefined, 'xycdef');
    assertEquals(latin1.tag === 'ok' ? [...latin1.value] : undefined, [233]);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true });
  }
});

Deno.test('node provider env and process expose host state through Result', () => {
  const variable = `SOUNDSCRIPT_TEST_${Date.now()}`;

  assertEquals(Env.set(variable, 'ok').tag, 'ok');
  const required = Env.required(variable);
  const hasVariable = Env.has(variable);
  assertEquals(required.tag === 'ok' ? required.value : undefined, 'ok');
  assertEquals(hasVariable.tag === 'ok' ? hasVariable.value : undefined, true);
  assertEquals(Env.toRecord().tag, 'ok');
  assertEquals(Env.remove(variable).tag, 'ok');
  assertEquals(Process.cwd().tag, 'ok');
  assertEquals(Process.info().tag, 'ok');
});

Deno.test('node provider net resolves localhost', async () => {
  const result = await Net.lookupHost('localhost');

  assertEquals(result.tag, 'ok');
  assertEquals(hasCapability('net.dns'), true);
});

Deno.test('node provider cli exposes arguments and terminal metadata through Result', () => {
  assertEquals(Cli.args().tag, 'ok');
  assertEquals(Cli.stdio().tag, 'ok');
  assertEquals(Cli.isTerminal('stdout').tag, 'ok');
  assertEquals(Cli.terminalSize().tag, 'ok');
});

Deno.test('node provider http serves Web Request and Response handlers', async () => {
  const serverResult = Http.server({
    hostname: '127.0.0.1',
    port: 0,
    handle(request) {
      const path = new URL(request.url).pathname;
      if (path === '/async') {
        return Promise.resolve(ok(new Response('async')));
      }
      if (path === '/echo') {
        return (async () => ok(new Response(await request.text())))();
      }
      if (path === '/fail') {
        return Promise.resolve(err(new Failure('http failure')));
      }
      return new Response(`web:${path}`);
    },
  });

  assertEquals(serverResult.tag, 'ok');
  if (serverResult.tag === 'err') {
    return;
  }

  const serving = serverResult.value.serve();
  try {
    const port = await waitForHttpServerPort(serverResult.value);
    const response = await fetch(`http://127.0.0.1:${port}/hello`);
    const asyncResponse = await fetch(`http://127.0.0.1:${port}/async`);
    const echoResponse = await fetch(`http://127.0.0.1:${port}/echo`, {
      body: 'body',
      method: 'POST',
    });
    const failResponse = await fetch(`http://127.0.0.1:${port}/fail`);
    assertEquals(await response.text(), 'web:/hello');
    assertEquals(await asyncResponse.text(), 'async');
    assertEquals(await echoResponse.text(), 'body');
    assertEquals(failResponse.status, 500);
    assertEquals(await failResponse.text(), 'http failure');
  } finally {
    assertEquals((await serverResult.value.close()).tag, 'ok');
    assertEquals((await serving).tag, 'ok');
  }
});

Deno.test('node provider http keeps low-level Node handler compatibility', async () => {
  const serverResult = await Http.serve(
    { hostname: '127.0.0.1', port: 0 },
    (_request, response) => {
      response.statusCode = 200;
      response.end('node');
    },
  );

  assertEquals(serverResult.tag, 'ok');
  if (serverResult.tag === 'err') {
    return;
  }

  try {
    const response = await fetch(`http://127.0.0.1:${serverResult.value.port}/`);
    assertEquals(await response.text(), 'node');
  } finally {
    assertEquals((await serverResult.value.close()).tag, 'ok');
  }
});

Deno.test('node provider http serve exits when signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await Http.serve({
    hostname: '127.0.0.1',
    port: 0,
    signal: controller.signal,
    handle() {
      return new Response('unused');
    },
  });

  assertEquals(result.tag, 'ok');
});

async function waitForHttpServerPort(server: { readonly address: { readonly port: number } }) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.address.port !== 0) {
      return server.address.port;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('HTTP server did not start listening.');
}
