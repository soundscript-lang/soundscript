import { UnsupportedCapabilityFailure } from 'sts:capabilities';
import { err, type Result } from 'sts:result';
import type { AsyncResult } from 'sts:concurrency/task';
import { Failure } from 'sts:failures';

export type Send<T> = T;
export type Share<T> = T;

export type ThreadEntry<I, O, E = Failure> = (input: I) => Result<O, E> | AsyncResult<O, E>;

export interface ThreadPoolOptions {
  readonly workers: number | 'available';
  readonly name?: string;
  readonly queueLimit?: number;
}

export interface ThreadOptions {
  readonly name?: string;
}

function unsupported<E = Failure>(): AsyncResult<never, E | UnsupportedCapabilityFailure> {
  return Promise.resolve(err(new UnsupportedCapabilityFailure('concurrency.parallel')));
}

export class ThreadPool implements AsyncDisposable {
  static get default(): ThreadPool {
    return new ThreadPool('default');
  }

  static fixed(options: ThreadPoolOptions): ThreadPool {
    return new ThreadPool('fixed', options);
  }

  readonly options: ThreadPoolOptions | undefined;
  readonly kind: 'default' | 'fixed';

  private constructor(kind: 'default' | 'fixed', options?: ThreadPoolOptions) {
    this.kind = kind;
    this.options = options;
  }

  run<I, O, E = Failure>(
    _entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    _input: Send<I>,
    _options: { readonly name?: string } = {},
  ): AsyncResult<Send<O>, E | UnsupportedCapabilityFailure> {
    return unsupported<E>();
  }

  map<I, O, E = Failure>(
    _entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    _inputs: readonly Send<I>[],
    _options: { readonly name?: string } = {},
  ): AsyncResult<Send<O>[], E | UnsupportedCapabilityFailure> {
    return unsupported<E>();
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

export class Thread<I, O, E = Failure> {
  static spawn<I, O, E = Failure>(
    _entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    _input: Send<I>,
    _options: ThreadOptions = {},
  ): Thread<Send<I>, Send<O>, E> {
    return new Thread<Send<I>, Send<O>, E>();
  }

  join(): AsyncResult<Send<O>, E | UnsupportedCapabilityFailure> {
    return unsupported<E>();
  }

  cancel(_reason?: Failure): void {}

  static blockOn<T, E = Failure>(
    _work: () => AsyncResult<T, E>,
  ): Result<T, E | UnsupportedCapabilityFailure> {
    return err(new UnsupportedCapabilityFailure('concurrency.parallel.blockOn'));
  }
}
