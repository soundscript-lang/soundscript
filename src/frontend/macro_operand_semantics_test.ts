import { assert, assertEquals } from '@std/assert';

import { collectResolvedMacroPlaceholders } from './macro_resolver.ts';
import {
  classifyCanonicalResultOfPrimaryExprOperand,
  resolveExpressionNodeAtSourcePosition,
  resolvePrimaryExprOperand,
  typeOfPrimaryExprOperand,
} from './macro_operand_semantics.ts';
import { createPreparedProgramForMacroTest } from './macro_test_helpers.ts';

const TEST_IMPORTS = [
  "import { Foo, Inner, Outer, main } from 'macros/test';",
  "import { Match, where } from 'sts:match';",
  '',
].join('\n');

const TEST_USER_MACRO_SITE_KINDS = new Map([
  [
    'macros/test',
    new Map([
      ['Foo', 'call' as const],
      ['Inner', 'call' as const],
      ['Outer', 'call' as const],
      ['main', 'annotation' as const],
    ]),
  ],
]);

function prepareMacroTest(
  fileName: string,
  sourceBody: string,
  macroName = 'Foo',
) {
  const fullSource = `${TEST_IMPORTS}${sourceBody}`;
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: fullSource,
  }, {
    importedMacroSiteKindsBySpecifier: TEST_USER_MACRO_SITE_KINDS,
  });
  const resolved = collectResolvedMacroPlaceholders(preparedProgram)
    .find((entry) => entry.resolved.placeholder.invocation.nameText === macroName);

  assert(resolved);
  return {
    fullSource,
    preparedProgram,
    resolved: resolved.resolved,
  };
}

Deno.test('typeOfPrimaryExprOperand uses the original operand instead of the placeholder helper call', () => {
  const fileName = '/virtual/index.sts';
  const { preparedProgram, resolved } = prepareMacroTest(
    fileName,
    [
      "type Result<Ok, Err> = { tag: 'ok'; value: Ok } | { tag: 'err'; error: Err };",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  const value = Foo(fetchValue());',
      "  return { tag: 'ok', value };",
      '}',
      '',
    ].join('\n'),
  );

  const operandType = typeOfPrimaryExprOperand(preparedProgram, resolved);

  assert(operandType);
  assertEquals(operandType.displayText, 'Result<number, string>');
});

Deno.test('resolvePrimaryExprOperand returns the patched operand node in expr-form macros', () => {
  const fileName = '/virtual/index.sts';
  const { preparedProgram, resolved } = prepareMacroTest(
    fileName,
    [
      'declare const input: number;',
      'function compute(): number {',
      '  const value = Foo(input + 1);',
      '  return value;',
      '}',
      '',
    ].join('\n'),
  );

  const operand = resolvePrimaryExprOperand(preparedProgram, resolved);

  assert(operand);
  assertEquals(operand.node.getText(operand.sourceFile), 'input + 1');
});

Deno.test('resolvePrimaryExprOperand returns the patched operand node for ternary-arm expr macros', () => {
  const fileName = '/virtual/index.sts';
  const { preparedProgram, resolved } = prepareMacroTest(
    fileName,
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute(flag: boolean): Result<number, string> {',
      '  const value = flag ? Foo(fetchValue()) : 1;',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
  );

  const operand = resolvePrimaryExprOperand(preparedProgram, resolved);

  assert(operand);
  assertEquals(operand.node.getText(operand.sourceFile), 'fetchValue()');
});

Deno.test('resolvePrimaryExprOperand returns the patched operand node for .sts expr macros', () => {
  const fileName = '/virtual/index.sts';
  const { preparedProgram, resolved } = prepareMacroTest(
    fileName,
    [
      'declare const input: number;',
      'function compute(): number {',
      '  const value = Foo(input + 1);',
      '  return value;',
      '}',
      '',
    ].join('\n'),
  );

  const operand = resolvePrimaryExprOperand(preparedProgram, resolved);

  assert(operand);
  assertEquals(operand.node.getText(operand.sourceFile), 'input + 1');
});

Deno.test('resolvePrimaryExprOperand reuses one patched source file for multiple simple expr macros in a file', () => {
  const fileName = '/virtual/index.sts';
  const fullSource = `${TEST_IMPORTS}${
    [
      'declare const left: number;',
      'declare const right: number;',
      'const a = Foo(left + 1);',
      'const b = Foo(right + 2);',
      '',
    ].join('\n')
  }`;
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: fullSource,
  }, {
    importedMacroSiteKindsBySpecifier: TEST_USER_MACRO_SITE_KINDS,
  });
  const resolved = collectResolvedMacroPlaceholders(preparedProgram)
    .filter((entry) => entry.resolved.placeholder.invocation.nameText === 'Foo')
    .map((entry) => entry.resolved);

  assertEquals(resolved.length, 2);

  const firstOperand = resolvePrimaryExprOperand(preparedProgram, resolved[0]!);
  const secondOperand = resolvePrimaryExprOperand(preparedProgram, resolved[1]!);

  assert(firstOperand);
  assert(secondOperand);
  assert(firstOperand.sourceFile === secondOperand.sourceFile);
  assertEquals(firstOperand.node.getText(firstOperand.sourceFile), 'left + 1');
  assertEquals(secondOperand.node.getText(secondOperand.sourceFile), 'right + 2');
});

Deno.test('classifyCanonicalResultOfPrimaryExprOperand classifies the patched operand type', () => {
  const fileName = '/virtual/index.sts';
  const { preparedProgram, resolved } = prepareMacroTest(
    fileName,
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  const value = Foo(fetchValue());',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
  );

  const resultInfo = classifyCanonicalResultOfPrimaryExprOperand(preparedProgram, resolved);

  assert(resultInfo);
  assertEquals(resultInfo.okType.displayText, 'number');
  assertEquals(resultInfo.errType.displayText, 'string');
});

Deno.test('typeOfPrimaryExprOperand returns null for declaration annotation macros', () => {
  const fileName = '/virtual/index.sts';
  const { preparedProgram, resolved } = prepareMacroTest(
    fileName,
    [
      '// #[main]',
      'class User {}',
      '',
    ].join('\n'),
    'main',
  );

  const operandType = typeOfPrimaryExprOperand(preparedProgram, resolved);

  assertEquals(operandType, null);
});

Deno.test('resolveExpressionNodeAtSourcePosition resolves nested expression macros for .sts files', () => {
  const fileName = '/virtual/index.sts';
  const { fullSource, preparedProgram, resolved } = prepareMacroTest(
    fileName,
    [
      'declare const source: number;',
      'const value = Outer(Inner(source));',
      '',
    ].join('\n'),
    'Outer',
  );

  const sourcePosition = fullSource.lastIndexOf('source');
  const expressionNode = resolveExpressionNodeAtSourcePosition(
    preparedProgram,
    resolved,
    sourcePosition,
  );

  assert(expressionNode);
  if ('kind' in expressionNode) {
    throw new Error('Expected a resolved expression node, not a macro hover target.');
  }
  assertEquals(expressionNode.node.getText(expressionNode.sourceFile), 'source');
  assertEquals(expressionNode.semantics.typeOfNode(expressionNode.node).displayText, 'number');
});

Deno.test('resolveExpressionNodeAtSourcePosition resolves typed bindings inside Match array-arm bodies', () => {
  const fileName = '/virtual/index.sts';
  const { fullSource, preparedProgram, resolved } = prepareMacroTest(
    fileName,
    [
      "type Ok = { tag: 'ok'; value: number };",
      "type Err = { tag: 'err'; error: string };",
      'declare const value: Ok | Err;',
      'const result = Match(value, [',
      '  ({ value }: Ok) => value + 1,',
      '  ({ error }: Err) => error.length,',
      ']);',
      '',
    ].join('\n'),
    'Match',
  );

  const sourcePosition = fullSource.indexOf('value + 1');
  const expressionNode = resolveExpressionNodeAtSourcePosition(
    preparedProgram,
    resolved,
    sourcePosition,
  );

  assert(expressionNode);
  if ('kind' in expressionNode) {
    throw new Error('Expected a resolved expression node, not a macro hover target.');
  }
  assertEquals(expressionNode.node.getText(expressionNode.sourceFile), 'value');
  assertEquals(expressionNode.semantics.typeOfNode(expressionNode.node).displayText, 'number');
});

Deno.test('resolveExpressionNodeAtSourcePosition resolves typed bindings inside where predicates', () => {
  const fileName = '/virtual/index.sts';
  const { fullSource, preparedProgram, resolved } = prepareMacroTest(
    fileName,
    [
      "type Ok = { tag: 'ok'; value: number };",
      'declare const value: Ok | undefined;',
      'const result = Match(value, [',
      '  where(({ value }: Ok) => value, ({ value }) => value > 2),',
      '  (_) => 0,',
      ']);',
      '',
    ].join('\n'),
    'Match',
  );

  const sourcePosition = fullSource.indexOf('value > 2');
  const expressionNode = resolveExpressionNodeAtSourcePosition(
    preparedProgram,
    resolved,
    sourcePosition,
  );

  assert(expressionNode);
  if ('kind' in expressionNode) {
    throw new Error('Expected a resolved expression node, not a macro hover target.');
  }
  assertEquals(expressionNode.node.getText(expressionNode.sourceFile), 'value');
  assertEquals(expressionNode.semantics.typeOfNode(expressionNode.node).displayText, 'number');
});
