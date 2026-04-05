import type { Bind, TypeLambda } from 'sts:hkt';
import { type DecodeFailure, type Decoder } from 'sts:decode';
import { contramap, type EncodeFailure, type Encoder } from 'sts:encode';
import type { Invariant } from 'sts:typeclasses';

export { booleanEncoder, contramap, numberEncoder, stringEncoder } from 'sts:encode';
export type { EncodeFailure, Encoder } from 'sts:encode';

// #[variance(T: inout, TEncoded: out, DE: out, EE: out)]
export type Codec<T, TEncoded = unknown, DE = DecodeFailure, EE = EncodeFailure> =
  Decoder<T, DE> & Encoder<T, TEncoded, EE>;

export interface CodecF extends TypeLambda {
  readonly type: Codec<this['Args'][3], this['Args'][2], this['Args'][1], this['Args'][0]>;
}

export function codec<T, TEncoded, DE, EE>(
  decoder: Decoder<T, DE>,
  encoder: Encoder<T, TEncoded, EE>,
): Codec<T, TEncoded, DE, EE>;
export function imap<A, B, TEncoded, DE, EE>(
  base: Codec<A, TEncoded, DE, EE>,
  decodeMap: (value: A) => B,
  encodeMap: (value: B) => A,
): Codec<B, TEncoded, DE, EE>;
export function codecInvariant<TEncoded, DE = DecodeFailure, EE = EncodeFailure>(): Invariant<
  Bind<Bind<Bind<CodecF, [EE]>, [DE]>, [TEncoded]>
>;

export const stringCodec: Codec<string, string>;
export const numberCodec: Codec<number, number>;
export const booleanCodec: Codec<boolean, boolean>;
