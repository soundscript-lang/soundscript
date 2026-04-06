import { type ErrorFrame, Failure } from 'sts:failures';
import { err, isErr, none, ok, some, type Option, type Result } from 'sts:result';

export type DecodePathSegment = string | number;
export type DecodePath = readonly DecodePathSegment[];

export class DecodeFailure extends Failure {
  readonly path: DecodePath;

  constructor(
    message = 'Failed to decode value.',
    options: Readonly<{
      cause?: unknown;
      path?: DecodePath;
      trace?: readonly ErrorFrame[];
    }> = {},
  ) {
    super(message, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.trace === undefined ? {} : { trace: options.trace }),
    });
    this.path = options.path ?? [];
  }

  at(segment: DecodePathSegment): this {
    const prototype = Object.getPrototypeOf(this as object);
    const clone = (prototype === null ? Object.create(null) : Object.create(prototype)) as this;
    Object.defineProperties(clone, Object.getOwnPropertyDescriptors(this));
    Object.defineProperty(clone, 'path', {
      configurable: true,
      enumerable: true,
      writable: false,
      value: [segment, ...this.path],
    });
    return clone;
  }
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

export const string: Decoder<string> = {
  decode(value): Result<string, DecodeFailure> {
    return typeof value === 'string'
      ? ok(value)
      : err(new DecodeFailure('Expected string.', { cause: value }));
  },
};

export const number: Decoder<number> = {
  decode(value): Result<number, DecodeFailure> {
    return typeof value === 'number'
      ? ok(value)
      : err(new DecodeFailure('Expected number.', { cause: value }));
  },
};

export const boolean: Decoder<boolean> = {
  decode(value): Result<boolean, DecodeFailure> {
    return typeof value === 'boolean'
      ? ok(value)
      : err(new DecodeFailure('Expected boolean.', { cause: value }));
  },
};

export const bigint: Decoder<bigint> = {
  decode(value): Result<bigint, DecodeFailure> {
    if (typeof value === 'bigint') {
      return ok(value);
    }

    if (typeof value === 'number') {
      return Number.isInteger(value) && Number.isSafeInteger(value)
        ? ok(BigInt(value))
        : err(new DecodeFailure('Expected bigint.', { cause: value }));
    }

    if (typeof value === 'string') {
      try {
        return ok(BigInt(value));
      } catch {
        return err(new DecodeFailure('Expected bigint.', { cause: value }));
      }
    }

    return err(new DecodeFailure('Expected bigint.', { cause: value }));
  },
};

export function lazy<T, E>(getDecoder: () => Decoder<T, E>): Decoder<T, E> {
  return {
    decode(value) {
      return getDecoder().decode(value);
    },
  };
}

export function optional<T, E>(decoder: Decoder<T, E>): OptionalDecoder<T, E> {
  return {
    __soundscriptOptional: true,
    inner: decoder,
    decode(value) {
      return value === undefined ? ok(undefined) : decoder.decode(value);
    },
  };
}

export function nullable<T, E>(decoder: Decoder<T, E>): Decoder<T | null, E> {
  return {
    decode(value) {
      return value === null ? ok(null) : decoder.decode(value);
    },
  };
}

export function defaulted<T, E>(decoder: Decoder<T | undefined, E>, fallback: T): Decoder<T, E> {
  return {
    decode(value) {
      const decoded = decoder.decode(value);
      return isErr(decoded) ? decoded : ok(decoded.value ?? fallback);
    },
  };
}

export function literal<const T extends string | number | boolean | null>(value: T): Decoder<T> {
  return {
    decode(input) {
      return Object.is(input, value)
        ? ok(value)
        : err(new DecodeFailure(`Expected literal ${JSON.stringify(value)}.`, { cause: input }));
    },
  };
}

export function array<T, E>(item: Decoder<T, E>): Decoder<readonly T[], E | DecodeFailure> {
  return {
    decode(value) {
      if (!Array.isArray(value)) {
        return err(new DecodeFailure('Expected array.', { cause: value }));
      }

      const decodedValues: T[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const decoded = item.decode(value[index]);
        if (isErr(decoded)) {
          return err(prependPathIfPossible(decoded.error, index));
        }
        decodedValues.push(decoded.value);
      }

      return ok(decodedValues);
    },
  };
}

export function readonlyRecord<T, E>(
  valueDecoder: Decoder<T, E>,
): Decoder<Readonly<Record<string, T>>, E | DecodeFailure> {
  return {
    decode(value) {
      if (!isPlainObject(value)) {
        return err(new DecodeFailure('Expected object record.', { cause: value }));
      }

      const decodedRecord: Record<string, T> = {};
      for (const [key, entry] of Object.entries(value)) {
        const decoded = valueDecoder.decode(entry);
        if (isErr(decoded)) {
          return err(prependPathIfPossible(decoded.error, key) as E | DecodeFailure);
        }
        decodedRecord[key] = decoded.value;
      }

      return ok(decodedRecord);
    },
  };
}

export function tuple<const TElements extends TupleShape>(
  ...elements: TElements
): Decoder<
  { readonly [K in keyof TElements]: DecoderValue<TElements[K]> },
  DecoderError<TElements[number]> | DecodeFailure
> {
  return {
    decode(value) {
      if (!Array.isArray(value)) {
        return err(new DecodeFailure('Expected tuple.', { cause: value }));
      }

      if (value.length !== elements.length) {
        return err(
          new DecodeFailure(`Expected tuple of length ${elements.length}.`, {
            cause: value,
          }),
        );
      }

      const decodedValues: unknown[] = [];
      for (let index = 0; index < elements.length; index += 1) {
        const elementDecoder = elements[index];
        if (!elementDecoder) {
          continue;
        }
        const decoded = elementDecoder.decode(value[index]);
        if (isErr(decoded)) {
          return err(
            prependPathIfPossible(decoded.error, index) as
              | DecoderError<TElements[number]>
              | DecodeFailure,
          );
        }
        decodedValues.push(decoded.value);
      }

      return ok(decodedValues as { readonly [K in keyof TElements]: DecoderValue<TElements[K]> });
    },
  };
}

export function option<T, E>(item: Decoder<T, E>): Decoder<Option<T>, E | DecodeFailure> {
  return union(
    map(
      object({
        tag: literal('some'),
        value: item,
      }),
      (value) => some(value.value) as Option<T>,
    ),
    map(
      object({
        tag: literal('none'),
      }),
      () => none() as Option<T>,
    ),
  );
}

export function result<T, EValue, EDecodeValue, EDecodeError>(
  okDecoder: Decoder<T, EDecodeValue>,
  errDecoder: Decoder<EValue, EDecodeError>,
): Decoder<Result<T, EValue>, EDecodeValue | EDecodeError | DecodeFailure> {
  return union(
    map(
      object({
        tag: literal('ok'),
        value: okDecoder,
      }),
      (value) => ok(value.value) as Result<T, EValue>,
    ),
    map(
      object({
        tag: literal('err'),
        error: errDecoder,
      }),
      (value) => err(value.error) as Result<T, EValue>,
    ),
  );
}

export function object<TShape extends ObjectShape>(
  shape: TShape,
): Decoder<
  { readonly [K in keyof TShape]: DecoderValue<TShape[K]> },
  DecoderError<TShape[keyof TShape]> | DecodeFailure
> {
  return {
    decode(value) {
      if (!isPlainObject(value)) {
        return err(new DecodeFailure('Expected object.', { cause: value }));
      }

      const record = value as Record<string, unknown>;
      const decodedObject: Record<string, unknown> = {};

      for (const key of Object.keys(shape)) {
        const decoder = shape[key];
        if (!decoder) {
          continue;
        }
        const hasKey = key in record;
        const rawValue = record[key];

        if (!hasKey || rawValue === undefined) {
          if (isOptionalDecoder(decoder)) {
            decodedObject[key] = undefined;
            continue;
          }

          return err(
            new DecodeFailure(`Missing field "${key}".`, {
              cause: value,
              path: [key],
            }),
          );
        }

        const decoded = decoder.decode(rawValue);
        if (isErr(decoded)) {
          return err(
            prependPathIfPossible(decoded.error, key) as
              | DecoderError<TShape[keyof TShape]>
              | DecodeFailure,
          );
        }

        decodedObject[key] = decoded.value;
      }

      return ok(decodedObject as { readonly [K in keyof TShape]: DecoderValue<TShape[K]> });
    },
  };
}

export function field<K extends string, T, E>(
  key: K,
  decoder: Decoder<T, E>,
): Decoder<T, E | DecodeFailure> {
  const shape = { [key]: decoder } as { readonly [P in K]: Decoder<T, E> };
  return map(object(shape), (value) => value[key]);
}

export function optionalField<K extends string, T, E>(
  key: K,
  decoder: Decoder<T, E>,
): Decoder<T | undefined, E | DecodeFailure> {
  const shape = { [key]: optional(decoder) } as {
    readonly [P in K]: OptionalDecoder<T, E>;
  };
  return map(object(shape), (value) => value[key]);
}

export function union<A, B, ELeft, ERight>(
  left: Decoder<A, ELeft>,
  right: Decoder<B, ERight>,
): Decoder<A | B, ELeft | ERight | DecodeFailure> {
  return {
    decode(value) {
      const leftDecoded = left.decode(value);
      if (isErr(leftDecoded)) {
        const rightDecoded = right.decode(value);
        if (isErr(rightDecoded)) {
          return err(
            new DecodeFailure('Expected one of the union members.', {
              cause: value,
            }),
          );
        }
        return rightDecoded;
      }
      return leftDecoded;
    },
  };
}

export function map<A, B, E>(
  decoder: Decoder<A, E>,
  project: (value: A) => B,
): Decoder<B, E> {
  return {
    decode(value) {
      const decoded = decoder.decode(value);
      return isErr(decoded) ? decoded : ok(project(decoded.value));
    },
  };
}

export function andThen<A, B, E>(
  decoder: Decoder<A, E>,
  project: (value: A) => Decoder<B, E>,
): Decoder<B, E> {
  return {
    decode(value) {
      const decoded = decoder.decode(value);
      return isErr(decoded) ? decoded : project(decoded.value).decode(valueOf(decoded));
    },
  };
}

export function refine<A, B extends A, E>(
  decoder: Decoder<A, E>,
  predicate: (value: A) => value is B,
  message: string,
): Decoder<B, E | DecodeFailure> {
  return {
    decode(value) {
      const decoded = decoder.decode(value);
      if (isErr(decoded)) {
        return decoded;
      }

      return predicate(decoded.value)
        ? ok(decoded.value)
        : err(new DecodeFailure(message, { cause: value }));
    },
  };
}

function prependPathIfPossible<E>(error: E, segment: DecodePathSegment): E | DecodeFailure {
  return error instanceof DecodeFailure ? error.at(segment) : error;
}

function isOptionalDecoder(
  value: Decoder<unknown, unknown>,
): value is OptionalDecoder<unknown, unknown> {
  return '__soundscriptOptional' in value &&
    value.__soundscriptOptional === true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueOf<T>(decoded: { readonly value: T }): T {
  return decoded.value;
}
