import type { Codec } from './codec.ts';
import type { DecodeMode, Decoder } from './decode.ts';
import type { EncodeMode, Encoder } from './encode.ts';

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

type ModeValue = 'async' | 'sync';
type ModeProvider = ModeValue | (() => ModeValue);

export type __InternalFieldMetadata = {
  readonly effects?: readonly MetadataEffect[];
  readonly localName?: string;
  readonly wireName?: string;
};

type InternalMetadataField = {
  readonly effects?: readonly MetadataEffect[];
  readonly localName: string;
  readonly node: __InternalMetadataNode;
  readonly optional: boolean;
  readonly wireName: string;
};

type InternalNodeBase = {
  readonly effects?: readonly MetadataEffect[];
};

export type __InternalMetadataNode =
  | ({
    readonly kind: 'array';
    readonly element: __InternalMetadataNode;
  } & InternalNodeBase)
  | ({
    readonly fields: readonly InternalMetadataField[];
    readonly kind: 'object';
    readonly unknownKeys: 'passthrough' | 'strict' | 'strip';
  } & InternalNodeBase)
  | ({
    readonly kind: 'intersection';
    readonly members: readonly __InternalMetadataNode[];
  } & InternalNodeBase)
  | ({
    readonly kind: 'literal';
    readonly value: boolean | null | number | string;
  } & InternalNodeBase)
  | ({
    readonly kind: 'null';
  } & InternalNodeBase)
  | ({
    readonly kind: 'opaque';
  } & InternalNodeBase)
  | ({
    readonly kind: 'option';
    readonly value: __InternalMetadataNode;
  } & InternalNodeBase)
  | ({
    readonly kind: 'primitive';
    readonly primitive: 'bigint' | 'boolean' | 'number' | 'string';
  } & InternalNodeBase)
  | ({
    readonly key: 'string';
    readonly kind: 'record';
    readonly value: __InternalMetadataNode;
  } & InternalNodeBase)
  | ({
    readonly kind: 'ref';
    readonly target: () => __InternalMetadataNode;
  } & InternalNodeBase)
  | ({
    readonly err: __InternalMetadataNode;
    readonly kind: 'result';
    readonly ok: __InternalMetadataNode;
  } & InternalNodeBase)
  | ({
    readonly elements: readonly __InternalMetadataNode[];
    readonly kind: 'tuple';
  } & InternalNodeBase)
  | ({
    readonly kind: 'undefined';
  } & InternalNodeBase)
  | ({
    readonly kind: 'union';
    readonly members: readonly __InternalMetadataNode[];
  } & InternalNodeBase);

export type __InternalDirectionMetadata = {
  readonly mode: ModeProvider;
  readonly root: __InternalMetadataNode;
};

type InternalDeriveMetadata = {
  readonly decode?: __InternalDirectionMetadata;
  readonly encode?: __InternalDirectionMetadata;
  readonly name?: string | null;
};

const metadataAttachmentSymbol = Symbol('soundscript.metadata');
const decodeModeSymbol = Symbol('soundscript.metadata.decodeMode');
const encodeModeSymbol = Symbol('soundscript.metadata.encodeMode');
const fieldMetadataSymbol = Symbol('soundscript.metadata.field');

type MetadataCarrier = object & {
  [decodeModeSymbol]?: ModeValue;
  [encodeModeSymbol]?: ModeValue;
  [fieldMetadataSymbol]?: __InternalFieldMetadata;
  [metadataAttachmentSymbol]?: InternalDeriveMetadata;
};

export function metadataOf(
  value:
    | Decoder<unknown, unknown, DecodeMode>
    | Encoder<unknown, unknown, unknown, EncodeMode>
    | Codec<unknown, unknown, unknown, unknown, DecodeMode, EncodeMode>,
): DeriveMetadata | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const attachment = (value as MetadataCarrier)[metadataAttachmentSymbol];
  return attachment ? materializeAttachment(attachment) : null;
}

export function attachMetadata<
  T extends
    | Decoder<unknown, unknown, DecodeMode>
    | Encoder<unknown, unknown, unknown, EncodeMode>
    | Codec<unknown, unknown, unknown, unknown, DecodeMode, EncodeMode>,
>(value: T, metadata: DeriveMetadata): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const carrier = value as T & MetadataCarrier;
  carrier[metadataAttachmentSymbol] = hydrateAttachment(metadata);
  if (metadata.decode) {
    carrier[decodeModeSymbol] = metadata.decode.mode;
  }
  if (metadata.encode) {
    carrier[encodeModeSymbol] = metadata.encode.mode;
  }
  return carrier;
}

export function __attachDecodeMetadata<T extends object>(
  value: T,
  metadata: __InternalDirectionMetadata,
): T {
  const carrier = value as T & MetadataCarrier;
  const existing = carrier[metadataAttachmentSymbol];
  carrier[metadataAttachmentSymbol] = {
    ...(existing ?? {}),
    decode: metadata,
  };
  if (typeof metadata.mode !== 'function') {
    carrier[decodeModeSymbol] = metadata.mode;
  }
  return carrier;
}

export function __attachEncodeMetadata<T extends object>(
  value: T,
  metadata: __InternalDirectionMetadata,
): T {
  const carrier = value as T & MetadataCarrier;
  const existing = carrier[metadataAttachmentSymbol];
  carrier[metadataAttachmentSymbol] = {
    ...(existing ?? {}),
    encode: metadata,
  };
  if (typeof metadata.mode !== 'function') {
    carrier[encodeModeSymbol] = metadata.mode;
  }
  return carrier;
}

export function __attachName<T extends object>(value: T, name: string): T {
  const carrier = value as T & MetadataCarrier;
  const existing = carrier[metadataAttachmentSymbol];
  carrier[metadataAttachmentSymbol] = {
    ...(existing ?? {}),
    name,
  };
  return carrier;
}

export function __decodeDirectionOf(value: unknown): __InternalDirectionMetadata | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return (value as MetadataCarrier)[metadataAttachmentSymbol]?.decode ?? null;
}

export function __encodeDirectionOf(value: unknown): __InternalDirectionMetadata | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return (value as MetadataCarrier)[metadataAttachmentSymbol]?.encode ?? null;
}

export function __decodeDirectionOrOpaque(value: unknown): __InternalDirectionMetadata {
  return __decodeDirectionOf(value) ?? {
    mode: __decodeModeOf(value) ?? 'sync',
    root: { kind: 'opaque' },
  };
}

export function __encodeDirectionOrOpaque(value: unknown): __InternalDirectionMetadata {
  return __encodeDirectionOf(value) ?? {
    mode: __encodeModeOf(value) ?? 'sync',
    root: { kind: 'opaque' },
  };
}

export function __setDecodeMode<T extends object>(value: T, mode: DecodeMode): T {
  (value as T & MetadataCarrier)[decodeModeSymbol] = mode;
  return value;
}

export function __setEncodeMode<T extends object>(value: T, mode: EncodeMode): T {
  (value as T & MetadataCarrier)[encodeModeSymbol] = mode;
  return value;
}

export function __decodeModeOf(value: unknown): DecodeMode | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const carrier = value as MetadataCarrier;
  const explicitMode = carrier[decodeModeSymbol];
  if (explicitMode) {
    return explicitMode;
  }
  const attachedMode = carrier[metadataAttachmentSymbol]?.decode?.mode;
  return attachedMode ? resolveMode(attachedMode) : null;
}

export function __encodeModeOf(value: unknown): EncodeMode | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const carrier = value as MetadataCarrier;
  const explicitMode = carrier[encodeModeSymbol];
  if (explicitMode) {
    return explicitMode;
  }
  const attachedMode = carrier[metadataAttachmentSymbol]?.encode?.mode;
  return attachedMode ? resolveMode(attachedMode) : null;
}

export function __setFieldMetadata<T extends object>(
  value: T,
  metadata: __InternalFieldMetadata,
): T {
  (value as T & MetadataCarrier)[fieldMetadataSymbol] = metadata;
  return value;
}

export function __fieldMetadataOf(value: unknown): __InternalFieldMetadata | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return (value as MetadataCarrier)[fieldMetadataSymbol] ?? null;
}

export function __cloneNodeWithEffects(
  node: __InternalMetadataNode,
  effects: readonly MetadataEffect[],
): __InternalMetadataNode {
  return {
    ...node,
    ...(effects.length > 0
      ? { effects: [...(node.effects ?? []), ...effects] }
      : {}),
  };
}

export function __helperName(value: unknown): string | null {
  if (typeof value !== 'function') {
    return null;
  }
  return value.name.length > 0 ? value.name : null;
}

export function __isAsyncCallable(value: unknown): boolean {
  if (typeof value !== 'function') {
    return false;
  }
  return value.constructor?.name === 'AsyncFunction';
}

export function __inferCallableMode(...values: readonly unknown[]): ModeValue {
  return values.some((value) => __isAsyncCallable(value)) ? 'async' : 'sync';
}

export function __metadataValueOf(value: unknown): MetadataValue | null {
  if (
    value === null || value === undefined || typeof value === 'string' || typeof value === 'number' ||
    typeof value === 'boolean' || typeof value === 'bigint'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map((entry) => __metadataValueOf(entry));
    return items.every((entry) => entry !== null) ? items as readonly MetadataValue[] : null;
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const entries = Object.entries(value).map(([key, entry]) => [key, __metadataValueOf(entry)] as const);
  return entries.every(([, entry]) => entry !== null)
    ? Object.fromEntries(entries) as { readonly [key: string]: MetadataValue }
    : null;
}

function materializeAttachment(metadata: InternalDeriveMetadata): DeriveMetadata {
  return {
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(metadata.decode === undefined ? {} : { decode: materializeDirection(metadata.decode) }),
    ...(metadata.encode === undefined ? {} : { encode: materializeDirection(metadata.encode) }),
  };
}

function materializeDirection(direction: __InternalDirectionMetadata): DirectionMetadata {
  const ids = new Map<__InternalMetadataNode, string>();
  const nodes: Record<string, MetadataNode> = {};
  let counter = 0;

  const materializeNode = (node: __InternalMetadataNode): string => {
    const existingId = ids.get(node);
    if (existingId) {
      return existingId;
    }
    const id = `node${counter++}`;
    ids.set(node, id);
    nodes[id] = materializeNodeValue(node, materializeNode);
    return id;
  };

  const root = materializeNode(direction.root);
  return {
    mode: resolveMode(direction.mode),
    nodes,
    root,
  };
}

function materializeNodeValue(
  node: __InternalMetadataNode,
  materializeNode: (node: __InternalMetadataNode) => string,
): MetadataNode {
  switch (node.kind) {
    case 'primitive':
      return copyEffects(node, { kind: 'primitive', primitive: node.primitive });
    case 'literal':
      return copyEffects(node, { kind: 'literal', value: node.value });
    case 'null':
      return copyEffects(node, { kind: 'null' });
    case 'undefined':
      return copyEffects(node, { kind: 'undefined' });
    case 'opaque':
      return copyEffects(node, { kind: 'opaque' });
    case 'array':
      return copyEffects(node, { element: materializeNode(node.element), kind: 'array' });
    case 'tuple':
      return copyEffects(node, {
        elements: node.elements.map((element) => materializeNode(element)),
        kind: 'tuple',
      });
    case 'object':
      return copyEffects(node, {
        fields: node.fields.map((field) => ({
          ...(field.effects ? { effects: field.effects } : {}),
          localName: field.localName,
          node: materializeNode(field.node),
          optional: field.optional,
          wireName: field.wireName,
        })),
        kind: 'object',
        unknownKeys: node.unknownKeys,
      });
    case 'record':
      return copyEffects(node, { key: 'string', kind: 'record', value: materializeNode(node.value) });
    case 'union':
      return copyEffects(node, {
        kind: 'union',
        members: node.members.map((member) => materializeNode(member)),
      });
    case 'intersection':
      return copyEffects(node, {
        kind: 'intersection',
        members: node.members.map((member) => materializeNode(member)),
      });
    case 'option':
      return copyEffects(node, { kind: 'option', value: materializeNode(node.value) });
    case 'result':
      return copyEffects(node, {
        err: materializeNode(node.err),
        kind: 'result',
        ok: materializeNode(node.ok),
      });
    case 'ref':
      return copyEffects(node, { kind: 'ref', target: materializeNode(node.target()) });
  }
}

function copyEffects<T extends MetadataNode>(node: __InternalMetadataNode, value: T): T {
  return node.effects ? { ...value, effects: node.effects } : value;
}

function hydrateAttachment(metadata: DeriveMetadata): InternalDeriveMetadata {
  return {
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(metadata.decode === undefined ? {} : { decode: hydrateDirection(metadata.decode) }),
    ...(metadata.encode === undefined ? {} : { encode: hydrateDirection(metadata.encode) }),
  };
}

function hydrateDirection(direction: DirectionMetadata): __InternalDirectionMetadata {
  const hydratedNodes = new Map<string, __InternalMetadataNode>();

  const hydrateNode = (nodeId: string): __InternalMetadataNode => {
    const existing = hydratedNodes.get(nodeId);
    if (existing) {
      return existing;
    }
    const node = direction.nodes[nodeId];
    if (!node) {
      const opaqueNode: __InternalMetadataNode = { kind: 'opaque' };
      hydratedNodes.set(nodeId, opaqueNode);
      return opaqueNode;
    }

    const hydrated = hydrateNodeValue(node, hydrateNode);
    hydratedNodes.set(nodeId, hydrated);
    return hydrated;
  };

  return {
    mode: direction.mode,
    root: hydrateNode(direction.root),
  };
}

function hydrateNodeValue(
  node: MetadataNode,
  hydrateNode: (nodeId: string) => __InternalMetadataNode,
): __InternalMetadataNode {
  switch (node.kind) {
    case 'primitive':
      return node.effects ? { ...node } : { kind: 'primitive', primitive: node.primitive };
    case 'literal':
      return node.effects ? { ...node } : { kind: 'literal', value: node.value };
    case 'null':
      return node.effects ? { ...node } : { kind: 'null' };
    case 'undefined':
      return node.effects ? { ...node } : { kind: 'undefined' };
    case 'opaque':
      return node.effects ? { ...node } : { kind: 'opaque' };
    case 'array':
      return {
        ...(node.effects ? { effects: node.effects } : {}),
        element: hydrateNode(node.element),
        kind: 'array',
      };
    case 'tuple':
      return {
        ...(node.effects ? { effects: node.effects } : {}),
        elements: node.elements.map((element) => hydrateNode(element)),
        kind: 'tuple',
      };
    case 'object':
      return {
        ...(node.effects ? { effects: node.effects } : {}),
        fields: node.fields.map((field) => ({
          ...(field.effects ? { effects: field.effects } : {}),
          localName: field.localName,
          node: hydrateNode(field.node),
          optional: field.optional,
          wireName: field.wireName,
        })),
        kind: 'object',
        unknownKeys: node.unknownKeys,
      };
    case 'record':
      return {
        ...(node.effects ? { effects: node.effects } : {}),
        key: 'string',
        kind: 'record',
        value: hydrateNode(node.value),
      };
    case 'union':
      return {
        ...(node.effects ? { effects: node.effects } : {}),
        kind: 'union',
        members: node.members.map((member) => hydrateNode(member)),
      };
    case 'intersection':
      return {
        ...(node.effects ? { effects: node.effects } : {}),
        kind: 'intersection',
        members: node.members.map((member) => hydrateNode(member)),
      };
    case 'option':
      return {
        ...(node.effects ? { effects: node.effects } : {}),
        kind: 'option',
        value: hydrateNode(node.value),
      };
    case 'result':
      return {
        ...(node.effects ? { effects: node.effects } : {}),
        err: hydrateNode(node.err),
        kind: 'result',
        ok: hydrateNode(node.ok),
      };
    case 'ref':
      return {
        ...(node.effects ? { effects: node.effects } : {}),
        kind: 'ref',
        target: () => hydrateNode(node.target),
      };
  }
}

function resolveMode(mode: ModeProvider): ModeValue {
  return typeof mode === 'function' ? mode() : mode;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
