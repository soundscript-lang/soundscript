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
