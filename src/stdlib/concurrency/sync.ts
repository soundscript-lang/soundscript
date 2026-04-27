import { err, ok } from 'sts:result';
import type { AsyncResult } from 'sts:concurrency/task';
import { CancellationFailure } from 'sts:concurrency/task';

export interface LockOptions {
  readonly signal?: AbortSignal;
}

type Release = () => void;

function cancelled(signal: AbortSignal): CancellationFailure {
  return signal.reason instanceof CancellationFailure
    ? signal.reason
    : new CancellationFailure('Lock acquisition was cancelled.', signal.reason);
}

export class Mutex {
  #locked = false;
  #waiters: Array<(release: Release) => void> = [];

  lock(options: LockOptions = {}): AsyncResult<Release, CancellationFailure> {
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.resolve(err(cancelled(signal)));
    }

    if (!this.#locked) {
      this.#locked = true;
      return Promise.resolve(ok(() => this.#release()));
    }

    return new Promise((resolve) => {
      const grant = (release: Release): void => {
        cleanup();
        resolve(ok(release));
      };
      const onAbort = (): void => {
        cleanup();
        this.#waiters = this.#waiters.filter((waiter) => waiter !== grant);
        resolve(err(cancelled(signal!)));
      };
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };

      this.#waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async with<T>(
    body: () => T | Promise<T>,
    options: LockOptions = {},
  ): AsyncResult<T, CancellationFailure> {
    const releaseResult = await this.lock(options);
    if (releaseResult.tag === 'err') {
      return releaseResult;
    }

    try {
      return ok(await body());
    } finally {
      releaseResult.value();
    }
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next(() => this.#release());
      return;
    }
    this.#locked = false;
  }
}

export class Semaphore {
  #available: number;
  #mutex = new Mutex();

  constructor(permits: number) {
    this.#available = permits;
  }

  async acquire(options: LockOptions = {}): AsyncResult<Release, CancellationFailure> {
    while (true) {
      const result = await this.#mutex.with(() => {
        if (this.#available <= 0) {
          return undefined;
        }
        this.#available -= 1;
        return () => {
          this.#available += 1;
        };
      }, options);

      if (result.tag === 'err') {
        return result;
      }
      if (result.value) {
        return ok(result.value);
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}
