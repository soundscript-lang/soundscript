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
import { readAllText, writeAllBytes } from './streams.ts';
import { Duration } from './time.ts';

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgE8peNPets+qmSHFl
ow9wcVaPzz6zLUGRQAQlMO7/aWqhRANCAAQLvA8wqUUnglgvRdLE6R3gRRHas3Jg
dktbeR1meNbwGHhW/aG4Ygq45q70LGywoFaehFvWcJhnt8LKuZELWYla
-----END PRIVATE KEY-----
`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBmjCCAT+gAwIBAgIUDArU7mOwU3WMpPS1UVmgy0rmWJowCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDUwMjAyNDQxMFoXDTI3MDUwMjAy
NDQxMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEC7wPMKlFJ4JYL0XSxOkd4EUR2rNyYHZLW3kdZnjW8Bh4Vv2huGIKuOau
9CxssKBWnoRb1nCYZ7fCyrmRC1mJWqNvMG0wHQYDVR0OBBYEFN8m7HfKOdMB6XAT
0DHS3Fnri6uNMB8GA1UdIwQYMBaAFN8m7HfKOdMB6XAT0DHS3Fnri6uNMA8GA1Ud
EwEB/wQFMAMBAf8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49
BAMCA0kAMEYCIQCpcO4XADr/rKSkoPWgWUP7P/NiHc7tasxRS5X0shTpRQIhAPa3
NOqUIa71l4JQaWGbIwAcoWhteATnwFJtNQGocg7+
-----END CERTIFICATE-----
`;

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
  assertEquals(hasCapability('process.child'), true);
});

Deno.test('node provider process runs child commands and exposes piped output', async () => {
  const output = await Process.output(Deno.execPath(), {
    args: ['eval', 'console.log("sound")'],
  });

  assertEquals(output.tag, 'ok');
  assertEquals(output.tag === 'ok' ? Bytes.toString(output.value.stdout) : undefined, 'sound\n');
  assertEquals(output.tag === 'ok' ? output.value.success : undefined, true);

  const failed = await Process.output(Deno.execPath(), {
    args: ['eval', 'Deno.exit(7)'],
  });
  assertEquals(failed.tag === 'ok' ? failed.value.success : undefined, false);
  assertEquals(failed.tag === 'ok' ? failed.value.code : undefined, 7);

  const child = await Process.spawn(Deno.execPath(), {
    args: ['eval', 'console.log("spawned")'],
    stdout: 'piped',
    stderr: 'piped',
  });

  assertEquals(child.tag, 'ok');
  if (child.tag === 'err') {
    return;
  }

  const text = child.value.stdout ? await readAllText(child.value.stdout) : undefined;
  const status = await child.value.status();
  const cachedStatus = await child.value.status();

  assertEquals(text?.tag === 'ok' ? text.value : undefined, 'spawned\n');
  assertEquals(status.tag === 'ok' ? status.value.success : undefined, true);
  assertEquals(cachedStatus.tag === 'ok' ? cachedStatus.value.success : undefined, true);
});

Deno.test('node provider net resolves localhost', async () => {
  const result = await Net.lookupHost('localhost');

  assertEquals(result.tag, 'ok');
  assertEquals(hasCapability('net.dns'), true);
});

Deno.test('node provider net opens TCP loopback streams', async () => {
  const listener = await Net.listen({ hostname: '127.0.0.1', port: 0 });

  assertEquals(listener.tag, 'ok');
  assertEquals(hasCapability('net.tcp'), true);
  if (listener.tag === 'err') {
    return;
  }

  const accepted = listener.value.accept();
  const client = await Net.connect(listener.value.address);

  assertEquals(client.tag, 'ok');
  if (client.tag === 'err') {
    await listener.value.close();
    return;
  }

  const server = await accepted;
  assertEquals(server.tag, 'ok');
  if (server.tag === 'err') {
    await client.value.close();
    await listener.value.close();
    return;
  }

  try {
    assertEquals(
      await writeAllBytes(client.value.writable, Bytes.fromString('ping')),
      ok(undefined),
    );

    const serverReader = server.value.readable.getReader();
    const request = await serverReader.read();
    serverReader.releaseLock();
    assertEquals(
      request.value ? Bytes.toString(new Uint8Array(request.value.buffer)) : undefined,
      'ping',
    );

    const serverWriter = server.value.writable.getWriter();
    await serverWriter.write(Bytes.fromString('pong'));
    await serverWriter.close();
    serverWriter.releaseLock();

    const response = await readAllText(client.value.readable);
    assertEquals(response.tag === 'ok' ? response.value : undefined, 'pong');
  } finally {
    await client.value.close();
    await server.value.close();
    await listener.value.close();
  }
});

Deno.test('node provider net opens TLS loopback streams', async () => {
  const listener = await Net.listenTls({
    cert: TEST_TLS_CERT,
    key: TEST_TLS_KEY,
    port: 0,
  });

  assertEquals(listener.tag, 'ok');
  assertEquals(hasCapability('net.tls'), true);
  if (listener.tag === 'err') {
    return;
  }

  const accepted = listener.value.accept();
  const client = await Net.connectTls({
    hostname: '127.0.0.1',
    port: listener.value.address.port,
    rejectUnauthorized: false,
    serverName: 'localhost',
  });

  assertEquals(client.tag, 'ok');
  if (client.tag === 'err') {
    await listener.value.close();
    return;
  }

  const server = await accepted;
  assertEquals(server.tag, 'ok');
  if (server.tag === 'err') {
    await client.value.close();
    await listener.value.close();
    return;
  }

  try {
    assertEquals(typeof client.value.authorized, 'boolean');
    assertEquals(
      await writeAllBytes(client.value.writable, Bytes.fromString('secure-ping')),
      ok(undefined),
    );

    const serverReader = server.value.readable.getReader();
    const request = await serverReader.read();
    serverReader.releaseLock();
    assertEquals(
      request.value ? Bytes.toString(new Uint8Array(request.value.buffer)) : undefined,
      'secure-ping',
    );

    const serverWriter = server.value.writable.getWriter();
    await serverWriter.write(Bytes.fromString('secure-pong'));
    await serverWriter.close();
    serverWriter.releaseLock();

    const response = await readAllText(client.value.readable);
    assertEquals(response.tag === 'ok' ? response.value : undefined, 'secure-pong');
  } finally {
    await client.value.close();
    await server.value.close();
    await listener.value.close();
  }
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

Deno.test('node provider http listen returns a ready Web server', async () => {
  const serverResult = await Http.listen({
    hostname: '127.0.0.1',
    port: 0,
    handle(request) {
      return new Response(`ready:${new URL(request.url).pathname}`);
    },
  });

  assertEquals(serverResult.tag, 'ok');
  if (serverResult.tag === 'err') {
    return;
  }

  try {
    assertEquals(serverResult.value.address.port > 0, true);
    const response = await fetch(`http://127.0.0.1:${serverResult.value.address.port}/listen`);
    assertEquals(await response.text(), 'ready:/listen');
  } finally {
    assertEquals((await serverResult.value.close()).tag, 'ok');
  }
});

Deno.test('node provider http close accepts force deadlines', async () => {
  const serverResult = await Http.listen({
    hostname: '127.0.0.1',
    port: 0,
    handle() {
      return new Response('closing');
    },
  });

  assertEquals(serverResult.tag, 'ok');
  if (serverResult.tag === 'err') {
    return;
  }

  const response = await fetch(`http://127.0.0.1:${serverResult.value.address.port}/slow`);
  assertEquals(await response.text(), 'closing');
  const closed = await serverResult.value.close({ forceAfter: Duration.milliseconds(1) });

  assertEquals(closed.tag, 'ok');
  assertEquals((await serverResult.value.closed()).tag, 'ok');
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
