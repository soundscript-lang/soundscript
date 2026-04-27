import { type Bind, type Kind2, type TypeLambda } from 'sts:hkt';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, isErr, isOk, ok, type Result } from 'sts:result';
import { type Applicative, type AsyncMonad, type Functor, type Monad } from 'sts:typeclasses';
import type { Duration } from 'sts:time';

export type AsyncResult<T, E = Failure> = Promise<Result<T, E>>;
export type Task<T, E = Failure> = () => AsyncResult<T, E>;

export type TaskAllResult<T> = {
  readonly [K in keyof T]: T[K] extends Task<infer V, unknown> ? V : never;
};

type TaskAllFailure<T> = T[keyof T] extends Task<unknown, infer E> ? E : never;

type TaskCollection =
  | readonly Task<unknown, unknown>[]
  | Readonly<Record<string, Task<unknown, unknown>>>;

export interface TaskF extends TypeLambda {
  readonly type: Task<this['Args'][1], this['Args'][0]>;
}

export interface PromiseF extends TypeLambda {
  readonly type: Promise<this['Args'][0]>;
}

export type TaskKind<E, T> = Kind2<TaskF, E, T>;
export type PromiseKind<T> = Promise<T>;

export class CancellationFailure extends Failure {
  constructor(message = 'Operation was cancelled.', cause?: unknown) {
    super(message, cause === undefined ? {} : { cause });
  }
}

export class DeadlineFailure extends Failure {
  constructor(message = 'Operation deadline elapsed.', cause?: unknown) {
    super(message, cause === undefined ? {} : { cause });
  }
}

export class TimeoutFailure extends DeadlineFailure {
  readonly milliseconds: number;

  constructor(duration: Duration, cause?: unknown) {
    super(`Task timed out after ${duration.milliseconds}ms.`, cause);
    this.milliseconds = duration.milliseconds;
  }

  get ms(): number {
    return this.milliseconds;
  }
}

export interface TaskModule {
  // #[effects(add: [])]
  succeed<T>(value: T): Task<T, never>;
  // #[effects(add: [])]
  fail<E>(error: E): Task<never, E>;
  // #[effects(add: [])]
  fromResult<T, E>(result: Result<T, E>): Task<T, E>;
  // #[effects(add: [])]
  fromAsyncResult<T, E>(work: () => AsyncResult<T, E>): Task<T, E>;
  // #[effects(add: [])]
  fromPromise<T>(body: () => Promise<T>): Task<T, Failure>;
  // #[effects(add: [])]
  fromPromise<T, E>(body: () => Promise<T>, mapFailure: (error: unknown) => E): Task<T, E>;
  // #[effects(add: [])]
  map<A, B, E>(task: Task<A, E>, project: (value: A) => B): Task<B, E>;
  // #[effects(add: [])]
  mapError<A, E1, E2>(task: Task<A, E1>, project: (error: E1) => E2): Task<A, E2 | Failure>;
  // #[effects(add: [])]
  flatMap<A, B, E1, E2>(
    task: Task<A, E1>,
    project: (value: A) => Task<B, E2>,
  ): Task<B, E1 | E2>;
  // #[effects(add: [])]
  recover<A, B, E>(
    task: Task<A, E>,
    project: (error: E) => B | Promise<B> | Result<B, Failure> | AsyncResult<B, Failure>,
  ): Task<A | B, Failure>;
  // #[effects(add: [])]
  tap<A, E>(
    task: Task<A, E>,
    effect: (value: A) => unknown | Promise<unknown>,
  ): Task<A, E | Failure>;
  // #[effects(add: [])]
  tapError<A, E>(
    task: Task<A, E>,
    effect: (error: E) => unknown | Promise<unknown>,
  ): Task<A, E | Failure>;
  // #[effects(add: [])]
  all<T extends TaskCollection>(tasks: T): Task<TaskAllResult<T>, TaskAllFailure<T>>;
  // #[effects(add: [])]
  race<T, E>(tasks: readonly [Task<T, E>, ...Task<T, E>[]]): Task<T, E>;
  // #[effects(add: [])]
  timeout<T, E>(task: Task<T, E>, duration: Duration): Task<T, E | TimeoutFailure>;
  // #[effects(add: [])]
  functor<E>(): Functor<Bind<TaskF, [E]>>;
  // #[effects(add: [])]
  applicative<E>(): Applicative<Bind<TaskF, [E]>>;
  // #[effects(add: [])]
  monad<E>(): Monad<Bind<TaskF, [E]>>;
  // #[effects(add: [])]
  asyncMonad<E>(): AsyncMonad<Bind<TaskF, [E]>>;
  readonly promiseFunctor: Functor<PromiseF>;
  readonly promiseApplicative: Applicative<PromiseF>;
  readonly promiseMonad: Monad<PromiseF>;
  readonly promiseAsyncMonad: AsyncMonad<PromiseF>;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }

  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

function isResult<T, E>(value: unknown): value is Result<T, E> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'tag' in value &&
    ((value as { tag?: unknown }).tag === 'ok' || (value as { tag?: unknown }).tag === 'err')
  );
}

// #[effects(add: [])]
function succeed<T>(value: T): Task<T, never> {
  return () => Promise.resolve(ok(value));
}

// #[effects(add: [])]
function fail<E>(error: E): Task<never, E> {
  return () => Promise.resolve(err(error));
}

// #[effects(add: [])]
function fromResult<T, E>(result: Result<T, E>): Task<T, E> {
  return () => Promise.resolve(result);
}

// #[effects(add: [])]
function fromAsyncResult<T, E>(work: () => AsyncResult<T, E>): Task<T, E> {
  return work;
}

// #[effects(add: [])]
function fromPromise<T>(body: () => Promise<T>): Task<T, Failure>;
function fromPromise<T, E>(body: () => Promise<T>, mapFailure: (error: unknown) => E): Task<T, E>;
function fromPromise<T, E>(
  body: () => Promise<T>,
  mapFailure?: (error: unknown) => E,
): Task<T, E | Failure> {
  return async () => {
    try {
      return ok(await body());
    } catch (error) {
      return err(mapFailure ? mapFailure(error) : failureFromUnknown(error));
    }
  };
}

// #[effects(add: [])]
function map<A, B, E>(
  task: Task<A, E>,
  project: (value: A) => B,
): Task<B, E> {
  return async () => {
    const result = await task();
    return isErr(result) ? result : ok(project(result.value));
  };
}

// #[effects(add: [])]
function mapError<A, E1, E2>(
  task: Task<A, E1>,
  project: (error: E1) => E2,
): Task<A, E2 | Failure> {
  return async () => {
    const result = await task();
    if (isOk(result)) {
      return result;
    }

    try {
      return err(project(result.error));
    } catch (error) {
      return err(failureFromUnknown(error));
    }
  };
}

// #[effects(add: [])]
function flatMap<A, B, E1, E2>(
  task: Task<A, E1>,
  project: (value: A) => Task<B, E2>,
): Task<B, E1 | E2> {
  return async () => {
    const result = await task();
    if (isErr(result)) {
      return result;
    }
    return await project(result.value)();
  };
}

// #[effects(add: [])]
function recover<A, B, E>(
  task: Task<A, E>,
  project: (error: E) => B | Promise<B> | Result<B, Failure> | AsyncResult<B, Failure>,
): Task<A | B, Failure> {
  return async () => {
    const result = await task();
    if (isOk(result)) {
      return result;
    }

    try {
      const recovered = await project(result.error);
      return isResult<B, Failure>(recovered) ? recovered : ok(recovered);
    } catch (error) {
      return err(failureFromUnknown(error));
    }
  };
}

// #[effects(add: [])]
function tap<A, E>(
  task: Task<A, E>,
  effect: (value: A) => unknown | Promise<unknown>,
): Task<A, E | Failure> {
  return async () => {
    const result = await task();
    if (isErr(result)) {
      return result;
    }

    try {
      await effect(result.value);
      return result;
    } catch (error) {
      return err(failureFromUnknown(error));
    }
  };
}

// #[effects(add: [])]
function tapError<A, E>(
  task: Task<A, E>,
  effect: (error: E) => unknown | Promise<unknown>,
): Task<A, E | Failure> {
  return async () => {
    const result = await task();
    if (isOk(result)) {
      return result;
    }

    try {
      await effect(result.error);
      return result;
    } catch (error) {
      return err(failureFromUnknown(error));
    }
  };
}

// #[effects(add: [])]
function all<T extends TaskCollection>(tasks: T): Task<TaskAllResult<T>, TaskAllFailure<T>> {
  return async () => {
    const isArrayInput = Array.isArray(tasks);
    const entries = isArrayInput
      ? (tasks as readonly Task<unknown, unknown>[]).map((task, index) => [index, task] as const)
      : Object.entries(tasks);
    const results = await Promise.all(entries.map(([, task]) => task()));
    const output: unknown[] | Record<string, unknown> = isArrayInput ? [] : {};

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (isErr(result)) {
        return result as Result<TaskAllResult<T>, TaskAllFailure<T>>;
      }

      const [key] = entries[index];
      if (isArrayInput) {
        (output as unknown[])[key as number] = result.value;
      } else {
        (output as Record<string, unknown>)[key as string] = result.value;
      }
    }

    return ok(output as TaskAllResult<T>);
  };
}

// #[effects(add: [])]
function race<T, E>(
  tasks: readonly [Task<T, E>, ...Task<T, E>[]],
): Task<T, E> {
  return async () => await Promise.race(tasks.map((task) => task()));
}

// #[effects(add: [])]
function timeout<T, E>(task: Task<T, E>, duration: Duration): Task<T, E | TimeoutFailure> {
  return async () => {
    let timeoutId: number | undefined;

    try {
      const timeoutPromise = new Promise<Result<T, E | TimeoutFailure>>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(err(new TimeoutFailure(duration)));
        }, duration.milliseconds);
      });

      return await Promise.race([
        task(),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  };
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

const promiseFunctor: Functor<PromiseF> = {
  map<A, B>(value: Promise<A>, f: (value: A) => B): Promise<B> {
    return value.then(f);
  },
};

const promiseApplicative: Applicative<PromiseF> = {
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

const promiseMonad: Monad<PromiseF> = {
  ...promiseApplicative,
  flatMap<A, B>(value: Promise<A>, f: (value: A) => Promise<B>): Promise<B> {
    return value.then(f);
  },
};

const promiseAsyncMonad: AsyncMonad<PromiseF> = {
  ...promiseMonad,
  fromPromise<A>(promise: Promise<A>): Promise<A> {
    return promise;
  },
};

function taskFunctor<E>(): Functor<Bind<TaskF, [E]>> {
  return createTaskMonad<E>();
}

function taskApplicative<E>(): Applicative<Bind<TaskF, [E]>> {
  return createTaskMonad<E>();
}

function taskMonad<E>(): Monad<Bind<TaskF, [E]>> {
  return createTaskMonad<E>();
}

function taskAsyncMonad<E>(): AsyncMonad<Bind<TaskF, [E]>> {
  const monad = createTaskMonad<E>();
  return {
    ...monad,
    fromPromise<A>(promise: Promise<A>): Task<A, E> {
      return fromPromise(() => promise, (error) => failureFromUnknown(error) as E);
    },
  };
}

export const Task = Object.freeze({
  succeed,
  fail,
  fromResult,
  fromAsyncResult,
  fromPromise,
  map,
  mapError,
  flatMap,
  recover,
  tap,
  tapError,
  all,
  race,
  timeout,
  functor: taskFunctor,
  applicative: taskApplicative,
  monad: taskMonad,
  asyncMonad: taskAsyncMonad,
  promiseFunctor,
  promiseApplicative,
  promiseMonad,
  promiseAsyncMonad,
}) satisfies TaskModule;
