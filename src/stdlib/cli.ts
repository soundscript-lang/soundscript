import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Readable, Writable } from 'node:stream';

import { Failure, normalizeThrown } from 'sts:failures';
import { err, none, ok, type Option, type Result, some } from 'sts:result';
import type { AsyncResult } from 'sts:concurrency/task';

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface Stdio {
  readonly stdin: ReadableStream<Uint8Array<ArrayBufferLike>>;
  readonly stdout: WritableStream<Uint8Array<ArrayBufferLike>>;
  readonly stderr: WritableStream<Uint8Array<ArrayBufferLike>>;
}

export type CliStream = 'stdin' | 'stdout' | 'stderr';

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface WriteOptions {
  readonly stream?: 'stdout' | 'stderr';
}

interface WritableLike {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

export function args(): Result<readonly string[], Failure> {
  try {
    return ok([...process.argv.slice(2)]);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function stdio(): Result<Stdio, Failure> {
  try {
    return ok({
      stdin: Readable.toWeb(process.stdin) as unknown as ReadableStream<
        Uint8Array<ArrayBufferLike>
      >,
      stdout: Writable.toWeb(process.stdout) as unknown as WritableStream<
        Uint8Array<ArrayBufferLike>
      >,
      stderr: Writable.toWeb(process.stderr) as unknown as WritableStream<
        Uint8Array<ArrayBufferLike>
      >,
    });
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function isTerminal(stream: CliStream): Result<boolean, Failure> {
  try {
    return ok(Boolean(process[stream].isTTY));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function terminalSize(): Result<Option<TerminalSize>, Failure> {
  try {
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;
    return ok(
      typeof columns === 'number' && typeof rows === 'number' ? some({ columns, rows }) : none(),
    );
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

function abortFailure(signal: AbortSignal): Failure {
  return signal.reason instanceof Failure
    ? signal.reason
    : new Failure('Operation was cancelled.', { cause: signal.reason });
}

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    return Promise.reject(abortFailure(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortFailure(signal));
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function readLine(
  options: OperationOptions & { readonly prompt?: string } = {},
): AsyncResult<string, Failure> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return ok(await raceAbort(readline.question(options.prompt ?? ''), options.signal));
  } catch (error) {
    return err(failureFromUnknown(error));
  } finally {
    readline.close();
  }
}

function writeToStream(stream: WritableLike, text: string): AsyncResult<void, Failure> {
  return new Promise((resolve) => {
    stream.write(text, (error?: Error | null) => {
      if (error) {
        resolve(err(failureFromUnknown(error)));
        return;
      }
      resolve(ok(undefined));
    });
  });
}

export async function write(
  text: string,
  options: WriteOptions = {},
): AsyncResult<void, Failure> {
  try {
    return await writeToStream(options.stream === 'stderr' ? process.stderr : process.stdout, text);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function writeLine(
  text: string,
  options: WriteOptions = {},
): AsyncResult<void, Failure> {
  return await write(`${text}\n`, options);
}

export const Cli = Object.freeze({
  args,
  stdio,
  isTerminal,
  terminalSize,
  readLine,
  write,
  writeLine,
});
