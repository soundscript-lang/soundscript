import { assertStringIncludes } from '@std/assert';

import { rewriteModuleSpecifiersForEmit } from './transform.ts';

Deno.test('rewriteModuleSpecifiersForEmit rewrites host protocol imports to canonical runtime modules', () => {
  const rewritten = rewriteModuleSpecifiersForEmit(
    [
      '// #[interop]',
      "import { document } from 'host:dom';",
      '// #[interop]',
      "import { process } from 'host:node';",
      '',
    ].join('\n'),
    '/virtual/index.ts',
  );

  assertStringIncludes(rewritten, "from '@soundscript/soundscript/host/dom'");
  assertStringIncludes(rewritten, "from '@soundscript/soundscript/host/node'");
});
