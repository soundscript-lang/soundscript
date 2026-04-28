import { err, ok } from 'sts:result';
import { type AsyncResult, CancellationFailure, DeadlineFailure } from 'sts:concurrency/task';
import { Failure } from 'sts:failures';

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

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export class Duration {
  readonly milliseconds: number;
  readonly nanoseconds: bigint;

  private constructor(milliseconds: number, nanoseconds: bigint) {
    this.milliseconds = milliseconds;
    this.nanoseconds = nanoseconds;
  }

  static milliseconds(value: number): Duration {
    return new Duration(value, BigInt(Math.trunc(value * 1_000_000)));
  }

  static seconds(value: number): Duration {
    return Duration.milliseconds(value * 1_000);
  }

  static minutes(value: number): Duration {
    return Duration.seconds(value * 60);
  }

  static nanoseconds(value: bigint): Duration {
    return new Duration(Number(value) / 1_000_000, value);
  }
}

export class Instant {
  readonly milliseconds: number;

  constructor(milliseconds: number) {
    this.milliseconds = milliseconds;
  }

  durationSince(other: Instant): Duration {
    return Duration.milliseconds(this.milliseconds - other.milliseconds);
  }

  add(duration: Duration): Instant {
    return new Instant(this.milliseconds + duration.milliseconds);
  }

  subtract(duration: Duration): Instant {
    return new Instant(this.milliseconds - duration.milliseconds);
  }
}

export class WallDateTime {
  readonly date: Date;

  constructor(date: Date) {
    this.date = date;
  }

  static now() {
    return ok(new WallDateTime(new Date()));
  }

  toIsoString(): string {
    return this.date.toISOString();
  }
}

function monotonicNow() {
  const performanceNow = globalThis.performance?.now?.();
  return ok(new Instant(performanceNow ?? Date.now()));
}

function wallNow() {
  return WallDateTime.now();
}

export const monotonic = Object.freeze({
  now: monotonicNow,
});

export const wall = Object.freeze({
  now: wallNow,
});

function cancellationFailure(signal: AbortSignal): CancellationFailure {
  const reason = signal.reason;
  return reason instanceof CancellationFailure
    ? reason
    : new CancellationFailure('Operation was cancelled.', reason);
}

export function sleep(
  duration: Duration,
  options: OperationOptions = {},
): AsyncResult<void, CancellationFailure> {
  return new Promise((resolve) => {
    const signal = options.signal;
    if (signal?.aborted) {
      resolve(err(cancellationFailure(signal)));
      return;
    }

    const timerId = setTimeout(() => {
      cleanup();
      resolve(ok(undefined));
    }, duration.milliseconds);

    const onAbort = (): void => {
      clearTimeout(timerId);
      cleanup();
      resolve(err(cancellationFailure(signal!)));
    };

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function deadline(
  at: Instant,
  options: OperationOptions = {},
): AsyncResult<void, DeadlineFailure | CancellationFailure> {
  const now = monotonicNow();
  if (now.tag === 'err') {
    return err(new DeadlineFailure('Could not read monotonic clock.', now.error));
  }

  const remaining = at.milliseconds - now.value.milliseconds;
  if (remaining <= 0) {
    return err(new DeadlineFailure());
  }

  const result = await sleep(Duration.milliseconds(remaining), options);
  if (result.tag === 'err') {
    return result;
  }
  return ok(undefined);
}

export function timeoutSignal(duration: Duration): AbortSignal {
  const AbortSignalWithTimeout = AbortSignal as typeof AbortSignal & {
    timeout?: (milliseconds: number) => AbortSignal;
  };
  if (typeof AbortSignalWithTimeout.timeout === 'function') {
    return AbortSignalWithTimeout.timeout(duration.milliseconds);
  }

  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new DeadlineFailure(`Timed out after ${duration.milliseconds}ms.`));
  }, duration.milliseconds);
  return controller.signal;
}

export const Time = Object.freeze({
  Duration,
  Instant,
  WallDateTime,
  monotonic,
  wall,
  sleep,
  deadline,
  timeoutSignal,
});

export type TimeFailure = Failure | CancellationFailure | DeadlineFailure;
