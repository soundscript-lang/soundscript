import { dirname, fromFileUrl, join } from '@std/path';
import ts from 'typescript';

const ROOT = join(dirname(fromFileUrl(import.meta.url)), '..', '..');
const SOUND_TYPES_ROOT = join(ROOT, 'src', 'bundled', 'sound-types');
const NODE_TYPES_VERSION = '24.12.2';
const UNDICI_TYPES_VERSION = '7.16.0';
const EXCLUDED_PUBLIC_MODULES = ['node:sys'] as const;

type PackedPackage = {
  archivePath: string;
  extractedDirectory: string;
};

function assertSuccess(command: Deno.Command, description: string): string {
  const result = command.outputSync();
  if (!result.success) {
    throw new Error(
      `${description} failed:\n${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function packAndExtract(
  tempDirectory: string,
  packageSpecifier: string,
): Promise<PackedPackage> {
  const archiveFileName = assertSuccess(
    new Deno.Command('npm', {
      args: ['pack', '--silent', packageSpecifier],
      cwd: tempDirectory,
    }),
    `npm pack ${packageSpecifier}`,
  )
    .split('\n')
    .pop();

  if (!archiveFileName) {
    throw new Error(`npm pack ${packageSpecifier} did not report an archive file name`);
  }

  assertSuccess(
    new Deno.Command('tar', {
      args: ['-xzf', archiveFileName],
      cwd: tempDirectory,
    }),
    `extract ${archiveFileName}`,
  );

  const extractedDirectories: string[] = [];
  for await (const entry of Deno.readDir(tempDirectory)) {
    if (!entry.isDirectory) {
      continue;
    }
    extractedDirectories.push(join(tempDirectory, entry.name));
  }

  if (extractedDirectories.length !== 1) {
    throw new Error(
      `expected exactly one extracted directory for ${packageSpecifier}, found ${extractedDirectories.length}`,
    );
  }

  return {
    archivePath: join(tempDirectory, archiveFileName),
    extractedDirectory: extractedDirectories[0],
  };
}

async function copyDirectory(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  await Deno.mkdir(destinationDirectory, { recursive: true });

  for await (const entry of Deno.readDir(sourceDirectory)) {
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);

    if (entry.isDirectory) {
      await copyDirectory(sourcePath, destinationPath);
      continue;
    }

    if (entry.isFile) {
      await Deno.mkdir(dirname(destinationPath), { recursive: true });
      await Deno.copyFile(sourcePath, destinationPath);
    }
  }
}

async function collectDeclarationFilePaths(directoryPath: string): Promise<string[]> {
  const filePaths: string[] = [];

  for await (const entry of Deno.readDir(directoryPath)) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory) {
      filePaths.push(...await collectDeclarationFilePaths(entryPath));
      continue;
    }
    if (entry.isFile && entry.name.endsWith('.d.ts')) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}

function replaceAnyKeywordsWithUnknown(sourceText: string, filePath: string): string {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  const seenReplacementKeys = new Set<string>();

  function addReplacement(start: number, end: number, text: string): void {
    const key = `${start}:${end}:${text}`;
    if (seenReplacementKeys.has(key)) {
      return;
    }
    seenReplacementKeys.add(key);
    replacements.push({ start, end, text });
  }

  function getRestParameterType(node: ts.Node): ts.TypeNode | undefined {
    let current: ts.Node | undefined = node;

    while (current) {
      if (ts.isParameter(current)) {
        if (!current.dotDotDotToken || !current.type) {
          return undefined;
        }

        return ts.isFunctionTypeNode(current.parent) || ts.isConstructorTypeNode(current.parent)
          ? current.type
          : undefined;
      }
      current = current.parent;
    }

    return undefined;
  }

  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const restParameterType = getRestParameterType(node);
      if (restParameterType) {
        addReplacement(
          restParameterType.getStart(sourceFile),
          restParameterType.getEnd(),
          'never[]',
        );
      } else {
        addReplacement(node.getStart(sourceFile), node.getEnd(), 'unknown');
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (replacements.length === 0) {
    return sourceText;
  }

  let nextText = sourceText;
  for (const replacement of replacements.reverse()) {
    nextText = `${nextText.slice(0, replacement.start)}${replacement.text}${
      nextText.slice(replacement.end)
    }`;
  }
  return nextText;
}

function replaceText(
  sourceText: string,
  before: string,
  after: string,
  description: string,
): string {
  if (!sourceText.includes(before)) {
    throw new Error(`failed to apply curated patch for ${description}`);
  }
  return sourceText.replace(before, after);
}

function insertAfter(
  sourceText: string,
  anchor: string,
  insertedText: string,
  description: string,
): string {
  const anchorIndex = sourceText.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(`failed to locate anchor for ${description}`);
  }

  const insertionPoint = anchorIndex + anchor.length;
  return `${sourceText.slice(0, insertionPoint)}${insertedText}${sourceText.slice(insertionPoint)}`;
}

async function sanitizeDeclarationTree(directoryPath: string): Promise<void> {
  for (const filePath of await collectDeclarationFilePaths(directoryPath)) {
    const sourceText = await Deno.readTextFile(filePath);
    const sanitizedText = replaceAnyKeywordsWithUnknown(sourceText, filePath);
    if (sanitizedText !== sourceText) {
      await Deno.writeTextFile(filePath, sanitizedText);
    }
  }
}

async function applyCuratedDeclarationPatches(directoryPath: string): Promise<void> {
  const bufferPath = join(directoryPath, 'node', 'buffer.d.ts');
  const bufferBufferPath = join(directoryPath, 'node', 'buffer.buffer.d.ts');
  const consolePath = join(directoryPath, 'node', 'console.d.ts');
  const cryptoPath = join(directoryPath, 'node', 'crypto.d.ts');
  const dgramPath = join(directoryPath, 'node', 'dgram.d.ts');
  const eventsPath = join(directoryPath, 'node', 'events.d.ts');
  const fsPath = join(directoryPath, 'node', 'fs.d.ts');
  const globalsPath = join(directoryPath, 'node', 'globals.d.ts');
  const globalsTypedArrayPath = join(directoryPath, 'node', 'globals.typedarray.d.ts');
  const httpPath = join(directoryPath, 'node', 'http.d.ts');
  const httpsPath = join(directoryPath, 'node', 'https.d.ts');
  const readlinePath = join(directoryPath, 'node', 'readline.d.ts');
  const stringDecoderPath = join(directoryPath, 'node', 'string_decoder.d.ts');
  const streamPath = join(directoryPath, 'node', 'stream.d.ts');
  const tlsPath = join(directoryPath, 'node', 'tls.d.ts');
  const undiciErrorsPath = join(directoryPath, 'node_modules', 'undici-types', 'errors.d.ts');

  const eventsText = await Deno.readTextFile(eventsPath);
  let patchedEventsText = replaceText(
    eventsText,
    '    type EventMap<T> = Record<keyof T, unknown[]> | DefaultEventMap;\n',
    '    type EventMap<T> = Record<keyof T, readonly unknown[]> | DefaultEventMap;\n',
    'node:events readonly custom event maps',
  );
  patchedEventsText = replaceText(
    patchedEventsText,
    '    type AnyRest = [...args: unknown[]];\n',
    '    type AnyRest = readonly unknown[];\n',
    'node:events readonly rest fallback',
  );
  patchedEventsText = replaceText(
    patchedEventsText,
    '                T[K] extends unknown[] ? (...args: T[K]) => void : never\n',
    '                T[K] extends readonly unknown[] ? (...args: T[K]) => void : never\n',
    'node:events readonly listener tuples',
  );
  patchedEventsText = replaceText(
    patchedEventsText,
    '    type Listener1<K, T> = Listener<K, T, (...args: never[]) => void>;\n',
    '    type Listener1<K, T> = Listener<K, T, (...args: readonly unknown[]) => void>;\n',
    'node:events default listener fallback',
  );
  await Deno.writeTextFile(eventsPath, patchedEventsText);

  const globalsText = await Deno.readTextFile(globalsPath);
  const patchedGlobalsText = replaceText(
    globalsText,
    '        read(size?: number): string | Buffer;\n',
    '        read(size?: number): string | Buffer | null;\n',
    'node:globals ReadableStream.read return type',
  );
  await Deno.writeTextFile(globalsPath, patchedGlobalsText);

  const bufferBufferText = await Deno.readTextFile(bufferBufferPath);
  const patchedBufferBufferText = replaceText(
    bufferBufferText,
    '        interface Buffer<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> extends Uint8Array<TArrayBuffer> {\n',
    '        interface Buffer<TArrayBuffer extends ArrayBufferLike = ArrayBuffer> extends Uint8Array<TArrayBuffer> {\n',
    'node:buffer default Buffer backing store',
  );
  await Deno.writeTextFile(bufferBufferPath, patchedBufferBufferText);

  const cryptoText = await Deno.readTextFile(cryptoPath);
  let patchedCryptoText = replaceText(
    cryptoText,
    '    type BinaryLike = string | NodeJS.ArrayBufferView;\n',
    '    type BinaryLike = string | Buffer | NodeJS.ArrayBufferView;\n',
    'node:crypto BinaryLike Buffer support',
  );
  patchedCryptoText = replaceText(
    patchedCryptoText,
    '    function timingSafeEqual(a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean;\n',
    '    function timingSafeEqual(a: NodeJS.ArrayBufferView | Buffer, b: NodeJS.ArrayBufferView | Buffer): boolean;\n',
    'node:crypto timingSafeEqual Buffer support',
  );
  await Deno.writeTextFile(cryptoPath, patchedCryptoText);

  const dgramText = await Deno.readTextFile(dgramPath);
  let patchedDgramText = dgramText.replaceAll(
    'msg: string | NodeJS.ArrayBufferView | readonly unknown[],',
    'msg: string | Buffer | NodeJS.ArrayBufferView | readonly unknown[],',
  );
  patchedDgramText = patchedDgramText.replaceAll(
    'msg: string | NodeJS.ArrayBufferView,',
    'msg: string | Buffer | NodeJS.ArrayBufferView,',
  );
  await Deno.writeTextFile(dgramPath, patchedDgramText);

  const fsText = await Deno.readTextFile(fsPath);
  const patchedFsText = replaceText(
    fsText,
    '    export type WatchListener<T> = (event: WatchEventType, filename: T | null) => void;\n',
    '    export interface WatchListener<T> {\n' +
      '        (event: WatchEventType, filename: T | null): void;\n' +
      '    }\n',
    'node:fs WatchListener callable interface',
  );
  await Deno.writeTextFile(fsPath, patchedFsText);

  const globalsTypedArrayText = await Deno.readTextFile(globalsTypedArrayPath);
  let patchedGlobalsTypedArrayText = replaceText(
    globalsTypedArrayText,
    '        type TypedArray<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> =\n' +
      '            | Uint8Array<TArrayBuffer>\n' +
      '            | Uint8ClampedArray<TArrayBuffer>\n' +
      '            | Uint16Array<TArrayBuffer>\n' +
      '            | Uint32Array<TArrayBuffer>\n' +
      '            | Int8Array<TArrayBuffer>\n' +
      '            | Int16Array<TArrayBuffer>\n' +
      '            | Int32Array<TArrayBuffer>\n' +
      '            | BigUint64Array<TArrayBuffer>\n' +
      '            | BigInt64Array<TArrayBuffer>\n' +
      '            | Float16Array<TArrayBuffer>\n' +
      '            | Float32Array<TArrayBuffer>\n' +
      '            | Float64Array<TArrayBuffer>;\n',
    '        type TypedArray<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> =\n' +
      '            TArrayBuffer extends ArrayBufferLike ?\n' +
      '                    | Uint8Array<TArrayBuffer>\n' +
      '                    | Uint8ClampedArray<TArrayBuffer>\n' +
      '                    | Uint16Array<TArrayBuffer>\n' +
      '                    | Uint32Array<TArrayBuffer>\n' +
      '                    | Int8Array<TArrayBuffer>\n' +
      '                    | Int16Array<TArrayBuffer>\n' +
      '                    | Int32Array<TArrayBuffer>\n' +
      '                    | BigUint64Array<TArrayBuffer>\n' +
      '                    | BigInt64Array<TArrayBuffer>\n' +
      '                    | Float16Array<TArrayBuffer>\n' +
      '                    | Float32Array<TArrayBuffer>\n' +
      '                    | Float64Array<TArrayBuffer>\n' +
      '                : never;\n',
    'node:globals distributive typed array alias',
  );
  patchedGlobalsTypedArrayText = replaceText(
    patchedGlobalsTypedArrayText,
    '        type ArrayBufferView<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> =\n' +
      '            | TypedArray<TArrayBuffer>\n' +
      '            | DataView<TArrayBuffer>;\n',
    '        type ArrayBufferView<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike> =\n' +
      '            TArrayBuffer extends ArrayBufferLike ?\n' +
      '                    | TypedArray<TArrayBuffer>\n' +
      '                    | DataView<TArrayBuffer>\n' +
      '                : never;\n',
    'node:globals distributive array buffer view alias',
  );
  await Deno.writeTextFile(globalsTypedArrayPath, patchedGlobalsTypedArrayText);

  const streamText = await Deno.readTextFile(streamPath);
  let patchedStreamText = replaceText(
    streamText,
    '            read(size?: number): unknown;\n',
    '            read(size?: number): string | Buffer | null;\n',
    'node:stream Readable.read return type',
  );
  patchedStreamText = replaceText(
    patchedStreamText,
    '            [Symbol.asyncIterator](): NodeJS.AsyncIterator<unknown>;\n',
    '            [Symbol.asyncIterator](): NodeJS.AsyncIterator<string | Buffer>;\n',
    'node:stream Readable async iterator yield type',
  );
  patchedStreamText = replaceText(
    patchedStreamText,
    '        type PipelineTransformSource<T> = PipelineSource<T> | PipelineTransform<unknown, T>;\n',
    '        type PipelineTransformSource<T> = PipelineSource<T> | PipelineTransform<never, T>;\n',
    'node:stream pipeline transform wildcard source',
  );
  patchedStreamText = replaceText(
    patchedStreamText,
    '        type PipelineCallback<S extends PipelineDestination<unknown, unknown>> = S extends\n',
    '        type PipelineCallback<S> = S extends\n',
    'node:stream pipeline callback constraint',
  );
  patchedStreamText = replaceText(
    patchedStreamText,
    '        type PipelinePromise<S extends PipelineDestination<unknown, unknown>> = S extends\n',
    '        type PipelinePromise<S> = S extends\n',
    'node:stream pipeline promise constraint',
  );
  patchedStreamText = replaceText(
    patchedStreamText,
    '            static toWeb(\n' +
      '                streamReadable: Readable,\n' +
      '                options?: {\n' +
      '                    strategy?: streamWeb.QueuingStrategy | undefined;\n' +
      '                },\n' +
      '            ): streamWeb.ReadableStream;\n',
    '            static toWeb(\n' +
      '                streamReadable: import("node:tty").ReadStream,\n' +
      '                options?: {\n' +
      '                    strategy?: streamWeb.QueuingStrategy<Uint8Array> | undefined;\n' +
      '                },\n' +
      '            ): ReadableStream<Uint8Array>;\n' +
      '            static toWeb(\n' +
      '                streamReadable: Readable,\n' +
      '                options?: {\n' +
      '                    strategy?: streamWeb.QueuingStrategy | undefined;\n' +
      '                },\n' +
      '            ): streamWeb.ReadableStream;\n',
    'node:stream Readable.toWeb tty overload',
  );
  patchedStreamText = replaceText(
    patchedStreamText,
    '            static toWeb(streamWritable: Writable): streamWeb.WritableStream;\n',
    '            static toWeb(streamWritable: import("node:tty").WriteStream): WritableStream<Uint8Array>;\n' +
      '            static toWeb(streamWritable: Writable): streamWeb.WritableStream;\n',
    'node:stream Writable.toWeb tty overload',
  );
  await Deno.writeTextFile(streamPath, patchedStreamText);

  const httpText = await Deno.readTextFile(httpPath);
  let patchedHttpText = replaceText(
    httpText,
    '    type RequestListener<\n' +
      '        Request extends typeof IncomingMessage = typeof IncomingMessage,\n' +
      '        Response extends typeof ServerResponse<InstanceType<Request>> = typeof ServerResponse,\n' +
      '    > = (req: InstanceType<Request>, res: InstanceType<Response> & { req: InstanceType<Request> }) => void;\n',
    '    interface RequestListener<\n' +
      '        Request extends typeof IncomingMessage = typeof IncomingMessage,\n' +
      '        Response extends typeof ServerResponse<InstanceType<Request>> = typeof ServerResponse,\n' +
      '    > {\n' +
      '        (req: InstanceType<Request>, res: InstanceType<Response> & { req: InstanceType<Request> }): void;\n' +
      '    }\n',
    'node:http RequestListener callable interface',
  );
  patchedHttpText = [
    {
      afterText:
        '        addListener(event: "drop", listener: (data?: DropArgument) => void): this;\n',
      anchor: '        addListener(event: "listening", listener: () => void): this;\n',
      description: 'node:http addListener drop overload',
    },
    {
      afterText: '        emit(event: "drop", data?: DropArgument): boolean;\n',
      anchor: '        emit(event: "listening"): boolean;\n',
      description: 'node:http emit drop overload',
    },
    {
      afterText: '        on(event: "drop", listener: (data?: DropArgument) => void): this;\n',
      anchor: '        on(event: "listening", listener: () => void): this;\n',
      description: 'node:http on drop overload',
    },
    {
      afterText: '        once(event: "drop", listener: (data?: DropArgument) => void): this;\n',
      anchor: '        once(event: "listening", listener: () => void): this;\n',
      description: 'node:http once drop overload',
    },
    {
      afterText:
        '        prependListener(event: "drop", listener: (data?: DropArgument) => void): this;\n',
      anchor: '        prependListener(event: "listening", listener: () => void): this;\n',
      description: 'node:http prependListener drop overload',
    },
    {
      afterText:
        '        prependOnceListener(event: "drop", listener: (data?: DropArgument) => void): this;\n',
      anchor: '        prependOnceListener(event: "listening", listener: () => void): this;\n',
      description: 'node:http prependOnceListener drop overload',
    },
  ].reduce(
    (nextText, patch) => insertAfter(nextText, patch.anchor, patch.afterText, patch.description),
    replaceText(
      patchedHttpText,
      '    import { LookupFunction, Server as NetServer, Socket, TcpSocketConnectOpts } from "node:net";\n',
      '    import { DropArgument, LookupFunction, Server as NetServer, Socket, TcpSocketConnectOpts } from "node:net";\n',
      'node:http DropArgument import',
    ),
  );
  await Deno.writeTextFile(httpPath, patchedHttpText);

  const httpsText = await Deno.readTextFile(httpsPath);
  const patchedHttpsText = [
    {
      afterText:
        '        addListener(event: "drop", listener: (data?: import("node:net").DropArgument) => void): this;\n',
      anchor: '        addListener(event: "listening", listener: () => void): this;\n',
      description: 'node:https addListener drop overload',
    },
    {
      afterText: '        emit(event: "drop", data?: import("node:net").DropArgument): boolean;\n',
      anchor: '        emit(event: "listening"): boolean;\n',
      description: 'node:https emit drop overload',
    },
    {
      afterText:
        '        on(event: "drop", listener: (data?: import("node:net").DropArgument) => void): this;\n',
      anchor: '        on(event: "listening", listener: () => void): this;\n',
      description: 'node:https on drop overload',
    },
    {
      afterText:
        '        once(event: "drop", listener: (data?: import("node:net").DropArgument) => void): this;\n',
      anchor: '        once(event: "listening", listener: () => void): this;\n',
      description: 'node:https once drop overload',
    },
    {
      afterText:
        '        prependListener(event: "drop", listener: (data?: import("node:net").DropArgument) => void): this;\n',
      anchor: '        prependListener(event: "listening", listener: () => void): this;\n',
      description: 'node:https prependListener drop overload',
    },
    {
      afterText:
        '        prependOnceListener(event: "drop", listener: (data?: import("node:net").DropArgument) => void): this;\n',
      anchor: '        prependOnceListener(event: "listening", listener: () => void): this;\n',
      description: 'node:https prependOnceListener drop overload',
    },
  ].reduce(
    (nextText, patch) => insertAfter(nextText, patch.anchor, patch.afterText, patch.description),
    httpsText,
  );
  await Deno.writeTextFile(httpsPath, patchedHttpsText);

  const tlsText = await Deno.readTextFile(tlsPath);
  const tlsBaseListenerOverloads = [
    '        addListener(event: "close", listener: () => void): this;\n',
    '        addListener(event: "connection", listener: (socket: net.Socket) => void): this;\n',
    '        addListener(event: "error", listener: (err: Error) => void): this;\n',
    '        addListener(event: "listening", listener: () => void): this;\n',
    '        addListener(event: "drop", listener: (data?: net.DropArgument) => void): this;\n',
  ].join('');
  const tlsBaseEmitOverloads = [
    '        emit(event: "close"): boolean;\n',
    '        emit(event: "connection", socket: net.Socket): boolean;\n',
    '        emit(event: "error", err: Error): boolean;\n',
    '        emit(event: "listening"): boolean;\n',
    '        emit(event: "drop", data?: net.DropArgument): boolean;\n',
  ].join('');
  const tlsPatchedText = [
    {
      afterText: tlsBaseListenerOverloads,
      anchor: '        addListener(event: string, listener: (...args: never[]) => void): this;\n',
      description: 'node:tls inherited addListener overloads',
    },
    {
      afterText: tlsBaseEmitOverloads,
      anchor: '        emit(event: string | symbol, ...args: unknown[]): boolean;\n',
      description: 'node:tls inherited emit overloads',
    },
    {
      afterText: tlsBaseListenerOverloads.replaceAll('addListener', 'on'),
      anchor: '        on(event: string, listener: (...args: never[]) => void): this;\n',
      description: 'node:tls inherited on overloads',
    },
    {
      afterText: tlsBaseListenerOverloads.replaceAll('addListener', 'once'),
      anchor: '        once(event: string, listener: (...args: never[]) => void): this;\n',
      description: 'node:tls inherited once overloads',
    },
    {
      afterText: tlsBaseListenerOverloads.replaceAll('addListener', 'prependListener'),
      anchor:
        '        prependListener(event: string, listener: (...args: never[]) => void): this;\n',
      description: 'node:tls inherited prependListener overloads',
    },
    {
      afterText: tlsBaseListenerOverloads.replaceAll('addListener', 'prependOnceListener'),
      anchor:
        '        prependOnceListener(event: string, listener: (...args: never[]) => void): this;\n',
      description: 'node:tls inherited prependOnceListener overloads',
    },
  ].reduce(
    (nextText, patch) => insertAfter(nextText, patch.anchor, patch.afterText, patch.description),
    tlsText,
  );
  await Deno.writeTextFile(tlsPath, tlsPatchedText);

  const consoleText = await Deno.readTextFile(consolePath);
  let patchedConsoleText = replaceText(
    consoleText,
    '                stdout: NodeJS.WritableStream;\n',
    '                readonly stdout: NodeJS.WritableStream;\n',
    'node:console readonly stdout option',
  );
  patchedConsoleText = replaceText(
    patchedConsoleText,
    '                stderr?: NodeJS.WritableStream | undefined;\n',
    '                readonly stderr?: NodeJS.WritableStream | undefined;\n',
    'node:console readonly stderr option',
  );
  await Deno.writeTextFile(consolePath, patchedConsoleText);

  const readlineText = await Deno.readTextFile(readlinePath);
  let patchedReadlineText = replaceText(
    readlineText,
    '        input: NodeJS.ReadableStream;\n',
    '        readonly input: NodeJS.ReadableStream;\n',
    'node:readline readonly input option',
  );
  patchedReadlineText = replaceText(
    patchedReadlineText,
    '        output?: NodeJS.WritableStream | undefined;\n',
    '        readonly output?: NodeJS.WritableStream | undefined;\n',
    'node:readline readonly output option',
  );
  await Deno.writeTextFile(readlinePath, patchedReadlineText);

  const stringDecoderText = await Deno.readTextFile(stringDecoderPath);
  let patchedStringDecoderText = replaceText(
    stringDecoderText,
    '        write(buffer: string | NodeJS.ArrayBufferView): string;\n',
    '        write(buffer: string | Buffer | NodeJS.ArrayBufferView): string;\n',
    'node:string_decoder write Buffer support',
  );
  patchedStringDecoderText = replaceText(
    patchedStringDecoderText,
    '        end(buffer?: string | NodeJS.ArrayBufferView): string;\n',
    '        end(buffer?: string | Buffer | NodeJS.ArrayBufferView): string;\n',
    'node:string_decoder end Buffer support',
  );
  await Deno.writeTextFile(stringDecoderPath, patchedStringDecoderText);

  const undiciErrorsText = await Deno.readTextFile(undiciErrorsPath);
  const patchedUndiciErrorsText = replaceText(
    undiciErrorsText,
    '      options?: Record<unknown, unknown>\n',
    '      options?: Record<PropertyKey, unknown>\n',
    'undici SecureProxyConnectionError options key constraint',
  );
  await Deno.writeTextFile(undiciErrorsPath, patchedUndiciErrorsText);
}

async function writeVendorMetadata(): Promise<void> {
  const metadataPath = join(SOUND_TYPES_ROOT, 'node', 'vendor.json');
  const metadata = {
    nodeMajor: 24,
    nodeTypesVersion: NODE_TYPES_VERSION,
    undiciTypesVersion: UNDICI_TYPES_VERSION,
    source: {
      nodeTypes: `@types/node@${NODE_TYPES_VERSION}`,
      undiciTypes: `undici-types@${UNDICI_TYPES_VERSION}`,
    },
    excludedModules: [...EXCLUDED_PUBLIC_MODULES],
  };
  await Deno.writeTextFile(`${metadataPath}`, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function main(): Promise<void> {
  const tempRoot = await Deno.makeTempDir({ prefix: 'soundscript-vendor-node-types-' });

  try {
    const nodeTypesPackage = await packAndExtract(tempRoot, `@types/node@${NODE_TYPES_VERSION}`);
    const undiciTypesDirectory = join(tempRoot, 'undici-types');
    await Deno.mkdir(undiciTypesDirectory, { recursive: true });
    const undiciTypesPackage = await packAndExtract(
      undiciTypesDirectory,
      `undici-types@${UNDICI_TYPES_VERSION}`,
    );

    await Deno.remove(SOUND_TYPES_ROOT, { recursive: true }).catch(() => undefined);
    await Deno.mkdir(SOUND_TYPES_ROOT, { recursive: true });

    await copyDirectory(nodeTypesPackage.extractedDirectory, join(SOUND_TYPES_ROOT, 'node'));
    await copyDirectory(
      undiciTypesPackage.extractedDirectory,
      join(SOUND_TYPES_ROOT, 'node_modules', 'undici-types'),
    );

    await sanitizeDeclarationTree(SOUND_TYPES_ROOT);
    await applyCuratedDeclarationPatches(SOUND_TYPES_ROOT);
    await writeVendorMetadata();
  } finally {
    await Deno.remove(tempRoot, { recursive: true }).catch(() => undefined);
  }
}

if (import.meta.main) {
  await main();
}
