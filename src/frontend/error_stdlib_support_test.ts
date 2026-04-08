import { assertEquals, assertStringIncludes } from '@std/assert';
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

Deno.test('error stdlib support text is generated from stdlib sources', () => {
  assertStringIncludes(ERROR_STDLIB_DECLARATION_TEXT, 'export declare class Failure');
});
