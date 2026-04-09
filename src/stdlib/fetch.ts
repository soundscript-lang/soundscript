import { URL, URLSearchParams } from 'sts:url';

export interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
}

export type HeadersInit = Headers | Iterable<readonly [string, string]> | Record<string, string>;
export type BodyInit = ArrayBuffer | string | Uint8Array<ArrayBufferLike> | URLSearchParams;
export type RequestInfo = Request | string | URL;

export interface RequestInit {
  readonly body?: BodyInit | null;
  readonly headers?: HeadersInit;
  readonly method?: string;
  readonly signal?: AbortSignal | null;
}

export interface ResponseInit {
  readonly headers?: HeadersInit;
  readonly status?: number;
  readonly statusText?: string;
}

export interface Headers {
  // #[effects(add: [mut])]
  append(name: string, value: string): void;
  // #[effects(add: [mut])]
  delete(name: string): void;
  // #[effects(add: [])]
  entries(): IterableIterator<[string, string]>;
  // #[effects(add: [])]
  get(name: string): string | null;
  // #[effects(add: [])]
  has(name: string): boolean;
  // #[effects(add: [])]
  keys(): IterableIterator<string>;
  // #[effects(add: [mut])]
  set(name: string, value: string): void;
  // #[effects(add: [])]
  values(): IterableIterator<string>;
  // #[effects(add: [])]
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

export const Headers: {
  // #[effects(add: [host.ffi])]
  new(init?: HeadersInit): Headers;
} = globalThis.Headers as unknown as {
  new(init?: HeadersInit): Headers;
};

export interface Request {
  readonly headers: Headers;
  readonly method: string;
  readonly signal: AbortSignal;
  readonly url: string;
  // #[effects(add: [host.io, suspend.await])]
  arrayBuffer(): Promise<ArrayBuffer>;
  // #[effects(add: [])]
  clone(): Request;
  // #[effects(add: [host.io, suspend.await])]
  json(): Promise<unknown>;
  // #[effects(add: [host.io, suspend.await])]
  text(): Promise<string>;
}

export const Request: {
  // #[effects(add: [host.ffi])]
  new(input: RequestInfo, init?: RequestInit): Request;
} = globalThis.Request as unknown as {
  new(input: RequestInfo, init?: RequestInit): Request;
};

export interface Response {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  // #[effects(add: [host.io, suspend.await])]
  arrayBuffer(): Promise<ArrayBuffer>;
  // #[effects(add: [])]
  clone(): Response;
  // #[effects(add: [host.io, suspend.await])]
  json(): Promise<unknown>;
  // #[effects(add: [host.io, suspend.await])]
  text(): Promise<string>;
}

export const Response: {
  // #[effects(add: [host.ffi])]
  new(body?: BodyInit | null, init?: ResponseInit): Response;
  // #[effects(add: [host.ffi])]
  error(): Response;
  // #[effects(add: [host.ffi])]
  json(data: unknown, init?: ResponseInit): Response;
  // #[effects(add: [host.ffi])]
  redirect(url: string | URL, status?: number): Response;
} = globalThis.Response as unknown as {
  new(body?: BodyInit | null, init?: ResponseInit): Response;
  error(): Response;
  json(data: unknown, init?: ResponseInit): Response;
  redirect(url: string | URL, status?: number): Response;
};

export const fetch: {
  // #[effects(add: [host.io, suspend.await])]
  (input: RequestInfo, init?: RequestInit): Promise<Response>;
} = globalThis.fetch.bind(globalThis) as unknown as {
  (input: RequestInfo, init?: RequestInit): Promise<Response>;
};
