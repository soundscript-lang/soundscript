import { lookup as nodeLookup } from 'node:dns/promises';
import {
  type AddressInfo,
  connect as nodeConnect,
  createServer as nodeCreateServer,
  type Server as NodeTcpServer,
  type Socket,
} from 'node:net';
import { Readable, Writable } from 'node:stream';
import {
  connect as nodeTlsConnect,
  type ConnectionOptions as NodeTlsConnectionOptions,
  createServer as nodeTlsCreateServer,
  type Server as NodeTlsServer,
  type TlsOptions as NodeTlsOptions,
  type TLSSocket,
} from 'node:tls';

import { CancellationFailure } from 'sts:concurrency/task';
import type { AsyncResult } from 'sts:concurrency/task';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

export interface DnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type IpAddress = string;

export interface SocketAddress {
  readonly hostname: string;
  readonly port: number;
}

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface ListenOptions extends OperationOptions {
  readonly hostname?: string;
  readonly port: number;
  readonly backlog?: number;
}

export type TlsCredential = string | Uint8Array<ArrayBufferLike>;

export interface TlsConnectOptions extends SocketAddress, OperationOptions {
  readonly serverName?: string;
  readonly ca?: TlsCredential | readonly TlsCredential[];
  readonly cert?: TlsCredential;
  readonly key?: TlsCredential;
  readonly rejectUnauthorized?: boolean;
  readonly alpnProtocols?: readonly string[];
}

export interface TlsListenOptions extends ListenOptions {
  readonly cert: TlsCredential;
  readonly key: TlsCredential;
  readonly ca?: TlsCredential | readonly TlsCredential[];
  readonly requestClientCertificate?: boolean;
  readonly rejectUnauthorized?: boolean;
  readonly alpnProtocols?: readonly string[];
}

type PendingAccept<T> = {
  readonly resolve: (result: Result<T, Failure>) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
};

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

function readableToWeb(
  stream: Readable,
): ReadableStream<Uint8Array<ArrayBufferLike>> {
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array<ArrayBufferLike>>;
}

function writableToWeb(
  stream: Writable,
): WritableStream<Uint8Array<ArrayBufferLike>> {
  return Writable.toWeb(stream) as unknown as WritableStream<Uint8Array<ArrayBufferLike>>;
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

function socketAddress(
  hostname: string | undefined,
  port: number | undefined,
): SocketAddress | undefined {
  return hostname !== undefined && port !== undefined ? { hostname, port } : undefined;
}

function tlsConnectionOptions(options: TlsConnectOptions): NodeTlsConnectionOptions {
  const tlsOptions: NodeTlsConnectionOptions = {
    host: options.hostname,
    port: options.port,
  };

  if (options.serverName !== undefined) {
    tlsOptions.servername = options.serverName;
  }
  if (options.ca !== undefined) {
    tlsOptions.ca = options.ca as NodeTlsConnectionOptions['ca'];
  }
  if (options.cert !== undefined) {
    tlsOptions.cert = options.cert as NodeTlsConnectionOptions['cert'];
  }
  if (options.key !== undefined) {
    tlsOptions.key = options.key as NodeTlsConnectionOptions['key'];
  }
  if (options.rejectUnauthorized !== undefined) {
    tlsOptions.rejectUnauthorized = options.rejectUnauthorized;
  }
  if (options.alpnProtocols !== undefined) {
    tlsOptions.ALPNProtocols = [...options.alpnProtocols];
  }

  return tlsOptions;
}

function tlsServerOptions(options: TlsListenOptions): NodeTlsOptions {
  const tlsOptions: NodeTlsOptions = {
    allowHalfOpen: true,
    cert: options.cert as NodeTlsOptions['cert'],
    key: options.key as NodeTlsOptions['key'],
  };

  if (options.ca !== undefined) {
    tlsOptions.ca = options.ca as NodeTlsOptions['ca'];
  }
  if (options.requestClientCertificate !== undefined) {
    tlsOptions.requestCert = options.requestClientCertificate;
  }
  if (options.rejectUnauthorized !== undefined) {
    tlsOptions.rejectUnauthorized = options.rejectUnauthorized;
  }
  if (options.alpnProtocols !== undefined) {
    tlsOptions.ALPNProtocols = [...options.alpnProtocols];
  }

  return tlsOptions;
}

export async function lookupHost(
  hostname: string,
  _options: OperationOptions = {},
): AsyncResult<readonly IpAddress[], Failure> {
  try {
    const results = await nodeLookup(hostname, { all: true });
    return ok(results.map((result) => result.address));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function lookup(hostname: string): AsyncResult<DnsAddress, Failure> {
  try {
    const result = await nodeLookup(hostname);
    return ok({ address: result.address, family: result.family as 4 | 6 });
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export class TcpConnection implements AsyncDisposable {
  readonly readable: ReadableStream<Uint8Array<ArrayBufferLike>>;
  readonly writable: WritableStream<Uint8Array<ArrayBufferLike>>;
  readonly #socket: Socket;

  constructor(socket: unknown) {
    const typedSocket = socket as Socket;
    this.#socket = typedSocket;
    this.readable = readableToWeb(typedSocket);
    this.writable = writableToWeb(typedSocket);
  }

  get localAddress(): SocketAddress | undefined {
    return socketAddress(this.#socket.localAddress, this.#socket.localPort);
  }

  get remoteAddress(): SocketAddress | undefined {
    return socketAddress(this.#socket.remoteAddress, this.#socket.remotePort);
  }

  close(): AsyncResult<void, Failure> {
    try {
      if (this.#socket.destroyed) {
        return Promise.resolve(ok(undefined));
      }
      this.#socket.destroy();
      return Promise.resolve(ok(undefined));
    } catch (error) {
      return Promise.resolve(err(failureFromUnknown(error)));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const result = await this.close();
    if (result.tag === 'err') {
      throw result.error;
    }
  }
}

export class TcpListener implements AsyncDisposable {
  readonly #server: NodeTcpServer;
  readonly #connections: Socket[] = [];
  readonly #pendingAccepts: PendingAccept<TcpConnection>[] = [];
  #address: SocketAddress;
  #closed = false;

  constructor(options: ListenOptions) {
    this.#address = {
      hostname: options.hostname ?? '0.0.0.0',
      port: options.port,
    };
    this.#server = nodeCreateServer({ allowHalfOpen: true }, (socket) => {
      this.#acceptSocket(socket);
    });
  }

  get address(): SocketAddress {
    return this.#address;
  }

  listen(options: ListenOptions): AsyncResult<TcpListener, Failure> {
    return new Promise((resolve) => {
      const signal = options.signal;
      if (signal?.aborted) {
        resolve(err(cancellationFailure(signal)));
        return;
      }

      const cleanup = (): void => {
        this.#server.off('error', onError);
        this.#server.off('listening', onListening);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (!signal) {
          return;
        }
        cleanup();
        try {
          this.#server.close();
        } catch {
          // Closing a not-yet-listening server is best-effort during cancellation.
        }
        resolve(err(cancellationFailure(signal)));
      };
      const onError = (error: Error): void => {
        const failure = failureFromUnknown(error);
        cleanup();
        this.#closed = true;
        this.#rejectPending(failure);
        resolve(err(failure));
      };
      const onListening = (): void => {
        cleanup();
        this.#address = nodeAddressToSocketAddress(this.#server.address(), this.#address);
        resolve(ok(this));
      };

      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        if (options.backlog !== undefined) {
          this.#server.listen(options.port, options.hostname, options.backlog);
        } else {
          this.#server.listen(options.port, options.hostname);
        }
      } catch (error) {
        cleanup();
        resolve(err(failureFromUnknown(error)));
      }
    });
  }

  accept(options: OperationOptions = {}): AsyncResult<TcpConnection, Failure> {
    if (this.#connections.length > 0) {
      return Promise.resolve(ok(new TcpConnection(this.#connections.shift()!)));
    }
    if (this.#closed) {
      return Promise.resolve(err(new Failure('TCP listener is closed.')));
    }
    if (options.signal?.aborted) {
      return Promise.resolve(err(cancellationFailure(options.signal)));
    }

    return new Promise((resolve) => {
      const signal = options.signal;
      const pending: PendingAccept<TcpConnection> = {
        resolve,
        signal,
        onAbort: signal
          ? () => {
            this.#removePending(pending);
            resolve(err(cancellationFailure(signal)));
          }
          : undefined,
      };

      this.#pendingAccepts.push(pending);
      if (signal && pending.onAbort) {
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
    });
  }

  close(): AsyncResult<void, Failure> {
    try {
      if (this.#closed) {
        return Promise.resolve(ok(undefined));
      }

      this.#closed = true;
      for (const socket of this.#connections.splice(0)) {
        socket.destroy();
      }
      this.#rejectPending(new Failure('TCP listener is closed.'));

      if (this.#server.listening) {
        this.#server.close();
      }
      return Promise.resolve(ok(undefined));
    } catch (error) {
      return Promise.resolve(err(failureFromUnknown(error)));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const result = await this.close();
    if (result.tag === 'err') {
      throw result.error;
    }
  }

  #acceptSocket(socket: Socket): void {
    const pending = this.#pendingAccepts.shift();
    if (!pending) {
      this.#connections.push(socket);
      return;
    }

    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.resolve(ok(new TcpConnection(socket)));
  }

  #rejectPending(failure: Failure): void {
    for (const pending of this.#pendingAccepts.splice(0)) {
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.resolve(err(failure));
    }
  }

  #removePending(pending: PendingAccept<TcpConnection>): void {
    const index = this.#pendingAccepts.indexOf(pending);
    if (index >= 0) {
      this.#pendingAccepts.splice(index, 1);
    }
  }
}

export function connect(
  address: SocketAddress & OperationOptions,
): AsyncResult<TcpConnection, Failure> {
  return new Promise((resolve) => {
    const signal = address.signal;
    if (signal?.aborted) {
      resolve(err(cancellationFailure(signal)));
      return;
    }

    let socket: Socket;
    try {
      socket = nodeConnect(address.port, address.hostname);
    } catch (error) {
      resolve(err(failureFromUnknown(error)));
      return;
    }
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (!signal) {
        return;
      }
      cleanup();
      socket.destroy();
      resolve(err(cancellationFailure(signal)));
    };
    const onConnect = (): void => {
      cleanup();
      resolve(ok(new TcpConnection(socket)));
    };
    const onError = (error: Error): void => {
      cleanup();
      resolve(err(failureFromUnknown(error)));
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function listen(options: ListenOptions): AsyncResult<TcpListener, Failure> {
  try {
    const listener = new TcpListener(options);
    return listener.listen(options);
  } catch (error) {
    return Promise.resolve(err(failureFromUnknown(error)));
  }
}

export class TlsConnection implements AsyncDisposable {
  readonly readable: ReadableStream<Uint8Array<ArrayBufferLike>>;
  readonly writable: WritableStream<Uint8Array<ArrayBufferLike>>;
  readonly #socket: TLSSocket;

  constructor(socket: unknown) {
    const typedSocket = socket as TLSSocket;
    this.#socket = typedSocket;
    this.readable = readableToWeb(typedSocket);
    this.writable = writableToWeb(typedSocket);
  }

  get authorized(): boolean {
    return this.#socket.authorized;
  }

  get authorizationError(): string | undefined {
    const error = this.#socket.authorizationError;
    if (!error) {
      return undefined;
    }
    return error instanceof Error ? error.message : String(error);
  }

  get protocol(): string | undefined {
    return this.#socket.getProtocol() ?? undefined;
  }

  get localAddress(): SocketAddress | undefined {
    return socketAddress(this.#socket.localAddress, this.#socket.localPort);
  }

  get remoteAddress(): SocketAddress | undefined {
    return socketAddress(this.#socket.remoteAddress, this.#socket.remotePort);
  }

  close(): AsyncResult<void, Failure> {
    try {
      if (this.#socket.destroyed) {
        return Promise.resolve(ok(undefined));
      }
      this.#socket.destroy();
      return Promise.resolve(ok(undefined));
    } catch (error) {
      return Promise.resolve(err(failureFromUnknown(error)));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const result = await this.close();
    if (result.tag === 'err') {
      throw result.error;
    }
  }
}

export class TlsListener implements AsyncDisposable {
  readonly #server: NodeTlsServer;
  readonly #connections: TLSSocket[] = [];
  readonly #pendingAccepts: PendingAccept<TlsConnection>[] = [];
  #address: SocketAddress;
  #closed = false;

  constructor(options: TlsListenOptions) {
    this.#address = {
      hostname: options.hostname ?? '0.0.0.0',
      port: options.port,
    };
    this.#server = nodeTlsCreateServer(tlsServerOptions(options), (socket) => {
      this.#acceptSocket(socket);
    });
  }

  get address(): SocketAddress {
    return this.#address;
  }

  listen(options: TlsListenOptions): AsyncResult<TlsListener, Failure> {
    return new Promise((resolve) => {
      const signal = options.signal;
      if (signal?.aborted) {
        resolve(err(cancellationFailure(signal)));
        return;
      }

      const cleanup = (): void => {
        this.#server.off('error', onError);
        this.#server.off('listening', onListening);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (!signal) {
          return;
        }
        cleanup();
        try {
          this.#server.close();
        } catch {
          // Closing a not-yet-listening server is best-effort during cancellation.
        }
        resolve(err(cancellationFailure(signal)));
      };
      const onError = (error: Error): void => {
        const failure = failureFromUnknown(error);
        cleanup();
        this.#closed = true;
        this.#rejectPending(failure);
        resolve(err(failure));
      };
      const onListening = (): void => {
        cleanup();
        this.#address = nodeAddressToSocketAddress(this.#server.address(), this.#address);
        resolve(ok(this));
      };

      this.#server.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        this.#listenServer(options, onListening);
      } catch (error) {
        cleanup();
        resolve(err(failureFromUnknown(error)));
      }
    });
  }

  accept(options: OperationOptions = {}): AsyncResult<TlsConnection, Failure> {
    if (this.#connections.length > 0) {
      return Promise.resolve(ok(new TlsConnection(this.#connections.shift()!)));
    }
    if (this.#closed) {
      return Promise.resolve(err(new Failure('TLS listener is closed.')));
    }
    if (options.signal?.aborted) {
      return Promise.resolve(err(cancellationFailure(options.signal)));
    }

    return new Promise((resolve) => {
      const signal = options.signal;
      const pending: PendingAccept<TlsConnection> = {
        resolve,
        signal,
        onAbort: signal
          ? () => {
            this.#removePending(pending);
            resolve(err(cancellationFailure(signal)));
          }
          : undefined,
      };

      this.#pendingAccepts.push(pending);
      if (signal && pending.onAbort) {
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
    });
  }

  close(): AsyncResult<void, Failure> {
    return new Promise((resolve) => {
      try {
        if (this.#closed) {
          resolve(ok(undefined));
          return;
        }

        this.#closed = true;
        for (const socket of this.#connections.splice(0)) {
          socket.destroy();
        }
        this.#rejectPending(new Failure('TLS listener is closed.'));

        this.#server.close((error) => {
          resolve(error ? err(failureFromUnknown(error)) : ok(undefined));
        });
      } catch (error) {
        resolve(err(failureFromUnknown(error)));
      }
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const result = await this.close();
    if (result.tag === 'err') {
      throw result.error;
    }
  }

  #listenServer(options: TlsListenOptions, onListening: () => void): void {
    if (options.hostname !== undefined) {
      if (options.backlog !== undefined) {
        this.#server.listen(options.port, options.hostname, options.backlog, onListening);
      } else {
        this.#server.listen(options.port, options.hostname, onListening);
      }
      return;
    }

    this.#server.listen(options.port, onListening);
  }

  #acceptSocket(socket: TLSSocket): void {
    const pending = this.#pendingAccepts.shift();
    if (!pending) {
      this.#connections.push(socket);
      return;
    }

    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.resolve(ok(new TlsConnection(socket)));
  }

  #rejectPending(failure: Failure): void {
    for (const pending of this.#pendingAccepts.splice(0)) {
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.resolve(err(failure));
    }
  }

  #removePending(pending: PendingAccept<TlsConnection>): void {
    const index = this.#pendingAccepts.indexOf(pending);
    if (index >= 0) {
      this.#pendingAccepts.splice(index, 1);
    }
  }
}

export function connectTls(options: TlsConnectOptions): AsyncResult<TlsConnection, Failure> {
  return new Promise((resolve) => {
    const signal = options.signal;
    if (signal?.aborted) {
      resolve(err(cancellationFailure(signal)));
      return;
    }

    let socket: TLSSocket;
    try {
      socket = nodeTlsConnect(tlsConnectionOptions(options));
    } catch (error) {
      resolve(err(failureFromUnknown(error)));
      return;
    }
    const cleanup = (): void => {
      socket.off('secureConnect', onSecureConnect);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (!signal) {
        return;
      }
      cleanup();
      socket.destroy();
      resolve(err(cancellationFailure(signal)));
    };
    const onSecureConnect = (): void => {
      cleanup();
      resolve(ok(new TlsConnection(socket)));
    };
    const onError = (error: Error): void => {
      cleanup();
      resolve(err(failureFromUnknown(error)));
    };

    socket.once('secureConnect', onSecureConnect);
    socket.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function listenTls(options: TlsListenOptions): AsyncResult<TlsListener, Failure> {
  try {
    const listener = new TlsListener(options);
    return listener.listen(options);
  } catch (error) {
    return Promise.resolve(err(failureFromUnknown(error)));
  }
}

export const Net = Object.freeze({
  lookupHost,
  lookup,
  connect,
  listen,
  connectTls,
  listenTls,
});
