import type { Bind, Kind3, TypeLambda } from 'sts:hkt';
import { Failure } from 'sts:failures';
import type { Option, Result } from 'sts:result';
import type { Contravariant } from 'sts:typeclasses';

export class EncodeFailure extends Failure {
  constructor(message?: string, cause?: unknown);
}

// #[variance(T: in, TEncoded: out, E: out)]
export type Encoder<T, TEncoded = unknown, E = EncodeFailure> = {
  encode(value: T): Result<TEncoded, E>;
};

// #[variance(T: in, TEncoded: out, E: out)]
export type OptionalEncoder<T, TEncoded = T, E = EncodeFailure> =
  Encoder<T | undefined, TEncoded | undefined, E> & {
    readonly __soundscriptOptional: true;
    readonly inner: Encoder<T, TEncoded, E>;
  };

type EncoderInput<TEncoder> = TEncoder extends Encoder<infer TValue, unknown, unknown> ? TValue
  : never;
type EncoderOutput<TEncoder> = TEncoder extends Encoder<unknown, infer TEncoded, unknown>
  ? TEncoded
  : never;
type EncoderError<TEncoder> = TEncoder extends Encoder<unknown, unknown, infer E> ? E : never;
type ObjectShape = Record<string, Encoder<unknown, unknown, unknown>>;
type TupleShape = readonly Encoder<unknown, unknown, unknown>[];

export interface EncoderF extends TypeLambda {
  readonly type: Encoder<this['Args'][2], this['Args'][1], this['Args'][0]>;
}

export type EncoderKind<E, TEncoded, T> = Kind3<EncoderF, E, TEncoded, T>;

export function fromEncode<T, TEncoded, E>(
  encode: (value: T) => Result<TEncoded, E>,
): Encoder<T, TEncoded, E>;
export function contramap<A, B, TEncoded, E>(
  encoder: Encoder<A, TEncoded, E>,
  project: (value: B) => A,
): Encoder<B, TEncoded, E>;
export function encoderContravariant<TEncoded, E = EncodeFailure>(): Contravariant<
  Bind<Bind<EncoderF, [E]>, [TEncoded]>
>;

export const stringEncoder: Encoder<string, string>;
export const numberEncoder: Encoder<number, number>;
export const booleanEncoder: Encoder<boolean, boolean>;
export const bigintEncoder: Encoder<bigint, bigint>;

export function optional<T, TEncoded, E>(
  encoder: Encoder<T, TEncoded, E>,
): OptionalEncoder<T, TEncoded, E>;
export function lazy<T, TEncoded, E>(
  getEncoder: () => Encoder<T, TEncoded, E>,
): Encoder<T, TEncoded, E>;
export function nullable<T, TEncoded, E>(
  encoder: Encoder<T, TEncoded, E>,
): Encoder<T | null, TEncoded | null, E>;
export function literal<const T extends string | number | boolean | null>(value: T): Encoder<T, T>;
export function array<T, TEncoded, E>(
  item: Encoder<T, TEncoded, E>,
): Encoder<readonly T[], readonly TEncoded[], E | EncodeFailure>;
export function tuple<const TElements extends TupleShape>(
  ...elements: TElements
): Encoder<
  { readonly [K in keyof TElements]: EncoderInput<TElements[K]> },
  { readonly [K in keyof TElements]: EncoderOutput<TElements[K]> },
  EncoderError<TElements[number]>
>;
export function option<T, TEncoded, E>(
  item: Encoder<T, TEncoded, E>,
): Encoder<
  Option<T>,
  { readonly tag: 'none' } | {
    readonly tag: 'some';
    readonly value: TEncoded;
  },
  E
>;
export function result<T, EValue, TEncoded, EEncoded, EOk, EErr>(
  okEncoder: Encoder<T, TEncoded, EOk>,
  errEncoder: Encoder<EValue, EEncoded, EErr>,
): Encoder<
  Result<T, EValue>,
  { readonly tag: 'ok'; readonly value: TEncoded } | {
    readonly error: EEncoded;
    readonly tag: 'err';
  },
  EOk | EErr
>;
export function object<TShape extends ObjectShape>(
  shape: TShape,
): Encoder<
  { readonly [K in keyof TShape]: EncoderInput<TShape[K]> },
  { readonly [K in keyof TShape]: EncoderOutput<TShape[K]> },
  EncoderError<TShape[keyof TShape]> | EncodeFailure
>;
