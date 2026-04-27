import { AsyncLocalStorage } from 'node:async_hooks';

import {
  hasCapability,
  list,
  requireCapability,
  UnsupportedCapabilityFailure,
} from 'sts:capabilities';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, isErr, ok, type Result } from 'sts:result';
import { type AsyncResult, CancellationFailure, type TaskAllResult } from 'sts:concurrency/task';
import type { Duration, Instant } from 'sts:time';

export interface RuntimeOptions {
  readonly deadline?: Instant | Duration;
  readonly signal?: AbortSignal;
  readonly scheduler?: SchedulerPolicy;
  readonly tracing?: TracingHooks;
  readonly providers?: ProviderOverrides;
}

export interface SchedulerPolicy {
  readonly name?: string;
}

export interface TracingHooks {
  readonly onTaskStart?: (name: string | undefined) => void;
  readonly onTaskEnd?: (name: string | undefined) => void;
}

export interface ProviderOverrides {
  readonly capabilities?: readonly string[];
}

export interface TaskGroupPolicy {
  readonly failFast?: boolean;
  readonly name?: string;
}

interface RuntimeContext {
  readonly signal?: AbortSignal;
}

const runtimeContextStorage = new AsyncLocalStorage<RuntimeContext>();

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }

  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

function cancellationFailure(reason?: unknown): CancellationFailure {
  return reason instanceof CancellationFailure
    ? reason
    : new CancellationFailure('Task was cancelled.', reason);
}

function currentRuntimeContext(): RuntimeContext {
  return runtimeContextStorage.getStore() ?? {};
}

function runtimeWith<T, E = Failure>(
  options: RuntimeOptions,
  body: () => AsyncResult<T, E>,
): AsyncResult<T, E | CancellationFailure> {
  const context: RuntimeContext = {
    signal: options.signal ?? currentRuntimeContext().signal,
  };

  if (context.signal?.aborted) {
    return Promise.resolve(err(cancellationFailure(context.signal.reason)));
  }

  return runtimeContextStorage.run(context, body);
}

export const Runtime = Object.freeze({
  with: runtimeWith,
  capabilities: list,
  hasCapability,
  requireCapability,
});

export class TaskHandle<T, E = Failure> {
  readonly signal: AbortSignal;
  readonly name?: string;
  #controller: AbortController;
  #joined: AsyncResult<T, E | CancellationFailure>;
  #settled = false;
  #cancellation: CancellationFailure | undefined;

  constructor(
    controller: AbortController,
    joined: AsyncResult<T, E | CancellationFailure>,
    options: { readonly name?: string } = {},
  ) {
    this.#controller = controller;
    this.#joined = joined.finally(() => {
      this.#settled = true;
    });
    this.name = options.name;
    this.signal = controller.signal;
  }

  async join(): AsyncResult<T, E | CancellationFailure> {
    const result = await this.#joined;
    return this.#cancellation ? err(this.#cancellation) : result;
  }

  cancel(reason?: Failure): void {
    if (this.#settled || this.#cancellation) {
      return;
    }

    this.#cancellation = cancellationFailure(reason);
    this.#controller.abort(this.#cancellation);
  }
}

export class TaskGroup<E = Failure> implements AsyncDisposable {
  readonly signal: AbortSignal;
  readonly policy: TaskGroupPolicy;
  #controller = new AbortController();
  #handles = new Set<TaskHandle<unknown, E>>();

  private constructor(policy: TaskGroupPolicy = {}) {
    this.policy = { failFast: true, ...policy };
    this.signal = this.#controller.signal;
  }

  static open<E = Failure>(policy?: TaskGroupPolicy): TaskGroup<E> {
    return new TaskGroup<E>(policy);
  }

  static currentSignal(): AbortSignal {
    return currentRuntimeContext().signal ?? new AbortController().signal;
  }

  fork<T>(
    body: () => AsyncResult<T, E>,
    options: { readonly name?: string } = {},
  ): TaskHandle<T, E> {
    const childController = new AbortController();
    const onGroupAbort = (): void => {
      childController.abort(this.#controller.signal.reason);
    };

    if (this.#controller.signal.aborted) {
      childController.abort(this.#controller.signal.reason);
    } else {
      this.#controller.signal.addEventListener('abort', onGroupAbort, { once: true });
    }

    const joined = runtimeContextStorage.run({ signal: childController.signal }, async () => {
      options.name && undefined;
      try {
        if (childController.signal.aborted) {
          return err(cancellationFailure(childController.signal.reason));
        }

        const result = await body();
        if (isErr(result) && this.policy.failFast !== false) {
          this.cancel(
            result.error instanceof Failure ? result.error : failureFromUnknown(result.error),
          );
        }
        return result;
      } catch (error) {
        const failure = failureFromUnknown(error);
        if (this.policy.failFast !== false) {
          this.cancel(failure);
        }
        return err(failure as E);
      } finally {
        this.#controller.signal.removeEventListener('abort', onGroupAbort);
      }
    });
    const handle = new TaskHandle<T, E>(childController, joined, options);
    this.#handles.add(handle as TaskHandle<unknown, E>);
    void handle.join().finally(() => {
      this.#handles.delete(handle as TaskHandle<unknown, E>);
    });
    return handle;
  }

  async all<T extends Readonly<Record<string, () => AsyncResult<unknown, E>>>>(
    tasks: T,
  ): AsyncResult<TaskAllResult<T>, E | CancellationFailure> {
    const entries = Object.entries(tasks);
    const handles = entries.map(([name, task]) => [name, this.fork(task, { name })] as const);
    const output: Record<string, unknown> = {};

    for (const [name, handle] of handles) {
      const result = await handle.join();
      if (isErr(result)) {
        return result as Result<TaskAllResult<T>, E | CancellationFailure>;
      }
      output[name] = result.value;
    }

    return ok(output as TaskAllResult<T>);
  }

  async race<T>(tasks: Iterable<() => AsyncResult<T, E>>): AsyncResult<T, E | CancellationFailure> {
    const handles = [...tasks].map((task) => this.fork(task));
    const result = await Promise.race(handles.map((handle) => handle.join()));
    for (const handle of handles) {
      handle.cancel(new CancellationFailure('TaskGroup.race cancelled a losing task.'));
    }
    return result;
  }

  async firstOk<T>(
    tasks: Iterable<() => AsyncResult<T, E>>,
  ): AsyncResult<T, E | CancellationFailure> {
    const errors: E[] = [];
    const handles = [...tasks].map((task) => this.fork(task));
    for (const handle of handles) {
      const result = await handle.join();
      if (result.tag === 'ok') {
        for (const other of handles) {
          if (other !== handle) {
            other.cancel(new CancellationFailure('TaskGroup.firstOk cancelled a losing task.'));
          }
        }
        return result;
      }
      errors.push(result.error as E);
    }
    return err(errors[0] ?? cancellationFailure());
  }

  cancel(reason?: Failure): void {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(cancellationFailure(reason));
    }
    for (const handle of this.#handles) {
      handle.cancel(reason);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.cancel(new CancellationFailure('TaskGroup disposed before all child tasks completed.'));
    await Promise.allSettled([...this.#handles].map((handle) => handle.join()));
  }
}

export class AsyncContextVariable<T> {
  readonly name?: string;
  readonly defaultValue?: T;
  #storage = new AsyncLocalStorage<T>();

  constructor(options: { readonly name?: string; readonly defaultValue?: T } = {}) {
    this.name = options.name;
    this.defaultValue = options.defaultValue;
  }

  get(): T | undefined {
    return this.#storage.getStore() ?? this.defaultValue;
  }

  run<R>(value: T, body: () => R): R {
    return this.#storage.run(value, body);
  }
}

export class AsyncContextSnapshot {
  #context = currentRuntimeContext();

  run<R>(body: () => R): R {
    return runtimeContextStorage.run(this.#context, body);
  }

  static wrap<F extends (...args: unknown[]) => unknown>(fn: F): F {
    const snapshot = new AsyncContextSnapshot();
    return ((...args: Parameters<F>) => snapshot.run(() => fn(...args))) as F;
  }
}

export const AsyncContext = Object.freeze({
  Variable: AsyncContextVariable,
  Snapshot: AsyncContextSnapshot,
});

export { UnsupportedCapabilityFailure };
