import { assert, assertEquals } from '@std/assert';

import type {
  BlockSyntax,
  ExprSyntax,
  MacroArrayLiteralExprSyntax,
  MacroClassDeclSyntax,
  MacroDefinition,
  MacroTypeAliasDeclSyntax,
} from './macro_api.ts';
import { formatMacroSignature, formatMacroSignatureExamples, macroSignature } from './macro_api.ts';

function expectType<T>(_value: T): void {}

Deno.test('macro descriptor objects preserve typed signature metadata without defineMacro', () => {
  const signature = macroSignature.oneOf(
    macroSignature.case('expr', macroSignature.expr('value')),
    macroSignature.case('block', macroSignature.block('body')),
  );

  const macro: MacroDefinition<typeof signature> = {
    expand(ctx, decoded) {
      if (decoded.caseName === 'expr') {
        expectType<ExprSyntax>(decoded.args.value);
        return ctx.output.expr(decoded.args.value);
      }

      expectType<BlockSyntax>(decoded.args.body);
      return ctx.output.expr(ctx.quote.expr`(() => ${decoded.args.body})()`);
    },
    signature,
  };

  assertEquals(macro.signature, signature);
});

Deno.test('declaration macros can narrow supported declaration kinds on the returned descriptor', () => {
  const signature = macroSignature.of(macroSignature.classDecl('component'));

  const macro: MacroDefinition<typeof signature> = {
    declarationKinds: ['class'],
    expand(ctx, decoded) {
      expectType<MacroClassDeclSyntax>(decoded.args.component);
      expectType<ExprSyntax>(ctx.build.identifier(decoded.args.component.name ?? 'Example'));
      return ctx.output.stmt(decoded.args.component);
    },
    signature,
  };

  assertEquals(macro.declarationKinds, ['class']);
});

Deno.test('type alias declaration macros can narrow supported declaration kinds on the returned descriptor', () => {
  const signature = macroSignature.of(macroSignature.typeAliasDecl('target'));

  const macro: MacroDefinition<typeof signature> = {
    declarationKinds: ['typeAlias'],
    expand(ctx, decoded) {
      expectType<MacroTypeAliasDeclSyntax>(decoded.args.target);
      return ctx.output.stmt(decoded.args.target);
    },
    signature,
  };

  assertEquals(macro.declarationKinds, ['typeAlias']);
});

Deno.test('declaration macros can opt into augment expansion mode on the returned descriptor', () => {
  const signature = macroSignature.of(macroSignature.classDecl('component'));

  const macro: MacroDefinition<typeof signature> = {
    declarationKinds: ['class'],
    expansionMode: 'augment',
    expand(ctx, decoded) {
      expectType<MacroClassDeclSyntax>(decoded.args.component);
      return ctx.output.stmt(ctx.build.constDecl('mounted', ctx.build.booleanLiteral(true)));
    },
    signature,
  };

  assertEquals(macro.expansionMode, 'augment');
});

Deno.test('macro signature formatting keeps parseable canonical examples', () => {
  assertEquals(
    formatMacroSignatureExamples(
      macroSignature.of(
        macroSignature.expr('value'),
        macroSignature.block('body'),
      ),
      'foo',
    ),
    ['foo(<value>, () => { ... })'],
  );
  assertEquals(
    formatMacroSignatureExamples(
      macroSignature.of(
        macroSignature.expr('trait'),
        macroSignature.decl('target'),
      ),
      'derive',
    ),
    ['derive(<trait>) <declaration>'],
  );
});

Deno.test('macro signature formatting enumerates optional variants', () => {
  const signature = macroSignature.of(
    macroSignature.optional(macroSignature.expr('message')),
  );

  assertEquals(formatMacroSignatureExamples(signature, 'todo'), ['todo(<message>)']);
  assertEquals(formatMacroSignature(signature, 'todo'), 'todo(); todo(<message>)');
});

Deno.test('macro signature builders keep refined operand types', () => {
  const signature = macroSignature.oneOf(
    macroSignature.case('items', macroSignature.arrayLiteral('items')),
    macroSignature.case('component', macroSignature.classDecl('component')),
  );

  const macro: MacroDefinition<typeof signature> = {
    expand(ctx, decoded) {
      if (decoded.caseName === 'items') {
        expectType<MacroArrayLiteralExprSyntax>(decoded.args.items);
        return ctx.output.expr(decoded.args.items);
      }

      expectType<MacroClassDeclSyntax>(decoded.args.component);
      return ctx.output.expr(ctx.quote.expr`${decoded.args.component.name}`);
    },
    signature,
  };

  assertEquals(macro.signature, signature);
});

Deno.test('shipped macros no longer depend on removed text-first macro helpers', () => {
  const bannedNeedles = [
    'argText(',
    'argTexts(',
    'exprText(',
    'blockText(',
    'declarationText(',
    'templateArg(',
    'emitExpr(',
    'emitStmt(',
    'emitStmtList(',
    'primaryExprExpandedText(',
    'primaryExprPreludeTexts(',
    "import ts from 'typescript';",
    'getHostExpression(',
    'getHostNode(',
    'getHostDeclaration(',
    'getHostBlock(',
    'getHostJsx(',
    'createExprSyntaxFromNode(',
    'parseHostExpression(',
  ];
  const macroFiles = [
    'builtin_macros.ts',
    '../../test-fixtures/packages/test-macro-package/src/index.macro.sts',
    'css_macro.ts',
    'graphql_macro.ts',
    'match_macro.ts',
    'sql_macro.ts',
  ];

  const violations: string[] = [];
  for (const fileName of macroFiles) {
    const fileUrl = new URL(fileName, import.meta.url);
    const source = Deno.readTextFileSync(fileUrl);
    for (const needle of bannedNeedles) {
      if (source.includes(needle)) {
        violations.push(`${fileName}: ${needle}`);
      }
    }
  }

  assertEquals(violations, []);
});

Deno.test('public macro declaration entrypoint stays declarations-only and no longer exports defineMacro', () => {
  const publicEntry = Deno.readTextFileSync(new URL('../macros.d.ts', import.meta.url));
  const publicApiTypes = Deno.readTextFileSync(
    new URL('../public_macro_api/macro_api.d.ts', import.meta.url),
  );
  const nonDeclarationTsImportPattern = /from ['"][^'"]+(?<!\.d)\.ts['"]/;

  assert(publicEntry.includes('./public_macro_api/macro_api'));
  assert(!nonDeclarationTsImportPattern.test(publicEntry));
  assert(!nonDeclarationTsImportPattern.test(publicApiTypes));
  assert(!/from ['"]typescript['"]/.test(publicApiTypes));
  assert(!publicApiTypes.includes('defineMacro('));
});
