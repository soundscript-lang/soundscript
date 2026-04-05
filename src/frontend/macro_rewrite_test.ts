import { assertEquals } from '@std/assert';

import {
  getAlwaysAvailableBuiltinMacroSiteKinds,
  getBuiltinMacroSiteKindsBySpecifier,
} from './builtin_macro_support.ts';
import { rewriteMacroSource } from './macro_rewrite.ts';

const BUILTIN_MACRO_SITE_KINDS_BY_SPECIFIER = new Map([
  ...getBuiltinMacroSiteKindsBySpecifier().entries(),
  ['./macros/component', new Map([['component', 'annotation' as const]])],
]);
const ALWAYS_AVAILABLE_BUILTIN_MACRO_SITE_KINDS = getAlwaysAvailableBuiltinMacroSiteKinds();

Deno.test('rewriteMacroSource rewrites imported UpperCamelCase call macros in expression position', () => {
  const sourceText = [
    "import { Try } from 'sts:prelude';",
    'const value = Try(fetchValue());',
    '',
  ].join('\n');
  const result = rewriteMacroSource(
    'example.sts',
    sourceText,
    BUILTIN_MACRO_SITE_KINDS_BY_SPECIFIER,
    ALWAYS_AVAILABLE_BUILTIN_MACRO_SITE_KINDS,
  );

  assertEquals(result.diagnostics, []);
  assertEquals(
    result.replacements.map((replacement) => ({
      id: replacement.id,
      original: sourceText.slice(replacement.originalSpan.start, replacement.originalSpan.end),
      rewritten: result.rewrittenText.slice(
        replacement.rewrittenSpan.start,
        replacement.rewrittenSpan.end,
      ),
    })),
    [
      {
        id: 1,
        original: 'Try(fetchValue())',
        rewritten: '__sts_macro_expr(1)',
      },
    ],
  );
});

Deno.test('rewriteMacroSource rewrites imported UpperCamelCase call macros in statement position', () => {
  const sourceText = [
    "import { Defer } from 'sts:prelude';",
    'function run() {',
    '  Defer(() => {',
    '    cleanup();',
    '  });',
    '}',
    '',
  ].join('\n');
  const result = rewriteMacroSource(
    'example.sts',
    sourceText,
    BUILTIN_MACRO_SITE_KINDS_BY_SPECIFIER,
    ALWAYS_AVAILABLE_BUILTIN_MACRO_SITE_KINDS,
  );

  assertEquals(result.diagnostics, []);
  assertEquals(result.macrosById.get(1)?.rewriteKind, 'stmt');
  assertEquals(
    result.replacements.map((replacement) =>
      sourceText.slice(replacement.originalSpan.start, replacement.originalSpan.end)
    ),
    [
      'Defer(() => {\n    cleanup();\n  });',
    ],
  );
});

Deno.test('rewriteMacroSource rewrites imported lowercase tag macros', () => {
  const sourceText = [
    "import { sql } from 'sts:experimental/sql';",
    'const query = sql`select * from users where id = ${userId}`;',
    '',
  ].join('\n');
  const result = rewriteMacroSource(
    'example.sts',
    sourceText,
    BUILTIN_MACRO_SITE_KINDS_BY_SPECIFIER,
    ALWAYS_AVAILABLE_BUILTIN_MACRO_SITE_KINDS,
  );

  assertEquals(result.diagnostics, []);
  assertEquals(
    result.replacements.map((replacement) =>
      sourceText.slice(replacement.originalSpan.start, replacement.originalSpan.end)
    ),
    [
      'sql`select * from users where id = ${userId}`',
    ],
  );
});

Deno.test('rewriteMacroSource rewrites declaration annotations bound to imported underscore names', () => {
  const sourceText = [
    "import { component } from './macros/component';",
    '',
    '// #[component]',
    'class TodoView {',
    '  render() {',
    '    return <div />;',
    '  }',
    '}',
    '',
  ].join('\n');
  const result = rewriteMacroSource(
    'example.sts',
    sourceText,
    BUILTIN_MACRO_SITE_KINDS_BY_SPECIFIER,
    ALWAYS_AVAILABLE_BUILTIN_MACRO_SITE_KINDS,
  );

  assertEquals(result.diagnostics, []);
  assertEquals(result.macrosById.get(1)?.invocationKind, 'decl');
  assertEquals(
    result.replacements.map((replacement) =>
      sourceText.slice(replacement.originalSpan.start, replacement.originalSpan.end)
    ),
    [
      '// #[component]\nclass TodoView {\n  render() {\n    return <div />;\n  }\n}',
    ],
  );
});

Deno.test('rewriteMacroSource rewrites interface declaration annotations bound to imported underscore names', () => {
  const sourceText = [
    "import { hkt } from 'sts:hkt';",
    '',
    '// #[hkt]',
    'export interface OptionF<A> {',
    '  readonly type: Option<A>;',
    '}',
    '',
  ].join('\n');
  const result = rewriteMacroSource(
    'example.sts',
    sourceText,
    BUILTIN_MACRO_SITE_KINDS_BY_SPECIFIER,
    ALWAYS_AVAILABLE_BUILTIN_MACRO_SITE_KINDS,
  );

  assertEquals(result.diagnostics, []);
  assertEquals(result.macrosById.get(1)?.invocationKind, 'decl');
  assertEquals(result.macrosById.get(1)?.declarationKind, 'interface');
  assertEquals(
    result.replacements.map((replacement) =>
      sourceText.slice(replacement.originalSpan.start, replacement.originalSpan.end)
    ),
    [
      '// #[hkt]\nexport interface OptionF<A> {\n  readonly type: Option<A>;\n}',
    ],
  );
});

Deno.test('rewriteMacroSource rewrites type alias declaration annotations with arguments', () => {
  const sourceText = [
    "import { derive } from './macros/derive';",
    '',
    '// #[derive(strategy: tagged)]',
    'export type UserId = string & { readonly __brand: "UserId" };',
    '',
  ].join('\n');
  const result = rewriteMacroSource('example.sts', sourceText, new Map([
    ['./macros/derive', new Map([['derive', 'annotation' as const]])],
  ]));

  assertEquals(result.diagnostics, []);
  assertEquals(result.macrosById.get(1)?.invocationKind, 'decl');
  assertEquals(result.macrosById.get(1)?.declarationKind, 'typeAlias');
  assertEquals(
    result.replacements.map((replacement) =>
      sourceText.slice(replacement.originalSpan.start, replacement.originalSpan.end)
    ),
    [
      '// #[derive(strategy: tagged)]\nexport type UserId = string & { readonly __brand: "UserId" };',
    ],
  );
});

Deno.test('rewriteMacroSource preserves stacked declaration annotations as ordered placeholders over one declaration span', () => {
  const sourceText = [
    "import { eq, hash } from 'sts:derive';",
    '',
    '// #[eq]',
    '// #[hash]',
    'type User = { id: string };',
    '',
  ].join('\n');
  const result = rewriteMacroSource('example.sts', sourceText, new Map([
    ['sts:derive', new Map([
      ['eq', 'annotation' as const],
      ['hash', 'annotation' as const],
    ])],
  ]));

  assertEquals(result.diagnostics, []);
  assertEquals(result.replacements.length, 2);
  assertEquals(result.macrosById.get(1)?.nameText, 'eq');
  assertEquals(result.macrosById.get(1)?.preserveDeclaration, true);
  assertEquals(result.macrosById.get(2)?.nameText, 'hash');
  assertEquals(result.macrosById.get(2)?.preserveDeclaration, false);
  assertEquals(
    result.replacements.map((replacement) =>
      sourceText.slice(replacement.originalSpan.start, replacement.originalSpan.end)
    ),
    [
      '// #[eq]\n// #[hash]\ntype User = { id: string };',
      '// #[eq]\n// #[hash]\ntype User = { id: string };',
    ],
  );
  assertEquals(result.rewrittenText.includes('__sts_macro_stmt(1);__sts_macro_stmt(2);'), true);
});

Deno.test('rewriteMacroSource ignores imported identifiers that do not follow macro naming conventions', () => {
  const sourceText = [
    "import { helper } from './helpers';",
    'const value = helper(fetchValue());',
    '',
  ].join('\n');
  const result = rewriteMacroSource('example.sts', sourceText);

  assertEquals(result.diagnostics, []);
  assertEquals(result.replacements, []);
  assertEquals(result.rewrittenText, sourceText);
});

Deno.test('rewriteMacroSource rejects legacy hash macro syntax', () => {
  const sourceText = 'const value = #attempt fetchValue();';
  const result = rewriteMacroSource('example.sts', sourceText);

  assertEquals(result.rewrittenText, sourceText);
  assertEquals(result.replacements, []);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.reason), ['legacy-syntax']);
});
