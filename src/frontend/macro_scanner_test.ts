import { assertEquals } from '@std/assert';

import { scanMacroCandidates } from './macro_scanner.ts';

Deno.test('scanMacroCandidates classifies top-level #name as a macro start', () => {
  const result = scanMacroCandidates('example.sts', '#foo bar');

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: '#foo',
    })),
    [
      {
        kind: 'macro-start',
        name: 'foo',
        text: '#foo',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates allows macro starts inside ordinary call arguments', () => {
  const sourceText = 'call(#foo bar);';
  const result = scanMacroCandidates('example.sts', sourceText);

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: sourceText.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'macro-start',
        name: 'foo',
        text: '#foo',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates allows macro starts inside grouped expressions', () => {
  const sourceText = 'const value = (#foo bar);';
  const result = scanMacroCandidates('example.sts', sourceText);

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: sourceText.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'macro-start',
        name: 'foo',
        text: '#foo',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates allows macro starts after short-circuit operators', () => {
  const cases = [
    'const a = left && #foo value;',
    'const b = left || #foo value;',
    'const c = left ?? #foo value;',
  ];

  for (const sourceText of cases) {
    const result = scanMacroCandidates('example.sts', sourceText);

    assertEquals(
      result.hashes.map((hash) => ({
        kind: hash.kind,
        name: hash.nameText,
        text: sourceText.slice(hash.span.start, hash.span.end),
      })),
      [
        {
          kind: 'macro-start',
          name: 'foo',
          text: '#foo',
        },
      ],
    );
    assertEquals(result.diagnostics, []);
  }
});

Deno.test('scanMacroCandidates allows macro starts in for-of and for-in right-hand expressions', () => {
  const cases = [
    'for (const value of #foo values) {}',
    'for (const key in #foo record) {}',
  ];

  for (const sourceText of cases) {
    const result = scanMacroCandidates('example.sts', sourceText);

    assertEquals(
      result.hashes.map((hash) => ({
        kind: hash.kind,
        name: hash.nameText,
        text: sourceText.slice(hash.span.start, hash.span.end),
      })),
      [
        {
          kind: 'macro-start',
          name: 'foo',
          text: '#foo',
        },
      ],
    );
    assertEquals(result.diagnostics, []);
  }
});

Deno.test('scanMacroCandidates allows top-level declaration macros after a prior class body', () => {
  const sourceText = [
    '#component',
    'class Summary {',
    '  render() {',
    '    return <p />;',
    '  }',
    '}',
    '',
    '#component',
    'class Example {',
    '  count = #state 1;',
    '}',
    '',
  ].join('\n');
  const result = scanMacroCandidates('example.sts', sourceText);

  assertEquals(
    result.hashes
      .filter((hash) => hash.kind === 'macro-start')
      .map((hash) => sourceText.slice(hash.span.start, hash.span.end)),
    ['#component', '#component', '#state'],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates classifies private field access after dot as private-name', () => {
  const result = scanMacroCandidates('example.sts', 'this.#value;');

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: 'this.#value;'.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'private-name',
        name: 'value',
        text: '#value',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates classifies class member #name as private-name', () => {
  const result = scanMacroCandidates('example.sts', 'class C { #value = 1; }');

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: 'class C { #value = 1; }'.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'private-name',
        name: 'value',
        text: '#value',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates classifies class private method names as private-name', () => {
  const sourceText = 'class JsonLikeParser { #consumeKeyword(expected: string) {} }';
  const result = scanMacroCandidates('example.sts', sourceText);

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: sourceText.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'private-name',
        name: 'consumeKeyword',
        text: '#consumeKeyword',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test(
  'scanMacroCandidates classifies class private methods after a prior method body as private-name',
  () => {
    const sourceText = [
      'class JsonLikeParser {',
      '  parseValue() {}',
      '  #consumeKeyword(expected: string) {}',
      '}',
    ].join('\n');
    const result = scanMacroCandidates('example.sts', sourceText);

    assertEquals(
      result.hashes.map((hash) => ({
        kind: hash.kind,
        name: hash.nameText,
        text: sourceText.slice(hash.span.start, hash.span.end),
      })),
      [
        {
          kind: 'private-name',
          name: 'consumeKeyword',
          text: '#consumeKeyword',
        },
      ],
    );
    assertEquals(result.diagnostics, []);
  },
);

Deno.test('scanMacroCandidates keeps class body tracking stable across extends expressions', () => {
  const sourceText = 'class C extends mixin({ x: 1 }) { #value = 1; }';
  const result = scanMacroCandidates('example.sts', sourceText);

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: sourceText.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'private-name',
        name: 'value',
        text: '#value',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates does not treat function parameter #name as a macro start', () => {
  const result = scanMacroCandidates('example.sts', 'function f(#value) {}');

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.reason), ['illegal-context']);
});

Deno.test('scanMacroCandidates does not treat method parameter #name as a macro start', () => {
  const result = scanMacroCandidates('example.sts', 'class C { method(#value) {} }');

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.reason), ['illegal-context']);
});

Deno.test('scanMacroCandidates does not treat arrow parameter #name as a macro start', () => {
  const result = scanMacroCandidates('example.sts', 'const fn = (#value) => {};');

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.reason), ['illegal-context']);
});

Deno.test('scanMacroCandidates does not treat multi-parameter arrow #name as a macro start', () => {
  const result = scanMacroCandidates('example.sts', 'const fn = (a, #value) => {};');

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.reason), ['illegal-context']);
});

Deno.test('scanMacroCandidates does not treat destructured multi-parameter arrow #name as a macro start', () => {
  const result = scanMacroCandidates('example.sts', 'const fn = ({ a }, #value) => {};');

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.reason), ['illegal-context']);
});

Deno.test('scanMacroCandidates supports non-ASCII private identifiers', () => {
  const sourceText = 'class C { #π = 1; }';
  const result = scanMacroCandidates('example.sts', sourceText);

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: sourceText.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'private-name',
        name: 'π',
        text: '#π',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates keeps class body tracking stable across tagged-template heritage', () => {
  const sourceText = 'class C extends tag`${value}` { #x = 1; }';
  const result = scanMacroCandidates('example.sts', sourceText);

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: sourceText.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'private-name',
        name: 'x',
        text: '#x',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates keeps class body tracking stable across no-substitution tagged-template heritage', () => {
  const sourceText = 'class C extends tag`plain` { #x = 1; }';
  const result = scanMacroCandidates('example.sts', sourceText);

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: sourceText.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'private-name',
        name: 'x',
        text: '#x',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates ignores hashes inside regular expression literals', () => {
  const sourceText = "const cssColor = /^#[0-9a-fA-F]{3,8}$/;";
  const result = scanMacroCandidates('example.ts', sourceText);

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates ignores hashes inside string literals', () => {
  const sourceText = "const htmlEntity = '&#039;';";
  const result = scanMacroCandidates('example.ts', sourceText);

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates ignores hashes inside template literal text', () => {
  const sourceText = 'const channelLink = `<#${channelId}>`;';
  const result = scanMacroCandidates('example.ts', sourceText);

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates ignores template hashes in larger expressions', () => {
  const sourceText = 'const value = next.title || `#${next.friendlyId}`;';
  const result = scanMacroCandidates('example.ts', sourceText);

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates ignores template hashes in indexed assignment expressions', () => {
  const sourceText = 'acc[next.id] = next.title || `#${next.friendlyId}`;';
  const result = scanMacroCandidates('example.ts', sourceText);

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates ignores template hashes after nested templates inside interpolation', () => {
  const sourceText =
    "const label = `${slackChannel.name}${slackChannel.botIds != null && !slackChannel.botIds.length ? ` (disconnected)` : ''}`;\n" +
    'const value = next.title || `#${next.friendlyId}`;';
  const result = scanMacroCandidates('example.ts', sourceText);

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates treats declared generic class private fields as private names', () => {
  const sourceText = [
    'export declare class RedisClientPool<M extends Record<string, unknown> = {}> {',
    '  #private;',
    '}',
    '',
  ].join('\n');
  const result = scanMacroCandidates('example.d.ts', sourceText);

  assertEquals(
    result.hashes.map((hash) => ({
      kind: hash.kind,
      name: hash.nameText,
      text: sourceText.slice(hash.span.start, hash.span.end),
    })),
    [
      {
        kind: 'private-name',
        name: 'private',
        text: '#private',
      },
    ],
  );
  assertEquals(result.diagnostics, []);
});

Deno.test('scanMacroCandidates does not treat computed method parameter #name as a macro start', () => {
  const result = scanMacroCandidates('example.sts', 'class C { [name](#value) {} }');

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.reason), ['illegal-context']);
});

Deno.test('scanMacroCandidates reports invalid hash use when no identifier follows', () => {
  const result = scanMacroCandidates('example.sts', '#(');

  assertEquals(result.hashes, []);
  assertEquals(result.diagnostics.map((diagnostic) => diagnostic.reason), [
    'not-followed-by-identifier',
  ]);
});

Deno.test('scanMacroCandidates continues finding later macros after a template-literal macro operand', () => {
  const sourceText = [
    "import { css } from 'sts:experimental/css';",
    "import { graphql } from 'sts:experimental/graphql';",
    "import { sql } from 'sts:experimental/sql';",
    'declare const userId: number;',
    'declare const primaryColor: string;',
    'declare const backgroundCss: string;',
    'const query = #sql `select *',
    'from users',
    'where id = ${userId}`;',
    'const style = #css `button { color: ${primaryColor}; background: ${css.raw(backgroundCss)}; }`;',
    'const operation = #graphql `query User { user(id: ${userId}) { name } }`;',
    '',
  ].join('\n');

  const result = scanMacroCandidates('example.sts', sourceText);

  assertEquals(
    result.hashes
      .filter((hash) => hash.kind === 'macro-start')
      .map((hash) => sourceText.slice(hash.span.start, hash.span.end)),
    ['#sql', '#css', '#graphql'],
  );
  assertEquals(result.diagnostics, []);
});
