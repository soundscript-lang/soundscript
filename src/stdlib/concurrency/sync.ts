import { err, ok } from 'sts:result';
import type { AsyncResult } from 'sts:concurrency/task';
import { CancellationFailure } from 'sts:concurrency/task';

export interface LockOptions {
  readonly signal?: AbortSignal;
}

type Release = () => void;

interface SemaphoreWaiter {
  readonly resolve: (result: Awaited<AsyncResult<Release, CancellationFailure>>) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

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
      return Promise.resolve(ok(this.#createRelease()));
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
      next(this.#createRelease());
      return;
    }
    this.#locked = false;
  }

  #createRelease(): Release {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#release();
    };
  }
}

export class Semaphore {
  #available: number;
  #waiters: SemaphoreWaiter[] = [];

  constructor(permits: number) {
    this.#available = permits;
  }

  acquire(options: LockOptions = {}): AsyncResult<Release, CancellationFailure> {
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.resolve(err(cancelled(signal)));
    }

    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(ok(this.#createRelease()));
    }

    return new Promise((resolve) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        signal,
        onAbort: signal
          ? () => {
            this.#removeWaiter(waiter);
            resolve(err(cancelled(signal)));
          }
          : undefined,
      };

      this.#waiters.push(waiter);
      if (signal && waiter.onAbort) {
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
    });
  }

  #release(): void {
    while (true) {
      const next = this.#waiters.shift();
      if (!next) {
        this.#available += 1;
        return;
      }

      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      if (next.signal?.aborted) {
        next.resolve(err(cancelled(next.signal)));
        continue;
      }

      next.resolve(ok(this.#createRelease()));
      return;
    }
  }

  #createRelease(): Release {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#release();
    };
  }

  #removeWaiter(waiter: SemaphoreWaiter): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) {
      this.#waiters.splice(index, 1);
    }
  }
}
