import { assertEquals } from '@std/assert';
import ts from 'typescript';

import { formatDiagnostic, toMergedDiagnostic, type MergedDiagnostic } from './diagnostics.ts';

Deno.test('formatDiagnostic renders notes hints and related information', () => {
  const diagnostic: MergedDiagnostic = {
    source: 'sound',
    code: 'SOUND1024',
    category: 'error',
    message: "Null-prototype values are not assignable to 'object' in soundscript.",
    filePath: '/repo/src/index.ts',
    line: 2,
    column: 7,
    notes: [
      "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
    ],
    hint: "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
    relatedInformation: [
      {
        message: 'Null-prototype value originates here.',
        filePath: '/repo/src/helpers.ts',
        line: 1,
        column: 1,
      },
    ],
  };

  assertEquals(
    formatDiagnostic(diagnostic, '/repo'),
    [
      "src/index.ts:2:7 - error SOUND1024: Null-prototype values are not assignable to 'object' in soundscript.",
      "  note: 'object' assumes Object.prototype members, but this value is known to have a null prototype.",
      "  hint: Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
      '  related: src/helpers.ts:1:1: Null-prototype value originates here.',
    ].join('\n'),
  );
});

Deno.test('toMergedDiagnostic preserves related TypeScript information', () => {
  const mainFile = ts.createSourceFile(
    '/repo/src/index.ts',
    'const value: string = 1;\n',
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const relatedFile = ts.createSourceFile(
    '/repo/src/types.ts',
    'export type Value = string;\n',
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );

  const diagnostic = {
    file: mainFile,
    start: 6,
    length: 5,
    category: ts.DiagnosticCategory.Error,
    code: 2322,
    messageText: "Type 'number' is not assignable to type 'string'.",
    relatedInformation: [
      {
        file: relatedFile,
        start: 13,
        length: 5,
        category: ts.DiagnosticCategory.Message,
        code: 6500,
        messageText: "The expected type comes from alias 'Value'.",
      },
    ],
  } satisfies ts.Diagnostic;

  assertEquals(toMergedDiagnostic(diagnostic), {
    source: 'ts',
    code: 'TS2322',
    category: 'error',
    message: "Type 'number' is not assignable to type 'string'.",
    filePath: '/repo/src/index.ts',
    line: 1,
    column: 7,
    endLine: 1,
    endColumn: 12,
    relatedInformation: [
      {
        message: "The expected type comes from alias 'Value'.",
        filePath: '/repo/src/types.ts',
        line: 1,
        column: 14,
        endLine: 1,
        endColumn: 19,
      },
    ],
  });
});
