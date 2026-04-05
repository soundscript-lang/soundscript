import { assertEquals } from '@std/assert';
import ts from 'typescript';

import {
  ERROR_STDLIB_DECLARATION_FILE,
  ERROR_STDLIB_DECLARATION_TEXT,
  ERROR_STDLIB_MODULE_SPECIFIER,
  withErrorStdlibModuleResolution,
} from './error_stdlib_support.ts';

Deno.test('error stdlib support resolves sts:failures to the virtual stdlib source file', () => {
  const host = withErrorStdlibModuleResolution(ts.createCompilerHost({
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  }));

  const [resolved] = host.resolveModuleNames!(
    [ERROR_STDLIB_MODULE_SPECIFIER],
    '/virtual/index.ts',
    undefined,
    undefined,
    {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  );

  assertEquals(resolved?.resolvedFileName, ERROR_STDLIB_DECLARATION_FILE);
});

Deno.test('error stdlib support text stays in sync with the checked-in stdlib declaration file', async () => {
  const fileText = await Deno.readTextFile(new URL('../stdlib/failures.d.ts', import.meta.url));
  assertEquals(ERROR_STDLIB_DECLARATION_TEXT.trim(), fileText.trim());
});
