import { type ErrorFrame, Failure } from 'sts:failures';
import type { Option, Result } from 'sts:result';

export type DecodeMode = 'sync' | 'async';
export type DecodePathSegment = string | number;
export type DecodePath = readonly DecodePathSegment[];
export type DecodeIssue = {
  readonly code: string;
  readonly input?: unknown;
  readonly message: string;
  readonly path: DecodePath;
};
export type DecodeRefinementContext = {
  readonly path: DecodePath;
  issue(code: string, message: string, input?: unknown): DecodeIssue;
};
export type DecodeRefinementResult = boolean | string | DecodeIssue | readonly DecodeIssue[];
export type DecodeOutput<T, E, M extends DecodeMode = 'sync'> = M extends 'async'
  ? Promise<Result<T, E>>
  : Result<T, E>;

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

// #[variance(T: out, E: out, M: out)]
export type Decoder<T, E = DecodeFailure, M extends DecodeMode = 'sync'> = {
  readonly __decodeMode?: M;
  decode(value: unknown): DecodeOutput<T, E, M>;
  validateDecode(value: unknown): DecodeOutput<T, readonly DecodeIssue[], M>;
};

// #[variance(T: out, E: out, M: out)]
export type OptionalDecoder<T, E = DecodeFailure, M extends DecodeMode = 'sync'> =
  Decoder<T | undefined, E, M> & {
    readonly __soundscriptOptional: true;
    readonly inner: Decoder<T, E, M>;
  };

type DecoderValue<TDecoder> = TDecoder extends Decoder<infer TValue, unknown, DecodeMode>
  ? TValue
  : never;
type DecoderError<TDecoder> = TDecoder extends Decoder<unknown, infer E, DecodeMode> ? E : never;
type DecoderModeOf<TDecoder> = TDecoder extends Decoder<unknown, unknown, infer M> ? M : never;
type MergeDecodeModes<M extends DecodeMode> = [M] extends [never] ? 'sync'
  : [M] extends ['sync'] ? 'sync'
  : 'async';
type ObjectShape = Record<string, Decoder<unknown, unknown, DecodeMode>>;
type TupleShape = readonly Decoder<unknown, unknown, DecodeMode>[];
type ShapeDecodeMode<TShape extends ObjectShape> = MergeDecodeModes<
  DecoderModeOf<TShape[keyof TShape]>
>;
type TupleDecodeMode<TElements extends TupleShape> = MergeDecodeModes<
  DecoderModeOf<TElements[number]>
>;

export function fromDecode<T, E, M extends DecodeMode = 'sync'>(
  decode: (value: unknown) => Result<T, E> | Promise<Result<T, E>>,
  validateDecode?: (
    value: unknown,
  ) => Result<T, readonly DecodeIssue[]> | Promise<Result<T, readonly DecodeIssue[]>>,
): Decoder<T, E, M>;

export const string: Decoder<string>;
export const number: Decoder<number>;
export const boolean: Decoder<boolean>;
export const bigint: Decoder<bigint>;
export const undefinedValue: Decoder<undefined>;
export function lazy<TDecoder extends Decoder<unknown, unknown, DecodeMode>>(
  getDecoder: () => TDecoder,
): Decoder<DecoderValue<TDecoder>, DecoderError<TDecoder>, DecoderModeOf<TDecoder>>;
export function lazy<T, E, M extends DecodeMode>(
  getDecoder: () => Decoder<T, E, M>,
): Decoder<T, E, M>;
export function optional<TDecoder extends Decoder<unknown, unknown, DecodeMode>>(
  decoder: TDecoder,
): OptionalDecoder<Exclude<DecoderValue<TDecoder>, undefined>, DecoderError<TDecoder>, DecoderModeOf<TDecoder>>;
export function optional<T, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
): OptionalDecoder<Exclude<T, undefined>, E, M>;
export function undefinedable<T, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
): Decoder<T | undefined, E, M>;
export function nullable<T, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
): Decoder<T | null, E, M>;
export function defaulted<T, E, M extends DecodeMode>(
  decoder: Decoder<T | undefined, E, M>,
  fallback: T,
): Decoder<T, E, M>;
export function defaulted<T, E, M extends DecodeMode, TFallback extends T | Promise<T>>(
  decoder: Decoder<T | undefined, E, M>,
  fallback: () => TFallback,
): Decoder<T, E, MergeDecodeModes<M | (TFallback extends Promise<unknown> ? 'async' : 'sync')>>;
export function literal<const T extends string | number | boolean | null>(value: T): Decoder<T>;
export function array<T, E, M extends DecodeMode>(
  item: Decoder<T, E, M>,
): Decoder<readonly T[], E | DecodeFailure, M>;
export function readonlyRecord<T, E, M extends DecodeMode>(
  valueDecoder: Decoder<T, E, M>,
): Decoder<Readonly<Record<string, T>>, E | DecodeFailure, M>;
export function tuple<const TElements extends TupleShape>(
  ...elements: TElements
): Decoder<
  { readonly [K in keyof TElements]: DecoderValue<TElements[K]> },
  DecoderError<TElements[number]> | DecodeFailure,
  TupleDecodeMode<TElements>
>;
export function option<T, E, M extends DecodeMode>(
  item: Decoder<T, E, M>,
): Decoder<Option<T>, E | DecodeFailure, M>;
export function result<T, EValue, EDecodeValue, EDecodeError, MOk extends DecodeMode, MErr extends DecodeMode>(
  okDecoder: Decoder<T, EDecodeValue, MOk>,
  errDecoder: Decoder<EValue, EDecodeError, MErr>,
): Decoder<Result<T, EValue>, EDecodeValue | EDecodeError | DecodeFailure, MergeDecodeModes<MOk | MErr>>;
export function object<TShape extends ObjectShape>(
  shape: TShape,
): Decoder<
  { readonly [K in keyof TShape]: DecoderValue<TShape[K]> },
  DecoderError<TShape[keyof TShape]> | DecodeFailure,
  ShapeDecodeMode<TShape>
>;
export function field<K extends string, T, E, M extends DecodeMode>(
  key: K,
  decoder: Decoder<T, E, M>,
): Decoder<T, E | DecodeFailure, M>;
export function optionalField<K extends string, T, E, M extends DecodeMode>(
  key: K,
  decoder: Decoder<T, E, M>,
): Decoder<T | undefined, E | DecodeFailure, M>;
export function union<A, B, ELeft, ERight, MLeft extends DecodeMode, MRight extends DecodeMode>(
  left: Decoder<A, ELeft, MLeft>,
  right: Decoder<B, ERight, MRight>,
): Decoder<A | B, ELeft | ERight | DecodeFailure, MergeDecodeModes<MLeft | MRight>>;
export function map<A, B, E, M extends DecodeMode, TProjected>(
  decoder: Decoder<A, E, M>,
  project: (value: A) => TProjected,
): Decoder<Awaited<TProjected>, E, MergeDecodeModes<M | (TProjected extends Promise<unknown> ? 'async' : 'sync')>>;
export function andThen<A, TNext extends Decoder<unknown, E, DecodeMode>, E, M extends DecodeMode>(
  decoder: Decoder<A, E, M>,
  project: (value: A) => TNext,
): Decoder<
  DecoderValue<TNext>,
  E,
  MergeDecodeModes<M | DecoderModeOf<TNext>>
>;
export function refine<A, B extends A, E, M extends DecodeMode>(
  decoder: Decoder<A, E, M>,
  predicate: (value: A, ctx: DecodeRefinementContext) => value is B,
  message: string,
): Decoder<B, E | DecodeFailure, M>;
export function refine<
  A,
  E,
  M extends DecodeMode,
  TResult extends DecodeRefinementResult | Promise<DecodeRefinementResult>,
>(
  decoder: Decoder<A, E, M>,
  predicate: (value: A, ctx: DecodeRefinementContext) => TResult,
  message: string,
): Decoder<A, E | DecodeFailure, MergeDecodeModes<M | (TResult extends Promise<unknown> ? 'async' : 'sync')>>;
