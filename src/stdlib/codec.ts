import { type Bind, type TypeLambda } from 'sts:hkt';
import {
  boolean as booleanDecoder,
  DecodeFailure,
  type Decoder,
  number as numberDecoder,
  string as stringDecoder,
} from 'sts:decode';
import {
  booleanEncoder as booleanEncoderValue,
  contramap as contramapEncoder,
  type EncodeFailure,
  type Encoder,
  numberEncoder as numberEncoderValue,
  stringEncoder as stringEncoderValue,
} from 'sts:encode';
import type { Invariant } from 'sts:typeclasses';
import { isErr, ok, type Result } from 'sts:result';

export type { EncodeFailure, Encoder } from 'sts:encode';
export {
  booleanEncoderValue as booleanEncoder,
  contramapEncoder as contramap,
  numberEncoderValue as numberEncoder,
  stringEncoderValue as stringEncoder,
};

// #[variance(T: inout, TEncoded: out, DE: out, EE: out)]
export type Codec<T, TEncoded = unknown, DE = DecodeFailure, EE = EncodeFailure> =
  Decoder<T, DE> & Encoder<T, TEncoded, EE>;

export interface CodecF extends TypeLambda {
  readonly type: Codec<this['Args'][3], this['Args'][2], this['Args'][1], this['Args'][0]>;
}

export function codec<T, TEncoded, DE, EE>(
  decoder: Decoder<T, DE>,
  encoder: Encoder<T, TEncoded, EE>,
): Codec<T, TEncoded, DE, EE> {
  return {
    decode(value): Result<T, DE> {
      return decoder.decode(value);
    },
    encode(value): Result<TEncoded, EE> {
      return encoder.encode(value);
    },
  };
}

export function imap<A, B, TEncoded, DE, EE>(
  base: Codec<A, TEncoded, DE, EE>,
  decodeMap: (value: A) => B,
  encodeMap: (value: B) => A,
): Codec<B, TEncoded, DE, EE> {
  return codec(
    {
      decode(value): Result<B, DE> {
        const decoded = base.decode(value);
        return isErr(decoded) ? decoded : ok(decodeMap(decoded.value));
      },
    },
    contramapEncoder(base, encodeMap),
  );
}

export function codecInvariant<TEncoded, DE = DecodeFailure, EE = EncodeFailure>(): Invariant<
  Bind<Bind<Bind<CodecF, [EE]>, [DE]>, [TEncoded]>
> {
  return {
    imap,
  };
}

export const stringCodec: Codec<string, string> = codec(stringDecoder, stringEncoderValue);
export const numberCodec: Codec<number, number> = codec(numberDecoder, numberEncoderValue);
export const booleanCodec: Codec<boolean, boolean> = codec(booleanDecoder, booleanEncoderValue);
