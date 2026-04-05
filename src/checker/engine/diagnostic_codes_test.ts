import { assertEquals, assertMatch, assertStringIncludes } from '@std/assert';

import {
  COMPILER_DIAGNOSTIC_CODES,
  COMPILER_DIAGNOSTIC_MESSAGES,
  SOUND_DIAGNOSTIC_CODES,
} from './diagnostic_codes.ts';

Deno.test('compiler diagnostics reserve a distinct backend-gap family', () => {
  assertEquals(COMPILER_DIAGNOSTIC_CODES.unsupportedCompilerSubset, 'COMPILER2001');
  assertStringIncludes(
    COMPILER_DIAGNOSTIC_MESSAGES.unsupportedCompilerSubset,
    'accepted by the checker',
  );
  assertStringIncludes(
    COMPILER_DIAGNOSTIC_MESSAGES.unsupportedCompilerSubset,
    'compiler backend',
  );
});

Deno.test('compiler diagnostics stay distinct from sound diagnostics', () => {
  for (const code of Object.values(SOUND_DIAGNOSTIC_CODES)) {
    assertMatch(code, /^SOUND\d+$/);
  }

  for (const code of Object.values(COMPILER_DIAGNOSTIC_CODES)) {
    assertMatch(String(code), /^COMPILER\d+$/);
  }
});
