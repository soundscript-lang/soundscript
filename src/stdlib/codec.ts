import { type Bind, type TypeLambda } from 'sts:hkt';
import {
  boolean as booleanDecoder,
  DecodeFailure,
  jsonArray as jsonArrayDecoder,
  jsonObject as jsonObjectDecoder,
  jsonValue as jsonValueDecoder,
  map as mapDecoder,
  mapError as mapDecodeErrorValue,
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
  jsonArray as jsonArrayEncoder,
  jsonObject as jsonObjectEncoder,
  jsonValue as jsonValueEncoder,
  mapError as mapEncodeErrorValue,
  numberEncoder as numberEncoderValue,
  stringEncoder as stringEncoderValue,
  url as urlEncoder,
} from 'sts:encode';
import type { Invariant } from 'sts:typeclasses';
import type { JsonArray, JsonObject, JsonValue } from 'sts:json';
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

export function mapDecodeError<
  T,
  TEncoded,
  DE1,
  DE2,
  EE,
  DM extends DecodeMode = 'sync',
  EM extends EncodeMode = 'sync',
>(
  base: Codec<T, TEncoded, DE1, EE, DM, EM>,
  project: (error: DE1) => DE2,
): Codec<T, TEncoded, DE2, EE, DM, EM> {
  return codec(
    mapDecodeErrorValue(base, project),
    base,
  );
}

export function mapEncodeError<
  T,
  TEncoded,
  DE,
  EE1,
  EE2,
  DM extends DecodeMode = 'sync',
  EM extends EncodeMode = 'sync',
>(
  base: Codec<T, TEncoded, DE, EE1, DM, EM>,
  project: (error: EE1) => EE2,
): Codec<T, TEncoded, DE, EE2, DM, EM> {
  return codec(
    base,
    mapEncodeErrorValue(base, project),
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
export const jsonValue: Codec<JsonValue, JsonValue> = codec(jsonValueDecoder, jsonValueEncoder);
export const jsonObject: Codec<JsonObject, JsonObject> = codec(jsonObjectDecoder, jsonObjectEncoder);
export const jsonArray: Codec<JsonArray, JsonArray> = codec(jsonArrayDecoder, jsonArrayEncoder);
export const url: Codec<UrlLike, string> = codec(urlDecoder, urlEncoder);
export const isoDate: Codec<Date, string> = codec(isoDateDecoder, isoDateEncoder);
