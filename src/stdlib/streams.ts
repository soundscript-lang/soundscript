import { type Bytes, Bytes as BytesApi } from 'sts:bytes';
import { type AsyncResult, CancellationFailure } from 'sts:concurrency/task';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok } from 'sts:result';

export interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface ReadableStreamReadResult<T> {
  readonly done: boolean;
  readonly value?: T;
}

export interface ReadableStreamDefaultReader<T> {
  cancel(reason?: unknown): Promise<void>;
  read(...args: readonly unknown[]): Promise<ReadableStreamReadResult<T>>;
  releaseLock(): void;
}

export interface ReadableStreamDefaultController<T> {
  close(): void;
  enqueue(chunk: T): void;
}

export interface UnderlyingSource<T> {
  start?(controller: ReadableStreamDefaultController<T>): void | PromiseLike<void>;
}

export interface WritableStreamDefaultWriter<T> {
  releaseLock(): void;
  write(chunk: T): Promise<void>;
}

export interface UnderlyingSink<T> {
  write?(chunk: T): void | PromiseLike<void>;
}

export interface WritableStream<T = unknown> {
  getWriter(): WritableStreamDefaultWriter<T>;
}

export interface ReadableStream<T = unknown> {
  getReader(...args: readonly unknown[]): ReadableStreamDefaultReader<T>;
  pipeTo(
    destination: WritableStream<unknown>,
    options?: {
      readonly preventAbort?: boolean;
      readonly preventCancel?: boolean;
      readonly preventClose?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<void>;
}

const ReadableStreamCtor = globalThis.ReadableStream as unknown as {
  new <T = unknown>(underlyingSource?: UnderlyingSource<T>): ReadableStream<T>;
};

export type ByteView =
  | ArrayBufferLike
  | ArrayBufferView<ArrayBufferLike>;

export type ByteStream = ReadableStream<ArrayBufferView<ArrayBufferLike>>;

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface PipeOptions extends OperationOptions {
  readonly preventAbort?: boolean;
  readonly preventCancel?: boolean;
  readonly preventClose?: boolean;
}

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

function bytesFromView(view: ByteView): Bytes {
  if (view instanceof ArrayBuffer || view instanceof SharedArrayBuffer) {
    return new Uint8Array(view);
  }
  if (view instanceof Uint8Array) {
    return view;
  }
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function abortResult<T>(
  signal?: AbortSignal,
): ReturnType<typeof err<CancellationFailure>> | undefined {
  return signal?.aborted ? err(cancellationFailure(signal)) : undefined;
}

function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    return Promise.reject(cancellationFailure(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(cancellationFailure(signal));
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

export async function readAllBytes(
  stream: ByteStream,
  options: OperationOptions = {},
): AsyncResult<Bytes, Failure> {
  const aborted = abortResult<Bytes>(options.signal);
  if (aborted) {
    return aborted;
  }

  const reader = stream.getReader();
  const chunks: Bytes[] = [];

  try {
    while (true) {
      const result = await raceAbort(reader.read(), options.signal);
      if (result.done) {
        return ok(BytesApi.concat(chunks));
      }
      if (result.value === undefined) {
        return err(new Failure('Byte stream yielded an empty read result before completion.'));
      }
      chunks.push(bytesFromView(result.value));
    }
  } catch (error) {
    if (error instanceof CancellationFailure) {
      await reader.cancel(error).catch(() => undefined);
    }
    return err(failureFromUnknown(error));
  } finally {
    reader.releaseLock();
  }
}

export async function readAllText(
  stream: ByteStream,
  options: OperationOptions & { readonly encoding?: string } = {},
): AsyncResult<string, Failure> {
  const bytes = await readAllBytes(stream, options);
  if (bytes.tag === 'err') {
    return bytes;
  }

  try {
    return ok(new TextDecoder(options.encoding ?? 'utf-8').decode(bytes.value));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function writeAllBytes(
  stream: WritableStream<Uint8Array<ArrayBufferLike>>,
  bytes: ByteView,
  options: OperationOptions = {},
): AsyncResult<void, Failure> {
  const aborted = abortResult<void>(options.signal);
  if (aborted) {
    return aborted;
  }

  const writer = stream.getWriter();
  try {
    await raceAbort(writer.write(bytesFromView(bytes)), options.signal);
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  } finally {
    writer.releaseLock();
  }
}

export async function pipe(
  source: ReadableStream<unknown>,
  sink: WritableStream<unknown>,
  options: PipeOptions = {},
): AsyncResult<void, Failure> {
  try {
    await source.pipeTo(sink, {
      preventAbort: options.preventAbort,
      preventCancel: options.preventCancel,
      preventClose: options.preventClose,
      signal: options.signal,
    });
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function fromBytes(bytes: ByteView): ByteStream {
  return new ReadableStreamCtor<ArrayBufferView<ArrayBufferLike>>({
    start(controller) {
      controller.enqueue(bytesFromView(bytes));
      controller.close();
    },
  });
}

export function fromIterable<T>(values: Iterable<T>): ReadableStream<T> {
  return new ReadableStreamCtor<T>({
    start(controller) {
      for (const value of values) {
        controller.enqueue(value);
      }
      controller.close();
    },
  });
}

export const Streams = Object.freeze({
  readAllBytes,
  readAllText,
  writeAllBytes,
  pipe,
  fromBytes,
  fromIterable,
});
