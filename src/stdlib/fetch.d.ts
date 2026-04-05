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

export declare class Headers {
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

export declare class Request {
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

export declare class Response {
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

export declare function fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
