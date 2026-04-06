import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';

import { createInstalledStdlibPackageFiles } from '../test_installed_stdlib.ts';
import {
  assert as assertMacro,
  css,
  Defer,
  graphql,
  lazy,
  log,
  Match,
  memo,
  sql,
  todo as todoMacro,
  Try,
  unreachable as unreachableMacro,
} from './builtin_macros.ts';
import { expandPreparedProgramWithBuiltins } from './builtin_macro_support.ts';
import {
  expandPreparedProgramWithImportScopedModules,
  expandPreparedProgramWithLoadedModules,
} from './macro_loader.ts';
import { MacroError } from './macro_errors.ts';
import {
  createPreparedProgramForMacroTest,
  printSourceFileForMacroTest,
} from './macro_test_helpers.ts';

async function expandWithBuiltins(
  source: string,
  exports: {
    Defer?: typeof Defer;
    assert?: typeof assertMacro;
    css?: typeof css;
    graphql?: typeof graphql;
    lazy?: typeof lazy;
    log?: typeof log;
    Match?: typeof Match;
    memo?: typeof memo;
    sql?: typeof sql;
    todo?: typeof todoMacro;
    Try?: typeof Try;
    unreachable?: typeof unreachableMacro;
  } = {
    Defer,
    assert: assertMacro,
    css,
    graphql,
    lazy,
    log,
    Match,
    memo,
    sql,
    todo: todoMacro,
    Try,
    unreachable: unreachableMacro,
  },
) {
  const fileName = '/virtual/index.sts';
  const builtinImportNames = Object.keys(exports);
  const importNamesBySpecifier = new Map<string, string[]>();
  for (const importName of builtinImportNames) {
    const specifier = (() => {
      switch (importName) {
        case 'Defer':
        case 'Match':
        case 'Try':
        case 'todo':
        case 'unreachable':
          return 'sts:prelude';
        case 'lazy':
        case 'memo':
          return 'sts:experimental/thunk';
        case 'sql':
          return 'sts:experimental/sql';
        case 'css':
          return 'sts:experimental/css';
        case 'graphql':
          return 'sts:experimental/graphql';
        case 'assert':
        case 'log':
          return 'sts:experimental/debug';
        default:
          throw new Error(`Unexpected builtin macro import: ${importName}`);
      }
    })();
    const existing = importNamesBySpecifier.get(specifier) ?? [];
    existing.push(importName);
    importNamesBySpecifier.set(specifier, existing);
  }
  const importPrefix = builtinImportNames.length > 0
    ? `${
      Array.from(importNamesBySpecifier.entries()).map(([specifier, importNames]) =>
        `import { ${importNames.join(', ')} } from '${specifier}';`
      ).join('\n')
    }\n`
    : '';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: `${importPrefix}${source}`,
  });
  const expanded = await expandPreparedProgramWithImportScopedModules(
    preparedProgram,
    () => Promise.resolve(exports),
  );
  const programFileName = preparedProgram.toProgramFileName(fileName);
  return {
    fileName,
    printed: printSourceFileForMacroTest(expanded.get(programFileName)!),
  };
}

function expandWithStdlibBuiltins(source: string) {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: source,
  });
  const expanded = expandPreparedProgramWithBuiltins(preparedProgram);
  const programFileName = preparedProgram.toProgramFileName(fileName);
  return {
    fileName,
    printed: printSourceFileForMacroTest(expanded.get(programFileName)!),
  };
}

function expandWithInstalledRuntimeStdlibBuiltins(source: string) {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest(
    Object.fromEntries([
      ...createInstalledStdlibPackageFiles('/virtual').entries(),
      [fileName, source],
    ]),
  );
  const expanded = expandPreparedProgramWithBuiltins(preparedProgram);
  const programFileName = preparedProgram.toProgramFileName(fileName);
  return {
    fileName,
    printed: printSourceFileForMacroTest(expanded.get(programFileName)!),
  };
}

async function captureTryMacroError(source: string): Promise<MacroError> {
  try {
    await expandWithBuiltins(source, { Try });
  } catch (caught) {
    if (caught instanceof MacroError) {
      return caught;
    }
    throw caught;
  }

  throw new Error('Expected Try macro expansion to fail.');
}

function captureStdlibBuiltinMacroError(source: string): MacroError {
  try {
    expandWithStdlibBuiltins(source);
  } catch (caught) {
    if (caught instanceof MacroError) {
      return caught;
    }
    throw caught;
  }

  throw new Error('Expected stdlib builtin macro expansion to fail.');
}

Deno.test('eq macro generates companion declarations for object-like type aliases', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { eq } from 'sts:derive';",
    'declare const timestampEq: { equals(left: Date, right: Date): boolean };',
    '',
    '// #[eq]',
    'type User = {',
    '  id: string;',
    '  active: boolean;',
    '  // #[eq.via(timestampEq)]',
    '  createdAt: Date;',
    '  // #[eq.skip]',
    '  cacheKey: string;',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserEq = {');
  assertStringIncludes(printed, 'equals(left: User, right: User)');
  assertStringIncludes(printed, 'equals(left.id, right.id)');
  assertStringIncludes(printed, 'equals(left.active, right.active)');
  assertStringIncludes(printed, 'timestampEq.equals(left.createdAt, right.createdAt)');
  assert(!printed.includes('cacheKey)'));
  assert(!printed.includes('.cacheKey'));
});

Deno.test('hash macro generates companion declarations for object-like type aliases', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { hash } from 'sts:derive';",
    'declare const timestampHashEq: { hash(value: Date): number; equals(left: Date, right: Date): boolean };',
    '',
    '// #[hash]',
    'type User = {',
    '  id: string;',
    '  active: boolean;',
    '  // #[hash.via(timestampHashEq)]',
    '  createdAt: Date;',
    '  // #[hash.skip]',
    '  cacheKey: string;',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserHash = ');
  assertStringIncludes(printed, 'fromHashEq as __sts_runtime_named_fromHashEq_');
  assertStringIncludes(printed, 'combineHashes as __sts_runtime_named_combineHashes_');
  assertStringIncludes(printed, '.hash(value.id)');
  assertStringIncludes(printed, '.hash(value.active)');
  assertStringIncludes(printed, 'timestampHashEq.hash(value.createdAt)');
  assertStringIncludes(printed, 'timestampHashEq.equals(left.createdAt, right.createdAt)');
  assert(!printed.includes('cacheKey)'));
  assert(!printed.includes('.cacheKey'));
});

Deno.test('hash macro rejects unsupported field types without a via override', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { hash } from 'sts:derive';",
    '',
    '// #[hash]',
    'type User = {',
    '  createdAt: Date | null;',
    '};',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'hash only supports fields with explicit primitive, nested object literal, tuple, array, Option/Result, or named derived types in v1. Add // #[hash.via(...)] or // #[hash.skip].',
  );
});

Deno.test('stacked eq and hash macros both expand over the same declaration', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { eq, hash } from 'sts:derive';",
    '',
    '// #[eq]',
    '// #[hash]',
    'type User = {',
    '  id: string;',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'type User = {');
  assertStringIncludes(printed, 'export const UserEq = {');
  assertStringIncludes(printed, 'export const UserHash = ');
});

Deno.test('eq and hash macros support named derived references and arrays', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { eq, hash } from 'sts:derive';",
    '',
    '// #[eq]',
    '// #[hash]',
    'type User = {',
    '  id: string;',
    '};',
    '',
    '// #[eq]',
    '// #[hash]',
    'type Group = {',
    '  owner: User;',
    '  members: readonly User[];',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'arrayEq as __sts_runtime_named_arrayEq_');
  assertStringIncludes(printed, 'lazyEq as __sts_runtime_named_lazyEq_');
  assertStringIncludes(printed, 'arrayHash as __sts_runtime_named_arrayHash_');
  assertStringIncludes(printed, 'lazyHashEq as __sts_runtime_named_lazyHashEq_');
  assertStringIncludes(printed, '() => UserEq');
  assertStringIncludes(printed, '.equals(left.owner, right.owner)');
  assertStringIncludes(printed, '.equals(left.members, right.members)');
  assertStringIncludes(printed, '() => UserHash');
  assertStringIncludes(printed, '.hash(value.owner)');
  assertStringIncludes(printed, '.hash(value.members)');
});

Deno.test('eq and hash macros support Option and Result field shapes', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { eq, hash } from 'sts:derive';",
    "import type { Option, Result } from 'sts:prelude';",
    '',
    '// #[eq]',
    '// #[hash]',
    'type User = {',
    '  id: string;',
    '};',
    '',
    '// #[eq]',
    '// #[hash]',
    'type FailureInfo = {',
    '  code: string;',
    '};',
    '',
    '// #[eq]',
    '// #[hash]',
    'type Group = {',
    '  maybeOwner: Option<User>;',
    '  latest: Result<User, FailureInfo>;',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'optionEq as __sts_runtime_named_optionEq_');
  assertStringIncludes(printed, 'resultEq as __sts_runtime_named_resultEq_');
  assertStringIncludes(printed, 'optionHash as __sts_runtime_named_optionHash_');
  assertStringIncludes(printed, 'resultHash as __sts_runtime_named_resultHash_');
  assertStringIncludes(printed, '() => UserEq');
  assertStringIncludes(printed, '() => FailureInfoEq');
  assertStringIncludes(printed, '() => UserHash');
  assertStringIncludes(printed, '() => FailureInfoHash');
});

Deno.test('eq and hash macros support tuple field shapes', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { eq, hash } from 'sts:derive';",
    '',
    '// #[eq]',
    '// #[hash]',
    'type Group = {',
    '  pair: [string, bigint];',
    '  flags: readonly [boolean, string];',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'tupleEq as __sts_runtime_named_tupleEq_');
  assertStringIncludes(printed, 'tupleHash as __sts_runtime_named_tupleHash_');
});

Deno.test('eq and hash macros support nested object literal field shapes', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { eq, hash } from 'sts:derive';",
    '',
    '// #[eq]',
    '// #[hash]',
    'type Group = {',
    '  owner: {',
    '    id: string;',
    '    active?: boolean;',
    '  };',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const GroupEq = {');
  assertStringIncludes(printed, 'left.owner');
  assertStringIncludes(printed, 'right.owner');
  assertStringIncludes(printed, 'export const GroupHash = ');
});

Deno.test('eq macro rejects named derived references when the companion is not in scope', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { eq } from 'sts:derive';",
    '',
    'type User = {',
    '  id: string;',
    '};',
    '',
    '// #[eq]',
    'type Group = {',
    '  owner: User;',
    '};',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'eq requires the companion value "UserEq" to be in scope for named derived types. Add an import or use // #[eq.via(...)] or // #[eq.skip].',
  );
});

Deno.test('tagged macro generates companion constructors and predicates for discriminated unions', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { tagged } from 'sts:derive';",
    '',
    '// #[tagged]',
    'type Expr =',
    '  | { tag: "lit"; value: number }',
    '  | { tag: "add"; left: Expr; right: Expr }',
    '  | { tag: "unit" };',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const ExprTagged = {');
  assertStringIncludes(printed, 'lit(payload: {');
  assertStringIncludes(printed, 'value: number;');
  assertStringIncludes(printed, 'return { tag: "lit", ...payload };');
  assertStringIncludes(printed, 'add(payload: {');
  assertStringIncludes(printed, 'left: Expr;');
  assertStringIncludes(printed, 'right: Expr;');
  assertStringIncludes(printed, 'unit(): Expr');
  assertStringIncludes(printed, 'return { tag: "unit" };');
  assertStringIncludes(printed, 'isLit(value: Expr): value is Extract<Expr, {');
  assertStringIncludes(printed, 'return value.tag === "lit";');
  assertStringIncludes(printed, 'return value.tag === "add";');
  assertStringIncludes(printed, 'return value.tag === "unit";');
});

Deno.test('tagged stacks with eq, hash, and codec for discriminated unions', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { codec, eq, hash, tagged } from 'sts:derive';",
    '',
    '// #[tagged]',
    '// #[eq]',
    '// #[hash]',
    '// #[codec]',
    'type Expr =',
    '  | { tag: "lit"; value: number }',
    '  | { tag: "add"; left: Expr; right: Expr };',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const ExprTagged = {');
  assertStringIncludes(printed, 'export const ExprEq = {');
  assertStringIncludes(printed, 'switch (left.tag)');
  assertStringIncludes(printed, 'case "lit":');
  assertStringIncludes(printed, 'case "add":');
  assertStringIncludes(printed, 'export const ExprHash = ');
  assertStringIncludes(printed, 'switch (value.tag)');
  assertStringIncludes(printed, 'export const ExprCodec = ');
  assertStringIncludes(printed, 'literal as __sts_runtime_named_literal_');
  assertStringIncludes(printed, 'union as __sts_runtime_named_union_');
  assertStringIncludes(printed, 'fromEncode as __sts_runtime_named_fromEncode_');
});

Deno.test('tagged macro generates companion constructors and predicates for value-class unions', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { tagged } from 'sts:derive';",
    '',
    '// #[value]',
    'class Ok<T> {',
    '  readonly value: T;',
    '',
    '  constructor(value: T) {',
    '    this.value = value;',
    '  }',
    '}',
    '',
    '// #[value]',
    'class Err<E> {',
    '  readonly error: E;',
    '',
    '  constructor(error: E) {',
    '    this.error = error;',
    '  }',
    '}',
    '',
    '// #[tagged]',
    'type Result<T, E> = Ok<T> | Err<E>;',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const ResultTagged = {');
  assertStringIncludes(printed, 'ok<T>(value:');
  assertStringIncludes(printed, 'return new Ok(value);');
  assertStringIncludes(printed, 'err<E>(error:');
  assertStringIncludes(printed, 'return new Err(error);');
  assertStringIncludes(printed, 'isOk<T, E>(value: Result<T, E>)');
  assertStringIncludes(printed, 'return value instanceof Ok;');
  assertStringIncludes(printed, 'return value instanceof Err;');
});

Deno.test('tagged macro rejects non-object union members', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { tagged } from 'sts:derive';",
    '',
    '// #[tagged]',
    'type Expr =',
    '  | { tag: "lit"; value: number }',
    '  | number;',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'tagged only supports unions of object-like variants or named classes in the same module in v1.',
  );
});

Deno.test('tagged macro rejects non-literal discriminant fields', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { tagged } from 'sts:derive';",
    '',
    '// #[tagged]',
    'type Expr =',
    '  | { tag: string; value: number }',
    '  | { tag: "add"; left: Expr; right: Expr };',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'tagged requires each variant discriminant to be a string literal type in v1.',
  );
});

Deno.test('decode macro generates companion decoders for object-like interfaces and type aliases', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { decode } from 'sts:derive';",
    'declare const timestampDecoder: unknown;',
    '',
    '// #[decode]',
    'interface User {',
    '  // #[decode.rename("user_id")]',
    '  id: string;',
    '  active: boolean;',
    '  nickname?: string;',
    '  // #[decode.via(timestampDecoder)]',
    '  createdAt: Date;',
    '  total: bigint;',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserDecoder = ');
  assertStringIncludes(printed, 'object as __sts_runtime_named_object_');
  assertStringIncludes(printed, 'map as __sts_runtime_named_map_');
  assertStringIncludes(printed, 'optional as __sts_runtime_named_optional_');
  assertStringIncludes(printed, 'bigint as __sts_runtime_named_bigint_');
  assertStringIncludes(printed, 'user_id: __sts_runtime_named_string_');
  assertStringIncludes(printed, 'active: __sts_runtime_named_boolean_');
  assertStringIncludes(printed, 'nickname: __sts_runtime_named_optional_');
  assertStringIncludes(printed, 'createdAt: value.createdAt');
  assertStringIncludes(printed, 'timestampDecoder');
  assertStringIncludes(printed, 'total: value.total');
});

Deno.test('decode macro rejects unsupported field types without a via override', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { decode } from 'sts:derive';",
    '',
    '// #[decode]',
    'type User = {',
    '  createdAt: Date | null;',
    '};',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'decode only supports fields with explicit primitive, nested object literal, tuple, array, Option/Result, or named derived types in v1. Add // #[decode.via(...)] to supply a custom decoder.',
  );
});

Deno.test('decode macro supports named derived references and arrays', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { decode } from 'sts:derive';",
    '',
    '// #[decode]',
    'type User = {',
    '  id: string;',
    '};',
    '',
    '// #[decode]',
    'type Group = {',
    '  owner: User;',
    '  members: readonly User[];',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const GroupDecoder = ');
  assertStringIncludes(printed, 'lazy as __sts_runtime_named_lazy_');
  assertStringIncludes(printed, 'array as __sts_runtime_named_array_');
  assertStringIncludes(printed, 'owner: __sts_runtime_named_lazy_');
  assertStringIncludes(printed, 'members: __sts_runtime_named_array_');
  assertStringIncludes(printed, '() => UserDecoder');
});

Deno.test('decode, encode, and codec macros support Option and Result field shapes', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { codec, decode, encode } from 'sts:derive';",
    "import type { Option, Result } from 'sts:prelude';",
    '',
    '// #[decode]',
    '// #[encode]',
    '// #[codec]',
    'type User = {',
    '  id: string;',
    '};',
    '',
    '// #[decode]',
    '// #[encode]',
    '// #[codec]',
    'type FailureInfo = {',
    '  code: string;',
    '};',
    '',
    '// #[decode]',
    '// #[encode]',
    '// #[codec]',
    'type Group = {',
    '  maybeOwner: Option<User>;',
    '  latest: Result<User, FailureInfo>;',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'option as __sts_runtime_named_option_');
  assertStringIncludes(printed, 'result as __sts_runtime_named_result_');
  assertStringIncludes(printed, '() => UserDecoder');
  assertStringIncludes(printed, '() => FailureInfoDecoder');
  assertStringIncludes(printed, '() => UserEncoder');
  assertStringIncludes(printed, '() => FailureInfoEncoder');
  assertStringIncludes(printed, '() => UserCodec');
  assertStringIncludes(printed, '() => FailureInfoCodec');
});

Deno.test('decode, encode, and codec macros support tuple field shapes', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { codec, decode, encode } from 'sts:derive';",
    '',
    '// #[decode]',
    '// #[encode]',
    '// #[codec]',
    'type Group = {',
    '  pair: [string, bigint];',
    '  flags: readonly [boolean, string];',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'tuple as __sts_runtime_named_tuple_');
  assertStringIncludes(printed, 'bigint as __sts_runtime_named_bigint_');
  assertStringIncludes(printed, 'bigintEncoder as __sts_runtime_named_bigintEncoder_');
});

Deno.test('decode, encode, and codec macros support nested object literal field shapes', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { codec, decode, encode } from 'sts:derive';",
    '',
    '// #[decode]',
    '// #[encode]',
    '// #[codec]',
    'type Group = {',
    '  owner: {',
    '    id: string;',
    '    active?: boolean;',
    '  };',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const GroupDecoder = ');
  assertStringIncludes(printed, 'export const GroupEncoder = ');
  assertStringIncludes(printed, 'export const GroupCodec = ');
  assertStringIncludes(printed, 'owner: __sts_runtime_named_object_');
});

Deno.test('decode macro supports parameterless classes via public instance fields', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { decode } from 'sts:derive';",
    '',
    '// #[decode]',
    'class User {',
    '  id: string = "";',
    '  total: bigint = 0n;',
    '  private secret: string = "";',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserDecoder = ');
  assertStringIncludes(printed, 'Object.assign(new User(), ({');
  assertStringIncludes(printed, 'id: __sts_runtime_named_string_');
  assertStringIncludes(printed, 'total: __sts_runtime_named_bigint_');
  assert(!printed.includes('secret: __sts_runtime_named_'));
  assert(!printed.includes('secret: value.secret'));
});

Deno.test('decode macro supports class factory annotations', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { decode } from 'sts:derive';",
    '',
    '// #[decode]',
    '// #[decode.factory(User.fromJson)]',
    'class User {',
    '  readonly id: string;',
    '  readonly total: bigint;',
    '  static fromJson(value: { id: string; total: bigint }) {',
    '    return new User(value.id, value.total);',
    '  }',
    '  constructor(',
    '    id: string,',
    '    total: bigint,',
    '  ) {',
    '    this.id = id;',
    '    this.total = total;',
    '  }',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserDecoder = ');
  assertStringIncludes(printed, 'User.fromJson(({');
  assertStringIncludes(printed, 'id: __sts_runtime_named_string_');
  assertStringIncludes(printed, 'total: __sts_runtime_named_bigint_');
});

Deno.test('decode macro rejects class constructors with parameters in v1', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { decode } from 'sts:derive';",
    '',
    '// #[decode]',
    'class User {',
    '  constructor(id: string) {}',
    '  id: string = "";',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'decode class support in v1 requires a constructor with no parameters.',
  );
});

Deno.test('decode macro rejects decode.factory without an identifier helper', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { decode } from 'sts:derive';",
    '',
    '// #[decode]',
    '// #[decode.factory("User.fromJson")]',
    'class User {',
    '  constructor(id: string) {}',
    '}',
    '',
  ].join('\n'));

  assertEquals(error.message, 'decode.factory(...) requires a helper identifier.');
});

Deno.test('decode macro rejects decode.factory helpers that are not in scope', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { decode } from 'sts:derive';",
    '',
    '// #[decode]',
    '// #[decode.factory(User.fromJson)]',
    'class User {',
    '  id: string = "";',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'decode.factory(...) requires the helper value "User.fromJson" to be in scope.',
  );
});

Deno.test('encode macro generates companion encoders for object-like interfaces and type aliases', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { encode } from 'sts:derive';",
    'declare const timestampEncoder: unknown;',
    '',
    '// #[encode]',
    'interface User {',
    '  // #[encode.rename("user_id")]',
    '  id: string;',
    '  active: boolean;',
    '  nickname?: string;',
    '  // #[encode.via(timestampEncoder)]',
    '  createdAt: Date;',
    '  total: bigint;',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserEncoder = ');
  assertStringIncludes(printed, 'object as __sts_runtime_named_object_');
  assertStringIncludes(printed, 'contramap as __sts_runtime_named_contramap_');
  assertStringIncludes(printed, 'optional as __sts_runtime_named_optional_');
  assertStringIncludes(printed, 'bigintEncoder as __sts_runtime_named_bigintEncoder_');
  assertStringIncludes(printed, 'user_id: __sts_runtime_named_stringEncoder_');
  assertStringIncludes(printed, 'active: __sts_runtime_named_booleanEncoder_');
  assertStringIncludes(printed, 'nickname: __sts_runtime_named_optional_');
  assertStringIncludes(printed, 'createdAt: timestampEncoder');
  assertStringIncludes(printed, 'total: __sts_runtime_named_bigintEncoder_');
  assertStringIncludes(printed, 'user_id: value.id');
  assertStringIncludes(printed, 'total: value.total');
});

Deno.test('encode macro rejects unsupported field types without a via override', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { encode } from 'sts:derive';",
    '',
    '// #[encode]',
    'type User = {',
    '  createdAt: Date | null;',
    '};',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'encode only supports fields with explicit primitive, nested object literal, tuple, array, Option/Result, or named derived types in v1. Add // #[encode.via(...)] to supply a custom encoder.',
  );
});

Deno.test('encode macro supports named derived references and arrays', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { encode } from 'sts:derive';",
    '',
    '// #[encode]',
    'type User = {',
    '  id: string;',
    '};',
    '',
    '// #[encode]',
    'type Group = {',
    '  owner: User;',
    '  members: readonly User[];',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const GroupEncoder = ');
  assertStringIncludes(printed, 'lazy as __sts_runtime_named_lazy_');
  assertStringIncludes(printed, 'array as __sts_runtime_named_array_');
  assertStringIncludes(printed, 'owner: __sts_runtime_named_lazy_');
  assertStringIncludes(printed, 'members: __sts_runtime_named_array_');
  assertStringIncludes(printed, '() => UserEncoder');
});

Deno.test('encode macro supports classes via public instance fields', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { encode } from 'sts:derive';",
    '',
    '// #[encode]',
    'class User {',
    '  id: string = "";',
    '  total: bigint = 0n;',
    '  private secret: string = "";',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserEncoder = ');
  assertStringIncludes(printed, 'id: value.id');
  assertStringIncludes(printed, 'total: value.total');
  assert(!printed.includes('secret: value.secret'));
});

Deno.test('codec macro generates companion codecs for object-like interfaces and type aliases', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { codec } from 'sts:derive';",
    'declare const timestampCodec: unknown;',
    '',
    '// #[codec]',
    'interface User {',
    '  // #[codec.rename("user_id")]',
    '  id: string;',
    '  active: boolean;',
    '  nickname?: string;',
    '  // #[codec.via(timestampCodec)]',
    '  createdAt: Date;',
    '  total: bigint;',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserCodec = ');
  assertStringIncludes(printed, 'codec as __sts_runtime_named_codec_');
  assertStringIncludes(printed, 'object as __sts_runtime_named_object_');
  assertStringIncludes(printed, 'map as __sts_runtime_named_map_');
  assertStringIncludes(printed, 'contramap as __sts_runtime_named_contramap_');
  assertStringIncludes(printed, 'optional as __sts_runtime_named_optional_');
  assertStringIncludes(printed, 'bigint as __sts_runtime_named_bigint_');
  assertStringIncludes(printed, 'bigintEncoder as __sts_runtime_named_bigintEncoder_');
  assertStringIncludes(printed, 'timestampCodec');
  assertStringIncludes(printed, 'user_id: value.id');
});

Deno.test('codec macro rejects unsupported field types without a via override', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { codec } from 'sts:derive';",
    '',
    '// #[codec]',
    'type User = {',
    '  createdAt: Date | null;',
    '};',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'codec only supports fields with explicit primitive, nested object literal, tuple, array, Option/Result, or named derived types in v1. Add // #[codec.via(...)] to supply a custom codec.',
  );
});

Deno.test('codec macro supports named derived references and arrays', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { codec } from 'sts:derive';",
    '',
    '// #[codec]',
    'type User = {',
    '  id: string;',
    '};',
    '',
    '// #[codec]',
    'type Group = {',
    '  owner: User;',
    '  members: readonly User[];',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const GroupCodec = ');
  assertStringIncludes(printed, 'lazy as __sts_runtime_named_lazy_');
  assertStringIncludes(printed, 'array as __sts_runtime_named_array_');
  assertStringIncludes(printed, 'owner: __sts_runtime_named_lazy_');
  assertStringIncludes(printed, 'members: __sts_runtime_named_array_');
  assertStringIncludes(printed, '() => UserCodec');
});

Deno.test('codec macro rejects named derived references when the companion is not in scope', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { codec } from 'sts:derive';",
    '',
    'type User = {',
    '  id: string;',
    '};',
    '',
    '// #[codec]',
    'type Group = {',
    '  owner: User;',
    '};',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'codec requires the companion value "UserCodec" to be in scope for named derived types. Add an import or use // #[codec.via(...)] to supply a custom codec.',
  );
});

Deno.test('codec macro supports parameterless classes via public instance fields', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { codec } from 'sts:derive';",
    '',
    '// #[codec]',
    'class User {',
    '  id: string = "";',
    '  total: bigint = 0n;',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserCodec = ');
  assertStringIncludes(printed, 'Object.assign(new User(), ({');
  assertStringIncludes(printed, 'id: value.id');
  assertStringIncludes(printed, 'total: value.total');
});

Deno.test('codec macro supports class factory annotations', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { codec } from 'sts:derive';",
    '',
    '// #[codec]',
    '// #[codec.factory(User.fromJson)]',
    'class User {',
    '  readonly id: string;',
    '  readonly total: bigint;',
    '  static fromJson(value: { id: string; total: bigint }) {',
    '    return new User(value.id, value.total);',
    '  }',
    '  constructor(',
    '    id: string,',
    '    total: bigint,',
    '  ) {',
    '    this.id = id;',
    '    this.total = total;',
    '  }',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserCodec = ');
  assertStringIncludes(printed, 'User.fromJson(({');
  assertStringIncludes(printed, 'id: value.id');
  assertStringIncludes(printed, 'total: value.total');
});

Deno.test('codec macro rejects class constructors with parameters in v1', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { codec } from 'sts:derive';",
    '',
    '// #[codec]',
    'class User {',
    '  constructor(id: string) {}',
    '  id: string = "";',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'codec class support in v1 requires a constructor with no parameters.',
  );
});

Deno.test('codec macro rejects codec.factory without an identifier helper', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { codec } from 'sts:derive';",
    '',
    '// #[codec]',
    '// #[codec.factory("User.fromJson")]',
    'class User {',
    '  constructor(id: string) {}',
    '}',
    '',
  ].join('\n'));

  assertEquals(error.message, 'codec.factory(...) requires a helper identifier.');
});

Deno.test('codec macro rejects codec.factory helpers that are not callable', () => {
  const error = captureStdlibBuiltinMacroError([
    "import { codec } from 'sts:derive';",
    '',
    'const createUser = "not callable";',
    '',
    '// #[codec]',
    '// #[codec.factory(createUser)]',
    'class User {',
    '  id: string = "";',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'codec.factory(...) requires "createUser" to be callable.',
  );
});

Deno.test('decode macro supports imported factory helpers', () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: [
      "import { decode } from 'sts:derive';",
      "import { buildUser } from './helpers.ts';",
      '',
      '// #[decode]',
      '// #[decode.factory(buildUser)]',
      'class User {',
      '  readonly id: string;',
      '  constructor(id: string) {',
      '    this.id = id;',
      '  }',
      '}',
      '',
    ].join('\n'),
    '/virtual/helpers.ts': [
      'export function buildUser(value: { id: string }) {',
      '  return new User(value.id);',
      '}',
      'class User {',
      '  readonly id: string;',
      '  constructor(id: string) {',
      '    this.id = id;',
      '  }',
      '}',
      '',
    ].join('\n'),
  });

  const expanded = expandPreparedProgramWithBuiltins(preparedProgram);
  const programFileName = preparedProgram.toProgramFileName(fileName);
  const printed = printSourceFileForMacroTest(expanded.get(programFileName)!);

  assertStringIncludes(printed, 'buildUser(({');
  assertStringIncludes(printed, "import { buildUser } from './helpers.ts';");
});

Deno.test('codec macro class factories compose with sts:json bridge calls', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { codec } from 'sts:derive';",
    "import { decodeJson, encodeJson } from 'sts:json';",
    '',
    '// #[codec]',
    '// #[codec.factory(User.fromJson)]',
    'class User {',
    '  readonly id: string;',
    '  readonly total: bigint;',
    '  static fromJson(value: { id: string; total: bigint }) {',
    '    return new User(value.id, value.total);',
    '  }',
    '  constructor(',
    '    id: string,',
    '    total: bigint,',
    '  ) {',
    '    this.id = id;',
    '    this.total = total;',
    '  }',
    '}',
    '',
    'const decoded = decodeJson(\'{"id":"user-1","total":12}\', UserCodec);',
    'const encoded = encodeJson(User.fromJson({ id: "user-1", total: 12n }), UserCodec, { bigint: "number" });',
    'void decoded;',
    'void encoded;',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'export const UserCodec = ');
  assertStringIncludes(printed, 'User.fromJson(({');
  assertStringIncludes(
    printed,
    'const decoded = decodeJson(\'{"id":"user-1","total":12}\', UserCodec);',
  );
  assertStringIncludes(
    printed,
    'const encoded = encodeJson(User.fromJson({ id: "user-1", total: 12n }), UserCodec, { bigint: "number" });',
  );
});

Deno.test('logMacro expands log(expr) into a source-aware helper call', async () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]:
      "import { log } from 'sts:experimental/debug';\nconst value = log(computeValue(input));\n",
  });

  const expanded = await expandPreparedProgramWithLoadedModules(
    preparedProgram,
    ['macros/log'],
    () => Promise.resolve({ log, Try, Match }),
  );
  const programFileName = preparedProgram.toProgramFileName(fileName);

  const printed = printSourceFileForMacroTest(expanded.get(programFileName)!);
  assertStringIncludes(printed, "import { log } from 'sts:experimental/debug';");
  assertStringIncludes(printed, 'const value = (() => {');
  assertStringIncludes(printed, 'console.log("computeValue(input)", __sts_log_value_');
  assertStringIncludes(printed, 'return __sts_log_value_');
});

Deno.test('logMacro accepts single parenthesized operands regardless of spacing', async () => {
  for (
    const source of [
      'const value = log({ key: 1 });\n',
      'const value = log({ key: 1 });\n',
    ]
  ) {
    const { printed } = await expandWithBuiltins(source, { log });
    assertStringIncludes(printed, 'const value = (() => {');
    assertStringIncludes(printed, 'console.log("{ key: 1 }", __sts_log_value_');
  }
});

Deno.test('lazy macro lowers expressions into delayed thunks', async () => {
  const { printed } = await expandWithBuiltins('const value = lazy(computeValue(input));\n', {
    lazy,
  });

  assertStringIncludes(printed, 'const value = () => (computeValue(input));');
});

Deno.test('memo macro lowers blocks into memoized thunks', async () => {
  const { printed } = await expandWithBuiltins(
    [
      'const expensive = memo(() => {',
      '  computeSomething();',
      '});',
      '',
    ].join('\n'),
    {
      memo,
    },
  );

  assertStringIncludes(printed, 'let __sts_memo_ready_');
  assertStringIncludes(printed, 'return () => {');
  assertStringIncludes(printed, 'if (!__sts_memo_ready_');
  assertStringIncludes(printed, '__sts_memo_value_');
  assertStringIncludes(printed, 'computeSomething();');
});

Deno.test('hkt macro rewrites interfaces imported from sts:hkt', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { hkt } from 'sts:hkt';",
      "import type { Option } from 'sts:result';",
      '',
      '// #[hkt]',
      'export interface OptionF<A> {',
      '  readonly type: Option<A>;',
      '}',
      '',
    ].join('\n'),
  );

  assertStringIncludes(
    printed,
    'export interface OptionF {',
  );
  assertStringIncludes(printed, 'readonly Args: readonly unknown[];');
  assertStringIncludes(printed, 'readonly type: Option<this["Args"][0]>;');
});

Deno.test('hkt macro rewrites higher-arity interfaces positionally', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { hkt } from 'sts:hkt';",
      '',
      '// #[hkt]',
      'interface ChannelF<R, InErr, InElem, OutErr, OutElem> {',
      '  readonly type: readonly [R, InErr, InElem, OutErr, OutElem];',
      '}',
      '',
    ].join('\n'),
  );

  assertStringIncludes(
    printed,
    'interface ChannelF {',
  );
  assertStringIncludes(printed, 'readonly Args: readonly unknown[];');
  assertStringIncludes(printed, 'readonly type: readonly [');
  assertStringIncludes(printed, 'this["Args"][0]');
  assertStringIncludes(printed, 'this["Args"][4]');
});

Deno.test('hkt macro rejects interface bodies that declare extra members', () => {
  const error = captureStdlibBuiltinMacroError(
    [
      "import { hkt } from 'sts:hkt';",
      "import type { Result } from 'sts:result';",
      '',
      '// #[hkt]',
      'interface ResultF<E, A> {',
      '  readonly type: Result<A, E>;',
      '  readonly tag: string;',
      '}',
      '',
    ].join('\n'),
  );

  assertEquals(error.message, 'hkt requires exactly one `readonly type: ...` member.');
});

Deno.test('Do macro lowers bind sites to generator yields through the stdlib binding', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { Do } from 'sts:typeclasses';",
      "import { ok, resultMonad } from 'sts:result';",
      '',
      'const out = Do(resultMonad<string>(), (bind) => {',
      '  let retries = 0;',
      '  while (retries < 3) {',
      '    const value = bind(ok(retries));',
      '    if (value > 0) return value;',
      '    retries += 1;',
      '    continue;',
      '  }',
      '  return retries;',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'const __sts_do_monad_');
  assertStringIncludes(printed, 'const __sts_do_bind_');
  assertStringIncludes(printed, 'Do.macroBind<');
  assertStringIncludes(printed, 'return Do.macroGen<');
  assertStringIncludes(printed, 'function* (): Generator<');
  assertStringIncludes(printed, 'let __sts_do_effect_');
  assertStringIncludes(printed, 'const value = __sts_do_bind_');
  assertStringIncludes(printed, '= ok(retries)');
  assertStringIncludes(printed, 'yield __sts_do_effect_');
  assertStringIncludes(printed, 'continue;');
  assertStringIncludes(printed, 'return retries;');
});

Deno.test('Do macro evaluates bind operands once through a temp binding', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { Do } from 'sts:typeclasses';",
      "import { ok, resultMonad } from 'sts:result';",
      '',
      'const out = Do(resultMonad<string>(), (bind) => {',
      '  const value = bind(ok(nextValue()));',
      '  return value;',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'let __sts_do_effect_');
  assertStringIncludes(printed, '= ok(nextValue())');
  const loweredSection = printed.slice(printed.indexOf('function* (): Generator<'));
  assertEquals(loweredSection.match(/ok\(nextValue\(\)\)/g)?.length ?? 0, 1);
});

Deno.test('Do macro lowers async callbacks through the stdlib async generator helper', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import type { TypeLambda } from 'sts:hkt';",
      "import { Do, type AsyncMonad } from 'sts:typeclasses';",
      'interface PromiseF extends TypeLambda {',
      "  readonly type: Promise<this['Args'][0]>;",
      '}',
      'declare const promiseMonad: AsyncMonad<PromiseF>;',
      'declare function loadSeed(): Promise<number>;',
      '',
      'const out = Do(promiseMonad, async (bind) => {',
      '  const seed = await loadSeed();',
      '  const value = bind(Promise.resolve(seed));',
      '  return await Promise.resolve(value + 1);',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'return Do.macroGen<');
  assertStringIncludes(printed, 'function* (): Generator<');
  assertStringIncludes(printed, 'const __sts_do_bind_');
  assertStringIncludes(printed, 'Do.macroBind<');
  assertStringIncludes(printed, '.fromPromise(loadSeed())');
  assertStringIncludes(printed, '.fromPromise(Promise.resolve(value + 1))');
  assertStringIncludes(printed, 'const value = __sts_do_bind_');
  assertStringIncludes(printed, 'yield __sts_do_effect_');
  assertStringIncludes(printed, 'return __sts_do_bind_');
});

Deno.test('Do macro lowers for-await-of loops in async callbacks through async iterators', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import type { TypeLambda } from 'sts:hkt';",
      "import { Do, type AsyncMonad } from 'sts:typeclasses';",
      'interface PromiseF extends TypeLambda {',
      "  readonly type: Promise<this['Args'][0]>;",
      '}',
      'declare const promiseMonad: AsyncMonad<PromiseF>;',
      'declare function loadValues(): AsyncIterable<number>;',
      '',
      'const out = Do(promiseMonad, async (bind) => {',
      '  let total = 0;',
      '  for await (const value of loadValues()) {',
      '    total += value;',
      '    if (total > 2) break;',
      '  }',
      '  return total;',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'const __sts_do_async_iterable_');
  assertStringIncludes(printed, 'const __sts_do_async_iterator_');
  assertStringIncludes(printed, 'while (true) {');
  assertStringIncludes(printed, '.next()');
  assertStringIncludes(printed, 'const __sts_do_async_step_');
  assertStringIncludes(printed, 'if (__sts_do_async_step_');
  assertStringIncludes(printed, 'finally {');
  assertStringIncludes(printed, '.return(');
});

Deno.test('Do macro preserves for-loop break and continue control flow', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { Do } from 'sts:typeclasses';",
      "import { ok, resultMonad } from 'sts:result';",
      '',
      'const out = Do(resultMonad<string>(), (bind) => {',
      '  let total = 0;',
      '  for (let i = 0; i < 4; i += 1) {',
      '    const value = bind(ok(i));',
      '    if (value === 0) continue;',
      '    total += value;',
      '    if (total > 2) break;',
      '  }',
      '  return total;',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'for (let i = 0; i < 4; i += 1) {');
  assertStringIncludes(printed, 'let __sts_do_effect_');
  assertStringIncludes(printed, 'const value = __sts_do_bind_');
  assertStringIncludes(printed, '= ok(i)');
  assertStringIncludes(printed, 'yield __sts_do_effect_');
  assertStringIncludes(printed, 'continue;');
  assertStringIncludes(printed, 'break;');
  assertStringIncludes(printed, 'return total;');
});

Deno.test('Do macro preserves switch control flow in the callback body', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { Do } from 'sts:typeclasses';",
      "import { ok, resultMonad } from 'sts:result';",
      '',
      'const out = Do(resultMonad<string>(), (bind) => {',
      '  const value = bind(ok(1));',
      '  switch (value) {',
      '    case 1:',
      '      return bind(ok(value + 1));',
      '    default:',
      '      return 0;',
      '  }',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'switch (value) {');
  assertStringIncludes(printed, 'case 1:');
  assertStringIncludes(printed, 'return __sts_do_bind_');
  assertStringIncludes(printed, '= ok(value + 1)');
  assertStringIncludes(printed, 'yield __sts_do_effect_');
  assertStringIncludes(printed, 'default:');
});

Deno.test('Do macro preserves labeled break and continue control flow', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { Do } from 'sts:typeclasses';",
      "import { ok, resultMonad } from 'sts:result';",
      '',
      'const out = Do(resultMonad<string>(), (bind) => {',
      '  let total = 0;',
      '  outer: for (let i = 0; i < 4; i += 1) {',
      '    const value = bind(ok(i));',
      '    if (value === 0) continue outer;',
      '    total += value;',
      '    break outer;',
      '  }',
      '  return total;',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'outer: for (let i = 0; i < 4; i += 1) {');
  assertStringIncludes(printed, 'continue outer;');
  assertStringIncludes(printed, 'break outer;');
});

Deno.test('Do macro preserves do-while, for-of, for-in, destructuring, and assignment forms', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { Do } from 'sts:typeclasses';",
      "import { ok, resultMonad } from 'sts:result';",
      '',
      'const out = Do(resultMonad<string>(), (bind) => {',
      '  let total = 0;',
      '  do {',
      '    const [left, right] = bind(ok([1, 2] as const));',
      '    total = bind(ok(total + left + right));',
      '  } while (total < 3);',
      '  for (const value of bind(ok([3, 4] as const))) {',
      '    total += value;',
      '  }',
      '  for (const key in bind(ok({ extra: 5 }))) {',
      '    total += key.length;',
      '  }',
      '  return total;',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'do {');
  assertStringIncludes(printed, 'const [left, right] = __sts_do_bind_');
  assertStringIncludes(printed, 'total = __sts_do_bind_');
  assertStringIncludes(printed, '} while (total < 3);');
  assertStringIncludes(printed, 'for (const value of __sts_do_bind_');
  assertStringIncludes(printed, 'for (const key in __sts_do_bind_');
});

Deno.test('Do macro preserves nested helper functions that do not reference bind', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { Do } from 'sts:typeclasses';",
      "import { ok, resultMonad } from 'sts:result';",
      '',
      'const out = Do(resultMonad<string>(), (bind) => {',
      '  const value = bind(ok(1));',
      '  const decorate = (n: number) => n + value;',
      '  function finish(n: number) {',
      '    return decorate(n + 1);',
      '  }',
      '  return finish(2);',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'const decorate = (n: number) => n + value;');
  assertStringIncludes(printed, 'function finish(n: number) {');
  assertStringIncludes(printed, 'return finish(2);');
});

Deno.test('Do macro rejects nested helper functions that reference bind', () => {
  const error = captureStdlibBuiltinMacroError(
    [
      "import { Do } from 'sts:typeclasses';",
      "import { ok, resultMonad } from 'sts:result';",
      '',
      'const out = Do(resultMonad<string>(), (bind) => {',
      '  const finish = () => bind(ok(1));',
      '  return finish();',
      '});',
      '',
    ].join('\n'),
  );

  assertEquals(error.message, 'Do does not allow `bind` inside nested functions.');
});

Deno.test('Do macro preserves try, catch, finally, and throw control flow', () => {
  const { printed } = expandWithStdlibBuiltins(
    [
      "import { Do } from 'sts:typeclasses';",
      "import { ok, resultMonad } from 'sts:result';",
      '',
      'const out = Do(resultMonad<string>(), (bind) => {',
      '  let total = 0;',
      '  try {',
      '    total += bind(ok(1));',
      '    throw new Error("boom");',
      '  } catch (error) {',
      '    total += error instanceof Error ? error.message.length : 0;',
      '  } finally {',
      '    total += 1;',
      '  }',
      '  return total;',
      '});',
      '',
    ].join('\n'),
  );

  assertStringIncludes(printed, 'try {');
  assertStringIncludes(printed, 'total += __sts_do_bind_');
  assertStringIncludes(printed, 'throw new Error("boom");');
  assertStringIncludes(printed, 'catch (error) {');
  assertStringIncludes(printed, 'finally {');
});

Deno.test('Defer macro rewrites trailing statements into a cleanup stack', async () => {
  const { printed } = await expandWithBuiltins(
    [
      'function run(value: number) {',
      '  Defer(() => {',
      '    cleanup(value);',
      '  });',
      '  work(value);',
      '  return value + 1;',
      '}',
      '',
    ].join('\n'),
    {
      Defer,
    },
  );

  assertStringIncludes(printed, 'const __sts_defer_stack_');
  assertStringIncludes(printed, 'try {');
  assertStringIncludes(printed, '__sts_defer_stack_');
  assertStringIncludes(printed, 'push(() => {');
  assertStringIncludes(printed, 'cleanup(value);');
  assertStringIncludes(printed, 'work(value);');
  assertStringIncludes(printed, 'return value + 1;');
  assertStringIncludes(printed, 'finally {');
});

Deno.test('Defer macro rejects module-scope usage', async () => {
  let error: unknown;
  try {
    await expandWithBuiltins('Defer(() => { cleanup(); });\nwork();\n', { Defer });
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(error.message, 'Defer can only be used inside a function or method body.');
});

Deno.test('graphql rewrites template interpolations into GraphQL variables by default', async () => {
  const { printed } = await expandWithBuiltins(
    'const query = graphql`query User { user(id: ${userId}) { name } }`;\n',
    { graphql },
  );

  assertStringIncludes(
    printed,
    'query: "query User { user(id: " + "$ss_graphql_1" + ") { name } }"',
  );
  assertStringIncludes(printed, 'variables: { "ss_graphql_1": userId }');
});

Deno.test('graphql supports explicit raw fragment interpolation helpers', async () => {
  const { printed } = await expandWithBuiltins(
    'const query = graphql`query { ${graphql.raw(selectionSet)} }`;\n',
    { graphql },
  );

  assertStringIncludes(printed, 'query: "query { " + String(selectionSet) + " }"');
  assertStringIncludes(printed, 'variables: {}');
});

Deno.test('assert macro lowers statement-position checks into throw-on-failure guards', async () => {
  const { printed } = await expandWithBuiltins(
    [
      'declare const maybeUser: { name: string } | null;',
      'assert(maybeUser);',
      'const user = maybeUser;',
      '',
    ].join('\n'),
    {
      assert: assertMacro,
    },
  );

  assertStringIncludes(printed, 'if (!(maybeUser)) {');
  assertStringIncludes(printed, 'throw new Error("Assertion failed: maybeUser");');
  assertStringIncludes(printed, 'const user = maybeUser;');
});

Deno.test('assert macro lowers expression-position checks into single-evaluation narrowing thunks', async () => {
  const { printed } = await expandWithBuiltins(
    'const user = assert(maybeUser);\n',
    {
      assert: assertMacro,
    },
  );

  assertStringIncludes(printed, 'const __sts_assert_');
  assertStringIncludes(printed, 'if (!__sts_assert_');
  assertStringIncludes(printed, 'throw new Error("Assertion failed: maybeUser");');
  assertStringIncludes(printed, 'return __sts_assert_');
});

Deno.test('todo macro throws in statement and expression positions', async () => {
  const statement = await expandWithBuiltins('todo();\n', {
    todo: todoMacro,
  });
  assertStringIncludes(statement.printed, 'throw new Error("TODO");');

  const expression = await expandWithBuiltins('const value = todo("later");\n', {
    todo: todoMacro,
  });
  assertStringIncludes(expression.printed, 'throw new Error(`TODO: ${String("later")}`);');
});

Deno.test('unreachable macro throws in statement and expression positions', async () => {
  const statement = await expandWithBuiltins('unreachable();\n', {
    unreachable: unreachableMacro,
  });
  assertStringIncludes(statement.printed, 'throw new Error("Unreachable");');

  const expression = await expandWithBuiltins('const value = unreachable("bad state");\n', {
    unreachable: unreachableMacro,
  });
  assertStringIncludes(
    expression.printed,
    'throw new Error(`Unreachable: ${String("bad state")}`);',
  );
});

Deno.test('Match macro rewrites literal and catch-all array arms', async () => {
  const { printed } = await expandWithBuiltins(
    [
      'declare const value: string;',
      'const result = Match(value, [',
      "  (x: 'a') => 1,",
      '  other => other.length,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, 'const result = (() => {');
  assertStringIncludes(printed, 'const __sts_match_value = (value);');
  assertStringIncludes(printed, 'if (__sts_match_value === "a") {');
  assertStringIncludes(printed, 'return (((other: string) => other.length))(__sts_match_value);');
});

Deno.test('Match macro rejects legacy branch-block syntax', async () => {
  await assertRejects(
    () =>
      expandWithBuiltins(
        'const result = Match(value, { arms: [] });',
        { Match },
      ),
    MacroError,
    'Match only supports: Match(<value>, [ ... ]).',
  );
});

Deno.test('Match macro rewrites typed structural arms', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "type Ok = { tag: 'ok'; value: number };",
      "type Err = { tag: 'err'; error: string };",
      'declare const value: Ok | Err;',
      'const result = Match(value, [',
      '  ({ value }: Ok) => value,',
      '  ({ error }: Err) => error.length,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, 'typeof __sts_match_value === "object"');
  assertStringIncludes(printed, '__sts_match_value !== null');
  assertStringIncludes(printed, '__sts_match_value.tag === "ok"');
  assertStringIncludes(printed, '__sts_match_value.tag === "err"');
  assertStringIncludes(
    printed,
    '(({ value }: Ok) => value)((__sts_match_value as Extract<Ok | Err, {',
  );
  assertStringIncludes(
    printed,
    '(({ error }: Err) => error.length)((__sts_match_value as Extract<Ok | Err, {',
  );
});

Deno.test('Match macro expands when referenced through the always-available prelude surface', () => {
  const { printed } = expandWithStdlibBuiltins([
    "import { type Ok, type Err } from 'sts:prelude';",
    'declare function safeDivide(a: number, b: number): Result<number, string>;',
    'export function divideThreeWays(a: number, b: number): boolean {',
    '  return Match(safeDivide(a, b), [',
    '    ({ value }: Ok<number>) => true,',
    '    ({ error }: Err<string>) => false,',
    '  ]);',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'const __sts_match_value = (safeDivide(a, b));');
  assertStringIncludes(printed, 'if (isOk(__sts_match_value)) {');
  assertStringIncludes(printed, 'if (isErr(__sts_match_value)) {');
  assertStringIncludes(
    printed,
    '(({ value }: Ok<number>) => true)(__sts_match_value);',
  );
  assertStringIncludes(
    printed,
    '(({ error }: Err<string>) => false)(__sts_match_value);',
  );
  assert(!printed.includes('__sts_match_value instanceof Ok'));
  assert(!printed.includes('__sts_match_value instanceof Err'));
  assert(!printed.includes('as Extract<Result<number, string>, Ok<number>>'));
  assert(!printed.includes('as Extract<Result<number, string>, Err<string>>'));
  assert(!printed.includes('__sts_macro_expr('));
});

Deno.test('derive macros expand when imported from the installed runtime derive subpath', () => {
  const { printed } = expandWithInstalledRuntimeStdlibBuiltins([
    "import { eq } from '@soundscript/soundscript/derive';",
    '',
    '// #[eq]',
    'type User = {',
    '  id: string;',
    '};',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'type User = {');
  assertStringIncludes(printed, 'export const UserEq = {');
});

Deno.test('Match macro rewrites explicit instanceof arms', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { Failure } from 'sts:failures';",
      'class NetworkFailure extends Failure {',
      '  constructor(readonly url: string) { super(); }',
      '}',
      'declare const error: Failure;',
      'const result = Match(error, [',
      '  (net: NetworkFailure) => net.url,',
      "  other => 'fallback',",
      ']);',
      '',
  ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value instanceof NetworkFailure');
  assertStringIncludes(printed, '((net: NetworkFailure) => net.url)(__sts_match_value);');
  assertStringIncludes(printed, 'return (((other: Failure) => "fallback"))(__sts_match_value);');
});

Deno.test('Match macro lowers builtin constructor arms through instanceof checks', async () => {
  const { printed } = await expandWithBuiltins(
    [
      'declare const value: unknown;',
      'const result = Match(value, [',
      '  (err: Error) => err.message.length > 0,',
      '  (_) => false,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value instanceof Error');
  assertStringIncludes(
    printed,
    '((err: Error) => err.message.length > 0)(__sts_match_value)',
  );
});

Deno.test('Match macro rewrites nested typed destructuring arms', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "type Ok = { payload: { kind: 'ok'; value: number } };",
      "type Err = { payload: { kind: 'err'; error: string } };",
      'declare const value: Ok | Err;',
      'const result = Match(value, [',
      '  ({ payload: { value } }: Ok) => value,',
      '  ({ payload: { error } }: Err) => error.length,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value.payload.kind === "ok"');
  assertStringIncludes(printed, '__sts_match_value.payload.kind === "err"');
  assertStringIncludes(
    printed,
    '(({ payload: { value } }: Ok) => value)((__sts_match_value as',
  );
  assertStringIncludes(
    printed,
    '(({ payload: { error } }: Err) => error.length)((__sts_match_value as',
  );
});

Deno.test('Match macro rejects untyped shorthand object members in arm annotations', async () => {
  await assertRejects(
    () =>
      expandWithBuiltins(
        [
          "type Result = { tag: 'ok'; value: number } | { tag: 'err'; error: string };",
          'declare const value: Result;',
          'const result = Match(value, [',
          "  (x: { tag: 'ok', value }) => value,",
          "  (x: { tag: 'err'; error: string }) => error.length,",
          ']);',
          '',
        ].join('\n'),
        { Match },
      ),
    MacroError,
    'Match object-type arm annotations do not support untyped shorthand members',
  );
});

Deno.test('Match macro rewrites guarded arms after successful matching', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { where } from 'sts:prelude';",
      "type Ok = { tag: 'ok'; value: number };",
      'declare const value: Ok | undefined;',
      'const result = Match(value, [',
      '  where(({ value }: Ok) => value, ({ value }) => value > 0),',
      '  (_) => 0,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value.tag === "ok"');
  assertStringIncludes(printed, '(({ value }) => value > 0)((__sts_match_value as');
  assertStringIncludes(printed, '(({ value }: Ok) => value)((__sts_match_value as');
});

Deno.test('Match macro accepts exhaustive literal unions without a catch-all arm', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "declare const value: 'a' | 'b';",
      'const result = Match(value, [',
      "  (x: 'a') => 1,",
      "  (x: 'b') => 2,",
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, 'if (__sts_match_value === "a") {');
  assertStringIncludes(printed, 'if (__sts_match_value === "b") {');
});

Deno.test('Match macro accepts exhaustive discriminated unions without a catch-all arm', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "type Ok = { tag: 'ok'; value: number };",
      "type Err = { tag: 'err'; error: string };",
      'declare const value: Ok | Err;',
      'const result = Match(value, [',
      '  ({ value }: Ok) => value,',
      '  ({ error }: Err) => error.length,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value.tag === "ok"');
  assertStringIncludes(printed, '__sts_match_value.tag === "err"');
});

Deno.test('Match macro accepts exhaustive class unions without a catch-all arm', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { Failure } from 'sts:failures';",
      'class NetworkFailure extends Failure {',
      '  constructor(readonly url: string) { super(); }',
      '}',
      'class ParseFailure extends Failure {',
      '  constructor(readonly path: string) { super(); }',
      '}',
      'declare const error: NetworkFailure | ParseFailure;',
      'const result = Match(error, [',
      '  (net: NetworkFailure) => net.url,',
      '  (parse: ParseFailure) => parse.path,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value instanceof NetworkFailure');
  assertStringIncludes(printed, '__sts_match_value instanceof ParseFailure');
});

Deno.test('Match macro accepts exhaustive tuple unions without a catch-all arm', async () => {
  const { printed } = await expandWithBuiltins(
    [
      'declare const value: readonly [1, string] | readonly [2, string];',
      'const result = Match(value, [',
      '  ([tag, text]: readonly [1, string]) => text.length + tag,',
      '  ([tag, text]: readonly [2, string]) => text.length + tag,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(
    printed,
    'if (Array.isArray(__sts_match_value) && __sts_match_value.length >= 2) {',
  );
  assertStringIncludes(printed, '__sts_match_value[0] === 1');
  assertStringIncludes(printed, '__sts_match_value[0] === 2');
});

Deno.test('Match macro accepts exhaustive bounded optional tuple shapes without a catch-all arm', async () => {
  const { printed } = await expandWithBuiltins(
    [
      'declare const value: readonly [1] | readonly [1, string] | readonly [1, string, number];',
      'const result = Match(value, [',
      '  ([tag, text, count]: readonly [1, string, number]) => text.length + count + tag,',
      '  ([tag, text]: readonly [1, string]) => text.length + tag,',
      '  ([tag]: readonly [1]) => tag - 1,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(
    printed,
    'Array.isArray(__sts_match_value) && __sts_match_value.length >= 3',
  );
  assertStringIncludes(
    printed,
    'Array.isArray(__sts_match_value) && __sts_match_value.length >= 2',
  );
  assertStringIncludes(
    printed,
    'Array.isArray(__sts_match_value) && __sts_match_value.length >= 1',
  );
});

Deno.test('Match macro accepts exhaustive nested object unions without a catch-all arm', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "type Ok = { payload: { kind: 'a'; value: number } };",
      "type Err = { payload: { kind: 'b'; error: string } };",
      'declare const value: Ok | Err;',
      'const result = Match(value, [',
      '  ({ payload: { value } }: Ok) => value,',
      '  ({ payload: { error } }: Err) => error.length,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value.payload.kind === "a"');
  assertStringIncludes(printed, '__sts_match_value.payload.kind === "b"');
});

Deno.test('Match macro accepts exhaustive finite object property unions without a catch-all arm', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "declare const value: { tag: 'a' | 'b' };",
      'const result = Match(value, [',
      "  (x: { tag: 'a' }) => 1,",
      "  (x: { tag: 'b' }) => 2,",
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value.tag === "a"');
  assertStringIncludes(printed, '__sts_match_value.tag === "b"');
});

Deno.test('Match macro accepts exhaustive finite tuple element unions without a catch-all arm', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "declare const value: readonly [1 | 2, 'x' | 'y'];",
      'const result = Match(value, [',
      "  (x: readonly [1, 'x']) => 1,",
      "  (x: readonly [1, 'y']) => 2,",
      "  (x: readonly [2, 'x']) => 3,",
      "  (x: readonly [2, 'y']) => 4,",
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value[0] === 1');
  assertStringIncludes(printed, '__sts_match_value[0] === 2');
  assertStringIncludes(printed, '__sts_match_value[1] === "x"');
  assertStringIncludes(printed, '__sts_match_value[1] === "y"');
});

Deno.test('Match macro accepts exhaustive runtime-kind unions without a catch-all arm', async () => {
  const { printed } = await expandWithBuiltins(
    [
      'declare const value: string | number | undefined | (() => void);',
      'const result = Match(value, [',
      '  (text: string) => text.length,',
      '  (n: number) => n + 1,',
      '  (_: undefined) => 0,',
      '  (fn: () => void) => 1,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, 'typeof __sts_match_value === "string"');
  assertStringIncludes(printed, 'typeof __sts_match_value === "number"');
  assertStringIncludes(printed, 'typeof __sts_match_value === "undefined"');
  assertStringIncludes(printed, 'typeof __sts_match_value === "function"');
});

Deno.test('Match macro lowers machine numeric family arms through exact machine-kind checks', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import type { Numeric } from 'sts:numerics';",
      'declare const value: Numeric | string;',
      'const result = Match(value, [',
      '  (n: Numeric) => 1,',
      '  (text: string) => text.length,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__soundscript_numeric_kind === "f64"');
  assertStringIncludes(printed, '__soundscript_numeric_kind === "u64"');
  assertStringIncludes(printed, 'typeof __sts_match_value === "string"');
});

Deno.test('Match macro lowers host number and bigint arms through carrier checks', async () => {
  const { printed } = await expandWithBuiltins(
    [
      'declare const value: number | bigint | string;',
      'const result = Match(value, [',
      '  (n: number) => 1,',
      '  (b: bigint) => 2,',
      '  (text: string) => text.length,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, 'typeof __sts_match_value === "number"');
  assertStringIncludes(printed, 'typeof __sts_match_value === "bigint"');
  assertStringIncludes(printed, 'typeof __sts_match_value === "string"');
});

Deno.test('Match macro rejects legacy numeric family spellings', async () => {
  await assertRejects(
    () =>
      expandWithBuiltins(
        [
          "import type { Numeric } from 'sts:numerics';",
          'declare const value: Numeric;',
          'const result = Match(value, [',
          '  (n: NumberLike) => 1,',
          '  (b: BigintLike) => 2,',
          '  (x: numeric) => 3,',
          '  (_) => 4,',
          ']);',
          '',
        ].join('\n'),
        { Match },
      ),
    MacroError,
    'Match no longer supports legacy NumberLike, BigintLike, or numeric patterns.',
  );
});

Deno.test('Match macro lowers Int and Float machine family arms through exact machine-kind checks', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import type { Float, Int, Numeric } from 'sts:numerics';",
      'declare const value: Numeric | string;',
      'const result = Match(value, [',
      '  (n: Int) => 1,',
      '  (n: Float) => 2,',
      '  (text: string) => text.length,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__soundscript_numeric_kind === "i8"');
  assertStringIncludes(printed, '__soundscript_numeric_kind === "u64"');
  assertStringIncludes(printed, '__soundscript_numeric_kind === "f32"');
  assertStringIncludes(printed, '__soundscript_numeric_kind === "f64"');
  assertStringIncludes(printed, 'typeof __sts_match_value === "string"');
});

Deno.test('Match macro still requires a catch-all arm for variadic tuple types', async () => {
  await assertRejects(
    () =>
      expandWithBuiltins(
        [
          'declare const value: readonly [1, ...string[]];',
          'const result = Match(value, [',
          '  ([head]: readonly [1]) => head - 1,',
          ']);',
          '',
        ].join('\n'),
        { Match },
      ),
    MacroError,
    'Match requires a final catch-all arm unless the scrutinee type is provably exhaustive.',
  );
});

Deno.test('Match macro supports block-bodied array arms with explicit return', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "type Ok = { tag: 'ok'; value: number };",
      'declare const value: Ok | string;',
      'const result = Match(value, [',
      '  ({ value }: Ok) => {',
      '    const rounded = Math.round(value);',
      "    return rounded === 4 ? 'ok:4' : 'ok';",
      '  },',
      "  (_) => 'other',",
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '(({ value }: Ok) => {');
  assertStringIncludes(printed, 'const rounded = Math.round(value);');
  assertStringIncludes(printed, 'return rounded === 4 ? "ok:4" : "ok";');
});

Deno.test('Match macro lowers typed array-arm arrows with a trailing arm array operand', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "interface Ok { type: 'ok'; value: number; }",
      'class MyClass {}',
      'declare const value: Ok | MyClass | string | undefined;',
      'const result = Match(value, [',
      '  ({ value }: Ok) => value,',
      '  (x: MyClass) => false,',
      '  (x: string) => null,',
      '  (_) => undefined,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value.type === "ok"');
  assertStringIncludes(printed, '"value" in __sts_match_value');
  assertStringIncludes(printed, '__sts_match_value instanceof MyClass');
  assertStringIncludes(printed, 'typeof __sts_match_value === "string"');
  assertStringIncludes(printed, '(({ value }: Ok) => value)((__sts_match_value as');
  assertStringIncludes(printed, '((x: MyClass) => false)(__sts_match_value)');
});

Deno.test('Match macro layers guards through where(...) without custom syntax', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { where } from 'sts:prelude';",
      "interface Ok { type: 'ok'; value: number; }",
      'declare const value: Ok | undefined;',
      'const result = Match(value, [',
      '  where(({ value }: Ok) => value, ({ value }) => value > 2),',
      '  (_) => 0,',
      ']);',
      '',
    ].join('\n'),
    { Match },
  );

  assertStringIncludes(printed, '__sts_match_value.type === "ok"');
  assertStringIncludes(printed, '(({ value }) => value > 2)((__sts_match_value as');
  assertStringIncludes(printed, '(({ value }: Ok) => value)((__sts_match_value as');
});

Deno.test('sql rewrites template interpolations into bind parameters by default', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { sql } from 'sts:experimental/sql';",
      'declare const userId: number;',
      'const query = sql`SELECT * FROM users WHERE id = ${userId}`;',
      '',
    ].join('\n'),
    { sql },
  );

  assertStringIncludes(printed, 'text: "SELECT * FROM users WHERE id = " + "$1" + ""');
  assertStringIncludes(printed, 'params: [userId]');
});

Deno.test('sql supports explicit identifier and raw fragment interpolation helpers', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { sql } from 'sts:experimental/sql';",
      'declare const tableName: string;',
      'declare const direction: string;',
      'const query = sql`SELECT * FROM ${sql.ident(tableName)} ORDER BY created_at ${sql.raw(direction)}`;',
      '',
    ].join('\n'),
    { sql },
  );

  assertStringIncludes(printed, 'String(tableName).replaceAll("\\"", "\\"\\"")');
  assertStringIncludes(printed, 'String(direction)');
  assertStringIncludes(printed, 'params: []');
});

Deno.test('css rewrites template interpolations into CSS variable placeholders by default', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { css } from 'sts:experimental/css';",
      'declare const primaryColor: string;',
      'const style = css`button { color: ${primaryColor}; }`;',
      '',
    ].join('\n'),
    { css },
  );

  assertStringIncludes(printed, 'text: "button { color: " + "var(--ss-css-1)" + "; }"');
  assertStringIncludes(printed, 'values: [primaryColor]');
});

Deno.test('css supports explicit raw fragment interpolation helpers', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { css } from 'sts:experimental/css';",
      'declare const className: string;',
      'declare const backgroundCss: string;',
      'const style = css`.${css.raw(className)} { background: ${backgroundCss}; }`;',
      '',
    ].join('\n'),
    { css },
  );

  assertStringIncludes(printed, 'String(className)');
  assertStringIncludes(printed, 'values: [backgroundCss]');
});

Deno.test('Match macro still requires a catch-all arm for open scrutinee types', async () => {
  let error: unknown;
  try {
    await expandWithBuiltins(
      [
        'const result = Match(value, [',
        "  (x: 'a') => 1,",
        "  (x: 'b') => 2,",
        ']);',
        '',
      ].join('\n'),
      { Match },
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(
    error.message,
    'Match requires a final catch-all arm unless the scrutinee type is provably exhaustive.',
  );
});

Deno.test('Match macro does not treat guarded catch-all branches as exhaustive', async () => {
  let error: unknown;
  try {
    await expandWithBuiltins(
      [
        "import { where } from 'sts:prelude';",
        'declare const value: string;',
        'const result = Match(value, [',
        '  where(other => other.length, other => other.length > 0),',
        ']);',
        '',
      ].join('\n'),
      { Match },
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(
    error.message,
    'Match requires a final catch-all arm unless the scrutinee type is provably exhaustive.',
  );
});

Deno.test('logMacro rejects arglist-style multiple operands', async () => {
  const fileName = '/virtual/index.sts';
  const preparedProgram = createPreparedProgramForMacroTest({
    [fileName]: "import { log } from 'sts:experimental/debug';\nconst value = log(input, other);\n",
  });

  let error: unknown;
  try {
    await expandPreparedProgramWithLoadedModules(
      preparedProgram,
      ['macros/log'],
      () => Promise.resolve({ log }),
    );
  } catch (caught) {
    error = caught;
  }

  assert(error instanceof MacroError);
  assertEquals(error.message, 'log only supports: log(<value>).');
  assertEquals(error.filePath, fileName);
});

Deno.test('expandPreparedProgramWithLoadedModules composes Try control-flow rewriting with loaded rewrite macros', async () => {
  const { printed } = await expandWithBuiltins([
    "import { type Result, ok } from 'sts:prelude';",
    'declare function fetchValue(): Result<number, string>;',
    'declare function __sts_log<T>(source: string, value: T): T;',
    '',
    'function compute(): Result<number, string> {',
    '  const value = Try(fetchValue());',
    '  const logged = log(value);',
    '  return ok(logged);',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = __sts_attempt_1_1.value;');
  assertStringIncludes(printed, 'const logged = (() => {');
  assertStringIncludes(printed, 'console.log("value", __sts_log_value_');
  assertStringIncludes(printed, 'return ok(logged);');
  assert(!printed.includes('__sts_macro_expr('));
});

Deno.test('Try macro keeps preceding annotation comments out of the expanded operand text', async () => {
  const { printed } = await expandWithBuiltins([
    "import { type Result, ok } from 'sts:prelude';",
    '// #[extern]',
    'declare function fetchValue(): Result<number, string>;',
    '',
    'function compute(): Result<number, string> {',
    '  const value = Try(fetchValue());',
    '  return ok(value);',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertEquals(printed.includes('fetchValue( // #[extern]'), false);
});

Deno.test('Try macro rewrites assignment-statement sites through the public advanced path', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let value = 0;',
      '  value = Try(fetchValue());',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'let value = 0;');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'value = __sts_attempt_1_1.value;');
  assert(!printed.includes('__sts_macro_expr('));
});

Deno.test('Try macro accepts canonical Option<T> operands through the Result family', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Option, ok } from 'sts:result';",
      'declare function fetchValue(): Option<number>;',
      '',
      'function compute(): Option<number> {',
      '  const value = Try(fetchValue());',
      '  return ok(value + 1);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isNone_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = __sts_attempt_1_1.value;');
  assertStringIncludes(printed, 'return ok(value + 1);');
  assert(!printed.includes('trace: [...('));
});

Deno.test('Try macro accepts unannotated enclosing functions with inferred Result returns', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { err, ok, type Result } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute() {',
      '  const value = Try(fetchValue());',
      '',
      '  if (value > 0) {',
      "    return err('bad');",
      '  }',
      '',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, "return err('bad');");
  assertStringIncludes(printed, 'return ok(value);');
});

Deno.test('Try macro accepts unannotated enclosing functions whose error flow comes only from Try', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { ok, type Result } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute() {',
      '  const value = Try(fetchValue());',
      '  return ok(value + 1);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'return ok(value + 1);');
});

Deno.test('Try macro appends trace frames for canonical Failure error payloads', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      "import { Failure } from 'sts:failures';",
      'class LoadError extends Failure {',
      '  constructor(readonly path: string) {',
      "    super('missing file');",
      '  }',
      '}',
      'declare function fetchValue(): Result<number, LoadError>;',
      '',
      'function compute(): Result<number, LoadError> {',
      '  const value = Try(fetchValue());',
      '  return ok(value + 1);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_runtime_named_err_');
  assertStringIncludes(printed, '__sts_attempt_1_1.error.withFrame({');
  assertStringIncludes(printed, 'file: "/virtual/index.sts"');
  assertStringIncludes(printed, 'column: 17');
  assertStringIncludes(printed, 'fn: "compute"');
  assertStringIncludes(printed, 'return ok(value + 1);');
});

Deno.test('Try macro rewrites call-argument expression sites through the nearest statement', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      'declare function useValue(value: number): number;',
      '',
      'function compute(): Result<number, string> {',
      '  const value = useValue(Try(fetchValue()));',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = useValue(__sts_attempt_1_1.value);');
});

Deno.test('Try macro rewrites return-expression sites through the nearest statement', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      'declare function transform(value: number): number;',
      '',
      'function compute(): Result<number, string> {',
      '  return ok(transform(Try(fetchValue())));',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'return ok(transform(__sts_attempt_1_1.value));');
});

Deno.test('Try macro rewrites while-condition expression sites with per-iteration evaluation', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let count = 0;',
      '  while (Try(fetchFlag())) {',
      '    count += 1;',
      '  }',
      '  return ok(count);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'while (true)');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'if (!__sts_attempt_1_1.value)');
  assertStringIncludes(printed, 'break;');
});

Deno.test('Try macro rewrites switch-expression sites through the nearest statement', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  switch (Try(fetchValue())) {',
      '    case 1:',
      '      return ok(1);',
      '    default:',
      '      return ok(0);',
      '  }',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'switch (__sts_attempt_1_1.value)');
});

Deno.test('Try macro rewrites for-of right-hand expression sites through the nearest statement', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValues(): Result<number[], string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let total = 0;',
      '  for (const value of Try(fetchValues())) {',
      '    total += value;',
      '  }',
      '  return ok(total);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValues();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'for (const value of __sts_attempt_1_1.value)');
});

Deno.test('Try macro rewrites for-in right-hand expression sites through the nearest statement', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchRecord(): Result<Record<string, number>, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let total = 0;',
      '  for (const key in Try(fetchRecord())) {',
      '    total += 1;',
      '  }',
      '  return ok(total);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchRecord();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'for (const key in __sts_attempt_1_1.value)');
});

Deno.test('Try macro rewrites do-while condition sites with post-body evaluation', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let count = 0;',
      '  do {',
      '    count += 1;',
      '  } while (Try(fetchFlag()));',
      '  return ok(count);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'while (true)');
  assertStringIncludes(printed, 'count += 1;');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'if (!__sts_attempt_1_1.value)');
  assertStringIncludes(printed, 'break;');
});

Deno.test('Try macro preserves continue semantics in do-while condition rewrites', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let count = 0;',
      '  do {',
      '    count += 1;',
      '    if (count < 2) continue;',
      '  } while (Try(fetchFlag()));',
      '  return ok(count);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, '__sts_continue_');
  assertStringIncludes(printed, 'break __sts_continue_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
});

Deno.test('Try macro preserves labeled continue semantics in labeled do-while condition rewrites', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let count = 0;',
      '  outer: do {',
      '    count += 1;',
      '    if (count < 2) continue outer;',
      '  } while (Try(fetchFlag()));',
      '  return ok(count);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'outer: while (true)');
  assertStringIncludes(printed, '__sts_continue_');
  assertStringIncludes(printed, 'break __sts_continue_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
});

Deno.test('Try macro preserves labeled continue semantics in labeled while-condition rewrites', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let count = 0;',
      '  outer: while (Try(fetchFlag())) {',
      '    count += 1;',
      '    if (count < 2) continue outer;',
      '  }',
      '  return ok(count);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'outer: while (true)');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
  assertStringIncludes(printed, 'continue outer;');
});

Deno.test('Try macro rewrites classic for-condition sites with per-iteration evaluation', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let count = 0;',
      '  for (; Try(fetchFlag()); ) {',
      '    count += 1;',
      '  }',
      '  return ok(count);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'while (true)');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'if (!__sts_attempt_1_1.value)');
  assertStringIncludes(printed, 'break;');
});

Deno.test('Try macro preserves increment and continue semantics in classic for-condition rewrites', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let count = 0;',
      '  for (let i = 0; Try(fetchFlag()); i += 1) {',
      '    if (i < 2) continue;',
      '    count += i;',
      '  }',
      '  return ok(count);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'let i = 0;');
  assertStringIncludes(printed, '__sts_continue_');
  assertStringIncludes(printed, 'break __sts_continue_');
  assertStringIncludes(printed, 'i += 1;');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
});

Deno.test('Try macro preserves labeled continue semantics in labeled classic for-condition rewrites', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let count = 0;',
      '  outer: for (let i = 0; Try(fetchFlag()); i += 1) {',
      '    if (i < 2) continue outer;',
      '    count += i;',
      '  }',
      '  return ok(count);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'outer: while (true)');
  assertStringIncludes(printed, '__sts_continue_');
  assertStringIncludes(printed, 'break __sts_continue_');
  assertStringIncludes(printed, 'i += 1;');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
});

Deno.test('Try macro preserves loop labels when classic for-condition rewrites hoist the initializer', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  outer: for (let i = 0; Try(fetchFlag()); i += 1) {',
      '    if (i < 2) continue outer;',
      '  }',
      '  return ok(1);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'let i = 0;');
  assertStringIncludes(printed, 'outer: while (true)');
  assertStringIncludes(printed, '__sts_continue_');
  assertStringIncludes(printed, 'break __sts_continue_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
});

Deno.test('Try macro rewrites classic for-expression-initializer sites before entering the loop', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function start(): Result<number, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  let current = 0;',
      '  for (current = Try(start()); current < 3; current += 1) {',
      '    current += 0;',
      '  }',
      '  return ok(current);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = start();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'current = __sts_attempt_1_1.value;');
  assertStringIncludes(printed, 'while (true)');
});

Deno.test('Try macro rewrites classic for-variable-initializer sites before entering the loop', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function start(): Result<number, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  for (let i = Try(start()); i < 3; i += 1) {',
      '    if (i < 1) continue;',
      '  }',
      '  return ok(1);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = start();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'let i = __sts_attempt_1_1.value;');
  assertStringIncludes(printed, 'while (true)');
});

Deno.test('Try macro rewrites classic for-increment sites after the loop body', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function advance(): Result<number, string>;',
      '',
      'function compute(): Result<number, string> {',
      '  for (let i = 0; i < 3; i = Try(advance())) {',
      '    if (i < 1) continue;',
      '  }',
      '  return ok(1);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'let i = 0;');
  assertStringIncludes(printed, '__sts_continue_');
  assertStringIncludes(printed, 'break __sts_continue_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = advance();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'i = __sts_attempt_1_1.value;');
});

Deno.test('Try macro rewrites logical-right-hand expression sites with short-circuit preservation', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      '',
      'function compute(flag: boolean): Result<boolean, string> {',
      '  const value = flag && Try(fetchFlag());',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_left_');
  assertStringIncludes(printed, 'if (__sts_left_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'value = __sts_expr_');
});

Deno.test('Try macro rewrites nested logical-right-hand expressions inside call arguments', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      'declare function useValue(value: boolean): boolean;',
      '',
      'function compute(flag: boolean): Result<boolean, string> {',
      '  const value = useValue(flag && Try(fetchFlag()));',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_left_');
  assertStringIncludes(printed, 'if (__sts_left_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = useValue(__sts_expr_');
});

Deno.test('Try macro rewrites nested logical-right-hand expressions inside optional-call arguments', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchFlag(): Result<boolean, string>;',
      'declare const target: { method(value: boolean): boolean } | undefined;',
      '',
      'function compute(flag: boolean): Result<boolean | undefined, string> {',
      '  const value = target?.method(flag && Try(fetchFlag()));',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_chain_');
  assertStringIncludes(printed, 'if (__sts_chain_');
  assertStringIncludes(printed, 'const __sts_left_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchFlag();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, '.method(__sts_expr_');
});

Deno.test('Try macro rewrites concise arrow-body expression sites into block bodies', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'const compute = (): Result<number, string> => ok(Try(fetchValue()));',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const compute = (): Result<number, string> => {');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'return ok(__sts_attempt_1_1.value);');
});

Deno.test('Try macro rejects non-expression invocation forms', async () => {
  const error = await captureTryMacroError([
    "import { type Result, ok } from 'sts:prelude';",
    'function compute(): Result<number, string> {',
    '  const value = Try(() => 1);',
    '  void value;',
    '  return ok(1);',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try requires a direct Result, Option, or nullish carrier.',
  );
});

Deno.test('Try macro rewrites ternary-arm expression sites with branch-local preservation', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute(flag: boolean): Result<number, string> {',
      '  const value = flag ? Try(fetchValue()) : 1;',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'let __sts_expr_');
  assertStringIncludes(printed, 'if (flag)');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, '__sts_expr_');
  assertStringIncludes(printed, 'const value = __sts_expr_');
});

Deno.test('Try macro rewrites ternary-false-arm expression sites with branch-local preservation', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      '',
      'function compute(flag: boolean): Result<number, string> {',
      '  const value = flag ? 1 : Try(fetchValue());',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'let __sts_expr_');
  assertStringIncludes(printed, 'if (flag)');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = __sts_expr_');
});

Deno.test('Try macro rewrites optional-chain base expression sites', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchUser(): Result<{ name: string }, string>;',
      '',
      'function compute(): Result<string | undefined, string> {',
      '  const value = (Try(fetchUser()))?.name;',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchUser();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = (__sts_attempt_1_1.value)?.name;');
});

Deno.test('Try macro rewrites optional-element-chain base expression sites', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchItems(): Result<string[] | undefined, string>;',
      '',
      'function compute(): Result<string | undefined, string> {',
      '  const value = (Try(fetchItems()))?.[0];',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchItems();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const __sts_chain_');
  assertStringIncludes(printed, 'if (__sts_chain_');
  assertStringIncludes(printed, '[0];');
  assertStringIncludes(printed, 'const value = __sts_expr_');
});

Deno.test('Try macro rewrites optional-call-chain base expression sites', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchCallback(): Result<(() => number) | undefined, string>;',
      '',
      'function compute(): Result<number | undefined, string> {',
      '  const value = (Try(fetchCallback()))?.();',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchCallback();');
  assertStringIncludes(printed, 'if (__sts_runtime_named_isErr_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const __sts_chain_');
  assertStringIncludes(printed, 'if (__sts_chain_');
  assertStringIncludes(printed, '__sts_expr_');
  assertStringIncludes(printed, 'const value = __sts_expr_');
});

Deno.test('Try macro rewrites optional-element-index expression sites with nullish short-circuit preservation', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchKey(): Result<string, string>;',
      'declare const target: Record<string, number> | undefined;',
      '',
      'function compute(): Result<number | undefined, string> {',
      '  const value = target?.[Try(fetchKey())];',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_chain_');
  assertStringIncludes(printed, 'if (__sts_chain_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchKey();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, '[__sts_attempt_1_1.value]');
});

Deno.test('Try macro rewrites optional-method-call argument sites with nullish short-circuit preservation', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      'declare const target: { method(value: number): number } | null;',
      '',
      'function compute(): Result<number | undefined, string> {',
      '  const value = target?.method(Try(fetchValue()));',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_chain_');
  assertStringIncludes(printed, 'if (__sts_chain_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, '.method(__sts_attempt_1_1.value)');
});

Deno.test('Try macro rewrites optional-direct-call argument sites with nullish short-circuit preservation', async () => {
  const { printed } = await expandWithBuiltins(
    [
      "import { type Result, ok } from 'sts:prelude';",
      'declare function fetchValue(): Result<number, string>;',
      'declare const target: ((value: number) => number) | undefined;',
      '',
      'function compute(): Result<number | undefined, string> {',
      '  const value = target?.(Try(fetchValue()));',
      '  return ok(value);',
      '}',
      '',
    ].join('\n'),
    { Try },
  );

  assertStringIncludes(printed, 'const __sts_chain_');
  assertStringIncludes(printed, 'if (__sts_chain_');
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, '__sts_attempt_1_1.value);');
});

Deno.test('Try macro expands operands that contain nested rewrite macros', async () => {
  const { printed } = await expandWithBuiltins([
    "import { type Result, ok } from 'sts:prelude';",
    'declare function fetchValue(value: number): Result<number, string>;',
    'declare function __sts_log<T>(source: string, value: T): T;',
    '',
    'function compute(): Result<number, string> {',
    '  const value = Try(fetchValue(log(1)));',
    '  return ok(value);',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'fetchValue((() => {');
  assertStringIncludes(printed, 'console.log("1", __sts_log_value_');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = __sts_attempt_1_1.value;');
});

Deno.test('Try macro expands operands that contain nested control-flow macro invocations', async () => {
  const { printed } = await expandWithBuiltins([
    "import { type Result, ok } from 'sts:prelude';",
    'declare function fetchInner(): Result<number, string>;',
    'declare function fetchOuter(value: number): Result<number, string>;',
    '',
    'function compute(): Result<number, string> {',
    '  const value = Try(fetchOuter(Try(fetchInner())));',
    '  return ok(value);',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'const __sts_attempt_1_1__nested_1 = fetchInner();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1__nested_1;');
  assertStringIncludes(
    printed,
    'const __sts_nested_result__nested_1 = fetchOuter(__sts_attempt_1_1__nested_1.value);',
  );
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = __sts_nested_result__nested_1;');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = __sts_attempt_1_1.value;');
});

Deno.test('Try macro expands nested control-flow operands inside async Result functions', async () => {
  const { printed } = await expandWithBuiltins([
    "import { type Result, ok } from 'sts:prelude';",
    'declare function fetchInner(): Promise<Result<number, string>>;',
    'declare function fetchOuter(value: number): Promise<Result<number, string>>;',
    '',
    'async function compute(): Promise<Result<number, string>> {',
    '  const value = Try(await fetchOuter(Try(await fetchInner())));',
    '  return ok(value);',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'const __sts_attempt_1_1__nested_1 = await fetchInner();');
  assertStringIncludes(printed, 'return __sts_attempt_1_1__nested_1;');
  assertStringIncludes(
    printed,
    'const __sts_nested_result__nested_1 = await fetchOuter(__sts_attempt_1_1__nested_1.value);',
  );
  assertStringIncludes(printed, 'const __sts_attempt_1_1 = __sts_nested_result__nested_1;');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = __sts_attempt_1_1.value;');
});

Deno.test('Try macro rejects multi-declaration variable statements in v1', async () => {
  const error = await captureTryMacroError([
    "import { type Result, ok } from 'sts:prelude';",
    'declare function fetchValue(): Result<number, string>;',
    '',
    'function compute(): Result<number, string> {',
    '  const before = 1, value = Try(fetchValue());',
    '  return ok(value);',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try currently only supports declarations with a single variable declarator.',
  );
});

Deno.test('Try macro rejects use outside a function body', async () => {
  const error = await captureTryMacroError([
    "import { type Result } from 'sts:prelude';",
    'declare function fetchValue(): Result<number, string>;',
    'const value = Try(fetchValue());',
    '',
  ].join('\n'));

  assertEquals(error.message, 'Try can only be used inside a function or method body.');
});

Deno.test('Try macro preserves explicit await operands in async functions', async () => {
  const { printed } = await expandWithBuiltins([
    "import { type Result, ok } from 'sts:prelude';",
    'declare function fetchValue(): Promise<Result<number, string>>;',
    '',
    'async function compute(): Promise<Result<number, string>> {',
    '  const value = Try(await fetchValue());',
    '  return ok(value);',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = await fetchValue();');
  assert(!printed.includes('await await'));
});

Deno.test('Try macro rejects generators in v1', async () => {
  const error = await captureTryMacroError([
    "import { type Result, ok } from 'sts:prelude';",
    'declare function fetchValue(): Result<number, string>;',
    '',
    'function* compute(): Result<number, string> {',
    '  const value = Try(fetchValue());',
    '  return ok(value);',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try does not yet support generators or yield-based Result flows.',
  );
});

Deno.test('Try macro rejects implicit Promise<Result<...>> operands', async () => {
  const error = await captureTryMacroError([
    "import { type Result, ok } from 'sts:prelude';",
    'declare function fetchValue(): Promise<Result<number, string>>;',
    '',
    'async function compute(): Promise<Result<number, string>> {',
    '  const value = Try(fetchValue());',
    '  return ok(value);',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try requires a direct Result, Option, or nullish carrier. Await Promises explicitly before calling Try.',
  );
});

Deno.test('Try macro unwraps nullish operands and returns early with the observed nullish value', async () => {
  const { printed } = await expandWithBuiltins([
    'declare function fetchValue(): number | null | undefined;',
    '',
    'function compute(): number | null | undefined {',
    '  const value = Try(fetchValue());',
    '  return value + 1;',
    '}',
    '',
  ].join('\n'));

  assertStringIncludes(printed, 'const __sts_attempt_1_1 = fetchValue();');
  assertStringIncludes(printed, 'if (__sts_attempt_1_1 == null) {');
  assertStringIncludes(printed, 'return __sts_attempt_1_1;');
  assertStringIncludes(printed, 'const value = __sts_attempt_1_1;');
});

Deno.test('Try macro rejects enclosing returns that cannot return undefined for undefined carriers', async () => {
  const error = await captureTryMacroError([
    'declare function fetchValue(): number | undefined;',
    '',
    'function compute(): number {',
    '  const value = Try(fetchValue());',
    '  return value;',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try cannot return this nullish value from the enclosing function.',
  );
});

Deno.test('Try macro rejects operands that are not supported carriers', async () => {
  const error = await captureTryMacroError([
    'declare function fetchValue(): number;',
    '',
    'function compute(): number {',
    '  const value = Try(fetchValue());',
    '  return value;',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try requires a direct Result, Option, or nullish carrier.',
  );
});

Deno.test('Try macro rejects enclosing returns that are not canonical Result', async () => {
  const error = await captureTryMacroError([
    "import { type Result } from 'sts:prelude';",
    'declare function fetchValue(): Result<number, string>;',
    '',
    'function compute(): number {',
    '  const value = Try(fetchValue());',
    '  return value;',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try requires the enclosing function, standalone helper, or object-literal method to return soundscript Result<Ok, Err>.',
  );
});

Deno.test('Try macro rejects async enclosing returns that are not Promise<Result<...>> for Result carriers', async () => {
  const error = await captureTryMacroError([
    "import { type Result } from 'sts:prelude';",
    'declare function fetchValue(): Promise<Result<number, string>>;',
    '',
    'async function compute(): Promise<number> {',
    '  const value = Try(await fetchValue());',
    '  return value;',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try requires async functions, standalone helpers, and object-literal methods to return Promise<soundscript Result<Ok, Err>>.',
  );
});

Deno.test('Try macro rejects object-literal methods that do not return canonical Result', async () => {
  const error = await captureTryMacroError([
    "import { type Result } from 'sts:prelude';",
    'declare function fetchValue(): Result<number, string>;',
    '',
    'const service = {',
    '  compute(): number {',
    '    const value = Try(fetchValue());',
    '    return value;',
    '  },',
    '};',
    '',
    'void service;',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try requires the enclosing function, standalone helper, or object-literal method to return soundscript Result<Ok, Err>.',
  );
});

Deno.test('Try macro rejects incompatible operand error types', async () => {
  const error = await captureTryMacroError([
    "import { type Result, ok } from 'sts:prelude';",
    'declare function fetchValue(): Result<number, number>;',
    '',
    'function compute(): Result<number, string> {',
    '  const value = Try(fetchValue());',
    '  return ok(value);',
    '}',
    '',
  ].join('\n'));

  assertEquals(
    error.message,
    'Try cannot return this error type from the enclosing function.',
  );
});
