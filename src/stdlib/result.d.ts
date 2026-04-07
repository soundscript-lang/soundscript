import type { Bind, Kind, Kind2, TypeLambda } from 'sts:hkt';
import type { Applicative, Functor, Monad } from 'sts:typeclasses';

// #[variance(T: out)]
export class Ok<T> {
  readonly tag: 'ok';
  readonly value: T;
  constructor(value: T);
}
// #[variance(E: out)]
export class Err<E> {
  readonly tag: 'err';
  readonly error: E;
  constructor(error: E);
}

// #[variance(T: out, E: out)]
export type Result<T, E> = Ok<T> | Err<E>;
// #[variance(T: out)]
export class Some<T> {
  readonly tag: 'some';
  readonly value: T;
  constructor(value: T);
}
export class None {
  readonly tag: 'none';
  constructor();
}
// #[variance(T: out)]
export type Option<T> = Some<T> | None;

export interface OptionF extends TypeLambda {
  readonly type: Option<this['Args'][0]>;
}

export interface ResultF extends TypeLambda {
  readonly type: Result<this['Args'][1], this['Args'][0]>;
}

export type OptionKind<T> = Kind<OptionF, T>;
export type ResultKind<E, T> = Kind2<ResultF, E, T>;

// #[effects(add: [])]
export function ok<T>(value: T): Result<T, never>;
// #[effects(add: [])]
export function err(): Result<never, void>;
// #[effects(add: [])]
export function err<E>(error: E): Result<never, E>;
// #[effects(add: [])]
export function some<T>(value: T): Option<T>;
// #[effects(add: [])]
export function none(): Option<never>;
export function isOk<T, E>(value: Result<T, E>): value is Ok<T>;
export function isErr<T, E>(value: Result<T, E>): value is Err<E>;
export function isSome<T>(value: Option<T>): value is Some<T>;
export function isNone<T>(value: Option<T>): value is None;
// #[effects(add: [suspend.await], forward: [{ from: fn, handle: [fails] }])]
export function resultOf<T>(fn: () => Promise<T>): Promise<Result<T, Error>>;
// #[effects(add: [suspend.await], forward: [{ from: fn, handle: [fails] }, { from: mapError, rewrite: [{ from: fails, to: fails.rejects }] }])]
export function resultOf<T, E>(
  fn: () => Promise<T>,
  mapError: (error: Error) => E,
): Promise<Result<T, E>>;
// #[effects(forward: [{ from: fn, handle: [fails] }])]
export function resultOf<T>(fn: () => T): Result<T, Error>;
// #[effects(forward: [{ from: fn, handle: [fails] }, { from: mapError }])]
export function resultOf<T, E>(fn: () => T, mapError: (error: Error) => E): Result<T, E>;
export function mapErr<T, E1, E2>(
  value: Result<T, E1>,
  project: (error: E1) => E2,
): Result<T, E2>;
export function tapErr<T, E>(
  value: Result<T, E>,
  effect: (error: E) => unknown,
): Result<T, E>;
export function unwrapOr<T, E>(value: Result<T, E>, fallback: T): T;
export function unwrapOrElse<T, E>(value: Result<T, E>, fallback: (error: E) => T): T;
export function unwrapOrThrow<T, E>(value: Result<T, E>, onErr?: (error: E) => unknown): T;
export function unwrapOrThrow<T>(value: Option<T>, onNone?: () => unknown): T;
export function collect<T, E>(values: readonly Result<T, E>[]): Result<readonly T[], E>;

export const optionFunctor: Functor<OptionF>;
export const optionApplicative: Applicative<OptionF>;
export const optionMonad: Monad<OptionF>;
export function resultFunctor<E>(): Functor<Bind<ResultF, [E]>>;
export function resultApplicative<E>(): Applicative<Bind<ResultF, [E]>>;
export function resultMonad<E>(): Monad<Bind<ResultF, [E]>>;

export function Try<T, E>(value: Result<T, E>): T;
export function Try<T>(value: Option<T>): T;
