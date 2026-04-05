import { assertEquals } from '@std/assert';

import { parseFixtureCase } from './harness.ts';

Deno.test('parseFixtureCase captures expected message notes and hint metadata', () => {
  const parsed = parseFixtureCase({
    name: 'covariant-array.reject.ts',
    source: `// @sound-test: reject
// @sound-error: SOUND1019 "Mutable arrays are invariant in soundscript."
// @sound-note: 'Dog[]' cannot be widened to 'Animal[]' because writes through the target could push values the source array does not allow.
// @sound-hint: Use a readonly array, copy into a new array, or keep the exact element type.
interface Animal {
  name: string;
}
`,
  });

  assertEquals(parsed.expectedDiagnosticCode, 'SOUND1019');
  assertEquals(parsed.expectedDiagnosticMessage, 'Mutable arrays are invariant in soundscript.');
  assertEquals(parsed.expectedDiagnosticNotes, [
    "'Dog[]' cannot be widened to 'Animal[]' because writes through the target could push values the source array does not allow.",
  ]);
  assertEquals(
    parsed.expectedDiagnosticHint,
    'Use a readonly array, copy into a new array, or keep the exact element type.',
  );
});
