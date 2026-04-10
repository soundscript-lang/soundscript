import { assertEquals, assertStringIncludes } from '@std/assert';

import { inlineSourceMapComment } from './source_maps.ts';

const INLINE_SOURCE_MAP_PREFIX = '//# sourceMappingURL=data:application/json;base64,';

function decodeInlineSourceMapComment(comment: string): string {
  assertStringIncludes(comment, INLINE_SOURCE_MAP_PREFIX);
  const base64 = comment.slice(INLINE_SOURCE_MAP_PREFIX.length);
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

Deno.test('inlineSourceMapComment encodes UTF-8 source maps without throwing on non-ASCII source text', () => {
  const mapText = `${
    JSON.stringify({
      version: 3,
      sources: ['/virtual/main.sts'],
      sourcesContent: ["const greeting = '👋 Привет';\n"],
      names: [],
      mappings: '',
    })
  }\n`;

  const comment = inlineSourceMapComment(mapText);

  assertEquals(decodeInlineSourceMapComment(comment), mapText);
});
