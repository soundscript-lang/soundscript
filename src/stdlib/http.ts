import {
  createServer as nodeCreateServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';

import { type AsyncResult, CancellationFailure } from 'sts:concurrency/task';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';
import type { SocketAddress } from 'sts:net';

export type HttpRequest = IncomingMessage;
export type HttpResponse = ServerResponse;

export interface HttpServer {
  readonly port: number;
  readonly address: SocketAddress;
  close(): AsyncResult<void, Failure>;
}

export interface ServeOptions {
  readonly hostname?: string;
  readonly port: number;
  readonly signal?: AbortSignal;
  readonly name?: string;
}

export type NodeHttpHandler = (
  request: HttpRequest,
  response: HttpResponse,
) => void | Promise<void>;

export type HttpHandler = NodeHttpHandler;

export type Handler = (request: Request) => Response | AsyncResult<Response, Failure>;

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

function isResult<T, E>(value: unknown): value is Result<T, E> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'tag' in value &&
    ((value as { tag?: unknown }).tag === 'ok' || (value as { tag?: unknown }).tag === 'err')
  );
}

function nodeAddressToSocketAddress(
  address: AddressInfo | string | null,
  fallback: SocketAddress,
): SocketAddress {
  if (typeof address === 'object' && address !== null) {
    return {
      hostname: address.address,
      port: address.port,
    };
  }
  return fallback;
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }
    headers.append(name, value);
  }
  return headers;
}

function requestUrl(request: IncomingMessage, fallback: SocketAddress): string {
  const headers = requestHeaders(request);
  const host = headers.get('host') ?? `${fallback.hostname}:${fallback.port}`;
  const rawPath = request.url ?? '/';
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `http://${host}${path}`;
}

function webRequestFromNode(request: IncomingMessage, fallback: SocketAddress): Request {
  const method = request.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = {
    headers: requestHeaders(request),
    method,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(request as Readable) as unknown as ReadableStream;
    init.duplex = 'half';
  }

  return new Request(requestUrl(request, fallback), init);
}

function failureResponse(error: unknown): Response {
  const failure = failureFromUnknown(error);
  return new Response(failure.message, { status: 500 });
}

async function writeWebResponse(
  response: ServerResponse,
  webResponse: Response,
): Promise<void> {
  response.statusCode = webResponse.status;
  response.statusMessage = webResponse.statusText;
  webResponse.headers.forEach((value, name) => {
    response.setHeader(name, value);
  });

  if (!webResponse.body) {
    response.end();
    return;
  }

  await webResponse.body.pipeTo(
    Writable.toWeb(response as Writable) as unknown as WritableStream<Uint8Array>,
  );
}

async function writeHandlerFailure(response: ServerResponse, error: unknown): Promise<void> {
  if (response.headersSent) {
    response.destroy(failureFromUnknown(error));
    return;
  }
  await writeWebResponse(response, failureResponse(error));
}

export class Server implements AsyncDisposable {
  readonly #options: ServeOptions & { readonly handle: Handler };
  readonly #nodeServer: NodeHttpServer;
  #address: SocketAddress;
  #listenResult?: AsyncResult<Server, Failure>;
  #serveResult?: AsyncResult<void, Failure>;
  #closedResult?: AsyncResult<void, Failure>;
  #abortSignal?: AbortSignal;
  #abortHandler?: () => void;
  #closed = false;

  constructor(options: ServeOptions & { readonly handle: Handler }) {
    this.#options = options;
    this.#address = {
      hostname: options.hostname ?? '0.0.0.0',
      port: options.port,
    };
    this.#nodeServer = nodeCreateServer((request, response) => {
      this.#handle(request, response);
    });
  }

  get address(): SocketAddress {
    return this.#address;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const webRequest = webRequestFromNode(request, this.#address);
      const result = await this.#options.handle(webRequest);
      const webResponse = isResult<Response, Failure>(result)
        ? result.tag === 'ok' ? result.value : failureResponse(result.error)
        : result;
      await writeWebResponse(response, webResponse);
    } catch (error) {
      await writeHandlerFailure(response, error);
    }
  }

  listen(): AsyncResult<Server, Failure> {
    if (this.#listenResult) {
      return this.#listenResult;
    }

    this.#listenResult = new Promise((resolve) => {
      const signal = this.#options.signal;
      if (signal?.aborted) {
        this.#closed = true;
        resolve(err(cancellationFailure(signal)));
        return;
      }

      const cleanup = (): void => {
        this.#nodeServer.off('error', onError);
        this.#nodeServer.off('listening', onListening);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (!signal) {
          return;
        }
        cleanup();
        this.#closed = true;
        try {
          this.#nodeServer.close();
        } catch {
          // Closing a not-yet-listening server is best-effort during cancellation.
        }
        resolve(err(cancellationFailure(signal)));
      };
      const onListening = (): void => {
        this.#address = nodeAddressToSocketAddress(this.#nodeServer.address(), this.#address);
        cleanup();
        this.#attachAbortClose();
        void this.closed();
        resolve(ok(this));
      };
      const onError = (error: Error): void => {
        cleanup();
        this.#closed = true;
        resolve(err(failureFromUnknown(error)));
      };

      this.#nodeServer.once('error', onError);
      this.#nodeServer.once('listening', onListening);
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        this.#nodeServer.listen(this.#options.port, this.#options.hostname);
      } catch (error) {
        cleanup();
        resolve(err(failureFromUnknown(error)));
      }
    });

    return this.#listenResult;
  }

  serve(): AsyncResult<void, Failure> {
    if (this.#serveResult) {
      return this.#serveResult;
    }

    this.#serveResult = (async () => {
      const listened = await this.listen();
      if (listened.tag === 'err') {
        return this.#options.signal?.aborted ? ok(undefined) : listened;
      }
      return await this.closed();
    })();

    return this.#serveResult;
  }

  closed(): AsyncResult<void, Failure> {
    if (this.#closed) {
      return Promise.resolve(ok(undefined));
    }
    if (this.#closedResult) {
      return this.#closedResult;
    }

    this.#closedResult = new Promise((resolve) => {
      const cleanup = (): void => {
        this.#nodeServer.off('close', onClose);
        this.#nodeServer.off('error', onError);
      };
      const onClose = (): void => {
        cleanup();
        this.#closed = true;
        this.#detachAbortClose();
        resolve(ok(undefined));
      };
      const onError = (error: Error): void => {
        cleanup();
        this.#closed = true;
        this.#detachAbortClose();
        resolve(err(failureFromUnknown(error)));
      };

      this.#nodeServer.once('close', onClose);
      this.#nodeServer.once('error', onError);
    });

    return this.#closedResult;
  }

  close(): AsyncResult<void, Failure> {
    return new Promise((resolve) => {
      this.#detachAbortClose();
      if (this.#closed || !this.#nodeServer.listening) {
        this.#closed = true;
        resolve(ok(undefined));
        return;
      }

      this.#nodeServer.close((error) => {
        this.#closed = true;
        resolve(error ? err(failureFromUnknown(error)) : ok(undefined));
      });
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const result = await this.close();
    if (result.tag === 'err') {
      throw result.error;
    }
  }

  #attachAbortClose(): void {
    const signal = this.#options.signal;
    if (!signal || this.#abortHandler) {
      return;
    }

    const onAbort = (): void => {
      this.close();
    };
    this.#abortSignal = signal;
    this.#abortHandler = onAbort;
    signal.addEventListener('abort', onAbort, { once: true });
  }

  #detachAbortClose(): void {
    if (this.#abortSignal && this.#abortHandler) {
      this.#abortSignal.removeEventListener('abort', this.#abortHandler);
    }
    this.#abortSignal = undefined;
    this.#abortHandler = undefined;
  }
}

export function server(
  options: ServeOptions & { readonly handle: Handler },
): Result<Server, Failure> {
  try {
    return ok(new Server(options));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function serveNode(
  options: ServeOptions,
  handler: NodeHttpHandler,
): AsyncResult<HttpServer, Failure> {
  return new Promise((resolve) => {
    const server = nodeCreateServer((request, response) => {
      Promise.resolve(handler(request, response)).catch((error) => {
        response.statusCode = 500;
        response.end(normalizeThrown(error).message);
      });
    });

    server.once('error', (error) => {
      resolve(err(failureFromUnknown(error)));
    });
    server.listen(options.port, options.hostname, () => {
      const address = server.address() as AddressInfo | string | null;
      const socketAddress = nodeAddressToSocketAddress(address, {
        hostname: options.hostname ?? '0.0.0.0',
        port: options.port,
      });
      resolve(ok({
        port: socketAddress.port,
        address: socketAddress,
        close() {
          return new Promise((closeResolve) => {
            server.close((error) => {
              closeResolve(error ? err(failureFromUnknown(error)) : ok(undefined));
            });
          });
        },
      }));
    });
  });
}

export function listen(
  options: ServeOptions & { readonly handle: Handler },
): AsyncResult<Server, Failure> {
  const created = server(options);
  if (created.tag === 'err') {
    return Promise.resolve(created);
  }
  return created.value.listen();
}

export function serve(
  options: ServeOptions & { readonly handle: Handler },
): AsyncResult<void, Failure>;
export function serve(
  options: ServeOptions,
  handler: NodeHttpHandler,
): AsyncResult<HttpServer, Failure>;
export function serve(
  options: ServeOptions | (ServeOptions & { readonly handle: Handler }),
  handler?: NodeHttpHandler,
): AsyncResult<void | HttpServer, Failure> {
  if (handler) {
    return serveNode(options, handler);
  }

  const created = server(options as ServeOptions & { readonly handle: Handler });
  if (created.tag === 'err') {
    return Promise.resolve(created);
  }
  return created.value.serve();
}

export const Http = Object.freeze({
  server,
  listen,
  serve,
  serveNode,
});
