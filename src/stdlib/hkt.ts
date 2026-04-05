export interface TypeLambda {
  readonly Args: readonly unknown[];
  readonly type: unknown;
}

export type Apply<F extends TypeLambda, Args extends readonly unknown[]> = F extends {
  readonly __target: infer Target extends TypeLambda;
  readonly __prefix: infer Prefix extends readonly unknown[];
} ? Apply<Target, [...Prefix, ...Args]>
  : (F & { readonly Args: Args })['type'];

export type Bind<F extends TypeLambda, Prefix extends readonly unknown[]> = TypeLambda & {
  readonly __target: F;
  readonly __prefix: Prefix;
};

export type Kind<F extends TypeLambda, A> = Apply<F, [A]>;
export type Kind2<F extends TypeLambda, A, B> = Apply<F, [A, B]>;
export type Kind3<F extends TypeLambda, A, B, C> = Apply<F, [A, B, C]>;

export type MonadTypeLambda<M extends { readonly __type_lambda?: TypeLambda }> = M extends {
  readonly __type_lambda?: infer F extends TypeLambda;
} ? F
  : never;
export type BoundEffect<F extends TypeLambda, A = unknown> = Kind<F, A>;
export type BoundValue<F extends TypeLambda, Value> = Value extends BoundEffect<F, infer A> ? A
  : never;
export type Binder<F extends TypeLambda> = <A>(value: BoundEffect<F, A>) => A;

export type {
  Applicative,
  AsyncMonad,
  Contravariant,
  Functor,
  Invariant,
  Monad,
} from 'sts:typeclasses';
export { Do, monadGen } from 'sts:typeclasses';

// Macro binding placeholder. The compiler-owned macro pipeline consumes this symbol.
export const hkt: unknown = undefined;
