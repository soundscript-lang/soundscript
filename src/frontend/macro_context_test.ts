import { assert, assertEquals } from '@std/assert';

import { normalizeRuntimeContext } from '../config.ts';
import { createAdvancedMacroContext } from './macro_advanced_context.ts';
import { createMacroContext } from './macro_context.ts';
import { MacroError } from './macro_errors.ts';
import { collectResolvedMacroPlaceholders } from './macro_resolver.ts';
import { createPreparedProgramForMacroTest } from './macro_test_helpers.ts';

const TEST_IMPORTS = [
  "import { Foo, Bar, Baz, component, derive } from 'macros/test';",
  "import { hkt } from 'macros/test';",
  "import { codec, decode, encode, eq, hash, tagged } from 'sts:derive';",
  "import { Match, where } from 'sts:match';",
  "import { sql } from 'sts:experimental/sql';",
  '',
].join('\n');

const TEST_USER_MACRO_SITE_KINDS = new Map([
  [
    'macros/test',
    new Map([
      ['Foo', 'call' as const],
      ['Bar', 'call' as const],
      ['Baz', 'call' as const],
      ['component', 'annotation' as const],
      ['derive', 'annotation' as const],
      ['hkt', 'annotation' as const],
    ]),
  ],
  [
    'sts:derive',
    new Map([
      ['decode', 'annotation' as const],
      ['encode', 'annotation' as const],
      ['eq', 'annotation' as const],
      ['hash', 'annotation' as const],
      ['codec', 'annotation' as const],
      ['tagged', 'annotation' as const],
    ]),
  ],
]);

function withImports(sourceBody: string): string {
  return `${TEST_IMPORTS}${sourceBody}`;
}

function createContext(
  sourceBody: string,
  macroName = 'Foo',
) {
  return createContextInFile('/virtual/index.sts', sourceBody, macroName);
}

function createContextInFile(
  fileName: string,
  sourceBody: string,
  macroName = 'Foo',
) {
  const fullSource = withImports(sourceBody);
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: fullSource,
  }, {
    importedMacroSiteKindsBySpecifier: TEST_USER_MACRO_SITE_KINDS,
  });
  const resolved = collectResolvedMacroPlaceholders(preparedProgram)
    .find((entry) => entry.resolved.placeholder.invocation.nameText === macroName);

  assert(resolved);
  return {
    context: createMacroContext(resolved.resolved),
    fullSource,
    preparedProgram,
    resolved: resolved.resolved,
  };
}

function createAdvancedContext(
  sourceBody: string,
  macroName = 'Foo',
) {
  return createAdvancedContextInFile('/virtual/index.sts', sourceBody, macroName);
}

function createAdvancedContextInFile(
  fileName: string,
  sourceBody: string,
  macroName = 'Foo',
) {
  const fullSource = withImports(sourceBody);
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: fullSource,
  }, {
    importedMacroSiteKindsBySpecifier: TEST_USER_MACRO_SITE_KINDS,
  });
  const resolved = collectResolvedMacroPlaceholders(preparedProgram)
    .find((entry) => entry.resolved.placeholder.invocation.nameText === macroName);

  assert(resolved);
  return {
    context: createAdvancedMacroContext(preparedProgram, resolved.resolved),
    fullSource,
    preparedProgram,
    resolved: resolved.resolved,
  };
}

function lineColumnAt(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < position; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

Deno.test('createMacroContext exposes normalized call-macro arglist accessors', () => {
  const { context, fullSource } = createContext('const value = Foo(bar + baz);\n');

  assertEquals(context.name, 'Foo');
  assertEquals(context.kind, 'expr');
  assertEquals(context.invocation.form, 'arglist');
  assertEquals(context.invocation.name, 'Foo');
  assertEquals(context.sourceText(), 'Foo(bar + baz)');
  assertEquals(context.syntax.primaryExpr().text(), 'bar + baz');
  assertEquals(context.syntax.arg(0).text(), 'bar + baz');
  assertEquals(context.syntax.args().map((argument) => argument.text()), ['bar + baz']);
  assertEquals(context.hasBlock(), false);
  assertEquals(context.invocation.args.map((argument) => argument.text()), ['bar + baz']);
  const invocationSpan = context.invocationSpan();
  assertEquals(
    fullSource.slice(invocationSpan.start, invocationSpan.end),
    'Foo(bar + baz)',
  );
  assertEquals(context.blockSpan(), null);
  assertEquals(context.parsedSyntax()?.kind, 'invocation');
});

Deno.test('createMacroContext exposes runtime target metadata', () => {
  const { resolved } = createContext('const value = Foo(bar + baz);\n');
  const runtime = normalizeRuntimeContext({
    externs: ['deno'],
    target: 'wasm-node',
  });
  const context = createMacroContext(resolved, null, undefined, runtime);

  assertEquals(context.runtime.target, 'wasm-node');
  assertEquals(context.runtime.backend, 'wasm');
  assertEquals(context.runtime.host, 'node');
  assertEquals(context.runtime.externs(), ['deno']);
});

Deno.test('createMacroContext treats Match array arms as ordinary expression args', () => {
  const { context } = createContext(
    [
      "type Ok = { tag: 'ok'; value: number };",
      'declare const value: Ok | undefined;',
      'const result = Match(value, [({ value }: Ok) => value, (_) => 0]);',
      '',
    ].join('\n'),
    'Match',
  );

  assertEquals(context.kind, 'expr');
  assertEquals(context.invocation.form, 'arglist');
  assertEquals(
    context.syntax.args().map((argument) => argument.text()),
    ['value', '[({ value }: Ok) => value, (_) => 0]'],
  );
  assertEquals(context.hasBlock(), false);
});

Deno.test('createMacroContext exposes declaration accessors for annotation macros', () => {
  const { context, fullSource } = createContext(
    [
      '// #[derive]',
      'export class User { id: string; }',
      '',
    ].join('\n'),
    'derive',
  );

  assertEquals(context.kind, 'stmt');
  assertEquals(context.invocation.form, 'decl');
  assertEquals(context.syntax.args(), []);
  assertEquals(context.hasBlock(), false);
  assertEquals(context.syntax.declaration().declarationKind, 'class');
  assertEquals(context.syntax.declaration().name, 'User');
  assertEquals(context.syntax.declaration().text(), 'export class User { id: string; }');
  const declarationSpan = context.declarationSpan();
  assert(declarationSpan);
  assertEquals(
    fullSource.slice(declarationSpan.start, declarationSpan.end),
    'export class User { id: string; }',
  );
});

Deno.test('createMacroContext exposes class and JSX declaration wrappers for annotation macros', () => {
  const { context } = createContextInFile(
    '/virtual/index.sts',
    [
      '// #[component]',
      'export class Counter {',
      '  count = 0;',
      '  get doubled() {',
      '    return this.count * 2;',
      '  }',
      '  render() {',
      '    return <button disabled={this.count > 0}><><span>{this.count}</span><strong>!</strong></></button>;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'component',
  );

  const declaration = context.syntax.declaration();
  const classDecl = declaration.asClass();
  assert(classDecl);
  assertEquals(classDecl.name, 'Counter');
  assertEquals(classDecl.hasModifier('export'), true);
  assertEquals(classDecl.asFunction(), null);
  assertEquals(classDecl.members().map((member) => member.memberKind), [
    'field',
    'getter',
    'method',
  ]);
  const countField = classDecl.member('count');
  assert(countField && countField.memberKind === 'field');
  assertEquals(countField.initializer()?.text(), '0');
  const getter = classDecl.member('doubled');
  assert(getter && getter.memberKind === 'getter');
  assertEquals(getter.body()?.thisMemberReferences(), ['count']);
  const renderMethod = classDecl.member('render');
  assert(renderMethod && renderMethod.memberKind === 'method');
  const returnedJsx = renderMethod.returnedJsx();
  assert(returnedJsx);
  assertEquals(returnedJsx.tagName, 'button');
  assertEquals(returnedJsx.attribute('disabled')?.kind, 'jsx_attribute');
  if (returnedJsx.attribute('disabled')?.kind === 'jsx_attribute') {
    assertEquals(returnedJsx.attribute('disabled')?.expression()?.text(), 'this.count > 0');
  }
  assertEquals(returnedJsx.children().map((child) => child.kind), ['jsx_fragment']);
});

Deno.test('createMacroContext exposes attached member annotations through syntax access', () => {
  const { context } = createContext(
    [
      '// #[derive]',
      'export type User = {',
      "  // #[codec.rename('user_id')]",
      '  id: string;',
      '  // #[eq.skip]',
      '  cacheKey: string;',
      '};',
      '',
    ].join('\n'),
    'derive',
  );

  const declaration = context.syntax.declaration().asTypeAlias();
  assert(declaration);
  const objectType = declaration.type.asObjectLiteral();
  assert(objectType);
  assertEquals(
    context.syntax.annotations(objectType.members[0]!).map((annotation) => annotation.name),
    ['codec.rename'],
  );
  assertEquals(
    context.syntax.annotations(objectType.members[1]!).map((annotation) => annotation.name),
    ['eq.skip'],
  );
});

Deno.test('createMacroContext exposes generic annotation paths and rich normalized argument values', () => {
  const { context } = createContext(
    [
      '// #[decode]',
      '// #[openapi.example({ route: Routes.users.show, matcher: /^users\\/[a-z]+$/i, value: null, tags: [Source.alpha, "beta"], "x-grpc-id": 3n, fallback: undefined })]',
      'export interface User {',
      '  // #[decode.minLength(3)]',
      '  // #[custom.meta(null, Routes.users.index, /users/u)]',
      '  name: string;',
      '}',
      '',
    ].join('\n'),
    'decode',
  );

  const declaration = context.syntax.declaration().asInterface();
  assert(declaration);

  const declarationAnnotations = context.syntax.annotations(declaration);
  assertEquals(
    declarationAnnotations.map((annotation) => annotation.path),
    [
      ['decode'],
      ['openapi', 'example'],
    ],
  );

  const openApiAnnotation = declarationAnnotations[1]!;
  const [openApiArgument] = openApiAnnotation.arguments ?? [];
  assertEquals(openApiArgument?.kind, 'positional');
  if (!openApiArgument || openApiArgument.kind !== 'positional' || openApiArgument.value.kind !== 'object') {
    throw new Error('expected normalized object annotation value');
  }

  const routeProperty = openApiArgument.value.properties.find((property) => property.name === 'route');
  const matcherProperty = openApiArgument.value.properties.find((property) => property.name === 'matcher');
  const valueProperty = openApiArgument.value.properties.find((property) => property.name === 'value');
  const tagsProperty = openApiArgument.value.properties.find((property) => property.name === 'tags');
  const grpcIdProperty = openApiArgument.value.properties.find((property) => property.name === 'x-grpc-id');
  const fallbackProperty = openApiArgument.value.properties.find((property) => property.name === 'fallback');

  assertEquals(routeProperty?.value, {
    kind: 'member',
    path: ['Routes', 'users', 'show'],
    text: 'Routes.users.show',
  });
  assertEquals(matcherProperty?.value, {
    flags: 'i',
    kind: 'regexp',
    pattern: '^users\\/[a-z]+$',
    text: '/^users\\/[a-z]+$/i',
  });
  assertEquals(valueProperty?.value, {
    kind: 'null',
    text: 'null',
  });
  assertEquals(tagsProperty?.value.kind, 'array');
  if (!tagsProperty || tagsProperty.value.kind !== 'array') {
    throw new Error('expected tags array');
  }
  assertEquals(tagsProperty.value.elements[0], {
    kind: 'member',
    path: ['Source', 'alpha'],
    text: 'Source.alpha',
  });
  assertEquals(tagsProperty.value.elements[1], {
    kind: 'string',
    text: '"beta"',
    value: 'beta',
  });
  assertEquals(grpcIdProperty?.value, {
    kind: 'bigint',
    text: '3n',
    value: '3',
  });
  assertEquals(fallbackProperty?.value, {
    kind: 'undefined',
    text: 'undefined',
  });

  const memberAnnotations = context.syntax.annotations(declaration.members[0]!);
  assertEquals(
    memberAnnotations.map((annotation) => annotation.path),
    [
      ['decode', 'minLength'],
      ['custom', 'meta'],
    ],
  );
  assertEquals(memberAnnotations[0]?.arguments?.[0]?.value, {
    kind: 'number',
    text: '3',
    value: 3,
  });
  assertEquals(memberAnnotations[1]?.arguments?.[0]?.value, {
    kind: 'null',
    text: 'null',
  });
  assertEquals(memberAnnotations[1]?.arguments?.[1]?.value, {
    kind: 'member',
    path: ['Routes', 'users', 'index'],
    text: 'Routes.users.index',
  });
  assertEquals(memberAnnotations[1]?.arguments?.[2]?.value, {
    flags: 'u',
    kind: 'regexp',
    pattern: 'users',
    text: '/users/u',
  });
});

Deno.test('createMacroContext exposes interface declaration wrappers for annotation macros', () => {
  const { context } = createContextInFile(
    '/virtual/index.sts',
    [
      '// #[hkt]',
      'export interface ResultF<E, A> {',
      '  readonly type: Result<A, E>;',
      '}',
      '',
    ].join('\n'),
    'hkt',
  );

  const declaration = context.syntax.declaration();
  const interfaceDecl = declaration.asInterface();
  assert(interfaceDecl);
  assertEquals(interfaceDecl.name, 'ResultF');
  assertEquals(interfaceDecl.declarationKind, 'interface');
  assertEquals(interfaceDecl.hasModifier('export'), true);
  assertEquals(interfaceDecl.typeParameters.map((parameter) => parameter.name), ['E', 'A']);
  assertEquals(interfaceDecl.extendsTypes.map((type) => type.text()), []);
  assertEquals(interfaceDecl.members.map((member) => member.name), ['type']);
  assertEquals(interfaceDecl.asClass(), null);
  assertEquals(interfaceDecl.asFunction(), null);
});

Deno.test('createMacroContext exposes type alias declaration wrappers for annotation macros', () => {
  const { context } = createContext(
    [
      '// #[derive]',
      'export type ResultF<E, A> = Result<A, E>;',
      '',
    ].join('\n'),
    'derive',
  );

  const declaration = context.syntax.declaration();
  const typeAliasDecl = declaration.asTypeAlias();
  assert(typeAliasDecl);
  assertEquals(typeAliasDecl.name, 'ResultF');
  assertEquals(typeAliasDecl.declarationKind, 'typeAlias');
  assertEquals(typeAliasDecl.hasModifier('export'), true);
  assertEquals(typeAliasDecl.typeParameters.map((parameter) => parameter.name), ['E', 'A']);
  assertEquals(typeAliasDecl.type.text(), 'Result<A, E>');
  assertEquals(typeAliasDecl.asClass(), null);
  assertEquals(typeAliasDecl.asFunction(), null);
  assertEquals(typeAliasDecl.asInterface(), null);
});

Deno.test('createMacroContext exposes generic this-rewrite and class dependency helpers', () => {
  const { context } = createContextInFile(
    '/virtual/index.sts',
    [
      '// #[component]',
      'class Counter {',
      '  count = 0;',
      '  get doubled() {',
      '    return this.count * 2;',
      '  }',
      '  render() {',
      '    return <button disabled={this.doubled > 0}>{this.count}</button>;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'component',
  );

  const classDecl = context.syntax.declaration().asClass();
  assert(classDecl);
  const renderMethod = classDecl.member('render');
  assert(renderMethod && renderMethod.memberKind === 'method');
  const returnedJsx = renderMethod.returnedJsx();
  assert(returnedJsx);
  const disabledAttr = returnedJsx.attribute('disabled');
  assert(disabledAttr && disabledAttr.kind === 'jsx_attribute');
  const disabledExpr = disabledAttr.expression();
  assert(disabledExpr);
  const replacedExpr = disabledExpr.replaceThis(context.build.identifier('instance'));
  assertEquals(replacedExpr.text(), 'instance.doubled > 0');
  const doubledGetter = classDecl.member('doubled');
  assert(doubledGetter && doubledGetter.memberKind === 'getter');
  const replacedGetterBody = doubledGetter.body()?.replaceThis(
    context.build.identifier('instance'),
  );
  assert(replacedGetterBody);
  assert(replacedGetterBody.text().includes('return instance.count * 2;'));
  assertEquals(classDecl.resolveThisDependencies(disabledExpr, ['count']), ['count']);
});

Deno.test('createMacroContext exposes returned expressions for declaration methods and functions', () => {
  const { context } = createContextInFile(
    '/virtual/index.sts',
    [
      '// #[component]',
      'class Counter {',
      '  count = 0;',
      '  render() {',
      "    return <button onClick={() => dispatch('tick', this.count)}>{this.count}</button>;",
      '  }',
      '}',
      '',
    ].join('\n'),
    'component',
  );

  const classDecl = context.syntax.declaration().asClass();
  assert(classDecl);
  const renderMethod = classDecl.member('render');
  assert(renderMethod && renderMethod.memberKind === 'method');
  assertEquals(
    renderMethod.returnedExpr()?.text(),
    "<button onClick={() => dispatch('tick', this.count)}>{this.count}</button>",
  );

  const { context: functionContext } = createContextInFile(
    '/virtual/function.sts',
    [
      '// #[derive]',
      'export function renderLabel() {',
      "  return <span data-label={'ok'}>{1}</span>;",
      '}',
      '',
    ].join('\n'),
    'derive',
  );
  const functionDecl = functionContext.syntax.declaration().asFunction();
  assert(functionDecl);
  assertEquals(
    functionDecl.returnedExpr()?.text(),
    "<span data-label={'ok'}>{1}</span>",
  );
});

Deno.test('createMacroContext exposes public expression and block rewrite helpers', () => {
  const { context } = createContextInFile(
    '/virtual/index.sts',
    [
      '// #[component]',
      'class Counter {',
      '  count = 0;',
      '  setup() {',
      "    dispatch('init', this.count);",
      '    if (this.count > 0) {',
      "      dispatch('gt_zero', this.count);",
      '    }',
      '  }',
      '  render() {',
      "    return <button onClick={() => dispatch('tick', this.count)}>{this.count}</button>;",
      '  }',
      '}',
      '',
    ].join('\n'),
    'component',
  );

  const classDecl = context.syntax.declaration().asClass();
  assert(classDecl);
  const instanceExpr = context.build.identifier('instance');
  const emitExpr = context.build.property(instanceExpr, '__sts_component_emit');
  const renderMethod = classDecl.member('render');
  assert(renderMethod && renderMethod.memberKind === 'method');
  const rewrittenExpr = renderMethod.returnedExpr()?.rewrite({
    replaceCallNamed: { dispatch: emitExpr },
    replaceThisWith: instanceExpr,
  });
  assert(rewrittenExpr);
  assertEquals(
    rewrittenExpr.text(),
    '<button onClick={() => instance.__sts_component_emit("tick", instance.count)}>{instance.count}</button>',
  );

  const setupMethod = classDecl.member('setup');
  assert(setupMethod && setupMethod.memberKind === 'method');
  const rewrittenBlock = setupMethod.body()?.rewrite({
    replaceCallNamed: { dispatch: emitExpr },
    replaceThisWith: instanceExpr,
  });
  assert(rewrittenBlock);
  assertEquals(
    rewrittenBlock.text(),
    [
      '{',
      '    instance.__sts_component_emit("init", instance.count);',
      '    if (instance.count > 0) {',
      '        instance.__sts_component_emit("gt_zero", instance.count);',
      '    }',
      '}',
    ].join('\n'),
  );
});

Deno.test('createMacroContext exposes structural expression helpers for conditionals and map callbacks', () => {
  const { context } = createContextInFile(
    '/virtual/index.sts',
    [
      'const view = Foo(this.open ? <p>Open</p> : null);',
      'const list = Bar(this.todos.map((todo, index) => <li key={todo.id}>{index}: {todo.text}</li>));',
      'const gate = Baz(this.open && <p>Open</p>);',
      '',
    ].join('\n'),
  );

  const conditional = context.syntax.arg(0).asConditional();
  assert(conditional);
  assertEquals(conditional.condition.text(), 'this.open');
  assertEquals(conditional.whenTrue.asJsxElement()?.tagName, 'p');
  assertEquals(conditional.whenFalse.isNullLiteral(), true);

  const { context: listContext } = createContextInFile(
    '/virtual/list.sts',
    [
      'const list = Foo(this.todos.map((todo, index) => <li key={todo.id}>{index}: {todo.text}</li>));',
      '',
    ].join('\n'),
  );
  const mapCall = listContext.syntax.arg(0).asCall();
  assert(mapCall);
  const callee = mapCall.callee.asPropertyAccess();
  assert(callee);
  assertEquals(callee.name, 'map');
  assertEquals(callee.object.text(), 'this.todos');
  const callback = mapCall.args[0]?.asFunction();
  assert(callback);
  assertEquals(callback.parameters.map((parameter) => parameter.name), ['todo', 'index']);
  assertEquals(callback.returnedJsx()?.tagName, 'li');

  const { context: gateContext } = createContextInFile(
    '/virtual/gate.sts',
    [
      'const gate = Foo(this.open && <p>Open</p>);',
      '',
    ].join('\n'),
  );
  const gateBinary = gateContext.syntax.arg(0).asBinary();
  assert(gateBinary);
  assertEquals(gateBinary.left.text(), 'this.open');
  assertEquals(gateBinary.operator, '&&');
  assertEquals(gateBinary.right.asJsxElement()?.tagName, 'p');
});

Deno.test('createAdvancedMacroContext exposes conservative read and write dependency sets', () => {
  const { context } = createAdvancedContextInFile(
    '/virtual/index.sts',
    [
      '// #[derive]',
      "export function collectDeps(step = this.count, result = { value: 1 }, store = { user: { name: '' } }, sink = '') {",
      '  return () => {',
      '    this.count += step;',
      '    ({ value: this.total } = result);',
      '    sink = store.user.name;',
      '    return this.todos.map((todo) => todo.text + this.count + store.user.name);',
      '  };',
      '}',
      '',
    ].join('\n'),
    'derive',
  );

  const functionDecl = context.syntax.declaration().asFunction();
  assert(functionDecl);
  const callback = functionDecl.returnedExpr()?.asFunction();
  assert(callback);
  const body = callback.body();
  assert(body);

  const readSet = context.semantics.readSet(body);
  const writeSet = context.semantics.writeSet(body);

  assertEquals(
    [...readSet.dependencies].sort((left, right) =>
      `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
    ),
    [
      { kind: 'binding', name: 'result' },
      { kind: 'binding', name: 'step' },
      { kind: 'binding', name: 'store' },
      { kind: 'this-member', name: 'count' },
      { kind: 'this-member', name: 'todos' },
    ],
  );
  assertEquals(readSet.unknown, false);
  assertEquals(
    [...writeSet.dependencies].sort((left, right) =>
      `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
    ),
    [
      { kind: 'binding', name: 'sink' },
      { kind: 'this-member', name: 'count' },
      { kind: 'this-member', name: 'total' },
    ],
  );
  assertEquals(writeSet.unknown, false);
});

Deno.test('createAdvancedMacroContext marks dynamic dependency analysis as unknown', () => {
  const { context } = createAdvancedContext(
    'const value = Foo(this[dynamicKey] + store[userKey]);\n',
  );

  const readSet = context.semantics.readSet(context.syntax.arg(0));
  assertEquals(readSet.dependencies, [
    { kind: 'binding', name: 'dynamicKey' },
    { kind: 'binding', name: 'store' },
    { kind: 'binding', name: 'userKey' },
  ]);
  assertEquals(readSet.unknown, true);
});

Deno.test('createMacroContext exposes parameter wrapper details for destructured typed arrow functions', () => {
  const { context } = createContextInFile(
    '/virtual/match.sts',
    [
      'type Value = readonly [string, ...string[]];',
      'const result = Foo(([first, ...rest]: Value) => first);',
      '',
    ].join('\n'),
  );

  const fn = context.syntax.arg(0).asFunction();
  assert(fn);
  const [parameter] = fn.parameters;
  assert(parameter);
  assertEquals(parameter.name, null);
  assertEquals(parameter.hasExplicitType(), true);
  assertEquals(parameter.bindingIdentifiers().map((binding) => binding.name), ['first', 'rest']);
});

Deno.test('createMacroContext exposes explicit types and optionality for object members and class fields', () => {
  const { context: typeContext } = createContext(
    [
      '// #[eq]',
      'export type User = {',
      '  id: string;',
      '  nickname?: string;',
      '};',
      '',
    ].join('\n'),
    'eq',
  );
  const userType = typeContext.syntax.declaration().asTypeAlias();
  assert(userType);
  const objectType = userType.type.asObjectLiteral();
  assert(objectType);
  const [idMember, nicknameMember] = objectType.members;
  assert(idMember);
  assert(nicknameMember);
  assertEquals(idMember.explicitType()?.text(), 'string');
  assertEquals(idMember.isOptional(), false);
  assertEquals(nicknameMember.explicitType()?.text(), 'string');
  assertEquals(nicknameMember.isOptional(), true);

  const { context: classContext } = createContext(
    [
      '// #[hash]',
      'export class Box {',
      '  value: bigint;',
      '  label?: string;',
      '}',
      '',
    ].join('\n'),
    'hash',
  );
  const boxClass = classContext.syntax.declaration().asClass();
  assert(boxClass);
  const [valueField, labelField] = boxClass.members().filter((member) =>
    member.memberKind === 'field'
  );
  assert(valueField?.memberKind === 'field');
  assert(labelField?.memberKind === 'field');
  assertEquals(valueField.explicitType()?.text(), 'bigint');
  assertEquals(valueField.isOptional(), false);
  assertEquals(labelField.explicitType()?.text(), 'string');
  assertEquals(labelField.isOptional(), true);
});

Deno.test('createMacroContext exposes union and literal type wrappers for tagged unions', () => {
  const { context } = createContext(
    [
      '// #[tagged]',
      'export type Expr =',
      '  | { tag: "lit"; value: number }',
      '  | { tag: "add"; left: Expr; right: Expr };',
      '',
    ].join('\n'),
    'tagged',
  );

  const exprType = context.syntax.declaration().asTypeAlias();
  assert(exprType);
  const unionType = exprType.type.asUnion();
  assert(unionType);
  assertEquals(unionType.members.length, 2);
  assertEquals(unionType.members[0]?.asObjectLiteral()?.members.map((member) => member.name), [
    'tag',
    'value',
  ]);
  assertEquals(unionType.members[1]?.asObjectLiteral()?.members.map((member) => member.name), [
    'tag',
    'left',
    'right',
  ]);

  const litVariant = unionType.members[0]?.asObjectLiteral();
  assert(litVariant);
  const tagMember = litVariant.members[0];
  assert(tagMember);
  assertEquals(tagMember.name, 'tag');
  const tagType = tagMember.explicitType()?.asLiteral();
  assert(tagType);
  assertEquals(tagType.literalKind, 'string');
  assertEquals(tagType.value, 'lit');
});

Deno.test('createMacroContext preserves absolute spans for nested function bindings parsed from array args', () => {
  const body = [
    'const result = Foo([',
    '  ((err: string) => err),',
    '  (({ value }: { value: number }) => value),',
    ']);',
    '',
  ].join('\n');
  const { context, fullSource } = createContextInFile('/virtual/match_spans.sts', body);

  const arms = context.syntax.arg(0).asArrayLiteral();
  assert(arms);
  const firstFn = arms.elements[0]?.expression()?.asFunction();
  assert(firstFn);
  const firstBinding = firstFn.parameters[0]?.bindingIdentifiers()[0];
  assert(firstBinding);
  assertEquals(fullSource.slice(firstBinding.span.start, firstBinding.span.end), 'err');

  const secondFn = arms.elements[1]?.expression()?.asFunction();
  assert(secondFn);
  const secondBinding = secondFn.parameters[0]?.bindingIdentifiers()[0];
  assert(secondBinding);
  assertEquals(fullSource.slice(secondBinding.span.start, secondBinding.span.end), 'value');
});

Deno.test('createMacroContext preserves nested macro structure inside call args and callback bodies', () => {
  const { context: exprContext } = createContextInFile(
    '/virtual/nested.sts',
    [
      'const value = Foo(wrap(Bar(input)));',
      '',
    ].join('\n'),
  );
  const exprCall = exprContext.syntax.arg(0).asCall();
  assert(exprCall);
  assertEquals(exprCall.callee.text(), 'wrap');
  assertEquals(exprCall.args.length, 1);

  const { context: callbackContext } = createContextInFile(
    '/virtual/nested_callback.sts',
    [
      'Foo(() => {',
      '  use(Bar(input));',
      '});',
      '',
    ].join('\n'),
  );
  const callback = callbackContext.syntax.arg(0).asFunction();
  assert(callback);
  assertEquals(callback.body()?.containsCallNamed('use'), true);
});

Deno.test('createMacroContext can quote and rebuild class declarations from annotation macro contexts', () => {
  const { context } = createContextInFile(
    '/virtual/index.sts',
    [
      '// #[component]',
      'export class Counter {',
      '  count = 0;',
      '  render() {',
      '    return <button>{this.count}</button>;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'component',
  );

  const classDecl = context.syntax.declaration().asClass();
  assert(classDecl);
  const runtimeMembers = context.quote.classMembers`
    ready = false;
    get doubled() {
      return this.count * 2;
    }
  `;
  const updatedClass = context.build.updateClass(classDecl, [
    ...runtimeMembers,
    ...classDecl.members(),
  ]);

  assertEquals(updatedClass.declarationKind, 'class');
  assertEquals(updatedClass.name, 'Counter');
  assert(updatedClass.text().includes('ready = false;'));
  assert(updatedClass.text().includes('get doubled()'));
  assert(updatedClass.text().includes('render()'));
});

Deno.test('createMacroContext can build low-level expressions statements objects and loops', () => {
  const { context } = createContext('const value = Foo(bar);\n');
  const stateRef = context.build.identifier('state');
  const countRef = context.build.property(stateRef, 'count');
  const nextCount = context.build.binary(countRef, '+', context.build.numberLiteral(1));
  const assignCount = context.build.assign(countRef, nextCount);
  const updateStmt = context.build.exprStmt(assignCount);
  const viewExpr = context.build.objectLiteral([
    {
      kind: 'property',
      name: 'ready',
      value: context.build.booleanLiteral(true),
    },
    {
      body: context.build.block([
        context.build.returnStmt(context.build.identifier('dirty')),
      ]),
      kind: 'method',
      name: 'update',
      parameters: ['dirty'],
    },
  ]);
  const loop = context.build.forStmt({
    initializer: {
      kind: 'let',
      name: 'index',
      value: context.build.numberLiteral(0),
    },
    condition: context.build.binary(
      context.build.identifier('index'),
      '<',
      context.build.property(context.build.identifier('items'), 'length'),
    ),
    increment: context.build.assign(
      context.build.identifier('index'),
      context.build.binary(context.build.identifier('index'), '+', context.build.numberLiteral(1)),
    ),
    statements: [
      context.build.constDecl(
        'item',
        context.build.element(context.build.identifier('items'), context.build.identifier('index')),
      ),
      updateStmt,
    ],
  });

  assertEquals(countRef.text(), 'state.count');
  assertEquals(updateStmt.text(), 'state.count = state.count + 1;');
  assert(viewExpr.text().includes('ready: true'));
  assert(viewExpr.text().includes('update(dirty)'));
  assert(loop.text().includes('for (let index = 0; index < items.length; index = index + 1)'));
});

Deno.test('createMacroContext exposes template literal operands for embedded DSL tags', () => {
  const { context } = createContext(
    'const query = sql`SELECT * FROM users WHERE id = ${userId}`;\n',
    'sql',
  );
  const template = context.syntax.template(0);

  assert(template);
  assertEquals(template.text(), '`SELECT * FROM users WHERE id = ${userId}`');
  assertEquals(template.quasis.map((quasi) => quasi.text), ['SELECT * FROM users WHERE id = ', '']);
  assertEquals(template.expressions.map((expression) => expression.text()), ['userId']);
});

Deno.test('createAdvancedMacroContext exposes semantic arg types for call macros', () => {
  const fileName = '/virtual/index.sts';
  const body = [
    "type Result<Ok, Err> = { tag: 'ok'; value: Ok } | { tag: 'err'; error: Err };",
    'declare function safeDivide(): Result<number, string>;',
    '',
    'function compute(): number {',
    '  return Foo(safeDivide());',
    '}',
    '',
  ].join('\n');
  const fullSource = withImports(body);
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: fullSource,
  }, {
    importedMacroSiteKindsBySpecifier: TEST_USER_MACRO_SITE_KINDS,
  });
  const resolved = collectResolvedMacroPlaceholders(preparedProgram)
    .find((entry) => entry.resolved.placeholder.invocation.nameText === 'Foo');

  assert(resolved);

  const context = createAdvancedMacroContext(preparedProgram, resolved.resolved);
  const argType = context.semantics.argType(0);

  assert(argType);
  assertEquals(argType.displayText, 'Result<number, string>');
});

Deno.test('createAdvancedMacroContext reflects object-like declaration shapes with recursive field types', () => {
  const { context } = createAdvancedContext(
    [
      '// #[codec]',
      'export type User = {',
      '  id: string;',
      '  profile?: {',
      '    name: string;',
      '    tags: readonly [string, number];',
      '  };',
      '  result: Result<Option<User>, bigint>;',
      '};',
      '',
    ].join('\n'),
    'codec',
  );

  const declaration = context.syntax.declaration();
  const shape = context.reflect.declarationShape(declaration);
  assertEquals(shape.kind, 'objectLike');
  if (shape.kind !== 'objectLike') {
    return;
  }

  assertEquals(shape.declarationKind, 'typeAlias');
  assertEquals(shape.name, 'User');
  assertEquals(shape.fields.map((field) => field.name), ['id', 'profile', 'result']);

  const [idField, profileField, resultField] = shape.fields;
  assert(idField);
  assert(profileField);
  assert(resultField);

  assertEquals(idField.originKind, 'typeLiteralProperty');
  assertEquals(idField.type?.kind, 'primitive');

  assertEquals(profileField.optional, true);
  assertEquals(profileField.type?.kind, 'object');
  if (profileField.type?.kind === 'object') {
    assertEquals(profileField.type.fields.map((field) => field.name), ['name', 'tags']);
    assertEquals(profileField.type.fields[1]?.type?.kind, 'tuple');
  }

  assertEquals(resultField.type?.kind, 'result');
  if (resultField.type?.kind === 'result') {
    assertEquals(resultField.type.ok.kind, 'option');
    assertEquals(resultField.type.err.kind, 'primitive');
  }
});

Deno.test('createAdvancedMacroContext resolves sibling local declarations from original source', () => {
  const { context } = createAdvancedContext(
    [
      'type Parent = {',
      '  id: string;',
      '};',
      '',
      '// #[codec]',
      'type Child = {',
      '  parent?: Parent;',
      '};',
      '',
    ].join('\n'),
    'codec',
  );

  const declaration = context.syntax.declaration();
  const localDeclaration = context.semantics.localDeclaration('Parent', declaration);

  assert(localDeclaration);
  assertEquals(localDeclaration.name, 'Parent');
  assert(localDeclaration.asTypeAlias());
  assert(localDeclaration.text().includes('type Parent = {'));
});

Deno.test('createAdvancedMacroContext reflects discriminated union declaration shapes', () => {
  const { context } = createAdvancedContext(
    [
      '// #[tagged]',
      'export type Expr =',
      '  | { tag: "lit"; value: number }',
      '  | { tag: "add"; left: Expr; right: Expr };',
      '',
    ].join('\n'),
    'tagged',
  );

  const declaration = context.syntax.declaration();
  const shape = context.reflect.declarationShape(declaration);
  assertEquals(shape.kind, 'discriminatedUnion');
  if (shape.kind !== 'discriminatedUnion') {
    return;
  }

  assertEquals(shape.name, 'Expr');
  assertEquals(shape.commonDiscriminantNames, ['tag']);
  assertEquals(shape.variants.map((variant) => variant.discriminants[0]?.tag), ['lit', 'add']);
  assertEquals(shape.variants[0]?.fields.map((field) => field.name), ['value']);
  assertEquals(shape.variants[1]?.fields.map((field) => field.name), ['left', 'right']);
});

Deno.test('createAdvancedMacroContext reflects member annotations on normalized fields', () => {
  const { context } = createAdvancedContext(
    [
      '// #[codec]',
      'export interface User {',
      "  // #[codec.rename('user_id')]",
      '  id: string;',
      '  // #[codec.via(UserMetadataCodec)]',
      '  metadata: { active: boolean };',
      '}',
      '',
    ].join('\n'),
    'codec',
  );

  const declaration = context.syntax.declaration();
  const shape = context.reflect.declarationShape(declaration);
  assertEquals(shape.kind, 'objectLike');
  if (shape.kind !== 'objectLike') {
    return;
  }

  assertEquals(shape.fields[0]?.annotations.map((annotation) => annotation.name), ['codec.rename']);
  assertEquals(shape.fields[1]?.annotations.map((annotation) => annotation.name), ['codec.via']);
  assertEquals(shape.fields[1]?.type?.kind, 'object');
});

Deno.test('createAdvancedMacroContext reflects null undefined record and intersection type shapes', () => {
  const { context } = createAdvancedContext(
    [
      '// #[codec]',
      'export type User = {',
      '  maybe: string | null | undefined;',
      '  extras: Record<string, number>;',
      '  flags: { [key: string]: boolean };',
      '  combined: { id: string } & { total: bigint };',
      '};',
      '',
    ].join('\n'),
    'codec',
  );

  const declaration = context.syntax.declaration();
  const shape = context.reflect.declarationShape(declaration);
  assertEquals(shape.kind, 'objectLike');
  if (shape.kind !== 'objectLike') {
    return;
  }

  assertEquals(shape.fields[0]?.type?.kind, 'union');
  if (shape.fields[0]?.type?.kind === 'union') {
    assertEquals(shape.fields[0].type.members.map((member) => member.kind), [
      'primitive',
      'null',
      'undefined',
    ]);
  }

  assertEquals(shape.fields[1]?.type?.kind, 'record');
  assertEquals(shape.fields[2]?.type?.kind, 'record');
  assertEquals(shape.fields[3]?.type?.kind, 'intersection');
  if (shape.fields[3]?.type?.kind === 'intersection') {
    assertEquals(shape.fields[3].type.members.map((member) => member.kind), ['object', 'object']);
  }
});

Deno.test('createAdvancedMacroContext exposes serializable declaration shape data without syntax nodes', () => {
  const { context } = createAdvancedContext(
    [
      '// #[codec]',
      'export interface User {',
      "  // #[codec.rename('user_id')]",
      '  id: string;',
      '  profile?: {',
      "    // #[custom.example('Ada')]",
      '    name: string;',
      '  };',
      '}',
      '',
    ].join('\n'),
    'codec',
  );

  const declaration = context.syntax.declaration();
  const shape = context.reflect.declarationShapeData(declaration);
  assertEquals(shape.kind, 'objectLike');
  if (shape.kind !== 'objectLike') {
    return;
  }

  assertEquals('node' in shape, false);
  assertEquals(shape.fields[0]?.annotations.map((annotation) => annotation.name), ['codec.rename']);
  assertEquals('node' in (shape.fields[0] ?? {}), false);
  assertEquals(shape.fields[1]?.type?.kind, 'object');
  if (shape.fields[1]?.type?.kind === 'object') {
    assertEquals(shape.fields[1].type.fields[0]?.annotations.map((annotation) => annotation.name), [
      'custom.example',
    ]);
    assertEquals('node' in (shape.fields[1].type.fields[0] ?? {}), false);
  }
});

Deno.test('createAdvancedMacroContext exposes serializable type shape data for discriminated unions', () => {
  const { context } = createAdvancedContext(
    [
      '// #[tagged]',
      'export type Expr =',
      '  | { tag: "lit"; value: number }',
      '  | { tag: "add"; left: Expr; right: Expr };',
      '',
    ].join('\n'),
    'tagged',
  );

  const declaration = context.syntax.declaration();
  const declShape = context.reflect.declarationShapeData(declaration);
  assertEquals(declShape.kind, 'discriminatedUnion');
  if (declShape.kind !== 'discriminatedUnion') {
    return;
  }

  assertEquals('node' in declShape, false);
  assertEquals('node' in (declShape.variants[0] ?? {}), false);
  assertEquals(declShape.variants[1]?.fields.map((field) => field.name), ['left', 'right']);

  const typeAlias = declaration.asTypeAlias();
  assert(typeAlias);
  const typeShape = context.reflect.typeShapeData(typeAlias.type);
  assertEquals(typeShape.kind, 'union');
  if (typeShape.kind === 'union') {
    assertEquals(typeShape.members.map((member) => member.kind), ['object', 'object']);
  }
});

Deno.test('createMacroContext throws helpful errors for unavailable syntax accessors', () => {
  const { context: exprContext } = createContext('const value = Foo(bar);\n');
  const { context: declContext } = createContext(
    [
      '// #[component]',
      'export class User {}',
      '',
    ].join('\n'),
    'component',
  );
  const { context: tagContext } = createContext('const query = sql`select 1`;\n', 'sql');

  let blockError: unknown;
  try {
    exprContext.syntax.block();
  } catch (caught) {
    blockError = caught;
  }

  let declarationError: unknown;
  try {
    exprContext.syntax.declaration();
  } catch (caught) {
    declarationError = caught;
  }

  let exprFromDeclarationError: unknown;
  try {
    declContext.syntax.primaryExpr();
  } catch (caught) {
    exprFromDeclarationError = caught;
  }

  let declarationFromTagError: unknown;
  try {
    tagContext.syntax.declaration();
  } catch (caught) {
    declarationFromTagError = caught;
  }

  assertEquals(
    blockError instanceof Error ? blockError.message : String(blockError),
    'Macro "Foo" does not have a block argument.',
  );
  assertEquals(
    declarationError instanceof Error ? declarationError.message : String(declarationError),
    'Macro "Foo" does not have a declaration argument.',
  );
  assertEquals(
    exprFromDeclarationError instanceof Error
      ? exprFromDeclarationError.message
      : String(exprFromDeclarationError),
    'Macro "component" does not have a primary expression argument.',
  );
  assertEquals(
    declarationFromTagError instanceof Error
      ? declarationFromTagError.message
      : String(declarationFromTagError),
    'Macro "sql" does not have a declaration argument.',
  );
});

Deno.test('createMacroContext error throws against the current invocation', () => {
  const body = 'const value = Foo(bar);\n';
  const { context, fullSource } = createContext(body);

  let error: unknown;
  try {
    context.error('boom');
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(error.message, 'boom');
  assertEquals(error.code, 'SOUNDSCRIPT_MACRO_EXPANSION');
  assertEquals(error.filePath, '/virtual/index.sts');
  const expected = lineColumnAt(fullSource, fullSource.indexOf('Foo(bar)'));
  assertEquals(error.line, expected.line);
  assertEquals(error.column, expected.column);
});

Deno.test('createMacroContext keeps sourceText exact while arg accessors use normalized spans', () => {
  const { context } = createContext('const value = Foo( a /*c*/,  b + c );\n');

  assertEquals(context.sourceText(), 'Foo( a /*c*/,  b + c )');
  assertEquals(context.syntax.args().map((argument) => argument.text()), ['a', 'b + c']);
});

Deno.test('createMacroContext exposes empty arglists as zero args', () => {
  const { context } = createContext('const value = Foo();\n');

  assertEquals(context.invocation.form, 'arglist');
  assertEquals(context.syntax.args(), []);
  assertEquals(context.invocation.args, []);
});
