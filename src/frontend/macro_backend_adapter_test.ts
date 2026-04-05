import { assert, assertEquals } from '@std/assert';
import ts from 'typescript';

import type { MacroDefinition } from './macro_api.ts';
import { macroSignature } from './macro_api.ts';
import { createExpandMacroPlaceholderFromDefinition } from './macro_backend_adapter.ts';
import { MacroError } from './macro_errors.ts';
import { collectResolvedMacroPlaceholders } from './macro_resolver.ts';
import { createPreparedProgramForMacroTest } from './macro_test_helpers.ts';

function createResolvedPlaceholder(sourceText: string) {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { Foo } from 'macros/test';",
      sourceText.trimEnd(),
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: new Map([
      ['macros/test', new Map([['Foo', 'call' as const]])],
    ]),
  });
  const [collected] = collectResolvedMacroPlaceholders(preparedProgram);

  assert(collected);
  return collected.resolved;
}

function createResolvedDeclarationPlaceholder(sourceText: string, macroName = 'component') {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      `import { ${macroName} } from 'macros/test';`,
      sourceText.trimEnd(),
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: new Map([
      ['macros/test', new Map([[macroName, 'annotation' as const]])],
    ]),
  });
  const [collected] = collectResolvedMacroPlaceholders(preparedProgram);

  assert(collected);
  return collected.resolved;
}

function exprMacro(code: string): MacroDefinition {
  return {
    expand(ctx) {
      return ctx.output.expr(ctx.quote.expr`${code}`);
    },
  };
}

function stmtMacro(code: string): MacroDefinition {
  return {
    expand(ctx) {
      return ctx.output.stmt(ctx.quote.stmt`${code}`);
    },
  };
}

function stmtsMacro(code: string): MacroDefinition {
  return {
    expand(ctx) {
      return ctx.output.stmts(ctx.quote.stmts`${code}`);
    },
  };
}

Deno.test('createExpandMacroPlaceholderFromDefinition lowers emitted expressions', () => {
  const resolved = createResolvedPlaceholder('const value = Foo(bar);\n');
  const expand = createExpandMacroPlaceholderFromDefinition(exprMacro('1 + 2'), 'Foo');

  const expansion = expand(resolved);
  assert(expansion);
  assertEquals(expansion.kind, 'expr');
  if (expansion.kind !== 'expr') {
    return;
  }

  const sourceFile = ts.createSourceFile('/virtual/test.ts', '', ts.ScriptTarget.Latest, true);
  assertEquals(
    ts.createPrinter().printNode(ts.EmitHint.Expression, expansion.node, sourceFile),
    '1 + 2',
  );
});

Deno.test('createExpandMacroPlaceholderFromDefinition lowers emitted statement lists', () => {
  const resolved = createResolvedPlaceholder('Foo(() => { body(); });\n');
  const expand = createExpandMacroPlaceholderFromDefinition(stmtsMacro('first(); second();'), 'Foo');

  const expansion = expand(resolved);
  assert(expansion);
  assertEquals(expansion.kind, 'stmt');
  if (expansion.kind !== 'stmt') {
    return;
  }

  const sourceFile = ts.createSourceFile('/virtual/test.ts', '', ts.ScriptTarget.Latest, true);
  assertEquals(
    expansion.nodes.map((node) =>
      ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, sourceFile)
    ),
    ['first();', 'second();'],
  );
});

Deno.test('createExpandMacroPlaceholderFromDefinition lowers scope-exit outputs', () => {
  const resolved = createResolvedPlaceholder('function run() { Foo(() => { body(); }); work(); }\n');
  const expand = createExpandMacroPlaceholderFromDefinition({
    expand(ctx) {
      return ctx.controlFlow.deferCleanup(ctx.quote.stmts`cleanup(); after();`);
    },
  }, 'Foo', createPreparedProgramForMacroTest({
    '/virtual/index.sts': [
      "import { Foo } from 'macros/test';",
      'function run() { Foo(() => { body(); }); work(); }',
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: new Map([
      ['macros/test', new Map([['Foo', 'call' as const]])],
    ]),
  }));

  const expansion = expand(resolved);
  assert(expansion);
  assertEquals(expansion.kind, 'scope_exit');
  if (expansion.kind !== 'scope_exit') {
    return;
  }

  const sourceFile = ts.createSourceFile('/virtual/test.ts', '', ts.ScriptTarget.Latest, true);
  assertEquals(
    expansion.cleanupStatements.map((node) =>
      ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, sourceFile)
    ),
    ['cleanup();', 'after();'],
  );
});

Deno.test('createExpandMacroPlaceholderFromDefinition rejects non-output returns', () => {
  const resolved = createResolvedPlaceholder('const value = Foo(bar);\n');
  const expand = createExpandMacroPlaceholderFromDefinition(
    { expand: () => ({ nope: true }) as never },
    'Foo',
  );

  let error: unknown;
  try {
    expand(resolved);
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(
    error.message,
    'Macro "Foo" must return a value created by ctx.output.expr(...), ctx.output.stmt(...), ctx.output.stmts(...), ctx.controlFlow.rewriteWithValue(...), or ctx.controlFlow.deferCleanup(...).',
  );
});

Deno.test('createExpandMacroPlaceholderFromDefinition passes decoded signatures to expanders', () => {
  const resolved = createResolvedPlaceholder('const value = Foo(left, right);\n');
  const signature = macroSignature.of(
    macroSignature.expr('left'),
    macroSignature.expr('right'),
  );
  const expand = createExpandMacroPlaceholderFromDefinition({
    expand(ctx, decoded) {
      if (!decoded) {
        throw new Error('Expected decoded signature.');
      }
      const left = decoded.args.left ?? ctx.error('missing left');
      const right = decoded.args.right ?? ctx.error('missing right');
      return ctx.output.expr(
        ctx.quote.expr`${left.text()} + ${right.text()}`,
      );
    },
    signature,
  }, 'Foo');

  const expansion = expand(resolved);
  assert(expansion);
  assertEquals(expansion.kind, 'expr');
  if (expansion.kind !== 'expr') {
    return;
  }

  const sourceFile = ts.createSourceFile('/virtual/test.ts', '', ts.ScriptTarget.Latest, true);
  assertEquals(
    ts.createPrinter().printNode(ts.EmitHint.Expression, expansion.node, sourceFile),
    'left + right',
  );
});

Deno.test('createExpandMacroPlaceholderFromDefinition validates refined array-literal operands', () => {
  const resolved = createResolvedPlaceholder('const value = Foo([left, right]);\n');
  const expand = createExpandMacroPlaceholderFromDefinition({
    expand(ctx, decoded) {
      if (!decoded) {
        throw new Error('Expected decoded signature.');
      }
      const itemsValue = decoded.args.items ?? ctx.error('missing items');
      if (itemsValue.kind !== 'expr') {
        ctx.error('missing items');
      }
      const items = itemsValue.asArrayLiteral() ?? ctx.error('missing items');
      return ctx.output.expr(items);
    },
    signature: macroSignature.of(macroSignature.arrayLiteral('items')),
  }, 'Foo');

  const expansion = expand(resolved);
  assert(expansion);
  assertEquals(expansion.kind, 'expr');
  if (expansion.kind !== 'expr') {
    return;
  }

  const sourceFile = ts.createSourceFile('/virtual/test.ts', '', ts.ScriptTarget.Latest, true);
  assertEquals(
    ts.createPrinter().printNode(ts.EmitHint.Expression, expansion.node, sourceFile),
    '[left, right]',
  );
});

Deno.test('createExpandMacroPlaceholderFromDefinition rejects operands that fail refined signature validation', () => {
  const resolved = createResolvedPlaceholder('const value = Foo(left);\n');
  const expand = createExpandMacroPlaceholderFromDefinition({
    expand(ctx, decoded) {
      if (!decoded) {
        throw new Error('Expected decoded signature.');
      }
      const itemsValue = decoded.args.items ?? ctx.error('missing items');
      if (itemsValue.kind !== 'expr') {
        ctx.error('missing items');
      }
      const items = itemsValue.asArrayLiteral() ?? ctx.error('missing items');
      return ctx.output.expr(items);
    },
    signature: macroSignature.of(macroSignature.arrayLiteral('items')),
  }, 'Foo');

  let error: unknown;
  try {
    expand(resolved);
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(error.message, 'Foo only supports: Foo([ ... ]).');
});

Deno.test('createExpandMacroPlaceholderFromDefinition runs custom signature validators', () => {
  const resolved = createResolvedPlaceholder('const value = Foo(null);\n');
  const expand = createExpandMacroPlaceholderFromDefinition({
    expand(ctx, decoded) {
      if (!decoded) {
        throw new Error('Expected decoded signature.');
      }
      const value = decoded.args.value ?? ctx.error('missing value');
      if (value.kind !== 'expr') {
        ctx.error('missing value');
      }
      return ctx.output.expr(value);
    },
    signature: macroSignature.refine(
      macroSignature.of(macroSignature.expr('value')),
      (ctx, decoded) => {
        if (decoded.args.value.isNullLiteral()) {
          ctx.error('Foo does not accept null.');
        }
      },
    ),
  }, 'Foo');

  let error: unknown;
  try {
    expand(resolved);
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(error.message, 'Foo does not accept null.');
});

Deno.test('createExpandMacroPlaceholderFromDefinition rejects malformed expression and statement fragments', () => {
  const exprResolved = createResolvedPlaceholder('const value = Foo(bar);\n');
  let error: unknown;
  try {
    createExpandMacroPlaceholderFromDefinition(exprMacro('1); sideEffect(); (2'), 'Foo')(exprResolved);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof MacroError);
  assertEquals(
    error.message,
    'Macro expression operands must parse as exactly one host-language expression.',
  );

  const stmtResolved = createResolvedPlaceholder('Foo(() => { body(); });\n');
  error = undefined;
  try {
    createExpandMacroPlaceholderFromDefinition(stmtMacro('first(); second();'), 'Foo')(stmtResolved);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof MacroError);
  assertEquals(
    error.message,
    'Quoted macro statements must parse as exactly one host-language statement.',
  );
});

Deno.test('createExpandMacroPlaceholderFromDefinition respects TSX host file kind for emitted expressions', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { Foo } from 'macros/test';",
      'const view = Foo(value);',
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: new Map([
      ['macros/test', new Map([['Foo', 'call' as const]])],
    ]),
  });
  const [collected] = collectResolvedMacroPlaceholders(preparedProgram);

  assert(collected);
  const expand = createExpandMacroPlaceholderFromDefinition(exprMacro('<Foo />'), 'Foo');

  const expansion = expand(collected.resolved);
  assert(expansion);
  assertEquals(expansion.kind, 'expr');
  if (expansion.kind !== 'expr') {
    return;
  }

  const sourceFile = ts.createSourceFile(
    '/virtual/test.tsx',
    '',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  assertEquals(
    ts.createPrinter().printNode(ts.EmitHint.Expression, expansion.node, sourceFile),
    '<Foo />',
  );
});

Deno.test('createExpandMacroPlaceholderFromDefinition preserves the original declaration in augment mode', () => {
  const resolved = createResolvedDeclarationPlaceholder([
    '// #[component]',
    'export class Counter {}',
    '',
  ].join('\n'));
  const expand = createExpandMacroPlaceholderFromDefinition({
    declarationKinds: ['class'],
    expansionMode: 'augment',
    expand(ctx) {
      return ctx.output.stmt(ctx.quote.stmt`export const mounted = true;`);
    },
    signature: macroSignature.of(macroSignature.classDecl('component')),
  }, 'component');

  const expansion = expand(resolved);
  assert(expansion);
  assertEquals(expansion.kind, 'stmt');
  if (expansion.kind !== 'stmt') {
    return;
  }

  const sourceFile = ts.createSourceFile('/virtual/test.ts', '', ts.ScriptTarget.Latest, true);
  assertEquals(
    expansion.nodes.map((node) =>
      ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, sourceFile)
    ),
    ['export class Counter {\n}', 'export const mounted = true;'],
  );
});

Deno.test('createExpandMacroPlaceholderFromDefinition rejects duplicate primary names in augment mode', () => {
  const resolved = createResolvedDeclarationPlaceholder([
    '// #[component]',
    'export class Counter {}',
    '',
  ].join('\n'));
  const expand = createExpandMacroPlaceholderFromDefinition({
    declarationKinds: ['class'],
    expansionMode: 'augment',
    expand(ctx) {
      return ctx.output.stmt(ctx.quote.stmt`export const Counter = true;`);
    },
    signature: macroSignature.of(macroSignature.classDecl('component')),
  }, 'component');

  let error: unknown;
  try {
    expand(resolved);
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(
    error.message,
    'component declaration macros with expansionMode "augment" cannot emit a declaration named "Counter" because the original declaration is preserved.',
  );
});
