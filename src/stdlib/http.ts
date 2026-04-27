import {
  createServer as nodeCreateServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok } from 'sts:result';
import type { AsyncResult } from 'sts:concurrency/task';

export type HttpRequest = IncomingMessage;
export type HttpResponse = ServerResponse;

export interface HttpServer {
  readonly port: number;
  close(): AsyncResult<void, Failure>;
}

export interface ServeOptions {
  readonly hostname?: string;
  readonly port: number;
}

export type HttpHandler = (
  request: HttpRequest,
  response: HttpResponse,
) => void | Promise<void>;

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

export function serve(
  options: ServeOptions,
  handler: HttpHandler,
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
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve(ok({
        port,
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

export const Http = Object.freeze({
  serve,
});
