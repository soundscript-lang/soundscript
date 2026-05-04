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
} from '../../tests/support/value_matrix.ts';
import {
  analyzePreparedProject,
  analyzePreparedProjectForFile,
  analyzeProject,
  prepareProjectAnalysis,
} from '../checker/analyze_project.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../../tests/support/test_installed_stdlib.ts';

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
      include: ['src/**/*.sts', 'src/**/*.d.ts'],
    },
    null,
    2,
  );
}

function createBrowserTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        lib: ['ES2024', 'DOM', 'DOM.AsyncIterable'],
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'ESNext',
      },
      soundscript: {
        target: 'js-browser',
      },
      include: ['src/**/*.sts', 'src/**/*.d.ts'],
    },
    null,
    2,
  );
}

function createValueAnalysisProject(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  return createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    ...files,
  });
}

function createMacroProject(
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

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1005',
    'SOUND1005',
    'SOUND1005',
    'SOUND1039',
  ]);
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

Deno.test('red-team: analyzeProject rejects wrapped Promise.resolve thenable interop surfaces', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          allowImportingTsExtensions: true,
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
    'src/foreign.ts': [
      'export interface ForeignThenable<T> {',
      '  then(onfulfilled: (value: T) => unknown): unknown;',
      '}',
      '',
      'export declare const foreignThenable: ForeignThenable<number>;',
      '',
    ].join('\n'),
    'src/index.sts': [
      '// #[interop]',
      'import { foreignThenable } from "./foreign.ts";',
      '',
      'const direct = Promise.resolve(foreignThenable);',
      'const viaCall = Promise.resolve.call(Promise, foreignThenable);',
      'const viaApply = Promise.resolve.apply(Promise, [foreignThenable]);',
      '',
      'void direct;',
      'void viaCall;',
      'void viaApply;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  const promiseResolveThenableDiagnostics = result.diagnostics.filter((diagnostic) =>
    diagnostic.code === 'SOUND1034' &&
    diagnostic.metadata?.evidence?.some((fact) =>
      fact.label === 'surfaceKind' && fact.value === 'promise resolve thenable'
    )
  );
  assertEquals(
    promiseResolveThenableDiagnostics.map((diagnostic) => diagnostic.line),
    [4, 5, 6],
  );
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

Deno.test('analyzeProject loads the bundled node extern pack on node-family targets', async () => {
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
      '// #[interop]',
      'import { Buffer as ModuleBuffer } from "node:buffer";',
      '// #[interop]',
      'import { createHash, createHmac, randomInt, randomUUID } from "node:crypto";',
      '// #[interop]',
      'import { readFile } from "node:fs/promises";',
      '// #[interop]',
      'import { join } from "node:path";',
      '// #[interop]',
      'import { setTimeout as scheduleTimeout } from "node:timers";',
      '// #[interop]',
      'import { scheduler, setTimeout as waitTimeout } from "node:timers/promises";',
      '// #[interop]',
      'import process from "node:process";',
      '',
      'const cwd = process.cwd();',
      'const path = join(cwd, "notes.txt");',
      'const bytes = readFile(path);',
      'const buffer = ModuleBuffer.from("ok");',
      'const digest = createHash("sha256").update("ok").digest("hex");',
      'const mac = createHmac("sha256", "key").update("ok").digest("hex");',
      'const id = randomUUID();',
      'const n = randomInt(10);',
      'const timer = scheduleTimeout(() => {}, 10);',
      'const timeout = waitTimeout(10);',
      'const tick = scheduler.yield();',
      '',
      'void bytes;',
      'void buffer;',
      'void digest;',
      'void mac;',
      'void id;',
      'void n;',
      'void timer;',
      'void timeout;',
      'void tick;',
      '',
    ].join('\n'),
  });

  const jsNodeResult = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });
  const jsBrowserResult = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  assertEquals(jsNodeResult.diagnostics, []);
  assertEquals(jsBrowserResult.diagnostics.map((diagnostic) => diagnostic.code), [
    'TS2307',
    'TS2307',
    'TS2307',
    'TS2307',
    'TS2307',
    'TS2307',
    'TS2307',
    'SOUND1042',
    'SOUND1042',
    'SOUND1042',
    'SOUND1042',
    'SOUND1042',
    'SOUND1042',
    'SOUND1042',
  ]);
});
Deno.test('analyzeProject tracks bundled deno extern builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts', '__soundscript_externs__/**/*.d.ts'],
      },
      null,
      2,
    ),
    '__soundscript_externs__/deno.global.d.ts': [
      'declare namespace Deno {',
      '  const env: {',
      '    // #[effects(add: [host.system, host.deno.env, mut])]',
      '    delete(key: string): void;',
      '    // #[effects(add: [host.system, host.deno.env])]',
      '    get(key: string): string | undefined;',
      '    // #[effects(add: [host.system, host.deno.env])]',
      '    has(key: string): boolean;',
      '    // #[effects(add: [host.system, host.deno.env, mut])]',
      '    set(key: string, value: string): void;',
      '    // #[effects(add: [host.system, host.deno.env])]',
      '    toObject(): Record<string, string>;',
      '  };',
      '',
      '  // #[effects(add: [host.system, host.deno.process, mut, fails.throws])]',
      '  function chdir(path: string | URL): void;',
      '  // #[effects(add: [host.system, host.deno.process])]',
      '  function cwd(): string;',
      '  // #[effects(add: [host.io, host.deno.fs, suspend.await])]',
      '  function readFile(path: string | URL): Promise<Uint8Array<ArrayBufferLike>>;',
      '  // #[effects(add: [host.io, host.deno.fs, fails.throws])]',
      '  function readFileSync(path: string | URL): Uint8Array<ArrayBufferLike>;',
      '  // #[effects(add: [host.io, host.deno.fs, suspend.await])]',
      '  function readTextFile(path: string | URL): Promise<string>;',
      '  // #[effects(add: [host.io, host.deno.fs, fails.throws])]',
      '  function readTextFileSync(path: string | URL): string;',
      '  // #[effects(add: [host.io, host.deno.fs, mut, suspend.await])]',
      '  function mkdir(path: string | URL): Promise<void>;',
      '  // #[effects(add: [host.io, host.deno.fs, mut, fails.throws])]',
      '  function mkdirSync(path: string | URL): void;',
      '  // #[effects(add: [host.io, host.deno.fs, mut, suspend.await])]',
      '  function remove(path: string | URL): Promise<void>;',
      '  // #[effects(add: [host.io, host.deno.fs, mut, fails.throws])]',
      '  function removeSync(path: string | URL): void;',
      '  // #[effects(add: [host.io, host.deno.fs, mut, suspend.await])]',
      '  function writeTextFile(path: string | URL, data: string): Promise<void>;',
      '  // #[effects(add: [host.io, host.deno.fs, mut, fails.throws])]',
      '  function writeTextFileSync(path: string | URL, data: string): void;',
      '}',
      '',
    ].join('\n'),
    'src/index.sts': [
      '// #[interop]',
      "import { Deno as runtimeDeno } from 'extern:globalThis';",
      '',
      '// #[effects(forbid: [host])]',
      'function readCurrentDirectory(): string {',
      '  return runtimeDeno.cwd();',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function readEnvValue(): string | undefined {',
      '  return runtimeDeno.env.get("HOME");',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function setEnvValue(value: string): void {',
      '  runtimeDeno.env.set("HOME", value);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function deleteEnvValue(): void {',
      '  runtimeDeno.env.delete("HOME");',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function readBinary(path: string): Promise<Uint8Array<ArrayBufferLike>> {',
      '  return runtimeDeno.readFile(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function readBinarySync(path: string): Uint8Array<ArrayBufferLike> {',
      '  return runtimeDeno.readFileSync(path);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function readText(path: string): Promise<string> {',
      '  return runtimeDeno.readTextFile(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function readTextSync(path: string): string {',
      '  return runtimeDeno.readTextFileSync(path);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function makeDirectory(path: string): Promise<void> {',
      '  return runtimeDeno.mkdir(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function makeDirectorySync(path: string): void {',
      '  runtimeDeno.mkdirSync(path);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function removePath(path: string): Promise<void> {',
      '  return runtimeDeno.remove(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function removePathSync(path: string): void {',
      '  runtimeDeno.removeSync(path);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function writeText(path: string, data: string): Promise<void> {',
      '  return runtimeDeno.writeTextFile(path, data);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function writeTextSync(path: string, data: string): void {',
      '  runtimeDeno.writeTextFileSync(path, data);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function changeDirectory(path: string): void {',
      '  runtimeDeno.chdir(path);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });

  const expectedDenoSymbols = [
    'readCurrentDirectory',
    'readEnvValue',
    'setEnvValue',
    'deleteEnvValue',
    'readBinary',
    'readBinarySync',
    'readText',
    'readTextSync',
    'makeDirectory',
    'makeDirectorySync',
    'removePath',
    'removePathSync',
    'writeText',
    'writeTextSync',
    'changeDirectory',
  ];
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    new Array(expectedDenoSymbols.length).fill('SOUND1041'),
  );
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol),
    expectedDenoSymbols,
  );
});

Deno.test('analyzeProject tracks bundled node builtins under effect contracts', async () => {
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
      '// #[interop]',
      'import { Buffer, Buffer as ModuleBuffer } from "node:buffer";',
      '// #[interop]',
      'import { createHash, createHmac, getRandomValues, randomBytes, randomFill, randomFillSync, randomInt, randomUUID } from "node:crypto";',
      '// #[interop]',
      'import { access, appendFile, cp, copyFile, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";',
      '// #[interop]',
      'import { accessSync, appendFileSync, cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";',
      '// #[interop]',
      'import { dirname, join } from "node:path";',
      '// #[interop]',
      'import { clearImmediate as clearModuleImmediate, clearInterval, clearTimeout, setImmediate as setModuleImmediate, setInterval, setTimeout } from "node:timers";',
      '// #[interop]',
      'import { scheduler, setImmediate as waitImmediate, setTimeout as waitTimeout } from "node:timers/promises";',
      '// #[interop]',
      'import process from "node:process";',
      '',
      '// #[effects(forbid: [host])]',
      'function readCurrentDirectory(): string {',
      '  return process.cwd();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function changeDirectory(path: string): void {',
      '  process.chdir(path);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function exitProcess(code: number): never {',
      '  return process.exit(code);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function scheduleImmediate(callback: () => void): NodeJS.Immediate {',
      '  return setModuleImmediate(callback);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function cancelImmediate(handle: NodeJS.Immediate): void {',
      '  clearModuleImmediate(handle);',
      '}',
      '',
      '// #[effects(forbid: [host, fails, mut, suspend])]',
      'function makeBuffer(value: string): Buffer {',
      '  return Buffer.from(value);',
      '}',
      '',
      '// #[effects(forbid: [host, fails, mut, suspend])]',
      'function makeModuleBuffer(value: string): Buffer {',
      '  return ModuleBuffer.from(value);',
      '}',
      '',
      '// #[effects(forbid: [host, fails, mut, suspend])]',
      'function joinPath(left: string, right: string): string {',
      '  return join(dirname(left), right);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function makeUuid(): string {',
      '  return randomUUID();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function makeHasher() {',
      '  return createHash("sha256");',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function makeHmac() {',
      '  return createHmac("sha256", "key");',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function makeRandomInt(max: number): number {',
      '  return randomInt(max);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function makeRandomBytes(size: number): Buffer {',
      '  return randomBytes(size);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function fillRandom(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {',
      '  return getRandomValues(bytes);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function fillRandomSync(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {',
      '  return randomFillSync(bytes);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function hashText(value: string): Buffer {',
      '  const hash = createHash("sha256");',
      '  hash.update(value);',
      '  return hash.digest();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function hashTextHex(value: string): string {',
      '  const hash = createHash("sha256");',
      '  hash.update(value);',
      '  return hash.digest("hex");',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function hmacText(value: string): Buffer {',
      '  const hmac = createHmac("sha256", "key");',
      '  hmac.update(value);',
      '  return hmac.digest();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function hmacTextHex(value: string): string {',
      '  const hmac = createHmac("sha256", "key");',
      '  hmac.update(value);',
      '  return hmac.digest("hex");',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function scheduleTimeout(callback: () => void): NodeJS.Timeout {',
      '  return setTimeout(callback, 10);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function cancelTimeout(handle: NodeJS.Timeout): void {',
      '  clearTimeout(handle);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function scheduleInterval(callback: () => void): NodeJS.Timeout {',
      '  return setInterval(callback, 10);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function cancelInterval(handle: NodeJS.Timeout): void {',
      '  clearInterval(handle);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function awaitImmediate(): Promise<void> {',
      '  return waitImmediate();',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function awaitTimeout(): Promise<void> {',
      '  return waitTimeout(10);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function waitOnScheduler(): Promise<void> {',
      '  return scheduler.wait(10);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function yieldOnScheduler(): Promise<void> {',
      '  return scheduler.yield();',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function accessPath(path: string): Promise<void> {',
      '  return access(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function accessPathSync(path: string): void {',
      '  accessSync(path);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function statPath(path: string) {',
      '  return stat(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function statPathSync(path: string) {',
      '  return statSync(path);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function renamePath(from: string, to: string): Promise<void> {',
      '  return rename(from, to);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function renamePathSync(from: string, to: string): void {',
      '  renameSync(from, to);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function copyPath(from: string, to: string): Promise<void> {',
      '  return copyFile(from, to);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function copyPathSync(from: string, to: string): void {',
      '  copyFileSync(from, to);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function readLinkTarget(path: string): Promise<string> {',
      '  return readlink(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function readLinkTargetSync(path: string): string {',
      '  return readlinkSync(path);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function resolveRealPath(path: string): Promise<string> {',
      '  return realpath(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function resolveRealPathSync(path: string): string {',
      '  return realpathSync(path);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function createSymlink(target: string, path: string): Promise<void> {',
      '  return symlink(target, path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function createSymlinkSync(target: string, path: string): void {',
      '  symlinkSync(target, path);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function unlinkPath(path: string): Promise<void> {',
      '  return unlink(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function unlinkPathSync(path: string): void {',
      '  unlinkSync(path);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function makeTempDirectory(prefix: string): Promise<string> {',
      '  return mkdtemp(prefix);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function makeTempDirectorySync(prefix: string): string {',
      '  return mkdtempSync(prefix);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function copyTree(from: string, to: string): Promise<void> {',
      '  return cp(from, to);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function copyTreeSync(from: string, to: string): void {',
      '  cpSync(from, to);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function truncatePath(path: string): Promise<void> {',
      '  return truncate(path, 0);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function truncatePathSync(path: string): void {',
      '  truncateSync(path, 0);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function appendBinary(path: string, data: Uint8Array<ArrayBuffer>): Promise<void> {',
      '  return appendFile(path, data);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function appendBinarySync(path: string, data: Uint8Array<ArrayBuffer>): void {',
      '  appendFileSync(path, data);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function readBinary(path: string): Promise<Uint8Array<ArrayBufferLike>> {',
      '  return readFile(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function readBinarySync(path: string): Uint8Array<ArrayBufferLike> {',
      '  return readFileSync(path);',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function readDirectory(path: string): Promise<string[]> {',
      '  return readdir(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function readDirectorySync(path: string): string[] {',
      '  return readdirSync(path);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function writeBinary(path: string, data: Uint8Array<ArrayBuffer>): Promise<void> {',
      '  return writeFile(path, data);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function writeBinarySync(path: string, data: Uint8Array<ArrayBuffer>): void {',
      '  writeFileSync(path, data);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function makeDirectory(path: string): Promise<void> {',
      '  return mkdir(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function makeDirectorySync(path: string): void {',
      '  mkdirSync(path);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function removePath(path: string): Promise<void> {',
      '  return rm(path);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function removePathSync(path: string): void {',
      '  rmSync(path);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });

  const expectedNodeSymbols = [
    'readCurrentDirectory',
    'changeDirectory',
    'exitProcess',
    'scheduleImmediate',
    'cancelImmediate',
    'makeBuffer',
    'makeModuleBuffer',
    'joinPath',
    'makeUuid',
    'makeHasher',
    'makeHmac',
    'makeRandomInt',
    'makeRandomBytes',
    'fillRandom',
    'fillRandomSync',
    'hashText',
    'hashTextHex',
    'hmacText',
    'hmacTextHex',
    'scheduleTimeout',
    'cancelTimeout',
    'scheduleInterval',
    'cancelInterval',
    'awaitImmediate',
    'awaitTimeout',
    'waitOnScheduler',
    'yieldOnScheduler',
    'accessPath',
    'accessPathSync',
    'statPath',
    'statPathSync',
    'renamePath',
    'renamePathSync',
    'copyPath',
    'copyPathSync',
    'readLinkTarget',
    'readLinkTargetSync',
    'resolveRealPath',
    'resolveRealPathSync',
    'createSymlink',
    'createSymlinkSync',
    'unlinkPath',
    'unlinkPathSync',
    'makeTempDirectory',
    'makeTempDirectorySync',
    'copyTree',
    'copyTreeSync',
    'truncatePath',
    'truncatePathSync',
    'appendBinary',
    'appendBinarySync',
    'readBinary',
    'readBinarySync',
    'readDirectory',
    'readDirectorySync',
    'writeBinary',
    'writeBinarySync',
    'makeDirectory',
    'makeDirectorySync',
    'removePath',
    'removePathSync',
  ];
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    new Array(expectedNodeSymbols.length).fill('SOUND1041'),
  );
  assertEquals(
    result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol),
    expectedNodeSymbols,
  );
});

Deno.test('analyzeProject exposes explicit raw web globals on js-browser', async () => {
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
      "import { document, window } from 'web:dom';",
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

Deno.test('analyzeProject rejects web:dom imports when DOM libs are unavailable', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      "import { document } from 'web:dom';",
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

Deno.test('analyzeProject rejects legacy host shims with migration guidance', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2024', 'DOM'],
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
      "import { document } from 'host:dom';",
      '// #[interop]',
      "import { process } from 'host:node';",
      '',
      'void document;',
      'void process;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  const capabilityDiagnostics = result.diagnostics.filter((diagnostic) =>
    diagnostic.code === 'SOUND1042'
  );
  assertEquals(capabilityDiagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'host:dom',
    'host:node',
  ]);
  assertEquals(capabilityDiagnostics.map((diagnostic) => diagnostic.hint), [
    'Use `web:dom` for raw DOM globals behind `// #[interop]`.',
    'Use ordinary `node:*` builtin imports behind `// #[interop]`.',
  ]);
});

Deno.test('analyzeProject gates raw web and node imports by runtime target', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2024', 'DOM'],
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
    'src/web-on-node.sts': [
      '// #[interop]',
      "import { document } from 'web:dom';",
      '',
      'void document;',
      '',
    ].join('\n'),
    'src/node-on-browser.sts': [
      '// #[interop]',
      "import process from 'node:process';",
      '',
      'void process;',
      '',
    ].join('\n'),
  });

  const webOnNode = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });
  const nodeOnBrowser = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  assertEquals(
    webOnNode.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1042').map((
      diagnostic,
    ) => diagnostic.metadata?.primarySymbol),
    ['web:dom'],
  );
  assertEquals(
    nodeOnBrowser.diagnostics.filter((diagnostic) => diagnostic.code === 'SOUND1042').map((
      diagnostic,
    ) => diagnostic.metadata?.primarySymbol),
    ['node:process'],
  );
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

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1039',
      'SOUND1039',
    ]);
  },
);

Deno.test('analyzeProject resolves explicit node:* imports when compilerOptions.types requests node', async () => {
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
      "import process from 'node:process';",
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

Deno.test('analyzeProject requires interop on raw host type-only imports', async () => {
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
      "import type { Buffer } from 'node:buffer';",
      '',
      'type Bytes = Buffer;',
      'const size: number = 1;',
      'void size;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1005']);
});

Deno.test('analyzeProject rejects node:* imports when compilerOptions.types omits node', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          types: [],
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      '// #[interop]',
      "import process from 'node:process';",
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

Deno.test('analyzeProject accepts extern:globalThis imports backed by ambient declarations', async () => {
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
    'src/app-globals.d.ts': [
      'interface AppConfig {',
      '  apiBase: string;',
      '  buildId: string;',
      '}',
      '',
      'declare var __APP_CONFIG__: AppConfig;',
      'declare const APP_LEXICAL: { readonly id: string };',
      'declare namespace Deno {',
      '  interface Runtime {',
      '    cwd(): string;',
      '  }',
      '  export function cwd(): string;',
      '}',
      '',
    ].join('\n'),
    'src/index.sts': [
      '// #[interop]',
      "import { __APP_CONFIG__ as config, Deno } from 'extern:globalThis';",
      '// #[interop]',
      "import { APP_LEXICAL as lexicalConfig } from 'extern:global';",
      '',
      'const apiBase: string = config.apiBase;',
      'const lexicalId: string = lexicalConfig.id;',
      'const denoCwd = Deno.cwd();',
      'void apiBase;',
      'void lexicalId;',
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

Deno.test('analyzeProject rejects extern imports without interop and missing ambient values', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts', 'src/**/*.d.ts'],
      },
      null,
      2,
    ),
    'src/app-globals.d.ts': [
      'declare var __APP_CONFIG__: { apiBase: string };',
      '',
    ].join('\n'),
    'src/index.sts': [
      "import { __APP_CONFIG__ as config, __MISSING__ as missing } from 'extern:globalThis';",
      '',
      'void config;',
      'void missing;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1005',
    'SOUND1043',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.rule), [
    'extern_import_requires_interop',
    'extern_import_missing_ambient',
  ]);
});

Deno.test('analyzeProject rejects unsupported extern import and re-export forms', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts', 'src/**/*.d.ts'],
      },
      null,
      2,
    ),
    'src/app-globals.d.ts': [
      'declare var __APP_CONFIG__: { apiBase: string };',
      '',
    ].join('\n'),
    'src/default.sts': [
      '// #[interop]',
      "import config from 'extern:globalThis';",
      'void config;',
      '',
    ].join('\n'),
    'src/namespace.sts': [
      '// #[interop]',
      "import * as app from 'extern:globalThis';",
      'void app;',
      '',
    ].join('\n'),
    'src/reexport.sts': [
      "export { __APP_CONFIG__ } from 'extern:globalThis';",
      '',
    ].join('\n'),
    'src/string-name-global.sts': [
      '// #[interop]',
      'import { "app-config" as config } from \'extern:global\';',
      'void config;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  const externDiagnostics = result.diagnostics.filter((diagnostic) =>
    diagnostic.code === 'SOUND1043'
  );
  assertEquals(externDiagnostics.map((diagnostic) => diagnostic.metadata?.rule), [
    'extern_import_named_only',
    'extern_import_named_only',
    'extern_import_reexport_forbidden',
    'extern_import_global_identifier_only',
  ]);
});

Deno.test('analyzeProject rejects retired #[extern] and same-file ambient runtime declarations', async () => {
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
      'declare const config: { apiBase: string };',
      '',
      'void config;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1007',
    'SOUND1029',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.rule), [
    'extern_annotation_removed',
    'ambient_runtime_requires_import_boundary',
  ]);
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
      'import { fromBytes, readAllBytes } from "sts:streams";',
      'import { TextEncoder, TextDecoder } from "sts:text";',
      'import { randomBytes } from "sts:random";',
      '',
      'const url = new URL("/x", "https://example.com");',
      'const params = new URLSearchParams({ q: "music" });',
      'const request = new Request(url, { headers: new Headers() });',
      'const responsePromise = fetch(request);',
      'const encoder = new TextEncoder();',
      'const decoder = new TextDecoder();',
      'const bytes = encoder.encode(url.href);',
      'const stream = fromBytes(bytes);',
      'const streamBytes = readAllBytes(stream);',
      'const text = decoder.decode(bytes);',
      'const random = randomBytes(1);',
      '',
      'void params;',
      'void responsePromise;',
      'void streamBytes;',
      'void random;',
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

Deno.test('analyzeProject rejects removed sts:async imports with migration guidance', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/index.sts': [
      "import { succeed } from 'sts:async';",
      '',
      'void succeed;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-node',
    workingDirectory: tempDirectory,
  });

  const capabilityDiagnostics = result.diagnostics.filter((diagnostic) =>
    diagnostic.code === 'SOUND1042'
  );
  assertEquals(capabilityDiagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'sts:async',
  ]);
  assertEquals(
    capabilityDiagnostics[0]?.hint,
    'Use `sts:concurrency/task` for portable task helpers.',
  );
});

Deno.test('analyzeProject accepts browser-supported portable stdlib modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      "import { Task } from 'sts:concurrency/task';",
      "import { hasCapability } from 'sts:capabilities';",
      "import { log } from 'sts:console';",
      "import { Duration, sleep } from 'sts:time';",
      "import { join } from 'sts:path';",
      "import { Bytes } from 'sts:bytes';",
      '',
      'const task = Task.map(Task.succeed(1), (value: number) => value + 1);',
      'const path = join("assets", "app.js");',
      'const bytes = Bytes.fromString(path);',
      'const ready = hasCapability("fetch");',
      'log(path, bytes, ready);',
      'void sleep(Duration.milliseconds(1));',
      'void task;',
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

Deno.test('analyzeProject gates js-node-only concurrency runtime modules on js-browser', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      "import { TaskGroup } from 'sts:concurrency/runtime';",
      '',
      'void TaskGroup;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  const capabilityDiagnostics = result.diagnostics.filter((diagnostic) =>
    diagnostic.code === 'SOUND1042'
  );
  assertEquals(capabilityDiagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'sts:concurrency/runtime',
  ]);
});

Deno.test('analyzeProject resolves js-node provider stdlib modules on js-node', async () => {
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
      "import { readTextFile } from 'sts:fs';",
      "import { required } from 'sts:env';",
      "import { args } from 'sts:cli';",
      "import { info, output, spawn } from 'sts:process';",
      "import { output as commandOutput, spawn as commandSpawn } from 'sts:process/command';",
      "import { onSignal as onProcessSignal } from 'sts:process/signals';",
      "import { listen as listenHttp, server } from 'sts:http';",
      "import { connect, connectTls, listen, listenTls, lookupHost } from 'sts:net';",
      "import { lookupHost as lookupHostDns } from 'sts:net/dns';",
      "import { connect as connectTcp, listen as listenTcp } from 'sts:net/tcp';",
      "import { connectTls as connectTlsSocket, listenTls as listenTlsSocket } from 'sts:net/tls';",
      '',
      'void readTextFile;',
      'void required;',
      'void args;',
      'void info;',
      'void output;',
      'void spawn;',
      'void commandOutput;',
      'void commandSpawn;',
      'void onProcessSignal;',
      'void server;',
      'void listenHttp;',
      'void connect;',
      'void connectTls;',
      'void listen;',
      'void listenTls;',
      'void lookupHost;',
      'void lookupHostDns;',
      'void connectTcp;',
      'void listenTcp;',
      'void connectTlsSocket;',
      'void listenTlsSocket;',
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

Deno.test('analyzeProject resolves web portable stdlib modules on js-browser', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      "import { request } from 'sts:fetch';",
      "import { readAllBytes } from 'sts:streams';",
      "import { encodeUtf8 } from 'sts:text';",
      "import { randomBytes } from 'sts:random';",
      "import { digest } from 'sts:crypto/digest';",
      "import { hmac } from 'sts:crypto/hmac';",
      '',
      'void request;',
      'void readAllBytes;',
      'void encodeUtf8;',
      'void randomBytes;',
      'void digest;',
      'void hmac;',
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

Deno.test('analyzeProject gates js-node provider modules on js-browser', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      "import { readTextFile } from 'sts:fs';",
      "import { output } from 'sts:process/command';",
      "import { connect } from 'sts:net/tcp';",
      '',
      'void readTextFile;',
      'void output;',
      'void connect;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    target: 'js-browser',
    workingDirectory: tempDirectory,
  });

  const capabilityDiagnostics = result.diagnostics.filter((diagnostic) =>
    diagnostic.code === 'SOUND1042'
  );
  assertEquals(capabilityDiagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'sts:fs',
    'sts:process/command',
    'sts:net/tcp',
  ]);
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
      "import { parseJson, type JsonValue } from 'sts:json';",
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

Deno.test('analyzeProject resolves stdlib v3 hash decode codec and concurrency modules through the analysis pipeline', async () => {
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
      "import { Task } from 'sts:concurrency/task';",
      "import * as codec from 'sts:codec';",
      "import * as decode from 'sts:decode';",
      "import * as hash from 'sts:hash';",
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
      'const baseTask = Task.fromPromise(async () => "user");',
      'const derivedTask = Task.map(baseTask, (value: string) => value.length + encodedText.length + hashCode);',
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
      'const maybeUnknown: unknown = { ok: true };',
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
      'const callableWithToJson: CallableWithToJson = Object.assign(() => 1, {',
      '  toJSON(_key?: string): string {',
      '    return "ok";',
      '  },',
      '});',
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
      'const nullableKeys: readonly (string | number)[] | null = null;',
      'const optionalKeys: readonly (string | number)[] | undefined = undefined;',
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
      'const tuple: readonly ["x"] = ["x"];',
      'const withOptional: { ok?: true } = { ok: true };',
      'const withUndefined: { ok: true | undefined } = { ok: undefined };',
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
      'const id: Opaque<string, "UserId"> = "user";',
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
      'const value: unknown = ["a"];',
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
      'const promiseLike: Promise<number> = Promise.resolve(1);',
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
      'const value: Value = { message: "boom" };',
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

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1007']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'extern_annotation_removed');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '#[extern]');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'extern_import_boundary');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    [
      'annotationName:extern',
      'registeredBuiltins:effects, interop, newtype, unsafe, value, variance',
    ],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'A same-file extern declaration gives the identifier a local declaration while its ambient type source stays implicit.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    [
      '// #[interop]',
      "import { __APP_CONFIG__ as config } from 'extern:globalThis';",
    ].join('\n'),
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`#[extern]` has been removed; use a reserved `extern:*` import or an ordinary `#[interop]` host import instead.',
    'Registered builtin annotations in v1 are `#[effects(...)]`, `#[interop]`, `#[newtype]`, `#[unsafe]`, `#[value]`, and `#[variance(...)]`.',
    [
      'Example: // #[interop]',
      "import { __APP_CONFIG__ as config } from 'extern:globalThis';",
    ].join('\n'),
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Replace same-file `#[extern] declare ...` with `// #[interop]` and an `extern:globalThis` or `extern:global` import.',
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
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'ambient_runtime_requires_import_boundary');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'envName');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'extern_import_boundary');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['declarationKind:const declaration', 'declarationName:envName'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'A same-file ambient declaration gives the identifier a local declaration while the host value still comes from outside checked soundscript.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    [
      '// #[interop]',
      "import { __APP_CONFIG__ as config } from 'extern:globalThis';",
    ].join('\n'),
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'This local ambient runtime declaration introduces `envName` without an explicit import boundary.',
    [
      'Example: // #[interop]',
      "import { __APP_CONFIG__ as config } from 'extern:globalThis';",
    ].join('\n'),
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Move the ambient declaration to `.d.ts` and import the value through `extern:*`, or replace it with a real implementation.',
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
    "Move the declaration to '.d.ts' and expose values through explicit imports, or replace it with a real implementation.",
  );
  assertEquals(result.diagnostics[0]?.notes, [
    'This ambient runtime declaration exports `envName` from a soundscript module even though there is no local implementation.',
    "Example: Move the declaration to '.d.ts' and expose values through explicit imports, or replace it with a real implementation.",
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    "Move exported declaration-only surfaces to '.d.ts' or provide a real implementation.",
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
      '// #[unsafe(answer: 1)]',
      'const envName = 1;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1028']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'annotation_arguments_not_supported');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '#[unsafe]');
  assertEquals(
    result.diagnostics[0]?.metadata?.replacementFamily,
    'supported_annotation_arguments',
  );
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['annotationName:unsafe', 'argumentsText:(answer: 1)', 'supportedForm:bare form only'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Unsupported annotation arguments can look like checked configuration even though v1 does not define any semantics for them.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Remove the arguments from `#[unsafe(answer: 1)]`.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`#[unsafe]` does not accept arguments in v1; this annotation uses `(answer: 1)`.',
    'Example: Remove the arguments from `#[unsafe(answer: 1)]`.',
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

Deno.test('analyzeProject rejects triple-slash lib reference directives', async () => {
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
      '/// <reference lib="dom" />',
      'const value = 1;',
      'void value;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1023']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'typescript_directive_banned');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '/// <reference lib="dom" />');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['directiveText:/// <reference lib="dom" />'],
  );
});

Deno.test('analyzeProject keeps triple-slash directive diagnostics alongside TypeScript errors', async () => {
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
      '/// <reference lib="dom" />',
      'const value: number = "bad";',
      'void value;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assert(result.diagnostics.some((diagnostic) => diagnostic.code === 'TS2322'));
  assert(result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1023'));
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
        'function readRecord(): Record<string, string> | undefined {',
        '  return undefined;',
        '}',
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
        'function readMetadata(): Record<string, LocalJsonValue> | undefined {',
        '  return undefined;',
        '}',
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

Deno.test('analyzeProject rejects unknown annotation namespaces and preserves nested member annotations', async () => {
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
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '#[eq]');
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
      '// #[unsafe]',
      '// #[unsafe]',
      'const envName = "dev";',
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
    'Duplicate soundscript annotation in the same annotation block. `#[unsafe]` appears more than once in the same block.',
  );
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'duplicate_annotation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, '#[unsafe]');
  assertEquals(result.diagnostics[0]?.metadata?.replacementFamily, 'single_annotation_per_block');
  assertEquals(result.diagnostics[0]?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.map((fact) => `${fact.label}:${fact.value}`),
    ['annotationName:unsafe', 'occurrenceCount:2'],
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.counterexample,
    'Duplicate entries make it ambiguous which single checked contract should govern the attached declaration.',
  );
  assertEquals(
    result.diagnostics[0]?.metadata?.example,
    'Keep one `#[unsafe]` entry in the block and remove the duplicate.',
  );
  assertEquals(result.diagnostics[0]?.notes, [
    '`#[unsafe]` appears 2 times in the same attached annotation block.',
    'Example: Keep one `#[unsafe]` entry in the block and remove the duplicate.',
  ]);
  assertEquals(
    result.diagnostics[0]?.hint,
    'Keep a single annotation entry for each name in the attached block.',
  );
});

Deno.test('analyzeProject accepts local forwarding annotations and callback parameter contracts', async () => {
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
      '// #[effects(forward: [callback])]',
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

Deno.test('analyzeProject rejects bodyful forbid contracts with unresolved forwarded callbacks', async () => {
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
      '// #[effects(forbid: [fails], forward: [callback])]',
      'function runOnce(callback: () => void): void {',
      '  callback();',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041']);
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'runOnce');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.find((entry) =>
      entry.label === 'unknownEffectReasons'
    )?.value,
    'unresolved forwarded callback (callback)',
  );
});

Deno.test('analyzeProject reports failing forwarded member steps in bodyful forbid diagnostics', async () => {
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
      'interface Decoder<T> {',
      '  readonly decode: (value: number) => T;',
      '}',
      '',
      'interface DecoderWithOptionalInner<T> extends Decoder<T> {',
      '  readonly inner?: Decoder<T>;',
      '}',
      '',
      '// #[effects(forbid: [fails], forward: [decoder.inner.decode])]',
      'function use(decoder: DecoderWithOptionalInner<number>, value: number): number {',
      '  return value;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041']);
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'use');
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.find((entry) =>
      entry.label === 'unknownEffectReasons'
    )?.value,
    'unresolved forwarded callback (decoder.inner.decode; failed at decode)',
  );
});

Deno.test('analyzeProject accepts open dotted effects and forward transforms', async () => {
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
      '// #[interop]',
      'import { resultOfLike, toPromise } from "./effects";',
      '',
      '// #[effects(forbid: [fails.throws])]',
      'function wrapThrowsAsRejects(): Promise<unknown> {',
      '  return toPromise(() => JSON.parse("1"));',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function captureFailures(text: string): unknown {',
      '  return resultOfLike(() => JSON.parse(text));',
      '}',
      '',
    ].join('\n'),
    'src/effects.d.ts': [
      '// #[effects(add: [suspend.await], forward: [{ from: callback, rewrite: [{ from: fails, to: fails.rejects }] }])]',
      'export declare function toPromise<T>(callback: () => T): Promise<T>;',
      '',
      '// #[effects(add: [], forward: [{ from: callback, handle: [fails] }])]',
      'export declare function resultOfLike<T>(callback: () => T): T | Error;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject allows bodyful add alongside inferred effects', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/index.sts': [
      '// #[effects(add: [host.io, host.node.fs, suspend.await])]',
      'function readRemote(path: string): Promise<string> {',
      '  return Promise.resolve(path);',
      '}',
      '',
      '// #[effects(add: [host.db.query])]',
      'export async function taggedRead(path: string): Promise<string> {',
      '  return await readRemote(path);',
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

Deno.test('analyzeProject keeps inferred conflicts under bodyful add contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/index.sts': [
      '// #[effects(add: [host.io, host.node.fs, suspend.await])]',
      'function readRemote(path: string): Promise<string> {',
      '  return Promise.resolve(path);',
      '}',
      '',
      '// #[effects(add: [host.db.query], forbid: [host.io])]',
      'export async function invalidTaggedRead(path: string): Promise<string> {',
      '  return await readRemote(path);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'effect_contract_violation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'invalidTaggedRead');
});

Deno.test('analyzeProject keeps source and declaration helper surfaces aligned under forbid contracts', async () => {
  const sourceProjectDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/helpers.sts': [
      'export interface Decoder<T> {',
      '  readonly decode: (value: unknown) => T;',
      '}',
      '',
      '// #[effects(add: [host.io, host.node.fs, suspend.await])]',
      'function readRemote(path: string): Promise<string> {',
      '  return Promise.resolve(path);',
      '}',
      '',
      'export function parseAndDecode<T>(text: string, decoder: Decoder<T>): T {',
      '  return decoder.decode(JSON.parse(text));',
      '}',
      '',
      '// #[effects(add: [host.db.transaction])]',
      'export async function transactionRead(path: string): Promise<string> {',
      '  return await readRemote(path);',
      '}',
      '',
      'const console = globalThis.console;',
      '',
      'export function logValue(value: unknown): void {',
      '  console.log(value);',
      '}',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import { type Decoder, logValue, parseAndDecode, transactionRead } from "./helpers";',
      '',
      'const failingDecoder: Decoder<number> = {',
      '  decode(_value: unknown): number {',
      '    throw new Error("boom");',
      '  },',
      '};',
      '',
      '// #[effects(forbid: [fails])]',
      'function useParse(text: string): number {',
      '  return parseAndDecode(text, failingDecoder);',
      '}',
      '',
      '// #[effects(forbid: [host.io])]',
      'async function useTransaction(path: string): Promise<string> {',
      '  return await transactionRead(path);',
      '}',
      '',
      '// #[effects(forbid: [host.ffi])]',
      'function useLog(value: unknown): void {',
      '  logValue(value);',
      '}',
      '',
    ].join('\n'),
  });
  const declarationProjectDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'node_modules/generated-helpers/package.json': JSON.stringify(
      {
        name: 'generated-helpers',
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './dist/index.js',
          },
        },
      },
      null,
      2,
    ),
    'node_modules/generated-helpers/dist/index.js': 'export {};\n',
    'node_modules/generated-helpers/dist/index.d.ts': [
      'export interface Decoder<T> {',
      '  readonly decode: (value: unknown) => T;',
      '}',
      '',
      '// #[effects(add: [fails.throws], forward: [decoder.decode], unknown: [direct])]',
      'export declare function parseAndDecode<T>(text: string, decoder: Decoder<T>): T;',
      '',
      '// #[effects(add: [host.db.transaction, host.io, host.node.fs, suspend.await])]',
      'export declare function transactionRead(path: string): Promise<string>;',
      '',
      '// #[effects(add: [host.ffi])]',
      'export declare function logValue(value: unknown): void;',
      '',
    ].join('\n'),
    'src/index.sts': [
      'import { type Decoder, logValue, parseAndDecode, transactionRead } from "generated-helpers";',
      '',
      'const failingDecoder: Decoder<number> = {',
      '  decode(_value: unknown): number {',
      '    throw new Error("boom");',
      '  },',
      '};',
      '',
      '// #[effects(forbid: [fails])]',
      'function useParse(text: string): number {',
      '  return parseAndDecode(text, failingDecoder);',
      '}',
      '',
      '// #[effects(forbid: [host.io])]',
      'async function useTransaction(path: string): Promise<string> {',
      '  return await transactionRead(path);',
      '}',
      '',
      '// #[effects(forbid: [host.ffi])]',
      'function useLog(value: unknown): void {',
      '  logValue(value);',
      '}',
      '',
    ].join('\n'),
  });

  const sourceResult = await analyzeProject({
    projectPath: join(sourceProjectDirectory, 'tsconfig.json'),
    workingDirectory: sourceProjectDirectory,
  });
  const declarationResult = await analyzeProject({
    projectPath: join(declarationProjectDirectory, 'tsconfig.json'),
    workingDirectory: declarationProjectDirectory,
  });

  const simplifyDiagnostics = (result: Awaited<ReturnType<typeof analyzeProject>>) =>
    result.diagnostics
      .filter((diagnostic) => diagnostic.code !== 'SOUND1005')
      .map((diagnostic) => ({
        code: diagnostic.code,
        forbiddenEffects: diagnostic.metadata?.evidence?.find((entry) =>
          entry.label === 'forbiddenEffects'
        )
          ?.value,
        primarySymbol: diagnostic.metadata?.primarySymbol,
        rule: diagnostic.metadata?.rule,
      }));

  assertEquals(simplifyDiagnostics(sourceResult), [
    {
      code: 'SOUND1041',
      forbiddenEffects: 'fails',
      primarySymbol: 'useParse',
      rule: 'effect_contract_violation',
    },
    {
      code: 'SOUND1041',
      forbiddenEffects: 'host.io',
      primarySymbol: 'useTransaction',
      rule: 'effect_contract_violation',
    },
    {
      code: 'SOUND1041',
      forbiddenEffects: 'host.ffi',
      primarySymbol: 'useLog',
      rule: 'effect_contract_violation',
    },
  ]);
  assertEquals(simplifyDiagnostics(declarationResult), simplifyDiagnostics(sourceResult));
});

Deno.test('analyzeProject rejects effects annotations on overload signatures with implementations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/index.sts': [
      '// #[effects(add: [host.io])]',
      'export function parse(input: string): string;',
      'export function parse(input: number): string;',
      '// #[effects(add: [host.io])]',
      'export function parse(input: string | number): string {',
      '  return String(input);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1040']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'invalid_effect_annotation');
});

Deno.test('analyzeProject rejects parameter effect annotations on overload signatures with implementations', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/index.sts': [
      'export function wrap(',
      '  // #[effects(forbid: [fails])]',
      '  callback: () => number,',
      '): number;',
      'export function wrap(callback: () => number, label: string): number;',
      '// #[effects(add: [])]',
      'export function wrap(callback: () => number, _label?: string): number {',
      '  return callback();',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1040']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'invalid_effect_annotation');
});

Deno.test('analyzeProject rejects deprecated via forwarding syntax', async () => {
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
      '// #[effects(add: [], via: [callback])]',
      'function wrap<T>(callback: () => T): T {',
      '  return callback();',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1040']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'invalid_effect_annotation');
});

Deno.test('analyzeProject discharges local failures handled by try catch', async () => {
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
      'function parseSafely(text: string): unknown {',
      '  try {',
      '    return JSON.parse(text);',
      '  } catch (_error) {',
      '    return null;',
      '  }',
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

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'effect_contract_violation');
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'explode');
});

Deno.test('analyzeProject accepts pure Promise continuations under forbid fails contracts', async () => {
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
      'function chain(source: Promise<number>): Promise<number> {',
      '  return source.then((value) => value + 1);',
      '}',
      '',
      'function forwardThen(',
      '  source: Promise<number>,',
      '  // #[effects(forbid: [fails])]',
      '  project: (value: number) => number,',
      '): Promise<number> {',
      '  return source.then(project);',
      '}',
      '',
      'const plusOne = (value: number): number => value + 1;',
      'void chain(Promise.resolve(1));',
      'void forwardThen(Promise.resolve(1), plusOne);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject accepts sts:concurrency/task task constructors under forbid contracts', async () => {
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
      "import { Task } from 'sts:concurrency/task';",
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function build(project: (value: number) => number): Task<number> {',
      '  const seed = Task.fromPromise(async () => 1);',
      '  return Task.map(seed, project);',
      '}',
      '',
      'const plusOne = (value: number): number => value + 1;',
      'void build(plusOne);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics, []);
});

Deno.test('analyzeProject accepts builtin collection readers and constructors under forbid contracts', async () => {
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
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function build(): number {',
      '  const map = new Map<string, number>();',
      '  const set = new Set<number>();',
      '  return (map.has("x") ? 1 : 0) + (set.has(1) ? 1 : 0);',
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

Deno.test('analyzeProject tracks builtin host and mut effects under forbid contracts', async () => {
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
      '// #[effects(forbid: [host])]',
      'function sample(): number {',
      '  return Math.random() + Date.now();',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function update(map: Map<string, number>, set: Set<number>): void {',
      '  map.set("x", 1);',
      '  set.add(1);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041', 'SOUND1041']);
  assertEquals(result.diagnostics[0]?.metadata?.primarySymbol, 'sample');
  assertEquals(result.diagnostics[1]?.metadata?.primarySymbol, 'update');
});

Deno.test('analyzeProject allows fresh local scratch mutation under forbid mut', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      'class Counter {',
      '  value = 0;',
      '  set(value: number): void {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildRecord(): { value: number } {',
      '  const box = { value: 0 };',
      '  box.value = 1;',
      '  return box;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildRecordAlias(): { value: number } {',
      '  const box = { value: 0 };',
      '  const out = box;',
      '  out.value = 1;',
      '  return out;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildList(): number[] {',
      '  const values = [0];',
      '  values[0] = 1;',
      '  return values;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildMap(): Map<string, number> {',
      '  const map = new Map<string, number>();',
      '  map.set("value", 1);',
      '  return map;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildMapAlias(): Map<string, number> {',
      '  const map = new Map<string, number>();',
      '  const out = map;',
      '  out.set("value", 1);',
      '  return out;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildSet(): Set<number> {',
      '  const values = new Set<number>();',
      '  values.add(1);',
      '  return values;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildSetAlias(): Set<number> {',
      '  const values = new Set<number>();',
      '  const out = values;',
      '  out.add(1);',
      '  return out;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildWeakMap(): WeakMap<object, number> {',
      '  const key = {};',
      '  const values = new WeakMap<object, number>();',
      '  values.set(key, 1);',
      '  return values;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildWeakMapAlias(): WeakMap<object, number> {',
      '  const key = {};',
      '  const values = new WeakMap<object, number>();',
      '  const out = values;',
      '  out.set(key, 1);',
      '  return out;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildWeakSet(): WeakSet<object> {',
      '  const key = {};',
      '  const values = new WeakSet<object>();',
      '  values.add(key);',
      '  return values;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildWeakSetAlias(): WeakSet<object> {',
      '  const key = {};',
      '  const values = new WeakSet<object>();',
      '  const out = values;',
      '  out.add(key);',
      '  return out;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildParams(): URLSearchParams {',
      '  const params = new window.URLSearchParams();',
      '  params.set("q", "music");',
      '  return params;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildParamsAlias(): URLSearchParams {',
      '  const params = new window.URLSearchParams();',
      '  const out = params;',
      '  out.set("q", "music");',
      '  return out;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildFormData(): FormData {',
      '  const data = new window.FormData();',
      '  data.append("q", "music");',
      '  return data;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildFormDataAlias(): FormData {',
      '  const data = new window.FormData();',
      '  const out = data;',
      '  out.append("q", "music");',
      '  return out;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildHeaders(): Headers {',
      '  const headers = new window.Headers();',
      '  headers.set("accept", "application/json");',
      '  return headers;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildHeadersAlias(): Headers {',
      '  const headers = new window.Headers();',
      '  const out = headers;',
      '  out.set("accept", "application/json");',
      '  return out;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildCustomCounter(): Counter {',
      '  const counter = new Counter();',
      '  counter.set(1);',
      '  return counter;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function escapeBeforeMutate(',
      '  // #[effects(forbid: [fails, suspend, mut, host])]',
      '  store: (value: { value: number }) => void,',
      '): { value: number } {',
      '  const box = { value: 0 };',
      '  store(box);',
      '  box.value = 1;',
      '  return box;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function escapeMapBeforeMutate(',
      '  // #[effects(forbid: [fails, suspend, mut, host])]',
      '  store: (value: Map<string, number>) => void,',
      '): Map<string, number> {',
      '  const map = new Map<string, number>();',
      '  store(map);',
      '  map.set("value", 1);',
      '  return map;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'buildCustomCounter',
    'escapeBeforeMutate',
    'escapeMapBeforeMutate',
  ]);
});

Deno.test('analyzeProject preserves narrowing across fresh local builder mutation', async () => {
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
      'function useMap(box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    const map = new Map<string, number>();',
      '    const out = map;',
      '    out.set("value", 1);',
      '    const value: string = box.value;',
      '    return value;',
      '  }',
      '  return "";',
      '}',
      '',
      'function useRecord(box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    const record = { count: 0 };',
      '    const out = record;',
      '    out.count = 1;',
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

Deno.test('analyzeProject reports fresh local conservative mut reasons in forbid diagnostics', async () => {
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
      'class Counter {',
      '  value = 0;',
      '  set(value: number): void {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function buildCustomCounter(): Counter {',
      '  const counter = new Counter();',
      '  counter.set(1);',
      '  return counter;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function escapeBeforeMutate(',
      '  // #[effects(forbid: [fails, suspend, mut, host])]',
      '  store: (value: { value: number }) => void,',
      '): { value: number } {',
      '  const box = { value: 0 };',
      '  store(box);',
      '  box.value = 1;',
      '  return box;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041', 'SOUND1041']);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'buildCustomCounter',
    'escapeBeforeMutate',
  ]);
  assertEquals(
    result.diagnostics[0]?.metadata?.evidence?.find((entry) =>
      entry.label === 'conservativeMutReasons'
    )
      ?.value,
    'unsupported mutator family (Counter.set)',
  );
  assertEquals(
    result.diagnostics[1]?.metadata?.evidence?.find((entry) =>
      entry.label === 'conservativeMutReasons'
    )
      ?.value,
    'escaped via argument',
  );
});

Deno.test('analyzeProject keeps fresh local mut suppression conservative for indirect or unstable builder paths', async () => {
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
      'let observed = 0;',
      '',
      'function mutateOuter(): void {',
      '  observed += 1;',
      '}',
      '',
      'class MyMap extends Map<string, number> {',
      '  override set(key: string, value: number): this {',
      '    mutateOuter();',
      '    return super.set(key, value);',
      '  }',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function storedRecordInContainer(): { value: number } {',
      '  const box = { value: 0 };',
      '  const holder = { box };',
      '  holder.box.value = 1;',
      '  return box;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function storedMapInArray(): Map<string, number> {',
      '  const map = new Map<string, number>();',
      '  const holders: [Map<string, number>] = [map];',
      '  holders[0].set("value", 1);',
      '  return map;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function capturedBeforeMutate(): { value: number } {',
      '  const box = { value: 0 };',
      '  const read = (): number => box.value;',
      '  void read;',
      '  box.value = 1;',
      '  return box;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function unstableAliasBeforeMutate(): { value: number } {',
      '  const box = { value: 0 };',
      '  let alias = box;',
      '  alias = { value: 1 };',
      '  box.value = 1;',
      '  return box;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function subclassedMapAsBase(): Map<string, number> {',
      '  const map: Map<string, number> = new MyMap();',
      '  map.set("value", 1);',
      '  return map;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function boundMapMethod(): Map<string, number> {',
      '  const map = new Map<string, number>();',
      '  const setValue = map.set.bind(map);',
      '  setValue("value", 1);',
      '  return map;',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'storedRecordInContainer',
    'storedMapInArray',
    'capturedBeforeMutate',
    'unstableAliasBeforeMutate',
    'subclassedMapAsBase',
    'boundMapMethod',
  ]);
});

Deno.test('analyzeProject tracks host-backed globals and stdlib wrappers under forbid contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      'import { fetch as stdFetch } from "sts:fetch";',
      'import { fillRandom } from "sts:random";',
      '',
      '// #[effects(forbid: [host, suspend])]',
      'function load() {',
      '  return window.fetch("https://example.com");',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function uuid(): string {',
      '  return window.crypto.randomUUID();',
      '}',
      '',
      '// #[effects(forbid: [host, mut])]',
      'function fill(bytes: Uint8Array): void {',
      '  fillRandom(bytes);',
      '}',
      '',
      '// #[effects(forbid: [host, suspend])]',
      'function loadStd() {',
      '  return stdFetch("https://example.com");',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'load',
    'uuid',
    'fill',
    'loadStd',
  ]);
});

Deno.test('analyzeProject treats deferred host schedulers as host effects without immediate callback forwarding', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      '// #[effects(forbid: [host])]',
      'function schedule(): void {',
      '  window.queueMicrotask(() => {});',
      '  window.setTimeout(() => {}, 0);',
      '  window.setInterval(() => {}, 10);',
      '  window.requestIdleCallback(() => {});',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function deferMutation(map: Map<string, number>): void {',
      '  window.setTimeout(() => {',
      '    map.set("x", 1);',
      '  }, 0);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function deferIdleMutation(map: Map<string, number>): void {',
      '  window.requestIdleCallback(() => {',
      '    map.set("x", 1);',
      '  });',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'schedule',
    'deferMutation',
    'deferIdleMutation',
  ]);
});

Deno.test('analyzeProject tracks fetch host-object families and stdlib wrappers under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      'import { Headers as FetchHeaders, Request as FetchRequest, Response as FetchResponse } from "sts:fetch";',
      'import { fillRandom as fillRandomStd } from "sts:random";',
      '',
      '// #[effects(forbid: [host])]',
      'function buildDomObjects(): void {',
      '  const headers = new window.Headers({ accept: "application/json" });',
      '  const request = new window.Request("https://example.com", { headers });',
      '  const response = new window.Response("ok");',
      '  void request;',
      '  void response;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function mutateDomHeaders(headers: Headers): void {',
      '  headers.set("x-id", "123");',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function readDomHeaders(headers: Headers): boolean {',
      '  return headers.has("x-id");',
      '}',
      '',
      '// #[effects(forbid: [host, suspend])]',
      'function readDomRequest(request: Request) {',
      '  return request.text();',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function buildStdObjects(): void {',
      '  const headers = new FetchHeaders({ accept: "application/json" });',
      '  const request = new FetchRequest("https://example.com", { headers });',
      '  const response = new FetchResponse("ok");',
      '  void request;',
      '  void response;',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function mutateStdHeaders(headers: FetchHeaders): void {',
      '  headers.set("x-id", "123");',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function readStdHeaders(headers: FetchHeaders): boolean {',
      '  return headers.has("x-id");',
      '}',
      '',
      '// #[effects(forbid: [host, suspend])]',
      'function readStdResponse(response: FetchResponse) {',
      '  return response.text();',
      '}',
      '',
      '// #[effects(forbid: [host, mut])]',
      'function fillViaRandom(bytes: Uint8Array): void {',
      '  fillRandomStd(bytes);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'buildDomObjects',
    'mutateDomHeaders',
    'readDomRequest',
    'buildStdObjects',
    'mutateStdHeaders',
    'readStdResponse',
    'fillViaRandom',
  ]);
});

Deno.test('analyzeProject tracks URL and text builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      'import { URL as StdURL, URLSearchParams as StdURLSearchParams } from "sts:url";',
      'import { TextEncoder as StdTextEncoder, TextDecoder as StdTextDecoder } from "sts:text";',
      '',
      '// #[effects(forbid: [fails])]',
      'function buildDomUrl(base: string): URL {',
      '  return new window.URL("/x", base);',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function canParseDomUrl(base: string): boolean {',
      '  return window.URL.canParse("/x", base);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function mutateDomParams(params: URLSearchParams): void {',
      '  params.set("q", "music");',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function readDomParams(params: URLSearchParams): boolean {',
      '  return params.has("q");',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function encodeDomText(input: string) {',
      '  return new window.TextEncoder().encode(input);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function decodeDomText(bytes: Uint8Array): string {',
      '  return new window.TextDecoder("utf-8").decode(bytes);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function buildStdUrl(base: string): StdURL {',
      '  return new StdURL("/x", base);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function mutateStdParams(params: StdURLSearchParams): void {',
      '  params.set("q", "music");',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function readStdParams(params: StdURLSearchParams): boolean {',
      '  return params.has("q");',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function encodeStdText(input: string) {',
      '  return new StdTextEncoder().encode(input);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function decodeStdText(bytes: Uint8Array): string {',
      '  return new StdTextDecoder("utf-8").decode(bytes);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'buildDomUrl',
    'mutateDomParams',
    'decodeDomText',
    'buildStdUrl',
    'mutateStdParams',
    'decodeStdText',
  ]);
});

Deno.test('analyzeProject tracks abort and cloning builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      '// #[effects(forbid: [host])]',
      'function buildController(): AbortController {',
      '  return new window.AbortController();',
      '}',
      '',
      '// #[effects(forbid: [host, mut])]',
      'function abortController(controller: AbortController): void {',
      '  controller.abort();',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function makeAbortedSignal(): AbortSignal {',
      '  return window.AbortSignal.abort("boom");',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function combineSignals(left: AbortSignal, right: AbortSignal): AbortSignal {',
      '  return window.AbortSignal.any([left, right]);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function timeoutSignal(): AbortSignal {',
      '  return window.AbortSignal.timeout(10);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function ensureNotAborted(signal: AbortSignal): void {',
      '  signal.throwIfAborted();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function cloneValue<T>(value: T): T {',
      '  return window.structuredClone(value);',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function parseUrl(value: string): URL | null {',
      '  return window.URL.parse(value);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'buildController',
    'abortController',
    'makeAbortedSignal',
    'combineSignals',
    'timeoutSignal',
    'ensureNotAborted',
    'cloneValue',
  ]);
});

Deno.test('analyzeProject tracks DOM listener and object URL builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      'let registered = 0;',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function buildBlob(): Blob {',
      '  return new window.Blob(["ok"]);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function registerAbortListener(signal: AbortSignal): void {',
      '  signal.addEventListener("abort", () => {',
      '    registered += 1;',
      '  });',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function unregisterAbortListener(signal: AbortSignal, listener: (event: Event) => void): void {',
      '  signal.removeEventListener("abort", listener);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function registerWindowListener(listener: (event: Event) => void): void {',
      '  window.addEventListener("message", listener);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function unregisterWindowListener(listener: (event: Event) => void): void {',
      '  window.removeEventListener("message", listener);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function createObjectUrl(blob: Blob): string {',
      '  return window.URL.createObjectURL(blob);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function revokeObjectUrl(url: string): void {',
      '  window.URL.revokeObjectURL(url);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'registerAbortListener',
    'unregisterAbortListener',
    'registerWindowListener',
    'unregisterWindowListener',
    'createObjectUrl',
    'revokeObjectUrl',
  ]);
});

Deno.test('analyzeProject tracks DOM mutation and dispatch builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { document, window } from "web:dom";',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function buildEvent(): Event {',
      '  return new window.Event("ping");',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function buildTarget(): EventTarget {',
      '  return new window.EventTarget();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function dispatchOnTarget(target: EventTarget): boolean {',
      '  return target.dispatchEvent(new window.Event("ping"));',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function createDomElement(): HTMLElement {',
      '  return document.createElement("div");',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function setDomAttribute(element: Element): void {',
      '  element.setAttribute("data-id", "1");',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function removeDomAttributeNs(element: Element): void {',
      '  element.removeAttributeNS(null, "data-id");',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function removeDomAttribute(element: Element): void {',
      '  element.removeAttribute("data-id");',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function appendDomChild(parent: Element, child: Element): Element {',
      '  return parent.appendChild(child);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function removeDomChild(parent: Element, child: Element): Element {',
      '  return parent.removeChild(child);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function insertDomChild(parent: Element, child: Element, nextChild: Element | null): Element {',
      '  return parent.insertBefore(child, nextChild);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function removeDomNode(child: Element): void {',
      '  child.remove();',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function replaceDomNode(child: Element, sibling: Element): void {',
      '  child.replaceWith("prefix", sibling);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'dispatchOnTarget',
    'createDomElement',
    'setDomAttribute',
    'removeDomAttributeNs',
    'removeDomAttribute',
    'appendDomChild',
    'removeDomChild',
    'insertDomChild',
    'removeDomNode',
    'replaceDomNode',
  ]);
});

Deno.test('analyzeProject tracks browser messaging builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      '// #[effects(forbid: [fails])]',
      'function sendWindowMessage(targetOrigin: string): void {',
      '  window.postMessage({ ok: true }, targetOrigin);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function openChannel(name: string): BroadcastChannel {',
      '  return new window.BroadcastChannel(name);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function sendChannelMessage(channel: BroadcastChannel): void {',
      '  channel.postMessage({ ok: true });',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function closeChannel(channel: BroadcastChannel): void {',
      '  channel.close();',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'sendWindowMessage',
    'openChannel',
    'sendChannelMessage',
    'closeChannel',
  ]);
});

Deno.test('analyzeProject tracks worker and socket builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      '// #[effects(forbid: [fails])]',
      'function openWorker(scriptUrl: string): Worker {',
      '  return new window.Worker(scriptUrl, { type: "module" });',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function postWorkerMessage(worker: Worker): void {',
      '  worker.postMessage({ ok: true });',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function terminateWorker(worker: Worker): void {',
      '  worker.terminate();',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function openMessageChannel(): MessageChannel {',
      '  return new window.MessageChannel();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function postPortMessage(port: MessagePort): void {',
      '  port.postMessage({ ok: true });',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function startPort(port: MessagePort): void {',
      '  port.start();',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function closePort(port: MessagePort): void {',
      '  port.close();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function openSocket(url: string): WebSocket {',
      '  return new window.WebSocket(url);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function sendSocketMessage(socket: WebSocket): void {',
      '  socket.send("ok");',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function closeSocket(socket: WebSocket): void {',
      '  socket.close();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function openEventStream(url: string): EventSource {',
      '  return new window.EventSource(url);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function closeEventStream(stream: EventSource): void {',
      '  stream.close();',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'openWorker',
    'postWorkerMessage',
    'terminateWorker',
    'openMessageChannel',
    'postPortMessage',
    'startPort',
    'closePort',
    'openSocket',
    'sendSocketMessage',
    'closeSocket',
    'openEventStream',
    'closeEventStream',
  ]);
});

Deno.test('analyzeProject tracks request and file builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function buildEmptyFormData(): FormData {',
      '  return new window.FormData();',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function buildFormDataFromForm(form: HTMLFormElement): FormData {',
      '  return new window.FormData(form);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function appendFormData(data: FormData, file: Blob): void {',
      '  data.append("file", file);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function readFileText(reader: FileReader, blob: Blob): void {',
      '  reader.readAsText(blob);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function buildFileReader(): FileReader {',
      '  return new window.FileReader();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function openXmlHttpRequest(xhr: XMLHttpRequest, url: string): void {',
      '  xhr.open("GET", url);',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function setXmlHttpRequestHeader(xhr: XMLHttpRequest): void {',
      '  xhr.setRequestHeader("x-test", "1");',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function sendXmlHttpRequest(xhr: XMLHttpRequest): void {',
      '  xhr.send();',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'buildFormDataFromForm',
    'appendFormData',
    'readFileText',
    'buildFileReader',
    'openXmlHttpRequest',
    'setXmlHttpRequestHeader',
    'sendXmlHttpRequest',
  ]);
});

Deno.test('analyzeProject enforces forbid contracts across recursive call cycles', async () => {
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
      'const failure = new Error("boom");',
      '',
      'function left(flag: boolean): void {',
      '  if (!flag) {',
      '    right(false);',
      '    return;',
      '  }',
      '  right(false);',
      '}',
      '',
      'function right(flag: boolean): void {',
      '  if (!flag) {',
      '    throw failure;',
      '  }',
      '  left(false);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function useLeft(flag: boolean): void {',
      '  left(flag);',
      '}',
      '',
      'async function asyncLeft(flag: boolean): Promise<void> {',
      '  if (!flag) {',
      '    await asyncRight(false);',
      '    return;',
      '  }',
      '  await asyncRight(false);',
      '}',
      '',
      'async function asyncRight(flag: boolean): Promise<void> {',
      '  if (!flag) {',
      '    throw failure;',
      '  }',
      '  await asyncLeft(false);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'async function useAsyncLeft(flag: boolean): Promise<void> {',
      '  await asyncLeft(flag);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'useLeft',
    'useAsyncLeft',
  ]);
});

Deno.test('analyzeProject reports unknown effect reason categories in forbid diagnostics', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { opaqueExtern } from "extern:globalThis";',
      '',
      '// #[effects(forbid: [fails])]',
      'function callOpaqueExtern(): number {',
      '  return opaqueExtern();',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function dispatchUnknown(target: EventTarget, event: Event): boolean {',
      '  return target.dispatchEvent(event);',
      '}',
      '',
    ].join('\n'),
    'src/app-globals.d.ts': [
      'declare function opaqueExtern(): number;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041', 'SOUND1041']);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'callOpaqueExtern',
    'dispatchUnknown',
  ]);
  assertEquals(
    result.diagnostics.map((diagnostic) =>
      diagnostic.metadata?.evidence?.find((entry) => entry.label === 'unknownEffectReasons')?.value
    ),
    [
      'unsummarized declaration frontier',
      'annotation declares unknown direct effects (dispatchEvent)',
    ],
  );
});

Deno.test('analyzeProject includes forwarded path detail in unknown effect reasons', async () => {
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
      '// #[interop]',
      'import { wrap } from "./effects";',
      '',
      'interface Decoder<T> {',
      '  readonly decode: (value: number) => T;',
      '}',
      '',
      'interface DecoderWithOptionalInner<T> extends Decoder<T> {',
      '  readonly inner?: Decoder<T>;',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function use(decoder: Decoder<number>): number {',
      '  return wrap(decoder, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function runTop(decoder: Decoder<number>): number {',
      '  return use(decoder);',
      '}',
    ].join('\n'),
    'src/effects.d.ts': [
      '// #[effects(forward: [decoder.inner.decode])]',
      'export declare function wrap<T>(',
      '  decoder: { readonly decode: (value: number) => T; readonly inner?: { readonly decode: (value: number) => T } },',
      '  value: number,',
      '): T;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assert(result.diagnostics.every((diagnostic) => diagnostic.code === 'SOUND1041'));
  assert(
    result.diagnostics.some((diagnostic) =>
      diagnostic.metadata?.evidence?.find((entry) => entry.label === 'unknownEffectReasons')
        ?.value ===
        'unresolved forwarded callback (decoder.inner.decode; failed at inner)'
    ),
  );
});

Deno.test('analyzeProject tracks browser storage and navigation builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      '// #[effects(forbid: [host])]',
      'function readStoredValue(): string | null {',
      '  return window.localStorage.getItem("key");',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function storeValue(): void {',
      '  window.localStorage.setItem("key", "value");',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function clearStoredValue(): void {',
      '  window.sessionStorage.clear();',
      '}',
      '',
      '// #[effects(forbid: [mut])]',
      'function pushHistoryState(url: string): void {',
      '  window.history.pushState(null, "", url);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function navigateHistory(): void {',
      '  window.history.back();',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function assignLocation(url: string): void {',
      '  window.location.assign(url);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function reloadLocation(): void {',
      '  window.location.reload();',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function sendBeaconNow(url: string): boolean {',
      '  return window.navigator.sendBeacon(url, "ok");',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'readStoredValue',
    'storeValue',
    'clearStoredValue',
    'pushHistoryState',
    'navigateHistory',
    'assignLocation',
    'reloadLocation',
    'sendBeaconNow',
  ]);
});

Deno.test('analyzeProject tracks JSON and console builtins under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      'const console = window.console;',
      '',
      '// #[effects(forbid: [fails])]',
      'function parseValue(text: string) {',
      '  return JSON.parse(text);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function stringifyValue(value: unknown) {',
      '  return JSON.stringify(value);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function logValue(value: unknown): void {',
      '  console.log(value);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function parseWithHostReviver(text: string) {',
      '  return JSON.parse(text, (_key, raw) => {',
      '    console.log(raw);',
      '    return raw;',
      '  });',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function stringifyWithHostReplacer(value: unknown) {',
      '  return JSON.stringify(value, (_key, raw) => {',
      '    console.log(raw);',
      '    return raw;',
      '  });',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'parseValue',
    'stringifyValue',
    'logValue',
    'parseWithHostReviver',
    'stringifyWithHostReplacer',
  ]);
});

Deno.test('analyzeProject tracks result, json, and debug stdlib helpers under effect contracts', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      'const console = window.console;',
      '',
      'import { resultOf, ok } from "sts:result";',
      'import { parseAndDecode, parseJson, stringifyJson, parseJsonLike, stringifyJsonLike, encodeAndStringify, decodeJson, encodeJson, type JsonLikeValue, type JsonValue } from "sts:json";',
      'import { fromDecode } from "sts:decode";',
      'import { fromEncode } from "sts:encode";',
      'import { assert, log } from "sts:experimental/debug";',
      '',
      'const pureDecoder = fromDecode((_value: unknown) => {',
      '    return ok(1);',
      '  });',
      '',
      'const hostDecoder = fromDecode((value: unknown) => {',
      '    console.log(value);',
      '    return ok(1);',
      '  });',
      '',
      'const throwDecoder = fromDecode((_value: unknown) => {',
      '    throw new Error("boom");',
      '  });',
      '',
      'const pureJsonEncoder = fromEncode((value: number) => {',
      '    return ok(value);',
      '  });',
      '',
      'const hostJsonEncoder = fromEncode((value: number) => {',
      '    console.log(value);',
      '    return ok(value);',
      '  });',
      '',
      'const pureJsonLikeEncoder = fromEncode((value: number) => {',
      '    return ok(value);',
      '  });',
      '',
      'const hostJsonLikeEncoder = fromEncode((value: number) => {',
      '    console.log(value);',
      '    return ok(value);',
      '  });',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function safeCaptureJson(text: string) {',
      '  return resultOf(() => JSON.parse(text));',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function captureHost(value: unknown) {',
      '  return resultOf(() => console.log(value));',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function mapErrorThrows(text: string) {',
      '  return resultOf(() => JSON.parse(text), (_error) => {',
      '    throw new Error("boom");',
      '  });',
      '}',
      '',
      '// #[effects(forbid: [suspend])]',
      'function captureAsync() {',
      '  return resultOf(async () => 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function stdParseJson(text: string) {',
      '  return parseJson(text);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function stdStringifyJson() {',
      '  return stringifyJson({ ok: true });',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function stdParseJsonLike(text: string) {',
      '  return parseJsonLike(text);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function stdStringifyJsonLike() {',
      '  return stringifyJsonLike({ ok: true, maybe: undefined });',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function safeParseAndDecode(text: string) {',
      '  return parseAndDecode(text, pureDecoder);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function hostParseAndDecode(text: string) {',
      '  return parseAndDecode(text, hostDecoder);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function failParseAndDecode(text: string) {',
      '  return parseAndDecode(text, throwDecoder);',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function safeEncodeAndStringify(value: number) {',
      '  return encodeAndStringify(value, pureJsonEncoder);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function hostEncodeAndStringify(value: number) {',
      '  return encodeAndStringify(value, hostJsonEncoder);',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function safeDecodeJson(text: string) {',
      '  return decodeJson(text, pureDecoder);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function hostDecodeJson(text: string) {',
      '  return decodeJson(text, hostDecoder);',
      '}',
      '',
      '// #[effects(forbid: [fails, suspend, mut, host])]',
      'function safeEncodeJson(value: number) {',
      '  return encodeJson(value, pureJsonLikeEncoder);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function hostEncodeJson(value: number) {',
      '  return encodeJson(value, hostJsonLikeEncoder);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'function debugLogValue(value: unknown) {',
      '  return log(value);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function debugAssertValue(condition: boolean): void {',
      '  assert(condition);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'safeCaptureJson',
    'captureHost',
    'mapErrorThrows',
    'captureAsync',
    'stdParseJson',
    'stdStringifyJson',
    'stdParseJsonLike',
    'stdStringifyJsonLike',
    'safeParseAndDecode',
    'hostParseAndDecode',
    'failParseAndDecode',
    'safeEncodeAndStringify',
    'hostEncodeAndStringify',
    'safeDecodeJson',
    'hostDecodeJson',
    'safeEncodeJson',
    'hostEncodeJson',
    'debugLogValue',
    'debugAssertValue',
  ]);
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
      'function runChecked(',
      '  // #[effects(forbid: [fails])]',
      '  callback: () => void,',
      '): void {',
      '  callback();',
      '}',
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

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041']);
  assertEquals(result.diagnostics[0]?.metadata?.rule, 'effect_contract_violation');
  assertEquals(result.diagnostics[0]?.line, 13);
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
      'const needsPure: NeedsPureCallback = (callback) => {',
      '  callback();',
      '};',
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

Deno.test('analyzeProject reports unknown forwarded effects in callable relation checks', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '// #[interop]',
      'import { wrapNumber } from "./effects";',
      '',
      'interface Decoder<T> {',
      '  readonly decode: (value: number) => T;',
      '}',
      '',
      'interface DecoderWithOptionalInner<T> extends Decoder<T> {',
      '  readonly inner?: Decoder<T>;',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function pureWrap(decoder: DecoderWithOptionalInner<number>, value: number): number {',
      '  void decoder;',
      '  return value;',
      '}',
      '',
      'const assigned: typeof pureWrap = wrapNumber;',
      'void assigned;',
      '',
    ].join('\n'),
    'src/effects.d.ts': [
      '// #[effects(forward: [decoder.inner.decode])]',
      'export declare function wrapNumber(',
      '  decoder: { readonly decode: (value: number) => number; readonly inner?: { readonly decode: (value: number) => number } },',
      '  value: number,',
      '): number;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1019',
    'SOUND1019',
  ]);
  const forwardedDiagnostic = result.diagnostics.find((diagnostic) =>
    diagnostic.metadata?.evidence?.some((entry) => entry.label === 'unknownEffectReasons')
  );
  assertEquals(forwardedDiagnostic?.metadata?.rule, 'callable_effect_covariance');
  assertEquals(
    forwardedDiagnostic?.metadata?.evidence?.find((entry) => entry.label === 'unknownEffectReasons')
      ?.value,
    'unresolved forwarded callback (decoder.inner.decode; failed at decode)',
  );
});

Deno.test('analyzeProject reports the same forbidden effect set for direct and relation callback contract violations', async () => {
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
      'function runChecked(',
      '  // #[effects(forbid: [fails])]',
      '  callback: () => void,',
      '): void {',
      '  callback();',
      '}',
      '',
      'interface NeedsPureCallback {',
      '  (',
      '    // #[effects(forbid: [fails])]',
      '    callback: () => void,',
      '  ): void;',
      '}',
      '',
      'const needsPure: NeedsPureCallback = (callback) => {',
      '  callback();',
      '};',
      '',
      'function bad(): void {',
      '  throw new Error("boom");',
      '}',
      '',
      'function main(): void {',
      '  runChecked(bad);',
      '}',
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

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1041', 'SOUND1019']);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.rule), [
    'effect_contract_violation',
    'callable_effect_parameter_contravariance',
  ]);
  assertEquals(
    result.diagnostics.map((diagnostic) =>
      diagnostic.metadata?.evidence?.find((entry) => entry.label === 'forbiddenEffects')?.value
    ),
    ['fails', 'fails'],
  );
});

Deno.test('analyzeProject keeps unresolved deep forwarded paths conservative across declaration, call-site, and relation checks', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createSoundscriptOnlyTsconfig(),
    'src/index.sts': [
      'interface Decoder<T> {',
      '  readonly decode: (value: number) => T;',
      '}',
      '',
      'interface DecoderLeaf<T> {',
      '  readonly leaf?: Decoder<T>;',
      '}',
      '',
      'interface DecoderTree<T> {',
      '  readonly inner?: DecoderLeaf<T>;',
      '}',
      '',
      '// #[effects(forward: [decoder.inner.leaf.decode])]',
      'function wrap(decoder: DecoderTree<number>, value: number): number {',
      '  void decoder;',
      '  return value;',
      '}',
      '',
      '// #[effects(forbid: [fails], forward: [decoder.inner.leaf.decode])]',
      'function ownWrap(decoder: DecoderTree<number>, value: number): number {',
      '  return value;',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function callWrap(decoder: DecoderTree<number>): number {',
      '  return wrap(decoder, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function pureWrap(decoder: DecoderTree<number>, value: number): number {',
      '  void decoder;',
      '  return value;',
      '}',
      '',
      'const assigned: typeof pureWrap = wrap;',
      'void assigned;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  const effectDiagnostics = result.diagnostics.filter((diagnostic) =>
    diagnostic.metadata?.rule === 'effect_contract_violation' ||
    diagnostic.metadata?.rule === 'callable_effect_covariance'
  );

  assertEquals(effectDiagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1019',
  ]);
  assertEquals(effectDiagnostics.map((diagnostic) => diagnostic.metadata?.rule), [
    'effect_contract_violation',
    'effect_contract_violation',
    'callable_effect_covariance',
  ]);
  assertEquals(
    effectDiagnostics.map((diagnostic) =>
      diagnostic.metadata?.evidence?.find((entry) => entry.label === 'forbiddenEffects')?.value
    ),
    ['fails', 'fails', 'fails'],
  );
  assert(
    effectDiagnostics.every((diagnostic) =>
      diagnostic.metadata?.evidence?.find((entry) => entry.label === 'unknownEffectReasons')
        ?.value?.includes('unresolved forwarded callback') === true
    ),
  );
});

Deno.test('analyzeProject keeps callable assignment as conservative as direct local forwarding inference', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      'function fail(value: number): number {',
      '  throw new Error("boom");',
      '}',
      '',
      'function defaultedAdapter(',
      '  callback: (value: number) => number = fail,',
      '  value: number = 1,',
      '): number {',
      '  const wrapped = (input: number): number => callback(input);',
      '  return wrapped(value);',
      '}',
      '',
      'function scheduleAdapter(callback: () => void): void {',
      '  const wrapped = (): void => callback();',
      '  window.queueMicrotask(wrapped);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function useDefaultedAdapter(): number {',
      '  return defaultedAdapter((value: number): number => value + 1, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function useScheduleAdapter(): void {',
      '  scheduleAdapter((): void => {});',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function pureDefaulted(callback: (value: number) => number, value: number): number {',
      '  void callback;',
      '  return value;',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function pureSchedule(callback: () => void): void {',
      '  void callback;',
      '}',
      '',
      'const assignedDefaulted: typeof pureDefaulted = defaultedAdapter;',
      'const assignedSchedule: typeof pureSchedule = scheduleAdapter;',
      'void assignedDefaulted;',
      'void assignedSchedule;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1019',
    'SOUND1019',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.rule), [
    'effect_contract_violation',
    'effect_contract_violation',
    'callable_effect_covariance',
    'callable_effect_covariance',
  ]);
  assertEquals(
    result.diagnostics.map((diagnostic) =>
      diagnostic.metadata?.evidence?.find((entry) => entry.label === 'forbiddenEffects')?.value
    ),
    ['fails', 'fails', 'fails', 'fails'],
  );
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
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': 'export const value = 1;\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
    fileOverrides: new Map([
      [
        join(tempDirectory, 'src/index.sts'),
        [
          '// #[interop]',
          "import { window } from 'web:dom';",
          "import { log } from 'sts:experimental/debug';",
          'const console = window.console;',
          'function __sts_log<T>(_source: string, value: T): T { return value; }',
          '',
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
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': 'export const value = 1;\n',
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
    fileOverrides: new Map([
      [
        join(tempDirectory, 'src/index.sts'),
        [
          '// #[interop]',
          "import { window } from 'web:dom';",
          "import { log } from 'sts:experimental/debug';",
          'const console = window.console;',
          'function __sts_log<T>(_source: string, value: T): T { return value; }',
          '',
          'const value = log(1);',
          'const count: number = "oops";',
          '',
        ].join('\n'),
      ],
    ]),
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
  assertEquals(result.diagnostics[0]?.line, 8);
});

Deno.test('analyzeProject expands import-scoped builtin macros before TypeScript diagnostics', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      "import { window } from 'web:dom';",
      "import { log } from 'sts:experimental/debug';",
      'const console = window.console;',
      'function __sts_log<T>(_source: string, value: T): T { return value; }',
      '',
      'const value: string = log(123);',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
  assertEquals(result.diagnostics[0]?.line, 7);
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
    assertEquals(directCodes, ['SOUND1007', 'TS2305']);
    assertEquals(wholePreparedResult.diagnostics.map((diagnostic) => diagnostic.code), directCodes);
    assertEquals(sortedFileScopedDiagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1007',
      'TS2305',
    ]);
    const missingExportDiagnostic = sortedFileScopedDiagnostics.find((diagnostic) =>
      diagnostic.code === 'TS2305'
    );
    assertStringIncludes(
      missingExportDiagnostic?.filePath ?? '',
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
      'function fetchValue(): Result<number, string> {',
      '  return ok(1);',
      '}',
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
      'function fetchValue(): Result<number, string> {',
      '  return ok(1);',
      '}',
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
      'function fetchValue(): Result<number, string> {',
      '  return ok(1);',
      '}',
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
      'function mutate(box: { value: string | null }): void { box.value = null; }',
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
  assertEquals(result.diagnostics[0]?.line, 5);
  assertEquals(result.diagnostics[0]?.column, 5);
  assertEquals(result.diagnostics[0]?.relatedInformation, [
    {
      message: 'Earlier narrowing established here.',
      filePath: join(tempDirectory, 'src/index.sts'),
      line: 4,
      column: 7,
      endLine: 4,
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

Deno.test('analyzeProject preserves narrowing across declaration-only calls proven free of mut and suspend', async () => {
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
      '// #[effects(add: [])]',
      'function observe(box: { value: string | null }): void { void box.value; }',
      '',
      'function use(box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    observe(box);',
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

Deno.test('analyzeProject preserves narrowing across shared collection callback metadata paths', async () => {
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
      'function useArray(values: readonly number[], box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    values.forEach((_value, _index, array) => {',
      '      void array.length;',
      '    });',
      '    const value: string = box.value;',
      '    return value;',
      '  }',
      '  return "";',
      '}',
      '',
      'function useSet(values: ReadonlySet<number>, box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    values.forEach((_value, _again, set) => {',
      '      void set.size;',
      '    });',
      '    const value: string = box.value;',
      '    return value;',
      '  }',
      '  return "";',
      '}',
      '',
      'function useMap(values: ReadonlyMap<string, number>, box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    values.forEach((_value, _key, map) => {',
      '      void map.size;',
      '    });',
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

Deno.test('analyzeProject preserves narrowing across sts:concurrency/task task constructor helpers', async () => {
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
      "import { Task } from 'sts:concurrency/task';",
      '',
      'function use(box: { value: string | null }, task: Task<number>): string {',
      '  if (box.value !== null) {',
      '    const mapped = Task.map(task, (value: number) => value + 1);',
      '    void mapped;',
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

Deno.test('analyzeProject preserves narrowing across pure builtin collection helpers', async () => {
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
      'function use(box: { value: string | null }, map: ReadonlyMap<string, number>): string {',
      '  if (box.value !== null) {',
      '    map.forEach(() => {});',
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

Deno.test('analyzeProject preserves narrowing across collection callbacks that use bound receiver parameters', async () => {
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
      'function useArray(values: readonly number[], box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    values.map((_value, _index, array) => array.length);',
      '    const value: string = box.value;',
      '    return value;',
      '  }',
      '  return "";',
      '}',
      '',
      'function useSet(values: ReadonlySet<number>, box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    values.forEach((_value, _again, set) => {',
      '      void set.size;',
      '    });',
      '    const value: string = box.value;',
      '    return value;',
      '  }',
      '  return "";',
      '}',
      '',
      'function useMap(values: ReadonlyMap<string, number>, box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    values.forEach((_value, _key, map) => {',
      '      void map.size;',
      '    });',
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

Deno.test('analyzeProject preserves narrowing when returning opaque calls with extracted readonly arguments', async () => {
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
      'function use(box: { value: string | null }, project: (value: string) => string): string {',
      '  if (box.value !== null) {',
      '    return project(box.value);',
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

Deno.test('analyzeProject preserves narrowing across local callback parameter calls proven free of mut and suspend', async () => {
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
      'function run(callback: (value: string) => void, value: string): void {',
      '  callback(value);',
      '}',
      '',
      'function use(box: { value: string | null }, callback: (value: string) => void): string {',
      '  if (box.value !== null) {',
      '    run(callback, box.value);',
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

Deno.test('analyzeProject infers callback and member effects through local aliases', async () => {
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
      'interface Decoder<T> {',
      '  readonly decode: (value: number) => T;',
      '}',
      '',
      'function aliasRun(callback: () => void): void {',
      '  const fn = callback;',
      '  fn();',
      '}',
      '',
      'function aliasDecode<T>(decoder: Decoder<T>, value: number): T {',
      '  const { decode } = decoder;',
      '  return decode(value);',
      '}',
      '',
      'function adapterRun<T>(callback: (value: number) => T, value: number): T {',
      '  const wrapped = (input: number): T => callback(input);',
      '  return wrapped(value);',
      '}',
      '',
      'function preludeAdapterRun<T>(callback: (value: number) => T, value: number): T {',
      '  const wrapped = (input: number): T => {',
      '    const forwarded = input;',
      '    return callback(forwarded);',
      '  };',
      '  return wrapped(value);',
      '}',
      '',
      'function adapterDecode<T>(decoder: Decoder<T>, value: number): T {',
      '  const wrapped = (input: number): T => decoder.decode(input);',
      '  return wrapped(value);',
      '}',
      '',
      'function preludeAdapterDecode<T>(decoder: Decoder<T>, value: number): T {',
      '  const wrapped = (input: number): T => {',
      '    const forwarded = input;',
      '    return decoder.decode(forwarded);',
      '  };',
      '  return wrapped(value);',
      '}',
      '',
      'async function asyncAdapterRun<T>(',
      '  callback: (value: number) => Promise<T>,',
      '  value: number,',
      '): Promise<T> {',
      '  const wrapped = async (input: number): Promise<T> => await callback(input);',
      '  return await wrapped(value);',
      '}',
      '',
      'function doubleAdapterRun<T>(callback: (value: number) => T, value: number): T {',
      '  const wrapped = (input: number): T => {',
      '    callback(input);',
      '    return callback(input);',
      '  };',
      '  return wrapped(value);',
      '}',
      '',
      'function branchedAdapterRun<T>(',
      '  callback: (value: number) => T,',
      '  value: number,',
      '  flag: boolean,',
      '): T {',
      '  const wrapped = (input: number): T => {',
      '    if (flag) {',
      '      return callback(input);',
      '    }',
      '    return callback(input);',
      '  };',
      '  return wrapped(value);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function pureThroughAliases(): number {',
      '  aliasRun(() => {});',
      '  adapterRun((value: number): number => value + 1, 1);',
      '  preludeAdapterRun((value: number): number => value + 1, 1);',
      '  preludeAdapterDecode({',
      '    decode: (value: number): number => value + 1,',
      '  }, 1);',
      '  return aliasDecode({',
      '    decode: (value: number): number => value + 1,',
      '  }, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function failThroughCallbackAlias(): void {',
      '  aliasRun(() => {',
      '    throw new Error("boom");',
      '  });',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function failThroughMemberAlias(): number {',
      '  return aliasDecode({',
      '    decode: (_value: number): number => {',
      '      throw new Error("boom");',
      '    },',
      '  }, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function failThroughCallbackAdapter(): void {',
      '  adapterRun((_value: number): void => {',
      '    throw new Error("boom");',
      '  }, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function failThroughMemberAdapter(): number {',
      '  return adapterDecode({',
      '    decode: (_value: number): number => {',
      '      throw new Error("boom");',
      '    },',
      '  }, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function failThroughPreludeCallbackAdapter(): void {',
      '  preludeAdapterRun((_value: number): void => {',
      '    throw new Error("boom");',
      '  }, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function failThroughPreludeMemberAdapter(): number {',
      '  return preludeAdapterDecode({',
      '    decode: (_value: number): number => {',
      '      throw new Error("boom");',
      '    },',
      '  }, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'async function failThroughAsyncCallbackAdapter(): Promise<void> {',
      '  await asyncAdapterRun(async (_value: number): Promise<void> => {',
      '    throw new Error("boom");',
      '  }, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function failThroughDoubleAdapter(): void {',
      '  doubleAdapterRun((_value: number): void => {',
      '    throw new Error("boom");',
      '  }, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function failThroughBranchedAdapter(): void {',
      '  branchedAdapterRun((_value: number): void => {',
      '    throw new Error("boom");',
      '  }, 1, true);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
});

Deno.test('analyzeProject keeps local forwarding inference conservative for unstable adapters', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      'const queueMicrotask = window.queueMicrotask;',
      '',
      'interface Decoder<T> {',
      '  readonly decode: (value: number) => T;',
      '}',
      '',
      'function fail(value: number): number {',
      '  throw new Error("boom");',
      '}',
      '',
      'function defaultedAdapter(',
      '  callback: (value: number) => number = fail,',
      '  value: number = 1,',
      '): number {',
      '  const wrapped = (input: number): number => callback(input);',
      '  return wrapped(value);',
      '}',
      '',
      'function extractedMemberAdapter(decoder: Decoder<number>, value: number): number {',
      '  const decode = decoder.decode;',
      '  const wrapped = (input: number): number => decode(input);',
      '  return wrapped(value);',
      '}',
      '',
      'function scheduleAdapter(callback: () => void): void {',
      '  const wrapped = (): void => callback();',
      '  queueMicrotask(wrapped);',
      '}',
      '',
      'function scheduleMemberAdapter(decoder: Decoder<number>, value: number): void {',
      '  const wrapped = (): void => {',
      '    decoder.decode(value);',
      '  };',
      '  queueMicrotask(wrapped);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function useDefaultedAdapter(): number {',
      '  return defaultedAdapter((input: number): number => input + 1, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function useExtractedMemberAdapter(): number {',
      '  return extractedMemberAdapter({',
      '    decode: (input: number): number => input + 1,',
      '  }, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function useScheduleAdapter(): void {',
      '  scheduleAdapter((): void => {});',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function useScheduleMemberAdapter(): void {',
      '  scheduleMemberAdapter({',
      '    decode: (input: number): number => input + 1,',
      '  }, 1);',
      '}',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
    'SOUND1041',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.primarySymbol), [
    'useDefaultedAdapter',
    'useExtractedMemberAdapter',
    'useScheduleAdapter',
    'useScheduleMemberAdapter',
  ]);
});

Deno.test('analyzeProject keeps unsupported local forwarding adapters conservative', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      'function fail(value: number): number {',
      '  void value;',
      '  throw new Error("boom");',
      '}',
      '',
      'function defaultedAdapterRun(',
      '  callback: (value: number) => number = fail,',
      '  value: number = 1,',
      '): number {',
      '  const wrapped = (input: number): number => callback(input);',
      '  return wrapped(value);',
      '}',
      '',
      'function scheduleAdapterRun(callback: () => void): void {',
      '  const wrapped = (): void => callback();',
      '  window.queueMicrotask(wrapped);',
      '}',
      '',
      'function pureRun(callback: (value: number) => number, value: number): number {',
      '  return callback(value);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function useDefaultedAdapter(): number {',
      '  return defaultedAdapterRun((value: number): number => value + 1, 1);',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function useScheduledAdapter(): void {',
      '  scheduleAdapterRun((): void => {',
      '    throw new Error("boom");',
      '  });',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function pureWrapper(_callback: (value: number) => number, value: number): number {',
      '  return value;',
      '}',
      '',
      '// #[effects(forbid: [fails])]',
      'function pureZero(_callback: () => void): void {}',
      '',
      'const assignedDefaulted: typeof pureWrapper = defaultedAdapterRun;',
      'const assignedScheduled: typeof pureZero = scheduleAdapterRun;',
      'void assignedDefaulted;',
      'void assignedScheduled;',
      '',
    ].join('\n'),
  });

  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });

  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
    'SOUND1041',
    'SOUND1041',
    'SOUND1019',
    'SOUND1019',
  ]);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.metadata?.rule), [
    'effect_contract_violation',
    'effect_contract_violation',
    'callable_effect_covariance',
    'callable_effect_covariance',
  ]);
});

Deno.test('analyzeProject invalidates narrowing across local helper constructors that mutate', async () => {
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
      'class ClearBox {',
      '  constructor(box: { value: string | null }) {',
      '    box.value = null;',
      '  }',
      '}',
      '',
      'function clear(box: { value: string | null }): void {',
      '  new ClearBox(box);',
      '}',
      '',
      'function use(box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    clear(box);',
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
});

Deno.test('analyzeProject preserves narrowing across deferred host schedulers', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': createBrowserTsconfig(),
    'src/index.sts': [
      '// #[interop]',
      'import { window } from "web:dom";',
      '',
      'function use(box: { value: string | null }): string {',
      '  if (box.value !== null) {',
      '    window.queueMicrotask(() => {',
      '      void box.value;',
      '    });',
      '    window.setTimeout(() => {',
      '      void box.value;',
      '    }, 0);',
      '    window.requestIdleCallback(() => {',
      '      void box.value;',
      '    });',
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
      "import { type Decoder, DecodeFailure, fromDecode } from 'sts:decode';",
      "import { isJsonValue, type JsonValue } from 'sts:json';",
      "import { Try, err, isErr, ok, type Result } from 'sts:prelude';",
      '',
      'type JsonRecord = Record<string, JsonValue>;',
      '',
      'const plainObjectDecoder: Decoder<Record<string, unknown>> = fromDecode((value): Result<Record<string, unknown>, DecodeFailure> => {',
      "    if (typeof value !== 'object' || value === null || Array.isArray(value)) {",
      "      return err(new DecodeFailure('Expected object.', { cause: value }));",
      '    }',
      '',
      '    const record: Record<string, unknown> = {};',
      '    for (const [key, nestedValue] of Object.entries(value)) {',
      '      record[key] = nestedValue;',
      '    }',
      '    return ok(record);',
      '});',
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
      '  return fromDecode((value): Result<JsonRecord, DecodeFailure> => decodeJsonRecordValue(value, message));',
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
      'const maybe: string | undefined = undefined;',
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

    const nominalDiagnostic = result.diagnostics.find((diagnostic) =>
      diagnostic.code === 'SOUND1019'
    );
    if (!nominalDiagnostic) {
      throw new Error('Expected SOUND1019 nominal diagnostic.');
    }
    assertEquals(nominalDiagnostic.line, 46);
    assertEquals(nominalDiagnostic.column, 'const c: C = '.length + 1);
    assertEquals(nominalDiagnostic.endLine, 46);
    assertEquals(nominalDiagnostic.endColumn, 'const c: C = b'.length + 1);
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
