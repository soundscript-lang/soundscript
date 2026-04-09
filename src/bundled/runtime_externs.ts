import ts from 'typescript';

import type { RuntimeContext } from '../config.ts';
import { dirname } from '../platform/path.ts';

const DENO_EXTERN_DECLARATION_FILE = '/__soundscript_externs__/deno.global.d.ts';
const NODE_BUFFER_DECLARATION_FILE = '/__soundscript_externs__/node.buffer.d.ts';
const NODE_CRYPTO_DECLARATION_FILE = '/__soundscript_externs__/node.crypto.d.ts';
const NODE_FS_DECLARATION_FILE = '/__soundscript_externs__/node.fs.d.ts';
const NODE_FS_PROMISES_DECLARATION_FILE = '/__soundscript_externs__/node.fs.promises.d.ts';
const NODE_GLOBAL_DECLARATION_FILE = '/__soundscript_externs__/node.global.d.ts';
const NODE_PATH_DECLARATION_FILE = '/__soundscript_externs__/node.path.d.ts';
const NODE_TIMERS_DECLARATION_FILE = '/__soundscript_externs__/node.timers.d.ts';
const NODE_TIMERS_PROMISES_DECLARATION_FILE = '/__soundscript_externs__/node.timers.promises.d.ts';
const PORTABLE_WEB_GLOBALS_DECLARATION_FILE = '/__soundscript_externs__/portable-web-globals.d.ts';
const DENO_EXTERN_DECLARATION_TEXT = `
declare namespace Deno {
  interface Env {
    // #[effects(add: [host.system, host.deno.env, mut])]
    delete(key: string): void;
    // #[effects(add: [host.system, host.deno.env])]
    get(key: string): string | undefined;
    // #[effects(add: [host.system, host.deno.env])]
    has(key: string): boolean;
    // #[effects(add: [host.system, host.deno.env, mut])]
    set(key: string, value: string): void;
    // #[effects(add: [host.system, host.deno.env])]
    toObject(): Record<string, string>;
  }
}

declare const Deno: {
  readonly args: readonly string[];
  readonly env: Deno.Env;
  // #[effects(add: [host.system, host.deno.fs, mut, fails.throws])]
  chdir(directory: string | URL): void;
  // #[effects(add: [host.system, host.deno.fs])]
  cwd(): string;
  // #[effects(add: [host.io, host.deno.fs, suspend.await])]
  readFile(path: string | URL): Promise<Uint8Array<ArrayBufferLike>>;
  // #[effects(add: [host.io, host.deno.fs, fails.throws])]
  readFileSync(path: string | URL): Uint8Array<ArrayBufferLike>;
  // #[effects(add: [host.io, host.deno.fs, suspend.await])]
  readTextFile(path: string | URL): Promise<string>;
  // #[effects(add: [host.io, host.deno.fs, fails.throws])]
  readTextFileSync(path: string | URL): string;
  // #[effects(add: [host.io, host.deno.fs, mut, suspend.await])]
  mkdir(path: string | URL): Promise<void>;
  // #[effects(add: [host.io, host.deno.fs, mut, fails.throws])]
  mkdirSync(path: string | URL): void;
  // #[effects(add: [host.io, host.deno.fs, mut, suspend.await])]
  remove(path: string | URL): Promise<void>;
  // #[effects(add: [host.io, host.deno.fs, mut, fails.throws])]
  removeSync(path: string | URL): void;
  // #[effects(add: [host.io, host.deno.fs, mut, suspend.await])]
  writeTextFile(path: string | URL, data: string): Promise<void>;
  // #[effects(add: [host.io, host.deno.fs, mut, fails.throws])]
  writeTextFileSync(path: string | URL, data: string): void;
};
`.trimStart();
const NODE_GLOBAL_DECLARATION_TEXT = `
interface ProcessEnv {
  [key: string]: string | undefined;
}

interface Process {
  readonly argv: readonly string[];
  readonly env: ProcessEnv;
  // #[effects(add: [host.system, host.node.process, mut, fails.throws])]
  chdir(directory: string): void;
  // #[effects(add: [host.system, host.node.process])]
  cwd(): string;
  // #[effects(add: [host.system, host.node.process])]
  exit(code?: number): never;
}

declare const process: Process;

interface Immediate {}
interface Timeout {}

// #[effects(add: [host.time])]
declare function setImmediate(callback: (...args: unknown[]) => void): Immediate;
// #[effects(add: [host.time])]
declare function clearImmediate(handle: Immediate): void;

interface Buffer extends Uint8Array<ArrayBufferLike> {
  // #[effects(add: [])]
  toString(encoding?: string): string;
}

declare const Buffer: {
  // #[effects(add: [])]
  alloc(size: number): Buffer;
  // #[effects(add: [])]
  from(
    data: string | ArrayLike<number> | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>,
  ): Buffer;
  // #[effects(add: [])]
  concat(list: readonly ArrayBufferView<ArrayBufferLike>[]): Buffer;
};
`.trimStart();
const NODE_FS_DECLARATION_TEXT = `
declare module "node:fs" {
  export interface Stats {}
  // #[effects(add: [host.io, host.node.fs, fails.throws])]
  export function accessSync(path: string): void;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function appendFileSync(path: string, data: string | Uint8Array<ArrayBufferLike>): void;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function cpSync(source: string, destination: string): void;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function copyFileSync(source: string, destination: string): void;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function mkdtempSync(prefix: string): string;
  // #[effects(add: [host.io, host.node.fs, fails.throws])]
  export function readlinkSync(path: string): string;
  // #[effects(add: [host.io, host.node.fs, fails.throws])]
  export function realpathSync(path: string): string;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function renameSync(oldPath: string, newPath: string): void;
  // #[effects(add: [host.io, host.node.fs, fails.throws])]
  export function readFileSync(path: string): Uint8Array<ArrayBufferLike>;
  // #[effects(add: [host.io, host.node.fs, fails.throws])]
  export function readdirSync(path: string): string[];
  // #[effects(add: [host.io, host.node.fs, fails.throws])]
  export function statSync(path: string): Stats;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function symlinkSync(target: string, path: string): void;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function truncateSync(path: string, len?: number): void;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function unlinkSync(path: string): void;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function writeFileSync(
    path: string,
    data: string | Uint8Array<ArrayBufferLike>,
  ): void;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function mkdirSync(path: string): void;
  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]
  export function rmSync(path: string): void;
}
`.trimStart();
const NODE_BUFFER_DECLARATION_TEXT = `
declare module "node:buffer" {
  export interface Buffer extends Uint8Array<ArrayBufferLike> {
    // #[effects(add: [])]
    toString(encoding?: string): string;
  }

  export const Buffer: {
    // #[effects(add: [])]
    alloc(size: number): Buffer;
    // #[effects(add: [])]
    from(
      data: string | ArrayLike<number> | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>,
    ): Buffer;
    // #[effects(add: [])]
    concat(list: readonly ArrayBufferView<ArrayBufferLike>[]): Buffer;
  };
}
`.trimStart();
const NODE_CRYPTO_DECLARATION_TEXT = `
declare module "node:crypto" {
  export interface Hash {
    // #[effects(add: [fails.throws, mut])]
    update(data: string | Uint8Array<ArrayBufferLike>): Hash;
    // #[effects(add: [fails.throws])]
    digest(): Buffer;
    // #[effects(add: [fails.throws])]
    digest(encoding: string): string;
  }

  export interface Hmac {
    // #[effects(add: [fails.throws, mut])]
    update(data: string | Uint8Array<ArrayBufferLike>): Hmac;
    // #[effects(add: [fails.throws])]
    digest(): Buffer;
    // #[effects(add: [fails.throws])]
    digest(encoding: string): string;
  }

  // #[effects(add: [fails.throws])]
  export function createHash(algorithm: string): Hash;
  // #[effects(add: [fails.throws])]
  export function createHmac(algorithm: string, key: string): Hmac;
  // #[effects(add: [host.random])]
  export function randomInt(max: number): number;
  // #[effects(add: [host.random])]
  export function randomUUID(): string;
  // #[effects(add: [host.random])]
  export function randomBytes(size: number): Buffer;
  // #[effects(add: [host.random, mut])]
  export function randomFillSync<T extends Uint8Array<ArrayBufferLike>>(array: T): T;
  // #[effects(add: [host.random, mut, suspend.await])]
  export function randomFill<T extends Uint8Array<ArrayBufferLike>>(array: T): Promise<T>;
  // #[effects(add: [host.random, mut])]
  export function getRandomValues<
    T extends DataView<ArrayBufferLike> | Uint8Array<ArrayBufferLike>,
  >(array: T): T;
}
`.trimStart();
const NODE_FS_PROMISES_DECLARATION_TEXT = `
declare module "node:fs/promises" {
  export interface Stats {}
  // #[effects(add: [host.io, host.node.fs, suspend.await])]
  export function access(path: string): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function appendFile(path: string, data: string | Uint8Array<ArrayBufferLike>): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function cp(source: string, destination: string): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function copyFile(source: string, destination: string): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function mkdtemp(prefix: string): Promise<string>;
  // #[effects(add: [host.io, host.node.fs, suspend.await])]
  export function readlink(path: string): Promise<string>;
  // #[effects(add: [host.io, host.node.fs, suspend.await])]
  export function realpath(path: string): Promise<string>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function rename(oldPath: string, newPath: string): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, suspend.await])]
  export function readFile(path: string): Promise<Uint8Array<ArrayBufferLike>>;
  // #[effects(add: [host.io, host.node.fs, suspend.await])]
  export function readdir(path: string): Promise<string[]>;
  // #[effects(add: [host.io, host.node.fs, suspend.await])]
  export function stat(path: string): Promise<Stats>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function symlink(target: string, path: string): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function truncate(path: string, len?: number): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function unlink(path: string): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function writeFile(
    path: string,
    data: string | Uint8Array<ArrayBufferLike>,
  ): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function mkdir(path: string): Promise<void>;
  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]
  export function rm(path: string): Promise<void>;
}
`.trimStart();
const NODE_PATH_DECLARATION_TEXT = `
declare module "node:path" {
  // #[effects(add: [])]
  export function basename(path: string): string;
  // #[effects(add: [])]
  export function dirname(path: string): string;
  // #[effects(add: [])]
  export function extname(path: string): string;
  // #[effects(add: [])]
  export function join(...paths: readonly string[]): string;
  // #[effects(add: [])]
  export function resolve(...paths: readonly string[]): string;
}
`.trimStart();
const NODE_TIMERS_DECLARATION_TEXT = `
declare module "node:timers" {
  export interface Immediate {}
  export interface Timeout {}

  // #[effects(add: [host.time])]
  export function setImmediate(callback: (...args: unknown[]) => void): Immediate;
  // #[effects(add: [host.time])]
  export function clearImmediate(handle: Immediate): void;
  // #[effects(add: [host.time])]
  export function setTimeout(callback: (...args: unknown[]) => void, delay?: number): Timeout;
  // #[effects(add: [host.time])]
  export function clearTimeout(handle: Timeout): void;
  // #[effects(add: [host.time])]
  export function setInterval(callback: (...args: unknown[]) => void, delay?: number): Timeout;
  // #[effects(add: [host.time])]
  export function clearInterval(handle: Timeout): void;
}
`.trimStart();
const NODE_TIMERS_PROMISES_DECLARATION_TEXT = `
declare module "node:timers/promises" {
  // #[effects(add: [host.time, suspend.await])]
  export function setImmediate(): Promise<void>;
  // #[effects(add: [host.time, suspend.await])]
  export function setTimeout(delay?: number): Promise<void>;

  export interface Scheduler {
    // #[effects(add: [host.time, suspend.await])]
    wait(delay?: number): Promise<void>;
    // #[effects(add: [host.time, suspend.await])]
    yield(): Promise<void>;
  }

  export const scheduler: Scheduler;
}
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

  if (runtime.host === 'node') {
    externs.set(NODE_GLOBAL_DECLARATION_FILE, NODE_GLOBAL_DECLARATION_TEXT);
    externs.set(NODE_BUFFER_DECLARATION_FILE, NODE_BUFFER_DECLARATION_TEXT);
    externs.set(NODE_CRYPTO_DECLARATION_FILE, NODE_CRYPTO_DECLARATION_TEXT);
    externs.set(NODE_FS_DECLARATION_FILE, NODE_FS_DECLARATION_TEXT);
    externs.set(NODE_FS_PROMISES_DECLARATION_FILE, NODE_FS_PROMISES_DECLARATION_TEXT);
    externs.set(NODE_PATH_DECLARATION_FILE, NODE_PATH_DECLARATION_TEXT);
    externs.set(NODE_TIMERS_DECLARATION_FILE, NODE_TIMERS_DECLARATION_TEXT);
    externs.set(NODE_TIMERS_PROMISES_DECLARATION_FILE, NODE_TIMERS_PROMISES_DECLARATION_TEXT);
  }

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
