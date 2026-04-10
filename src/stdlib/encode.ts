import { type Bind, type Kind3, type TypeLambda } from 'sts:hkt';
import { Failure } from 'sts:failures';
import { err, isErr, isOk, isSome, ok, type Option, type Result } from 'sts:result';
import type { Contravariant } from 'sts:typeclasses';
import type { UrlLike } from 'sts:decode';
import {
  __attachEncodeMetadata,
  __cloneNodeWithEffects,
  __encodeDirectionOrOpaque,
  __encodeModeOf,
  __fieldMetadataOf,
  __helperName,
  __inferCallableMode,
  __InternalMetadataNode,
  __isAsyncCallable,
  __setEncodeMode,
  type MetadataEffect,
} from './metadata.ts';

export type EncodeMode = 'sync' | 'async';
export type ObjectKeyPolicy = 'strip' | 'strict' | 'passthrough';
export type EncodeObjectOptions = {
  readonly unknownKeys?: ObjectKeyPolicy;
};
export type EncodePathSegment = string | number;
export type EncodePath = readonly EncodePathSegment[];
export type EncodeIssue = {
  readonly code: string;
  readonly input?: unknown;
  readonly message: string;
  readonly path: EncodePath;
};
export type EncodeRefinementContext = {
  readonly path: EncodePath;
  issue(code: string, message: string, input?: unknown): EncodeIssue;
};
export type EncodeRefinementResult = boolean | string | EncodeIssue | readonly EncodeIssue[];
export type EncodeOutput<T, E, M extends EncodeMode = 'sync'> = M extends 'async'
  ? Promise<Result<T, E>>
  : Result<T, E>;

type MaybePromise<T> = T | Promise<T>;
type MaybeEncodeOutput<T, E> = Result<T, E> | Promise<Result<T, E>>;
type AsyncModeOf<TReturn> = TReturn extends Promise<unknown> ? 'async' : 'sync';
type EncodeState = {
  readonly seen: WeakSet<object>;
};
const encodeWithStateSymbol = Symbol('soundscript.encodeWithState');
const validateEncodeWithStateSymbol = Symbol('soundscript.validateEncodeWithState');

export class EncodeFailure extends Failure {
  readonly path: EncodePath;

  constructor(
    message = 'Failed to encode value.',
    options: Readonly<{
      cause?: unknown;
      path?: EncodePath;
    }> = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.path = options.path ?? [];
  }

  at(segment: EncodePathSegment): this {
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

// #[variance(T: in, TEncoded: out, E: out, M: out)]
export type Encoder<T, TEncoded = unknown, E = EncodeFailure, M extends EncodeMode = 'sync'> = {
  encode(value: T): EncodeOutput<TEncoded, E, M>;
  validateEncode(value: T): EncodeOutput<TEncoded, readonly EncodeIssue[], M>;
};

// #[variance(T: in, TEncoded: out, E: out, M: out)]
export type OptionalEncoder<T, TEncoded = T, E = EncodeFailure, M extends EncodeMode = 'sync'> =
  & Encoder<T | undefined, TEncoded | undefined, E, M>
  & {
    readonly __soundscriptOptional: true;
    readonly inner: Encoder<T, TEncoded, E, M>;
  };

type UndefinedableEncoder<T, TEncoded = T, E = EncodeFailure, M extends EncodeMode = 'sync'> =
  & Encoder<T | undefined, TEncoded | undefined, E, M>
  & {
    readonly __soundscriptUndefinedable: true;
    readonly inner: Encoder<T, TEncoded, E, M>;
  };

type EncoderInput<TEncoder> = TEncoder extends Encoder<infer T, unknown, unknown, EncodeMode> ? T
  : never;
type EncoderOutputValue<TEncoder> = TEncoder extends
  Encoder<unknown, infer TEncoded, unknown, EncodeMode> ? TEncoded
  : never;
type EncoderError<TEncoder> = TEncoder extends Encoder<unknown, unknown, infer E, EncodeMode> ? E
  : never;
type EncoderModeOf<TEncoder> = TEncoder extends Encoder<unknown, unknown, unknown, infer M> ? M
  : never;
type MergeEncodeModes<M extends EncodeMode> = [M] extends [never] ? 'sync'
  : [M] extends ['sync'] ? 'sync'
  : 'async';
type ObjectShape = Record<string, Encoder<unknown, unknown, unknown, EncodeMode>>;
type TupleShape = readonly Encoder<unknown, unknown, unknown, EncodeMode>[];
type OptionalShapeKeys<TShape extends ObjectShape> = {
  readonly [K in keyof TShape]-?: TShape[K] extends
    OptionalEncoder<unknown, unknown, unknown, EncodeMode> ? K
    : never;
}[keyof TShape];
type RequiredShapeKeys<TShape extends ObjectShape> = Exclude<
  keyof TShape,
  OptionalShapeKeys<TShape>
>;
type ObjectInputOfShape<TShape extends ObjectShape> =
  & {
    readonly [K in RequiredShapeKeys<TShape>]: EncoderInput<TShape[K]>;
  }
  & {
    readonly [K in OptionalShapeKeys<TShape>]?: EncoderInput<TShape[K]>;
  };
type ObjectOutputOfShape<TShape extends ObjectShape> =
  & {
    readonly [K in RequiredShapeKeys<TShape>]: EncoderOutputValue<TShape[K]>;
  }
  & {
    readonly [K in OptionalShapeKeys<TShape>]?: EncoderOutputValue<TShape[K]>;
  };
type ShapeEncodeMode<TShape extends ObjectShape> = MergeEncodeModes<
  EncoderModeOf<TShape[keyof TShape]>
>;
type TupleEncodeMode<TElements extends TupleShape> = MergeEncodeModes<
  EncoderModeOf<TElements[number]>
>;
type StatefulEncoder<T, TEncoded = unknown, E = EncodeFailure, M extends EncodeMode = 'sync'> =
  & Encoder<T, TEncoded, E, M>
  & {
    [encodeWithStateSymbol]?: (value: T, state: EncodeState) => MaybeEncodeOutput<TEncoded, E>;
    [validateEncodeWithStateSymbol]?: (
      value: T,
      state: EncodeState,
    ) => MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]>;
  };

export interface EncoderF extends TypeLambda {
  readonly type: Encoder<this['Args'][2], this['Args'][1], this['Args'][0]>;
}

export type EncoderKind<E, TEncoded, T> = Kind3<EncoderF, E, TEncoded, T>;

export function fromEncode<T, TEncoded, E, M extends EncodeMode = 'sync'>(
  encode: (value: T, state?: EncodeState) => MaybeEncodeOutput<TEncoded, E>,
  validateEncode?: (
    value: T,
    state?: EncodeState,
  ) => MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]>,
): Encoder<T, TEncoded, E, M> {
  const inferredMode = __inferCallableMode(encode, validateEncode) as M;
  const encoder = {
    [encodeWithStateSymbol]: encode as (
      value: T,
      state: EncodeState,
    ) => MaybeEncodeOutput<TEncoded, E>,
    [validateEncodeWithStateSymbol]: (validateEncode ??
      ((value: T, state?: EncodeState) => defaultValidateEncode(encode(value, state), value))) as (
        value: T,
        state: EncodeState,
      ) => MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]>,
    encode: ((value: T) =>
      encodeWithStateImpl(
        encode as (value: T, state: EncodeState) => MaybeEncodeOutput<TEncoded, E>,
        value,
        createEncodeState(),
      )) as (value: T) => EncodeOutput<TEncoded, E, M>,
    validateEncode: ((value: T) =>
      validateEncodeWithStateImpl(
        (validateEncode ??
          ((nextValue: T, state?: EncodeState) =>
            defaultValidateEncode(encode(nextValue, state), nextValue))) as (
            value: T,
            state: EncodeState,
          ) => MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]>,
        value,
        createEncodeState(),
      )) as (value: T) => EncodeOutput<TEncoded, readonly EncodeIssue[], M>,
  } as StatefulEncoder<T, TEncoded, E, M>;
  __setEncodeMode(encoder, inferredMode);
  return __attachEncodeMetadata(encoder, {
    mode: inferredMode,
    root: { kind: 'opaque' },
  });
}

function encodeModeOf(encoder: unknown): EncodeMode {
  return __encodeModeOf(encoder) ?? 'sync';
}

function mergeEncodeRuntimeModes(...encoders: readonly unknown[]): EncodeMode {
  return encoders.some((encoder) => encodeModeOf(encoder) === 'async') ? 'async' : 'sync';
}

function encodeDirectionOf(encoder: unknown) {
  return __encodeDirectionOrOpaque(encoder);
}

function encodeNodeOf(encoder: unknown): __InternalMetadataNode {
  return encodeDirectionOf(encoder).root;
}

function encodeOpaqueEffect(
  effect: 'refine' | 'transform' | 'via',
  helper: unknown,
): MetadataEffect {
  return {
    async: __isAsyncCallable(helper),
    effect,
    helperName: __helperName(helper),
    kind: 'opaque',
  };
}

export function contramap<A, B, TEncoded, E>(
  encoder: Encoder<A, TEncoded, E>,
  project: (value: B) => A,
): Encoder<B, TEncoded, E>;
export function contramap<
  A,
  B,
  TEncoded,
  E,
  M extends EncodeMode,
  TProjected extends A | Promise<A>,
>(
  encoder: Encoder<A, TEncoded, E, M>,
  project: (value: B) => TProjected,
): Encoder<B, TEncoded, E, MergeEncodeModes<M | AsyncModeOf<TProjected>>>;
export function contramap<
  A,
  B,
  TEncoded,
  E,
  M extends EncodeMode,
  TProjected extends A | Promise<A>,
>(
  encoder: Encoder<A, TEncoded, E, M>,
  project: (value: B) => TProjected,
): Encoder<B, TEncoded, E, MergeEncodeModes<M | AsyncModeOf<TProjected>>> {
  type TMode = MergeEncodeModes<M | AsyncModeOf<TProjected>>;
  return __attachEncodeMetadata(
    fromEncode<B, TEncoded, E, TMode>(
      (value: B, state?: EncodeState) =>
        projectEncode(
          (projected: A) => encodeWithState(encoder, projected, state),
          project(value) as A | Promise<A>,
        ) as EncodeOutput<
          TEncoded,
          E,
          TMode
        >,
      (value: B, state?: EncodeState) =>
        projectEncode(
          (projected: A) => validateEncodeWithState(encoder, projected, state),
          project(value) as A | Promise<A>,
        ) as EncodeOutput<TEncoded, readonly EncodeIssue[], TMode>,
    ),
    {
      mode: encodeModeOf(encoder) === 'async' || __isAsyncCallable(project) ? 'async' : 'sync',
      root: __cloneNodeWithEffects(encodeNodeOf(encoder), [
        encodeOpaqueEffect('transform', project),
      ]),
    },
  );
}

export function encoderContravariant<TEncoded, E = EncodeFailure>(): Contravariant<
  Bind<Bind<EncoderF, [E]>, [TEncoded]>
> {
  return {
    contramap,
  };
}

export const stringEncoder: Encoder<string, string> = __attachEncodeMetadata(
  fromEncode((value) => ok(value)),
  { mode: 'sync', root: { kind: 'primitive', primitive: 'string' } },
);
export const numberEncoder: Encoder<number, number> = __attachEncodeMetadata(
  fromEncode((value) => ok(value)),
  { mode: 'sync', root: { kind: 'primitive', primitive: 'number' } },
);
export const booleanEncoder: Encoder<boolean, boolean> = __attachEncodeMetadata(
  fromEncode((value) => ok(value)),
  { mode: 'sync', root: { kind: 'primitive', primitive: 'boolean' } },
);
export const bigintEncoder: Encoder<bigint, bigint> = __attachEncodeMetadata(
  fromEncode((value) => ok(value)),
  { mode: 'sync', root: { kind: 'primitive', primitive: 'bigint' } },
);
export const undefinedEncoder: Encoder<undefined, undefined> = __attachEncodeMetadata(
  fromEncode((value) =>
    value === undefined
      ? ok(undefined)
      : err(new EncodeFailure('Expected undefined.', { cause: value }))
  ),
  { mode: 'sync', root: { kind: 'undefined' } },
);
export const url: Encoder<UrlLike, string> = __attachEncodeMetadata(
  fromEncode((value) => ok(value.toString())),
  {
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
  },
);
export const isoDate: Encoder<Date, string> = __attachEncodeMetadata(
  fromEncode((value) =>
    Number.isNaN(value.getTime())
      ? err(new EncodeFailure('Expected valid Date.', { cause: value }))
      : ok(value.toISOString())
  ),
  {
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
  },
);

export function refine<T, TEncoded, E, M extends EncodeMode>(
  encoder: Encoder<T, TEncoded, E, M>,
  predicate: (value: T, ctx: EncodeRefinementContext) => value is T,
  message: string,
): Encoder<T, TEncoded, E | EncodeFailure, M>;
export function refine<
  T,
  TEncoded,
  E,
  M extends EncodeMode,
  TResult extends EncodeRefinementResult | Promise<EncodeRefinementResult>,
>(
  encoder: Encoder<T, TEncoded, E, M>,
  predicate: (value: T, ctx: EncodeRefinementContext) => TResult,
  message: string,
): Encoder<T, TEncoded, E | EncodeFailure, MergeEncodeModes<M | AsyncModeOf<TResult>>>;
export function refine<
  T,
  TEncoded,
  E,
  M extends EncodeMode,
  TResult extends EncodeRefinementResult | Promise<EncodeRefinementResult>,
>(
  encoder: Encoder<T, TEncoded, E, M>,
  predicate: (value: T, ctx: EncodeRefinementContext) => TResult,
  message: string,
): Encoder<T, TEncoded, E | EncodeFailure, MergeEncodeModes<M | AsyncModeOf<TResult>>> {
  type TMode = MergeEncodeModes<M | AsyncModeOf<TResult>>;
  return __attachEncodeMetadata(
    fromEncode<T, TEncoded, E | EncodeFailure, TMode>(
      (value: T, state?: EncodeState) =>
        refineEncode(
          encodeWithState(encoder, value, state),
          predicate,
          message,
          value,
        ) as EncodeOutput<
          TEncoded,
          E | EncodeFailure,
          TMode
        >,
      (value: T, state?: EncodeState) =>
        refineValidateEncode(
          validateEncodeWithState(encoder, value, state),
          predicate,
          message,
          value,
        ) as EncodeOutput<TEncoded, readonly EncodeIssue[], TMode>,
    ),
    {
      mode: encodeModeOf(encoder) === 'async' || __isAsyncCallable(predicate) ? 'async' : 'sync',
      root: __cloneNodeWithEffects(encodeNodeOf(encoder), [
        encodeOpaqueEffect('refine', predicate),
      ]),
    },
  );
}

export function optional<TEncoder extends Encoder<unknown, unknown, unknown, EncodeMode>>(
  encoder: TEncoder,
): OptionalEncoder<
  Exclude<EncoderInput<TEncoder>, undefined>,
  Exclude<EncoderOutputValue<TEncoder>, undefined>,
  EncoderError<TEncoder>,
  EncoderModeOf<TEncoder>
>;
export function optional<T, TEncoded, E, M extends EncodeMode>(
  encoder: Encoder<T, TEncoded, E, M>,
): OptionalEncoder<Exclude<T, undefined>, Exclude<TEncoded, undefined>, E, M>;
export function optional<T, TEncoded, E, M extends EncodeMode>(
  encoder: Encoder<T, TEncoded, E, M>,
): OptionalEncoder<Exclude<T, undefined>, Exclude<TEncoded, undefined>, E, M> {
  const optionalEncoder = {
    __soundscriptOptional: true,
    inner: encoder,
    [encodeWithStateSymbol](value: T | undefined, state: EncodeState) {
      return (value === undefined
        ? ok(undefined)
        : encodeWithState(encoder, value, state)) as EncodeOutput<
          TEncoded | undefined,
          E,
          M
        >;
    },
    [validateEncodeWithStateSymbol](value: T | undefined, state: EncodeState) {
      return (value === undefined
        ? ok(undefined)
        : validateEncodeWithState(encoder, value, state)) as EncodeOutput<
          TEncoded | undefined,
          readonly EncodeIssue[],
          M
        >;
    },
    encode(value) {
      return ((this as StatefulEncoder<T | undefined, TEncoded | undefined, E, M>)[
        encodeWithStateSymbol
      ]!(
        value,
        createEncodeState(),
      )) as EncodeOutput<
        TEncoded | undefined,
        E,
        M
      >;
    },
    validateEncode(value) {
      return ((this as StatefulEncoder<T | undefined, TEncoded | undefined, E, M>)[
        validateEncodeWithStateSymbol
      ]!(
        value,
        createEncodeState(),
      )) as EncodeOutput<
        TEncoded | undefined,
        readonly EncodeIssue[],
        M
      >;
    },
  } as
    & StatefulEncoder<T | undefined, TEncoded | undefined, E, M>
    & OptionalEncoder<Exclude<T, undefined>, Exclude<TEncoded, undefined>, E, M>;
  return __attachEncodeMetadata(optionalEncoder, {
    mode: encodeModeOf(encoder),
    root: {
      kind: 'union',
      members: [
        encodeNodeOf(encoder),
        { kind: 'undefined' },
      ],
    },
  });
}

export function undefinedable<T, TEncoded, E, M extends EncodeMode>(
  encoder: Encoder<T, TEncoded, E, M>,
): Encoder<T | undefined, TEncoded | undefined, E, M> {
  const undefinedableEncoder = {
    __soundscriptUndefinedable: true,
    inner: encoder,
    [encodeWithStateSymbol](value: T | undefined, state: EncodeState) {
      return (value === undefined
        ? ok(undefined)
        : encodeWithState(encoder, value, state)) as EncodeOutput<
          TEncoded | undefined,
          E,
          M
        >;
    },
    [validateEncodeWithStateSymbol](value: T | undefined, state: EncodeState) {
      return (value === undefined
        ? ok(undefined)
        : validateEncodeWithState(encoder, value, state)) as EncodeOutput<
          TEncoded | undefined,
          readonly EncodeIssue[],
          M
        >;
    },
    encode(value) {
      return ((this as StatefulEncoder<T | undefined, TEncoded | undefined, E, M>)[
        encodeWithStateSymbol
      ]!(
        value,
        createEncodeState(),
      )) as EncodeOutput<
        TEncoded | undefined,
        E,
        M
      >;
    },
    validateEncode(value) {
      return ((this as StatefulEncoder<T | undefined, TEncoded | undefined, E, M>)[
        validateEncodeWithStateSymbol
      ]!(
        value,
        createEncodeState(),
      )) as EncodeOutput<
        TEncoded | undefined,
        readonly EncodeIssue[],
        M
      >;
    },
  } as
    & StatefulEncoder<T | undefined, TEncoded | undefined, E, M>
    & UndefinedableEncoder<T, TEncoded, E, M>;
  return __attachEncodeMetadata(undefinedableEncoder, {
    mode: encodeModeOf(encoder),
    root: {
      kind: 'union',
      members: [
        encodeNodeOf(encoder),
        { kind: 'undefined' },
      ],
    },
  });
}

export function lazy<TEncoder extends Encoder<unknown, unknown, unknown, EncodeMode>>(
  getEncoder: () => TEncoder,
): Encoder<
  EncoderInput<TEncoder>,
  EncoderOutputValue<TEncoder>,
  EncoderError<TEncoder>,
  EncoderModeOf<TEncoder>
>;
export function lazy<T, TEncoded, E, M extends EncodeMode>(
  getEncoder: () => Encoder<T, TEncoded, E, M>,
): Encoder<T, TEncoded, E, M> {
  return __attachEncodeMetadata(
    fromEncode(
      (value: T, state?: EncodeState) => encodeWithState(getEncoder(), value, state),
      (value: T, state?: EncodeState) => validateEncodeWithState(getEncoder(), value, state),
    ),
    {
      mode: () => encodeModeOf(getEncoder()),
      root: {
        kind: 'ref',
        target: () => encodeNodeOf(getEncoder()),
      },
    },
  );
}

export function nullable<T, TEncoded, E, M extends EncodeMode>(
  encoder: Encoder<T, TEncoded, E, M>,
): Encoder<T | null, TEncoded | null, E, M> {
  return __attachEncodeMetadata(
    fromEncode(
      (value: T | null, state?: EncodeState) =>
        (value === null ? ok(null) : encodeWithState(encoder, value, state)) as MaybeEncodeOutput<
          TEncoded | null,
          E
        >,
      (value: T | null, state?: EncodeState) =>
        (value === null
          ? ok(null)
          : validateEncodeWithState(encoder, value, state)) as MaybeEncodeOutput<
            TEncoded | null,
            readonly EncodeIssue[]
          >,
    ),
    {
      mode: encodeModeOf(encoder),
      root: {
        kind: 'union',
        members: [
          encodeNodeOf(encoder),
          { kind: 'null' },
        ],
      },
    },
  );
}

export function literal<const T extends string | number | boolean | null>(value: T): Encoder<T, T> {
  return __attachEncodeMetadata(
    fromEncode((input) =>
      Object.is(input, value)
        ? ok(value)
        : err(new EncodeFailure(`Expected literal ${JSON.stringify(value)}.`, { cause: input }))
    ),
    {
      mode: 'sync',
      root: value === null ? { kind: 'null' } : { kind: 'literal', value },
    },
  );
}

export function array<T, TEncoded, E, M extends EncodeMode>(
  item: Encoder<T, TEncoded, E, M>,
): Encoder<readonly T[], readonly TEncoded[], E | EncodeFailure, M> {
  return __attachEncodeMetadata(
    fromEncode(
      (value: readonly T[], state?: EncodeState) => {
        return withEncodeCycleTracking(
          state,
          value,
          () => err(new EncodeFailure('Cyclic value encountered during encode.', { cause: value })),
          () => {
            const encodedValues: TEncoded[] = [];
            for (let index = 0; index < value.length; index += 1) {
              const encoded = encodeWithState(item, value[index] as T, state) as MaybeEncodeOutput<
                TEncoded,
                E
              >;
              if (isPromiseLike(encoded)) {
                return encodeArrayAsync(value, item, encodedValues, index, encoded, state);
              }
              if (isErr(encoded)) {
                return err(prependPathIfPossible(encoded.error, index) as E | EncodeFailure);
              }
              encodedValues.push(encoded.value);
            }
            return ok(encodedValues);
          },
        );
      },
      (value: readonly T[], state?: EncodeState) => {
        return withEncodeCycleTracking(state, value, () =>
          err([
            issueFromEncodeFailure(
              new EncodeFailure('Cyclic value encountered during encode.', { cause: value }),
            ),
          ]), () => {
          const encodedValues: TEncoded[] = [];
          const issues: EncodeIssue[] = [];
          for (let index = 0; index < value.length; index += 1) {
            const encoded = validateEncodeWithState(
              item,
              value[index] as T,
              state,
            ) as MaybeEncodeOutput<
              TEncoded,
              readonly EncodeIssue[]
            >;
            if (isPromiseLike(encoded)) {
              return validateArrayAsync(value, item, encodedValues, issues, index, encoded, state);
            }
            if (isErr(encoded)) {
              issues.push(...prependIssuePaths(encoded.error, index));
              continue;
            }
            encodedValues.push(encoded.value);
          }
          return issues.length > 0 ? err(issues) : ok(encodedValues);
        });
      },
    ),
    {
      mode: encodeModeOf(item),
      root: {
        element: encodeNodeOf(item),
        kind: 'array',
      },
    },
  );
}

export function record<T, TEncoded, E, M extends EncodeMode>(
  valueEncoder: Encoder<T, TEncoded, E, M>,
): Encoder<Readonly<Record<string, T>>, Readonly<Record<string, TEncoded>>, E | EncodeFailure, M> {
  return __attachEncodeMetadata(
    fromEncode(
      (value: Readonly<Record<string, T>>, state?: EncodeState) => {
        if (!isPlainObject(value)) {
          return err(new EncodeFailure('Expected object record.', { cause: value }));
        }

        return withEncodeCycleTracking(
          state,
          value,
          () => err(new EncodeFailure('Cyclic value encountered during encode.', { cause: value })),
          () => {
            const encodedRecord: Record<string, TEncoded> = {};
            for (const [key, entry] of Object.entries(value)) {
              const encoded = encodeWithState(valueEncoder, entry as T, state) as MaybeEncodeOutput<
                TEncoded,
                E
              >;
              if (isPromiseLike(encoded)) {
                return encodeRecordAsync(value, valueEncoder, encodedRecord, key, encoded, state);
              }
              if (isErr(encoded)) {
                return err(prependPathIfPossible(encoded.error, key) as E | EncodeFailure);
              }
              encodedRecord[key] = encoded.value;
            }

            return ok(encodedRecord);
          },
        );
      },
      (value: Readonly<Record<string, T>>, state?: EncodeState) => {
        if (!isPlainObject(value)) {
          return err([
            issueFromEncodeFailure(new EncodeFailure('Expected object record.', { cause: value })),
          ]);
        }

        return withEncodeCycleTracking(state, value, () =>
          err([
            issueFromEncodeFailure(
              new EncodeFailure('Cyclic value encountered during encode.', { cause: value }),
            ),
          ]), () => {
          const encodedRecord: Record<string, TEncoded> = {};
          const issues: EncodeIssue[] = [];
          const entries = Object.entries(value);
          for (let index = 0; index < entries.length; index += 1) {
            const [key, entry] = entries[index]!;
            const encoded = validateEncodeWithState(
              valueEncoder,
              entry as T,
              state,
            ) as MaybeEncodeOutput<
              TEncoded,
              readonly EncodeIssue[]
            >;
            if (isPromiseLike(encoded)) {
              return validateRecordAsync(
                entries,
                valueEncoder,
                encodedRecord,
                issues,
                index,
                encoded,
                state,
              );
            }
            if (isErr(encoded)) {
              issues.push(...prependIssuePaths(encoded.error, key));
              continue;
            }
            encodedRecord[key] = encoded.value;
          }

          return issues.length > 0 ? err(issues) : ok(encodedRecord);
        });
      },
    ),
    {
      mode: encodeModeOf(valueEncoder),
      root: {
        key: 'string',
        kind: 'record',
        value: encodeNodeOf(valueEncoder),
      },
    },
  );
}

export function tuple<const TElements extends TupleShape>(
  ...elements: TElements
): Encoder<
  { readonly [K in keyof TElements]: EncoderInput<TElements[K]> },
  { readonly [K in keyof TElements]: EncoderOutputValue<TElements[K]> },
  EncoderError<TElements[number]>,
  TupleEncodeMode<TElements>
> {
  type TInput = { readonly [K in keyof TElements]: EncoderInput<TElements[K]> };
  type TOutput = { readonly [K in keyof TElements]: EncoderOutputValue<TElements[K]> };
  type TError = EncoderError<TElements[number]>;
  type TMode = TupleEncodeMode<TElements>;

  return __attachEncodeMetadata(
    fromEncode<TInput, TOutput, TError, TMode>(
      (value: TInput, state?: EncodeState) => {
        const values = value as readonly unknown[];
        return withEncodeCycleTracking(state, values, () =>
          err(
            new EncodeFailure('Cyclic value encountered during encode.', { cause: values }),
          ) as EncodeOutput<
            TOutput,
            TError,
            TMode
          >, () => {
          const encodedValues: unknown[] = [];
          for (let index = 0; index < elements.length; index += 1) {
            const elementEncoder = elements[index];
            if (!elementEncoder) {
              continue;
            }
            const encoded = encodeWithState(
              elementEncoder,
              values[index] as never,
              state,
            ) as MaybeEncodeOutput<
              EncoderOutputValue<TElements[number]>,
              EncoderError<TElements[number]>
            >;
            if (isPromiseLike(encoded)) {
              return encodeTupleAsync(
                values,
                elements,
                encodedValues,
                index,
                encoded,
                state,
              ) as EncodeOutput<
                TOutput,
                TError,
                TMode
              >;
            }
            if (isErr(encoded)) {
              return err(prependPathIfPossible(encoded.error, index) as TError) as EncodeOutput<
                TOutput,
                TError,
                TMode
              >;
            }
            encodedValues.push(encoded.value);
          }
          return ok(encodedValues as TOutput) as EncodeOutput<TOutput, TError, TMode>;
        });
      },
      (value: TInput, state?: EncodeState) => {
        const values = value as readonly unknown[];
        return withEncodeCycleTracking(state, values, () =>
          err([
            issueFromEncodeFailure(
              new EncodeFailure('Cyclic value encountered during encode.', { cause: values }),
            ),
          ]) as EncodeOutput<
            TOutput,
            readonly EncodeIssue[],
            TMode
          >, () => {
          const encodedValues: unknown[] = [];
          const issues: EncodeIssue[] = [];
          for (let index = 0; index < elements.length; index += 1) {
            const elementEncoder = elements[index];
            if (!elementEncoder) {
              continue;
            }
            const encoded = validateEncodeWithState(
              elementEncoder,
              values[index] as never,
              state,
            ) as MaybeEncodeOutput<
              EncoderOutputValue<TElements[number]>,
              readonly EncodeIssue[]
            >;
            if (isPromiseLike(encoded)) {
              return validateTupleAsync(
                values,
                elements,
                encodedValues,
                issues,
                index,
                encoded,
                state,
              ) as EncodeOutput<
                TOutput,
                readonly EncodeIssue[],
                TMode
              >;
            }
            if (isErr(encoded)) {
              issues.push(...prependIssuePaths(encoded.error, index));
              continue;
            }
            encodedValues.push(encoded.value);
          }
          return (issues.length > 0 ? err(issues) : ok(encodedValues as TOutput)) as EncodeOutput<
            TOutput,
            readonly EncodeIssue[],
            TMode
          >;
        });
      },
    ),
    {
      mode: () => elements.some((element) => encodeModeOf(element) === 'async') ? 'async' : 'sync',
      root: {
        elements: elements.map((element) => encodeNodeOf(element)),
        kind: 'tuple',
      },
    },
  );
}

export function option<T, TEncoded, E, M extends EncodeMode>(
  item: Encoder<T, TEncoded, E, M>,
): Encoder<
  Option<T>,
  { readonly tag: 'none' } | {
    readonly tag: 'some';
    readonly value: TEncoded;
  },
  E,
  M
> {
  type TOptionEncoded = { readonly tag: 'none' } | {
    readonly tag: 'some';
    readonly value: TEncoded;
  };
  return __attachEncodeMetadata(
    fromEncode<Option<T>, TOptionEncoded, E, M>((value: Option<T>, state?: EncodeState) => {
      if (isSome(value)) {
        const encoded = encodeWithState(item, value.value, state);
        return mapEncodeOutput(
          encoded,
          (resolved) =>
            isErr(resolved)
              ? resolved
              : ok({ tag: 'some', value: resolved.value } as TOptionEncoded),
        ) as MaybeEncodeOutput<
          TOptionEncoded,
          E
        >;
      }

      return ok({ tag: 'none' } as TOptionEncoded);
    }, (value: Option<T>, state?: EncodeState) => {
      if (isSome(value)) {
        const encoded = validateEncodeWithState(item, value.value, state);
        return mapEncodeOutput(
          encoded,
          (resolved) =>
            isErr(resolved)
              ? resolved
              : ok({ tag: 'some', value: resolved.value } as TOptionEncoded),
        ) as MaybeEncodeOutput<
          TOptionEncoded,
          readonly EncodeIssue[]
        >;
      }

      return ok({ tag: 'none' } as TOptionEncoded);
    }),
    {
      mode: encodeModeOf(item),
      root: {
        kind: 'union',
        members: [
          {
            fields: [
              {
                localName: 'tag',
                node: { kind: 'literal', value: 'none' },
                optional: false,
                wireName: 'tag',
              },
            ],
            kind: 'object',
            unknownKeys: 'strip',
          },
          {
            fields: [
              {
                localName: 'tag',
                node: { kind: 'literal', value: 'some' },
                optional: false,
                wireName: 'tag',
              },
              {
                localName: 'value',
                node: encodeNodeOf(item),
                optional: false,
                wireName: 'value',
              },
            ],
            kind: 'object',
            unknownKeys: 'strip',
          },
        ],
      },
    },
  );
}

export function result<
  T,
  EValue,
  TEncoded,
  EEncoded,
  EOk,
  EErr,
  MOk extends EncodeMode,
  MErr extends EncodeMode,
>(
  okEncoder: Encoder<T, TEncoded, EOk, MOk>,
  errEncoder: Encoder<EValue, EEncoded, EErr, MErr>,
): Encoder<
  Result<T, EValue>,
  { readonly tag: 'ok'; readonly value: TEncoded } | {
    readonly error: EEncoded;
    readonly tag: 'err';
  },
  EOk | EErr,
  MergeEncodeModes<MOk | MErr>
> {
  type TResultEncoded = { readonly tag: 'ok'; readonly value: TEncoded } | {
    readonly error: EEncoded;
    readonly tag: 'err';
  };
  return __attachEncodeMetadata(
    fromEncode<Result<T, EValue>, TResultEncoded, EOk | EErr, MergeEncodeModes<MOk | MErr>>((
      value: Result<T, EValue>,
      state?: EncodeState,
    ) => {
      if (isOk(value)) {
        const encoded = encodeWithState(okEncoder, value.value, state);
        return mapEncodeOutput(
          encoded,
          (resolved) =>
            isErr(resolved) ? resolved : ok({ tag: 'ok', value: resolved.value } as TResultEncoded),
        ) as MaybeEncodeOutput<
          TResultEncoded,
          EOk | EErr
        >;
      }

      const encoded = encodeWithState(errEncoder, value.error, state);
      return mapEncodeOutput(
        encoded,
        (resolved) =>
          isErr(resolved) ? resolved : ok({ tag: 'err', error: resolved.value } as TResultEncoded),
      ) as MaybeEncodeOutput<
        TResultEncoded,
        EOk | EErr
      >;
    }, (value: Result<T, EValue>, state?: EncodeState) => {
      if (isOk(value)) {
        const encoded = validateEncodeWithState(okEncoder, value.value, state);
        return mapEncodeOutput(
          encoded,
          (resolved) =>
            isErr(resolved) ? resolved : ok({ tag: 'ok', value: resolved.value } as TResultEncoded),
        ) as MaybeEncodeOutput<TResultEncoded, readonly EncodeIssue[]>;
      }

      const encoded = validateEncodeWithState(errEncoder, value.error, state);
      return mapEncodeOutput(
        encoded,
        (resolved) =>
          isErr(resolved) ? resolved : ok({ tag: 'err', error: resolved.value } as TResultEncoded),
      ) as MaybeEncodeOutput<TResultEncoded, readonly EncodeIssue[]>;
    }),
    {
      mode: () => mergeEncodeRuntimeModes(okEncoder, errEncoder),
      root: {
        kind: 'union',
        members: [
          {
            fields: [
              {
                localName: 'tag',
                node: { kind: 'literal', value: 'ok' },
                optional: false,
                wireName: 'tag',
              },
              {
                localName: 'value',
                node: encodeNodeOf(okEncoder),
                optional: false,
                wireName: 'value',
              },
            ],
            kind: 'object',
            unknownKeys: 'strip',
          },
          {
            fields: [
              {
                localName: 'tag',
                node: { kind: 'literal', value: 'err' },
                optional: false,
                wireName: 'tag',
              },
              {
                localName: 'error',
                node: encodeNodeOf(errEncoder),
                optional: false,
                wireName: 'error',
              },
            ],
            kind: 'object',
            unknownKeys: 'strip',
          },
        ],
      },
    },
  );
}

export function object<TShape extends ObjectShape>(
  shape: TShape,
  options?: EncodeObjectOptions,
): Encoder<
  ObjectInputOfShape<TShape>,
  ObjectOutputOfShape<TShape>,
  EncoderError<TShape[keyof TShape]> | EncodeFailure,
  ShapeEncodeMode<TShape>
> {
  type TInput = ObjectInputOfShape<TShape>;
  type TOutput = ObjectOutputOfShape<TShape>;
  type TError = EncoderError<TShape[keyof TShape]> | EncodeFailure;
  type TMode = ShapeEncodeMode<TShape>;
  const keys = Object.keys(shape) as readonly (keyof TShape & string)[];
  const keySet = new Set<string>(keys);
  const unknownKeys = options?.unknownKeys ?? 'strip';

  return __attachEncodeMetadata(
    fromEncode<TInput, TOutput, TError, TMode>(
      (value: TInput, state?: EncodeState) => {
        if (!isPlainObject(value)) {
          return err<TError>(
            new EncodeFailure('Expected object.', { cause: value }),
          ) as EncodeOutput<
            TOutput,
            TError,
            TMode
          >;
        }

        return withEncodeCycleTracking(state, value, () =>
          err<TError>(
            new EncodeFailure('Cyclic value encountered during encode.', { cause: value }),
          ) as EncodeOutput<
            TOutput,
            TError,
            TMode
          >, () => {
          const record = value as Record<string, unknown>;
          const extraKeys = collectUnknownObjectKeys(record, keySet);
          if (unknownKeys === 'strict' && extraKeys.length > 0) {
            return err<TError>(
              unknownEncodeKeyFailure(extraKeys[0]!, record[extraKeys[0]!]),
            ) as EncodeOutput<
              TOutput,
              TError,
              TMode
            >;
          }
          const encodedObject: Record<string, unknown> = unknownKeys === 'passthrough'
            ? { ...record }
            : {};

          for (let index = 0; index < keys.length; index += 1) {
            const key = keys[index]!;
            const encoder = shape[key];
            if (!encoder) {
              continue;
            }
            const hasKey = key in record;
            const rawValue = record[key];

            if (!hasKey) {
              if (allowsMissingObjectField(encoder)) {
                encodedObject[key] = undefined;
                continue;
              }
              return err<TError>(
                new EncodeFailure(`Missing field "${key}".`, {
                  cause: value,
                  path: [key],
                }),
              ) as EncodeOutput<TOutput, TError, TMode>;
            }

            if (rawValue === undefined) {
              if (allowsUndefinedObjectField(encoder)) {
                encodedObject[key] = undefined;
                continue;
              }
              return err<TError>(
                new EncodeFailure(`Missing field "${key}".`, {
                  cause: value,
                  path: [key],
                }),
              ) as EncodeOutput<TOutput, TError, TMode>;
            }

            const encoded = encodeWithState(encoder, rawValue as never, state) as MaybeEncodeOutput<
              EncoderOutputValue<TShape[keyof TShape]>,
              EncoderError<TShape[keyof TShape]>
            >;
            if (isPromiseLike(encoded)) {
              return encodeObjectAsync(
                record,
                shape,
                keys,
                encodedObject,
                index,
                encoded,
                state,
              ) as EncodeOutput<
                TOutput,
                TError,
                TMode
              >;
            }
            if (isErr(encoded)) {
              return err(prependPathIfPossible(encoded.error, key) as TError) as EncodeOutput<
                TOutput,
                TError,
                TMode
              >;
            }
            encodedObject[key] = encoded.value;
          }

          return ok(encodedObject as TOutput) as EncodeOutput<TOutput, TError, TMode>;
        });
      },
      (value: TInput, state?: EncodeState) => {
        if (!isPlainObject(value)) {
          return err([
            issueFromEncodeFailure(new EncodeFailure('Expected object.', { cause: value })),
          ]) as EncodeOutput<
            TOutput,
            readonly EncodeIssue[],
            TMode
          >;
        }

        return withEncodeCycleTracking(state, value, () =>
          err([
            issueFromEncodeFailure(
              new EncodeFailure('Cyclic value encountered during encode.', { cause: value }),
            ),
          ]) as EncodeOutput<
            TOutput,
            readonly EncodeIssue[],
            TMode
          >, () => {
          const record = value as Record<string, unknown>;
          const encodedObject: Record<string, unknown> = unknownKeys === 'passthrough'
            ? { ...record }
            : {};
          const issues: EncodeIssue[] = [];
          if (unknownKeys === 'strict') {
            for (const extraKey of collectUnknownObjectKeys(record, keySet)) {
              issues.push({
                code: 'encode_unknown_key',
                input: record[extraKey],
                message: `Unknown field "${extraKey}".`,
                path: [extraKey],
              });
            }
          }

          for (let index = 0; index < keys.length; index += 1) {
            const key = keys[index]!;
            const encoder = shape[key];
            if (!encoder) {
              continue;
            }
            const hasKey = key in record;
            const rawValue = record[key];

            if (!hasKey) {
              if (allowsMissingObjectField(encoder)) {
                encodedObject[key] = undefined;
                continue;
              }
              issues.push(issueFromEncodeFailure(
                new EncodeFailure(`Missing field "${key}".`, {
                  cause: value,
                  path: [key],
                }),
              ));
              continue;
            }

            if (rawValue === undefined) {
              if (allowsUndefinedObjectField(encoder)) {
                encodedObject[key] = undefined;
                continue;
              }
              issues.push(issueFromEncodeFailure(
                new EncodeFailure(`Missing field "${key}".`, {
                  cause: value,
                  path: [key],
                }),
              ));
              continue;
            }

            const encoded = validateEncodeWithState(
              encoder,
              rawValue as never,
              state,
            ) as MaybeEncodeOutput<
              EncoderOutputValue<TShape[keyof TShape]>,
              readonly EncodeIssue[]
            >;
            if (isPromiseLike(encoded)) {
              return validateObjectAsync(
                record,
                shape,
                keys,
                encodedObject,
                issues,
                index,
                encoded,
                state,
              ) as EncodeOutput<
                TOutput,
                readonly EncodeIssue[],
                TMode
              >;
            }
            if (isErr(encoded)) {
              issues.push(...prependIssuePaths(encoded.error, key));
              continue;
            }
            encodedObject[key] = encoded.value;
          }

          return (issues.length > 0 ? err(issues) : ok(encodedObject as TOutput)) as EncodeOutput<
            TOutput,
            readonly EncodeIssue[],
            TMode
          >;
        });
      },
    ),
    {
      mode: () => keys.some((key) => encodeModeOf(shape[key]) === 'async') ? 'async' : 'sync',
      root: {
        fields: keys.map((key) => {
          const encoder = shape[key]!;
          const fieldMetadata = __fieldMetadataOf(encoder);
          return {
            ...(fieldMetadata?.effects ? { effects: fieldMetadata.effects } : {}),
            localName: fieldMetadata?.localName ?? key,
            node: encodeNodeOf(encoder),
            optional: allowsMissingObjectField(encoder),
            wireName: fieldMetadata?.wireName ?? key,
          };
        }),
        kind: 'object',
        unknownKeys,
      },
    },
  );
}

export function strictObject<TShape extends ObjectShape>(
  shape: TShape,
): Encoder<
  ObjectInputOfShape<TShape>,
  ObjectOutputOfShape<TShape>,
  EncoderError<TShape[keyof TShape]> | EncodeFailure,
  ShapeEncodeMode<TShape>
> {
  return object(shape, { unknownKeys: 'strict' });
}

export function passthroughObject<TShape extends ObjectShape>(
  shape: TShape,
): Encoder<
  ObjectInputOfShape<TShape>,
  ObjectOutputOfShape<TShape>,
  EncoderError<TShape[keyof TShape]> | EncodeFailure,
  ShapeEncodeMode<TShape>
> {
  return object(shape, { unknownKeys: 'passthrough' });
}

function defaultValidateEncode<TEncoded, E>(
  encoded: MaybeEncodeOutput<TEncoded, E>,
  input: unknown,
): MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]> {
  if (isPromiseLike(encoded)) {
    return encoded.then((result) =>
      isErr(result) ? err(normalizeEncodeIssues(result.error, input)) : ok(result.value)
    );
  }
  return isErr(encoded) ? err(normalizeEncodeIssues(encoded.error, input)) : ok(encoded.value);
}

function normalizeEncodeIssues(error: unknown, input: unknown): readonly EncodeIssue[] {
  if (Array.isArray(error) && error.every(isEncodeIssue)) {
    return error;
  }
  return [issueFromUnknown(error, input)];
}

function issueFromUnknown(error: unknown, input: unknown): EncodeIssue {
  if (isEncodeIssue(error)) {
    return error;
  }
  if (error instanceof EncodeFailure) {
    return issueFromEncodeFailure(error);
  }
  if (error instanceof Failure) {
    return {
      code: 'encode_failure',
      ...(input === undefined ? {} : { input }),
      message: error.message,
      path: [],
    };
  }
  if (error instanceof Error) {
    return {
      code: 'encode_failure',
      ...(input === undefined ? {} : { input }),
      message: error.message,
      path: [],
    };
  }
  return {
    code: 'encode_failure',
    ...(input === undefined ? {} : { input }),
    message: 'Failed to encode value.',
    path: [],
  };
}

function issueFromEncodeFailure(error: EncodeFailure): EncodeIssue {
  return {
    code: 'encode_failure',
    ...(error.cause === undefined ? {} : { input: error.cause }),
    message: error.message,
    path: error.path,
  };
}

function prependPathIfPossible<E>(error: E, segment: EncodePathSegment): E | EncodeFailure {
  return error instanceof EncodeFailure ? error.at(segment) : error;
}

function prependIssuePaths(
  issues: readonly EncodeIssue[],
  segment: EncodePathSegment,
): readonly EncodeIssue[] {
  return issues.map((issue) => ({
    ...issue,
    path: [segment, ...issue.path],
  }));
}

function collectUnknownObjectKeys(
  record: Readonly<Record<string, unknown>>,
  keySet: ReadonlySet<string>,
): readonly string[] {
  return Object.keys(record).filter((key) => !keySet.has(key));
}

function unknownEncodeKeyFailure(
  key: string,
  value: unknown,
): EncodeFailure {
  return new EncodeFailure(`Unknown field "${key}".`, {
    cause: value,
    path: [key],
  });
}

function isEncodeIssue(value: unknown): value is EncodeIssue {
  return typeof value === 'object' && value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    Array.isArray((value as { path?: unknown }).path);
}

function isOptionalEncoder(
  value: Encoder<unknown, unknown, unknown, EncodeMode>,
): value is OptionalEncoder<unknown, unknown, unknown, EncodeMode> {
  return '__soundscriptOptional' in value && value.__soundscriptOptional === true;
}

function isUndefinedableEncoder(
  value: Encoder<unknown, unknown, unknown, EncodeMode>,
): value is UndefinedableEncoder<unknown, unknown, unknown, EncodeMode> {
  return '__soundscriptUndefinedable' in value && value.__soundscriptUndefinedable === true;
}

function allowsMissingObjectField(
  encoder: Encoder<unknown, unknown, unknown, EncodeMode>,
): boolean {
  return isOptionalEncoder(encoder);
}

function allowsUndefinedObjectField(
  encoder: Encoder<unknown, unknown, unknown, EncodeMode>,
): boolean {
  return isOptionalEncoder(encoder) || isUndefinedableEncoder(encoder);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return value instanceof Promise;
}

function mapEncodeOutput<A, B, E>(
  value: MaybeEncodeOutput<A, E>,
  project: (value: Result<A, E>) => MaybeEncodeOutput<B, E>,
): MaybeEncodeOutput<B, E> {
  return isPromiseLike(value) ? value.then((resolved) => project(resolved)) : project(value);
}

function mapMaybeAsync<A, B>(
  value: MaybePromise<A>,
  project: (value: A) => B,
): MaybePromise<B> {
  return isPromiseLike(value) ? value.then((resolved) => project(resolved)) : project(value);
}

function createEncodeState(): EncodeState {
  return { seen: new WeakSet<object>() };
}

function encodeWithState<T, TEncoded, E>(
  encoder: Encoder<T, TEncoded, E, EncodeMode>,
  value: T,
  state?: EncodeState,
): MaybeEncodeOutput<TEncoded, E> {
  const nextState = state ?? createEncodeState();
  const candidate = encoder as StatefulEncoder<T, TEncoded, E, EncodeMode>;
  return candidate[encodeWithStateSymbol]
    ? candidate[encodeWithStateSymbol]!(value, nextState)
    : candidate.encode(value);
}

function validateEncodeWithState<T, TEncoded>(
  encoder: Encoder<T, TEncoded, unknown, EncodeMode>,
  value: T,
  state?: EncodeState,
): MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]> {
  const nextState = state ?? createEncodeState();
  const candidate = encoder as StatefulEncoder<T, TEncoded, unknown, EncodeMode>;
  return candidate[validateEncodeWithStateSymbol]
    ? candidate[validateEncodeWithStateSymbol]!(value, nextState)
    : candidate.validateEncode(value);
}

function encodeWithStateImpl<T, TEncoded, E>(
  encode: (value: T, state: EncodeState) => MaybeEncodeOutput<TEncoded, E>,
  value: T,
  state: EncodeState,
): MaybeEncodeOutput<TEncoded, E> {
  return encode(value, state);
}

function validateEncodeWithStateImpl<T, TEncoded>(
  validateEncode: (
    value: T,
    state: EncodeState,
  ) => MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]>,
  value: T,
  state: EncodeState,
): MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]> {
  return validateEncode(value, state);
}

function withEncodeCycleTracking<T, E>(
  state: EncodeState | undefined,
  input: unknown,
  onCycle: () => MaybeEncodeOutput<T, E>,
  run: () => MaybeEncodeOutput<T, E>,
): MaybeEncodeOutput<T, E> {
  const nextState = state ?? createEncodeState();
  if (input === null || typeof input !== 'object') {
    return run();
  }

  const objectValue = input as object;
  if (nextState.seen.has(objectValue)) {
    return onCycle();
  }

  nextState.seen.add(objectValue);
  try {
    const result = run();
    if (isPromiseLike(result)) {
      return result.finally(() => {
        nextState.seen.delete(objectValue);
      });
    }
    nextState.seen.delete(objectValue);
    return result;
  } catch (error) {
    nextState.seen.delete(objectValue);
    throw error;
  }
}

function projectEncode<A, TEncoded, E>(
  encode: (value: A) => MaybeEncodeOutput<TEncoded, E>,
  projected: A | Promise<A>,
): MaybeEncodeOutput<TEncoded, E> {
  return isPromiseLike(projected)
    ? projected.then((resolved) => encode(resolved))
    : encode(projected);
}

function refineEncode<T, TEncoded, E>(
  value: MaybeEncodeOutput<TEncoded, E>,
  predicate: (
    value: T,
    ctx: EncodeRefinementContext,
  ) => EncodeRefinementResult | Promise<EncodeRefinementResult>,
  message: string,
  input: T,
): MaybeEncodeOutput<TEncoded, E | EncodeFailure> {
  const context = createEncodeRefinementContext();
  if (isPromiseLike(value)) {
    return value.then((encoded) => {
      if (isErr(encoded)) {
        return encoded as Result<TEncoded, E | EncodeFailure>;
      }
      return mapMaybeAsync(
        predicate(input, context),
        (result) =>
          refinementPassed(result)
            ? ok(encoded.value)
            : err(encodeFailureFromRefinementResult(result, message, input)),
      );
    });
  }
  if (isErr(value)) {
    return value as Result<TEncoded, E | EncodeFailure>;
  }
  return mapMaybeAsync(
    predicate(input, context),
    (result) =>
      refinementPassed(result)
        ? ok(value.value)
        : err(encodeFailureFromRefinementResult(result, message, input)),
  );
}

function refineValidateEncode<T, TEncoded>(
  value: MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]>,
  predicate: (
    value: T,
    ctx: EncodeRefinementContext,
  ) => EncodeRefinementResult | Promise<EncodeRefinementResult>,
  message: string,
  input: T,
): MaybeEncodeOutput<TEncoded, readonly EncodeIssue[]> {
  const context = createEncodeRefinementContext();
  return mapEncodeOutput(value, (encoded) => {
    if (isErr(encoded)) {
      return encoded;
    }
    return mapMaybeAsync(
      predicate(input, context),
      (result) =>
        refinementPassed(result)
          ? ok(encoded.value)
          : err(encodeIssuesFromRefinementResult(result, message, input)),
    );
  });
}

function createEncodeRefinementContext(): EncodeRefinementContext {
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

function refinementPassed(result: EncodeRefinementResult): boolean {
  return result === true || (Array.isArray(result) && result.length === 0);
}

function encodeFailureFromRefinementResult(
  result: EncodeRefinementResult,
  message: string,
  input: unknown,
): EncodeFailure {
  if (typeof result === 'string') {
    return new EncodeFailure(result, { cause: input });
  }
  if (isEncodeIssue(result)) {
    return new EncodeFailure(result.message, {
      cause: result.input ?? input,
      path: result.path,
    });
  }
  if (Array.isArray(result) && result.length > 0) {
    const firstIssue = result.find(isEncodeIssue);
    if (firstIssue) {
      return new EncodeFailure(firstIssue.message, {
        cause: firstIssue.input ?? input,
        path: firstIssue.path,
      });
    }
  }
  return new EncodeFailure(message, { cause: input });
}

function encodeIssuesFromRefinementResult(
  result: EncodeRefinementResult,
  message: string,
  input: unknown,
): readonly EncodeIssue[] {
  if (typeof result === 'string') {
    return [{
      code: 'encode_failure',
      ...(input === undefined ? {} : { input }),
      message: result,
      path: [],
    }];
  }
  if (isEncodeIssue(result)) {
    return [normalizeEncodeIssue(result, input)];
  }
  if (Array.isArray(result)) {
    const issues = result.filter(isEncodeIssue);
    return issues.length === 0 ? [] : issues.map((issue) => normalizeEncodeIssue(issue, input));
  }
  return [{
    code: 'encode_failure',
    ...(input === undefined ? {} : { input }),
    message,
    path: [],
  }];
}

function normalizeEncodeIssue(issue: EncodeIssue, input: unknown): EncodeIssue {
  return issue.input === undefined && input !== undefined ? { ...issue, input } : issue;
}

async function encodeArrayAsync<T, TEncoded, E>(
  values: readonly T[],
  item: Encoder<T, TEncoded, E, EncodeMode>,
  encodedValues: TEncoded[],
  startIndex: number,
  firstPending: Promise<Result<TEncoded, E>>,
  state?: EncodeState,
): Promise<Result<readonly TEncoded[], E | EncodeFailure>> {
  const firstEncoded = await firstPending;
  if (isErr(firstEncoded)) {
    return err(prependPathIfPossible(firstEncoded.error, startIndex) as E | EncodeFailure);
  }
  encodedValues.push(firstEncoded.value);

  for (let index = startIndex + 1; index < values.length; index += 1) {
    const encoded = await encodeWithState(item, values[index] as T, state);
    if (isErr(encoded)) {
      return err(prependPathIfPossible(encoded.error, index) as E | EncodeFailure);
    }
    encodedValues.push(encoded.value);
  }
  return ok(encodedValues);
}

async function validateArrayAsync<T, TEncoded>(
  values: readonly T[],
  item: Encoder<T, TEncoded, unknown, EncodeMode>,
  encodedValues: TEncoded[],
  issues: EncodeIssue[],
  startIndex: number,
  firstPending: Promise<Result<TEncoded, readonly EncodeIssue[]>>,
  state?: EncodeState,
): Promise<Result<readonly TEncoded[], readonly EncodeIssue[]>> {
  const firstEncoded = await firstPending;
  if (isErr(firstEncoded)) {
    issues.push(...prependIssuePaths(firstEncoded.error, startIndex));
  } else {
    encodedValues.push(firstEncoded.value);
  }

  for (let index = startIndex + 1; index < values.length; index += 1) {
    const encoded = await validateEncodeWithState(item, values[index] as T, state);
    if (isErr(encoded)) {
      issues.push(...prependIssuePaths(encoded.error, index));
      continue;
    }
    encodedValues.push(encoded.value);
  }
  return issues.length > 0 ? err(issues) : ok(encodedValues);
}

async function encodeTupleAsync<const TElements extends TupleShape>(
  values: readonly unknown[],
  elements: TElements,
  encodedValues: unknown[],
  startIndex: number,
  firstPending: Promise<
    Result<EncoderOutputValue<TElements[number]>, EncoderError<TElements[number]>>
  >,
  state?: EncodeState,
): Promise<
  Result<
    { readonly [K in keyof TElements]: EncoderOutputValue<TElements[K]> },
    EncoderError<TElements[number]>
  >
> {
  const firstEncoded = await firstPending;
  if (isErr(firstEncoded)) {
    return err(
      prependPathIfPossible(firstEncoded.error, startIndex) as EncoderError<TElements[number]>,
    );
  }
  encodedValues.push(firstEncoded.value);

  for (let index = startIndex + 1; index < elements.length; index += 1) {
    const elementEncoder = elements[index];
    if (!elementEncoder) {
      continue;
    }
    const encoded = await encodeWithState(elementEncoder, values[index] as never, state);
    if (isErr(encoded)) {
      return err(prependPathIfPossible(encoded.error, index) as EncoderError<TElements[number]>);
    }
    encodedValues.push(encoded.value);
  }
  return ok(encodedValues as { readonly [K in keyof TElements]: EncoderOutputValue<TElements[K]> });
}

async function validateTupleAsync<const TElements extends TupleShape>(
  values: readonly unknown[],
  elements: TElements,
  encodedValues: unknown[],
  issues: EncodeIssue[],
  startIndex: number,
  firstPending: Promise<Result<EncoderOutputValue<TElements[number]>, readonly EncodeIssue[]>>,
  state?: EncodeState,
): Promise<
  Result<
    { readonly [K in keyof TElements]: EncoderOutputValue<TElements[K]> },
    readonly EncodeIssue[]
  >
> {
  const firstEncoded = await firstPending;
  if (isErr(firstEncoded)) {
    issues.push(...prependIssuePaths(firstEncoded.error, startIndex));
  } else {
    encodedValues.push(firstEncoded.value);
  }

  for (let index = startIndex + 1; index < elements.length; index += 1) {
    const elementEncoder = elements[index];
    if (!elementEncoder) {
      continue;
    }
    const encoded = await validateEncodeWithState(elementEncoder, values[index] as never, state);
    if (isErr(encoded)) {
      issues.push(...prependIssuePaths(encoded.error, index));
      continue;
    }
    encodedValues.push(encoded.value);
  }
  return issues.length > 0
    ? err(issues)
    : ok(encodedValues as { readonly [K in keyof TElements]: EncoderOutputValue<TElements[K]> });
}

async function encodeRecordAsync<T, TEncoded, E>(
  value: Record<string, unknown>,
  valueEncoder: Encoder<T, TEncoded, E, EncodeMode>,
  encodedRecord: Record<string, TEncoded>,
  startKey: string,
  firstPending: Promise<Result<TEncoded, E>>,
  state?: EncodeState,
): Promise<Result<Readonly<Record<string, TEncoded>>, E | EncodeFailure>> {
  const firstEncoded = await firstPending;
  if (isErr(firstEncoded)) {
    return err(prependPathIfPossible(firstEncoded.error, startKey) as E | EncodeFailure);
  }
  encodedRecord[startKey] = firstEncoded.value;

  let started = false;
  for (const [key, entry] of Object.entries(value)) {
    if (!started) {
      started = key === startKey;
      continue;
    }
    const encoded = await encodeWithState(valueEncoder, entry as T, state);
    if (isErr(encoded)) {
      return err(prependPathIfPossible(encoded.error, key) as E | EncodeFailure);
    }
    encodedRecord[key] = encoded.value;
  }
  return ok(encodedRecord);
}

async function validateRecordAsync<T, TEncoded>(
  entries: readonly (readonly [string, unknown])[],
  valueEncoder: Encoder<T, TEncoded, unknown, EncodeMode>,
  encodedRecord: Record<string, TEncoded>,
  issues: EncodeIssue[],
  startIndex: number,
  firstPending: Promise<Result<TEncoded, readonly EncodeIssue[]>>,
  state?: EncodeState,
): Promise<Result<Readonly<Record<string, TEncoded>>, readonly EncodeIssue[]>> {
  const [firstKey] = entries[startIndex]!;
  const firstEncoded = await firstPending;
  if (isErr(firstEncoded)) {
    issues.push(...prependIssuePaths(firstEncoded.error, firstKey));
  } else {
    encodedRecord[firstKey] = firstEncoded.value;
  }

  for (let index = startIndex + 1; index < entries.length; index += 1) {
    const [key, entry] = entries[index]!;
    const encoded = await validateEncodeWithState(valueEncoder, entry as T, state);
    if (isErr(encoded)) {
      issues.push(...prependIssuePaths(encoded.error, key));
      continue;
    }
    encodedRecord[key] = encoded.value;
  }
  return issues.length > 0 ? err(issues) : ok(encodedRecord);
}

async function encodeObjectAsync<TShape extends ObjectShape>(
  record: Record<string, unknown>,
  shape: TShape,
  keys: readonly (keyof TShape & string)[],
  encodedObject: Record<string, unknown>,
  startIndex: number,
  firstPending: Promise<Result<unknown, unknown>>,
  state?: EncodeState,
): Promise<
  Result<
    { readonly [K in keyof TShape]: EncoderOutputValue<TShape[K]> },
    EncoderError<TShape[keyof TShape]> | EncodeFailure
  >
> {
  const firstKey = keys[startIndex]!;
  const firstEncoded = await firstPending;
  if (isErr(firstEncoded)) {
    return err(
      prependPathIfPossible(firstEncoded.error, firstKey) as
        | EncoderError<TShape[keyof TShape]>
        | EncodeFailure,
    );
  }
  encodedObject[firstKey] = firstEncoded.value;

  for (let index = startIndex + 1; index < keys.length; index += 1) {
    const key = keys[index]!;
    const encoder = shape[key];
    if (!encoder) {
      continue;
    }
    const hasKey = key in record;
    const rawValue = record[key];
    if (!hasKey) {
      if (allowsMissingObjectField(encoder)) {
        encodedObject[key] = undefined;
        continue;
      }
      return err(
        new EncodeFailure(`Missing field "${key}".`, {
          cause: record,
          path: [key],
        }),
      );
    }

    if (rawValue === undefined) {
      if (allowsUndefinedObjectField(encoder)) {
        encodedObject[key] = undefined;
        continue;
      }
      return err(
        new EncodeFailure(`Missing field "${key}".`, {
          cause: record,
          path: [key],
        }),
      );
    }
    const encoded = await encodeWithState(encoder, rawValue as never, state);
    if (isErr(encoded)) {
      return err(
        prependPathIfPossible(encoded.error, key) as
          | EncoderError<TShape[keyof TShape]>
          | EncodeFailure,
      );
    }
    encodedObject[key] = encoded.value;
  }
  return ok(encodedObject as { readonly [K in keyof TShape]: EncoderOutputValue<TShape[K]> });
}

async function validateObjectAsync<TShape extends ObjectShape>(
  record: Record<string, unknown>,
  shape: TShape,
  keys: readonly (keyof TShape & string)[],
  encodedObject: Record<string, unknown>,
  issues: EncodeIssue[],
  startIndex: number,
  firstPending: Promise<Result<unknown, readonly EncodeIssue[]>>,
  state?: EncodeState,
): Promise<
  Result<
    { readonly [K in keyof TShape]: EncoderOutputValue<TShape[K]> },
    readonly EncodeIssue[]
  >
> {
  const firstKey = keys[startIndex]!;
  const firstEncoded = await firstPending;
  if (isErr(firstEncoded)) {
    issues.push(...prependIssuePaths(firstEncoded.error, firstKey));
  } else {
    encodedObject[firstKey] = firstEncoded.value;
  }

  for (let index = startIndex + 1; index < keys.length; index += 1) {
    const key = keys[index]!;
    const encoder = shape[key];
    if (!encoder) {
      continue;
    }
    const hasKey = key in record;
    const rawValue = record[key];
    if (!hasKey) {
      if (allowsMissingObjectField(encoder)) {
        encodedObject[key] = undefined;
        continue;
      }
      issues.push(issueFromEncodeFailure(
        new EncodeFailure(`Missing field "${key}".`, {
          cause: record,
          path: [key],
        }),
      ));
      continue;
    }

    if (rawValue === undefined) {
      if (allowsUndefinedObjectField(encoder)) {
        encodedObject[key] = undefined;
        continue;
      }
      issues.push(issueFromEncodeFailure(
        new EncodeFailure(`Missing field "${key}".`, {
          cause: record,
          path: [key],
        }),
      ));
      continue;
    }
    const encoded = await validateEncodeWithState(encoder, rawValue as never, state);
    if (isErr(encoded)) {
      issues.push(...prependIssuePaths(encoded.error, key));
      continue;
    }
    encodedObject[key] = encoded.value;
  }
  return issues.length > 0
    ? err(issues)
    : ok(encodedObject as { readonly [K in keyof TShape]: EncoderOutputValue<TShape[K]> });
}
