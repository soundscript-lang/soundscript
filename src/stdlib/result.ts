import { normalizeThrown } from 'sts:failures';
import { type Bind, type Kind, type Kind2, type TypeLambda } from 'sts:hkt';
import { type Applicative, type Functor, type Monad } from 'sts:typeclasses';
import {
  __valueFactory,
  __valueKey,
  __valueReadonly,
  __valueShallowToken,
} from 'sts:value';

const makeOk = __valueFactory<Ok<unknown>, [unknown]>(
  (value) => __valueKey('ok', __valueShallowToken(value)),
  () => Object.create(Ok.prototype) as Ok<unknown>,
  (instance, value) => {
    __valueReadonly(instance, 'tag', 'ok');
    __valueReadonly(instance, 'value', value);
  },
);

const makeErr = __valueFactory<Err<unknown>, [unknown]>(
  (error) => __valueKey('err', __valueShallowToken(error)),
  () => Object.create(Err.prototype) as Err<unknown>,
  (instance, error) => {
    __valueReadonly(instance, 'tag', 'err');
    __valueReadonly(instance, 'error', error);
  },
);

const makeSome = __valueFactory<Some<unknown>, [unknown]>(
  (value) => __valueKey('some', __valueShallowToken(value)),
  () => Object.create(Some.prototype) as Some<unknown>,
  (instance, value) => {
    __valueReadonly(instance, 'tag', 'some');
    __valueReadonly(instance, 'value', value);
  },
);

const makeNone = __valueFactory<None, []>(
  () => __valueKey('none'),
  () => Object.create(None.prototype) as None,
  (instance) => {
    __valueReadonly(instance, 'tag', 'none');
  },
);

// #[variance(T: out)]
export class Ok<T> {
  readonly tag!: 'ok';
  readonly value!: T;

  constructor(value: T) {
    return makeOk(value) as Ok<T>;
  }
}

// #[variance(E: out)]
export class Err<E> {
  readonly tag!: 'err';
  readonly error!: E;

  constructor(error: E) {
    return makeErr(error) as Err<E>;
  }
}

// #[variance(T: out, E: out)]
export type Result<T, E> = Ok<T> | Err<E>;

// #[variance(T: out)]
export class Some<T> {
  readonly tag!: 'some';
  readonly value!: T;

  constructor(value: T) {
    return makeSome(value) as Some<T>;
  }
}

export class None {
  readonly tag!: 'none';

  constructor() {
    return makeNone();
  }
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

export function ok<T>(value: T): Result<T, never> {
  return new Ok(value);
}

export function err(): Result<never, void>;
export function err<E>(error: E): Result<never, E>;
export function err<E>(error?: E): Result<never, E | void> {
  return new Err(error);
}

export function some<T>(value: T): Option<T> {
  return new Some(value);
}

export function none(): Option<never> {
  return new None();
}

export function isOk<T, E>(value: Result<T, E>): value is Ok<T> {
  return value instanceof Ok;
}

export function isErr<T, E>(value: Result<T, E>): value is Err<E> {
  return value instanceof Err;
}

export function isSome<T>(value: Option<T>): value is Some<T> {
  return value instanceof Some;
}

export function isNone<T>(value: Option<T>): value is None {
  return value instanceof None;
}

function isPromiseInstance<T>(value: unknown): value is Promise<T> {
  return value instanceof Promise;
}

export function resultOf<T>(fn: () => Promise<T>): Promise<Result<T, Error>>;
export function resultOf<T, E>(
  fn: () => Promise<T>,
  mapError: (error: Error) => E,
): Promise<Result<T, E>>;
export function resultOf<T>(fn: () => T): Result<T, Error>;
export function resultOf<T, E>(fn: () => T, mapError: (error: Error) => E): Result<T, E>;
export function resultOf<T, E>(
  fn: () => T | Promise<T>,
  mapError?: (error: Error) => E,
): Result<T, E | Error> | Promise<Result<T, E | Error>> {
  try {
    const value = fn();
    if (isPromiseInstance<T>(value)) {
      return value.then(
        (resolved) => ok(resolved),
        (error) => {
          const normalized = normalizeThrown(error);
          return err(mapError ? mapError(normalized) : normalized);
        },
      );
    }
    return ok(value);
  } catch (error) {
    const normalized = normalizeThrown(error);
    return err(mapError ? mapError(normalized) : normalized);
  }
}

export function mapErr<T, E1, E2>(
  value: Result<T, E1>,
  project: (error: E1) => E2,
): Result<T, E2> {
  return isErr(value) ? err(project(value.error)) : value;
}

export function tapErr<T, E>(
  value: Result<T, E>,
  effect: (error: E) => unknown,
): Result<T, E> {
  if (isErr(value)) {
    effect(value.error);
  }
  return value;
}

export function unwrapOr<T, E>(value: Result<T, E>, fallback: T): T {
  return isOk(value) ? value.value : fallback;
}

export function unwrapOrElse<T, E>(value: Result<T, E>, fallback: (error: E) => T): T {
  return isOk(value) ? value.value : fallback(value.error);
}

export function collect<T, E>(values: readonly Result<T, E>[]): Result<readonly T[], E> {
  const collectedValues: T[] = [];
  for (const value of values) {
    if (isErr(value)) {
      return value;
    }
    collectedValues.push(value.value);
  }
  return ok(collectedValues);
}

function mapOption<A, B>(value: Option<A>, f: (value: A) => B): Option<B> {
  return isSome(value) ? some(f(value.value)) : value;
}

function apOption<A, B>(
  fn: Option<(value: A) => B>,
  value: Option<A>,
): Option<B> {
  if (!isSome(fn)) {
    return fn;
  }
  return isSome(value) ? some(fn.value(value.value)) : value;
}

function flatMapOption<A, B>(value: Option<A>, f: (value: A) => Option<B>): Option<B> {
  return isSome(value) ? f(value.value) : value;
}

const optionMonadImpl: Monad<OptionF> = {
  ap: apOption,
  flatMap: flatMapOption,
  map: mapOption,
  pure: some,
};

export const optionFunctor: Functor<OptionF> = optionMonadImpl;
export const optionApplicative: Applicative<OptionF> = optionMonadImpl;
export const optionMonad: Monad<OptionF> = optionMonadImpl;

function mapResult<E, A, B>(value: Result<A, E>, f: (value: A) => B): Result<B, E> {
  return isOk(value) ? ok(f(value.value)) : value;
}

function apResult<E, A, B>(
  fn: Result<(value: A) => B, E>,
  value: Result<A, E>,
): Result<B, E> {
  if (!isOk(fn)) {
    return fn;
  }
  return isOk(value) ? ok(fn.value(value.value)) : value;
}

function flatMapResult<E, A, B>(
  value: Result<A, E>,
  f: (value: A) => Result<B, E>,
): Result<B, E> {
  return isOk(value) ? f(value.value) : value;
}

function createResultMonad<E>(): Monad<Bind<ResultF, [E]>> {
  return {
    ap: apResult,
    flatMap: flatMapResult,
    map: mapResult,
    pure: ok,
  };
}

export function resultFunctor<E>(): Functor<Bind<ResultF, [E]>> {
  return createResultMonad<E>();
}

export function resultApplicative<E>(): Applicative<Bind<ResultF, [E]>> {
  return createResultMonad<E>();
}

export function resultMonad<E>(): Monad<Bind<ResultF, [E]>> {
  return createResultMonad<E>();
}

function macroRuntimeError(name: string): never {
  throw new Error(
    `${name}(...) is a soundscript macro and should be removed during soundscript expansion.`,
  );
}

export function Try<T, E>(value: Result<T, E>): T;
export function Try(_value: unknown): never {
  return macroRuntimeError('Try');
}
