import { type ErrorFrame, Failure } from 'sts:failures';
import { err, isErr, none, ok, some, type Option, type Result } from 'sts:result';
import {
  __attachDecodeMetadata,
  __cloneNodeWithEffects,
  __decodeDirectionOrOpaque,
  __decodeModeOf,
  __fieldMetadataOf,
  __helperName,
  __inferCallableMode,
  __InternalMetadataNode,
  __isAsyncCallable,
  __metadataValueOf,
  __setDecodeMode,
  type KnownConstraint,
  type MetadataEffect,
} from './metadata.ts';
import {
  isJsonObject,
  isJsonValue,
  type JsonArray,
  type JsonObject,
  type JsonValue,
} from './json.ts';

export type DecodeMode = 'sync' | 'async';
export type DecodeFormat = 'email' | 'uuid' | 'url' | 'iso-datetime';
export type ObjectKeyPolicy = 'strip' | 'strict' | 'passthrough';
export type DecodeObjectOptions = {
  readonly unknownKeys?: ObjectKeyPolicy;
};
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
export interface UrlLike {
  readonly hash: string;
  readonly host: string;
  readonly hostname: string;
  readonly href: string;
  readonly password: string;
  readonly pathname: string;
  readonly port: string;
  readonly protocol: string;
  readonly search: string;
  readonly username: string;
  toJSON(): string;
  toString(): string;
}
export type DecodeOutput<T, E, M extends DecodeMode = 'sync'> = M extends 'async'
  ? Promise<Result<T, E>>
  : Result<T, E>;

type MaybePromise<T> = T | Promise<T>;
type MaybeDecodeOutput<T, E> = Result<T, E> | Promise<Result<T, E>>;
type AsyncModeOf<TReturn> = TReturn extends Promise<unknown> ? 'async' : 'sync';

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

// #[variance(T: out, E: out, M: out)]
export type Decoder<T, E = DecodeFailure, M extends DecodeMode = 'sync'> = {
  decode(value: unknown): DecodeOutput<T, E, M>;
  validateDecode(value: unknown): DecodeOutput<T, readonly DecodeIssue[], M>;
};

// #[variance(T: out, E: out, M: out)]
export type OptionalDecoder<T, E = DecodeFailure, M extends DecodeMode = 'sync'> =
  Decoder<T | undefined, E, M> & {
    readonly __soundscriptOptional: true;
    readonly inner: Decoder<T, E, M>;
  };

type UndefinedableDecoder<T, E = DecodeFailure, M extends DecodeMode = 'sync'> =
  Decoder<T | undefined, E, M> & {
    readonly __soundscriptUndefinedable: true;
    readonly inner: Decoder<T, E, M>;
  };

type DefaultedDecoder<T, E = DecodeFailure, M extends DecodeMode = 'sync'> =
  Decoder<T, E, M> & {
    readonly __soundscriptDefaulted: true;
  };

type DecoderValue<TDecoder> = TDecoder extends Decoder<infer TValue, unknown, DecodeMode>
  ? TValue
  : never;
type DecoderError<TDecoder> = TDecoder extends Decoder<unknown, infer E, DecodeMode> ? E : never;
type DecoderModeOf<TDecoder> = TDecoder extends { decode(value: unknown): infer TOutput }
  ? TOutput extends Promise<Result<unknown, unknown>> ? 'async'
  : 'sync'
  : never;
type MergeDecodeModes<M extends DecodeMode> = [M] extends [never] ? 'sync'
  : 'async' extends M ? 'async'
  : 'sync';
type ObjectShape = Record<string, Decoder<unknown, unknown, DecodeMode>>;
type TupleShape = readonly Decoder<unknown, unknown, DecodeMode>[];
type OptionalShapeKeys<TShape extends ObjectShape> = {
  readonly [K in keyof TShape]-?: TShape[K] extends OptionalDecoder<unknown, unknown, DecodeMode>
    ? K
    : never;
}[keyof TShape];
type RequiredShapeKeys<TShape extends ObjectShape> = Exclude<keyof TShape, OptionalShapeKeys<TShape>>;
type ObjectValueOfShape<TShape extends ObjectShape> =
  & {
    readonly [K in RequiredShapeKeys<TShape>]: DecoderValue<TShape[K]>;
  }
  & {
    readonly [K in OptionalShapeKeys<TShape>]?: Exclude<DecoderValue<TShape[K]>, undefined>;
  };
type ShapeDecodeMode<TShape extends ObjectShape> = true extends {
  readonly [K in keyof TShape]: DecoderModeOf<TShape[K]> extends 'async' ? true : false;
}[keyof TShape] ? 'async'
  : 'sync';
type TupleDecodeMode<TElements extends TupleShape> = true extends {
  readonly [K in keyof TElements]: TElements[K] extends Decoder<unknown, unknown, 'async'> ? true
    : false;
}[number] ? 'async'
  : 'sync';

const jsonStringNode: __InternalMetadataNode = { kind: 'primitive', primitive: 'string' };
const jsonNumberNode: __InternalMetadataNode = { kind: 'primitive', primitive: 'number' };
const jsonBooleanNode: __InternalMetadataNode = { kind: 'primitive', primitive: 'boolean' };
const jsonNullNode: __InternalMetadataNode = { kind: 'null' };
const jsonObjectNode: __InternalMetadataNode = {
  key: 'string',
  kind: 'record',
  value: {
    kind: 'ref',
    target: () => jsonValueNode,
  },
};
const jsonArrayNode: __InternalMetadataNode = {
  element: {
    kind: 'ref',
    target: () => jsonValueNode,
  },
  kind: 'array',
};
const jsonValueNode: __InternalMetadataNode = {
  kind: 'union',
  members: [
    jsonStringNode,
    jsonNumberNode,
    jsonBooleanNode,
    jsonNullNode,
    {
      kind: 'ref',
      target: () => jsonObjectNode,
    },
    {
      kind: 'ref',
      target: () => jsonArrayNode,
    },
  ],
};

export function fromDecode<T, E, M extends DecodeMode = 'sync'>(
  decode: (value: unknown) => MaybeDecodeOutput<T, E>,
  validateDecode?: (value: unknown) => MaybeDecodeOutput<T, readonly DecodeIssue[]>,
): Decoder<T, E, M> {
  const inferredMode = __inferCallableMode(decode, validateDecode) as M;
  const decoder = {
    decode: decode as (value: unknown) => DecodeOutput<T, E, M>,
    validateDecode: (validateDecode ?? ((value) => defaultValidateDecode(decode(value), value))) as
      (value: unknown) => DecodeOutput<T, readonly DecodeIssue[], M>,
  };
  __setDecodeMode(decoder, inferredMode);
  return __attachDecodeMetadata(decoder, {
    mode: inferredMode,
    root: { kind: 'opaque' },
  });
}

function decodeModeOf(decoder: unknown): DecodeMode {
  return __decodeModeOf(decoder) ?? 'sync';
}

function mergeDecodeRuntimeModes(...decoders: readonly unknown[]): DecodeMode {
  return decoders.some((decoder) => decodeModeOf(decoder) === 'async') ? 'async' : 'sync';
}

function decodeDirectionOf(decoder: unknown) {
  return __decodeDirectionOrOpaque(decoder);
}

function decodeNodeOf(decoder: unknown): __InternalMetadataNode {
  return decodeDirectionOf(decoder).root;
}

function decodeOpaqueEffect(
  effect: 'andThen' | 'preprocess' | 'refine' | 'transform' | 'via',
  helper: unknown,
): MetadataEffect {
  return {
    async: __isAsyncCallable(helper),
    effect,
    helperName: __helperName(helper),
    kind: 'opaque',
  };
}

function decodeConstraintEffect(constraint: KnownConstraint): MetadataEffect {
  return {
    constraint,
    kind: 'constraint',
  };
}

export const string: Decoder<string> = __attachDecodeMetadata(
  fromDecode((value) =>
    typeof value === 'string'
      ? ok(value)
      : err(new DecodeFailure('Expected string.', { cause: value }))
  ),
  {
    mode: 'sync',
    root: { kind: 'primitive', primitive: 'string' },
  },
);

export const number: Decoder<number> = __attachDecodeMetadata(
  fromDecode((value) =>
    typeof value === 'number'
      ? ok(value)
      : err(new DecodeFailure('Expected number.', { cause: value }))
  ),
  {
    mode: 'sync',
    root: { kind: 'primitive', primitive: 'number' },
  },
);

export const boolean: Decoder<boolean> = __attachDecodeMetadata(
  fromDecode((value) =>
    typeof value === 'boolean'
      ? ok(value)
      : err(new DecodeFailure('Expected boolean.', { cause: value }))
  ),
  {
    mode: 'sync',
    root: { kind: 'primitive', primitive: 'boolean' },
  },
);

export const bigint: Decoder<bigint> = __attachDecodeMetadata(
  fromDecode((value) => {
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
  }),
  {
    mode: 'sync',
    root: { kind: 'primitive', primitive: 'bigint' },
  },
);

export const undefinedValue: Decoder<undefined> = __attachDecodeMetadata(
  fromDecode((value) =>
    value === undefined
      ? ok(undefined)
      : err(new DecodeFailure('Expected undefined.', { cause: value }))
  ),
  {
    mode: 'sync',
    root: { kind: 'undefined' },
  },
);

export const url: Decoder<UrlLike> = __attachDecodeMetadata(fromDecode((value) => {
  if (typeof value !== 'string') {
    return err(new DecodeFailure('Expected URL string.', { cause: value }));
  }
  try {
    return ok(new URL(value));
  } catch {
    return err(new DecodeFailure('Expected URL string.', { cause: value }));
  }
}), {
  mode: 'sync',
  root: {
    effects: [{
      async: false,
      effect: 'transform',
      helperName: 'url',
      kind: 'opaque',
    }],
    kind: 'primitive',
    primitive: 'string',
  },
});

export const isoDate: Decoder<Date> = __attachDecodeMetadata(fromDecode((value) => {
  if (typeof value !== 'string') {
    return err(new DecodeFailure('Expected ISO datetime string.', { cause: value }));
  }
  if (!isIsoDatetimeString(value)) {
    return err(new DecodeFailure('Expected ISO datetime string.', { cause: value }));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? err(new DecodeFailure('Expected ISO datetime string.', { cause: value }))
    : ok(parsed);
}), {
  mode: 'sync',
  root: {
    effects: [{
      async: false,
      effect: 'transform',
      helperName: 'isoDate',
      kind: 'opaque',
    }],
    kind: 'primitive',
    primitive: 'string',
  },
});

export const jsonValue: Decoder<JsonValue> = __attachDecodeMetadata(
  fromDecode((value) =>
    isJsonValue(value)
      ? ok(value)
      : err(new DecodeFailure('Expected JSON value.', { cause: value }))
  ),
  {
    mode: 'sync',
    root: jsonValueNode,
  },
);

export const jsonObject: Decoder<JsonObject> = __attachDecodeMetadata(
  fromDecode((value) =>
    isJsonObject(value)
      ? ok(value)
      : err(new DecodeFailure('Expected JSON object.', { cause: value }))
  ),
  {
    mode: 'sync',
    root: jsonObjectNode,
  },
);

export const jsonArray: Decoder<JsonArray> = __attachDecodeMetadata(
  fromDecode((value) =>
    Array.isArray(value) && isJsonValue(value)
      ? ok(value as JsonArray)
      : err(new DecodeFailure('Expected JSON array.', { cause: value }))
  ),
  {
    mode: 'sync',
    root: jsonArrayNode,
  },
);

export function mapError<T, E1, E2, M extends DecodeMode>(
  decoder: Decoder<T, E1, M>,
  project: (error: E1) => E2,
): Decoder<T, E2, M> {
  return __attachDecodeMetadata({
    decode(value: unknown) {
      const decoded = decoder.decode(value) as MaybeDecodeOutput<T, E1>;
      if (isPromiseLike(decoded)) {
        return decoded.then((result) => isErr(result) ? err(project(result.error)) : result) as DecodeOutput<
          T,
          E2,
          M
        >;
      }
      return (isErr(decoded) ? err(project(decoded.error)) : decoded) as DecodeOutput<T, E2, M>;
    },
    validateDecode(value: unknown) {
      return decoder.validateDecode(value) as DecodeOutput<T, readonly DecodeIssue[], M>;
    },
  } as Decoder<T, E2, M>, decodeDirectionOf(decoder));
}

export function lazy<const TDecoder extends Decoder<unknown, unknown, DecodeMode>>(
  getDecoder: () => TDecoder,
): Decoder<DecoderValue<TDecoder>, DecoderError<TDecoder>, DecoderModeOf<TDecoder>>;
export function lazy<T, E, M extends DecodeMode>(
  getDecoder: () => Decoder<T, E, M>,
): Decoder<T, E, M> {
  return __attachDecodeMetadata(fromDecode(
    (value) => getDecoder().decode(value),
    (value) => getDecoder().validateDecode(value),
  ), {
    mode: () => decodeModeOf(getDecoder()),
    root: {
      kind: 'ref',
      target: () => decodeNodeOf(getDecoder()),
    },
  });
}

export function optional<const TDecoder extends Decoder<unknown, unknown, DecodeMode>>(
  decoder: TDecoder,
): OptionalDecoder<Exclude<DecoderValue<TDecoder>, undefined>, DecoderError<TDecoder>, DecoderModeOf<TDecoder>>;
export function optional<T, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
): OptionalDecoder<Exclude<T, undefined>, E, M>;
export function optional<T, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
): OptionalDecoder<Exclude<T, undefined>, E, M> {
  return __attachDecodeMetadata({
    __soundscriptOptional: true,
    inner: decoder,
    decode(value) {
      return (value === undefined ? ok(undefined) : decoder.decode(value)) as DecodeOutput<
        T | undefined,
        E,
        M
      >;
    },
    validateDecode(value) {
      return (value === undefined ? ok(undefined) : decoder.validateDecode(value)) as DecodeOutput<
        T | undefined,
        readonly DecodeIssue[],
        M
      >;
    },
  } as OptionalDecoder<Exclude<T, undefined>, E, M>, {
    mode: decodeModeOf(decoder),
    root: {
      kind: 'union',
      members: [
        decodeNodeOf(decoder),
        { kind: 'undefined' },
      ],
    },
  });
}

export function undefinedable<T, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
): Decoder<T | undefined, E, M> {
  return __attachDecodeMetadata({
    __soundscriptUndefinedable: true,
    inner: decoder,
    decode(value) {
      return (value === undefined ? ok(undefined) : decoder.decode(value)) as DecodeOutput<
        T | undefined,
        E,
        M
      >;
    },
    validateDecode(value) {
      return (value === undefined ? ok(undefined) : decoder.validateDecode(value)) as DecodeOutput<
        T | undefined,
        readonly DecodeIssue[],
        M
      >;
    },
  } as UndefinedableDecoder<T, E, M>, {
    mode: decodeModeOf(decoder),
    root: {
      kind: 'union',
      members: [
        decodeNodeOf(decoder),
        { kind: 'undefined' },
      ],
    },
  });
}

export function nullable<T, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
): Decoder<T | null, E, M> {
  return __attachDecodeMetadata(fromDecode(
    (value) => (value === null ? ok(null) : decoder.decode(value)) as MaybeDecodeOutput<T | null, E>,
    (value) =>
      (value === null ? ok(null) : decoder.validateDecode(value)) as MaybeDecodeOutput<
        T | null,
        readonly DecodeIssue[]
      >,
  ), {
    mode: decodeModeOf(decoder),
    root: {
      kind: 'union',
      members: [
        decodeNodeOf(decoder),
        { kind: 'null' },
      ],
    },
  });
}

export function defaulted<
  TDecoder extends Decoder<unknown, unknown, DecodeMode>,
  TValue = Exclude<DecoderValue<TDecoder>, undefined>,
>(
  decoder: TDecoder & Decoder<TValue | undefined, DecoderError<TDecoder>, DecoderModeOf<TDecoder>>,
  fallback: TValue,
): Decoder<TValue, DecoderError<TDecoder>, DecoderModeOf<TDecoder>>;
export function defaulted<
  TDecoder extends Decoder<unknown, unknown, DecodeMode>,
  TValue = Exclude<DecoderValue<TDecoder>, undefined>,
  TFallback extends TValue | Promise<TValue> = TValue | Promise<TValue>,
>(
  decoder: TDecoder & Decoder<TValue | undefined, DecoderError<TDecoder>, DecoderModeOf<TDecoder>>,
  fallback: () => TFallback,
): Decoder<TValue, DecoderError<TDecoder>, MergeDecodeModes<DecoderModeOf<TDecoder> | AsyncModeOf<TFallback>>>;
export function defaulted<
  TDecoder extends Decoder<unknown, unknown, DecodeMode>,
  TValue = Exclude<DecoderValue<TDecoder>, undefined>,
>(
  decoder: TDecoder & Decoder<TValue | undefined, DecoderError<TDecoder>, DecoderModeOf<TDecoder>>,
  fallback: TValue | (() => TValue | Promise<TValue>),
): Decoder<TValue, DecoderError<TDecoder>, DecodeMode> {
  type T = TValue;
  type E = DecoderError<TDecoder>;
  const typedDecoder = decoder as Decoder<T | undefined, E, DecodeMode>;
  const resolveFallback = (): T | Promise<T> =>
    typeof fallback === 'function'
      ? (fallback as () => T | Promise<T>)()
      : fallback;

  const mapDefaultedDecode = (
    decoded: Result<T | undefined, E>,
  ): MaybeDecodeOutput<T, E> => {
    if (isErr(decoded)) {
      return decoded as Result<T, E>;
    }

    if (decoded.value === undefined) {
      return mapMaybeAsync(resolveFallback(), (resolved): Result<T, E> => ok(resolved));
    }

    return ok(decoded.value);
  };

  const mapDefaultedValidation = (
    decoded: Result<T | undefined, readonly DecodeIssue[]>,
  ): MaybeDecodeOutput<T, readonly DecodeIssue[]> => {
    if (isErr(decoded)) {
      return decoded as Result<T, readonly DecodeIssue[]>;
    }

    if (decoded.value === undefined) {
      return mapMaybeAsync(
        resolveFallback(),
        (resolved): Result<T, readonly DecodeIssue[]> => ok(resolved),
      );
    }

    return ok(decoded.value);
  };

  return __attachDecodeMetadata({
    __soundscriptDefaulted: true,
    decode(value) {
      return mapDecodeOutput(typedDecoder.decode(value), mapDefaultedDecode) as DecodeOutput<
        T,
        E,
        DecodeMode
      >;
    },
    validateDecode(value) {
      return mapDecodeOutput(
        typedDecoder.validateDecode(value),
        mapDefaultedValidation,
      ) as DecodeOutput<T, readonly DecodeIssue[], DecodeMode>;
    },
  } as DefaultedDecoder<T, E, DecodeMode>, {
    mode: () => decodeModeOf(decoder) === 'async' || typeof fallback === 'function' && __isAsyncCallable(fallback)
      ? 'async'
      : 'sync',
    root: __cloneNodeWithEffects(decodeNodeOf(decoder), [{
      ...(typeof fallback === 'function'
        ? {
          async: __isAsyncCallable(fallback),
          helperName: __helperName(fallback),
          kind: 'default' as const,
          opaque: true,
        }
        : {
          kind: 'default' as const,
          value: __metadataValueOf(fallback),
        }),
    }]),
  });
}

export function preprocess<A, E, M extends DecodeMode, TPreprocessed>(
  decoder: Decoder<A, E, M>,
  project: (value: unknown) => TPreprocessed,
): Decoder<A, E, MergeDecodeModes<M | AsyncModeOf<TPreprocessed>>> {
  type TMode = MergeDecodeModes<M | AsyncModeOf<TPreprocessed>>;
  return __attachDecodeMetadata(fromDecode<A, E, TMode>(
    (value) =>
      chainMaybeAsync(project(value), (projected) => decoder.decode(projected)) as DecodeOutput<
        A,
        E,
        TMode
      >,
    (value) =>
      chainMaybeAsync(project(value), (projected) => decoder.validateDecode(projected)) as DecodeOutput<
        A,
        readonly DecodeIssue[],
        TMode
      >,
  ), {
    mode: decodeModeOf(decoder) === 'async' || __isAsyncCallable(project) ? 'async' : 'sync',
    root: __cloneNodeWithEffects(decodeNodeOf(decoder), [decodeOpaqueEffect('preprocess', project)]),
  });
}

export function literal<const T extends string | number | boolean | null>(value: T): Decoder<T> {
  return __attachDecodeMetadata(fromDecode((input) =>
    Object.is(input, value)
      ? ok(value)
      : err(new DecodeFailure(`Expected literal ${JSON.stringify(value)}.`, { cause: input }))
  ), {
    mode: 'sync',
    root: value === null ? { kind: 'null' } : { kind: 'literal', value },
  });
}

export function min<T extends number | bigint, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
  minimum: T,
): Decoder<T, E | DecodeFailure, M> {
  return constrain(decoder, (value) =>
    value >= minimum ? null : {
      code: 'decode_min',
      input: value,
      message: `Expected value >= ${String(minimum)}.`,
      path: [],
    }
  , decodeConstraintEffect({ kind: 'min', value: minimum }));
}

export function max<T extends number | bigint, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
  maximum: T,
): Decoder<T, E | DecodeFailure, M> {
  return constrain(decoder, (value) =>
    value <= maximum ? null : {
      code: 'decode_max',
      input: value,
      message: `Expected value <= ${String(maximum)}.`,
      path: [],
    }
  , decodeConstraintEffect({ kind: 'max', value: maximum }));
}

export function minLength<T extends string | readonly unknown[], E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
  minimum: number,
): Decoder<T, E | DecodeFailure, M> {
  return constrain(decoder, (value) =>
    value.length >= minimum ? null : {
      code: 'decode_min_length',
      input: value,
      message: `Expected length >= ${minimum}.`,
      path: [],
    }
  , decodeConstraintEffect({ kind: 'minLength', value: minimum }));
}

export function maxLength<T extends string | readonly unknown[], E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
  maximum: number,
): Decoder<T, E | DecodeFailure, M> {
  return constrain(decoder, (value) =>
    value.length <= maximum ? null : {
      code: 'decode_max_length',
      input: value,
      message: `Expected length <= ${maximum}.`,
      path: [],
    }
  , decodeConstraintEffect({ kind: 'maxLength', value: maximum }));
}

export function startsWith<E, M extends DecodeMode>(
  decoder: Decoder<string, E, M>,
  prefix: string,
): Decoder<string, E | DecodeFailure, M> {
  return constrain(decoder, (value) =>
    value.startsWith(prefix) ? null : {
      code: 'decode_starts_with',
      input: value,
      message: `Expected string to start with ${JSON.stringify(prefix)}.`,
      path: [],
    }
  , decodeConstraintEffect({ kind: 'startsWith', value: prefix }));
}

export function endsWith<E, M extends DecodeMode>(
  decoder: Decoder<string, E, M>,
  suffix: string,
): Decoder<string, E | DecodeFailure, M> {
  return constrain(decoder, (value) =>
    value.endsWith(suffix) ? null : {
      code: 'decode_ends_with',
      input: value,
      message: `Expected string to end with ${JSON.stringify(suffix)}.`,
      path: [],
    }
  , decodeConstraintEffect({ kind: 'endsWith', value: suffix }));
}

export function pattern<E, M extends DecodeMode>(
  decoder: Decoder<string, E, M>,
  expression: RegExp,
): Decoder<string, E | DecodeFailure, M> {
  return constrain(decoder, (value) =>
    expression.test(value) ? null : {
      code: 'decode_pattern',
      input: value,
      message: `Expected string to match ${expression}.`,
      path: [],
    }
  , decodeConstraintEffect({ flags: expression.flags, kind: 'pattern', source: expression.source }));
}

export function multipleOf<T extends number | bigint, E, M extends DecodeMode>(
  decoder: Decoder<T, E, M>,
  factor: T,
): Decoder<T, E | DecodeFailure, M> {
  return constrain(decoder, (value) => {
    if ((typeof factor === 'number' && factor === 0) || (typeof factor === 'bigint' && factor === 0n)) {
      return {
        code: 'decode_multiple_of',
        input: value,
        message: 'Expected multipleOf factor to be non-zero.',
        path: [],
      };
    }
    if (typeof value === 'bigint' && typeof factor === 'bigint') {
      return value % factor === 0n ? null : {
        code: 'decode_multiple_of',
        input: value,
        message: `Expected value to be a multiple of ${String(factor)}.`,
        path: [],
      };
    }
    if (typeof value === 'number' && typeof factor === 'number') {
      return value % factor === 0 ? null : {
        code: 'decode_multiple_of',
        input: value,
        message: `Expected value to be a multiple of ${String(factor)}.`,
        path: [],
      };
    }
    return {
      code: 'decode_multiple_of',
      input: value,
      message: `Expected value to be a multiple of ${String(factor)}.`,
      path: [],
    };
  }, decodeConstraintEffect({ kind: 'multipleOf', value: factor }));
}

export function integer<E, M extends DecodeMode>(
  decoder: Decoder<number, E, M>,
): Decoder<number, E | DecodeFailure, M> {
  return constrain(decoder, (value) =>
    Number.isInteger(value) ? null : {
      code: 'decode_integer',
      input: value,
      message: 'Expected integer.',
      path: [],
    }
  , decodeConstraintEffect({ kind: 'integer' }));
}

export function format<E, M extends DecodeMode>(
  decoder: Decoder<string, E, M>,
  expectedFormat: DecodeFormat,
): Decoder<string, E | DecodeFailure, M> {
  return constrain(decoder, (value) =>
    stringMatchesFormat(value, expectedFormat) ? null : {
      code: 'decode_format',
      input: value,
      message: `Expected string with format "${expectedFormat}".`,
      path: [],
    }
  , decodeConstraintEffect({ kind: 'format', value: expectedFormat }));
}

export function array<T, E>(
  item: Decoder<T, E, 'sync'>,
): Decoder<readonly T[], E | DecodeFailure, 'sync'>;
export function array<T, E>(
  item: Decoder<T, E, 'async'>,
): Decoder<readonly T[], E | DecodeFailure, 'async'>;
export function array<T, E, M extends DecodeMode>(
  item: Decoder<T, E, M>,
): Decoder<readonly T[], E | DecodeFailure, M> {
  return __attachDecodeMetadata(fromDecode(
    (value) => {
      if (!Array.isArray(value)) {
        return err(new DecodeFailure('Expected array.', { cause: value }));
      }

      const decodedValues: T[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const decoded = item.decode(value[index]) as MaybeDecodeOutput<T, E>;
        if (isPromiseLike(decoded)) {
          return decodeArrayAsync(value, item, decodedValues, index, decoded);
        }
        if (isErr(decoded)) {
          return err(prependPathIfPossible(decoded.error, index) as E | DecodeFailure);
        }
        decodedValues.push(decoded.value);
      }

      return ok(decodedValues);
    },
    (value) => {
      if (!Array.isArray(value)) {
        return err([issueFromDecodeFailure(new DecodeFailure('Expected array.', { cause: value }))]);
      }

      const decodedValues: T[] = [];
      const issues: DecodeIssue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const decoded = item.validateDecode(value[index]) as MaybeDecodeOutput<T, readonly DecodeIssue[]>;
        if (isPromiseLike(decoded)) {
          return validateArrayAsync(value, item, decodedValues, issues, index, decoded);
        }
        if (isErr(decoded)) {
          issues.push(...prependIssuePaths(decoded.error, index));
          continue;
        }
        decodedValues.push(decoded.value);
      }

      return issues.length > 0 ? err(issues) : ok(decodedValues);
    },
  ), {
    mode: decodeModeOf(item),
    root: {
      element: decodeNodeOf(item),
      kind: 'array',
    },
  });
}

export function readonlyRecord<T, E, M extends DecodeMode>(
  valueDecoder: Decoder<T, E, M>,
): Decoder<Readonly<Record<string, T>>, E | DecodeFailure, M> {
  return __attachDecodeMetadata(fromDecode(
    (value) => {
      if (!isPlainObject(value)) {
        return err(new DecodeFailure('Expected object record.', { cause: value }));
      }

      const decodedRecord: Record<string, T> = {};
      for (const [key, entry] of Object.entries(value)) {
        const decoded = valueDecoder.decode(entry) as MaybeDecodeOutput<T, E>;
        if (isPromiseLike(decoded)) {
          return decodeRecordAsync(value, valueDecoder, decodedRecord, key, decoded);
        }
        if (isErr(decoded)) {
          return err(prependPathIfPossible(decoded.error, key) as E | DecodeFailure);
        }
        decodedRecord[key] = decoded.value;
      }

      return ok(decodedRecord);
    },
    (value) => {
      if (!isPlainObject(value)) {
        return err([
          issueFromDecodeFailure(new DecodeFailure('Expected object record.', { cause: value })),
        ]);
      }

      const decodedRecord: Record<string, T> = {};
      const issues: DecodeIssue[] = [];
      const entries = Object.entries(value);
      for (let index = 0; index < entries.length; index += 1) {
        const [key, entry] = entries[index]!;
        const decoded = valueDecoder.validateDecode(entry) as MaybeDecodeOutput<
          T,
          readonly DecodeIssue[]
        >;
        if (isPromiseLike(decoded)) {
          return validateRecordAsync(entries, valueDecoder, decodedRecord, issues, index, decoded);
        }
        if (isErr(decoded)) {
          issues.push(...prependIssuePaths(decoded.error, key));
          continue;
        }
        decodedRecord[key] = decoded.value;
      }

      return issues.length > 0 ? err(issues) : ok(decodedRecord);
    },
  ), {
    mode: decodeModeOf(valueDecoder),
    root: {
      key: 'string',
      kind: 'record',
      value: decodeNodeOf(valueDecoder),
    },
  });
}

export function tuple<const TElements extends TupleShape>(
  ...elements: TElements
): Decoder<
  { readonly [K in keyof TElements]: DecoderValue<TElements[K]> },
  DecoderError<TElements[number]> | DecodeFailure,
  TupleDecodeMode<TElements>
> {
  type TValue = { readonly [K in keyof TElements]: DecoderValue<TElements[K]> };
  type TError = DecoderError<TElements[number]> | DecodeFailure;
  type TMode = TupleDecodeMode<TElements>;

  return __attachDecodeMetadata(fromDecode<TValue, TError, TMode>(
    (value) => {
      if (!Array.isArray(value)) {
        return err(new DecodeFailure('Expected tuple.', { cause: value })) as DecodeOutput<
          TValue,
          TError,
          TMode
        >;
      }

      if (value.length !== elements.length) {
        return err(
          new DecodeFailure(`Expected tuple of length ${elements.length}.`, {
            cause: value,
          }),
        ) as DecodeOutput<TValue, TError, TMode>;
      }

      const decodedValues: unknown[] = [];
      for (let index = 0; index < elements.length; index += 1) {
        const elementDecoder = elements[index];
        if (!elementDecoder) {
          continue;
        }
        const decoded = elementDecoder.decode(value[index]) as MaybeDecodeOutput<
          DecoderValue<TElements[number]>,
          DecoderError<TElements[number]>
        >;
        if (isPromiseLike(decoded)) {
          return decodeTupleAsync(value, elements, decodedValues, index, decoded) as DecodeOutput<
            TValue,
            TError,
            TMode
          >;
        }
        if (isErr(decoded)) {
          return err(prependPathIfPossible(decoded.error, index) as TError) as DecodeOutput<
            TValue,
            TError,
            TMode
          >;
        }
        decodedValues.push(decoded.value);
      }

      return ok(decodedValues as TValue) as DecodeOutput<TValue, TError, TMode>;
    },
    (value) => {
      if (!Array.isArray(value)) {
        return err([
          issueFromDecodeFailure(new DecodeFailure('Expected tuple.', { cause: value })),
        ]) as unknown as DecodeOutput<TValue, readonly DecodeIssue[], TMode>;
      }

      if (value.length !== elements.length) {
        return err([
          issueFromDecodeFailure(
            new DecodeFailure(`Expected tuple of length ${elements.length}.`, {
              cause: value,
            }),
          ),
        ]) as unknown as DecodeOutput<TValue, readonly DecodeIssue[], TMode>;
      }

      const decodedValues: unknown[] = [];
      const issues: DecodeIssue[] = [];
      for (let index = 0; index < elements.length; index += 1) {
        const elementDecoder = elements[index];
        if (!elementDecoder) {
          continue;
        }
        const decoded = elementDecoder.validateDecode(value[index]) as MaybeDecodeOutput<
          DecoderValue<TElements[number]>,
          readonly DecodeIssue[]
        >;
        if (isPromiseLike(decoded)) {
          return validateTupleAsync(value, elements, decodedValues, issues, index, decoded) as DecodeOutput<
            TValue,
            readonly DecodeIssue[],
            TMode
          >;
        }
        if (isErr(decoded)) {
          issues.push(...prependIssuePaths(decoded.error, index));
          continue;
        }
        decodedValues.push(decoded.value);
      }

      return (issues.length > 0 ? err(issues) : ok(decodedValues as TValue)) as DecodeOutput<
        TValue,
        readonly DecodeIssue[],
        TMode
      >;
    },
  ), {
    mode: () => elements.some((element) => decodeModeOf(element) === 'async') ? 'async' : 'sync',
    root: {
      elements: elements.map((element) => decodeNodeOf(element)),
      kind: 'tuple',
    },
  });
}

export function option<T, E, M extends DecodeMode>(
  item: Decoder<T, E, M>,
): Decoder<Option<T>, E | DecodeFailure, M> {
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
  ) as Decoder<Option<T>, E | DecodeFailure, M>;
}

export function result<T, EValue, EDecodeValue, EDecodeError, MOk extends DecodeMode, MErr extends DecodeMode>(
  okDecoder: Decoder<T, EDecodeValue, MOk>,
  errDecoder: Decoder<EValue, EDecodeError, MErr>,
): Decoder<Result<T, EValue>, EDecodeValue | EDecodeError | DecodeFailure, MergeDecodeModes<MOk | MErr>> {
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
  ) as unknown as Decoder<
    Result<T, EValue>,
    EDecodeValue | EDecodeError | DecodeFailure,
    MergeDecodeModes<MOk | MErr>
  >;
}

export function object<const TShape extends ObjectShape>(
  shape: TShape,
  options?: DecodeObjectOptions,
): Decoder<
  ObjectValueOfShape<TShape>,
  DecoderError<TShape[keyof TShape]> | DecodeFailure,
  ShapeDecodeMode<TShape>
> {
  type TValue = ObjectValueOfShape<TShape>;
  type TError = DecoderError<TShape[keyof TShape]> | DecodeFailure;
  type TMode = ShapeDecodeMode<TShape>;
  const keys = Object.keys(shape) as readonly (keyof TShape & string)[];
  const keySet = new Set<string>(keys);
  const unknownKeys = options?.unknownKeys ?? 'strip';

  return __attachDecodeMetadata(fromDecode<TValue, TError, TMode>(
    (value) => {
      if (!isPlainObject(value)) {
        return err(new DecodeFailure('Expected object.', { cause: value })) as DecodeOutput<
          TValue,
          TError,
          TMode
        >;
      }

      const record = value as Record<string, unknown>;
      const extraKeys = collectUnknownObjectKeys(record, keySet);
      if (unknownKeys === 'strict' && extraKeys.length > 0) {
        return err(unknownDecodeKeyFailure(extraKeys[0]!, record[extraKeys[0]!])) as DecodeOutput<
          TValue,
          TError,
          TMode
        >;
      }
      const decodedObject: Record<string, unknown> = unknownKeys === 'passthrough' ? { ...record } : {};

      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        const decoder = shape[key];
        if (!decoder) {
          continue;
        }
        const hasKey = key in record;
        const rawValue = record[key];

        if (!hasKey && !allowsMissingObjectField(decoder)) {
          return err(
            new DecodeFailure(`Missing field "${key}".`, {
              cause: value,
              path: [key],
            }),
          ) as DecodeOutput<TValue, TError, TMode>;
        }

        if (hasKey && rawValue === undefined && !allowsUndefinedObjectField(decoder)) {
          return err(
            new DecodeFailure(`Missing field "${key}".`, {
              cause: value,
              path: [key],
            }),
          ) as DecodeOutput<TValue, TError, TMode>;
        }

        const decodeInput = hasKey ? rawValue : undefined;
        const decoded = decoder.decode(decodeInput) as MaybeDecodeOutput<
          DecoderValue<TShape[keyof TShape]>,
          DecoderError<TShape[keyof TShape]>
        >;
        if (isPromiseLike(decoded)) {
          return decodeObjectAsync(record, shape, keys, decodedObject, index, decoded) as DecodeOutput<
            TValue,
            TError,
            TMode
          >;
        }

        if (isErr(decoded)) {
          return err(prependPathIfPossible(decoded.error, key) as TError) as DecodeOutput<
            TValue,
            TError,
            TMode
          >;
        }

        decodedObject[key] = decoded.value;
      }

      return ok(decodedObject as TValue) as DecodeOutput<TValue, TError, TMode>;
    },
    (value) => {
      if (!isPlainObject(value)) {
        return err([
          issueFromDecodeFailure(new DecodeFailure('Expected object.', { cause: value })),
        ]) as unknown as DecodeOutput<TValue, readonly DecodeIssue[], TMode>;
      }

      const record = value as Record<string, unknown>;
      const decodedObject: Record<string, unknown> = unknownKeys === 'passthrough' ? { ...record } : {};
      const issues: DecodeIssue[] = [];
      if (unknownKeys === 'strict') {
        for (const extraKey of collectUnknownObjectKeys(record, keySet)) {
          issues.push({
            code: 'decode_unknown_key',
            input: record[extraKey],
            message: `Unknown field "${extraKey}".`,
            path: [extraKey],
          });
        }
      }

      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!;
        const decoder = shape[key];
        if (!decoder) {
          continue;
        }
        const hasKey = key in record;
        const rawValue = record[key];

        if (!hasKey && !allowsMissingObjectField(decoder)) {
          issues.push(issueFromDecodeFailure(new DecodeFailure(`Missing field "${key}".`, {
            cause: value,
            path: [key],
          })));
          continue;
        }

        if (hasKey && rawValue === undefined && !allowsUndefinedObjectField(decoder)) {
          issues.push(issueFromDecodeFailure(new DecodeFailure(`Missing field "${key}".`, {
            cause: value,
            path: [key],
          })));
          continue;
        }

        const decodeInput = hasKey ? rawValue : undefined;
        const decoded = decoder.validateDecode(decodeInput) as MaybeDecodeOutput<
          DecoderValue<TShape[keyof TShape]>,
          readonly DecodeIssue[]
        >;
        if (isPromiseLike(decoded)) {
          return validateObjectAsync(record, shape, keys, decodedObject, issues, index, decoded) as DecodeOutput<
            TValue,
            readonly DecodeIssue[],
            TMode
          >;
        }

        if (isErr(decoded)) {
          issues.push(...prependIssuePaths(decoded.error, key));
          continue;
        }

        decodedObject[key] = decoded.value;
      }

      return (issues.length > 0 ? err(issues) : ok(decodedObject as TValue)) as DecodeOutput<
        TValue,
        readonly DecodeIssue[],
        TMode
      >;
    },
  ), {
    mode: () => keys.some((key) => decodeModeOf(shape[key]) === 'async') ? 'async' : 'sync',
    root: {
      fields: keys.map((key) => {
        const decoder = shape[key]!;
        const fieldMetadata = __fieldMetadataOf(decoder);
        return {
          ...(fieldMetadata?.effects ? { effects: fieldMetadata.effects } : {}),
          localName: fieldMetadata?.localName ?? key,
          node: decodeNodeOf(decoder),
          optional: allowsMissingObjectField(decoder),
          wireName: fieldMetadata?.wireName ?? key,
        };
      }),
      kind: 'object',
      unknownKeys,
    },
  });
}

export function strictObject<const TShape extends ObjectShape>(
  shape: TShape,
): Decoder<
  ObjectValueOfShape<TShape>,
  DecoderError<TShape[keyof TShape]> | DecodeFailure,
  ShapeDecodeMode<TShape>
> {
  return object(shape, { unknownKeys: 'strict' });
}

export function passthroughObject<const TShape extends ObjectShape>(
  shape: TShape,
): Decoder<
  ObjectValueOfShape<TShape>,
  DecoderError<TShape[keyof TShape]> | DecodeFailure,
  ShapeDecodeMode<TShape>
> {
  return object(shape, { unknownKeys: 'passthrough' });
}

export function field<K extends string, T, E, M extends DecodeMode>(
  key: K,
  decoder: Decoder<T, E, M>,
): Decoder<T, E | DecodeFailure, M> {
  const shape = { [key]: decoder } as { readonly [P in K]: Decoder<T, E, M> };
  return map(object(shape), (value) => (value as Readonly<Record<K, T>>)[key]) as Decoder<
    T,
    E | DecodeFailure,
    M
  >;
}

export function optionalField<K extends string, T, E, M extends DecodeMode>(
  key: K,
  decoder: Decoder<T, E, M>,
): Decoder<T | undefined, E | DecodeFailure, M> {
  const shape = { [key]: optional(decoder) } as unknown as {
    readonly [P in K]: OptionalDecoder<T, E, M>;
  };
  return map(object(shape), (value) => (value as { readonly [P in K]?: T })[key]) as Decoder<
    T | undefined,
    E | DecodeFailure,
    M
  >;
}

export function union<A, B, ELeft, ERight, MLeft extends DecodeMode, MRight extends DecodeMode>(
  left: Decoder<A, ELeft, MLeft>,
  right: Decoder<B, ERight, MRight>,
): Decoder<A | B, ELeft | ERight | DecodeFailure, MergeDecodeModes<MLeft | MRight>> {
  type TValue = A | B;
  type TError = ELeft | ERight | DecodeFailure;
  type TMode = MergeDecodeModes<MLeft | MRight>;
  return __attachDecodeMetadata(fromDecode<TValue, TError, TMode>(
    (value) => {
      const leftDecoded = left.decode(value) as MaybeDecodeOutput<A, ELeft>;
      if (isPromiseLike(leftDecoded)) {
        return decodeUnionAsync(value, leftDecoded, right) as DecodeOutput<TValue, TError, TMode>;
      }
      if (isErr(leftDecoded)) {
        const rightDecoded = right.decode(value) as MaybeDecodeOutput<B, ERight>;
        if (isPromiseLike(rightDecoded)) {
          return decodeRightUnionAsync(value, rightDecoded) as DecodeOutput<TValue, TError, TMode>;
        }
        if (isErr(rightDecoded)) {
          return err(
            new DecodeFailure('Expected one of the union members.', {
              cause: value,
            }),
          ) as DecodeOutput<TValue, TError, TMode>;
        }
        return rightDecoded as DecodeOutput<TValue, TError, TMode>;
      }
      return leftDecoded as DecodeOutput<TValue, TError, TMode>;
    },
    (value) => {
      const leftDecoded = left.validateDecode(value) as MaybeDecodeOutput<A, readonly DecodeIssue[]>;
      if (isPromiseLike(leftDecoded)) {
        return validateUnionAsync(value, leftDecoded, right) as DecodeOutput<
          TValue,
          readonly DecodeIssue[],
          TMode
        >;
      }
      if (!isErr(leftDecoded)) {
        return leftDecoded as DecodeOutput<TValue, readonly DecodeIssue[], TMode>;
      }

      const rightDecoded = right.validateDecode(value) as MaybeDecodeOutput<B, readonly DecodeIssue[]>;
      if (isPromiseLike(rightDecoded)) {
        return validateRightUnionAsync(leftDecoded.error, rightDecoded, value) as DecodeOutput<
          TValue,
          readonly DecodeIssue[],
          TMode
        >;
      }
      if (!isErr(rightDecoded)) {
        return rightDecoded as DecodeOutput<TValue, readonly DecodeIssue[], TMode>;
      }
      return err(selectUnionIssues(leftDecoded.error, rightDecoded.error, value)) as DecodeOutput<
        TValue,
        readonly DecodeIssue[],
        TMode
      >;
    },
  ), {
    mode: () => mergeDecodeRuntimeModes(left, right),
    root: {
      kind: 'union',
      members: [
        decodeNodeOf(left),
        decodeNodeOf(right),
      ],
    },
  });
}

export function map<A, B, E, M extends DecodeMode, TProjected>(
  decoder: Decoder<A, E, M>,
  project: (value: A) => TProjected,
): Decoder<Awaited<TProjected>, E, MergeDecodeModes<M | AsyncModeOf<TProjected>>> {
  type TValue = Awaited<TProjected>;
  type TMode = MergeDecodeModes<M | AsyncModeOf<TProjected>>;

  return __attachDecodeMetadata(fromDecode<TValue, E, TMode>(
    (value) => projectDecode(decoder.decode(value), project) as DecodeOutput<TValue, E, TMode>,
    (value) => projectDecode(decoder.validateDecode(value), project) as DecodeOutput<
      TValue,
      readonly DecodeIssue[],
      TMode
    >,
  ), {
    mode: decodeModeOf(decoder) === 'async' || __isAsyncCallable(project) ? 'async' : 'sync',
    root: __cloneNodeWithEffects(decodeNodeOf(decoder), [decodeOpaqueEffect('transform', project)]),
  });
}

export function andThen<A, TNext extends Decoder<unknown, E, DecodeMode>, E, M extends DecodeMode>(
  decoder: Decoder<A, E, M>,
  project: (value: A) => TNext,
): Decoder<
  DecoderValue<TNext>,
  E,
  MergeDecodeModes<M | DecoderModeOf<TNext>>
> {
  type TValue = DecoderValue<TNext>;
  type TMode = MergeDecodeModes<M | DecoderModeOf<TNext>>;

  return __attachDecodeMetadata(fromDecode<TValue, E, TMode>(
    (value) => chainDecode(decoder.decode(value), project) as DecodeOutput<TValue, E, TMode>,
    (value) => chainValidateDecode(decoder.validateDecode(value), project) as DecodeOutput<
      TValue,
      readonly DecodeIssue[],
      TMode
    >,
  ), {
    mode: decodeModeOf(decoder) === 'async' || __isAsyncCallable(project) ? 'async' : 'sync',
    root: __cloneNodeWithEffects(decodeNodeOf(decoder), [decodeOpaqueEffect('andThen', project)]),
  });
}

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
): Decoder<A, E | DecodeFailure, MergeDecodeModes<M | AsyncModeOf<TResult>>>;
export function refine<
  A,
  E,
  M extends DecodeMode,
  TResult extends DecodeRefinementResult | Promise<DecodeRefinementResult>,
>(
  decoder: Decoder<A, E, M>,
  predicate: (value: A, ctx: DecodeRefinementContext) => TResult,
  message: string,
): Decoder<A, E | DecodeFailure, MergeDecodeModes<M | AsyncModeOf<TResult>>> {
  type TMode = MergeDecodeModes<M | AsyncModeOf<TResult>>;

  return __attachDecodeMetadata(fromDecode<A, E | DecodeFailure, TMode>(
    (value) => refineDecode(decoder.decode(value), predicate, message, value) as DecodeOutput<
      A,
      E | DecodeFailure,
      TMode
    >,
    (value) =>
      refineValidateDecode(decoder.validateDecode(value), predicate, message, value) as DecodeOutput<
        A,
        readonly DecodeIssue[],
        TMode
      >,
  ), {
    mode: decodeModeOf(decoder) === 'async' || __isAsyncCallable(predicate) ? 'async' : 'sync',
    root: __cloneNodeWithEffects(decodeNodeOf(decoder), [decodeOpaqueEffect('refine', predicate)]),
  });
}

function defaultValidateDecode<T, E>(
  decoded: MaybeDecodeOutput<T, E>,
  input: unknown,
): MaybeDecodeOutput<T, readonly DecodeIssue[]> {
  if (isPromiseLike(decoded)) {
    return decoded.then((result) =>
      isErr(result) ? err(normalizeDecodeIssues(result.error, input)) : ok(result.value)
    );
  }
  return isErr(decoded) ? err(normalizeDecodeIssues(decoded.error, input)) : ok(decoded.value);
}

function normalizeDecodeIssues(error: unknown, input: unknown): readonly DecodeIssue[] {
  if (Array.isArray(error) && error.every(isDecodeIssue)) {
    return error;
  }
  return [issueFromUnknown(error, input)];
}

function issueFromUnknown(error: unknown, input: unknown): DecodeIssue {
  if (isDecodeIssue(error)) {
    return error;
  }
  if (error instanceof DecodeFailure) {
    return issueFromDecodeFailure(error);
  }
  if (error instanceof Failure) {
    return {
      code: 'decode_failure',
      ...(input === undefined ? {} : { input }),
      message: error.message,
      path: [],
    };
  }
  if (error instanceof Error) {
    return {
      code: 'decode_failure',
      ...(input === undefined ? {} : { input }),
      message: error.message,
      path: [],
    };
  }
  return {
    code: 'decode_failure',
    ...(input === undefined ? {} : { input }),
    message: 'Failed to decode value.',
    path: [],
  };
}

function issueFromDecodeFailure(error: DecodeFailure): DecodeIssue {
  return {
    code: 'decode_failure',
    ...(error.cause === undefined ? {} : { input: error.cause }),
    message: error.message,
    path: error.path,
  };
}

function prependPathIfPossible<E>(error: E, segment: DecodePathSegment): E | DecodeFailure {
  return error instanceof DecodeFailure ? error.at(segment) : error;
}

function prependIssuePaths(
  issues: readonly DecodeIssue[],
  segment: DecodePathSegment,
): readonly DecodeIssue[] {
  return issues.map((issue) => ({
    ...issue,
    path: [segment, ...issue.path],
  }));
}

function constrain<A, E, M extends DecodeMode>(
  decoder: Decoder<A, E, M>,
  validate: (value: A) => DecodeIssue | null,
  effect?: MetadataEffect,
): Decoder<A, E | DecodeFailure, M> {
  return __attachDecodeMetadata(fromDecode<A, E | DecodeFailure, M>(
    (value) => {
      const decoded = decoder.decode(value);
      if (isPromiseLike(decoded)) {
        return decoded.then((resolved) => {
          if (isErr(resolved)) {
            return resolved as Result<A, E | DecodeFailure>;
          }
          const issue = validate(resolved.value);
          return issue === null
            ? ok(resolved.value)
            : err(new DecodeFailure(issue.message, {
              cause: issue.input,
              path: issue.path,
            }));
        });
      }
      if (isErr(decoded)) {
        return decoded as Result<A, E | DecodeFailure>;
      }
      const issue = validate(decoded.value);
      return issue === null
        ? ok(decoded.value)
        : err(new DecodeFailure(issue.message, {
          cause: issue.input,
          path: issue.path,
        }));
    },
    (value) => {
      const decoded = decoder.validateDecode(value);
      if (isPromiseLike(decoded)) {
        return decoded.then((resolved) => {
          if (isErr(resolved)) {
            return resolved;
          }
          const issue = validate(resolved.value);
          return issue === null ? ok(resolved.value) : err([issue]);
        });
      }
      if (isErr(decoded)) {
        return decoded;
      }
      const issue = validate(decoded.value);
      return issue === null ? ok(decoded.value) : err([issue]);
    },
  ), {
    mode: decodeModeOf(decoder),
    root: effect ? __cloneNodeWithEffects(decodeNodeOf(decoder), [effect]) : decodeNodeOf(decoder),
  });
}

function collectUnknownObjectKeys(
  record: Readonly<Record<string, unknown>>,
  keySet: ReadonlySet<string>,
): readonly string[] {
  return Object.keys(record).filter((key) => !keySet.has(key));
}

function unknownDecodeKeyFailure(
  key: string,
  value: unknown,
): DecodeFailure {
  return new DecodeFailure(`Unknown field "${key}".`, {
    cause: value,
    path: [key],
  });
}

function isDecodeIssue(value: unknown): value is DecodeIssue {
  return typeof value === 'object' && value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    Array.isArray((value as { path?: unknown }).path);
}

function isOptionalDecoder(
  value: Decoder<unknown, unknown, DecodeMode>,
): value is OptionalDecoder<unknown, unknown, DecodeMode> {
  return '__soundscriptOptional' in value && value.__soundscriptOptional === true;
}

function isUndefinedableDecoder(
  value: Decoder<unknown, unknown, DecodeMode>,
): value is UndefinedableDecoder<unknown, unknown, DecodeMode> {
  return '__soundscriptUndefinedable' in value && value.__soundscriptUndefinedable === true;
}

function isDefaultedDecoder(
  value: Decoder<unknown, unknown, DecodeMode>,
): value is DefaultedDecoder<unknown, unknown, DecodeMode> {
  return '__soundscriptDefaulted' in value && value.__soundscriptDefaulted === true;
}

function allowsMissingObjectField(
  decoder: Decoder<unknown, unknown, DecodeMode>,
): boolean {
  return isOptionalDecoder(decoder) || isDefaultedDecoder(decoder);
}

function allowsUndefinedObjectField(
  decoder: Decoder<unknown, unknown, DecodeMode>,
): boolean {
  return isOptionalDecoder(decoder) || isUndefinedableDecoder(decoder) || isDefaultedDecoder(decoder);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return value instanceof Promise;
}

function chainMaybeAsync<A, B>(
  value: MaybePromise<A>,
  project: (value: A) => MaybePromise<B>,
): MaybePromise<B> {
  return isPromiseLike(value) ? value.then((resolved) => project(resolved)) : project(value);
}

function mapDecodeOutput<A, B, E>(
  value: MaybeDecodeOutput<A, E>,
  project: (value: Result<A, E>) => MaybeDecodeOutput<B, E>,
): MaybeDecodeOutput<B, E> {
  return isPromiseLike(value) ? value.then((resolved) => project(resolved)) : project(value);
}

function mapMaybeAsync<A, B>(
  value: MaybePromise<A>,
  project: (value: A) => B,
): MaybePromise<B> {
  return isPromiseLike(value) ? value.then((resolved) => project(resolved)) : project(value);
}

function isIsoDatetimeString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
}

function stringMatchesFormat(value: string, expectedFormat: DecodeFormat): boolean {
  switch (expectedFormat) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    case 'url':
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case 'iso-datetime':
      return isIsoDatetimeString(value) && !Number.isNaN(new Date(value).getTime());
  }
}

function projectDecode<A, B>(
  value: MaybeDecodeOutput<A, readonly DecodeIssue[]>,
  project: (value: A) => B | Promise<B>,
): MaybeDecodeOutput<B, readonly DecodeIssue[]>;
function projectDecode<A, B, E>(
  value: MaybeDecodeOutput<A, E>,
  project: (value: A) => B | Promise<B>,
): MaybeDecodeOutput<B, E>;
function projectDecode<A, B, E>(
  value: MaybeDecodeOutput<A, E>,
  project: (value: A) => B | Promise<B>,
): MaybeDecodeOutput<B, E> {
  return mapDecodeOutput(value, (decoded) => {
    if (isErr(decoded)) {
      return decoded as Result<B, E>;
    }
    return mapMaybeAsync(project(decoded.value), (projected) => ok(projected));
  });
}

function chainDecode<A, TValue, E>(
  value: MaybeDecodeOutput<A, E>,
  project: (value: A) => Decoder<TValue, E, DecodeMode>,
): MaybeDecodeOutput<TValue, E> {
  return mapDecodeOutput(value, (decoded) =>
    isErr(decoded) ? decoded as Result<TValue, E> : project(decoded.value).decode(decoded.value)
  );
}

function chainValidateDecode<A, TValue, E>(
  value: MaybeDecodeOutput<A, readonly DecodeIssue[]>,
  project: (value: A) => Decoder<TValue, E, DecodeMode>,
): MaybeDecodeOutput<TValue, readonly DecodeIssue[]> {
  return mapDecodeOutput(value, (decoded) =>
    isErr(decoded) ? decoded as Result<TValue, readonly DecodeIssue[]>
    : project(decoded.value).validateDecode(decoded.value)
  );
}

function refineDecode<A, E>(
  value: MaybeDecodeOutput<A, E>,
  predicate: (value: A, ctx: DecodeRefinementContext) =>
    DecodeRefinementResult | Promise<DecodeRefinementResult>,
  message: string,
  input: unknown,
): MaybeDecodeOutput<A, E | DecodeFailure> {
  const context = createDecodeRefinementContext();
  if (isPromiseLike(value)) {
    return value.then((decoded) => {
      if (isErr(decoded)) {
        return decoded as Result<A, E | DecodeFailure>;
      }
      return mapMaybeAsync(predicate(decoded.value, context), (result) =>
        refinementPassed(result)
          ? ok(decoded.value)
          : err(decodeFailureFromRefinementResult(result, message, input))
      );
    });
  }
  if (isErr(value)) {
    return value as Result<A, E | DecodeFailure>;
  }
  return mapMaybeAsync(predicate(value.value, context), (result) =>
    refinementPassed(result)
      ? ok(value.value)
      : err(decodeFailureFromRefinementResult(result, message, input))
  );
}

function refineValidateDecode<A>(
  value: MaybeDecodeOutput<A, readonly DecodeIssue[]>,
  predicate: (value: A, ctx: DecodeRefinementContext) =>
    DecodeRefinementResult | Promise<DecodeRefinementResult>,
  message: string,
  input: unknown,
): MaybeDecodeOutput<A, readonly DecodeIssue[]> {
  const context = createDecodeRefinementContext();
  if (isPromiseLike(value)) {
    return value.then((decoded) => {
      if (isErr(decoded)) {
        return decoded;
      }
      return mapMaybeAsync(predicate(decoded.value, context), (result) =>
        refinementPassed(result)
          ? ok(decoded.value)
          : err(decodeIssuesFromRefinementResult(result, message, input))
      );
    });
  }
  if (isErr(value)) {
    return value;
  }
  return mapMaybeAsync(predicate(value.value, context), (result) =>
    refinementPassed(result)
      ? ok(value.value)
      : err(decodeIssuesFromRefinementResult(result, message, input))
  );
}

function createDecodeRefinementContext(): DecodeRefinementContext {
  return {
    issue(code, message, input) {
      return {
        code,
        ...(input === undefined ? {} : { input }),
        message,
        path: [],
      };
    },
    path: [],
  };
}

function refinementPassed(result: DecodeRefinementResult): boolean {
  return result === true || (Array.isArray(result) && result.length === 0);
}

function decodeFailureFromRefinementResult(
  result: DecodeRefinementResult,
  message: string,
  input: unknown,
): DecodeFailure {
  if (typeof result === 'string') {
    return new DecodeFailure(result, { cause: input });
  }
  if (isDecodeIssue(result)) {
    return new DecodeFailure(result.message, {
      cause: result.input ?? input,
      path: result.path,
    });
  }
  if (Array.isArray(result) && result.length > 0) {
    const firstIssue = result.find(isDecodeIssue);
    if (firstIssue) {
      return new DecodeFailure(firstIssue.message, {
        cause: firstIssue.input ?? input,
        path: firstIssue.path,
      });
    }
  }
  return new DecodeFailure(message, { cause: input });
}

function decodeIssuesFromRefinementResult(
  result: DecodeRefinementResult,
  message: string,
  input: unknown,
): readonly DecodeIssue[] {
  if (typeof result === 'string') {
    return [{
      code: 'decode_failure',
      ...(input === undefined ? {} : { input }),
      message: result,
      path: [],
    }];
  }
  if (isDecodeIssue(result)) {
    return [normalizeDecodeIssue(result, input)];
  }
  if (Array.isArray(result)) {
    const issues = result.filter(isDecodeIssue);
    return issues.length === 0 ? [] : issues.map((issue) => normalizeDecodeIssue(issue, input));
  }
  return [{
    code: 'decode_failure',
    ...(input === undefined ? {} : { input }),
    message,
    path: [],
  }];
}

function normalizeDecodeIssue(issue: DecodeIssue, input: unknown): DecodeIssue {
  return issue.input === undefined && input !== undefined ? { ...issue, input } : issue;
}

async function decodeArrayAsync<T, E>(
  values: readonly unknown[],
  item: Decoder<T, E, DecodeMode>,
  decodedValues: T[],
  startIndex: number,
  firstPending: Promise<Result<T, E>>,
): Promise<Result<readonly T[], E | DecodeFailure>> {
  const firstDecoded = await firstPending;
  if (isErr(firstDecoded)) {
    return err(prependPathIfPossible(firstDecoded.error, startIndex) as E | DecodeFailure);
  }
  decodedValues.push(firstDecoded.value);

  for (let index = startIndex + 1; index < values.length; index += 1) {
    const decoded = await item.decode(values[index]);
    if (isErr(decoded)) {
      return err(prependPathIfPossible(decoded.error, index) as E | DecodeFailure);
    }
    decodedValues.push(decoded.value);
  }
  return ok(decodedValues);
}

async function validateArrayAsync<T>(
  values: readonly unknown[],
  item: Decoder<T, unknown, DecodeMode>,
  decodedValues: T[],
  issues: DecodeIssue[],
  startIndex: number,
  firstPending: Promise<Result<T, readonly DecodeIssue[]>>,
): Promise<Result<readonly T[], readonly DecodeIssue[]>> {
  const firstDecoded = await firstPending;
  if (isErr(firstDecoded)) {
    issues.push(...prependIssuePaths(firstDecoded.error, startIndex));
  } else {
    decodedValues.push(firstDecoded.value);
  }

  for (let index = startIndex + 1; index < values.length; index += 1) {
    const decoded = await item.validateDecode(values[index]);
    if (isErr(decoded)) {
      issues.push(...prependIssuePaths(decoded.error, index));
      continue;
    }
    decodedValues.push(decoded.value);
  }
  return issues.length > 0 ? err(issues) : ok(decodedValues);
}

async function decodeRecordAsync<T, E>(
  value: Record<string, unknown>,
  decoder: Decoder<T, E, DecodeMode>,
  decodedRecord: Record<string, T>,
  firstKey: string,
  firstPending: Promise<Result<T, E>>,
): Promise<Result<Readonly<Record<string, T>>, E | DecodeFailure>> {
  const entries = Object.entries(value);
  const startIndex = entries.findIndex(([key]) => key === firstKey);

  const firstDecoded = await firstPending;
  if (isErr(firstDecoded)) {
    return err(prependPathIfPossible(firstDecoded.error, firstKey) as E | DecodeFailure);
  }
  decodedRecord[firstKey] = firstDecoded.value;

  for (let index = startIndex + 1; index < entries.length; index += 1) {
    const [key, entry] = entries[index]!;
    const decoded = await decoder.decode(entry);
    if (isErr(decoded)) {
      return err(prependPathIfPossible(decoded.error, key) as E | DecodeFailure);
    }
    decodedRecord[key] = decoded.value;
  }
  return ok(decodedRecord);
}

async function validateRecordAsync<T>(
  entries: readonly [string, unknown][],
  decoder: Decoder<T, unknown, DecodeMode>,
  decodedRecord: Record<string, T>,
  issues: DecodeIssue[],
  startIndex: number,
  firstPending: Promise<Result<T, readonly DecodeIssue[]>>,
): Promise<Result<Readonly<Record<string, T>>, readonly DecodeIssue[]>> {
  const [firstKey] = entries[startIndex]!;
  const firstDecoded = await firstPending;
  if (isErr(firstDecoded)) {
    issues.push(...prependIssuePaths(firstDecoded.error, firstKey));
  } else {
    decodedRecord[firstKey] = firstDecoded.value;
  }

  for (let index = startIndex + 1; index < entries.length; index += 1) {
    const [key, entry] = entries[index]!;
    const decoded = await decoder.validateDecode(entry);
    if (isErr(decoded)) {
      issues.push(...prependIssuePaths(decoded.error, key));
      continue;
    }
    decodedRecord[key] = decoded.value;
  }
  return issues.length > 0 ? err(issues) : ok(decodedRecord);
}

async function decodeTupleAsync<const TElements extends TupleShape>(
  values: readonly unknown[],
  elements: TElements,
  decodedValues: unknown[],
  startIndex: number,
  firstPending: Promise<Result<DecoderValue<TElements[number]>, DecoderError<TElements[number]>>>,
): Promise<Result<
  { readonly [K in keyof TElements]: DecoderValue<TElements[K]> },
  DecoderError<TElements[number]> | DecodeFailure
>> {
  const firstDecoded = await firstPending;
  if (isErr(firstDecoded)) {
    return err(
      prependPathIfPossible(firstDecoded.error, startIndex) as
        | DecoderError<TElements[number]>
        | DecodeFailure,
    );
  }
  decodedValues.push(firstDecoded.value);

  for (let index = startIndex + 1; index < elements.length; index += 1) {
    const elementDecoder = elements[index];
    if (!elementDecoder) {
      continue;
    }
    const decoded = await elementDecoder.decode(values[index]);
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
}

async function validateTupleAsync<const TElements extends TupleShape>(
  values: readonly unknown[],
  elements: TElements,
  decodedValues: unknown[],
  issues: DecodeIssue[],
  startIndex: number,
  firstPending: Promise<Result<DecoderValue<TElements[number]>, readonly DecodeIssue[]>>,
): Promise<Result<
  { readonly [K in keyof TElements]: DecoderValue<TElements[K]> },
  readonly DecodeIssue[]
>> {
  const firstDecoded = await firstPending;
  if (isErr(firstDecoded)) {
    issues.push(...prependIssuePaths(firstDecoded.error, startIndex));
  } else {
    decodedValues.push(firstDecoded.value);
  }

  for (let index = startIndex + 1; index < elements.length; index += 1) {
    const elementDecoder = elements[index];
    if (!elementDecoder) {
      continue;
    }
    const decoded = await elementDecoder.validateDecode(values[index]);
    if (isErr(decoded)) {
      issues.push(...prependIssuePaths(decoded.error, index));
      continue;
    }
    decodedValues.push(decoded.value);
  }
  return issues.length > 0
    ? err(issues)
    : ok(decodedValues as { readonly [K in keyof TElements]: DecoderValue<TElements[K]> });
}

async function decodeObjectAsync<TShape extends ObjectShape>(
  record: Record<string, unknown>,
  shape: TShape,
  keys: readonly (keyof TShape & string)[],
  decodedObject: Record<string, unknown>,
  startIndex: number,
  firstPending: Promise<Result<unknown, unknown>>,
): Promise<Result<
  ObjectValueOfShape<TShape>,
  DecoderError<TShape[keyof TShape]> | DecodeFailure
>> {
  const firstKey = keys[startIndex]!;
  const firstDecoded = await firstPending;
  if (isErr(firstDecoded)) {
    return err(
      prependPathIfPossible(firstDecoded.error, firstKey) as
        | DecoderError<TShape[keyof TShape]>
        | DecodeFailure,
    );
  }
  decodedObject[firstKey] = firstDecoded.value;

  for (let index = startIndex + 1; index < keys.length; index += 1) {
    const key = keys[index]!;
    const decoder = shape[key];
    if (!decoder) {
      continue;
    }

    const hasKey = key in record;
    const rawValue = record[key];
    if (!hasKey && !allowsMissingObjectField(decoder)) {
      return err(
        new DecodeFailure(`Missing field "${key}".`, {
          cause: record,
          path: [key],
        }),
      );
    }

    if (hasKey && rawValue === undefined && !allowsUndefinedObjectField(decoder)) {
      return err(
        new DecodeFailure(`Missing field "${key}".`, {
          cause: record,
          path: [key],
        }),
      );
    }

    const decodeInput = hasKey ? rawValue : undefined;
    const decoded = await decoder.decode(decodeInput);
    if (isErr(decoded)) {
      return err(prependPathIfPossible(decoded.error, key) as DecoderError<TShape[keyof TShape]> | DecodeFailure);
    }
    decodedObject[key] = decoded.value;
  }

  return ok(decodedObject as ObjectValueOfShape<TShape>);
}

async function validateObjectAsync<TShape extends ObjectShape>(
  record: Record<string, unknown>,
  shape: TShape,
  keys: readonly (keyof TShape & string)[],
  decodedObject: Record<string, unknown>,
  issues: DecodeIssue[],
  startIndex: number,
  firstPending: Promise<Result<unknown, readonly DecodeIssue[]>>,
): Promise<Result<
  ObjectValueOfShape<TShape>,
  readonly DecodeIssue[]
>> {
  const firstKey = keys[startIndex]!;
  const firstDecoded = await firstPending;
  if (isErr(firstDecoded)) {
    issues.push(...prependIssuePaths(firstDecoded.error, firstKey));
  } else {
    decodedObject[firstKey] = firstDecoded.value;
  }

  for (let index = startIndex + 1; index < keys.length; index += 1) {
    const key = keys[index]!;
    const decoder = shape[key];
    if (!decoder) {
      continue;
    }

    const hasKey = key in record;
    const rawValue = record[key];
    if (!hasKey && !allowsMissingObjectField(decoder)) {
      issues.push(issueFromDecodeFailure(new DecodeFailure(`Missing field "${key}".`, {
        cause: record,
        path: [key],
      })));
      continue;
    }

    if (hasKey && rawValue === undefined && !allowsUndefinedObjectField(decoder)) {
      issues.push(issueFromDecodeFailure(new DecodeFailure(`Missing field "${key}".`, {
        cause: record,
        path: [key],
      })));
      continue;
    }

    const decodeInput = hasKey ? rawValue : undefined;
    const decoded = await decoder.validateDecode(decodeInput);
    if (isErr(decoded)) {
      issues.push(...prependIssuePaths(decoded.error, key));
      continue;
    }
    decodedObject[key] = decoded.value;
  }

  return issues.length > 0
    ? err(issues)
    : ok(decodedObject as ObjectValueOfShape<TShape>);
}

async function decodeUnionAsync<A, B, ELeft, ERight>(
  value: unknown,
  leftDecoded: Promise<Result<A, ELeft>>,
  right: Decoder<B, ERight, DecodeMode>,
): Promise<Result<A | B, ELeft | ERight | DecodeFailure>> {
  const resolvedLeft = await leftDecoded;
  if (!isErr(resolvedLeft)) {
    return resolvedLeft;
  }
  return decodeRightUnionAsync(value, right.decode(value));
}

async function decodeRightUnionAsync<B, ERight>(
  value: unknown,
  rightDecoded: MaybeDecodeOutput<B, ERight>,
): Promise<Result<B, ERight | DecodeFailure>> {
  const resolvedRight = await rightDecoded;
  if (isErr(resolvedRight)) {
    return err(new DecodeFailure('Expected one of the union members.', { cause: value }));
  }
  return resolvedRight;
}

async function validateUnionAsync<A, B, ERight>(
  value: unknown,
  leftDecoded: Promise<Result<A, readonly DecodeIssue[]>>,
  right: Decoder<B, ERight, DecodeMode>,
): Promise<Result<A | B, readonly DecodeIssue[]>> {
  const resolvedLeft = await leftDecoded;
  if (!isErr(resolvedLeft)) {
    return resolvedLeft;
  }
  return validateRightUnionAsync(resolvedLeft.error, right.validateDecode(value), value);
}

async function validateRightUnionAsync<B>(
  leftIssues: readonly DecodeIssue[],
  rightDecoded: MaybeDecodeOutput<B, readonly DecodeIssue[]>,
  value: unknown,
): Promise<Result<B, readonly DecodeIssue[]>> {
  const resolvedRight = await rightDecoded;
  if (isErr(resolvedRight)) {
    return err(selectUnionIssues(leftIssues, resolvedRight.error, value));
  }
  return resolvedRight;
}

function selectUnionIssues(
  leftIssues: readonly DecodeIssue[],
  rightIssues: readonly DecodeIssue[],
  input: unknown,
): readonly DecodeIssue[] {
  if (leftIssues.length === 0 && rightIssues.length === 0) {
    return [{
      code: 'decode_union',
      input,
      message: 'Expected one of the union members.',
      path: [],
    }];
  }
  if (leftIssues.length === 0) {
    return rightIssues;
  }
  if (rightIssues.length === 0) {
    return leftIssues;
  }

  return compareUnionIssueSets(leftIssues, rightIssues) >= 0 ? leftIssues : rightIssues;
}

function compareUnionIssueSets(
  leftIssues: readonly DecodeIssue[],
  rightIssues: readonly DecodeIssue[],
): number {
  const leftScore = unionIssueSetScore(leftIssues);
  const rightScore = unionIssueSetScore(rightIssues);
  if (leftScore.maxDepth !== rightScore.maxDepth) {
    return leftScore.maxDepth - rightScore.maxDepth;
  }
  if (leftScore.issueCount !== rightScore.issueCount) {
    return rightScore.issueCount - leftScore.issueCount;
  }
  if (leftScore.totalDepth !== rightScore.totalDepth) {
    return leftScore.totalDepth - rightScore.totalDepth;
  }
  if (leftScore.rootIssueCount !== rightScore.rootIssueCount) {
    return rightScore.rootIssueCount - leftScore.rootIssueCount;
  }
  return 0;
}

function unionIssueSetScore(
  issues: readonly DecodeIssue[],
): {
  readonly issueCount: number;
  readonly maxDepth: number;
  readonly rootIssueCount: number;
  readonly totalDepth: number;
} {
  let maxDepth = 0;
  let rootIssueCount = 0;
  let totalDepth = 0;
  for (const issue of issues) {
    const depth = issue.path.length;
    maxDepth = Math.max(maxDepth, depth);
    totalDepth += depth;
    if (depth === 0) {
      rootIssueCount += 1;
    }
  }
  return {
    issueCount: issues.length,
    maxDepth,
    rootIssueCount,
    totalDepth,
  };
}
