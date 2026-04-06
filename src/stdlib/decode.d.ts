import { type ErrorFrame, Failure } from 'sts:failures';
import type { Option, Result } from 'sts:result';

export type DecodePathSegment = string | number;
export type DecodePath = readonly DecodePathSegment[];

export class DecodeFailure extends Failure {
  readonly path: DecodePath;
  constructor(
    message?: string,
    options?: Readonly<{
      cause?: unknown;
      path?: DecodePath;
      trace?: readonly ErrorFrame[];
    }>,
  );
  at(segment: DecodePathSegment): this;
}

// #[variance(T: out, E: out)]
export type Decoder<T, E = DecodeFailure> = {
  decode(value: unknown): Result<T, E>;
};

// #[variance(T: out, E: out)]
export type OptionalDecoder<T, E = DecodeFailure> = Decoder<T | undefined, E> & {
  readonly __soundscriptOptional: true;
  readonly inner: Decoder<T, E>;
};

type DecoderValue<TDecoder> = TDecoder extends Decoder<infer TValue, unknown> ? TValue : never;
type DecoderError<TDecoder> = TDecoder extends Decoder<unknown, infer E> ? E : never;
type ObjectShape = Record<string, Decoder<unknown, unknown>>;
type TupleShape = readonly Decoder<unknown, unknown>[];

export const string: Decoder<string>;
export const number: Decoder<number>;
export const boolean: Decoder<boolean>;
export const bigint: Decoder<bigint>;
export function lazy<T, E>(getDecoder: () => Decoder<T, E>): Decoder<T, E>;

export function optional<T, E>(decoder: Decoder<T, E>): OptionalDecoder<T, E>;
export function nullable<T, E>(decoder: Decoder<T, E>): Decoder<T | null, E>;
export function defaulted<T, E>(decoder: Decoder<T | undefined, E>, fallback: T): Decoder<T, E>;
export function literal<const T extends string | number | boolean | null>(value: T): Decoder<T>;
export function array<T, E>(item: Decoder<T, E>): Decoder<readonly T[], E | DecodeFailure>;
export function readonlyRecord<T, E>(
  valueDecoder: Decoder<T, E>,
): Decoder<Readonly<Record<string, T>>, E | DecodeFailure>;
export function tuple<const TElements extends TupleShape>(
  ...elements: TElements
): Decoder<
  { readonly [K in keyof TElements]: DecoderValue<TElements[K]> },
  DecoderError<TElements[number]> | DecodeFailure
>;
export function option<T, E>(item: Decoder<T, E>): Decoder<Option<T>, E | DecodeFailure>;
export function result<T, EValue, EDecodeValue, EDecodeError>(
  okDecoder: Decoder<T, EDecodeValue>,
  errDecoder: Decoder<EValue, EDecodeError>,
): Decoder<Result<T, EValue>, EDecodeValue | EDecodeError | DecodeFailure>;
export function object<TShape extends ObjectShape>(
  shape: TShape,
): Decoder<
  { readonly [K in keyof TShape]: DecoderValue<TShape[K]> },
  DecoderError<TShape[keyof TShape]> | DecodeFailure
>;
export function field<K extends string, T, E>(
  key: K,
  decoder: Decoder<T, E>,
): Decoder<T, E | DecodeFailure>;
export function optionalField<K extends string, T, E>(
  key: K,
  decoder: Decoder<T, E>,
): Decoder<T | undefined, E | DecodeFailure>;
export function union<A, B, ELeft, ERight>(
  left: Decoder<A, ELeft>,
  right: Decoder<B, ERight>,
): Decoder<A | B, ELeft | ERight | DecodeFailure>;
export function map<A, B, E>(
  decoder: Decoder<A, E>,
  project: (value: A) => B,
): Decoder<B, E>;
export function andThen<A, B, E>(
  decoder: Decoder<A, E>,
  project: (value: A) => Decoder<B, E>,
): Decoder<B, E>;
export function refine<A, B extends A, E>(
  decoder: Decoder<A, E>,
  predicate: (value: A) => value is B,
  message: string,
): Decoder<B, E | DecodeFailure>;
