import { type Bind, type TypeLambda } from 'sts:hkt';
import {
  boolean as booleanDecoder,
  DecodeFailure,
  type DecodeMode,
  type Decoder,
  isoDate as isoDateDecoder,
  number as numberDecoder,
  string as stringDecoder,
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
import { isErr, ok, type Result } from 'sts:result';

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
  return {
    decode(value) {
      return decoder.decode(value);
    },
    validateDecode(value) {
      return decoder.validateDecode(value);
    },
    encode(value) {
      return encoder.encode(value);
    },
    validateEncode(value) {
      return encoder.validateEncode(value);
    },
  };
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
    {
      decode(value) {
        const decoded = base.decode(value);
        return (decoded instanceof Promise
          ? decoded.then((resolved) => isErr(resolved) ? resolved : ok(decodeMap(resolved.value)))
          : isErr(decoded)
          ? decoded
          : ok(decodeMap(decoded.value))) as Result<B, DE> | Promise<Result<B, DE>>;
      },
      validateDecode(value) {
        const decoded = base.validateDecode(value);
        return (decoded instanceof Promise
          ? decoded.then((resolved) => isErr(resolved) ? resolved : ok(decodeMap(resolved.value)))
          : isErr(decoded)
          ? decoded
          : ok(decodeMap(decoded.value))) as
          | Result<B, readonly import('sts:decode').DecodeIssue[]>
          | Promise<Result<B, readonly import('sts:decode').DecodeIssue[]>>;
      },
    } as Decoder<B, DE, DM>,
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
export const url: Codec<URL, string> = codec(urlDecoder, urlEncoder);
export const isoDate: Codec<Date, string> = codec(isoDateDecoder, isoDateEncoder);
