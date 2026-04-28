import { URL, URLSearchParams } from 'sts:url';
import { type Bytes, Bytes as BytesApi } from 'sts:bytes';
import type { DecodeMode, Decoder } from 'sts:decode';
import { type AsyncResult, CancellationFailure } from 'sts:concurrency/task';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

export interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
}

export interface OperationOptions {
  readonly signal?: AbortSignal;
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
  new (init?: HeadersInit): Headers;
} = globalThis.Headers as unknown as {
  new (init?: HeadersInit): Headers;
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
  new (input: RequestInfo, init?: RequestInit): Request;
} = globalThis.Request as unknown as {
  new (input: RequestInfo, init?: RequestInit): Request;
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
  new (body?: BodyInit | null, init?: ResponseInit): Response;
  // #[effects(add: [host.ffi])]
  error(): Response;
  // #[effects(add: [host.ffi])]
  json(data: unknown, init?: ResponseInit): Response;
  // #[effects(add: [host.ffi])]
  redirect(url: string | URL, status?: number): Response;
} = globalThis.Response as unknown as {
  new (body?: BodyInit | null, init?: ResponseInit): Response;
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

export type FetchFailure = Failure;

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

function cancellationFailure(signal: AbortSignal): CancellationFailure {
  return signal.reason instanceof CancellationFailure
    ? signal.reason
    : new CancellationFailure('Operation was cancelled.', signal.reason);
}

function abortResult<T>(signal?: AbortSignal): Result<T, CancellationFailure> | undefined {
  return signal?.aborted ? err(cancellationFailure(signal)) : undefined;
}

export async function request(
  input: RequestInfo,
  init: RequestInit = {},
): AsyncResult<Response, FetchFailure> {
  const aborted = abortResult<Response>(init.signal ?? undefined);
  if (aborted) {
    return aborted;
  }

  try {
    return ok(await fetch(input, init));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function readJson<T, E = Failure>(
  response: Response,
  decoder: Decoder<T, E, DecodeMode>,
  options: OperationOptions = {},
): AsyncResult<T, E | Failure> {
  const aborted = abortResult<T>(options.signal);
  if (aborted) {
    return aborted;
  }

  try {
    const value = await response.json();
    const afterRead = abortResult<T>(options.signal);
    if (afterRead) {
      return afterRead;
    }
    return await decoder.decode(value) as Result<T, E | Failure>;
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function readText(
  response: Response,
  options: OperationOptions = {},
): AsyncResult<string, Failure> {
  const aborted = abortResult<string>(options.signal);
  if (aborted) {
    return aborted;
  }

  try {
    const text = await response.text();
    const afterRead = abortResult<string>(options.signal);
    return afterRead ?? ok(text);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function readBytes(
  response: Response,
  options: OperationOptions = {},
): AsyncResult<Bytes, Failure> {
  const aborted = abortResult<Bytes>(options.signal);
  if (aborted) {
    return aborted;
  }

  try {
    const bytes = BytesApi.from(await response.arrayBuffer());
    const afterRead = abortResult<Bytes>(options.signal);
    return afterRead ?? ok(bytes);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export const Fetch = Object.freeze({
  Headers,
  Request,
  Response,
  fetch,
  request,
  readJson,
  readText,
  readBytes,
});
