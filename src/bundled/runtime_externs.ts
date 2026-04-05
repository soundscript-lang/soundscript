import ts from 'typescript';

import type { RuntimeContext } from '../config.ts';
import { dirname } from '../platform/path.ts';

const DENO_EXTERN_DECLARATION_FILE = '/__soundscript_externs__/deno.global.d.ts';
const PORTABLE_WEB_GLOBALS_DECLARATION_FILE = '/__soundscript_externs__/portable-web-globals.d.ts';
const DENO_EXTERN_DECLARATION_TEXT = `
declare namespace Deno {
  interface Env {
    delete(key: string): void;
    get(key: string): string | undefined;
    has(key: string): boolean;
    set(key: string, value: string): void;
    toObject(): Record<string, string>;
  }
}

declare const Deno: {
  readonly args: readonly string[];
  readonly env: Deno.Env;
  cwd(): string;
  readFile(path: string | URL): Promise<Uint8Array<ArrayBufferLike>>;
  readTextFile(path: string | URL): Promise<string>;
  readTextFileSync(path: string | URL): string;
  writeTextFile(path: string | URL, data: string): Promise<void>;
};
`.trimStart();
const PORTABLE_WEB_GLOBALS_DECLARATION_TEXT = `
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
}

declare class AbortController {
  constructor();
  abort(reason?: unknown): void;
  readonly signal: AbortSignal;
}

type SoundscriptRandomBufferView =
  | Int8Array<ArrayBufferLike>
  | Uint8Array<ArrayBufferLike>
  | Uint8ClampedArray<ArrayBufferLike>
  | Int16Array<ArrayBufferLike>
  | Uint16Array<ArrayBufferLike>
  | Int32Array<ArrayBufferLike>
  | Uint32Array<ArrayBufferLike>
  | BigInt64Array<ArrayBufferLike>
  | BigUint64Array<ArrayBufferLike>
  | Float32Array<ArrayBufferLike>
  | Float64Array<ArrayBufferLike>;

interface Crypto {
  getRandomValues<T extends DataView<ArrayBufferLike> | SoundscriptRandomBufferView>(array: T): T;
}

declare const crypto: Crypto;

type HeadersInit = Headers | Iterable<readonly [string, string]> | Record<string, string>;
type BodyInit = ArrayBuffer | string | Uint8Array<ArrayBufferLike> | URLSearchParams;
type RequestInfo = Request | string | URL;

interface RequestInit {
  readonly body?: BodyInit | null;
  readonly headers?: HeadersInit;
  readonly method?: string;
  readonly signal?: AbortSignal | null;
}

interface ResponseInit {
  readonly headers?: HeadersInit;
  readonly status?: number;
  readonly statusText?: string;
}

declare class Headers {
  constructor(init?: HeadersInit);
  append(name: string, value: string): void;
  delete(name: string): void;
  entries(): IterableIterator<[string, string]>;
  get(name: string): string | null;
  has(name: string): boolean;
  keys(): IterableIterator<string>;
  set(name: string, value: string): void;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

declare class URLSearchParams {
  constructor(
    init?:
      | Iterable<readonly [string, string]>
      | Record<string, string>
      | string
      | URLSearchParams,
  );
  append(name: string, value: string): void;
  delete(name: string): void;
  entries(): IterableIterator<[string, string]>;
  get(name: string): string | null;
  has(name: string): boolean;
  keys(): IterableIterator<string>;
  set(name: string, value: string): void;
  toString(): string;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

declare class URL {
  constructor(url: string, base?: string | URL);
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toJSON(): string;
  toString(): string;
}

declare class Request {
  constructor(input: RequestInfo, init?: RequestInit);
  readonly headers: Headers;
  readonly method: string;
  readonly signal: AbortSignal;
  readonly url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  clone(): Request;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

declare class Response {
  constructor(body?: BodyInit | null, init?: ResponseInit);
  readonly headers: Headers;
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  clone(): Response;
  json(): Promise<unknown>;
  text(): Promise<string>;
  static error(): Response;
  static json(data: unknown, init?: ResponseInit): Response;
  static redirect(url: string | URL, status?: number): Response;
}

declare function fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;

interface TextDecodeOptions {
  stream?: boolean;
}

interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

declare class TextEncoder {
  constructor();
  encode(input?: string): Uint8Array<ArrayBufferLike>;
}

declare class TextDecoder {
  constructor(label?: string, options?: TextDecoderOptions);
  decode(
    input?: ArrayBuffer | DataView<ArrayBufferLike> | Uint8Array<ArrayBufferLike> | null,
    options?: TextDecodeOptions,
  ): string;
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
}
`.trimStart();

function getBundledExternDeclarations(runtime: RuntimeContext): ReadonlyMap<string, string> {
  const externs = new Map<string, string>();

  if (runtime.target === 'wasm-wasi') {
    externs.set(PORTABLE_WEB_GLOBALS_DECLARATION_FILE, PORTABLE_WEB_GLOBALS_DECLARATION_TEXT);
  }

  if (runtime.host === 'node' && runtime.externs.includes('deno')) {
    externs.set(DENO_EXTERN_DECLARATION_FILE, DENO_EXTERN_DECLARATION_TEXT);
  }

  return externs;
}

export function getBundledExternRootNames(runtime: RuntimeContext): readonly string[] {
  return [...getBundledExternDeclarations(runtime).keys()];
}

export function withBundledRuntimeExterns(
  baseHost: ts.CompilerHost,
  runtime: RuntimeContext,
): ts.CompilerHost {
  const externDeclarations = getBundledExternDeclarations(runtime);
  if (externDeclarations.size === 0) {
    return baseHost;
  }

  const syntheticDirectories = new Set(
    [...externDeclarations.keys()].map((fileName) => dirname(fileName)),
  );

  return {
    ...baseHost,
    directoryExists(directoryName) {
      return syntheticDirectories.has(directoryName) ||
        baseHost.directoryExists?.(directoryName) === true;
    },
    fileExists(fileName) {
      return externDeclarations.has(fileName) || baseHost.fileExists(fileName);
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const externText = externDeclarations.get(fileName);
      if (externText !== undefined) {
        return ts.createSourceFile(fileName, externText, languageVersion, true);
      }

      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    readFile(fileName) {
      return externDeclarations.get(fileName) ?? baseHost.readFile(fileName);
    },
  };
}
