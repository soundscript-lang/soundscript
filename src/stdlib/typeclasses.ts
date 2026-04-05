import type { Binder, BoundEffect, Kind, MonadTypeLambda, TypeLambda } from 'sts:hkt';

export interface Contravariant<F extends TypeLambda> {
  readonly __type_lambda?: F;
  contramap<A, B>(value: Kind<F, A>, project: (value: B) => A): Kind<F, B>;
}

export interface Invariant<F extends TypeLambda> {
  readonly __type_lambda?: F;
  imap<A, B>(
    value: Kind<F, A>,
    decodeMap: (value: A) => B,
    encodeMap: (value: B) => A,
  ): Kind<F, B>;
}

export interface Functor<F extends TypeLambda> {
  readonly __type_lambda?: F;
  map<A, B>(value: Kind<F, A>, f: (value: A) => B): Kind<F, B>;
}

export interface Applicative<F extends TypeLambda> extends Functor<F> {
  ap<A, B>(fn: Kind<F, (value: A) => B>, value: Kind<F, A>): Kind<F, B>;
  pure<A>(value: A): Kind<F, A>;
}

export interface Monad<F extends TypeLambda> extends Applicative<F> {
  flatMap<A, B>(value: Kind<F, A>, f: (value: A) => Kind<F, B>): Kind<F, B>;
}

export interface AsyncMonad<F extends TypeLambda> extends Monad<F> {
  fromPromise<A>(promise: Promise<A>): Kind<F, A>;
}

function runGenerator<F extends TypeLambda, T>(
  monad: Monad<F>,
  iterator: Generator<Kind<F, unknown>, T, unknown>,
  input?: unknown,
): Kind<F, T> {
  const step = iterator.next(input as never);
  if (step.done) {
    return monad.pure(step.value);
  }

  return monad.flatMap(step.value, (nextInput) => runGenerator(monad, iterator, nextInput));
}

export function monadGen<F extends TypeLambda, T>(
  monad: Monad<F>,
  factory: () => Generator<Kind<F, unknown>, T, unknown>,
): Kind<F, T> {
  return runGenerator(monad, factory());
}

function bindValue<F extends TypeLambda>(_monad: Monad<F>) {
  return function bindRuntimeValue<A>(_effect: BoundEffect<F, A>, value: unknown): A {
    return value as A;
  };
}

export type DoBinder<M extends Monad<TypeLambda>> = Binder<MonadTypeLambda<M>>;

class DoBindSignal<F extends TypeLambda> {
  readonly effect: Kind<F, unknown>;

  constructor(effect: Kind<F, unknown>) {
    this.effect = effect;
  }
}

function executeDoBody<F extends TypeLambda, T>(
  body: (bind: Binder<F>) => T,
  resolvedValues: readonly unknown[],
): { done: true; value: T } | { done: false; effect: Kind<F, unknown> } {
  let index = 0;
  function bind<A>(effect: BoundEffect<F, A>): A {
    if (index < resolvedValues.length) {
      return resolvedValues[index++] as A;
    }
    throw new DoBindSignal(effect);
  }

  try {
    return { done: true, value: body(bind) };
  } catch (error) {
    if (error instanceof DoBindSignal) {
      return { done: false, effect: error.effect };
    }
    throw error;
  }
}

async function executeAsyncDoBody<F extends TypeLambda, T>(
  body: (bind: Binder<F>) => T | Promise<T>,
  resolvedValues: readonly unknown[],
): Promise<{ done: true; value: T } | { done: false; effect: Kind<F, unknown> }> {
  let index = 0;
  function bind<A>(effect: BoundEffect<F, A>): A {
    if (index < resolvedValues.length) {
      return resolvedValues[index++] as A;
    }
    throw new DoBindSignal(effect);
  }

  try {
    return { done: true, value: await body(bind) };
  } catch (error) {
    if (error instanceof DoBindSignal) {
      return { done: false, effect: error.effect };
    }
    throw error;
  }
}

function runDo<F extends TypeLambda, T>(
  monad: Monad<F>,
  body: (bind: Binder<F>) => T,
  resolvedValues: readonly unknown[] = [],
): Kind<F, T> {
  const step = executeDoBody(body, resolvedValues);
  if (step.done) {
    return monad.pure(step.value);
  }
  return monad.flatMap(step.effect, (value) => runDo(monad, body, [...resolvedValues, value]));
}

function runAsyncDo<F extends TypeLambda, T>(
  monad: AsyncMonad<F>,
  body: (bind: Binder<F>) => T | Promise<T>,
  resolvedValues: readonly unknown[] = [],
): Kind<F, T> {
  return monad.flatMap(
    monad.fromPromise(executeAsyncDoBody(body, resolvedValues)),
    (step) =>
      step.done ? monad.pure(step.value) : monad.flatMap(
        step.effect,
        (value) => runAsyncDo(monad, body, [...resolvedValues, value]),
      ),
  );
}

export interface DoRuntime {
  <F extends TypeLambda, T>(
    monad: Monad<F>,
    body: (bind: Binder<F>) => T,
  ): Kind<F, T>;
  <F extends TypeLambda, T>(
    monad: AsyncMonad<F>,
    body: (bind: Binder<F>) => T | Promise<T>,
  ): Kind<F, T>;
  readonly macroBind: <F extends TypeLambda>(
    monad: Monad<F>,
  ) => <A>(effect: BoundEffect<F, A>, value: unknown) => A;
  readonly macroGen: typeof monadGen;
}

function createDoRuntime(): DoRuntime {
  function runtime<F extends TypeLambda, T>(
    monad: Monad<F>,
    body: (bind: Binder<F>) => T | Promise<T>,
  ): Kind<F, T> {
    return 'fromPromise' in monad
      ? runAsyncDo(monad as AsyncMonad<F>, body, [])
      : runDo(monad, body as (bind: Binder<F>) => T, []);
  }

  const doRuntime = runtime as DoRuntime;
  Object.assign(doRuntime, { macroBind: bindValue, macroGen: monadGen });
  return doRuntime;
}

// The compiler lowers `Do(...)` to `Do.macroGen(...)`, but keep a callable runtime bridge.
export const Do = createDoRuntime();
