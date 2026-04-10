# Building Annotation-Driven Libraries

This guide shows the intended way to build user-space macro libraries on top of the current core
surface.

The key idea is:

- let Soundscript own structural reflection and builtin decode / encode behavior
- let your library own its own annotation namespace
- read both through the public macro surface instead of compiler internals

## When To Build On Core

Use the current public surface when your library needs any combination of:

- declaration shape such as object-like fields or discriminated unions
- builtin validation metadata such as `#[decode.minLength(...)]`
- custom metadata such as `#[openapi.example(...)]`, `#[grpc.field(...)]`, or `#[policy.owner]`

You do **not** need a built-in schema artifact from core for this. The intended inputs are:

- `ctx.reflect.declarationShape(...)`
- `ctx.reflect.typeShape(...)`
- `ctx.syntax.annotations(...)`

## Example

Imagine a package `@soundstage/rest` that wants to generate route metadata.

User code:

```ts
import { decode } from 'sts:derive';
import { rest } from '@soundstage/rest';

// #[decode]
// #[rest.resource('users')]
// #[openapi.example({ route: Routes.users.show, retryable: false })]
interface User {
  // #[decode.minLength(3)]
  // #[rest.field('display_name')]
  name: string;

  // #[decode.format('email')]
  email: string;
}
```

The package-authored macro can then:

- use `ctx.reflect.declarationShape(...)` to get the normalized field list
- use `ctx.syntax.annotations(declaration)` to read declaration metadata
- use `field.annotations` from the reflected shape or `ctx.syntax.annotations(field.node)` to read
  member metadata
- lower only the namespaces it understands

## Minimal Macro Sketch

```ts
import { macroSignature } from 'sts:macros';

const DECL = macroSignature.of(macroSignature.decl('target'));

// #[macro(decl)]
export function rest() {
  return {
    declarationKinds: ['interface', 'typeAlias', 'class'] as const,
    expansionMode: 'augment' as const,
    signature: DECL,
    expand(ctx: any) {
      const declaration = ctx.syntax.declaration();
      const shape = ctx.reflect.declarationShape(declaration);
      if (shape.kind !== 'objectLike') {
        ctx.error('rest only supports object-like declarations');
      }

      const name = shape.name ?? ctx.error('expected named declaration');
      const declarationAnnotations = ctx.syntax.annotations(declaration);
      const resource = declarationAnnotations.find((annotation: any) =>
        annotation.name === 'rest.resource'
      );

      const fields = shape.fields.map((field: any) => {
        const fieldAnnotations = field.annotations;
        const restField = fieldAnnotations.find((annotation: any) =>
          annotation.name === 'rest.field'
        );
        const minLength = fieldAnnotations.find((annotation: any) =>
          annotation.name === 'decode.minLength'
        );
        const format = fieldAnnotations.find((annotation: any) =>
          annotation.name === 'decode.format'
        );

        return {
          fieldName: field.name,
          wireName: restField?.arguments?.[0]?.value?.kind === 'string'
            ? restField.arguments[0].value.value
            : field.name,
          minLength: minLength?.arguments?.[0]?.value?.kind === 'number'
            ? minLength.arguments[0].value.value
            : null,
          format: format?.arguments?.[0]?.value?.kind === 'string'
            ? format.arguments[0].value.value
            : null,
        };
      });

      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${`${name}RestMetadata`} = ${
          JSON.stringify({
            fields,
            resource: resource?.arguments?.[0]?.value?.text ?? null,
          })
        };
        `,
      );
    },
  };
}
```

## What To Lower

Builtin `decode.*` annotations are useful when they are machine-readable:

- `decode.min`
- `decode.max`
- `decode.minLength`
- `decode.maxLength`
- `decode.startsWith`
- `decode.endsWith`
- `decode.multipleOf`
- `decode.pattern`
- `decode.integer`
- `decode.format`
- `decode.unknownKeys`

Those are good inputs for downstream tooling because they already have stable argument shapes.

Opaque helpers such as:

- `decode.via(...)`
- `decode.preprocess(...)`
- `decode.transform(...)`
- `decode.refine(...)`

are still visible through annotations, but most libraries should treat them as:

- metadata they do not lower automatically, or
- extension points requiring package-specific support

## What To Ignore

Ignore namespaces your library does not own unless you deliberately want to compose with them.

Examples:

- an OpenAPI library should probably ignore `grpc.*`
- a gRPC library should probably ignore `openapi.*`
- both might still read builtin `decode.*` constraints

Unknown annotation namespaces are preserved by core reflection and carry no builtin semantics on
their own.

## Current Stable Guidance

For library authors, the current stable reflection contract is:

- use `ctx.reflect.declarationShape(...)` for structure
- use `ctx.reflect.typeShape(...)` for nested type shapes
- use `ctx.syntax.annotations(...)` and reflected `field.annotations` for metadata

At the moment, that is the intended public foundation for downstream schema, transport, policy, and
documentation libraries. Core does not currently provide a separate contract or schema object on top
of this.
