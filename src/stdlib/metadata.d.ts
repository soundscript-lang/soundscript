import type { Codec } from 'sts:codec';
import type { DecodeMode, Decoder } from 'sts:decode';
import type { EncodeMode, Encoder } from 'sts:encode';

export type MetadataValue =
  | bigint
  | boolean
  | null
  | number
  | string
  | undefined
  | { readonly [key: string]: MetadataValue }
  | readonly MetadataValue[];

export type KnownConstraint =
  | { readonly kind: 'endsWith'; readonly value: string }
  | { readonly kind: 'format'; readonly value: 'email' | 'iso-datetime' | 'url' | 'uuid' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'max'; readonly value: bigint | number }
  | { readonly kind: 'maxLength'; readonly value: number }
  | { readonly kind: 'min'; readonly value: bigint | number }
  | { readonly kind: 'minLength'; readonly value: number }
  | { readonly kind: 'multipleOf'; readonly value: bigint | number }
  | { readonly flags: string; readonly kind: 'pattern'; readonly source: string }
  | { readonly kind: 'startsWith'; readonly value: string };

export type MetadataEffect =
  | {
    readonly constraint: KnownConstraint;
    readonly kind: 'constraint';
  }
  | {
    readonly async?: boolean;
    readonly helperName?: string | null;
    readonly helperText?: string | null;
    readonly kind: 'default';
    readonly opaque?: boolean;
    readonly value?: MetadataValue;
  }
  | {
    readonly async: boolean;
    readonly effect: 'andThen' | 'factory' | 'preprocess' | 'refine' | 'transform' | 'via';
    readonly helperName?: string | null;
    readonly helperText?: string | null;
    readonly kind: 'opaque';
  };

export type MetadataField = {
  readonly effects?: readonly MetadataEffect[];
  readonly localName: string;
  readonly node: string;
  readonly optional: boolean;
  readonly wireName: string;
};

type MetadataNodeBase = {
  readonly effects?: readonly MetadataEffect[];
};

export type MetadataNode =
  | ({
    readonly kind: 'array';
    readonly element: string;
  } & MetadataNodeBase)
  | ({
    readonly fields: readonly MetadataField[];
    readonly kind: 'object';
    readonly unknownKeys: 'passthrough' | 'strict' | 'strip';
  } & MetadataNodeBase)
  | ({
    readonly kind: 'intersection';
    readonly members: readonly string[];
  } & MetadataNodeBase)
  | ({
    readonly kind: 'literal';
    readonly value: boolean | null | number | string;
  } & MetadataNodeBase)
  | ({
    readonly kind: 'null';
  } & MetadataNodeBase)
  | ({
    readonly kind: 'opaque';
  } & MetadataNodeBase)
  | ({
    readonly kind: 'option';
    readonly value: string;
  } & MetadataNodeBase)
  | ({
    readonly kind: 'primitive';
    readonly primitive: 'bigint' | 'boolean' | 'number' | 'string';
  } & MetadataNodeBase)
  | ({
    readonly key: 'string';
    readonly kind: 'record';
    readonly value: string;
  } & MetadataNodeBase)
  | ({
    readonly kind: 'ref';
    readonly target: string;
  } & MetadataNodeBase)
  | ({
    readonly err: string;
    readonly kind: 'result';
    readonly ok: string;
  } & MetadataNodeBase)
  | ({
    readonly elements: readonly string[];
    readonly kind: 'tuple';
  } & MetadataNodeBase)
  | ({
    readonly kind: 'undefined';
  } & MetadataNodeBase)
  | ({
    readonly kind: 'union';
    readonly members: readonly string[];
  } & MetadataNodeBase);

export type DirectionMetadata = {
  readonly mode: 'async' | 'sync';
  readonly nodes: Readonly<Record<string, MetadataNode>>;
  readonly root: string;
};

export type DeriveMetadata = {
  readonly decode?: DirectionMetadata;
  readonly encode?: DirectionMetadata;
  readonly name?: string | null;
};

export function metadataOf(
  value:
    | Decoder<unknown, unknown, DecodeMode>
    | Encoder<unknown, unknown, unknown, EncodeMode>
    | Codec<unknown, unknown, unknown, unknown, DecodeMode, EncodeMode>,
): DeriveMetadata | null;
export function attachMetadata<
  T extends
    | Decoder<unknown, unknown, DecodeMode>
    | Encoder<unknown, unknown, unknown, EncodeMode>
    | Codec<unknown, unknown, unknown, unknown, DecodeMode, EncodeMode>,
>(value: T, metadata: DeriveMetadata): T;
