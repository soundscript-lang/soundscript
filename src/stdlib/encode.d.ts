import type { Bind, Kind3, TypeLambda } from 'sts:hkt';
import { Failure } from 'sts:failures';
import type { Option, Result } from 'sts:result';
import type { Contravariant } from 'sts:typeclasses';

export type EncodeMode = 'sync' | 'async';
export type EncodePathSegment = string | number;
export type EncodePath = readonly EncodePathSegment[];
export type EncodeIssue = {
  readonly code: string;
  readonly input?: unknown;
  readonly message: string;
  readonly path: EncodePath;
};
export type EncodeRefinementContext = {
  readonly path: EncodePath;
  issue(code: string, message: string, input?: unknown): EncodeIssue;
};
export type EncodeRefinementResult = boolean | string | EncodeIssue | readonly EncodeIssue[];
export type EncodeOutput<T, E, M extends EncodeMode = 'sync'> = M extends 'async'
  ? Promise<Result<T, E>>
  : Result<T, E>;

export class EncodeFailure extends Failure {
  readonly path: EncodePath;
  constructor(
    message?: string,
    options?: Readonly<{
      cause?: unknown;
      path?: EncodePath;
    }>,
  );
  at(segment: EncodePathSegment): this;
}

// #[variance(T: in, TEncoded: out, E: out, M: out)]
export type Encoder<T, TEncoded = unknown, E = EncodeFailure, M extends EncodeMode = 'sync'> = {
  readonly __encodeMode?: M;
  encode(value: T): EncodeOutput<TEncoded, E, M>;
  validateEncode(value: T): EncodeOutput<TEncoded, readonly EncodeIssue[], M>;
};

// #[variance(T: in, TEncoded: out, E: out, M: out)]
export type OptionalEncoder<T, TEncoded = T, E = EncodeFailure, M extends EncodeMode = 'sync'> =
  Encoder<T | undefined, TEncoded | undefined, E, M> & {
    readonly __soundscriptOptional: true;
    readonly inner: Encoder<T, TEncoded, E, M>;
  };

type EncoderInput<TEncoder> = TEncoder extends Encoder<infer TValue, unknown, unknown, EncodeMode>
  ? TValue
  : never;
type EncoderOutputValue<TEncoder> = TEncoder extends Encoder<
  unknown,
  infer TEncoded,
  unknown,
  EncodeMode
> ? TEncoded
  : never;
type EncoderError<TEncoder> = TEncoder extends Encoder<unknown, unknown, infer E, EncodeMode> ? E
  : never;
type EncoderModeOf<TEncoder> = TEncoder extends Encoder<unknown, unknown, unknown, infer M> ? M
  : never;
type MergeEncodeModes<M extends EncodeMode> = [M] extends [never] ? 'sync'
  : [M] extends ['sync'] ? 'sync'
  : 'async';
type ObjectShape = Record<string, Encoder<unknown, unknown, unknown, EncodeMode>>;
type TupleShape = readonly Encoder<unknown, unknown, unknown, EncodeMode>[];
type OptionalShapeKeys<TShape extends ObjectShape> = {
  readonly [K in keyof TShape]-?: TShape[K] extends OptionalEncoder<unknown, unknown, unknown, EncodeMode>
    ? K
    : never;
}[keyof TShape];
type RequiredShapeKeys<TShape extends ObjectShape> = Exclude<keyof TShape, OptionalShapeKeys<TShape>>;
type ObjectInputOfShape<TShape extends ObjectShape> =
  & {
    readonly [K in RequiredShapeKeys<TShape>]: EncoderInput<TShape[K]>;
  }
  & {
    readonly [K in OptionalShapeKeys<TShape>]?: EncoderInput<TShape[K]>;
  };
type ObjectOutputOfShape<TShape extends ObjectShape> =
  & {
    readonly [K in RequiredShapeKeys<TShape>]: EncoderOutputValue<TShape[K]>;
  }
  & {
    readonly [K in OptionalShapeKeys<TShape>]?: EncoderOutputValue<TShape[K]>;
  };
type ShapeEncodeMode<TShape extends ObjectShape> = MergeEncodeModes<
  EncoderModeOf<TShape[keyof TShape]>
>;
type TupleEncodeMode<TElements extends TupleShape> = MergeEncodeModes<
  EncoderModeOf<TElements[number]>
>;

export interface EncoderF extends TypeLambda {
  readonly type: Encoder<this['Args'][2], this['Args'][1], this['Args'][0]>;
}

export type EncoderKind<E, TEncoded, T> = Kind3<EncoderF, E, TEncoded, T>;

export function fromEncode<T, TEncoded, E, M extends EncodeMode = 'sync'>(
  encode: (value: T) => Result<TEncoded, E> | Promise<Result<TEncoded, E>>,
  validateEncode?: (
    value: T,
  ) => Result<TEncoded, readonly EncodeIssue[]> | Promise<Result<TEncoded, readonly EncodeIssue[]>>,
): Encoder<T, TEncoded, E, M>;
export function contramap<A, B, TEncoded, E>(
  encoder: Encoder<A, TEncoded, E>,
  project: (value: B) => A,
): Encoder<B, TEncoded, E>;
export function contramap<
  A,
  B,
  TEncoded,
  E,
  M extends EncodeMode,
  TProjected extends A | Promise<A>,
>(
  encoder: Encoder<A, TEncoded, E, M>,
  project: (value: B) => TProjected,
): Encoder<B, TEncoded, E, MergeEncodeModes<M | (TProjected extends Promise<unknown> ? 'async' : 'sync')>>;
export function encoderContravariant<TEncoded, E = EncodeFailure>(): Contravariant<
  Bind<Bind<EncoderF, [E]>, [TEncoded]>
>;

export const stringEncoder: Encoder<string, string>;
export const numberEncoder: Encoder<number, number>;
export const booleanEncoder: Encoder<boolean, boolean>;
export const bigintEncoder: Encoder<bigint, bigint>;
export const undefinedEncoder: Encoder<undefined, undefined>;
export function refine<T, TEncoded, E, M extends EncodeMode>(
  encoder: Encoder<T, TEncoded, E, M>,
  predicate: (value: T, ctx: EncodeRefinementContext) => value is T,
  message: string,
): Encoder<T, TEncoded, E | EncodeFailure, M>;
export function refine<
  T,
  TEncoded,
  E,
  M extends EncodeMode,
  TResult extends EncodeRefinementResult | Promise<EncodeRefinementResult>,
>(
  encoder: Encoder<T, TEncoded, E, M>,
  predicate: (value: T, ctx: EncodeRefinementContext) => TResult,
  message: string,
): Encoder<
  T,
  TEncoded,
  E | EncodeFailure,
  MergeEncodeModes<M | (TResult extends Promise<unknown> ? 'async' : 'sync')>
>;

export function optional<TEncoder extends Encoder<unknown, unknown, unknown, EncodeMode>>(
  encoder: TEncoder,
): OptionalEncoder<
  Exclude<EncoderInput<TEncoder>, undefined>,
  Exclude<EncoderOutputValue<TEncoder>, undefined>,
  EncoderError<TEncoder>,
  EncoderModeOf<TEncoder>
>;
export function optional<T, TEncoded, E, M extends EncodeMode>(
  encoder: Encoder<T, TEncoded, E, M>,
): OptionalEncoder<Exclude<T, undefined>, Exclude<TEncoded, undefined>, E, M>;
export function undefinedable<T, TEncoded, E, M extends EncodeMode>(
  encoder: Encoder<T, TEncoded, E, M>,
): Encoder<T | undefined, TEncoded | undefined, E, M>;
export function lazy<TEncoder extends Encoder<unknown, unknown, unknown, EncodeMode>>(
  getEncoder: () => TEncoder,
): Encoder<
  EncoderInput<TEncoder>,
  EncoderOutputValue<TEncoder>,
  EncoderError<TEncoder>,
  EncoderModeOf<TEncoder>
>;
export function lazy<T, TEncoded, E, M extends EncodeMode>(
  getEncoder: () => Encoder<T, TEncoded, E, M>,
): Encoder<T, TEncoded, E, M>;
export function nullable<T, TEncoded, E, M extends EncodeMode>(
  encoder: Encoder<T, TEncoded, E, M>,
): Encoder<T | null, TEncoded | null, E, M>;
export function literal<const T extends string | number | boolean | null>(value: T): Encoder<T, T>;
export function array<T, TEncoded, E, M extends EncodeMode>(
  item: Encoder<T, TEncoded, E, M>,
): Encoder<readonly T[], readonly TEncoded[], E | EncodeFailure, M>;
export function record<T, TEncoded, E, M extends EncodeMode>(
  valueEncoder: Encoder<T, TEncoded, E, M>,
): Encoder<Readonly<Record<string, T>>, Readonly<Record<string, TEncoded>>, E | EncodeFailure, M>;
export function tuple<const TElements extends TupleShape>(
  ...elements: TElements
): Encoder<
  { readonly [K in keyof TElements]: EncoderInput<TElements[K]> },
  { readonly [K in keyof TElements]: EncoderOutputValue<TElements[K]> },
  EncoderError<TElements[number]>,
  TupleEncodeMode<TElements>
>;
export function option<T, TEncoded, E, M extends EncodeMode>(
  item: Encoder<T, TEncoded, E, M>,
): Encoder<
  Option<T>,
  { readonly tag: 'none' } | {
    readonly tag: 'some';
    readonly value: TEncoded;
  },
  E,
  M
>;
export function result<
  T,
  EValue,
  TEncoded,
  EEncoded,
  EOk,
  EErr,
  MOk extends EncodeMode,
  MErr extends EncodeMode,
>(
  okEncoder: Encoder<T, TEncoded, EOk, MOk>,
  errEncoder: Encoder<EValue, EEncoded, EErr, MErr>,
): Encoder<
  Result<T, EValue>,
  { readonly tag: 'ok'; readonly value: TEncoded } | {
    readonly error: EEncoded;
    readonly tag: 'err';
  },
  EOk | EErr,
  MergeEncodeModes<MOk | MErr>
>;
export function object<TShape extends ObjectShape>(
  shape: TShape,
): Encoder<
  ObjectInputOfShape<TShape>,
  ObjectOutputOfShape<TShape>,
  EncoderError<TShape[keyof TShape]> | EncodeFailure,
  ShapeEncodeMode<TShape>
>;
