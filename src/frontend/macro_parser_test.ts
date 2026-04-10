import { assertEquals } from '@std/assert';

import { parseMacroInvocationAt } from './macro_parser.ts';

Deno.test('parseMacroInvocationAt parses arglist form in expression position', () => {
  const sourceText = 'const x = #foo(a, b + c);';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.nameText, 'foo');
  assertEquals(result.invocationKind, 'arglist');
  assertEquals(result.rewriteKind, 'expr');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'a' },
      { kind: 'ExprArg', text: 'b + c' },
    ],
  );
  assertEquals(sourceText.slice(result.span.start, result.span.end), '#foo(a, b + c)');
});

Deno.test('parseMacroInvocationAt parses arglist-plus-block form', () => {
  const sourceText = '#foo(a, b) { body(); }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist+block');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'a' },
      { kind: 'ExprArg', text: 'b' },
    ],
  );
  assertEquals(
    result.trailingBlockSpan
      ? sourceText.slice(result.trailingBlockSpan.start, result.trailingBlockSpan.end)
      : undefined,
    '{ body(); }',
  );
});

Deno.test('parseMacroInvocationAt parses arglist with a trailing final expression operand', () => {
  const sourceText = 'const value = #match (result) [({ value }: Ok) => value, (_) => 0];';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist');
  assertEquals(result.rewriteKind, 'expr');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'result' },
      { kind: 'ExprArg', text: '[({ value }: Ok) => value, (_) => 0]' },
    ],
  );
});

Deno.test('parseMacroInvocationAt keeps trailing object literals explicit via parentheses', () => {
  const sourceText = 'const value = #foo(a) ({ kind: "ok" });';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist');
  assertEquals(
    result.argumentSpans.map((argument) =>
      sourceText.slice(argument.span.start, argument.span.end)
    ),
    ['a', '({ kind: "ok" })'],
  );
});

Deno.test('parseMacroInvocationAt does not treat bracket access continuations as trailing final operands', () => {
  const sourceText = 'const value = #foo(a)[0];';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist');
  assertEquals(
    result.argumentSpans.map((argument) =>
      sourceText.slice(argument.span.start, argument.span.end)
    ),
    ['a'],
  );
  assertEquals(sourceText.slice(result.span.start, result.span.end), '#foo(a)');
});

Deno.test('parseMacroInvocationAt does not treat next-line expressions as trailing final operands', () => {
  const sourceText = ['const value = #foo(a)', 'bar;'].join('\n');
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist');
  assertEquals(
    result.argumentSpans.map((argument) =>
      sourceText.slice(argument.span.start, argument.span.end)
    ),
    ['a'],
  );
  assertEquals(sourceText.slice(result.span.start, result.span.end), '#foo(a)');
});

Deno.test('parseMacroInvocationAt parses block-only form in statement position', () => {
  const sourceText = '#foo { body(); }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.nameText, 'foo');
  assertEquals(result.invocationKind, 'block');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'BlockArg', text: '{ body(); }' },
    ],
  );
  assertEquals(result.trailingBlockSpan, undefined);
});

Deno.test('parseMacroInvocationAt parses bare single-arg form as arglist in expression position', () => {
  const sourceText = 'call(#foo bar + baz);';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.nameText, 'foo');
  assertEquals(result.invocationKind, 'arglist');
  assertEquals(result.rewriteKind, 'expr');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'bar + baz' },
    ],
  );
});

Deno.test('parseMacroInvocationAt treats single parenthesized operands as arglist form in expression position', () => {
  for (
    const sourceText of [
      'const value = #foo({ key: 1 });',
      'const value = #foo ({ key: 1 });',
    ]
  ) {
    const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

    assertEquals('reason' in result, false);
    if ('reason' in result) {
      continue;
    }

    assertEquals(result.nameText, 'foo');
    assertEquals(result.invocationKind, 'arglist');
    assertEquals(result.rewriteKind, 'expr');
    assertEquals(
      result.argumentSpans.map((argument) => ({
        kind: argument.kind,
        text: sourceText.slice(argument.span.start, argument.span.end),
      })),
      [
        { kind: 'ExprArg', text: '{ key: 1 }' },
      ],
    );
  }
});

Deno.test('parseMacroInvocationAt keeps spaced arglist-plus-block form for generic block operands', () => {
  const sourceText = 'const value = #foo (result) { body(); };';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist+block');
  assertEquals(result.rewriteKind, 'expr');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'result' },
    ],
  );
  assertEquals(
    result.trailingBlockSpan
      ? sourceText.slice(result.trailingBlockSpan.start, result.trailingBlockSpan.end)
      : undefined,
    '{ body(); }',
  );
});

Deno.test('parseMacroInvocationAt keeps ternary object literal inside expression', () => {
  const sourceText = '#foo cond ? { x: 1 } : y';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'cond ? { x: 1 } : y' },
    ],
  );
  assertEquals(result.trailingBlockSpan, undefined);
});

Deno.test('parseMacroInvocationAt keeps arrow block body inside expression', () => {
  const sourceText = '#foo x => { body(); }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'x => { body(); }' },
    ],
  );
  assertEquals(result.trailingBlockSpan, undefined);
});

Deno.test('parseMacroInvocationAt keeps function expression body inside expression', () => {
  const sourceText = '#foo function () { body(); }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'function () { body(); }' },
    ],
  );
  assertEquals(result.trailingBlockSpan, undefined);
});

Deno.test('parseMacroInvocationAt treats named bare class bodies as declaration forms in statement position', () => {
  const sourceText = '#foo class X { method() {} }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'decl');
  assertEquals(result.argumentSpans, []);
  assertEquals(
    sourceText.slice(result.declarationSpan?.start ?? 0, result.declarationSpan?.end ?? 0),
    'class X { method() {} }',
  );
  assertEquals(result.declarationKind, 'class');
  assertEquals(result.declarationName, 'X');
});

Deno.test('parseMacroInvocationAt parses declaration form in statement position', () => {
  const sourceText = '#foo export abstract class User<T> { method(): T { throw new Error(); } }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'decl');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(result.argumentSpans, []);
  assertEquals(
    sourceText.slice(result.declarationSpan?.start ?? 0, result.declarationSpan?.end ?? 0),
    'export abstract class User<T> { method(): T { throw new Error(); } }',
  );
  assertEquals(result.declarationKind, 'class');
  assertEquals(result.declarationName, 'User');
  assertEquals(result.trailingBlockSpan, undefined);
});

Deno.test('parseMacroInvocationAt parses bare class declaration form in statement position', () => {
  const sourceText = '#foo class User { id: string; }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'decl');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(result.argumentSpans, []);
  assertEquals(
    sourceText.slice(result.declarationSpan?.start ?? 0, result.declarationSpan?.end ?? 0),
    'class User { id: string; }',
  );
  assertEquals(result.declarationKind, 'class');
  assertEquals(result.declarationName, 'User');
});

Deno.test('parseMacroInvocationAt parses bare function declaration form in statement position', () => {
  const sourceText = '#foo function boot(): void {}';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'decl');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(result.argumentSpans, []);
  assertEquals(
    sourceText.slice(result.declarationSpan?.start ?? 0, result.declarationSpan?.end ?? 0),
    'function boot(): void {}',
  );
  assertEquals(result.declarationKind, 'function');
  assertEquals(result.declarationName, 'boot');
});

Deno.test('parseMacroInvocationAt parses bare interface declaration form in statement position', () => {
  const sourceText = '#foo interface Box<T> { readonly value: T; }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'decl');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(result.argumentSpans, []);
  assertEquals(
    sourceText.slice(result.declarationSpan?.start ?? 0, result.declarationSpan?.end ?? 0),
    'interface Box<T> { readonly value: T; }',
  );
  assertEquals(result.declarationKind, 'interface');
  assertEquals(result.declarationName, 'Box');
});

Deno.test('parseMacroInvocationAt parses bare type alias declaration form in statement position', () => {
  const sourceText = '#foo export type Box<T> = { readonly value: T };';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'decl');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(result.argumentSpans, []);
  assertEquals(
    sourceText.slice(result.declarationSpan?.start ?? 0, result.declarationSpan?.end ?? 0),
    'export type Box<T> = { readonly value: T };',
  );
  assertEquals(result.declarationKind, 'typeAlias');
  assertEquals(result.declarationName, 'Box');
});

Deno.test('parseMacroInvocationAt keeps JSX-bearing declaration bodies intact in .sts files', () => {
  const sourceText = [
    '#component',
    'export class TodoApp {',
    '  render() {',
    '    return <section>',
    '      <button type="button" onClick={() => this.addSeedTodo()}>Add seeded todo</button>',
    '    </section>;',
    '  }',
    '}',
    '',
  ].join('\n');
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'decl');
  assertEquals(
    result.declarationSpan
      ? sourceText.slice(result.declarationSpan.start, result.declarationSpan.end)
      : '',
    [
      'export class TodoApp {',
      '  render() {',
      '    return <section>',
      '      <button type="button" onClick={() => this.addSeedTodo()}>Add seeded todo</button>',
      '    </section>;',
      '  }',
      '}',
    ].join('\n'),
  );
});

Deno.test('parseMacroInvocationAt parses arglist-plus-declaration form for async functions', () => {
  const sourceText =
    '#main(node) export async function boot<T>(input: { value: T }): Promise<T> { return input.value; }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist+decl');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'node' },
    ],
  );
  assertEquals(
    sourceText.slice(result.declarationSpan?.start ?? 0, result.declarationSpan?.end ?? 0),
    'export async function boot<T>(input: { value: T }): Promise<T> { return input.value; }',
  );
  assertEquals(result.declarationKind, 'function');
  assertEquals(result.declarationName, 'boot');
  assertEquals(result.trailingBlockSpan, undefined);
});

Deno.test('parseMacroInvocationAt parses arglist-plus-interface declaration form', () => {
  const sourceText =
    '#main(node) export interface Entry<A> { readonly run: (value: A) => number; }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist+decl');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'node' },
    ],
  );
  assertEquals(
    sourceText.slice(result.declarationSpan?.start ?? 0, result.declarationSpan?.end ?? 0),
    'export interface Entry<A> { readonly run: (value: A) => number; }',
  );
  assertEquals(result.declarationKind, 'interface');
  assertEquals(result.declarationName, 'Entry');
});

Deno.test('parseMacroInvocationAt parses arglist-plus-type-alias declaration form', () => {
  const sourceText = '#main(node) export type Entry<A> = { readonly run: (value: A) => number };';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist+decl');
  assertEquals(result.rewriteKind, 'stmt');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'node' },
    ],
  );
  assertEquals(
    sourceText.slice(result.declarationSpan?.start ?? 0, result.declarationSpan?.end ?? 0),
    'export type Entry<A> = { readonly run: (value: A) => number };',
  );
  assertEquals(result.declarationKind, 'typeAlias');
  assertEquals(result.declarationName, 'Entry');
});

Deno.test('parseMacroInvocationAt keeps ternary colon object literal inside expression', () => {
  const sourceText = '#foo cond ? x : { y: 1 }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist');
  assertEquals(
    result.argumentSpans.map((argument) => ({
      kind: argument.kind,
      text: sourceText.slice(argument.span.start, argument.span.end),
    })),
    [
      { kind: 'ExprArg', text: 'cond ? x : { y: 1 }' },
    ],
  );
  assertEquals(result.trailingBlockSpan, undefined);
});

Deno.test('parseMacroInvocationAt rejects expression-plus-trailing-block form', () => {
  const sourceText = '#foo value { body(); }';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, true);
  if (!('reason' in result)) {
    return;
  }

  assertEquals(result.reason, 'unexpected-token');
  assertEquals(sourceText.slice(result.span.start, result.span.end), '{ body(); }');
});

Deno.test('parseMacroInvocationAt supports non-ASCII macro names', () => {
  const sourceText = 'const value = #π(value);';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.nameText, 'π');
  assertEquals(result.invocationKind, 'arglist');
});

Deno.test('parseMacroInvocationAt classifies return-site macros as expression rewrite kind', () => {
  const sourceText = 'return #foo value;';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.rewriteKind, 'expr');
});

Deno.test('parseMacroInvocationAt classifies short-circuit rhs macros as expression rewrite kind', () => {
  const sourceText = 'const value = flag && #foo value;';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.rewriteKind, 'expr');
});

Deno.test('parseMacroInvocationAt classifies for-of and for-in rhs macros as expression rewrite kind', () => {
  const cases = [
    'for (const value of #foo values) {}',
    'for (const key in #foo record) {}',
  ];

  for (const sourceText of cases) {
    const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

    assertEquals('reason' in result, false);
    if ('reason' in result) {
      return;
    }

    assertEquals(result.rewriteKind, 'expr');
  }
});

Deno.test('parseMacroInvocationAt classifies classic for-condition macros as expression rewrite kind', () => {
  const sourceText = 'for (; #foo value; ) {}';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.rewriteKind, 'expr');
});

Deno.test('parseMacroInvocationAt stops ternary-arm macros before the outer colon', () => {
  const sourceText = 'const value = flag ? #foo fetchValue() : 1;';
  const result = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));

  assertEquals('reason' in result, false);
  if ('reason' in result) {
    return;
  }

  assertEquals(result.invocationKind, 'arglist');
  assertEquals(sourceText.slice(result.span.start, result.span.end), '#foo fetchValue()');
  assertEquals(
    result.argumentSpans.map((argument) =>
      sourceText.slice(argument.span.start, argument.span.end)
    ),
    ['fetchValue()'],
  );
});

Deno.test('parseMacroInvocationAt reports missing expression after macro name', () => {
  const sourceText = '#foo';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, true);
  if (!('reason' in result)) {
    return;
  }

  assertEquals(result.reason, 'missing-expression');
});

Deno.test('parseMacroInvocationAt reports malformed arglist with missing middle expression', () => {
  const sourceText = '#foo(a,,b)';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, true);
  if (!('reason' in result)) {
    return;
  }

  assertEquals(result.reason, 'unexpected-token');
});

Deno.test('parseMacroInvocationAt reports malformed arglist with missing leading expression', () => {
  const sourceText = '#foo(,a)';
  const result = parseMacroInvocationAt('example.sts', sourceText, 0);

  assertEquals('reason' in result, true);
  if (!('reason' in result)) {
    return;
  }

  assertEquals(result.reason, 'unexpected-token');
});
