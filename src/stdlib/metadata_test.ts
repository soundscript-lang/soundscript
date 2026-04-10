import { assertEquals, assertNotEquals } from '@std/assert';

import { codec as createCodec, isoDate } from './codec.ts';
import {
  array,
  defaulted,
  type DecodeMode,
  type Decoder,
  jsonObject,
  jsonValue,
  lazy,
  mapError as mapDecodeError,
  minLength,
  object,
  optional,
  preprocess,
  refine,
  string,
} from './decode.ts';
import {
  attachMetadata,
  metadataOf,
  type DeriveMetadata,
} from './metadata.ts';

function expectMetadata(value: unknown): DeriveMetadata {
  const metadata = metadataOf(value as never);
  if (metadata === null) {
    throw new Error('expected metadata');
  }
  return metadata;
}

Deno.test('metadataOf returns primitive decode metadata for builtin helpers', () => {
  const metadata = expectMetadata(string);

  assertEquals(metadata.name ?? null, null);
  assertEquals(metadata.encode ?? null, null);
  assertNotEquals(metadata.decode, undefined);
  assertEquals(metadata.decode?.mode, 'sync');
  assertEquals(metadata.decode?.nodes[metadata.decode.root], {
    kind: 'primitive',
    primitive: 'string',
  });
});

Deno.test('metadataOf materializes object graphs with field metadata and constraints', () => {
  function trimString(value: unknown): string {
    return String(value).trim();
  }

  const UserDecoder = object({
    id: string,
    name: refine(
      minLength(
        preprocess(string, trimString),
        3,
      ),
      (value) => value.length > 0,
      'Expected non-empty name.',
    ),
    nickname: defaulted(optional(string), 'guest'),
  }, { unknownKeys: 'strict' });

  const metadata = expectMetadata(UserDecoder);
  const decode = metadata.decode;
  if (!decode) {
    throw new Error('expected decode metadata');
  }
  const root = decode.nodes[decode.root];
  if (!root || root.kind !== 'object') {
    throw new Error('expected object root');
  }

  assertEquals(root.unknownKeys, 'strict');
  assertEquals(
    root.fields.map((field: { localName: string; optional: boolean; wireName: string }) => ({
      localName: field.localName,
      optional: field.optional,
      wireName: field.wireName,
    })),
    [
      { localName: 'id', optional: false, wireName: 'id' },
      { localName: 'name', optional: false, wireName: 'name' },
      { localName: 'nickname', optional: true, wireName: 'nickname' },
    ],
  );

  const nameNode = decode.nodes[root.fields[1]!.node];
  const nicknameNode = decode.nodes[root.fields[2]!.node];
  assertEquals(nameNode?.effects, [
    {
      async: false,
      effect: 'preprocess',
      helperName: 'trimString',
      kind: 'opaque',
    },
    {
      constraint: { kind: 'minLength', value: 3 },
      kind: 'constraint',
    },
    {
      async: false,
      effect: 'refine',
      helperName: null,
      kind: 'opaque',
    },
  ]);
  assertEquals(nicknameNode?.effects, [
    {
      kind: 'default',
      value: 'guest',
    },
  ]);
});

Deno.test('metadataOf preserves recursion using ref nodes', () => {
  type Node = {
    readonly id: string;
    readonly next?: Node;
  };

  let NodeDecoder!: Decoder<{ readonly id: string; readonly next?: Node }, unknown, DecodeMode>;
  NodeDecoder = object({
    id: string,
    next: optional(lazy(() => NodeDecoder)),
  });

  const metadata = expectMetadata(NodeDecoder);
  const decode = metadata.decode;
  if (!decode) {
    throw new Error('expected decode metadata');
  }

  const nodes = Object.values(decode.nodes) as Array<{ kind: string }>;
  assertEquals(nodes.some((node) => node.kind === 'ref'), true);
});

Deno.test('metadataOf returns null for opaque handwritten helpers without explicit attachment', () => {
  const OpaqueDecoder = {
    decode(value: unknown) {
      return { tag: 'ok', value };
    },
    validateDecode(value: unknown) {
      return { tag: 'ok', value };
    },
  };

  assertEquals(metadataOf(OpaqueDecoder as never), null);
});

Deno.test('attachMetadata allows manual helpers to opt into the metadata surface', () => {
  const OpaqueDecoder = {
    decode(value: unknown) {
      return { tag: 'ok', value };
    },
    validateDecode(value: unknown) {
      return { tag: 'ok', value };
    },
  };

  const attached = attachMetadata(OpaqueDecoder as never, {
    decode: {
      mode: 'sync',
      nodes: {
        root: {
          kind: 'primitive',
          primitive: 'string',
        },
      },
      root: 'root',
    },
  });

  const metadata = expectMetadata(attached);
  assertEquals(metadata.decode?.mode, 'sync');
  assertEquals(metadata.decode?.nodes[metadata.decode.root], {
    kind: 'primitive',
    primitive: 'string',
  });
});

Deno.test('metadataOf exposes both directions for codecs', () => {
  const metadata = expectMetadata(isoDate);
  const encodeRoot = metadata.encode?.nodes[metadata.encode.root];

  assertEquals(metadata.decode?.mode, 'sync');
  assertEquals(metadata.encode?.mode, 'sync');
  assertEquals(metadata.decode?.nodes[metadata.decode.root], {
    effects: [{
      async: false,
      effect: 'transform',
      helperName: 'isoDate',
      kind: 'opaque',
    }],
    kind: 'primitive',
    primitive: 'string',
  });
  assertEquals(encodeRoot?.kind, 'primitive');
  if (!encodeRoot || encodeRoot.kind !== 'primitive') {
    throw new Error('expected primitive encode root');
  }
  assertEquals(encodeRoot.primitive, 'string');
});

Deno.test('metadataOf exposes recursive graphs for json helpers', () => {
  const valueMetadata = expectMetadata(jsonValue);
  const objectMetadata = expectMetadata(jsonObject);

  const valueRoot = valueMetadata.decode?.nodes[valueMetadata.decode.root];
  const objectRoot = objectMetadata.decode?.nodes[objectMetadata.decode.root];

  assertEquals(valueRoot?.kind, 'union');
  assertEquals(objectRoot?.kind, 'record');
  assertEquals(
    Object.values(valueMetadata.decode?.nodes ?? {}).some((node) => node.kind === 'ref'),
    true,
  );
});

Deno.test('metadataOf preserves shape and mode through decode mapError wrappers', () => {
  const AsyncWrapped = mapDecodeError(
    preprocess(string, async (value) => String(value)),
    (error: Error | { readonly message: string }) => new Error(error.message),
  );
  const metadata = expectMetadata(AsyncWrapped);
  const root = metadata.decode?.nodes[metadata.decode.root];

  assertEquals(metadata.decode?.mode, 'async');
  assertEquals(root, {
    effects: [{
      async: true,
      effect: 'preprocess',
      helperName: null,
      kind: 'opaque',
    }],
    kind: 'primitive',
    primitive: 'string',
  });
});
