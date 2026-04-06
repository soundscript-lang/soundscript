import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, join } from '@std/path';

import {
  createInvalidDeepValueRouteProgram,
  createValueRouteProgram,
  getValueModeSlug,
  getValueRouteSlug,
  prefixValueMatrixProgram,
  VALUE_MODES,
  VALUE_ROUTES,
} from '../../test/value_matrix.ts';
import {
  analyzePreparedProject,
  analyzePreparedProjectForFile,
  analyzeProject,
  prepareProjectAnalysis,
} from '../checker/analyze_project.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../test_installed_stdlib.ts';

async function createTempProject(files: Readonly<Record<string, string>>): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-ts-service-' });

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(tempDirectory, relativePath);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(
      absolutePath,
      maybeNormalizeTsconfigForInstalledStdlib(relativePath, contents),
    );
  }

  await writeInstalledStdlibPackage(tempDirectory);
  return tempDirectory;
}

function createSoundscriptOnlyTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
      },
      include: ['src/**/*.sts'],
    },
    null,
    2,
  );
}

async function createValueAnalysisProject(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  return createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    ...files,
  });
}

async function createMacroProject(
  macroSourceText: string,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<string> {
  return createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/macros/twice.macro.sts': macroSourceText,
    'src/index.sts': [
      "import { Twice } from './macros/twice.macro';",
      'const value: number = Twice();',
      '',
    ].join('\n'),
    ...extraFiles,
  });
}

function createUserDefinedTwiceMacroText(): string {
  return [
    "import { macroSignature } from 'sts:macros';",
    '',
    '// #[macro(call)]',
    'export function Twice() {',
    '  return {',
    '    signature: macroSignature.of(macroSignature.expr("value")),',
    '    expand(ctx: any, signature: any) {',
    '      if (!signature) {',
    "        throw new Error('expected signature');",
    '      }',
    '      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

function createUserDefinedAugmentMacroText(): string {
  return [
    "import { macroSignature } from 'sts:macros';",
    '',
    '// #[macro(decl)]',
    'export function augment() {',
    '  return {',
    '    declarationKinds: ["class"] as const,',
    "    expansionMode: 'augment' as const,",
    '    signature: macroSignature.of(macroSignature.decl("target")),',
    '    expand(ctx: any) {',
    '      const name = ctx.syntax.declaration().name ?? ctx.error("expected named declaration");',
    '      return ctx.output.stmt(',
    '        ctx.quote.stmt`export const ${`${name}Registry`} = ${name};`,',
    '      );',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

function createTopLevelMutatingMacroText(): string {
  return createMacroTextWithTopLevelBody([
    'const values = [1];',
    'values.push(2);',
  ].join('\n'));
}

function createMacroTextWithTopLevelBody(body: string): string {
  return [
    "import 'sts:macros';",
    '',
    body,
    '',
    '// #[macro(call)]',
    'export function Twice() {',
    '  return {',
    '    expand(ctx: any) {',
    '      return ctx.output.expr(ctx.quote.expr`1`);',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

const topLevelAccessorMacroCases = [
  {
    label: 'object getter accessor',
    body: [
      'const state = {',
      '  get value() {',
      '    return 1;',
      '  },',
      '};',
      'state.value;',
    ].join('\n'),
    extraFiles: undefined,
  },
  {
    label: 'class getter accessor',
    body: [
      'class Counter {',
      '  get value() {',
      '    return 1;',
      '  }',
      '}',
      'const counterObj = new Counter();',
      'counterObj.value;',
    ].join('\n'),
    extraFiles: undefined,
  },
] as const;
Deno.test('analyzeProject returns merged diagnostics for a tsconfig project', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': "const coerced = JSON.parse('1') as number;\n",
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.summary.total, 1);
  assertEquals(result.diagnostics[0]?.code, 'SOUND1002');
});

Deno.test('analyzeProject uses sound stdlib typing for JSON.parse', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'const value: JsonValue = JSON.parse("{}");\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject allows WeakMap and WeakSet on js-node but rejects them on wasm-wasi', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const weakMap: WeakMap<object, number> = new WeakMap();',
      'const weakSet: WeakSet<object> = new WeakSet();',
      'void weakMap;',
      'void weakSet;',
      '',
    ].join('\n'),
  });

  const jsNodeResult = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });
  const wasmWasiResult = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'wasm-wasi',
    workingDirectory: tempDirectory,
  });

  assertEquals(jsNodeResult.diagnostics, []);
  assertEquals(wasmWasiResult.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1022',
    'SOUND1022',
    'SOUND1022',
    'SOUND1022',
  ]);
});

Deno.test('analyzeProject keeps bundled node typings explicit for js-node projects', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { join } from 'node:path';",
      '',
      'const cwd: string = process.cwd();',
      "const path: string = join(cwd, 'dist');",
      'void path;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2307', 'TS2580']);
});

Deno.test(
  'analyzeProject keeps bundled node globals and modules explicit even when compilerOptions.types requests node',
  async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          types: ['node'],
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { join } from 'node:path';",
      '',
      'const cwd: string = process.cwd();',
      "const path: string = join(cwd, 'dist');",
      "const bytes: Uint8Array<ArrayBuffer> = Buffer.from('sound');",
      'void path;',
      'void bytes;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });

    const diagnosticCodes = result.diagnostics.map((diagnostic) => diagnostic.code);
    assertEquals(diagnosticCodes, [
      'SOUND1005',
      'SOUND1005',
      'SOUND1005',
      'SOUND1039',
      'SOUND1039',
    ]);
  },
);

Deno.test(
  'analyzeProject resolves the explicit bundled node package across the supported core module slice',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import { Buffer as NodeBuffer } from 'node:buffer';",
        '// #[interop]',
        "import { spawn } from 'node:child_process';",
        '// #[interop]',
        "import { readdirSync, statSync, watch } from 'node:fs';",
        '// #[interop]',
        "import { readFile } from 'node:fs/promises';",
        '// #[interop]',
        "import { createRequire } from 'node:module';",
        '// #[interop]',
        "import { tmpdir } from 'node:os';",
        '// #[interop]',
        "import nodeProcess from 'node:process';",
        '// #[interop]',
        "import { Readable, Writable } from 'node:stream';",
        '// #[interop]',
        "import { fileURLToPath, pathToFileURL } from 'node:url';",
        '',
        'const cwd: string = nodeProcess.cwd();',
        'const entries = readdirSync(cwd, { withFileTypes: true });',
        'const fileEntry = entries.find((entry) => entry.isFile()) ?? null;',
        'void fileEntry;',
        'const stats = statSync(cwd);',
        'const isDirectory: boolean = stats.isDirectory();',
        'void isDirectory;',
        'const watcher = watch(cwd, (_eventType, fileName) => {',
        "  if (typeof fileName === 'string') {",
        '    const text: string = fileName;',
        '    void text;',
        '  }',
        '});',
        "watcher.on('error', (_error) => {});",
        "const child = spawn(nodeProcess.execPath, [], { stdio: ['ignore', 'pipe', 'pipe'] });",
        "child.stdout?.setEncoding('utf8');",
        "child.stdout?.on('data', (chunk: unknown) => {",
        "  if (typeof chunk === 'string') {",
        '    const text: string = chunk;',
        '    void text;',
        '  }',
        '});',
        "child.on('close', (_code) => {});",
        'const fileUrl = pathToFileURL(tmpdir());',
        'const filePath: string = fileURLToPath(fileUrl);',
        'const require = createRequire(pathToFileURL(filePath));',
        "const resolved: string = require.resolve('node:path');",
        'void resolved;',
        'const bytes: NodeBuffer = NodeBuffer.alloc(4);',
        'void bytes;',
        'const webReadable: ReadableStream<Uint8Array> = Readable.toWeb(nodeProcess.stdin);',
        'const webWritable: WritableStream<Uint8Array> = Writable.toWeb(nodeProcess.stdout);',
        'void webReadable;',
        'void webWritable;',
        'async function loadText(): Promise<void> {',
        "  const text: string = await readFile(filePath, 'utf8');",
        '  const binary: NodeBuffer = await readFile(fileUrl);',
        '  void text;',
        '  void binary;',
        '}',
        'void loadText;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves a common explicit node ecosystem slice',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import { Buffer } from 'node:buffer';",
        '// #[interop]',
        "import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual, webcrypto } from 'node:crypto';",
        '// #[interop]',
        "import { EventEmitter } from 'node:events';",
        '// #[interop]',
        "import { clearImmediate, clearTimeout, setImmediate, setTimeout } from 'node:timers';",
        '// #[interop]',
        "import { setImmediate as waitImmediate, setTimeout as waitTimeout } from 'node:timers/promises';",
        '// #[interop]',
        "import { inspect, promisify } from 'node:util';",
        '',
        'type Events = {',
        '  close: readonly [];',
        '  data: readonly [Buffer];',
        '};',
        '',
        'const emitter = new EventEmitter<Events>();',
        'const onData = (...args: readonly unknown[]): void => {',
        '  const [chunk] = args;',
        '  if (Buffer.isBuffer(chunk)) {',
        '    const bytes: Buffer = chunk;',
        '    void bytes;',
        '  }',
        '};',
        "emitter.on('data', onData);",
        "const fired: boolean = emitter.emit('close');",
        'void fired;',
        'const payload: Buffer = randomBytes(16);',
        'const id: string = randomUUID();',
        "const hashHex: string = createHash('sha256').update(payload).digest('hex');",
        "const macBytes: Buffer = createHmac('sha256', payload).update(id).digest();",
        'const equal: boolean = timingSafeEqual(payload, randomBytes(16));',
        'const inspected: string = inspect({ equal, hashHex, id }, { depth: 2 });',
        'void macBytes;',
        'void inspected;',
        'const makePromise: typeof promisify = promisify;',
        'void makePromise;',
        '',
        'async function run(): Promise<void> {',
        '  const timer = setTimeout(() => {}, 1);',
        '  clearTimeout(timer);',
        '  const immediate = setImmediate(() => {});',
        '  clearImmediate(immediate);',
        "  const waited: string = await waitTimeout(1, 'sound');",
        "  const immediateValue: string = await waitImmediate('ready');",
        '  const subtle: typeof webcrypto.subtle = webcrypto.subtle;',
        '  void waited;',
        '  void immediateValue;',
        '  void subtle;',
        '}',
        'void run;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves explicit node networking and assertion modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import assert from 'node:assert/strict';",
        '// #[interop]',
        "import { Readable, Writable } from 'node:stream';",
        '// #[interop]',
        "import { finished, pipeline } from 'node:stream/promises';",
        '// #[interop]',
        "import { createServer, get, request } from 'node:http';",
        '// #[interop]',
        "import { Agent, get as httpsGet, request as httpsRequest } from 'node:https';",
        '',
        "assert.equal('sound', 'sound');",
        'assert.ok(true);',
        '',
        'const readable = new Readable();',
        'const writable = new Writable();',
        'const pipePromise: Promise<void> = pipeline(readable, writable);',
        'const finishPromise: Promise<void> = finished(writable);',
        'void pipePromise;',
        'void finishPromise;',
        '',
        'const server = createServer((req, res) => {',
        '  const method: string | undefined = req.method;',
        "  const host: string | undefined = req.headers['host'];",
        '  void method;',
        '  void host;',
        '  res.statusCode = 200;',
        "  res.setHeader('content-type', 'text/plain');",
        "  res.end('ok');",
        '});',
        'server.listen(8080);',
        'server.close();',
        '',
        "const req = request('http://example.com', (res) => {",
        '  const statusCode: number | undefined = res.statusCode;',
        '  void statusCode;',
        "  res.on('data', (chunk: unknown) => {",
        '    void chunk;',
        '  });',
        '});',
        "req.setHeader('accept', 'text/plain');",
        'req.end();',
        '',
        "get('http://example.com', (_res) => {});",
        '',
        'const agent = new Agent({ keepAlive: true });',
        "const secureReq = httpsRequest('https://example.com', { agent }, (_res) => {});",
        'secureReq.end();',
        "httpsGet('https://example.com', { agent }, (_res) => {});",
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves explicit node stream fs and net modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import { Buffer } from 'node:buffer';",
        '// #[interop]',
        "import { createReadStream, createWriteStream } from 'node:fs';",
        '// #[interop]',
        "import { connect, createServer } from 'node:net';",
        '// #[interop]',
        "import { tmpdir } from 'node:os';",
        '// #[interop]',
        "import { join } from 'node:path';",
        '// #[interop]',
        "import { ReadableStream as WebReadableStream, TransformStream as WebTransformStream, WritableStream as WebWritableStream } from 'node:stream/web';",
        '// #[interop]',
        "import { createGunzip, createGzip, gzipSync } from 'node:zlib';",
        '',
        "const sourcePath = join(tmpdir(), 'input.txt');",
        "const targetPath = join(tmpdir(), 'output.txt');",
        'const reader = createReadStream(sourcePath);',
        "reader.setEncoding('utf8');",
        'const onFileData = (chunk: string | Buffer): void => {',
        '  if (typeof chunk === "string") {',
        '    const text: string = chunk;',
        '    void text;',
        '  }',
        '};',
        "reader.on('data', onFileData);",
        'const writer = createWriteStream(targetPath);',
        "writer.write('sound');",
        'writer.end();',
        '',
        'const netServer = createServer((socket) => {',
        "  socket.write('ok');",
        '  socket.end();',
        '});',
        'netServer.listen(8082);',
        'netServer.close();',
        "const client = connect(8082, 'localhost');",
        "client.setEncoding('utf8');",
        'const onSocketData = (chunk: string | Buffer): void => {',
        '  if (typeof chunk === "string") {',
        '    const text: string = chunk;',
        '    void text;',
        '  }',
        '};',
        "client.on('data', onSocketData);",
        "client.write('ping');",
        'client.end();',
        '',
        'const gzip = createGzip();',
        "gzip.write(Buffer.from('sound'));",
        'gzip.end();',
        'const gunzip = createGunzip();',
        "gunzip.write(gzipSync(Buffer.from('sound')));",
        'gunzip.end();',
        '',
        'const webReadable = new WebReadableStream<string>();',
        'const webWritable = new WebWritableStream<string>();',
        'const webTransform = new WebTransformStream<string, string>();',
        'void webReadable;',
        'void webWritable;',
        'void webTransform;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves explicit node cli and utility modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import { Console } from 'node:console';",
        '// #[interop]',
        "import { lookup } from 'node:dns/promises';",
        '// #[interop]',
        "import { performance } from 'node:perf_hooks';",
        '// #[interop]',
        "import process from 'node:process';",
        '// #[interop]',
        "import { createInterface } from 'node:readline/promises';",
        '// #[interop]',
        "import { isatty } from 'node:tty';",
        '',
        'const logger = new Console({ stdout: process.stdout, stderr: process.stderr });',
        "logger.log('sound');",
        '',
        'const started: number = performance.now();',
        'void started;',
        'const ttyState: boolean = isatty(1);',
        'void ttyState;',
        '',
        'const lookupPromise = lookup("localhost");',
        'const onLookup = (result: unknown): void => {',
        '  void result;',
        '};',
        'void lookupPromise.then(onLookup);',
        '',
        'const prompt = createInterface({ input: process.stdin, output: process.stdout });',
        'const questionPromise: Promise<string> = prompt.question("> ");',
        'void questionPromise;',
        'prompt.close();',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves explicit node worker and query utility modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        "import { URL } from 'sts:url';",
        '',
        '// #[interop]',
        "import { Buffer } from 'node:buffer';",
        '// #[interop]',
        "import { parse, stringify } from 'node:querystring';",
        '// #[interop]',
        "import { StringDecoder } from 'node:string_decoder';",
        '// #[interop]',
        "import { isArrayBufferView, isDate, isPromise } from 'node:util/types';",
        '// #[interop]',
        "import { Worker, isMainThread, parentPort, threadId } from 'node:worker_threads';",
        '',
        "const query = stringify({ first: 'sound', second: ['one', 'two'] });",
        'const parsed = parse(query);',
        'const first = parsed["first"];',
        'void first;',
        '',
        "const decoder = new StringDecoder('utf8');",
        "const decoded: string = decoder.write(Buffer.from('sound'));",
        'void decoded;',
        '',
        'const bufferViewState: boolean = isArrayBufferView(new Uint8Array());',
        'const dateState: boolean = isDate(new Date());',
        'const promiseState: boolean = isPromise(Promise.resolve(1));',
        'void bufferViewState;',
        'void dateState;',
        'void promiseState;',
        '',
        "const worker = new Worker('file:///tmp/worker.js');",
        "worker.postMessage({ kind: 'sound' });",
        'const workerId: number = worker.threadId;',
        'void workerId;',
        'const terminatePromise: Promise<number> = worker.terminate();',
        'void terminatePromise;',
        'const mainThreadState: boolean = isMainThread;',
        'void mainThreadState;',
        'void parentPort;',
        'const currentThreadId: number = threadId;',
        'void currentThreadId;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves explicit node async hooks and secure transport modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import { AsyncLocalStorage } from 'node:async_hooks';",
        '// #[interop]',
        "import { connect as connectHttp2, constants, createServer as createHttp2Server } from 'node:http2';",
        '// #[interop]',
        "import { connect as connectTls, createServer as createTlsServer } from 'node:tls';",
        '',
        'const storage = new AsyncLocalStorage<{ readonly requestId: string }>();',
        "storage.run({ requestId: 'req-1' }, () => {",
        '  const store = storage.getStore();',
        '  void store;',
        '});',
        "storage.enterWith({ requestId: 'req-2' });",
        'storage.disable();',
        '',
        "const tlsServer = createTlsServer({ ALPNProtocols: ['h2'] }, (socket) => {",
        "  socket.setEncoding('utf8');",
        "  socket.write('ok');",
        '  socket.end();',
        '});',
        'tlsServer.listen(8443);',
        'tlsServer.close();',
        "const tlsSocket = connectTls({ host: 'localhost', port: 8443 });",
        "tlsSocket.setEncoding('utf8');",
        "tlsSocket.write('ping');",
        'tlsSocket.end();',
        '',
        'const h2Server = createHttp2Server();',
        "h2Server.on('stream', (stream, headers) => {",
        "  const method = headers[':method'];",
        '  void method;',
        "  stream.respond({ ':status': 200, 'content-type': 'text/plain' });",
        "  stream.end('ok');",
        '});',
        'h2Server.listen(8444);',
        'h2Server.close();',
        "const h2Session = connectHttp2('https://example.com');",
        "const h2Request = h2Session.request({ ':path': '/' });",
        'h2Request.end();',
        'h2Session.close();',
        'const okStatus: number = constants.HTTP_STATUS_OK;',
        'void okStatus;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves explicit node test and assert modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import assert from 'node:assert';",
        '// #[interop]',
        "import { after, afterEach, before, beforeEach, describe, it, test } from 'node:test';",
        '',
        'let counter = 0;',
        'before(() => {',
        '  counter = 1;',
        '});',
        'beforeEach(() => {',
        '  counter += 1;',
        '});',
        'afterEach(() => {',
        '  counter -= 1;',
        '});',
        'after(() => {',
        '  counter = 0;',
        '});',
        '',
        "const rootTest: Promise<void> = test('root', (t) => {",
        '  const name: string = t.name;',
        '  void name;',
        '  assert.ok(counter >= 0);',
        "  assert.strict.equal('sound', 'sound');",
        '});',
        'void rootTest;',
        '',
        "const suite: Promise<void> = describe('suite', () => {",
        "  return it('case', (t) => {",
        '    const name: string = t.name;',
        '    void name;',
        '    assert.strictEqual(counter >= 0, true);',
        '  });',
        '});',
        'void suite;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves explicit node path stream-consumer and reporter modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import { join as joinPosix } from 'node:path/posix';",
        '// #[interop]',
        "import { join as joinWin32 } from 'node:path/win32';",
        '// #[interop]',
        "import { text } from 'node:stream/consumers';",
        '// #[interop]',
        "import { spec, tap } from 'node:test/reporters';",
        '// #[interop]',
        "import { Readable } from 'node:stream';",
        '',
        "const posixPath: string = joinPosix('/tmp', 'sound');",
        "const winPath: string = joinWin32('C:\\\\', 'sound');",
        'void posixPath;',
        'void winPath;',
        '',
        'const readable = new Readable();',
        'const textPromise: Promise<string> = text(readable);',
        'void textPromise;',
        '',
        'const specReporter = spec();',
        'const tapReporter = tap((async function* (): AsyncGenerator<import("node:test/reporters").TestEvent, void> {})());',
        'void specReporter;',
        'void tapReporter;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves explicit node runtime and tracing modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import { Buffer } from 'node:buffer';",
        '// #[interop]',
        "import * as constants from 'node:constants';",
        '// #[interop]',
        "import cluster from 'node:cluster';",
        '// #[interop]',
        "import { channel } from 'node:diagnostics_channel';",
        '// #[interop]',
        "import { createSocket } from 'node:dgram';",
        '// #[interop]',
        "import { createTracing } from 'node:trace_events';",
        '',
        'const e2big: number = constants.E2BIG;',
        'void e2big;',
        "cluster.setupPrimary({ exec: 'worker.js' });",
        'const primaryState: boolean = cluster.isPrimary;',
        'void primaryState;',
        '',
        "const diagnosticsChannel = channel('soundscript');",
        "diagnosticsChannel.publish({ kind: 'sound' });",
        '',
        "const socket = createSocket('udp4');",
        "socket.send(Buffer.from('sound'), 8080, '127.0.0.1');",
        'socket.close();',
        '',
        "const tracing = createTracing({ categories: ['node'] });",
        'tracing.enable();',
        'tracing.disable();',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject resolves explicit node introspection and specialized modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        '// #[interop]',
        "import { create } from 'node:domain';",
        '// #[interop]',
        "import * as inspector from 'node:inspector';",
        '// #[interop]',
        "import { Session as InspectorSession } from 'node:inspector/promises';",
        '// #[interop]',
        "import { toASCII, toUnicode } from 'node:punycode';",
        '// #[interop]',
        "import { getAssetKeys, isSea } from 'node:sea';",
        '// #[interop]',
        "import { DatabaseSync } from 'node:sqlite';",
        '// #[interop]',
        "import { getHeapStatistics } from 'node:v8';",
        '// #[interop]',
        "import { WASI } from 'node:wasi';",
        '',
        'const domain = create();',
        'domain.run(() => {});',
        '',
        'const session = new inspector.Session();',
        'session.connect();',
        'session.disconnect();',
        'const promiseSession = new InspectorSession();',
        'void promiseSession;',
        '',
        "const ascii: string = toASCII('mañana.com');",
        "const unicode: string = toUnicode('xn--maana-pta.com');",
        'void ascii;',
        'void unicode;',
        '',
        'const seaState: boolean = isSea();',
        'const assetKeys: string[] = getAssetKeys();',
        'void seaState;',
        'void assetKeys;',
        '',
        "const database = new DatabaseSync(':memory:');",
        "database.exec('CREATE TABLE sound (id INTEGER)');",
        'database.close();',
        '',
        'const heapStats = getHeapStatistics();',
        'void heapStats;',
        '',
        "const wasi = new WASI({ version: 'preview1' });",
        'void wasi;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test('analyzeProject rejects authored PromiseLike carriers in sound source', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'let promiseLike: PromiseLike<number> | null = null;',
      'let promiseCtor: PromiseConstructorLike | null = null;',
      'promiseLike = null;',
      'promiseCtor = null;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1034',
    'SOUND1022',
    'SOUND1022',
  ]);
});

Deno.test('analyzeProject reports actionable guidance for unsupported async surfaces', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'interface Thenable<T> {',
      '  then(onfulfilled: (value: T) => unknown): unknown;',
      '}',
      '',
      'let value: Thenable<number> | null = null;',
      'void value;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  const diagnostic = result.diagnostics.find((entry) =>
    entry.code === 'SOUND1034' &&
    entry.metadata?.evidence?.some((fact) =>
      fact.label === 'surfaceText' && fact.value === 'Thenable<number>'
    )
  );
  assertEquals(diagnostic?.code, 'SOUND1034');
  assertEquals(diagnostic?.metadata?.rule, 'unsupported_async_surface');
  assertEquals(diagnostic?.metadata?.primarySymbol, 'Thenable');
  assertEquals(diagnostic?.metadata?.replacementFamily, 'builtin_promise_surface');
  assertEquals(diagnostic?.metadata?.fixability, 'api_redesign');
  assertEquals(
    diagnostic?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['surfaceKind:thenable surface', 'surfaceText:Thenable<number>'],
  );
  assertEquals(
    diagnostic?.metadata?.counterexample,
    'Structural thenables can run arbitrary fulfillment behavior outside the compiler-owned Promise semantics soundscript models.',
  );
  assertEquals(
    diagnostic?.metadata?.example,
    'Replace `Thenable<number>` with `Promise<number>`, or normalize the foreign thenable at a boundary before it reaches checked soundscript code.',
  );
  assertEquals(diagnostic?.notes, [
    'This async surface uses `Thenable<number>`, which is a structural thenable rather than a builtin `Promise<T>` surface.',
    'Example: Replace `Thenable<number>` with `Promise<number>`, or normalize the foreign thenable at a boundary before it reaches checked soundscript code.',
  ]);
  assertEquals(
    diagnostic?.hint,
    'Use plain `Promise<T>` surfaces in soundscript, and normalize foreign thenables at the boundary.',
  );
});

Deno.test('analyzeProject widens decoder aliases through their declared generic surface', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import * as decode from 'sts:decode';",
      "import type { Decoder } from 'sts:decode';",
      '',
      'const decoder: Decoder<unknown, unknown> = decode.string;',
      'const arrayDecoder: Decoder<unknown, unknown> = decode.array(decode.string);',
      'const optionalDecoder: Decoder<unknown, unknown> = decode.optional(decode.string);',
      'void decoder;',
      'void arrayDecoder;',
      'void optionalDecoder;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUNDSCRIPT_MACRO_EXPANSION'),
    false,
  );
});

Deno.test('analyzeProject rejects direct ambient DOM globals even when DOM libs are enabled', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2024', 'DOM', 'DOM.AsyncIterable'],
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const title = document.title;',
      'const href = window.location.href;',
      'void title;',
      'void href;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1039', 'SOUND1039']);
});

Deno.test('analyzeProject resolves explicit host:dom imports when DOM libs are enabled', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2024', 'DOM', 'DOM.AsyncIterable'],
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[interop]',
      "import { document, window } from 'host:dom';",
      '',
      'const title = document.title;',
      'const href = window.location.href;',
      'void title;',
      'void href;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject rejects host:dom imports when DOM libs are unavailable', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      "import { document } from 'host:dom';",
      '',
      'void document;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2307']);
});

Deno.test(
  'analyzeProject rejects direct ambient node globals even when compilerOptions.types requests node',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            types: ['node'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'const cwd = process.cwd();',
        "const bytes = Buffer.from('sound');",
        'void cwd;',
        'void bytes;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      target: 'js-node',
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1039', 'SOUND1039']);
  },
);

Deno.test('analyzeProject resolves explicit host:node imports when compilerOptions.types requests node', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          types: ['node'],
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[interop]',
      "import { Buffer, process } from 'host:node';",
      '',
      'const cwd = process.cwd();',
      "const bytes = Buffer.from('sound');",
      'void cwd;',
      'void bytes;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject rejects host:node imports when compilerOptions.types omits node', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      "import { process } from 'host:node';",
      '',
      'void process;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2307']);
});

Deno.test('analyzeProject accepts same-file #[extern] declarations for node and user-supplied Deno globals', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          types: ['node'],
        },
        include: ['src/**/*.sts', 'src/**/*.d.ts'],
      },
      null,
      2,
    ),
    'src/deno-globals.d.ts': [
      'declare namespace Deno {',
      '  interface Runtime {',
      '    cwd(): string;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'src/index.sts': [
      '// #[extern]',
      'declare const runtimeProcess: NodeJS.Process;',
      '',
      '// #[extern]',
      'declare const runtimeDeno: Deno.Runtime;',
      '',
      'const cwd = runtimeProcess.cwd();',
      'const denoCwd = runtimeDeno.cwd();',
      'void cwd;',
      'void denoCwd;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject resolves portable sts platform modules on wasm-wasi', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'import { URL, URLSearchParams } from "sts:url";',
      'import { fetch, Headers, Request } from "sts:fetch";',
      'import { TextEncoder, TextDecoder } from "sts:text";',
      'import { crypto } from "sts:random";',
      '',
      'const url = new URL("/x", "https://example.com");',
      'const params = new URLSearchParams({ q: "music" });',
      'const request = new Request(url, { headers: new Headers() });',
      'const responsePromise = fetch(request);',
      'const encoder = new TextEncoder();',
      'const decoder = new TextDecoder();',
      'const bytes = encoder.encode(url.href);',
      'const text = decoder.decode(bytes);',
      'const cryptoRef = crypto;',
      '',
      'void params;',
      'void responsePromise;',
      'void cryptoRef;',
      'void text;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'wasm-wasi',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject resolves stdlib v2 json and compare modules through the analysis pipeline', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { isErr } from 'sts:prelude';",
      "import { parseJson } from 'sts:json';",
      "import { fromCompare, reverse, thenBy, type Ordering } from 'sts:compare';",
      '',
      'const parsed = parseJson(\'{"name":"ok","rank":1}\');',
      'if (isErr(parsed)) {',
      "  throw new Error('unexpected parse failure');",
      '}',
      '',
      'const byRank = fromCompare<{ rank: number; name: string }>((left, right) => left.rank - right.rank);',
      'const byName = fromCompare<{ rank: number; name: string }>((left, right) => left.name.localeCompare(right.name));',
      'const combined = thenBy(byRank, byName);',
      'const descending = reverse(combined);',
      "const ordering: Ordering = descending.compare({ rank: 1, name: 'b' }, { rank: 1, name: 'a' });",
      '',
      'const parsedValue: JsonValue = parsed.value;',
      'const parsedOrdering: Ordering = ordering;',
      'void parsedValue;',
      'void parsedOrdering;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject resolves stdlib v3 hash decode codec and async modules through the analysis pipeline', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { isErr } from 'sts:prelude';",
      "import * as async from 'sts:async';",
      "import * as codec from 'sts:codec';",
      "import * as decode from 'sts:decode';",
      "import * as hash from 'sts:hash';",
      "import type { Task } from 'sts:async';",
      "import type { Codec } from 'sts:codec';",
      "import type { Decoder } from 'sts:decode';",
      "import type { HashEq } from 'sts:hash';",
      '',
      'type LoadedContracts = [',
      '  Task<number>,',
      '  Codec<{ value: string }, string>,',
      '  Decoder<{ id: string; tags: readonly string[]; nickname: string | undefined }>,',
      '  HashEq<{ id: string }>,',
      '];',
      '',
      'const UserDecoder = decode.object({',
      '  id: decode.string,',
      '  tags: decode.array(decode.string),',
      '  nickname: decode.optional(decode.string),',
      '});',
      '',
      'const parsed = UserDecoder.decode({ id: "user-1", tags: ["a", "b"] });',
      'if (isErr(parsed)) {',
      "  throw new Error('unexpected decode failure');",
      '}',
      '',
      'const UserHash = hash.contramap(hash.stringHash, (user: { id: string }) => user.id);',
      'const hashCode: number = UserHash.hash({ id: parsed.value.id });',
      'const parsedTags: readonly string[] = parsed.value.tags;',
      'const parsedNickname: string | undefined = parsed.value.nickname;',
      '',
      'const UserIdCodec = codec.imap(',
      '  codec.stringCodec,',
      '  (value: string) => ({ value }),',
      '  (id: { value: string }) => id.value,',
      ');',
      'const encoded = UserIdCodec.encode({ value: parsed.value.id });',
      'if (isErr(encoded)) {',
      "  throw new Error('unexpected encode failure');",
      '}',
      'const encodedText: string = encoded.value;',
      '',
      'const baseTask = async.fromPromise(async () => "user");',
      'const derivedTask = async.map(baseTask, (value: string) => value.length + encodedText.length + hashCode);',
      'const loadedContracts: LoadedContracts | undefined = undefined;',
      'void loadedContracts;',
      'void parsedTags;',
      'void parsedNickname;',
      'void derivedTask;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject keeps JSON.parse reviver results at the unknown boundary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'const value: JsonValue = JSON.parse("{}", (_key, raw) => raw);\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject uses sound stdlib typing for JSON.stringify overloads', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'declare const maybeUnknown: unknown;',
      'const fromUndefined: undefined = JSON.stringify(undefined);',
      'const fromFunction: undefined = JSON.stringify(() => 1);',
      'const fromObject: string = JSON.stringify({ ok: true }, ["ok"]);',
      'const fromUnknown: string | undefined = JSON.stringify(maybeUnknown);',
      'const fromReplacer: string | undefined = JSON.stringify({ ok: true }, (_key, value) => value);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject rejects plain-string assumptions for Date.toJSON', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'const value: string = new Date(Number.NaN).toJSON();\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject requires undefined handling for RegExp exec capture groups', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const captures = /^(a)(b)?$/.exec("a");',
      '',
      'if (captures) {',
      '  const optional: string = captures[1];',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject keeps string replace callbacks precise and rejects regex function replacers', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const fromStringSearch = "abba".replace("b", (substring, offset, source) => {',
      '  const exactSubstring: string = substring;',
      '  const exactOffset: number = offset;',
      '  const exactSource: string = source;',
      '  return `${exactSubstring}${exactOffset}${exactSource.length}`;',
      '});',
      '',
      'const fromRegexStringReplacement = "abcd".replace(/^(a)(b)?(c)?(d)?$/, "x");',
      '',
      'const unsafeCapturingRegex = "ab".replace(/^(a)(b)?$/, (substring: string, offset: number, source: string) => {',
      '  return `${substring}${offset}${source.length}`;',
      '});',
      '',
      'const unsafeNoCaptureRegex = "ab".replace(/^ab$/, (substring: string, offset: number, source: string) => {',
      '  return `${substring}${offset}${source.length}`;',
      '});',
      '',
      'void fromStringSearch;',
      'void fromRegexStringReplacement;',
      'void unsafeCapturingRegex;',
      'void unsafeNoCaptureRegex;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'TS2769',
    'TS2769',
  ]);
});

Deno.test('analyzeProject keeps custom toJSON stringify results conservative', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'type CallableWithToJson = (() => number) & { toJSON(key?: string): string };',
      '// #[extern]',
      'declare const callableWithToJson: CallableWithToJson;',
      'const conservative: string | undefined = JSON.stringify(callableWithToJson);',
      'const narrowed: undefined = JSON.stringify(callableWithToJson);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject accepts union-typed JSON.stringify property-list replacers', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'declare const nullableKeys: readonly (string | number)[] | null;',
      '// #[extern]',
      'declare const optionalKeys: readonly (string | number)[] | undefined;',
      'const fromNullableKeys: string = JSON.stringify({ ok: true }, nullableKeys);',
      'const fromOptionalKeys: string = JSON.stringify({ ok: true }, optionalKeys);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject accepts installed stdlib json package subpath imports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { parseJson, stringifyJson } from '@soundscript/soundscript/json';",
      '',
      'const parsed = parseJson(\'{"ok": true}\');',
      'const text = stringifyJson({ ok: true });',
      'void parsed;',
      'void text;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject accepts installed runtime builtin macro subpath imports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { eq } from '@soundscript/soundscript/derive';",
      '',
      '// #[eq]',
      'type User = {',
      '  id: string;',
      '};',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject accepts installed runtime result Try macro imports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { type Result, Try, ok } from '@soundscript/soundscript/result';",
      '',
      'export function unwrap(value: Result<number, string>): Result<number, string> {',
      '  const next = Try(value);',
      '  return ok(next);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject treats readonly arrays and plain objects as definite JSON.stringify strings', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'declare const tuple: readonly ["x"];',
      '// #[extern]',
      'declare const withOptional: { ok?: true };',
      '// #[extern]',
      'declare const withUndefined: { ok: true | undefined };',
      'const fromTuple: string = JSON.stringify(tuple);',
      'const fromOptional: string = JSON.stringify(withOptional);',
      'const fromUndefinedValue: string = JSON.stringify(withUndefined);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject does not expose removed bundled helper aliases', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'declare const id: Opaque<string, "UserId">;',
      'const xs: NonEmptyArray<string> = ["a"];',
      'const states = { open: "open", closed: "closed" } as const;',
      'const state: ValueOf<typeof states> = "open";',
      'type User = Simplify<{ id: string } & { name: string }>;',
      '',
      'void id;',
      'void xs;',
      'void state;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'TS2304',
    'TS2304',
    'TS2304',
  ]);
});

Deno.test('analyzeProject uses sound stdlib typing for Array.isArray narrowing', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'declare const value: unknown;',
      '',
      'if (Array.isArray(value)) {',
      '  const items: string[] = value;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject keeps length-only Array constructors sparse at indexed reads', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const xs = Array<string>(2);',
      'const first: string = xs[0];',
      '',
      'const ys = new Array<number>(3);',
      'const second: number = ys[0];',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['TS2322', 'TS2322'],
  );
});

Deno.test('analyzeProject rejects non-generic length-only Array constructors at indexed reads', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const xs = Array(2);',
      'const first: string = xs[0];',
      '',
      'const ys = new Array(2);',
      'const second: number = ys[0];',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['TS2322', 'TS2322'],
  );
});

Deno.test('analyzeProject uses sound stdlib typing for eval', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'const value: string = eval("1");\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject normalizes catch bindings and built-in Promise rejection handlers to Error', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'try {',
      '  throw new Error("boom");',
      '} catch (error) {',
      '  const trusted: Error = error;',
      '  void trusted.message;',
      '});',
      '',
      'Promise.reject({ message: "boom" }).catch((error) => {',
      '  const trusted: Error = error;',
      '  return trusted.message;',
      '});',
      '',
      'const handlePromiseError = (error: Error): string => error.message;',
      'Promise.resolve(1).then(undefined, handlePromiseError);',
      '',
      'Promise.resolve(1).then(undefined, (() => {',
      '  const evaluations: string[] = [];',
      '  evaluations.push("registered");',
      '  return (error: Error) => {',
      '    evaluations.push(error.name);',
      '    return evaluations.join(",");',
      '  };',
      '})());',
      '',
      'const customThenable = {',
      '  catch(onRejected: (reason: unknown) => string) {',
      '    return onRejected({ message: "boom" });',
      '  },',
      '};',
      'customThenable.catch((reason) => {',
      '  const trusted: Error = reason;',
      '  return trusted.message;',
      '});',
      '',
      '// #[extern]',
      'declare const promiseLike: Promise<number>;',
      'promiseLike.then(undefined, (reason) => {',
      '  const trusted: Error = reason;',
      '  return trusted.message;',
      '});',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['TS2322'],
  );
});

Deno.test('analyzeProject remaps diagnostics in normalized catch and Promise rejection handlers back to original lines', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'try {',
      '  throw new Error("boom");',
      '} catch (error) {',
      '  const trusted: Error = error;',
      '  const wrong: number = error.message;',
      '}',
      '',
      'Promise.reject({ message: "boom" }).catch((error) => {',
      '  const wrong: number = error.message;',
      '  return wrong;',
      '});',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['TS2322', 'TS2322'],
  );
  assertEquals(result.diagnostics[0]?.line, 5);
  assertEquals(result.diagnostics[1]?.line, 9);
});

Deno.test('analyzeProject keeps Promise constructor reject extraction at an unknown boundary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'new Promise((_resolve, reject) => {',
      '  type Rejection = Parameters<typeof reject>[0];',
      '  const reason: Rejection = { message: "boom" };',
      '  const trusted: { message: string } = reason;',
      '  void trusted.message;',
      '});',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject keeps Promise.reject parameter extraction at an unknown boundary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'type Rejection = Parameters<typeof Promise.reject>[0];',
      'const reason: Rejection = { message: "boom" };',
      'const trusted: { message: string } = reason;',
      'void trusted.message;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject keeps Promise.prototype.then fulfillment extraction at an unknown boundary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'type OnFulfilled = Parameters<typeof Promise.prototype.then>[0];',
      'type Value = Parameters<NonNullable<OnFulfilled>>[0];',
      '// #[extern]',
      'declare const value: Value;',
      'const trusted: { message: string } = value;',
      'void trusted.message;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject keeps Object(value) wrappers at a non-any boundary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'const fromValue: string = Object("value");\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject keeps Object() wrappers at a non-any boundary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'const fromNothing: string = Object();\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject keeps Object.getPrototypeOf results at a non-any boundary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'const reflected: string = Object.getPrototypeOf({ knownKey: "value" });\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject reports Object.setPrototypeOf null-prototype creation', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const updated = Object.setPrototypeOf({ count: 1 }, null);',
      'const count: number = updated.count;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1021']);
  assertEquals(
    result.diagnostics[0]?.message,
    'Null-prototype object creation is not supported in soundscript.',
  );
  assertEquals(
    result.diagnostics[0]?.hint,
    'Use `Object.create(null)` with `BareObject`, or use an ordinary object or `Map` instead of prototype surgery.',
  );
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'null_prototype_object_creation');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'bare_object_or_map');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['api:Object.setPrototypeOf'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Prototype surgery can create null-prototype objects after allocation, which breaks the ordinary object assumptions soundscript relies on.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Use `Object.create(null)` and keep the value as `BareObject`, or use an ordinary object or `Map` if you want normal object behavior.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'This call creates a null-prototype object through prototype mutation instead of through the explicit `BareObject` path.',
    'Example: Use `Object.create(null)` and keep the value as `BareObject`, or use an ordinary object or `Map` if you want normal object behavior.',
  ]);
});

Deno.test('analyzeProject reports Reflect.setPrototypeOf null-prototype creation', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const updated: boolean = Reflect.setPrototypeOf({ count: 1 }, null);',
      'void updated;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1021']);
  assertEquals(
    result.diagnostics[0]?.message,
    'Null-prototype object creation is not supported in soundscript.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.rule,
    'null_prototype_object_creation',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['api:Reflect.setPrototypeOf'],
  );
});

Deno.test('analyzeProject reports actionable guidance for invalid extern annotation targets', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'const local = 1;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1027']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'invalid_annotation_target');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '#[extern]');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'supported_annotation_site');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    [
      'annotationName:extern',
      'expectedTarget:local ambient runtime declaration',
      'actualTarget:variable declaration',
    ],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'An annotation attached to the wrong syntax node can look like it blesses code even though that site does not support the annotation’s semantics.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Move `#[extern]` to a local ambient runtime declaration, or remove it if this code is an ordinary implementation.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`#[extern]` must attach to a local ambient runtime declaration, but this annotation is attached to a variable declaration.',
    'Example: Move `#[extern]` to a local ambient runtime declaration, or remove it if this code is an ordinary implementation.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Move the annotation to a supported target, or remove it if this site should stay ordinary checked code.',
  );
});

Deno.test('analyzeProject reports actionable guidance for ambient declarations missing extern', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'declare const envName: string;',
      'void envName;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1029']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'ambient_runtime_requires_extern');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'envName');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'site_local_extern_boundary');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['declarationKind:const declaration', 'declarationName:envName'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Without `#[extern]`, a declaration-only runtime name looks like ordinary checked soundscript even though there is no local implementation.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Add `// #[extern]` immediately above the declaration, or replace the declaration with a real implementation.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'This local ambient runtime declaration introduces `envName` without a site-local extern boundary.',
    'Example: Add `// #[extern]` immediately above the declaration, or replace the declaration with a real implementation.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Use '// #[extern]' only for local runtime-provided declarations, or replace the declaration with a real implementation.",
  );
});

Deno.test('analyzeProject reports actionable guidance for exported ambient runtime declarations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'export declare const envName: string;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1030']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'ambient_runtime_export_forbidden');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'envName');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'ambient_surface_split_or_real_implementation',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'api_redesign');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['declarationKind:const declaration', 'declarationName:envName', 'exportForm:direct export'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'An exported declaration-only runtime name creates a module API without a local implementation, so downstream code would treat a nonexistent checked value as real.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    "Move the declaration to '.d.ts', keep it local with `// #[extern]`, or replace it with a real implementation.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'This ambient runtime declaration exports `envName` from a soundscript module even though there is no local implementation.',
    "Example: Move the declaration to '.d.ts', keep it local with `// #[extern]`, or replace it with a real implementation.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Keep declaration-only runtime names local with '// #[extern]', move exported declaration-only surfaces to '.d.ts', or provide a real implementation.",
  );
});

Deno.test('analyzeProject reports actionable guidance for unsupported annotation arguments', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern(answer: 1)]',
      'declare const envName: string;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1028']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'annotation_arguments_not_supported');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '#[extern]');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'supported_annotation_arguments',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['annotationName:extern', 'argumentsText:(answer: 1)', 'supportedForm:bare form only'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Unsupported annotation arguments can look like checked configuration even though v1 does not define any semantics for them.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Remove the arguments from `#[extern(answer: 1)]`.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`#[extern]` does not accept arguments in v1; this annotation uses `(answer: 1)`.',
    'Example: Remove the arguments from `#[extern(answer: 1)]`.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Remove the unsupported annotation arguments, or rewrite the annotation to one of its supported forms.',
  );
});

Deno.test('analyzeProject reports actionable guidance for banned TypeScript pragmas', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// @ts-ignore',
      'const value: number = "bad";',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1023']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'typescript_pragma_banned');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '@ts-ignore');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'checked_code_without_suppression',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['pragmaText:@ts-ignore'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'TypeScript pragmas suppress upstream evidence and make soundscript checking depend on hidden unchecked assumptions.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Remove `@ts-ignore` and express the invariant with checked code, a validated boundary, or a real type fix.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`@ts-ignore` suppresses upstream diagnostics instead of expressing a checked soundscript boundary.',
    'Example: Remove `@ts-ignore` and express the invariant with checked code, a validated boundary, or a real type fix.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Delete the TypeScript pragma and make the code type-check without suppression.',
  );
});

Deno.test('analyzeProject gives feature-specific guidance for var declarations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'var count = 1;',
      'void count;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
  assertEquals(
    result.diagnostics[0]?.message,
    '`var` declarations are not supported in soundscript.',
  );
  assertEquals(
    result.diagnostics[0]?.hint,
    'Use `const` for immutable bindings or `let` when reassignment is intentional.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'Example: Write `const total = 0` or `let total = 0` instead of `var total = 0`.',
  ]);
  assertEquals(result.diagnostics[0]?.metadata?.featureId, 'unsupported.varDeclaration');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'explicit_binding_kind');
});

Deno.test('analyzeProject gives feature-specific guidance for loose equality', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const left: unknown = 1;',
      'const right: unknown = "1";',
      'const equal = left == right;',
      'void equal;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
  assertEquals(
    result.diagnostics[0]?.message,
    'Loose equality (`==` / `!=`) is not supported in soundscript.',
  );
  assertEquals(
    result.diagnostics[0]?.hint,
    'Convert values explicitly, then use `===` or `!==`.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'Example: Write `value === null` or `Number(text) === count` instead of relying on `==` coercion.',
  ]);
  assertEquals(result.diagnostics[0]?.metadata?.featureId, 'unsupported.looseEquality');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'strict_equality');
});

Deno.test('analyzeProject uses sound stdlib typing for BareObject and Object.assign', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const created: BareObject = Object.create(null);',
      'const count: number = Object.assign({}, { count: 1 }).count;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject keeps Reflect.get reads at an unknown boundary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const target = { knownKey: "value" };',
      'const reflected: string = Reflect.get(target, "knownKey");',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['TS2322'],
  );
});

Deno.test('analyzeProject keeps reflective descriptor values at an unknown boundary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const target = { knownKey: "value" };',
      'const descriptor = Reflect.getOwnPropertyDescriptor(target, "knownKey");',
      'if (descriptor?.value !== undefined) {',
      '  const reflected: string = descriptor.value;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject keeps descriptor getter and setter surfaces at unknown boundaries', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const target = {',
      '  storage: "value",',
      '  get knownKey() {',
      '    return this.storage;',
      '  },',
      '  set knownKey(next: string) {',
      '    this.storage = next;',
      '  },',
      '};',
      '',
      'const descriptor = Object.getOwnPropertyDescriptor(target, "knownKey");',
      'if (descriptor?.get) {',
      '  const getter = descriptor.get;',
      '  const reflected: string = getter.call(target);',
      '}',
      'if (descriptor?.set) {',
      '  const setter = descriptor.set;',
      '  const reflectWrite = (value: Parameters<typeof setter>[0]): string => value;',
      '  void reflectWrite;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    [
      'TS2322',
      'TS2322',
    ],
  );
});

Deno.test('analyzeProject keeps widened Function invocation fallback surfaces at unknown boundaries', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'function returnsNumber() {',
      '  return 42;',
      '}',
      'class Box {',
      '  value = 42;',
      '}',
      'const dynamicFn: Function = returnsNumber;',
      'const reflectedApply: string = Reflect.apply(dynamicFn, undefined, []);',
      'const reflectedCall: string = dynamicFn.call(undefined);',
      'const reflectedApplyMethod: string = dynamicFn.apply(undefined, []);',
      'const bound = dynamicFn.bind(undefined);',
      'const reflectedBind: string = bound();',
      'const dynamicCtor: Function = Box;',
      'const constructed: { value: string } = Reflect.construct(dynamicCtor, []);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['TS2322', 'TS2322', 'TS2322', 'TS2322', 'TS2322'],
  );
});

Deno.test('analyzeProject preserves null-prototype helper returns and rejects object widening', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'function makeDict() {',
      '  return Object.create(null);',
      '}',
      '',
      'function id<T>(value: T): T {',
      '  return value;',
      '}',
      '',
      'const dict = makeDict();',
      'const alias: BareObject = id(dict);',
      'const plain: object = alias;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'null_prototype_object_widening');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'bare_object_or_exact_nonordinary_type',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    "Code typed as 'object' can rely on Object.prototype members, but a null-prototype value intentionally omits them.",
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['sourceType:BareObject', 'targetType:object'],
  );
  assertEquals(result.diagnostics[0]?.line, 11);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject keeps imported helper Object.groupBy returns non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2024',
          module: 'ESNext',
          lib: ['ES2024'],
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'export function groupByParity() {',
      '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
      '}',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import { groupByParity } from "./helpers";',
      'const plain: object = groupByParity();',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject keeps direct exported Object.groupBy values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2024',
          module: 'ESNext',
          lib: ['ES2024'],
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'export const grouped = Object.groupBy(',
      '  [1, 2],',
      '  (value) => value % 2 === 0 ? "even" : "odd",',
      ');',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import { grouped } from "./helpers";',
      'const plain: object = grouped;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject preserves Object.groupBy values through simple value re-exports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2024',
          module: 'ESNext',
          lib: ['ES2024'],
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'export const grouped = Object.groupBy(',
      '  [1, 2],',
      '  (value) => value % 2 === 0 ? "even" : "odd",',
      ');',
      '',
    ].join('\n'),
    'src/mid.sts': 'export { grouped } from "./helpers";\n',
    'src/index.sts': [
      'import { grouped } from "./mid";',
      'const plain: object = grouped;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject keeps default-exported Object.groupBy values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2024',
          module: 'ESNext',
          lib: ['ES2024'],
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'export default Object.groupBy(',
      '  [1, 2],',
      '  (value) => value % 2 === 0 ? "even" : "odd",',
      ');',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import grouped from "./helpers";',
      'const plain: object = grouped;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject keeps imported helper-returned module namespaces non-ordinary', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'import * as math from "./math";',
      '',
      'export function getMathNamespace() {',
      '  return math;',
      '}',
      '',
    ].join('\n'),
    'src/math.sts':
      'export function add(left: number, right: number): number { return left + right; }\n',
    'src/index.sts': [
      'import { getMathNamespace } from "./helpers";',
      'const plain: object = getMathNamespace();',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message ===
        'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.'
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.notes?.includes(
        'Only direct exported-member reads from a namespace import are allowed.',
      ) ??
        false
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.hint ===
        'Read the exported member you need immediately instead of storing or forwarding the namespace object.'
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.metadata?.rule === 'module_namespace_escape' &&
      diagnostic.metadata?.replacementFamily === 'direct_exported_member_read' &&
      diagnostic.metadata?.fixability === 'local_rewrite'
    ),
    true,
  );
});

Deno.test('analyzeProject keeps direct exported module namespace values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'import * as math from "./math";',
      '',
      'export const mathNamespace = math;',
      '',
    ].join('\n'),
    'src/math.sts':
      'export function add(left: number, right: number): number { return left + right; }\n',
    'src/index.sts': [
      'import { mathNamespace } from "./helpers";',
      'const plain: object = mathNamespace;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message ===
        'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.'
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.notes?.includes(
        'Only direct exported-member reads from a namespace import are allowed.',
      ) ??
        false
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.hint ===
        'Read the exported member you need immediately instead of storing or forwarding the namespace object.'
    ),
    true,
  );
});

Deno.test('analyzeProject preserves module namespace values through simple value re-exports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'import * as math from "./math";',
      '',
      'export const mathNamespace = math;',
      '',
    ].join('\n'),
    'src/mid.sts': 'export { mathNamespace } from "./helpers";\n',
    'src/math.sts':
      'export function add(left: number, right: number): number { return left + right; }\n',
    'src/index.sts': [
      'import { mathNamespace } from "./mid";',
      'const plain: object = mathNamespace;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message ===
        'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.'
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.notes?.includes(
        'Only direct exported-member reads from a namespace import are allowed.',
      ) ??
        false
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.hint ===
        'Read the exported member you need immediately instead of storing or forwarding the namespace object.'
    ),
    true,
  );
});

Deno.test('analyzeProject keeps default-exported module namespace values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'import * as math from "./math";',
      '',
      'export default math;',
      '',
    ].join('\n'),
    'src/math.sts':
      'export function add(left: number, right: number): number { return left + right; }\n',
    'src/index.sts': [
      'import mathNamespace from "./helpers";',
      'const plain: object = mathNamespace;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message ===
        'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.'
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.notes?.includes(
        'Only direct exported-member reads from a namespace import are allowed.',
      ) ??
        false
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.hint ===
        'Read the exported member you need immediately instead of storing or forwarding the namespace object.'
    ),
    true,
  );
});

Deno.test('analyzeProject preserves module namespace quarantine for source-published package subpaths', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          skipLibCheck: true,
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'import { math } from "sound-pkg/sub";',
      'const plain: object = math;',
      'void plain;',
      '',
    ].join('\n'),
    'node_modules/sound-pkg/package.json': JSON.stringify(
      {
        name: 'sound-pkg',
        version: '1.0.0',
        type: 'module',
        exports: {
          './sub': {
            types: './dist/sub.d.ts',
            import: './dist/sub.js',
          },
        },
        soundscript: {
          version: 1,
          exports: {
            './sub': { source: './src/sub.sts' },
          },
        },
      },
      null,
      2,
    ),
    'node_modules/sound-pkg/dist/sub.d.ts': 'export declare const math: typeof import("./math");\n',
    'node_modules/sound-pkg/dist/math.d.ts':
      'export declare function add(left: number, right: number): number;\n',
    'node_modules/sound-pkg/src/sub.sts': [
      'import * as mathNs from "./math";',
      '',
      'export const math = mathNs;',
      '',
    ].join('\n'),
    'node_modules/sound-pkg/src/math.sts':
      'export function add(left: number, right: number): number { return left + right; }\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1024'), true);
  assertEquals(result.diagnostics.length >= 1, true);
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.message ===
        'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.'
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.notes?.includes(
        'Only direct exported-member reads from a namespace import are allowed.',
      ) ??
        false
    ),
    true,
  );
  assertEquals(
    result.diagnostics.some((diagnostic) =>
      diagnostic.hint ===
        'Read the exported member you need immediately instead of storing or forwarding the namespace object.'
    ),
    true,
  );
});

Deno.test('analyzeProject explains mutable array variance with notes and hint', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'interface Animal {',
      '  name: string;',
      '}',
      '',
      'interface Dog extends Animal {',
      '  breed: string;',
      '}',
      '',
      'const dogs: Dog[] = [{ name: "Rex", breed: "Lab" }];',
      'const animals: Animal[] = dogs;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
  assertEquals(result.diagnostics[0]?.message, 'Mutable arrays are invariant in soundscript.');
  assertEquals(result.diagnostics[0]?.notes, [
    "'Dog[]' cannot be widened to 'Animal[]' because writes through the target could push values the source array does not allow.",
    'Mutable edge: array writes such as `push`, indexed assignment, or `splice` would become unsound through the widened target surface.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Make the array readonly, copy into a fresh array before widening, or keep the exact element type.',
  );
  assertEquals(result.diagnostics[0]?.line, 10);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject rejects nested mutable array variance inside fresh object literals', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'interface Animal { name: string; }',
      'interface Dog extends Animal { breed: string; }',
      'interface Kennel { animals: Animal[]; }',
      'const dogs: Dog[] = [];',
      'const kennel: Kennel = { animals: dogs };',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Writable property 'animals' is invariant in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.line, 5);
});

Deno.test(
  'analyzeProject accepts union-branch object literals with nullish record fallbacks',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'type Step =',
        '  | { key: string; output: Record<string, string>; type: "noop" }',
        '  | { config: Record<string, string>; key: string; type: "node" };',
        '',
        '// #[extern]',
        'declare function readRecord(): Record<string, string> | undefined;',
        '',
        'function buildStep(kind: "node" | "noop", key: string): Step {',
        '  if (kind === "noop") {',
        '    return {',
        '      key,',
        '      output: readRecord() ?? {},',
        '      type: "noop",',
        '    };',
        '  }',
        '',
        '  return {',
        '    config: readRecord() ?? {},',
        '    key,',
        '    type: "node",',
        '  };',
        '}',
        '',
        'void buildStep;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject accepts object-literal JsonValue properties with nullish record fallbacks',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'type LocalJsonValue =',
        '  | null',
        '  | string',
        '  | { [key: string]: LocalJsonValue };',
        '',
        '// #[extern]',
        'declare function readMetadata(): Record<string, LocalJsonValue> | undefined;',
        '',
        'function buildStep(): Record<string, LocalJsonValue> {',
        '  return {',
        '    metadata: readMetadata() ?? {},',
        '    type: "noop",',
        '  };',
        '}',
        '',
        'void buildStep;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics, []);
  },
);

Deno.test(
  'analyzeProject rejects narrower object-literal methods assigned to broader interface methods',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'interface Animal { name: string; }',
        'interface Dog extends Animal { breed: string; }',
        'interface HandlerBox {',
        '  handle(value: Animal): void;',
        '}',
        'const handlers: HandlerBox = {',
        '  handle(value: Dog) {',
        '    value.breed;',
        '  },',
        '};',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
    assertEquals(
      result.diagnostics[0]?.message,
      'Callable parameter types are contravariant in soundscript.',
    );
    assertEquals(result.diagnostics[0]?.line, 7);
  },
);

Deno.test('analyzeProject accepts named variance contracts on generic declarations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[variance(T: out)]',
      'export interface Box<T> {',
      '  readonly value: T;',
      '}',
      '',
      'const box: Box<string> = { value: "ok" };',
      'const widened: Box<string | number> = box;',
      'void widened;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject explains generic contravariance mismatches with concrete variance guidance', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'export interface Sink<T> {',
      '  push(value: T): void;',
      '}',
      '',
      'const strings: Sink<string> = {',
      '  push(value) {',
      '    void value;',
      '  },',
      '};',
      '',
      'const widened: Sink<string | number> = strings;',
      'void widened;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Generic parameter 'T' of 'Sink' is contravariant in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "'Sink<string>' cannot be assigned to 'Sink<string | number>' because contravariant parameter 'T' flows into 'Sink'.",
    "For a contravariant parameter, the target argument must be assignable to the source argument: 'string | number' -> 'string' fails here.",
    "Counterexample: Code typed as 'Sink<string | number>' could pass 'string | number' into the surface, but 'Sink<string>' only accepts 'string'.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Keep the exact instantiation, widen the source parameter type, or introduce an adapter with the direction you need. If this surface is intentionally input-only, document it with `// #[variance(T: in)]`.',
  );
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'generic_variance_mismatch');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'Sink');
  assertEquals(result.diagnostics[0]?.metadata?.secondarySymbol, 'T');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    [
      'typeParameter:T',
      'variance:contravariant',
      'sourceType:Sink<string>',
      'targetType:Sink<string | number>',
      'sourceArgument:string',
      'targetArgument:string | number',
      'requiredRelation:string | number -> string',
    ],
  );
  assertEquals(result.diagnostics[0]?.line, 11);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject explains variance annotation mismatches with the proven contract', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[variance(T: out)]',
      'export interface Sink<T> {',
      '  push(value: T): void;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1032']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Variance annotation does not match the declaration's proven variance.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'Parameter `T` is annotated as `out`, but soundscript proves it is `in` from the declaration surface.',
    'Update the checked contract to `// #[variance(T: in)]`, or rewrite the declaration so `T` is only consumed.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Make the checked contract match the proven variance, or change the declaration surface until the desired variance is actually provable.',
  );
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'variance_annotation_mismatch');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'Sink');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['parameter T:annotated out, proven in'],
  );
  assertEquals(result.diagnostics[0]?.metadata?.example, '// #[variance(T: in)]');
  assertEquals(result.diagnostics[0]?.metadata?.secondarySymbol, '// #[variance(T: in)]');
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 18);
});

Deno.test('analyzeProject gives structured guidance for malformed annotation comments', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[unsafe(',
      'const value = 1;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1006']);
  assertStringIncludes(
    result.diagnostics[0]?.message ?? '',
    'Malformed soundscript annotation comment.',
  );
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'malformed_annotation_comment');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '// #[unsafe(');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'well_formed_annotation_comment',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    [
      'annotationText:// #[unsafe(',
      'parseError:Annotation comments must close with `]`.',
    ],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'A malformed annotation comment looks like a checked directive, but it attaches to nothing and leaves the following code ordinary checked code.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Rewrite the comment as a complete annotation such as `// #[unsafe]`, or remove it if no directive is intended.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`// #[unsafe(` did not parse as a complete soundscript annotation comment, so it does not attach to the following code.',
    'Parser detail: Annotation comments must close with `]`.',
    'Example: Rewrite the comment as a complete annotation such as `// #[unsafe]`, or remove it if no directive is intended.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Rewrite the malformed comment as a complete `// #[...]` annotation, or remove it.',
  );
});

Deno.test('analyzeProject reports targeted diagnostics for dotted macro-owned member annotations without an owner', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'type User = {',
      '  // #[eq.skip]',
      '  id: string;',
      '};',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1027']);
  assertEquals(
    result.diagnostics[0]?.message,
    'soundscript annotation is not valid on this target. `#[eq.skip]` must attach to a declaration annotated with `#[eq]` or to a supported member inside one.',
  );
});

Deno.test('analyzeProject preserves unknown annotation namespaces and their nested member annotations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[eq]',
      'type User = {',
      '  // #[eq.skip]',
      '  id: string;',
      '};',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1007']);
  assertEquals(
    result.diagnostics[0]?.message,
    'Unknown soundscript annotation. `#[eq]` is not registered.',
  );
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'unknown_annotation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '#[eq]');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'registered_annotation_name');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['annotationName:eq', 'registeredBuiltins:effects, extern, interop, newtype, unsafe, value, variance'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'An unknown annotation can look like a checked contract even though soundscript gives it no semantics.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Replace `#[eq]` with a registered builtin annotation such as `#[extern]`, or remove it until that directive exists.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`#[eq]` is not a registered builtin soundscript annotation.',
    'Registered builtin annotations in v1 are `#[effects(...)]`, `#[extern]`, `#[interop]`, `#[newtype]`, `#[unsafe]`, `#[value]`, and `#[variance(...)]`.',
    'Example: Replace `#[eq]` with a registered builtin annotation such as `#[extern]`, or remove it until that directive exists.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Rename the annotation to a registered builtin, or remove it until that directive exists.',
  );
});

Deno.test('analyzeProject gives structured guidance for duplicate annotations in one block', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      '// #[extern]',
      'declare const envName: string;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1026']);
  assertEquals(
    result.diagnostics[0]?.message,
    'Duplicate soundscript annotation in the same annotation block. `#[extern]` appears more than once in the same block.',
  );
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'duplicate_annotation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '#[extern]');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'single_annotation_per_block');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['annotationName:extern', 'occurrenceCount:2'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Duplicate entries make it ambiguous which single checked contract should govern the attached declaration.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Keep one `#[extern]` entry in the block and remove the duplicate.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`#[extern]` appears 2 times in the same attached annotation block.',
    'Example: Keep one `#[extern]` entry in the block and remove the duplicate.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Keep a single annotation entry for each name in the attached block.',
  );
});

Deno.test('analyzeProject accepts builtin effects annotations on local functions and callback parameters', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'function each(',
      '  values: number[],',
      '  // #[effects(forbid: [fails])]',
      '  callback: (value: number) => void,',
      '): void {',
      '  for (const value of values) {',
      '    callback(value);',
      '  }',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host], via: [callback])]',
      'function runOnce(callback: () => void): void {',
      '  callback();',
      '}',
      '',
      'runOnce(() => each([1, 2, 3], () => {}));',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject rejects invalid public effects annotation names', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[effects(forbid: [fails.throws, throws])]',
      'function main(): number {',
      '  return 1;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1039']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'invalid_effect_annotation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '#[effects(...)]');
});

Deno.test('analyzeProject enforces local forbid fails contracts against inferred throw behavior', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[effects(forbid: [fails])]',
      'function explode(): number {',
      '  throw new Error("boom");',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1040']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'effect_contract_violation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'explode');
});

Deno.test('analyzeProject enforces callback forbid contracts against failful arguments', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'declare function runChecked(',
      '  // #[effects(forbid: [fails])]',
      '  callback: () => void,',
      '): void;',
      '',
      'function bad(): void {',
      '  throw new Error("boom");',
      '}',
      '',
      'function main(): void {',
      '  runChecked(bad);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1040']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'effect_contract_violation');
  assertEquals(result.diagnostics[0]?.line, 12);
  assertEquals(result.diagnostics[0]?.column, 3);
});

Deno.test('analyzeProject checks callable assignability against callback forbid contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'interface NeedsPureCallback {',
      '  (',
      '    // #[effects(forbid: [fails])]',
      '    callback: () => void,',
      '  ): void;',
      '}',
      '',
      '// #[extern]',
      'declare const needsPure: NeedsPureCallback;',
      '',
      'const general: (callback: () => void) => void = needsPure;',
      'void general;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'callable_effect_parameter_contravariance');
});

Deno.test('analyzeProject explains invalid variance contracts with concrete contract guidance', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[variance(T: out)]',
      'type Pair<T, U> = [T, U];',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1031']);
  assertEquals(
    result.diagnostics[0]?.message,
    'Variance annotation contract is invalid. Variance annotation must mention every type parameter exactly once. Missing: `U`.',
  );
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'invalid_variance_annotation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'Pair');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'checked_variance_annotation',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    [
      'declarationName:Pair',
      'typeParameters:T, U',
      'contractText:T: out',
      'parseError:Variance annotation must mention every type parameter exactly once. Missing: `U`.',
    ],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'A malformed checked variance contract can overclaim how generic arguments may vary even though the declaration surface has not proved that story.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Start with a total contract such as `// #[variance(T: inout, U: inout)]`, then tighten each direction only when the declaration surface proves it.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.secondarySymbol,
    '// #[variance(T: inout, U: inout)]',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`#[variance(...)]` on `Pair` must mention every type parameter exactly once in a checked total contract.',
    'Contract issue: Variance annotation must mention every type parameter exactly once. Missing: `U`.',
    'Example: Start with a total contract such as `// #[variance(T: inout, U: inout)]`, then tighten each direction only when the declaration surface proves it.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Rewrite the contract so every type parameter appears exactly once with `in`, `out`, `inout`, or `independent`.',
  );
});

Deno.test('analyzeProject keeps imported helper-returned RegExp groups as BareObject', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'export function getGroups() {',
      '  const match = /^(?<value>a)$/.exec("a");',
      '  if (match?.groups === undefined) {',
      '    throw new Error("expected groups");',
      '  }',
      '  return match.groups;',
      '}',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import { getGroups } from "./helpers";',
      'const plain: object = getGroups();',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject keeps direct exported RegExp groups values as BareObject across modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'const match = /^(?<value>a)$/.exec("a");',
      'if (match?.groups === undefined) {',
      '  throw new Error("expected groups");',
      '}',
      '',
      'export const groups = match.groups;',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import { groups } from "./helpers";',
      'const plain: object = groups;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject preserves RegExp groups values as BareObject through simple value re-exports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'const match = /^(?<value>a)$/.exec("a");',
      'if (match?.groups === undefined) {',
      '  throw new Error("expected groups");',
      '}',
      '',
      'export const groups = match.groups;',
      '',
    ].join('\n'),
    'src/mid.sts': 'export { groups } from "./helpers";\n',
    'src/index.sts': [
      'import { groups } from "./mid";',
      'const plain: object = groups;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject keeps default-exported RegExp groups values as BareObject across modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'const match = /^(?<value>a)$/.exec("a");',
      'if (match?.groups === undefined) {',
      '  throw new Error("expected groups");',
      '}',
      '',
      'const groups = match.groups;',
      '',
      'export default groups;',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import groups from "./helpers";',
      'const plain: object = groups;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test(
  'analyzeProject keeps branchy helpers with a RegExp-groups branch in the BareObject family',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/helpers.sts': [
        'export function getGroups(flag: boolean) {',
        '  if (flag) {',
        '    return { plain: true };',
        '  }',
        '  const match = /^(?<value>a)$/.exec("a");',
        '  if (match?.groups === undefined) {',
        '    throw new Error("expected groups");',
        '  }',
        '  return match.groups;',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import { getGroups } from "./helpers";',
        'const plain: object = getGroups(true);',
        'void plain;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  },
);
Deno.test('analyzeProject preserves Object.groupBy through imported identity helpers', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2024',
          module: 'ESNext',
          lib: ['ES2024'],
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/forward.sts': [
      'export function forward<T>(value: T): T {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/helpers.sts': [
      'export function groupByParity() {',
      '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
      '}',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import { forward } from "./forward";',
      'import { groupByParity } from "./helpers";',
      'const plain: object = forward(groupByParity());',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SOUND1024'],
  );
  assertEquals(
    result.diagnostics.some((diagnostic) => diagnostic.line === 3 && diagnostic.column === 7),
    true,
  );
});

Deno.test('analyzeProject preserves RegExp groups as BareObject through imported identity helpers', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/forward.sts': [
      'export function forward<T>(value: T): T {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import { forward } from "./forward";',
      'const match = /^(?<value>a)$/.exec("a");',
      'if (match?.groups === undefined) {',
      '  throw new Error("expected groups");',
      '}',
      'const groups = match.groups;',
      'const plain: object = forward(groups);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(result.diagnostics[0]?.line, 7);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test(
  'analyzeProject keeps ordinary helpers named getGroups ordinary despite groups-like plain-object returns',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/helpers.sts': [
        'export function getGroups() {',
        '  return { value: "a" };',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import { getGroups } from "./helpers";',
        'const plain: object = getGroups();',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);

Deno.test(
  'analyzeProject keeps forwarded fake RegExp groups-like plain objects ordinary',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/forward.sts': [
        'export function forward<T>(value: T): T {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import { forward } from "./forward";',
        'const fakeGroups = { groups: { value: "a" } };',
        'const plain: object = forward(fakeGroups);',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);

Deno.test('analyzeProject allows awaited dynamic-import namespace member reads', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/math.sts': [
      'export function add(left: number, right: number): number { return left + right; }',
      'export function sub(left: number, right: number): number { return left - right; }',
      '',
    ].join('\n'),
    'src/index.sts': [
      'export {};',
      'const math = await import("./math");',
      'const sum: number = math.add(1, 2);',
      'const diff: number = math.sub(4, 1);',
      'void sum;',
      'void diff;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test(
  'analyzeProject summarizes default-exported RegExp groups helpers as BareObject across modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/helpers.sts': [
        'export default function getGroups() {',
        '  const match = "a".match(/^(?<value>a)$/);',
        '  if (match?.groups === undefined) {',
        '    throw new Error("expected groups");',
        '  }',
        '  return match.groups;',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import getGroups from "./helpers";',
        'const plain: object = getGroups();',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertEquals(result.diagnostics[0]?.line, 2);
    assertEquals(result.diagnostics[0]?.column, 7);
  },
);

Deno.test(
  'analyzeProject preserves aliased Object.groupBy results through imported identity helpers',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            lib: ['ES2024'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/forward.sts': [
        'export function forward<T>(value: T): T {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
      'src/helpers.sts': [
        'export function groupByParity() {',
        '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import { forward } from "./forward";',
        'import { groupByParity } from "./helpers";',
        'const grouped = groupByParity();',
        'const plain: object = forward(grouped);',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertEquals(
      result.diagnostics.some((diagnostic) => diagnostic.line === 4 && diagnostic.column === 7),
      true,
    );
  },
);

Deno.test(
  'analyzeProject does not treat imported helper function values as non-ordinary results',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            lib: ['ES2024'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/helpers.sts': [
        'export function groupByParity() {',
        '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import { groupByParity } from "./helpers";',
        'const x: object = groupByParity;',
        'void x;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);

Deno.test(
  'analyzeProject allows Promise.all destructured namespace member reads',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/math.sts':
        'export function add(left: number, right: number): number { return left + right; }\n',
      'src/strings.sts': 'export const label = "ok";\n',
      'src/index.sts': [
        'export {};',
        'const [math, strings] = await Promise.all([import("./math"), import("./strings")]);',
        'const sum: number = math.add(1, 2);',
        'const text: string = strings.label;',
        'void sum;',
        'void text;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);

Deno.test(
  'analyzeProject summarizes anonymous default-exported null-prototype helpers across modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/helpers.sts': [
        'export default function () {',
        '  return Object.create(null);',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import makeDict from "./helpers";',
        'const plain: object = makeDict();',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertEquals(
      result.diagnostics.some((diagnostic) => diagnostic.line === 2 && diagnostic.column === 7),
      true,
    );
  },
);

Deno.test(
  'analyzeProject summarizes anonymous default-exported Object.groupBy helpers across modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            lib: ['ES2024'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/helpers.sts': [
        'export default function () {',
        '  return Object.groupBy([1, 2], (value) => value % 2 === 0 ? "even" : "odd");',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import groupByParity from "./helpers";',
        'const plain: object = groupByParity();',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertEquals(
      result.diagnostics.some((diagnostic) => diagnostic.line === 2 && diagnostic.column === 7),
      true,
    );
  },
);

Deno.test(
  'analyzeProject summarizes default-exported arrow Object.groupBy helpers across modules',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2024',
            module: 'ESNext',
            lib: ['ES2024'],
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/helpers.sts': [
        'export default () => Object.groupBy(',
        '  [1, 2],',
        '  (value) => value % 2 === 0 ? "even" : "odd",',
        ');',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import groupByParity from "./helpers";',
        'const plain: object = groupByParity();',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
    assertEquals(result.diagnostics[0]?.line, 2);
    assertEquals(result.diagnostics[0]?.column, 7);
  },
);

Deno.test(
  'analyzeProject allows Promise.allSettled fulfilled namespace member reads',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/math.sts':
        'export function add(left: number, right: number): number { return left + right; }\n',
      'src/index.sts': [
        'export {};',
        'const settled = await Promise.allSettled([import("./math")]);',
        'if (settled[0]?.status === "fulfilled") {',
        '  const sum: number = settled[0].value.add(1, 2);',
        '  void sum;',
        '}',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);

Deno.test('analyzeProject preserves non-ordinary arguments through imported helper parameter forwarding', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': [
      'export function forward<T>(value: T): T {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import { forward } from "./helpers";',
      'const dict = Object.create(null);',
      'const plain: object = forward(dict);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(result.diagnostics[0]?.line, 3);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject keeps direct exported null-prototype values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': 'export const dict = Object.create(null);\n',
    'src/index.sts': [
      'import { dict } from "./helpers";',
      'const plain: object = dict;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject preserves null-prototype values through simple value re-exports', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': 'export const dict = Object.create(null);\n',
    'src/mid.sts': 'export { dict } from "./helpers";\n',
    'src/index.sts': [
      'import { dict } from "./mid";',
      'const plain: object = dict;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject keeps default-exported null-prototype values non-ordinary across modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helpers.sts': 'export default Object.create(null);\n',
    'src/index.sts': [
      'import dict from "./helpers";',
      'const plain: object = dict;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(
    result.diagnostics[0]?.message,
    "Null-prototype values are not assignable to 'object' in soundscript.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  );
  assertEquals(result.diagnostics[0]?.line, 2);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test(
  'analyzeProject keeps ordinary imported helpers ordinary despite same-named summarized helpers',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/nonordinary.sts': [
        'export function forward<T>(value: T): T {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
      'src/ordinary.sts': [
        'export function forward<T>(value: T) {',
        '  return { value };',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': [
        'import { forward } from "./ordinary";',
        '',
        'const dict = Object.create(null);',
        'const plain: object = forward(dict);',
        'void plain;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);

Deno.test('analyzeProject models extends-null class instances as BareObject', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'class DirectDict extends null {}',
      'const direct: BareObject = new DirectDict();',
      '',
      'const n = null;',
      'class AliasedDict extends n {}',
      'const aliased: BareObject = new AliasedDict();',
      'const plain: object = aliased;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1024']);
  assertEquals(result.diagnostics[0]?.line, 7);
  assertEquals(result.diagnostics[0]?.column, 7);
});

Deno.test('analyzeProject respects in-memory file overrides', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': "export const value = 'ok';\n",
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
    fileOverrides: new Map([
      [
        join(tempDirectory, 'src/index.sts'),
        "const coerced = JSON.parse('1') as number;\n",
      ],
    ]),
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1002']);
});

Deno.test('analyzeProject applies macro rewriting in in-memory file overrides before TypeScript parsing', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'export const value = 1;\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
    fileOverrides: new Map([
      [
        join(tempDirectory, 'src/index.sts'),
        [
          "import { log } from 'sts:experimental/debug';",
          '// #[extern]',
          'declare const console: { log(...args: readonly unknown[]): void };',
          '// #[extern]',
          'declare function __sts_log<T>(source: string, value: T): T;',
          'const value = log(1);',
          'void value;',
          '',
        ].join('\n'),
      ],
    ]),
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject reports malformed macro syntax without duplicate TypeScript parse errors', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'export const value = 1;\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
    fileOverrides: new Map([
      [
        join(tempDirectory, 'src/index.sts'),
        '#foo(a,,b)\n',
      ],
    ]),
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUNDSCRIPT_MACRO_PARSE',
  ]);
});

Deno.test('analyzeProject does not cascade missing-export errors from malformed macro files', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/broken.sts': 'export const bad = #foo(a,,b);\n',
    'src/index.sts': [
      'import { bad } from "./broken";',
      'export const value = bad;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUNDSCRIPT_MACRO_PARSE',
  ]);
});

Deno.test('analyzeProject preserves ordinary TypeScript diagnostic lines after macro rewriting', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'export const value = 1;\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
    fileOverrides: new Map([
      [
        join(tempDirectory, 'src/index.sts'),
        [
          "import { log } from 'sts:experimental/debug';",
          '// #[extern]',
          'declare const console: { log(...args: readonly unknown[]): void };',
          '// #[extern]',
          'declare function __sts_log<T>(source: string, value: T): T;',
          'const value = log(1);',
          'const count: number = "oops";',
          '',
        ].join('\n'),
      ],
    ]),
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
  assertEquals(result.diagnostics[0]?.line, 7);
});

Deno.test('analyzeProject expands import-scoped builtin macros before TypeScript diagnostics', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { log } from 'sts:experimental/debug';",
      '// #[extern]',
      'declare const console: { log(...args: readonly unknown[]): void };',
      '// #[extern]',
      'declare function __sts_log<T>(source: string, value: T): T;',
      'const value: string = log(123);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
  assertEquals(result.diagnostics[0]?.line, 6);
});

Deno.test('analyzeProject expands import-scoped user-defined macros before TypeScript diagnostics', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/macros/twice.macro.sts': '',
    'src/index.sts': [
      "import { Twice } from './macros/twice.macro';",
      'const value: string = Twice(123);',
      '',
    ].join('\n'),
  });
  const actualMacroModulePath = join(tempDirectory, 'src/macros/twice.macro.sts');
  await Deno.writeTextFile(
    actualMacroModulePath,
    createUserDefinedTwiceMacroText(),
  );

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
  assertEquals(result.diagnostics[0]?.line, 2);
});

Deno.test('analyzeProject allows .macro.sts macro-authoring modules and expands them for consumers', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/macros/twice.macro.sts': createUserDefinedTwiceMacroText(),
    'src/index.sts': [
      "import { Twice } from './macros/twice.macro';",
      'const value: number = Twice(21);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject requires explicit comparators for sort aliases and prototype call sites', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const hostValues = [3, 1, 2];',
      'hostValues["sort"]();',
      'const machineValues: u8[] = [U8(3), U8(1), U8(2)];',
      'machineValues["toSorted"]();',
      'Array.prototype.sort.call(hostValues);',
      'Array.prototype.toSorted.call(machineValues);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 2, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 4, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 5, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 6, 1],
    ],
  );
});

Deno.test('analyzeProject requires explicit comparators for apply and bound alias sort sites', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'const hostValues = [3, 1, 2];',
      'Array.prototype.sort.apply(hostValues);',
      'const machineValues: u8[] = [U8(3), U8(1), U8(2)];',
      'Array.prototype.toSorted.apply(machineValues);',
      'const boundSort = hostValues.sort.bind(hostValues);',
      'boundSort();',
      'const boundToSorted = machineValues.toSorted.bind(machineValues);',
      'boundToSorted();',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 2, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 4, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 6, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 8, 1],
    ],
  );
});

Deno.test('analyzeProject rejects top-level mutating method calls in .macro.sts modules', async () => {
  const tempDirectory = await createMacroProject(createTopLevelMutatingMacroText());

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['SOUNDSCRIPT_MACRO_FORBIDDEN_TOP_LEVEL_EFFECT'],
  );
  assertEquals(result.diagnostics[0]?.line, 4);
});

Deno.test('prepareProjectAnalysis excludes macro-rewritten consumer .sts files from sound-analysis contexts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/macros/augment.macro.sts': createUserDefinedAugmentMacroText(),
    'src/index.sts': [
      "import { augment } from './macros/augment.macro';",
      '',
      '// #[augment]',
      'export class Registry {}',
      '',
    ].join('\n'),
  });

  const prepared = prepareProjectAnalysis({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assert(prepared.stsView);
  assertEquals(
    prepared.stsView.analysisContext.getSourceFiles().map((sourceFile) => sourceFile.fileName),
    [],
  );
});

Deno.test(
  'analyzePreparedProjectForFile excludes macro-rewritten consumer .sts files from sound-analysis contexts',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/macros/augment.macro.sts': createUserDefinedAugmentMacroText(),
      'src/index.sts': [
        "import { augment } from './macros/augment.macro';",
        '',
        '// #[augment]',
        'export class Registry {}',
        '',
        'const dict = Object.create(null);',
        'const plain: object = dict;',
        'void plain;',
        '',
      ].join('\n'),
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const filePath = join(tempDirectory, 'src/index.sts');
    const prepared = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });

    const fullResult = analyzePreparedProject(prepared);
    const fileResult = analyzePreparedProjectForFile(prepared, filePath);

    assertEquals(
      fullResult.diagnostics.map((diagnostic) => diagnostic.code),
      [],
    );
    assertEquals(
      fileResult.diagnostics.map((diagnostic) => diagnostic.code),
      [],
    );
  },
);

Deno.test(
  'analyzePreparedProjectForFile reports dependency-side diagnostics for invalid default-exported local macro barrels',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/macros/augment.macro.sts': [
        "import { macroSignature } from 'sts:macros';",
        '',
        '// #[macro(decl)]',
        'export default function augment() {',
        '  return {',
        '    declarationKinds: ["class"] as const,',
        "    expansionMode: 'augment' as const,",
        '    signature: macroSignature.of(macroSignature.decl("target")),',
        '    expand(ctx: any) {',
        '      return ctx.output.stmt(',
        '        ctx.quote.stmt`export const RegistryRegistry = Registry;`,',
        '      );',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
      'src/macros/index.sts': 'export { default } from "./augment.macro.sts";\n',
      'src/index.sts': [
        'import augment from "./macros/index.sts";',
        '',
        '// #[augment]',
        'export class Registry {}',
        '',
        'const dict = Object.create(null);',
        'const plain: object = dict;',
        'void plain;',
        '',
      ].join('\n'),
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const filePath = join(tempDirectory, 'src/index.sts');
    const prepared = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });

    const fullResult = analyzePreparedProject(prepared);
    const fileResult = analyzePreparedProjectForFile(prepared, filePath);

    assertEquals(
      fullResult.diagnostics.map((diagnostic) => diagnostic.code),
      ['SOUNDSCRIPT_MACRO_EXPANSION'],
    );
    assertEquals(
      fileResult.diagnostics.map((diagnostic) => diagnostic.code),
      ['SOUNDSCRIPT_MACRO_EXPANSION'],
    );
    assert(
      fullResult.diagnostics[0]?.message.includes(
        'cannot default-export // #[macro(...)] factories',
      ) ?? false,
    );
    assert(
      fileResult.diagnostics[0]?.message.includes(
        'cannot default-export // #[macro(...)] factories',
      ) ?? false,
    );
  },
);

Deno.test(
  'analyzePreparedProjectForFile includes dependency-side package macro diagnostics for local consumers',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import { augment } from "sound-pkg";',
        '',
        '// #[augment]',
        'export class Registry {}',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          type: 'module',
          types: './dist/index.d.ts',
          soundscript: {
            source: './src/index.sts',
          },
        },
        null,
        2,
      ),
      'node_modules/sound-pkg/dist/index.d.ts': 'export declare const augment: unique symbol;\n',
      'node_modules/sound-pkg/src/index.sts': 'export { augment } from "./augment.macro.sts";\n',
      'node_modules/sound-pkg/src/augment.macro.sts': [
        "import 'sts:macros';",
        '',
        'const box = {',
        '  get value() {',
        '    return 1;',
        '  },',
        '};',
        'void box;',
        '',
      ].join('\n'),
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const filePath = join(tempDirectory, 'src/index.sts');

    const directResult = await analyzeProject(baseOptions);
    const prepared = prepareProjectAnalysis(baseOptions);
    const wholePreparedResult = analyzePreparedProject(prepared);
    const fileScopedResult = analyzePreparedProjectForFile(prepared, filePath);
    const sortedFileScopedDiagnostics = [...fileScopedResult.diagnostics].sort((left, right) =>
      left.code.localeCompare(right.code) ||
      (left.filePath ?? '').localeCompare(right.filePath ?? '')
    );

    const directCodes = directResult.diagnostics.map((diagnostic) => diagnostic.code);
    assertEquals(directCodes, ['TS2305']);
    assertEquals(wholePreparedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertEquals(sortedFileScopedDiagnostics.map((diagnostic) => diagnostic.code), ['TS2305']);
    assertStringIncludes(
      sortedFileScopedDiagnostics[0]?.filePath ?? '',
      '/node_modules/sound-pkg/src/index.sts',
    );
  },
);

Deno.test(
  'analyzePreparedProjectForFile keeps local non-root .sts files on the sts view',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          files: ['src/index.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'import "./leaf.sts";',
        'import { version } from "sound-pkg";',
        'void version;',
        '',
      ].join('\n'),
      'src/leaf.sts': [
        'let promiseLike: PromiseLike<number> | null = null;',
        'promiseLike = null;',
        '',
      ].join('\n'),
      'node_modules/sound-pkg/package.json': JSON.stringify(
        {
          name: 'sound-pkg',
          version: '1.0.0',
          type: 'module',
          types: './dist/index.d.ts',
          soundscript: {
            source: './src/index.sts',
          },
        },
        null,
        2,
      ),
      'node_modules/sound-pkg/dist/index.d.ts': 'export declare const version: number;\n',
      'node_modules/sound-pkg/src/index.sts': 'export const version = 1;\n',
    });

    const projectPath = join(tempDirectory, 'tsconfig.json');
    const filePath = join(tempDirectory, 'src/leaf.sts');
    const prepared = prepareProjectAnalysis({
      projectPath,
      workingDirectory: tempDirectory,
    });

    const result = analyzePreparedProjectForFile(prepared, filePath);

    assertEquals(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['SOUND1034', 'SOUND1022'],
    );
    assertEquals(result.diagnostics[0]?.filePath, filePath);
    assertEquals(result.diagnostics[1]?.filePath, filePath);
  },
);

Deno.test(
  'prepareProjectAnalysis invalidates reused sound views when resolved imported macro site kinds change',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/macros/augment.macro.sts': createUserDefinedAugmentMacroText(),
      'src/index.sts': [
        "import { augment } from './macros/augment.macro';",
        '',
        '// #[augment]',
        'export class Registry {}',
        '',
        'const dict = Object.create(null);',
        'const plain: object = dict;',
        'void plain;',
        '',
      ].join('\n'),
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'src/macros/augment.macro.sts'),
      [
        "import { macroSignature } from 'sts:macros';",
        '',
        '// #[macro(call)]',
        'export function augment() {',
        '  return {',
        '    signature: macroSignature.of(macroSignature.expr("value")),',
        '    expand(ctx, signature) {',
        '      if (!signature) {',
        "        throw new Error('expected signature');",
        '      }',
        '      return ctx.output.expr(signature.args.value);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    );

    const directResult = await analyzeProject(baseOptions);
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const directSound1024 = directResult.diagnostics.find((diagnostic) =>
      diagnostic.code === 'SOUND1024'
    );
    const reusedSound1024 = reusedPreparedResult.diagnostics.find((diagnostic) =>
      diagnostic.code === 'SOUND1024'
    );

    const directCodes = directResult.diagnostics.map((diagnostic) => diagnostic.code);
    assertEquals(directCodes.includes('SOUND1024'), true);
    assertEquals(freshPreparedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertEquals(
      reusedPreparedResult.diagnostics.map((diagnostic) => diagnostic.code),
      directCodes,
    );
    assertEquals(directSound1024?.filePath, join(tempDirectory, 'src/index.sts'));
    assertEquals(reusedSound1024?.filePath, join(tempDirectory, 'src/index.sts'));
  },
);

for (const { label, body, extraFiles } of topLevelAccessorMacroCases) {
  Deno.test(`analyzeProject rejects top-level ${label} in .macro.sts modules`, async () => {
    const tempDirectory = await createMacroProject(
      createMacroTextWithTopLevelBody(body),
      extraFiles,
    );

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['SOUND1022'],
    );
  });
}
Deno.test('analyzeProject expands sts:prelude Try macros before TypeScript diagnostics', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { type Result, ok, Try } from 'sts:prelude';",
      '// #[extern]',
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute(): Result<string, string> {',
      '  const value: string = Try(fetchValue());',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
});

Deno.test('analyzeProject does not report SOUND1020 for extracted Try values used as ordinary locals', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { Try, err, ok, type Result } from 'sts:prelude';",
      '',
      'export function safeDivide(dividend: number, divisor: number): Result<number, string> {',
      '  if (divisor === 0) {',
      "    return err('divide_by_zero');",
      '  }',
      '',
      '  return ok(dividend / divisor);',
      '}',
      '',
      'export function divideThreeWays(',
      '  left: number,',
      '  middle: number,',
      '  right: number,',
      '): Result<number, string> {',
      '  const first = Try(safeDivide(left, middle));',
      '  const second = Try(safeDivide(first, right));',
      '  return ok(second);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject accepts Try in unannotated functions with inferred Result returns', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { Try, err, ok, type Result } from 'sts:prelude';",
      '',
      '// #[extern]',
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute() {',
      '  const value = Try(fetchValue());',
      '',
      '  if (value > 0) {',
      "    return err('bad');",
      '  }',
      '',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUNDSCRIPT_MACRO_EXPANSION'),
    false,
  );
});

Deno.test('analyzeProject accepts Try in unannotated functions whose error flow comes only from Try', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { Try, ok, type Result } from 'sts:prelude';",
      '',
      '// #[extern]',
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute() {',
      '  const value = Try(fetchValue());',
      '  return ok(value + 1);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUNDSCRIPT_MACRO_EXPANSION'),
    false,
  );
});

Deno.test('analyzeProject reports actionable guidance for SOUND1020 invalidation boundaries', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'declare function mutate(box: { value: string | null }): void;',
      '',
      'function use(box: { value: string | null }) {',
      '  if (box.value !== null) {',
      '    mutate(box);',
      '    const value: string = box.value;',
      '    return value;',
      '  }',
      '  return "";',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1020']);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Capture a stable primitive or immutable snapshot into a fresh local before the call boundary, or re-check the value after the call.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'The earlier check for `box.value` was invalidated by this call boundary.',
    'Earlier proof: `box.value !== null`.',
    'Capture a stable primitive or immutable snapshot into a fresh local before the call boundary, or re-check the value after the call.',
    'Example: Capture before the call when stable: `const capturedValue = box.value; mutate(box); use(capturedValue);`, or re-check after the call.',
  ]);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'flow_narrowing_invalidation');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'recheck_after_boundary');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'box.value');
  assertEquals(result.diagnostics[0]?.metadata?.secondarySymbol, 'call');
  assertEquals(result.diagnostics[0]?.metadata?.evidence, [
    { label: 'narrowedValue', value: 'box.value' },
    { label: 'boundaryKind', value: 'call' },
    { label: 'invalidatingBoundary', value: 'mutate(box)' },
    { label: 'earlierProof', value: 'box.value !== null' },
  ]);
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'A boundary between the check and later use could change the value before the narrowed use runs.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Capture before the call when stable: `const capturedValue = box.value; mutate(box); use(capturedValue);`, or re-check after the call.',
  );
  assertEquals(result.diagnostics[0]?.line, 6);
  assertEquals(result.diagnostics[0]?.column, 5);
  assertEquals(result.diagnostics[0]?.relatedInformation, [
    {
      message: 'Earlier narrowing established here.',
      filePath: join(tempDirectory, 'src/index.sts'),
      line: 5,
      column: 7,
      endLine: 5,
      endColumn: 25,
    },
  ]);
});

Deno.test('analyzeProject preserves narrowing across calls proven free of mut and suspend', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'function peek(box: { value: string | null }): string | null {',
      '  return box.value;',
      '}',
      '',
      'function use(box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    peek(box);',
      '    const value: string = box.value;',
      '    return value;',
      '  }',
      '  return "";',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject keeps guarded Error Match arms free of generated-code diagnostics', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { where, Match } from 'sts:prelude';",
      'function matchTest(value: unknown): boolean {',
      '  return Match(value, [',
      '    where(((err: Error) => true), ((err) => "code" in err)),',
      '    ((_) => false),',
      '  ]);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject reports direct Match diagnostics for untyped shorthand object arm annotations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { err, Match, ok, type Result } from 'sts:prelude';",
      '',
      'function safeDivide(dividend: number, divisor: number): Result<number, string> {',
      '  if (divisor === 0) {',
      "    return err('divide_by_zero');",
      '  }',
      '',
      '  return ok(dividend / divisor);',
      '}',
      '',
      'export function describeDivision(dividend: number, divisor: number): string {',
      '  return Match(safeDivide(dividend, divisor), [',
      "    (x: { type: 'ok', value }) => value === 4 ? 'ok:4' : 'ok',",
      "    (x: { type: 'err', error }) => x.error === 'divide_by_zero' ? 'err:divide_by_zero' : 'err',",
      "    (x) => 'not reachable',",
      '  ]);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUNDSCRIPT_MACRO_EXPANSION',
  ]);
  assert(
    result.diagnostics[0]?.message.includes(
      'Match object-type arm annotations do not support untyped shorthand members',
    ) ?? false,
  );
});

Deno.test('analyzeProject keeps ordinary TypeScript and sound diagnostics after earlier macro rewrites on the original source span', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { Try, err, Match, ok, type Err, type Ok, type Result, where } from 'sts:prelude';",
      '',
      'export function safeDivide(dividend: number, divisor: number): Result<number, string> {',
      '  if (divisor === 0) {',
      "    return err('divide_by_zero');",
      '  }',
      '',
      '  return ok(dividend / divisor);',
      '}',
      '',
      'export function divideThreeWays(',
      '  left: number,',
      '  middle: number,',
      '  right: number,',
      '): Result<number, string> {',
      '  const first = Try(safeDivide(left, middle));',
      '  const second = Try(safeDivide(first, right));',
      '  return ok(second);',
      '}',
      '',
      'export function describeDivision(dividend: number, divisor: number): string {',
      '  return Match(safeDivide(dividend, divisor), [',
      "    ({ value }: Ok<number>) => value === 4 ? 'ok:4' : 'ok',",
      "    ({ error }: Err<string>) => error === 'divide_by_zero' ? 'err:divide_by_zero' : 'err',",
      '  ]);',
      '}',
      '',
      'function matchTest(value: unknown): boolean {',
      '  return Match(value, [',
      "    where((x: Error) => true, (x) => 'code' in x),",
      '    (_) => false',
      '  ]);',
      '}',
      '',
      'interface Animal { name: string; }',
      'interface Dog extends Animal { breed: string; }',
      '',
      'const dogs: readonly Dog[] = [];',
      'const animals: readonly Animal[] = dogs;',
      '',
      'animals.push({ name: "Whiskers" });',
      '',
      'const o1 = Object.create(null);',
      'const o2: object = o1;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2339']);
  assertEquals(result.diagnostics[0]?.line, 41);
  assertEquals(result.diagnostics[0]?.column, 'animals.'.length + 1);
  assertEquals(result.diagnostics[0]?.endLine, 41);
  assertEquals(result.diagnostics[0]?.endColumn, 'animals.push'.length + 1);
});

Deno.test('analyzeProject reports nominal class assignment errors on the source expression', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'class B {',
      '  type: string;',
      '',
      '  constructor() {',
      "    this.type = 'b';",
      '  }',
      '}',
      '',
      'class C {',
      '  type: string;',
      '',
      '  constructor() {',
      "    this.type = 'c';",
      '  }',
      '}',
      '',
      'const b = new B();',
      'const c: C = b;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
  assertEquals(result.diagnostics[0]?.message, 'Class instance types are nominal in soundscript.');
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'nominal_class_relation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'C');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'structural_interface_projection',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['sourceType:B', 'targetType:C', 'requiredIdentity:C'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    "A value with the public shape of 'C' is still not a real 'C' instance unless it carries the target class identity or subclass relation.",
  );
  assertEquals(result.diagnostics[0]?.line, 18);
  assertEquals(result.diagnostics[0]?.column, 'const c: C = '.length + 1);
  assertEquals(result.diagnostics[0]?.endLine, 18);
  assertEquals(result.diagnostics[0]?.endColumn, 'const c: C = b'.length + 1);
});

Deno.test('analyzeProject allows inferred Result branch unions to flow into canonical Result aliases', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { err, ok, type Result } from 'sts:prelude';",
      '',
      'function decodeJsonRecordValue(flag: boolean) {',
      '  if (flag) {',
      "    return err('bad');",
      '  }',
      '',
      '  return ok(1);',
      '}',
      '',
      'const value: Result<number, string> = decodeJsonRecordValue(true);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject accepts Try-based decoder helpers with inferred Result returns', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      "import { type Decoder, DecodeFailure } from 'sts:decode';",
      "import { isJsonValue, type JsonValue } from 'sts:json';",
      "import { Try, err, isErr, ok, type Result } from 'sts:prelude';",
      '',
      'type JsonRecord = Record<string, JsonValue>;',
      '',
      'const plainObjectDecoder: Decoder<Record<string, unknown>> = {',
      '  decode(value): Result<Record<string, unknown>, DecodeFailure> {',
      "    if (typeof value !== 'object' || value === null || Array.isArray(value)) {",
      "      return err(new DecodeFailure('Expected object.', { cause: value }));",
      '    }',
      '',
      '    const record: Record<string, unknown> = {};',
      '    for (const [key, nestedValue] of Object.entries(value)) {',
      '      record[key] = nestedValue;',
      '    }',
      '    return ok(record);',
      '  },',
      '};',
      '',
      'function decodeJsonRecordValue(value: unknown, message: string) {',
      '  const record = Try(plainObjectDecoder.decode(value));',
      '  const jsonRecord: JsonRecord = {};',
      '',
      '  for (const [key, nestedValue] of Object.entries(record)) {',
      '    if (!isJsonValue(nestedValue)) {',
      '      return err(new DecodeFailure(message, { path: [key] }));',
      '    }',
      '    jsonRecord[key] = nestedValue;',
      '  }',
      '',
      '  return ok(jsonRecord);',
      '}',
      '',
      'function jsonRecordDecoder(message: string): Decoder<JsonRecord> {',
      '  return {',
      '    decode(value): Result<JsonRecord, DecodeFailure> {',
      '      return decodeJsonRecordValue(value, message);',
      '    },',
      '  };',
      '}',
      '',
      "const decoded = jsonRecordDecoder('Expected JSON object.').decode({ ok: 'value' });",
      'if (isErr(decoded)) {',
      "  throw new Error('unexpected');",
      '}',
      'const record: JsonRecord = decoded.value;',
      'void record;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
});

Deno.test('analyzeProject reports actionable guidance for non-Error throws', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'function fail(): never {',
      '  throw "boom";',
      '}',
      '',
      'void fail;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1025']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'throw_non_error');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'error_object_construction');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['thrownType:"boom"'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Throwing a bare value drops the `Error` surface that downstream code relies on for `message`, `name`, stack, and cause information.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Write `throw new Error(String(problem));` or throw a concrete `Error` subclass instead.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'The thrown value has type \'"boom"\', but soundscript only permits `Error`-family throws.',
    'Example: Write `throw new Error(String(problem));` or throw a concrete `Error` subclass instead.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Wrap the payload in `Error` or a concrete `Error` subclass before throwing.',
  );
});

Deno.test('analyzeProject reports actionable guidance for receiver-sensitive callable extraction', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'const extracted = box.read;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1035']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'receiver_sensitive_callable_value');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'read');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'receiver_preserving_wrapper',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['receiverType:Box', 'memberName:read'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Extracted method references can be called later with the wrong `this` value or with no receiver at all.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Write `const extracted = () => box.read();` or keep the call as `box.read()`.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'This callable depends on its original receiver and cannot safely become a standalone value.',
    'Example: Write `const extracted = () => box.read();` or keep the call as `box.read()`.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Keep the call in member form like `box.read()`, or wrap it in a lambda that preserves the receiver.',
  );
});

Deno.test('analyzeProject reports actionable guidance for construction-time member dispatch', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '',
      '  constructor() {',
      '    this.read();',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1036']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'construction_lifecycle_violation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'read');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'finish_initialization_before_dispatch',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['hazardKind:receiver method dispatch', 'receiver:this', 'memberName:read'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Dispatching through instance members before construction completes can observe partially initialized state or overridden subclass behavior.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Write fields directly during construction, then call `read` from a post-construction method or factory step instead of from the constructor.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'This constructor dispatches through `this.read` before construction completes.',
    'Example: Write fields directly during construction, then call `read` from a post-construction method or factory step instead of from the constructor.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Finish initialization before calling instance members or letting `this` escape.',
  );
});

Deno.test('analyzeProject reports actionable guidance for field reads before initialization', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'class Box {',
      '  first = this.second;',
      '  second = 1;',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  const diagnostic = result.diagnostics.find((entry) => entry.code === 'SOUND1037');
  assertEquals(diagnostic?.code, 'SOUND1037');
  assertEquals(diagnostic?.metadata?.rule, 'field_read_before_initialization');
  assertEquals(diagnostic?.metadata?.primarySymbol, 'second');
  assertEquals(diagnostic?.metadata?.replacementFamily, 'initialize_before_read');
  assertEquals(diagnostic?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    diagnostic?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['fieldName:second', 'accessKind:this property access'],
  );
  assertEquals(
    diagnostic?.metadata?.counterexample,
    'A read before definite initialization can observe an uninitialized field or depend on constructor ordering that soundscript cannot prove safe.',
  );
  assertEquals(
    diagnostic?.metadata?.example,
    'Assign `second` on every path before reading it, or move the read after the initializing assignment.',
  );
  assertEquals(diagnostic?.notes, [
    'The read of `second` can happen before that field is definitely initialized on every path.',
    'Example: Assign `second` on every path before reading it, or move the read after the initializing assignment.',
  ]);
  assertEquals(
    diagnostic?.hint,
    'Initialize the field before reading it, or defer the read until after construction establishes the value.',
  );
});

Deno.test('analyzeProject reports actionable guidance for any types', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'const leaked: any = 1;\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1001']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'any_type');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'unknown_plus_validation');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Using `any` lets unchecked assumptions flow outward and disables the proof obligations soundscript relies on.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Replace `any` with `unknown`, then narrow or validate before use, or spell the precise type you expect.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`any` erases the type information that checked soundscript code relies on.',
    'Example: Replace `any` with `unknown`, then narrow or validate before use, or spell the precise type you expect.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Replace `any` with `unknown` plus validation, or write the precise type directly.',
  );
});

Deno.test('analyzeProject reports actionable guidance for unchecked type assertions', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': "const coerced = JSON.parse('1') as number;\n",
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1002']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'unchecked_type_assertion');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'control_flow_narrowing_or_boundary_validation',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'A type assertion can claim a value has structure or variants that the checker never proved.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Replace the assertion with a real runtime check, a validated interop boundary, or a helper that already returns the target type honestly.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['expressionType:JsonValue', 'assertedType:number'],
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "This assertion changes the type from 'JsonValue' to 'number' without a checked proof.",
    'Example: Replace the assertion with a real runtime check, a validated interop boundary, or a helper that already returns the target type honestly.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Use narrowing, validation, or an interop boundary instead of asserting the target type.',
  );
});

Deno.test('analyzeProject reports actionable guidance for non-null assertions', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[extern]',
      'declare const maybe: string | undefined;',
      'const value = maybe!;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1003']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'unchecked_non_null_assertion');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'explicit_null_check');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'A non-null assertion can pretend a maybe-null value is present even though another path still allows `null` or `undefined`.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Check the value first, or normalize it with a real fallback before using it as present.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['expressionType:string | undefined'],
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "This expression has type 'string | undefined', but `!` skips the proof that it is present.",
    'Example: Check the value first, or normalize it with a real fallback before using it as present.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Re-check the value or provide an explicit fallback before using it as non-null.',
  );
});

Deno.test('analyzeProject reports actionable guidance for predicate body mismatches', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'function isString(value: string | number): value is string {',
      '  return typeof value === "number";',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1017']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'predicate_body_mismatch');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'isString');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'supported_predicate_surface');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['parameterName:value', 'predicateType:string'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    "Callers may narrow `value` to 'string' on a path where the body actually accepts non-strings.",
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Make the body check the claimed predicate directly, or weaken the predicate to match what the function really proves.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'This guard claims `value is string`, but the body does not prove that on every `true` path.',
    'Example: Make the body check the claimed predicate directly, or weaken the predicate to match what the function really proves.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Change the body to prove the declared predicate, or weaken the predicate to match the actual check.',
  );
});

Deno.test('analyzeProject reports actionable guidance for unsupported predicate targets', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'function isStrings(value: unknown): value is string[] {',
      '  return Array.isArray(value);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1017']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'predicate_target_unsupported');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'isStrings');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'supported_predicate_surface');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'api_redesign');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['predicateType:string[]', 'unsupportedReason:unsupportedTarget'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'soundscript does not currently verify arbitrary predicate targets like arrays, tuples, generics, or receiver predicates from function bodies alone.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Return boolean and narrow at the call site, or redesign the API around a supported predicate target.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "This predicate targets 'string[]', which soundscript does not currently verify.",
    'Example: Return boolean and narrow at the call site, or redesign the API around a supported predicate target.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Use a boolean-returning helper plus caller-side checks, or restrict the predicate to a supported target kind.',
  );
});

Deno.test('analyzeProject reports actionable guidance for overload implementation mismatches', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'function format(value: string): string;',
      'function format(value: number): number;',
      'function format(value: string | number): string | number {',
      '  return String(value);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1018']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'overload_implementation_mismatch');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'format');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'honest_overload_surface');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['overloadSignature:format(value: number): number', 'implementationReturnType:string'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    "A caller selecting the `number` overload could receive a 'string' value that the signature never promised.",
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Return a `number` on the numeric path, or narrow the overload list so every declared overload matches the implementation.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    "The implementation returns 'string', but the overload `format(value: number): number` promises a different result.",
    'Example: Return a `number` on the numeric path, or narrow the overload list so every declared overload matches the implementation.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Make the implementation satisfy every overload signature honestly, or remove overloads the body does not really implement.',
  );
});

Deno.test(
  'analyzeProject forces the sound compiler option baseline when tsconfig omits it',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'function implicitAny(value) {',
        '  return value;',
        '}',
        '',
        'type Options = { maybe?: string };',
        'const options: Options = { maybe: undefined };',
        '',
        'type Dict = { [key: string]: number };',
        'declare const dict: Dict;',
        'const dot = dict.missing;',
        'const exact: number = dict["missing"];',
        '',
        'class Base {',
        '  render(): number {',
        '    return 1;',
        '  }',
        '}',
        '',
        'class Derived extends Base {',
        '  render(): number {',
        '    return 2;',
        '  }',
        '}',
        '',
        'function fallthrough(value: 0 | 1): number {',
        '  switch (value) {',
        '    case 0:',
        '      value + 1;',
        '    case 1:',
        '      return value;',
        '  }',
        '}',
        '',
        'void implicitAny;',
        'void options;',
        'void dot;',
        'void exact;',
        'void Derived;',
        'void fallthrough;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(
      result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      ['TS2322', 'TS2375', 'TS4111', 'TS4114', 'TS7006', 'TS7029'].sort(),
    );
  },
);

Deno.test('analyzeProject forces allowImportingTsExtensions when tsconfig omits it', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/types.ts': 'export const value = 1;\n',
    'src/index.sts': [
      '// #[interop]',
      'import { value } from "./types.ts";',
      'const exact: number = value;',
      'void exact;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test(
  'analyzeProject keeps nominal class assignment spans stable after interop import projection',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            allowImportingTsExtensions: true,
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/types.ts': [
        'export interface Environment {}',
        'export const literalSchema: any = {};',
        'export const a: any = 1;',
        '',
      ].join('\n'),
      'src/index.sts': [
        '',
        '// #[interop]',
        'import { type Environment, literalSchema, a } from "./types.ts";',
        '',
        '',
        '// import { type Result, ok, err, type Ok, type Err, Match, Try } from "soundscript:prelude";',
        '',
        '// function safeDivide(divisor: number, denominator: number): Result<number, string> {',
        '//     if (denominator == 0) {',
        '//         return err("divid_by_zero");',
        '//     }',
        '',
        '//     return ok(divisor / denominator);',
        '// }',
        '',
        '// function matchDivision() {',
        '//     return Match (safeDivide(10, 0), [',
        '//         ({ value }: Ok<number>) => true,',
        '//         ({ err }: Err<string>) => false',
        '//     ]);',
        '// }',
        '',
        '// function tryDivision() {',
        '//     const value = Try (safeDivide(10, 0));',
        '',
        '//     return value;',
        '// }',
        '',
        'class B {',
        '    type: string;',
        '',
        '    constructor() {',
        '        this.type = "b";',
        '    }',
        '}',
        '',
        'class C {',
        '    type: string;',
        '',
        '    constructor() {',
        '        this.type = "c";',
        '    }',
        '}',
        '',
        'const b = new B();',
        'const c: C = b;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
    assertEquals(result.diagnostics[0]?.line, 46);
    assertEquals(result.diagnostics[0]?.column, 'const c: C = '.length + 1);
    assertEquals(result.diagnostics[0]?.endLine, 46);
    assertEquals(result.diagnostics[0]?.endColumn, 'const c: C = b'.length + 1);
  },
);

for (const mode of VALUE_MODES) {
  for (const route of VALUE_ROUTES) {
    Deno.test(
      `analyzeProject accepts valid ${getValueModeSlug(mode)} #[value] routes through ${
        getValueRouteSlug(route)
      }`,
      async () => {
        const program = prefixValueMatrixProgram(createValueRouteProgram(mode, route), 'src');
        const tempDirectory = await createValueAnalysisProject(program.files);
        const result = await analyzeProject({
          projectPath: join(tempDirectory, 'tsconfig.json'),
          workingDirectory: tempDirectory,
        });

        assertEquals(result.diagnostics, []);
      },
    );
  }
}

for (const route of VALUE_ROUTES) {
  Deno.test(
    `analyzeProject rejects invalid deep #[value] routes through ${getValueRouteSlug(route)}`,
    async () => {
      const program = prefixValueMatrixProgram(createInvalidDeepValueRouteProgram(route), 'src');
      const tempDirectory = await createValueAnalysisProject(program.files);
      const result = await analyzeProject({
        projectPath: join(tempDirectory, 'tsconfig.json'),
        workingDirectory: tempDirectory,
      });

      const expectedBoxPath = join(
        tempDirectory,
        route === 'local' ? 'src/index.sts' : 'src/box.sts',
      );
      const expectedLeafPath = join(
        tempDirectory,
        route === 'local' ? 'src/index.sts' : 'src/leaf.sts',
      );
      assertEquals(
        result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.filePath]).sort(),
        [
          ['SOUND1022', expectedLeafPath],
          ['SOUND1027', expectedBoxPath],
          ['SOUND1027', expectedLeafPath],
        ],
      );
    },
  );
}

Deno.test('analyzeProject rejects deep #[value] classes that depend on invalid imported deep leaves', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'import { Box } from "./box.sts";\nvoid Box;\n',
    'src/box.sts': [
      '// #[value(deep: true)]',
      'export class Box {',
      '  readonly leaf: import("./leaf.sts").Leaf;',
      '',
      '  constructor(leaf: import("./leaf.sts").Leaf) {',
      '    this.leaf = leaf;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'src/leaf.sts': [
      '// #[value(deep: true)]',
      'export class Leaf {',
      '  readonly x: number;',
      '',
      '  constructor(x: number) {',
      '    this.x = x;',
      '  }',
      '',
      '  get y(): number {',
      '    return this.x;',
      '  }',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(
    result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.filePath]).sort(),
    [
      ['SOUND1022', join(tempDirectory, 'src/leaf.sts')],
      ['SOUND1027', join(tempDirectory, 'src/box.sts')],
      ['SOUND1027', join(tempDirectory, 'src/leaf.sts')],
    ].sort(),
  );
});
