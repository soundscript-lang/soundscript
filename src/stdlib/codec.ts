import { type Bind, type TypeLambda } from 'sts:hkt';
import {
  boolean as booleanDecoder,
  DecodeFailure,
  map as mapDecoder,
  type DecodeMode,
  type Decoder,
  isoDate as isoDateDecoder,
  number as numberDecoder,
  string as stringDecoder,
  type UrlLike,
  url as urlDecoder,
} from 'sts:decode';
import {
  booleanEncoder as booleanEncoderValue,
  contramap as contramapEncoder,
  type EncodeFailure,
  type Encoder,
  type EncodeMode,
  isoDate as isoDateEncoder,
  numberEncoder as numberEncoderValue,
  stringEncoder as stringEncoderValue,
  url as urlEncoder,
} from 'sts:encode';
import type { Invariant } from 'sts:typeclasses';
import {
  __attachDecodeMetadata,
  __attachEncodeMetadata,
  __decodeDirectionOf,
  __encodeDirectionOf,
} from './metadata.ts';

export type { EncodeFailure, Encoder } from 'sts:encode';
export {
  booleanEncoderValue as booleanEncoder,
  contramapEncoder as contramap,
  numberEncoderValue as numberEncoder,
  stringEncoderValue as stringEncoder,
};

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
): Codec<T, TEncoded, DE, EE, DM, EM> {
  const value = {
    decode(value: unknown) {
      return decoder.decode(value);
    },
    validateDecode(value: unknown) {
      return decoder.validateDecode(value);
    },
    encode(value: T) {
      return encoder.encode(value);
    },
    validateEncode(value: T) {
      return encoder.validateEncode(value);
    },
  };
  const decodeDirection = __decodeDirectionOf(decoder);
  const encodeDirection = __encodeDirectionOf(encoder);
  if (decodeDirection) {
    __attachDecodeMetadata(value, decodeDirection);
  }
  if (encodeDirection) {
    __attachEncodeMetadata(value, encodeDirection);
  }
  return value;
}

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
): Codec<B, TEncoded, DE, EE, DM, EM> {
  return codec(
    mapDecoder(base, decodeMap) as Decoder<B, DE, DM>,
    contramapEncoder(base, encodeMap) as Encoder<B, TEncoded, EE, EM>,
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
export const url: Codec<UrlLike, string> = codec(urlDecoder, urlEncoder);
export const isoDate: Codec<Date, string> = codec(isoDateDecoder, isoDateEncoder);
