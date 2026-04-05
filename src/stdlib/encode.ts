import { type Bind, type Kind3, type TypeLambda } from 'sts:hkt';
import { Failure } from 'sts:failures';
import { err, isErr, isOk, isSome, ok, type Option, type Result } from 'sts:result';
import type { Contravariant } from 'sts:typeclasses';

export class EncodeFailure extends Failure {
  constructor(message = 'Failed to encode value.', cause?: unknown) {
    super(message, { cause });
  }
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

type EncoderInput<TEncoder> = TEncoder extends Encoder<infer T, unknown, unknown> ? T : never;
type EncoderOutput<TEncoder> = TEncoder extends Encoder<unknown, infer TEncoded, unknown> ? TEncoded
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
): Encoder<T, TEncoded, E> {
  return {
    encode,
  };
}

export function contramap<A, B, TEncoded, E>(
  encoder: Encoder<A, TEncoded, E>,
  project: (value: B) => A,
): Encoder<B, TEncoded, E> {
  return fromEncode((value) => encoder.encode(project(value)));
}

export function encoderContravariant<TEncoded, E = EncodeFailure>(): Contravariant<
  Bind<Bind<EncoderF, [E]>, [TEncoded]>
> {
  return {
    contramap,
  };
}

export const stringEncoder: Encoder<string, string> = fromEncode((value) => ok(value));
export const numberEncoder: Encoder<number, number> = fromEncode((value) => ok(value));
export const booleanEncoder: Encoder<boolean, boolean> = fromEncode((value) => ok(value));
export const bigintEncoder: Encoder<bigint, bigint> = fromEncode((value) => ok(value));

export function optional<T, TEncoded, E>(
  encoder: Encoder<T, TEncoded, E>,
): OptionalEncoder<T, TEncoded, E> {
  return {
    __soundscriptOptional: true,
    inner: encoder,
    encode(value) {
      return value === undefined ? ok(undefined) : encoder.encode(value);
    },
  };
}

export function lazy<T, TEncoded, E>(
  getEncoder: () => Encoder<T, TEncoded, E>,
): Encoder<T, TEncoded, E> {
  return fromEncode((value) => getEncoder().encode(value));
}

export function nullable<T, TEncoded, E>(
  encoder: Encoder<T, TEncoded, E>,
): Encoder<T | null, TEncoded | null, E> {
  return fromEncode((value) => value === null ? ok(null) : encoder.encode(value));
}

export function literal<const T extends string | number | boolean | null>(value: T): Encoder<T, T> {
  return fromEncode((input) =>
    Object.is(input, value)
      ? ok(value)
      : err(new EncodeFailure(`Expected literal ${JSON.stringify(value)}.`, input))
  );
}

export function array<T, TEncoded, E>(
  item: Encoder<T, TEncoded, E>,
): Encoder<readonly T[], readonly TEncoded[], E | EncodeFailure> {
  return fromEncode((value) => {
    const encodedValues: TEncoded[] = [];
    for (const entry of value) {
      const encoded = item.encode(entry);
      if (isErr(encoded)) {
        return encoded;
      }
      encodedValues.push(encoded.value);
    }
    return ok(encodedValues);
  });
}

export function tuple<const TElements extends TupleShape>(
  ...elements: TElements
): Encoder<
  { readonly [K in keyof TElements]: EncoderInput<TElements[K]> },
  { readonly [K in keyof TElements]: EncoderOutput<TElements[K]> },
  EncoderError<TElements[number]>
> {
  return fromEncode((value) => {
    const values = value as readonly unknown[];
    const encodedValues: unknown[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const elementEncoder = elements[index];
      if (!elementEncoder) {
        continue;
      }
      const encoded = elementEncoder.encode(values[index] as never);
      if (isErr(encoded)) {
        return encoded as Result<
          { readonly [K in keyof TElements]: EncoderOutput<TElements[K]> },
          EncoderError<TElements[number]>
        >;
      }
      encodedValues.push(encoded.value);
    }
    return ok(encodedValues as { readonly [K in keyof TElements]: EncoderOutput<TElements[K]> });
  });
}

export function option<T, TEncoded, E>(
  item: Encoder<T, TEncoded, E>,
): Encoder<
  Option<T>,
  { readonly tag: 'none' } | {
    readonly tag: 'some';
    readonly value: TEncoded;
  },
  E
> {
  return fromEncode<
    Option<T>,
    { readonly tag: 'none' } | {
      readonly tag: 'some';
      readonly value: TEncoded;
    },
    E
  >((value) => {
    if (isSome(value)) {
      const encoded = item.encode(value.value);
      return isErr(encoded) ? encoded : ok({ tag: 'some', value: encoded.value });
    }

    return ok({ tag: 'none' });
  });
}

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
> {
  return fromEncode<
    Result<T, EValue>,
    { readonly tag: 'ok'; readonly value: TEncoded } | {
      readonly error: EEncoded;
      readonly tag: 'err';
    },
    EOk | EErr
  >((value) => {
    if (isOk(value)) {
      const encoded = okEncoder.encode(value.value);
      return isErr(encoded) ? encoded : ok({ tag: 'ok', value: encoded.value });
    }

    const encoded = errEncoder.encode(value.error);
    return isErr(encoded) ? encoded : ok({ tag: 'err', error: encoded.value });
  });
}

export function object<TShape extends ObjectShape>(
  shape: TShape,
): Encoder<
  { readonly [K in keyof TShape]: EncoderInput<TShape[K]> },
  { readonly [K in keyof TShape]: EncoderOutput<TShape[K]> },
  EncoderError<TShape[keyof TShape]> | EncodeFailure
> {
  return fromEncode<
    { readonly [K in keyof TShape]: EncoderInput<TShape[K]> },
    { readonly [K in keyof TShape]: EncoderOutput<TShape[K]> },
    EncoderError<TShape[keyof TShape]> | EncodeFailure
  >((value) => {
    if (!isPlainObject(value)) {
      return err<EncoderError<TShape[keyof TShape]> | EncodeFailure>(
        new EncodeFailure('Expected object.', value),
      );
    }

    const record = value as Record<string, unknown>;
    const encodedObject: Record<string, unknown> = {};

    for (const key of Object.keys(shape)) {
      const encoder = shape[key];
      if (!encoder) {
        continue;
      }
      const hasKey = key in record;
      const rawValue = record[key];

      if (!hasKey || rawValue === undefined) {
        if (isOptionalEncoder(encoder)) {
          encodedObject[key] = undefined;
          continue;
        }

        return err<EncoderError<TShape[keyof TShape]> | EncodeFailure>(
          new EncodeFailure(`Missing field "${key}".`, value),
        );
      }

      const encoded = encoder.encode(rawValue as never) as Result<
        unknown,
        EncoderError<TShape[keyof TShape]> | EncodeFailure
      >;
      if (isErr(encoded)) {
        return encoded;
      }
      encodedObject[key] = encoded.value;
    }

    return ok(encodedObject as { readonly [K in keyof TShape]: EncoderOutput<TShape[K]> });
  });
}

function isOptionalEncoder(
  value: Encoder<unknown, unknown, unknown>,
): value is OptionalEncoder<unknown, unknown, unknown> {
  return '__soundscriptOptional' in value && value.__soundscriptOptional === true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
