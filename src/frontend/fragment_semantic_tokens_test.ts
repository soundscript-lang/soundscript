import { assertEquals } from '@std/assert';

import { css, graphql, sql } from './builtin_macros.ts';
import type { MacroDefinition } from './macro_api.ts';
import { createSyntaxOnlyMacroContext } from './macro_context.ts';
import { fragmentsForMacroDefinition } from './macro_definition_support.ts';
import { parseMacroInvocationAt } from './macro_parser.ts';

function fragmentForSource(
  sourceText: string,
  definition: MacroDefinition,
) {
  const invocation = parseMacroInvocationAt('example.sts', sourceText, sourceText.indexOf('#'));
  if ('reason' in invocation) {
    throw new Error(`expected invocation, got diagnostic: ${invocation.reason}`);
  }

  const ctx = createSyntaxOnlyMacroContext(invocation, sourceText);
  const [fragment] = fragmentsForMacroDefinition(definition, ctx);
  if (!fragment) {
    throw new Error('expected embedded fragment');
  }
  return { fragment, sourceText };
}

Deno.test('sql embedded fragments expose basic keyword semantic tokens', () => {
  const { fragment, sourceText } = fragmentForSource(
    'const query = #sql `select * from users where id = ${userId}`;\n',
    sql(),
  );

  assertEquals(fragment.language, 'sql');
  assertEquals(
    fragment.semanticTokens?.map((token) => ({
      text: sourceText.slice(token.span.start, token.span.end),
      type: token.type,
    })),
    [
      { text: 'select', type: 'keyword' },
      { text: 'from', type: 'keyword' },
      { text: 'where', type: 'keyword' },
    ],
  );
});

Deno.test('css embedded fragments expose property semantic tokens', () => {
  const { fragment, sourceText } = fragmentForSource(
    'const style = #css `button { color: ${primaryColor}; background: ${css.raw(backgroundCss)}; }`;\n',
    css(),
  );

  assertEquals(fragment.language, 'css');
  assertEquals(
    fragment.semanticTokens?.map((token) => ({
      text: sourceText.slice(token.span.start, token.span.end),
      type: token.type,
    })),
    [
      { text: 'color', type: 'property' },
      { text: 'background', type: 'property' },
    ],
  );
});

Deno.test('graphql embedded fragments expose keyword semantic tokens', () => {
  const { fragment, sourceText } = fragmentForSource(
    'const query = #graphql `query User { user(id: ${userId}) { name } }`;\n',
    graphql(),
  );

  assertEquals(fragment.language, 'graphql');
  assertEquals(
    fragment.semanticTokens?.map((token) => ({
      text: sourceText.slice(token.span.start, token.span.end),
      type: token.type,
    })),
    [
      { text: 'query', type: 'keyword' },
    ],
  );
});
