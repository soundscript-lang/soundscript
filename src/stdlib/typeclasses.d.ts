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

export function monadGen<F extends TypeLambda, T>(
  monad: Monad<F>,
  factory: () => Generator<Kind<F, unknown>, T, unknown>,
): Kind<F, T>;

export type DoBinder<M extends Monad<TypeLambda>> = Binder<MonadTypeLambda<M>>;

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

export const Do: DoRuntime;
