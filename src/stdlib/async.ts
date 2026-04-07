import { type Bind, type Kind2, type TypeLambda } from 'sts:hkt';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, isErr, ok, type Result, resultOf } from 'sts:result';
import { type Applicative, type AsyncMonad, type Functor, type Monad } from 'sts:typeclasses';

export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: boolean | { once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void, options?: boolean): void;
}

export type Task<T, E = Error> = (signal?: AbortSignalLike) => Promise<Result<T, E>>;

export interface TaskF extends TypeLambda {
  readonly type: Task<this['Args'][1], this['Args'][0]>;
}

export interface PromiseF extends TypeLambda {
  readonly type: Promise<this['Args'][0]>;
}

export type TaskKind<E, T> = Kind2<TaskF, E, T>;
export type PromiseKind<T> = Promise<T>;

export class TimeoutFailure extends Failure {
  readonly ms: number;

  constructor(ms: number, cause?: unknown) {
    super(`Task timed out after ${ms}ms.`, { cause });
    this.ms = ms;
  }
}

export function succeed<T>(value: T): Task<T, never> {
  return () => Promise.resolve(ok(value));
}

export function fail<E>(error: E): Task<never, E> {
  return () => Promise.resolve(err(error));
}

export function fromResult<T, E>(result: Result<T, E>): Task<T, E> {
  return () => Promise.resolve(result);
}

// #[effects(add: [])]
export function fromPromise<T>(fn: (signal?: AbortSignalLike) => Promise<T>): Task<T, Error>;
// #[effects(add: [])]
export function fromPromise<T, E>(
  fn: (signal?: AbortSignalLike) => Promise<T>,
  mapError: (error: Error) => E,
): Task<T, E>;
export function fromPromise<T, E>(
  fn: (signal?: AbortSignalLike) => Promise<T>,
  mapError?: (error: Error) => E,
): Task<T, E | Error> {
  return async (signal?: AbortSignalLike) => {
    if (mapError) {
      return await resultOf(() => fn(signal), mapError);
    }

    return await resultOf(() => fn(signal));
  };
}

export function map<A, B, E>(
  task: Task<A, E>,
  project: (value: A) => B,
): Task<B, E> {
  return async (signal?: AbortSignalLike) => {
    const result = await task(signal);
    return isErr(result) ? result : ok(project(result.value));
  };
}

export function mapError<A, E1, E2>(
  task: Task<A, E1>,
  project: (error: E1) => E2,
): Task<A, E2 | Error> {
  return async (signal?: AbortSignalLike) => {
    const result = await task(signal);
    if (!isErr(result)) {
      return result;
    }

    try {
      return err(project(result.error));
    } catch (error) {
      return err(normalizeThrown(error));
    }
  };
}

export function flatMap<A, B, E1, E2>(
  task: Task<A, E1>,
  project: (value: A) => Task<B, E2>,
): Task<B, E1 | E2> {
  return async (signal?: AbortSignalLike) => {
    const result = await task(signal);
    if (isErr(result)) {
      return result;
    }
    return await project(result.value)(signal);
  };
}

export function recover<A, B, E>(
  task: Task<A, E>,
  project: (error: E) => B | Promise<B>,
): Task<A | B, Error> {
  return async (signal?: AbortSignalLike) => {
    const result = await task(signal);
    if (!isErr(result)) {
      return result;
    }

    return await resultOf(async () => await project(result.error));
  };
}

export function tap<A, E>(
  task: Task<A, E>,
  effect: (value: A) => unknown | Promise<unknown>,
): Task<A, E | Error> {
  return async (signal?: AbortSignalLike) => {
    const result = await task(signal);
    if (isErr(result)) {
      return result;
    }

    const observed = await resultOf(async () => await effect(result.value));
    return isErr(observed) ? observed : result;
  };
}

export function tapError<A, E>(
  task: Task<A, E>,
  effect: (error: E) => unknown | Promise<unknown>,
): Task<A, E | Error> {
  return async (signal?: AbortSignalLike) => {
    const result = await task(signal);
    if (!isErr(result)) {
      return result;
    }

    const observed = await resultOf(async () => await effect(result.error));
    return isErr(observed) ? observed : result;
  };
}

export function parallel<T, E>(tasks: readonly Task<T, E>[]): Task<readonly T[], E> {
  return async (signal?: AbortSignalLike) => {
    const results = await Promise.all(tasks.map((task) => task(signal)));
    const values: T[] = [];
    for (const result of results) {
      if (isErr(result)) {
        return result;
      }
      values.push(result.value);
    }
    return ok(values);
  };
}

export function race<T, E>(
  tasks: readonly [Task<T, E>, ...Task<T, E>[]],
): Task<T, E> {
  return async (signal?: AbortSignalLike) => {
    const controller = new AbortController();
    const cleanup = forwardAbort(signal, controller);

    try {
      return await Promise.race(tasks.map(async (task) => {
        const result = await task(controller.signal);
        controller.abort(result);
        return result;
      }));
    } finally {
      cleanup();
    }
  };
}

export function timeout<T, E>(task: Task<T, E>, ms: number): Task<T, E | TimeoutFailure> {
  return async (signal?: AbortSignalLike) => {
    const controller = new AbortController();
    const cleanup = forwardAbort(signal, controller);
    let timeoutId: number | undefined;

    try {
      const timeoutPromise = new Promise<Result<T, E | TimeoutFailure>>((resolve) => {
        timeoutId = setTimeout(() => {
          const failure = new TimeoutFailure(ms);
          resolve(err(failure));
          controller.abort(failure);
        }, ms);
      });

      return await Promise.race([
        task(controller.signal),
        timeoutPromise,
      ]);
    } finally {
      cleanup();
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  };
}

function forwardAbort(
  signal: AbortSignalLike | undefined,
  controller: AbortController,
): () => void {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }

  const onAbort = (): void => {
    controller.abort(signal.reason);
  };

  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function mapTask<E, A, B>(task: Task<A, E>, project: (value: A) => B): Task<B, E> {
  return map(task, project);
}

function apTask<E, A, B>(
  fn: Task<(value: A) => B, E>,
  value: Task<A, E>,
): Task<B, E> {
  return flatMap(fn, (resolvedFn) => map(value, resolvedFn));
}

function flatMapTask<E, A, B>(
  task: Task<A, E>,
  project: (value: A) => Task<B, E>,
): Task<B, E> {
  return flatMap(task, project);
}

function createTaskMonad<E>(): Monad<Bind<TaskF, [E]>> {
  return {
    ap: apTask,
    flatMap: flatMapTask,
    map: mapTask,
    pure: succeed,
  };
}

export function taskFunctor<E>(): Functor<Bind<TaskF, [E]>> {
  return createTaskMonad<E>();
}

export function taskApplicative<E>(): Applicative<Bind<TaskF, [E]>> {
  return createTaskMonad<E>();
}

export function taskMonad<E>(): Monad<Bind<TaskF, [E]>> {
  return createTaskMonad<E>();
}

export function taskAsyncMonad<E>(): AsyncMonad<Bind<TaskF, [E]>> {
  const monad = createTaskMonad<E>();
  return {
    ...monad,
    fromPromise<A>(promise: Promise<A>): Task<A, E> {
      return fromPromise(() => promise) as Task<A, E>;
    },
  };
}

export const promiseFunctor: Functor<PromiseF> = {
  map<A, B>(value: Promise<A>, f: (value: A) => B): Promise<B> {
    return value.then(f);
  },
};

export const promiseApplicative: Applicative<PromiseF> = {
  ...promiseFunctor,
  ap<A, B>(fn: Promise<(value: A) => B>, value: Promise<A>): Promise<B> {
    return Promise.all([fn, value]).then(([resolvedFn, resolvedValue]) =>
      resolvedFn(resolvedValue)
    );
  },
  pure<A>(value: A): Promise<A> {
    return Promise.resolve(value);
  },
};

export const promiseMonad: Monad<PromiseF> = {
  ...promiseApplicative,
  flatMap<A, B>(value: Promise<A>, f: (value: A) => Promise<B>): Promise<B> {
    return value.then(f);
  },
};

export const promiseAsyncMonad: AsyncMonad<PromiseF> = {
  ...promiseMonad,
  fromPromise<A>(promise: Promise<A>): Promise<A> {
    return promise;
  },
};
