import type { Bind, Kind2, TypeLambda } from 'sts:hkt';
import { Failure } from 'sts:failures';
import type { Result } from 'sts:result';
import type { Applicative, AsyncMonad, Functor, Monad } from 'sts:typeclasses';

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
  constructor(ms: number, cause?: unknown);
}

export function succeed<T>(value: T): Task<T, never>;
export function fail<E>(error: E): Task<never, E>;
export function fromResult<T, E>(result: Result<T, E>): Task<T, E>;
export function fromPromise<T>(fn: (signal?: AbortSignalLike) => Promise<T>): Task<T, Error>;
export function fromPromise<T, E>(
  fn: (signal?: AbortSignalLike) => Promise<T>,
  mapError: (error: Error) => E,
): Task<T, E>;
export function map<A, B, E>(
  task: Task<A, E>,
  project: (value: A) => B,
): Task<B, E>;
export function mapError<A, E1, E2>(
  task: Task<A, E1>,
  project: (error: E1) => E2,
): Task<A, E2 | Error>;
export function flatMap<A, B, E1, E2>(
  task: Task<A, E1>,
  project: (value: A) => Task<B, E2>,
): Task<B, E1 | E2>;
export function recover<A, B, E>(
  task: Task<A, E>,
  project: (error: E) => B | Promise<B>,
): Task<A | B, Error>;
export function tap<A, E>(
  task: Task<A, E>,
  effect: (value: A) => unknown | Promise<unknown>,
): Task<A, E | Error>;
export function tapError<A, E>(
  task: Task<A, E>,
  effect: (error: E) => unknown | Promise<unknown>,
): Task<A, E | Error>;
export function parallel<T, E>(tasks: readonly Task<T, E>[]): Task<readonly T[], E>;
export function race<T, E>(
  tasks: readonly [Task<T, E>, ...Task<T, E>[]],
): Task<T, E>;
export function timeout<T, E>(task: Task<T, E>, ms: number): Task<T, E | TimeoutFailure>;

export function taskFunctor<E>(): Functor<Bind<TaskF, [E]>>;
export function taskApplicative<E>(): Applicative<Bind<TaskF, [E]>>;
export function taskMonad<E>(): Monad<Bind<TaskF, [E]>>;
export function taskAsyncMonad<E>(): AsyncMonad<Bind<TaskF, [E]>>;

export const promiseFunctor: Functor<PromiseF>;
export const promiseApplicative: Applicative<PromiseF>;
export const promiseMonad: Monad<PromiseF>;
export const promiseAsyncMonad: AsyncMonad<PromiseF>;
