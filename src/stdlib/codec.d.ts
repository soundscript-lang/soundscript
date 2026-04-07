import type { Bind, TypeLambda } from 'sts:hkt';
import { type DecodeFailure, type DecodeMode, type Decoder } from 'sts:decode';
import { contramap, type EncodeFailure, type Encoder, type EncodeMode } from 'sts:encode';
import type { Invariant } from 'sts:typeclasses';

export { booleanEncoder, contramap, numberEncoder, stringEncoder } from 'sts:encode';
export type { EncodeFailure, Encoder } from 'sts:encode';

// #[variance(T: inout, TEncoded: out, DE: out, EE: out, DM: out, EM: out)]
export type Codec<
  T,
  TEncoded = unknown,
  DE = DecodeFailure,
  EE = EncodeFailure,
  DM extends DecodeMode = 'sync',
  EM extends EncodeMode = 'sync',
> = Decoder<T, DE, DM> & Encoder<T, TEncoded, EE, EM>;

export interface CodecF extends TypeLambda {
  readonly type: Codec<this['Args'][3], this['Args'][2], this['Args'][1], this['Args'][0]>;
}

export function codec<
  T,
  TEncoded,
  DE,
  EE,
  DM extends DecodeMode = 'sync',
  EM extends EncodeMode = 'sync',
>(
  decoder: Decoder<T, DE, DM>,
  encoder: Encoder<T, TEncoded, EE, EM>,
): Codec<T, TEncoded, DE, EE, DM, EM>;
export function imap<
  A,
  B,
  TEncoded,
  DE,
  EE,
  DM extends DecodeMode = 'sync',
  EM extends EncodeMode = 'sync',
>(
  base: Codec<A, TEncoded, DE, EE, DM, EM>,
  decodeMap: (value: A) => B,
  encodeMap: (value: B) => A,
): Codec<B, TEncoded, DE, EE, DM, EM>;
export function codecInvariant<TEncoded, DE = DecodeFailure, EE = EncodeFailure>(): Invariant<
  Bind<Bind<Bind<CodecF, [EE]>, [DE]>, [TEncoded]>
>;

export const stringCodec: Codec<string, string>;
export const numberCodec: Codec<number, number>;
export const booleanCodec: Codec<boolean, boolean>;
