import { assertEquals } from '@std/assert';

import { SessionState } from './session.ts';

Deno.test('SessionState increments revision for open update and close lifecycle changes', () => {
  const session = new SessionState();

  assertEquals(session.revision(), 0);

  session.open({
    uri: 'file:///workspace/src/index.ts',
    languageId: 'typescript',
    version: 1,
    text: 'const value = 1;\n',
  });
  assertEquals(session.revision(), 1);

  session.update('file:///workspace/src/index.ts', 2, 'const value = 2;\n');
  assertEquals(session.revision(), 2);

  session.close('file:///workspace/src/index.ts');
  assertEquals(session.revision(), 3);
});

Deno.test('SessionState does not increment revision for no-op close or update', () => {
  const session = new SessionState();

  session.update('file:///workspace/src/index.ts', 1, 'const value = 1;\n');
  assertEquals(session.revision(), 0);

  session.close('file:///workspace/src/index.ts');
  assertEquals(session.revision(), 0);
});
