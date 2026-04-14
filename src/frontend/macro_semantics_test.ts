import { assert, assertEquals } from '@std/assert';
import ts from 'typescript';

import { collectResolvedMacroPlaceholders } from './macro_resolver.ts';
import { createMacroSemantics } from './macro_semantics.ts';
import { createPreparedProgramForMacroTest } from './macro_test_helpers.ts';

const TEST_USER_MACRO_SITE_KINDS = new Map([
  [
    'macros/test',
    new Map([
      ['Foo', 'call' as const],
      ['Bar', 'call' as const],
    ]),
  ],
]);

function findVariableDeclaration(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration {
  let found: ts.VariableDeclaration | undefined;

  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      found = node;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (!found) {
    throw new Error(`Expected variable declaration "${name}".`);
  }

  return found;
}

function findFunctionDeclaration(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (!found) {
    throw new Error(`Expected function declaration "${name}".`);
  }

  return found;
}

function findTypeAliasDeclaration(sourceFile: ts.SourceFile, name: string): ts.TypeAliasDeclaration {
  let found: ts.TypeAliasDeclaration | undefined;

  function visit(node: ts.Node) {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) {
      found = node;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (!found) {
    throw new Error(`Expected type alias declaration "${name}".`);
  }

  return found;
}

Deno.test('createMacroSemantics exposes enclosing function metadata for resolved macro sites', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { Bar, Foo } from 'macros/test';",
      '',
      "type Result<Ok, Err> = { tag: 'ok'; value: Ok } | { tag: 'err'; error: Err };",
      '',
      'function compute(flag: boolean): Result<number, string> {',
      '  const value = Foo(flag ? 1 : 2);',
      "  return { tag: 'ok', value };",
      '}',
      '',
      'async function load(): Promise<Result<number, string>> {',
      '  const value = Bar(1);',
      "  return { tag: 'ok', value };",
      '}',
      '',
    ].join('\n'),
  }, {
    importedMacroSiteKindsBySpecifier: TEST_USER_MACRO_SITE_KINDS,
  });

  const semantics = createMacroSemantics(preparedProgram.program);
  const resolved = collectResolvedMacroPlaceholders(preparedProgram);

  assertEquals(resolved.length, 2);

  const computeContext = semantics.enclosingFunctionOfNode(resolved[0]!.resolved.callExpression);
  const loadContext = semantics.enclosingFunctionOfNode(resolved[1]!.resolved.callExpression);

  assert(computeContext);
  assert(loadContext);
  assertEquals(computeContext.fileName, fileName);
  assertEquals(computeContext.isAsync, false);
  assertEquals(computeContext.isGenerator, false);
  assertEquals(computeContext.name, 'compute');
  assertEquals(computeContext.returnType.displayText, 'Result<number, string>');
  assertEquals(loadContext.isAsync, true);
  assertEquals(loadContext.isGenerator, false);
  assertEquals(loadContext.name, 'load');
  assertEquals(loadContext.returnType.displayText, 'Promise<Result<number, string>>');
});

Deno.test('createMacroSemantics exposes frontend-owned type handles and assignability checks', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      'function compute(value: string): string | number {',
      '  const wide: string | number = value;',
      "  const narrow: string = 'x';",
      '  return wide;',
      '}',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const wide = findVariableDeclaration(sourceFile, 'wide');
  const narrow = findVariableDeclaration(sourceFile, 'narrow');
  const wideType = semantics.typeOfNode(wide.name);
  const narrowType = semantics.typeOfNode(narrow.name);

  assertEquals(wideType.displayText, 'string | number');
  assertEquals(narrowType.displayText, 'string');
  assertEquals(semantics.isAssignable(narrowType, wideType), true);
  assertEquals(semantics.isAssignable(wideType, narrowType), false);
});

Deno.test('createMacroSemantics can query value bindings in scope at declaration sites', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      'type User = { id: string };',
      'const UserEq = { equals(left: User, right: User) { return left.id === right.id; } };',
      'type Group = { owner: User };',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const group = findTypeAliasDeclaration(sourceFile, 'Group');

  assertEquals(semantics.valueBindingInScope('UserEq', group), true);
  assertEquals(semantics.valueBindingInScope('UserCodec', group), false);
  assertEquals(semantics.valueBindingInScope('User', group), false);
});

Deno.test('createMacroSemantics can query dotted value helpers and callability in scope', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      'class User {',
      '  static fromJson(value: { id: string }) {',
      '    return new User();',
      '  }',
      '  static label = "user";',
      '}',
      'type Group = { owner: User };',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const group = findTypeAliasDeclaration(sourceFile, 'Group');

  assertEquals(semantics.valueBindingInScope('User.fromJson', group), true);
  assertEquals(semantics.valueBindingInScope('User.missing', group), false);
  assertEquals(semantics.valueBindingCallableInScope('User.fromJson', group), true);
  assertEquals(semantics.valueBindingCallableInScope('User.label', group), false);
  assertEquals(semantics.valueBindingCallableInScope('User.missing', group), false);
});

Deno.test('createMacroSemantics can detect promise-like value helpers in scope', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      'declare function normalizeUser(value: User): Promise<User>;',
      'declare function normalizeSync(value: User): User;',
      'declare const promisedLabel: Promise<string>;',
      'class User {',
      '  static async fromJson(value: { id: string }): Promise<User> {',
      '    return new User();',
      '  }',
      '  static label = "user";',
      '}',
      'type Group = { owner: User };',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const group = findTypeAliasDeclaration(sourceFile, 'Group');

  assertEquals(semantics.valueBindingPromiseLikeInScope('normalizeUser', group), true);
  assertEquals(semantics.valueBindingPromiseLikeInScope('normalizeSync', group), false);
  assertEquals(semantics.valueBindingPromiseLikeInScope('promisedLabel', group), true);
  assertEquals(semantics.valueBindingPromiseLikeInScope('User.fromJson', group), true);
  assertEquals(semantics.valueBindingPromiseLikeInScope('User.label', group), false);
  assertEquals(semantics.valueBindingPromiseLikeInScope('User.missing', group), false);
});

Deno.test('createMacroSemantics can query value binding types in scope', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { lazy as decodeLazy, string } from 'sts:decode';",
      'const StringDecoderRef = decodeLazy(() => string);',
      'type Wrapper = { value: string };',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const wrapper = findTypeAliasDeclaration(sourceFile, 'Wrapper');
  const helperType = semantics.valueBindingTypeInScope('StringDecoderRef', wrapper);

  assert(helperType);
  assert(helperType.displayText.length > 0);
});

Deno.test('createMacroSemantics prefers runtime-kind finite cases for primitive and function unions', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      'const value: string | number | undefined | (() => void) = Math.random() > 0.5 ? "x" : 1;',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const value = findVariableDeclaration(sourceFile, 'value');
  const finiteCases = semantics.finiteCases(semantics.typeOfNode(value.name));

  assertEquals(finiteCases, [
    { kind: 'runtime', typeName: 'undefined' },
    { kind: 'runtime', typeName: 'string' },
    { kind: 'runtime', typeName: 'number' },
    { kind: 'runtime', typeName: 'function' },
  ]);
});

Deno.test('createMacroSemantics classifies canonical sts:result Result types', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { type Result as ControlResult, ok } from 'sts:result';",
      "type Result<Ok, Err> = { tag: 'ok'; value: Ok } | { tag: 'err'; error: Err };",
      '',
      'function compute(): ControlResult<number, string> {',
      '  return ok(1);',
      '}',
      '',
      'function notCanonical(): Result<number, string> {',
      "  return { tag: 'ok', value: 1 };",
      '}',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const compute = findFunctionDeclaration(sourceFile, 'compute');
  const notCanonical = findFunctionDeclaration(sourceFile, 'notCanonical');
  const resultType = semantics.typeOfNode(compute.type!);
  const lookalikeType = semantics.typeOfNode(notCanonical.type!);
  const resultInfo = semantics.classifyCanonicalResultType(resultType);
  const lookalikeInfo = semantics.classifyCanonicalResultType(lookalikeType);

  assert(resultInfo);
  assertEquals(resultInfo.resultType.displayText, 'Result<number, string>');
  assertEquals(resultInfo.okType.displayText, 'number');
  assertEquals(resultInfo.errType.displayText, 'string');
  assertEquals(lookalikeInfo, null);
});

Deno.test('createMacroSemantics classifies canonical sts:prelude Result types', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { type Result as ControlResult, ok } from 'sts:prelude';",
      '',
      'function compute(): ControlResult<number, string> {',
      '  return ok(1);',
      '}',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const compute = findFunctionDeclaration(sourceFile, 'compute');
  const resultType = semantics.typeOfNode(compute.type!);
  const resultInfo = semantics.classifyCanonicalResultType(resultType);

  assert(resultInfo);
  assertEquals(resultInfo.family, 'result');
  assertEquals(resultInfo.okType.displayText, 'number');
  assertEquals(resultInfo.errType.displayText, 'string');
});

Deno.test('createMacroSemantics classifies local aliases to canonical Result types', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { type Result, ok } from 'sts:prelude';",
      'type LocalResult<Ok> = Result<Ok, string>;',
      '',
      'function compute(): LocalResult<number> {',
      '  return ok(1);',
      '}',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const compute = findFunctionDeclaration(sourceFile, 'compute');
  const resultType = semantics.typeOfNode(compute.type!);
  const resultInfo = semantics.classifyCanonicalResultType(resultType);

  assert(resultInfo);
  assertEquals(resultInfo.family, 'result');
  assertEquals(resultInfo.okType.displayText, 'number');
  assertEquals(resultInfo.errType.displayText, 'string');
});

Deno.test('createMacroSemantics instantiates nested local Result alias type arguments', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { type Result, ok } from 'sts:prelude';",
      'type LocalResult<T> = Result<readonly T[], string>;',
      '',
      'function compute(): LocalResult<number> {',
      '  return ok([1]);',
      '}',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const compute = findFunctionDeclaration(sourceFile, 'compute');
  const resultType = semantics.typeOfNode(compute.type!);
  const resultInfo = semantics.classifyCanonicalResultType(resultType);

  assert(resultInfo);
  assertEquals(resultInfo.family, 'result');
  assertEquals(resultInfo.okType.displayText, 'readonly number[]');
  assertEquals(resultInfo.errType.displayText, 'string');
});

Deno.test('createMacroSemantics classifies Promise<Result<...>> carriers for async flows', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { type Result, ok } from 'sts:result';",
      'declare function fetchAsync(): Promise<Result<number, string>>;',
      '',
      'async function load(): Promise<Result<number, string>> {',
      '  const value = fetchAsync();',
      '  return ok(1);',
      '}',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const value = findVariableDeclaration(sourceFile, 'value');
  const valueType = semantics.typeOfNode(value.name);
  const carrier = semantics.classifyCanonicalResultCarrierType(valueType);

  assert(carrier);
  assertEquals(carrier.requiresAwait, true);
  assertEquals(carrier.resultType.displayText, 'Result<number, string>');
  assertEquals(carrier.okType.displayText, 'number');
  assertEquals(carrier.errType.displayText, 'string');
});

Deno.test('createMacroSemantics classifies local aliases of canonical Result carriers', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import type { Result } from 'sts:result';",
      'type DomainResult<T> = Result<T, string>;',
      '',
      'declare const resultValue: Promise<DomainResult<number>>;',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const resultValue = findVariableDeclaration(sourceFile, 'resultValue');
  const resultType = semantics.typeOfNode(resultValue.name);
  const resultInfo = semantics.classifyCanonicalResultCarrierType(resultType);

  assert(resultInfo);
  assertEquals(resultInfo.requiresAwait, true);
  assertEquals(resultInfo.family, 'result');
  assertEquals(resultInfo.okType.displayText, 'number');
  assertEquals(resultInfo.errType.displayText, 'string');
});

Deno.test('createMacroSemantics classifies canonical sts:failures Failure types', () => {
  const fileName = '/virtual/index.ts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { Failure } from 'sts:failures';",
      '',
      'class LoadError extends Failure {',
      '  constructor(readonly path: string) {',
      "    super('missing file');",
      '  }',
      '}',
      '',
      'class PlainError {',
      '  constructor(readonly path: string) {}',
      '}',
      '',
      'function load(): LoadError {',
      "  return new LoadError('/tmp/file');",
      '}',
      '',
      'function plain(): PlainError {',
      "  return new PlainError('/tmp/file');",
      '}',
      '',
    ].join('\n'),
  });

  const sourceFile = preparedProgram.program.getSourceFile(fileName);
  assert(sourceFile);

  const semantics = createMacroSemantics(preparedProgram.program);
  const load = findFunctionDeclaration(sourceFile, 'load');
  const plain = findFunctionDeclaration(sourceFile, 'plain');
  const failureType = semantics.typeOfNode(load.type!);
  const plainType = semantics.typeOfNode(plain.type!);

  assert(semantics.classifyCanonicalFailureType(failureType));
  assertEquals(semantics.classifyCanonicalFailureType(plainType), null);
});
