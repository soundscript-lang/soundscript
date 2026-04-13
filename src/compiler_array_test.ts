import { assertEquals, assertStrictEquals, assertStringIncludes } from '@std/assert';

import {
  compileTempProject,
  createCompilerTestProject,
} from '../tests/support/compiler_object_test_helpers.ts';
import {
  createIsolatedTestRegistrar,
  createTempProject,
  instantiateCompiledModuleInJs,
  invokeCompiledEntry,
  lowerTempProjectToCompilerIR,
  readWatArtifact,
  resolveQualifiedExportName,
} from '../tests/support/compiler_test_helpers.ts';

const compilerArrayTest = createIsolatedTestRegistrar(import.meta.url);

compilerArrayTest(
  'compileProject passes user-authored class array literals through internal helper params and returns',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'function build(left: number, right: number): Box[] {',
      '  return [new Box(left), new Box(right)];',
      '}',
      '',
      'function pick(values: Box[], index: number): Box {',
      '  return values[index];',
      '}',
      '',
      'export function main(left: number, right: number, index: number): number {',
      '  return pick(build(left, right), index).get();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const build = moduleIR.functions.find((func) => func.name === 'build');
    const pick = moduleIR.functions.find((func) => func.name === 'pick');
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      left: number,
      right: number,
      index: number,
    ) => number;

    assertEquals(build?.resultType, 'owned_heap_array_ref');
    assertEquals(pick?.params[0]?.type, 'owned_heap_array_ref');
    assertEquals(
      (pick?.body[0] as {
        value?: { kind?: string };
      } | undefined)?.value?.kind,
      'owned_heap_array_element',
    );
    assertEquals(main(11, 29, 0), 11);
    assertEquals(main(11, 29, 1), 29);
  },
);

compilerArrayTest('compileProject mutates local class arrays through indexed writes', async () => {
  const tempDirectory = await createCompilerTestProject([
    'class Box {',
    '  value = 0;',
    '',
    '  constructor(value: number) {',
    '    this.value = value;',
    '  }',
    '',
    '  get(): number {',
    '    return this.value;',
    '  }',
    '}',
    '',
    'export function main(index: number, replacement: number): number {',
    '  const values: Box[] = [new Box(3), new Box(5)];',
    '  values[index] = new Box(replacement);',
    '  return values[0].get() * 10 + values[1].get();',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
  const mainFunction = moduleIR.functions.find((func) => func.name === 'main');
  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const main = instance.exports[exportName] as (index: number, replacement: number) => number;

  assertEquals(
    mainFunction?.body.some((statement) => statement.kind === 'owned_heap_array_set'),
    true,
  );
  assertEquals(main(0, 9), 95);
  assertEquals(main(1, 9), 39);
});

compilerArrayTest('compileProject executes for-of loops over owned number arrays', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  let total = 0;',
    '  for (const value of [1, 2, 3]) {',
    '    total = total + value;',
    '  }',
    '  return total;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 6);
});

compilerArrayTest(
  'compileProject executes numeric += inside for-of loops over owned number arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  for (const value of [1, 2, 3]) {',
      '    total += value;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 6);
  },
);

compilerArrayTest(
  'compileProject executes for-of loop bindings captured by nested closures over owned number arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  let readLast = (): number => 0;',
      '  for (const value of [2, 4]) {',
      '    const read = (): number => value;',
      '    total += read();',
      '    readLast = read;',
      '  }',
      '  return total * 10 + readLast();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 64);
  },
);

compilerArrayTest(
  'compileProject executes for-of heap loop bindings captured by nested closures',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): number {',
      '  let total = 0;',
      '  let readLast = (): number => 0;',
      '  for (const box of values) {',
      '    const read = (): number => box.get();',
      '    total += read();',
      '    readLast = read;',
      '  }',
      '  return total * 10 + readLast();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([{ value: 2 }, { value: 4 }]), 64);
  },
);

compilerArrayTest(
  'compileProject executes array binding patterns with defaults over owned number arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  const [first = 0, second = 0] = values;',
      '  return first + second;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([2, 4]), 6);
    assertEquals(exported([2]), 2);
    assertEquals(exported([]), 0);
  },
);

compilerArrayTest(
  'compileProject executes array binding patterns with trailing rest over owned number arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  const [first = 0, ...rest] = values;',
      '  return first * 10 + rest.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([4, 5, 6]), 42);
    assertEquals(exported([4]), 40);
    assertEquals(exported([]), 0);
  },
);

compilerArrayTest(
  'compileProject executes array destructuring assignments over existing locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  let first = 0;',
      '  let second = 0;',
      '  [first, second] = values;',
      '  return first + second;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([2, 4]), 6);
  },
);

compilerArrayTest(
  'compileProject executes array destructuring assignments with defaults over existing locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  let first = 10;',
      '  let second = 20;',
      '  [first = 1, second = 2] = values;',
      '  return first + second;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([2, 4]), 6);
    assertEquals(exported([2]), 4);
    assertEquals(exported([]), 3);
  },
);

compilerArrayTest(
  'compileProject executes array destructuring assignments with defaults over captured locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  let first = 10;',
      '  let second = 20;',
      '  const read = (): number => first * 10 + second;',
      '  [first = 1, second = 2] = values;',
      '  return read();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([2, 4]), 24);
    assertEquals(exported([2]), 22);
    assertEquals(exported([]), 12);
  },
);

compilerArrayTest(
  'compileProject executes object binding patterns inside for-of loops over class arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value: number;',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): number {',
      '  let total = 0;',
      '  for (const { value } of values) {',
      '    total += value;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([{ value: 2 }, { value: 4 }]), 6);
  },
);

compilerArrayTest(
  'compileProject executes captured object binding patterns inside for-of loops over class arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value: number;',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): number {',
      '  let total = 0;',
      '  let readLast = (): number => 0;',
      '  for (const { value } of values) {',
      '    const read = (): number => value;',
      '    total += read();',
      '    readLast = read;',
      '  }',
      '  return total * 10 + readLast();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([{ value: 2 }, { value: 4 }]), 64);
  },
);

compilerArrayTest(
  'compileProject executes object binding patterns with defaults inside for-of loops over bag-like object arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Array<Record<string, number | undefined>>): number {',
      '  let total = 0;',
      '  for (const { left = 0, right = 0 } of values) {',
      '    total += left + right;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([{ left: 2 }, { left: 1, right: 3 }]), 6);
  },
);

compilerArrayTest(
  'compileProject executes captured object binding patterns with defaults inside for-of loops over bag-like object arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Array<Record<string, number | undefined>>): number {',
      '  let total = 0;',
      '  let readLast = (): number => 0;',
      '  for (const { left = 0, right = 0 } of values) {',
      '    const read = (): number => left + right;',
      '    total += read();',
      '    readLast = read;',
      '  }',
      '  return total * 10 + readLast();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([{ left: 2 }, { left: 1, right: 3 }]), 64);
  },
);

compilerArrayTest(
  'compileProject executes object binding callback params over class arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Item {',
      '  value: number;',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(values: Item[]): number {',
      '  const found = values.find(({ value }, index) => value === index + 3);',
      '  if (found === undefined) {',
      '    return -1;',
      '  }',
      '  return found.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([{ value: 1 }, { value: 3 }, { value: 5 }]), 5);
  },
);

compilerArrayTest(
  'compileProject executes object binding callback params over bag-like object arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Item = {',
      '  [key: string]: number;',
      '  value: number;',
      '};',
      '',
      'export function main(values: Item[]): number {',
      '  let total = 0;',
      '  values.forEach(({ value }, index): undefined => {',
      '    total += value + index;',
      '    return undefined;',
      '  });',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([{ value: 1 }, { value: 2 }, { value: 4 }]), 10);
  },
);

compilerArrayTest(
  'compileProject executes exported function params with array binding patterns and defaults',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main([first = 0, second = 0]: number[]): number {',
      '  return first + second;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([3, 4]), 7);
    assertEquals(exported([3]), 3);
    assertEquals(exported([]), 0);
  },
);

compilerArrayTest(
  'compileProject executes same-file helper params with array binding patterns and defaults',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function sum([first = 0, second = 0]: number[]): number {',
      '  return first + second;',
      '}',
      '',
      'export function main(values: number[]): number {',
      '  return sum(values);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([5]), 5);
    assertEquals(exported([5, 6]), 11);
  },
);

compilerArrayTest(
  'compileProject executes local function params with array binding patterns and defaults',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  function sum([first = 0, second = 0]: number[]): number {',
      '    return first + second;',
      '  }',
      '  return sum(values);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([8]), 8);
    assertEquals(exported([8, 2]), 10);
  },
);

compilerArrayTest(
  'compileProject adapts exported class array results through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function build(left: number, right: number): Box[] {',
      '  return [new Box(left), new Box(right)];',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const build = instance.exports[await resolveQualifiedExportName(tempDirectory, 'build')] as (
      left: number,
      right: number,
    ) => Array<{ get(): number }>;

    const values = build(3, 5);
    assertEquals(Array.isArray(values), true);
    assertEquals(values.length, 2);
    assertEquals(values[0]?.get(), 3);
    assertEquals(values[1]?.get(), 5);
  },
);

compilerArrayTest(
  'compileProject adapts exported bag-like object array results through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Box = {',
      '  value: number;',
      '  run(step: number): number;',
      '};',
      '',
      'export function build(left: number, right: number): Box[] {',
      '  const first: Box = {',
      '    value: left,',
      '    run(step: number): number {',
      '      return this.value + step;',
      '    },',
      '  };',
      '  const second: Box = {',
      '    value: right,',
      '    run(step: number): number {',
      '      return this.value + step;',
      '    },',
      '  };',
      '  return [first, second];',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const build = instance.exports[await resolveQualifiedExportName(tempDirectory, 'build')] as (
      left: number,
      right: number,
    ) => Array<{ run(step: number): number }>;

    const values = build(3, 5);
    assertEquals(Array.isArray(values), true);
    assertEquals(values.length, 2);
    assertEquals(values[0]?.run(4), 7);
    assertEquals(values[1]?.run(6), 11);
  },
);

compilerArrayTest(
  'compileProject adapts exported base-typed subclass array results through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Base {',
      '  value = 0;',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'class Derived extends Base {}',
      '',
      'export function build(left: number, right: number): Base[] {',
      '  const first: Base = new Derived();',
      '  first.value = left;',
      '  const second: Base = new Derived();',
      '  second.value = right;',
      '  return [first, second];',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const build = instance.exports[await resolveQualifiedExportName(tempDirectory, 'build')] as (
      left: number,
      right: number,
    ) => Array<{ get(): number }>;

    const values = build(8, 13);
    assertEquals(Array.isArray(values), true);
    assertEquals(values.length, 2);
    assertEquals(values[0]?.get(), 8);
    assertEquals(values[1]?.get(), 13);
  },
);

compilerArrayTest(
  'compileProject adapts exported class array params through JS array boundaries and methods',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  run(value: number): number {',
      '    return this.offset + value;',
      '  }',
      '}',
      '',
      'export function apply(values: Box[], index: number, value: number): number {',
      '  return values[index].run(value);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const apply = instance.exports[await resolveQualifiedExportName(tempDirectory, 'apply')] as (
      values: Array<{ offset: number }>,
      index: number,
      value: number,
    ) => number;

    assertEquals(apply([{ offset: 5 }, { offset: 8 }], 0, 2), 7);
    assertEquals(apply([{ offset: 5 }, { offset: 8 }], 1, 3), 11);
  },
);

compilerArrayTest(
  'compileProject copies back exported class array param mutations through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  bump(step: number): number {',
      '    this.value = this.value + step;',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function mutate(values: Box[], step: number, replacement: number): Box[] {',
      '  values[0].bump(step);',
      '  values[1] = new Box();',
      '  values[1].value = replacement;',
      '  return values;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const mutate = instance.exports[await resolveQualifiedExportName(tempDirectory, 'mutate')] as (
      values: Array<{ value: number }>,
      step: number,
      replacement: number,
    ) => Array<{ value: number }>;

    const first = { value: 3 };
    const second = { value: 5 };
    const values = [first, second];
    const resultValues = mutate(values, 4, 9);

    assertStrictEquals(resultValues, values);
    assertStrictEquals(resultValues[0], first);
    assertEquals(first.value, 7);
    assertEquals(resultValues[0]?.value, 7);
    assertEquals(resultValues[1]?.value, 9);
    assertEquals(resultValues[1] === second, false);
  },
);

compilerArrayTest(
  'compileProject preserves local class-array aliases across push growth',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const values: Box[] = [new Box(3)];',
      '  const alias = values;',
      '  const nextLength = values.push(new Box(5), new Box(8));',
      '  return nextLength + alias[1].get() + alias[2].get();',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3 + 5 + 8);
  },
);

compilerArrayTest(
  'compileProject copies back exported class array push mutations through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function append(values: Box[], left: number, right: number): Box[] {',
      '  const nextLength = values.push(new Box(left), new Box(right));',
      '  values[0].value = nextLength;',
      '  return values;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const append = instance.exports[await resolveQualifiedExportName(tempDirectory, 'append')] as (
      values: Array<{ value: number; get(): number }>,
      left: number,
      right: number,
    ) => Array<{ value: number; get(): number }>;

    const first = {
      value: 1,
      get() {
        return this.value;
      },
    };
    const values = [first];
    const resultValues = append(values, 7, 9);

    assertStrictEquals(resultValues, values);
    assertStrictEquals(resultValues[0], first);
    assertEquals(first.value, 3);
    assertEquals(resultValues[1]?.get(), 7);
    assertEquals(resultValues[2]?.get(), 9);
  },
);

compilerArrayTest(
  'compileProject preserves local class-array aliases across unshift growth',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const values: Box[] = [new Box(8)];',
      '  const alias = values;',
      '  const nextLength = values.unshift(new Box(3), new Box(5));',
      '  return nextLength + alias[0].get() + alias[1].get();',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3 + 3 + 5);
  },
);

compilerArrayTest(
  'compileProject copies back exported class array unshift mutations through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function prepend(values: Box[], left: number, right: number): Box[] {',
      '  const nextLength = values.unshift(new Box(left), new Box(right));',
      '  values[2].value = nextLength;',
      '  return values;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const prepend = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'prepend')] as (
        values: Array<{ value: number; get(): number }>,
        left: number,
        right: number,
      ) => Array<{ value: number; get(): number }>;

    const first = {
      value: 8,
      get() {
        return this.value;
      },
    };
    const values = [first];
    const resultValues = prepend(values, 3, 5);

    assertStrictEquals(resultValues, values);
    assertStrictEquals(resultValues[2], first);
    assertEquals(resultValues[0]?.get(), 3);
    assertEquals(resultValues[1]?.get(), 5);
    assertEquals(first.value, 3);
  },
);

compilerArrayTest(
  'compileProject preserves heap object identity in exported class array results sourced from host params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function duplicate(values: Box[]): Box[] {',
      '  return [values[0], values[0]];',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const duplicate = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'duplicate')] as (
        values: Array<{ value: number }>,
      ) => Array<{ value: number }>;

    const first = { value: 3 };
    const returned = duplicate([first]);

    assertEquals(returned.length, 2);
    assertStrictEquals(returned[0], returned[1]);
    assertStrictEquals(returned[0], first);
  },
);

compilerArrayTest(
  'compileProject preserves repeated heap object identity in exported class array results without host inputs',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function duplicate(value: number): Box[] {',
      '  const box = new Box(value);',
      '  return [box, box];',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const duplicate = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'duplicate')] as (
        value: number,
      ) => Array<{ value: number }>;

    const returned = duplicate(7);

    assertEquals(returned.length, 2);
    assertStrictEquals(returned[0], returned[1]);
    assertEquals(returned[0]?.value, 7);
  },
);

compilerArrayTest(
  'compileProject pops owned class arrays through internal tagged results and exported mutation copy-back',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'function maybe(values: Box[]): Box | undefined {',
      '  return values.pop();',
      '}',
      '',
      'export function score(values: Box[]): number {',
      '  const value = values.pop();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  return value.get() + values.length;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: Array<{ value: number; get(): number }>,
    ) => number;
    const first = {
      value: 3,
      get() {
        return this.value;
      },
    };
    const second = {
      value: 5,
      get() {
        return this.value;
      },
    };
    const third = {
      value: 8,
      get() {
        return this.value;
      },
    };
    const empty: Array<{ value: number; get(): number }> = [];
    const scored = [first, second, third];

    assertEquals(score(scored), 10);
    assertEquals(scored, [first, second]);
    assertEquals(score(empty), 0);
    assertEquals(empty, []);
  },
);

compilerArrayTest(
  'compileProject shifts owned class arrays through internal tagged results and exported mutation copy-back',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'function maybe(values: Box[]): Box | undefined {',
      '  return values.shift();',
      '}',
      '',
      'export function score(values: Box[]): number {',
      '  const value = values.shift();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  return value.get() + values.length;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: Array<{ value: number; get(): number }>,
    ) => number;
    const first = {
      value: 3,
      get() {
        return this.value;
      },
    };
    const second = {
      value: 5,
      get() {
        return this.value;
      },
    };
    const third = {
      value: 8,
      get() {
        return this.value;
      },
    };
    const empty: Array<{ value: number; get(): number }> = [];
    const scored = [first, second, third];

    assertEquals(score(scored), 5);
    assertEquals(scored, [second, third]);
    assertEquals(score(empty), 0);
    assertEquals(empty, []);
  },
);

compilerArrayTest(
  'compileProject executes owned class array at(index) through internal tagged results and narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'function maybe(values: Box[], index: number): Box | undefined {',
      '  return values.at(index);',
      '}',
      '',
      'export function score(values: Box[], index: number): number {',
      '  const value = maybe(values, index);',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  return value.get() + values.length;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: Array<{ value: number; get(): number }>,
      index: number,
    ) => number;
    const first = {
      value: 3,
      get() {
        return this.value;
      },
    };
    const second = {
      value: 5,
      get() {
        return this.value;
      },
    };
    const third = {
      value: 8,
      get() {
        return this.value;
      },
    };

    assertEquals(score([first, second, third], 1), 8);
    assertEquals(score([first, second, third], -1), 11);
    assertEquals(score([first, second, third], 9), 3);
  },
);

compilerArrayTest(
  'compileProject slices exported class arrays through JS array boundaries without mutating the input and preserves element identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[], start: number, end: number): Box[] {',
      '  return values.slice(start, end);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number; get(): number }>,
      start: number,
      end: number,
    ) => Array<{ value: number; get(): number }>;
    const first = {
      value: 3,
      get() {
        return this.value;
      },
    };
    const second = {
      value: 5,
      get() {
        return this.value;
      },
    };
    const third = {
      value: 8,
      get() {
        return this.value;
      },
    };
    const values = [first, second, third];
    const sliced = main(values, 1, 3);

    assertEquals(sliced.length, 2);
    assertStrictEquals(sliced[0], second);
    assertStrictEquals(sliced[1], third);
    assertEquals(values, [first, second, third]);
  },
);

compilerArrayTest(
  'compileProject concatenates exported class arrays through JS array boundaries without mutating the inputs and preserves element identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function copy(values: Box[]): Box[] {',
      '  return values.concat();',
      '}',
      '',
      'export function main(left: Box[], right: Box[]): Box[] {',
      '  return left.concat(right[0], right);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const copy = instance.exports[await resolveQualifiedExportName(tempDirectory, 'copy')] as (
      values: Array<{ value: number; get(): number }>,
    ) => Array<{ value: number; get(): number }>;
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      left: Array<{ value: number; get(): number }>,
      right: Array<{ value: number; get(): number }>,
    ) => Array<{ value: number; get(): number }>;
    const first = {
      value: 3,
      get() {
        return this.value;
      },
    };
    const second = {
      value: 5,
      get() {
        return this.value;
      },
    };
    const third = {
      value: 8,
      get() {
        return this.value;
      },
    };
    const left = [first];
    const right = [second, third];

    const copied = copy(left);
    const merged = main(left, right);

    assertEquals(copied.length, 1);
    assertStrictEquals(copied[0], first);
    assertEquals(merged.length, 4);
    assertStrictEquals(merged[0], first);
    assertStrictEquals(merged[1], second);
    assertStrictEquals(merged[2], second);
    assertStrictEquals(merged[3], third);
    assertEquals(left, [first]);
    assertEquals(right, [second, third]);
  },
);

compilerArrayTest(
  'compileProject checks exported class array includes with host identity semantics and fromIndex normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[], needle: Box, fromIndex: number): boolean {',
      '  return values.includes(needle, fromIndex);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
      needle: { value: number },
      fromIndex: number,
    ) => number;
    const first = { value: 3 };
    const second = { value: 5 };
    const third = { value: 8 };

    assertEquals(main([first, second, first], first, 1), 1);
    assertEquals(main([first, second, third], { value: 5 }, 0), 0);
    assertEquals(main([first, second, third], second, -2), 1);
    assertEquals(main([first, second, third], first, 2), 0);
  },
);

compilerArrayTest(
  'compileProject checks exported class array indexOf with host identity semantics and fromIndex normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[], needle: Box, fromIndex: number): number {',
      '  return values.indexOf(needle, fromIndex);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
      needle: { value: number },
      fromIndex: number,
    ) => number;
    const first = { value: 3 };
    const second = { value: 5 };
    const third = { value: 8 };

    assertEquals(main([first, second, first], first, 1), 2);
    assertEquals(main([first, second, third], { value: 5 }, 0), -1);
    assertEquals(main([first, second, third], second, -2), 1);
    assertEquals(main([first, second, third], first, 2), -1);
  },
);

compilerArrayTest(
  'compileProject checks exported class array lastIndexOf with host identity semantics and fromIndex normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[], needle: Box, fromIndex: number): number {',
      '  return values.lastIndexOf(needle, fromIndex);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
      needle: { value: number },
      fromIndex: number,
    ) => number;
    const first = { value: 3 };
    const second = { value: 5 };
    const third = { value: 8 };

    assertEquals(main([first, second, first], first, 2), 2);
    assertEquals(main([first, second, third], { value: 5 }, 2), -1);
    assertEquals(main([first, second, first], first, -2), 0);
    assertEquals(main([first, second, third], first, -5), -1);
  },
);

compilerArrayTest(
  'compileProject reverses exported class arrays in place and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): Box[] {',
      '  return values.reverse();',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => Array<{ value: number }>;
    const first = { value: 3 };
    const second = { value: 5 };
    const third = { value: 8 };
    const values = [first, second, third];

    const reversed = main(values);

    assertStrictEquals(reversed, values);
    assertStrictEquals(reversed[0], third);
    assertStrictEquals(reversed[1], second);
    assertStrictEquals(reversed[2], first);
  },
);

compilerArrayTest(
  'compileProject fills exported class arrays in place with JS start/end normalization and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[], replacement: Box, start: number, end: number): Box[] {',
      '  return values.fill(replacement, start, end);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
      replacement: { value: number },
      start: number,
      end: number,
    ) => Array<{ value: number }>;
    const first = { value: 3 };
    const second = { value: 5 };
    const third = { value: 8 };
    const fourth = { value: 13 };
    const replacement = { value: 21 };
    const values = [first, second, third, fourth];

    const returned = main(values, replacement, 1, -1);

    assertStrictEquals(returned, values);
    assertStrictEquals(values[0], first);
    assertStrictEquals(values[1], replacement);
    assertStrictEquals(values[2], replacement);
    assertStrictEquals(values[3], fourth);
  },
);

compilerArrayTest(
  'compileProject splices exported class arrays by mutating the receiver and returning removed values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): Box[] {',
      '  return values.splice(1, 2);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => Array<{ value: number }>;
    const first = { value: 3 };
    const second = { value: 5 };
    const third = { value: 8 };
    const fourth = { value: 13 };
    const values = [first, second, third, fourth];

    const removed = main(values);

    assertEquals(removed.length, 2);
    assertStrictEquals(removed[0], second);
    assertStrictEquals(removed[1], third);
    assertEquals(values.length, 2);
    assertStrictEquals(values[0], first);
    assertStrictEquals(values[1], fourth);
    assertEquals(removed === values, false);
  },
);

compilerArrayTest(
  'compileProject copyWithin mutates owned class arrays in place and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[], target: number, start: number, end: number): Box[] {',
      '  return values.copyWithin(target, start, end);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
      target: number,
      start: number,
      end: number,
    ) => Array<{ value: number }>;
    const first = { value: 3 };
    const second = { value: 5 };
    const third = { value: 8 };
    const fourth = { value: 13 };
    const values = [first, second, third, fourth];

    const returned = main(values, -3, 2, -1);

    assertStrictEquals(returned, values);
    assertStrictEquals(returned[0], first);
    assertStrictEquals(returned[1], third);
    assertStrictEquals(returned[2], third);
    assertStrictEquals(returned[3], fourth);
  },
);

compilerArrayTest(
  'compileProject executes owned class array some with callback index params and early exit',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): number {',
      '  const found = values.some((value: Box, index: number, array: Box[]): boolean => {',
      '    return value.value + index + array.length === 8;',
      '  });',
      '  if (found) {',
      '    return 1;',
      '  }',
      '  return 0;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => number;

    assertEquals(main([{ value: 3 }, { value: 4 }, { value: 6 }]), 1);
  },
);

compilerArrayTest(
  'compileProject finds class-array indexes through callback predicates',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): number {',
      '  return values.findIndex((value: Box, index: number, array: Box[]): boolean => {',
      '    return value.value > 6;',
      '  });',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => number;

    assertEquals(main([{ value: 2 }, { value: 4 }, { value: 7 }, { value: 9 }]), 2);
  },
);

compilerArrayTest(
  'compileProject finds owned class-array elements through callback predicates',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'function helper(values: Box[]): Box | undefined {',
      '  return values.find((value: Box, index: number, array: Box[]): boolean => {',
      '    return value.value >= 5;',
      '  });',
      '}',
      '',
      'export function main(values: Box[]): number {',
      '  const found = helper(values);',
      '  if (found === undefined) {',
      '    return 0;',
      '  }',
      '  return found.value;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => number;

    assertEquals(main([{ value: 2 }, { value: 4 }, { value: 7 }, { value: 9 }]), 7);
    assertEquals(main([{ value: 1 }, { value: 3 }]), 0);
  },
);

compilerArrayTest(
  'compileProject filters owned class arrays through callback predicates and preserves identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): Box[] {',
      '  return values.filter((value: Box, index: number, array: Box[]): boolean => {',
      '    return value.value >= 5;',
      '  });',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => Array<{ value: number }>;
    const first = { value: 3 };
    const second = { value: 5 };
    const third = { value: 8 };
    const fourth = { value: 1 };

    const filtered = main([first, second, third, fourth]);

    assertEquals(filtered.length, 2);
    assertStrictEquals(filtered[0], second);
    assertStrictEquals(filtered[1], third);
  },
);

compilerArrayTest(
  'compileProject maps owned class arrays through callback predicates and preserves identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): Box[] {',
      '  return values.map((value: Box, index: number, array: Box[]): Box => {',
      '    return array[index];',
      '  });',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => Array<{ value: number }>;
    const first = { value: 3 };
    const second = { value: 5 };
    const third = { value: 8 };

    const mapped = main([first, second, third]);

    assertEquals(mapped.length, 3);
    assertStrictEquals(mapped[0], first);
    assertStrictEquals(mapped[1], second);
    assertStrictEquals(mapped[2], third);
  },
);

compilerArrayTest(
  'compileProject executes owned class array forEach with callback index and array params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): number {',
      '  let total = 0;',
      '  values.forEach((value: Box, index: number, array: Box[]): undefined => {',
      '    total = total + value.get() * (index + 1) + array.length;',
      '    return undefined;',
      '  });',
      '  return total;',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => number;

    assertEquals(main([{ value: 2 }, { value: 3 }]), 12);
  },
);

compilerArrayTest(
  'compileProject reduces owned class arrays with numeric accumulators',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): number {',
      '  return values.reduce((sum: number, value: Box, index: number, array: Box[]): number => {',
      '    return sum + value.value + index + array.length;',
      '  }, 0);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => number;

    assertEquals(main([{ value: 2 }, { value: 3 }]), 10);
  },
);

compilerArrayTest(
  'compileProject reduces owned class arrays with heap accumulators and preserves identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '}',
      '',
      'export function main(values: Box[]): Box {',
      '  return values.reduce((best: Box, value: Box, index: number, array: Box[]): Box => {',
      '    if (value.value > best.value) {',
      '      return value;',
      '    }',
      '    return best;',
      '  }, values[0]);',
      '}',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number }>,
    ) => { value: number };
    const first = { value: 2 };
    const second = { value: 7 };
    const third = { value: 4 };

    const reduced = main([first, second, third]);

    assertStrictEquals(reduced, second);
  },
);

compilerArrayTest(
  'compileProject passes user-authored string array literals through internal helper params and returns',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function build(left: string, right: string): string[] {',
      '  return [left, right, "zebra"];',
      '}',
      '',
      'function pick(values: string[], index: number): string {',
      '  return values[index];',
      '}',
      '',
      'export function main(left: string, right: string, index: number): string {',
      '  return pick(build(left, right), index);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const build = moduleIR.functions.find((func) => func.name === 'build');
    const pick = moduleIR.functions.find((func) => func.name === 'pick');
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      left: string,
      right: string,
      index: number,
    ) => string;

    assertEquals(build?.resultType, 'owned_array_ref');
    assertEquals(pick?.params[0]?.type, 'owned_array_ref');
    assertEquals(
      (pick?.body[pick.body.length - 1] as {
        value?: { value?: { kind?: string } };
      } | undefined)?.value?.value?.kind,
      'owned_string_array_element',
    );
    assertEquals(main('ant', 'bee', 0), 'ant');
    assertEquals(main('ant', 'bee', 1), 'bee');
    assertEquals(main('ant', 'bee', 2), 'zebra');
  },
);

compilerArrayTest(
  'compileProject materializes user-authored string array literals onto the owned array runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(index: number): number {',
      '  const values: string[] = ["ant", "bee", "cat"];',
      '  return values.length + values[index].charCodeAt(0);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);

    assertStringIncludes(watOutput, '(type $owned_string_array_data (array (mut (ref null eq))))');
    assertStringIncludes(
      watOutput,
      '(type $owned_string_array (struct (field (mut (ref null $owned_string_array_data)))))',
    );
    assertStringIncludes(watOutput, 'array.new_default $owned_string_array_data');
    assertStringIncludes(watOutput, 'array.set $owned_string_array_data');
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 3 + 'a'.charCodeAt(0));
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [2]), 3 + 'c'.charCodeAt(0));
  },
);

compilerArrayTest(
  'compileProject adapts exported string array params through the owned array runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[], index: number): string {',
      '  return values[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: string[], index: number) => string;

    assertStringIncludes(watOutput, '(import "soundscript_array" "length"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "get"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "clear"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "push"');
    assertEquals(watOutput.includes('(import "soundscript_array" "empty"'), false);
    assertEquals(main(['ant', 'bee', 'cat'], 1), 'bee');
  },
);

compilerArrayTest(
  'compileProject executes owned string array at(index) through tagged nullable results and narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: string[], index: number): string | undefined {',
      '  return values.at(index);',
      '}',
      '',
      'export function len(values: string[], index: number): number {',
      '  const value = values.at(index);',
      '  if (value === undefined) {',
      '    return 0;',
      '  }',
      '  return value.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: string[],
      index: number,
    ) => string | undefined;
    const len = instance.exports[await resolveQualifiedExportName(tempDirectory, 'len')] as (
      values: string[],
      index: number,
    ) => number;

    assertEquals(maybe(['ant', 'bee', 'cat'], 1), 'bee');
    assertEquals(maybe(['ant', 'bee', 'cat'], -1), 'cat');
    assertEquals(maybe(['ant', 'bee', 'cat'], -4), undefined);
    assertEquals(len(['ant', 'bee', 'cat'], -1), 3);
    assertEquals(len(['ant', 'bee', 'cat'], 9), 0);
  },
);

compilerArrayTest(
  'compileProject pops owned string arrays through tagged results and exported mutation copy-back',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: string[]): string | undefined {',
      '  return values.pop();',
      '}',
      '',
      'export function score(values: string[]): number {',
      '  const value = values.pop();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  return value.length + values.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: string[],
    ) => string | undefined;
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: string[],
    ) => number;
    const first = ['ant', 'bee', 'cat'];
    const second: string[] = [];
    const third = ['ant', 'bee', 'cat'];
    const fourth: string[] = [];

    assertEquals(maybe(first), 'cat');
    assertEquals(first, ['ant', 'bee']);
    assertEquals(maybe(second), undefined);
    assertEquals(second, []);
    assertEquals(score(third), 5);
    assertEquals(third, ['ant', 'bee']);
    assertEquals(score(fourth), 0);
    assertEquals(fourth, []);
  },
);

compilerArrayTest(
  'compileProject shifts owned string arrays through tagged results and exported mutation copy-back',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: string[]): string | undefined {',
      '  return values.shift();',
      '}',
      '',
      'export function score(values: string[]): number {',
      '  const value = values.shift();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  return value.length + values.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: string[],
    ) => string | undefined;
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: string[],
    ) => number;
    const first = ['ant', 'bee', 'cat'];
    const second: string[] = [];
    const third = ['ant', 'bee', 'cat'];
    const fourth: string[] = [];

    assertEquals(maybe(first), 'ant');
    assertEquals(first, ['bee', 'cat']);
    assertEquals(maybe(second), undefined);
    assertEquals(second, []);
    assertEquals(score(third), 5);
    assertEquals(third, ['bee', 'cat']);
    assertEquals(score(fourth), 0);
    assertEquals(fourth, []);
  },
);

compilerArrayTest(
  'compileProject adapts exported string array results through the owned array runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: string, right: string): string[] {',
      '  return [left, right, "zebra"];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: string, right: string) => string[];

    assertStringIncludes(watOutput, '(import "soundscript_array" "empty"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "push"');
    assertEquals(watOutput.includes('(import "soundscript_array" "length"'), false);
    assertEquals(watOutput.includes('(import "soundscript_array" "get"'), false);
    assertEquals(main('ant', 'bee'), ['ant', 'bee', 'zebra']);
  },
);

compilerArrayTest(
  'compileProject fills exported string arrays in place with optional numeric bounds and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(',
      '  values: string[],',
      '  useStart: boolean,',
      '  start: number,',
      '  useEnd: boolean,',
      '  end: number,',
      '): string[] {',
      '  let maybeStart: number | undefined = undefined;',
      '  let maybeEnd: number | undefined = undefined;',
      '  if (useStart) {',
      '    maybeStart = start;',
      '  }',
      '  if (useEnd) {',
      '    maybeEnd = end;',
      '  }',
      '  return values.fill("yak", maybeStart, maybeEnd);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: string[],
      useStart: boolean,
      start: number,
      useEnd: boolean,
      end: number,
    ) => string[];
    const first = ['ant', 'bee', 'cat', 'dog'];
    const firstReturned = main(first, false, 2, true, -1);
    const second = ['ant', 'bee', 'cat', 'dog'];
    const secondReturned = main(second, true, 1, false, 0);

    assertStrictEquals(firstReturned, first);
    assertEquals(first, ['yak', 'yak', 'yak', 'dog']);
    assertStrictEquals(secondReturned, second);
    assertEquals(second, ['ant', 'yak', 'yak', 'yak']);
  },
);

compilerArrayTest(
  'compileProject reverses exported string arrays in place and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[]): string[] {',
      '  return values.reverse();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: string[]) => string[];
    const values = ['ant', 'bee', 'cat'];
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, ['cat', 'bee', 'ant']);
  },
);

compilerArrayTest(
  'compileProject copyWithin mutates owned string arrays in place with JS index normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function localScore(): number {',
      '  const values: string[] = ["ant", "bee", "cat", "dog"];',
      '  const returned = values.copyWithin(1, 2);',
      '  return values[0].length * 100 + values[1].length * 10 + returned[2].length;',
      '}',
      '',
      'export function exported(values: string[], target: number, start: number, useEnd: boolean, end: number): string[] {',
      '  let maybeEnd: number | undefined = undefined;',
      '  if (useEnd) {',
      '    maybeEnd = end;',
      '  }',
      '  return values.copyWithin(target, start, maybeEnd);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const localScore = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'localScore')] as () => number;
    const exported = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'exported')] as (
        values: string[],
        target: number,
        start: number,
        useEnd: boolean,
        end: number,
      ) => string[];
    const first = ['ant', 'bee', 'cat', 'dog'];
    const firstExpected = [...first];
    firstExpected.copyWithin(1, -3, -1);
    const second = ['ant', 'bee', 'cat', 'dog'];
    const secondExpected = [...second];
    secondExpected.copyWithin(-3, 2);
    const firstReturned = exported(first, 1, -3, true, -1);
    const secondReturned = exported(second, -3, 2, false, 0);

    assertEquals(localScore(), 333);
    assertStrictEquals(firstReturned, first);
    assertEquals(first, firstExpected);
    assertStrictEquals(secondReturned, second);
    assertEquals(second, secondExpected);
  },
);

compilerArrayTest(
  'compileProject copies back exported string array copyWithin mutations through local aliases',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[]): string[] {',
      '  const alias = values;',
      '  return alias.copyWithin(1, 0, 1);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: string[]) => string[];
    const values = ['ant', 'bee', 'cat'];
    const expected = [...values];
    expected.copyWithin(1, 0, 1);
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, expected);
  },
);

compilerArrayTest(
  'compileProject supports user-authored string array reassignment across branches',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: boolean, index: number): string {',
      '  let values: string[] = ["fallback"];',
      '  if (flag) {',
      '    values = ["ant", "bee"];',
      '  } else {',
      '    values = ["cat", "dog"];',
      '  }',
      '  return values[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (flag: boolean, index: number) => string;

    assertEquals(main(true, 1), 'bee');
    assertEquals(main(false, 0), 'cat');
  },
);

compilerArrayTest(
  'compileProject supports branch-joined string arrays from literals and Object.keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      '',
      'export function main(flag: boolean, index: number, left: number, right: number): string {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  let values: string[] = ["fallback"];',
      '  if (flag) {',
      '    values = Object.keys(mixed);',
      '  } else {',
      '    values = ["cat", "dog"];',
      '  }',
      '  return values[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      flag: boolean,
      index: number,
      left: number,
      right: number,
    ) => string;

    assertEquals(main(true, 0, 4, 7), '1');
    assertEquals(main(true, 3, 4, 7), 'apple');
    assertEquals(main(false, 1, 4, 7), 'dog');
  },
);

compilerArrayTest(
  'compileProject slices owned string arrays with JS slice normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(start: number, end: number, hasEnd: boolean): number {',
      '  const values: string[] = ["ant", "bee", "cat", "dog"];',
      '  let sliced: string[] = ["fallback"];',
      '  if (hasEnd) {',
      '    sliced = values.slice(start, end);',
      '  } else {',
      '    sliced = values.slice(start);',
      '  }',
      '  return sliced.length + sliced[0].length + sliced[sliced.length - 1].length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1, -1, 1]), 8);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [-2, 0, 0]), 8);
  },
);

compilerArrayTest(
  'compileProject splices owned string arrays by mutating the receiver and returning removed values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function localScore(): number {',
      '  const values: string[] = ["ant", "bee", "cat", "dog"];',
      '  const removed = values.splice(1, 2);',
      '  return values.length + removed.length + values[1].length + removed[0].length + removed[1].length;',
      '}',
      '',
      'export function exported(values: string[]): string[] {',
      '  return values.splice(1, 2);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const localScore = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'localScore')] as () => number;
    const exported = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'exported')] as (
        values: string[],
      ) => string[];
    const values = ['ant', 'bee', 'cat', 'dog'];
    const removed = exported(values);

    assertEquals(localScore(), 2 + 2 + 'dog'.length + 'bee'.length + 'cat'.length);
    assertEquals(removed, ['bee', 'cat']);
    assertEquals(values, ['ant', 'dog']);
    assertEquals(removed === values, false);
  },
);

compilerArrayTest('compileProject supports one-arg owned string array splice forms', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function deleteToEnd(values: string[]): string[] {',
    '  return values.splice(1);',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const deleteToEnd = instance.exports[
    await resolveQualifiedExportName(tempDirectory, 'deleteToEnd')
  ] as (values: string[]) => string[];
  const values = ['ant', 'bee', 'cat', 'dog'];
  const removed = deleteToEnd(values);

  assertEquals(removed, ['bee', 'cat', 'dog']);
  assertEquals(values, ['ant']);
});

compilerArrayTest(
  'compileProject splices owned string arrays with same-kind scalar insert args',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function exported(values: string[]): string[] {',
      '  return values.splice(1, 2, "yak", "emu");',
      '}',
      '',
      'export function localScore(): number {',
      '  const values: string[] = ["ant", "bee", "cat", "dog"];',
      '  const removed = values.splice(1, 2, "yak", "emu");',
      '  return values.length + removed.length + values[1].length + values[2].length + removed[0].length + removed[1].length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const localScore = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'localScore')] as () => number;
    const exported = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'exported')] as (
        values: string[],
      ) => string[];
    const values = ['ant', 'bee', 'cat', 'dog'];
    const removed = exported(values);

    assertEquals(localScore(), 4 + 2 + 'yak'.length + 'emu'.length + 'bee'.length + 'cat'.length);
    assertEquals(removed, ['bee', 'cat']);
    assertEquals(values, ['ant', 'yak', 'emu', 'dog']);
  },
);

compilerArrayTest(
  'compileProject keeps spread splice insert forms unsupported in the compiler subset',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[], inserts: string[]): string[] {',
      '  return values.splice(1, 1, ...inserts);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.source === 'compiler'), true);
  },
);

compilerArrayTest(
  'compileProject fills local string arrays with JS start/end normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(start: number, end: number): number {',
      '  const values: string[] = ["ant", "bee", "cat", "dog"];',
      '  const alias = values.fill("yak", start, end);',
      '  return alias.length + values[1].charCodeAt(0) + values[2].charCodeAt(0);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(
      await invokeCompiledEntry(tempDirectory, 'main', [1, -1]),
      4 + 'y'.charCodeAt(0) * 2,
    );
    assertEquals(
      await invokeCompiledEntry(tempDirectory, 'main', [-2, 10]),
      4 + 'b'.charCodeAt(0) + 'y'.charCodeAt(0),
    );
  },
);

compilerArrayTest(
  'compileProject reverses local string arrays in place and returns the same array reference',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: string[] = ["ant", "bee", "cat"];',
      '  const reversed = values.reverse();',
      '  reversed[0] = "yak";',
      '  return values[0].length + values[2].length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3 + 3);
  },
);

compilerArrayTest(
  'compileProject concatenates owned string arrays with zero-arg, element, and multi-arg cases without mutating either input',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(index: number): number {',
      '  const left: string[] = ["ant", "bee"];',
      '  const right: string[] = ["dog"];',
      '  const copy = right.concat();',
      '  const merged = left.concat("cat", right, "eel");',
      '  return merged.length + merged[index].length + copy.length + left.length + right.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [2]), 5 + 3 + 1 + 2 + 1);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4]), 5 + 3 + 1 + 2 + 1);
  },
);

compilerArrayTest(
  'compileProject joins owned string arrays natively with default and explicit separators',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[], separator: string): number {',
      '  const joined = values.join(separator);',
      '  return joined.length + joined.charCodeAt(2);',
      '}',
      '',
      'export function defaults(values: string[]): number {',
      '  return values.join().length;',
      '}',
      '',
      'export function explicitUndefined(values: string[]): number {',
      '  return values.join(undefined).length;',
      '}',
      '',
      'export function maybeSeparator(values: string[], separator: string | undefined): number {',
      '  return values.join(separator).length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: string[],
      separator: string,
    ) => number;
    const defaults = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'defaults')] as (
        values: string[],
      ) => number;
    const explicitUndefined = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'explicitUndefined')] as (
        values: string[],
      ) => number;
    const maybeSeparator = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'maybeSeparator')] as (
        values: string[],
        separator: string | undefined,
      ) => number;

    assertStringIncludes(watOutput, 'call $owned_string_array_join');
    assertEquals(watOutput.includes('call $tagged_from_number'), false);
    assertEquals(watOutput.includes('call $tagged_from_boolean'), false);
    assertEquals(main(['ab', 'cd'], '-'), 5 + '-'.charCodeAt(0));
    assertEquals(main(['ab', 'cd'], ''), 4 + 'c'.charCodeAt(0));
    assertEquals(defaults(['a', 'b', 'c']), 'a,b,c'.length);
    assertEquals(defaults([]), 0);
    assertEquals(explicitUndefined(['a', 'b']), 'a,b'.length);
    assertEquals(maybeSeparator(['ab', 'cd'], undefined), 'ab,cd'.length);
    assertEquals(maybeSeparator(['ab', 'cd'], '---'), 'ab---cd'.length);
  },
);

compilerArrayTest(
  'compileProject checks owned string array includes with content equality and fromIndex',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(fromIndex: number): boolean {',
      '  const derived = "ants".slice(0, 3);',
      '  const values: string[] = [derived, "bee", "ant"];',
      '  return values.includes("ant", fromIndex);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);

    assertEquals(watOutput.includes('(import "soundscript_string" "equals"'), false);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 1);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [2]), 1);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [3]), 0);
  },
);

compilerArrayTest(
  'compileProject executes owned number array some with mutable closure capture and early exit',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let calls = 0;',
      '  const values: number[] = [1, 5, 7];',
      '  const found = values.some((value: number): boolean => {',
      '    calls = calls + 1;',
      '    return value > 3;',
      '  });',
      '  if (found) {',
      '    return 10 + calls;',
      '  }',
      '  return calls;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 12);
  },
);

compilerArrayTest(
  'compileProject executes owned string array some with callback index params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): boolean {',
      '  const values: string[] = ["a", "bee", "see"];',
      '  return values.some((value: string, index: number): boolean => value.length === index + 2);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1);
  },
);

compilerArrayTest(
  'compileProject keeps non-boolean owned array some callbacks unsupported for now',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): boolean {',
      '  const values: number[] = [1, 2, 3];',
      '  return values.some((value: number): number => value);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.source === 'compiler'), true);
  },
);

compilerArrayTest(
  'compileProject executes owned number array every with early false exit',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let calls = 0;',
      '  const values: number[] = [1, 2, 5, 0];',
      '  const allSmall = values.every((value: number): boolean => {',
      '    calls = calls + 1;',
      '    return value < 5;',
      '  });',
      '  if (allSmall) {',
      '    return 10 + calls;',
      '  }',
      '  return calls;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerArrayTest(
  'compileProject executes owned number array findIndex with callback index params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: number[] = [1, 4, 7];',
      '  return values.findIndex((value: number, index: number): boolean => value === index + 3);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1);
  },
);

compilerArrayTest(
  'compileProject executes owned number array find with tagged narrowing and early exit',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(target: number): number {',
      '  let calls = 0;',
      '  const values: number[] = [1, 4, 7];',
      '  const found = values.find((value: number): boolean => {',
      '    calls = calls + 1;',
      '    return value === target;',
      '  });',
      '  if (found !== undefined) {',
      '    return found + calls * 10;',
      '  }',
      '  return calls;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4]), 24);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [9]), 3);
  },
);

compilerArrayTest(
  'compileProject keeps owned number array find results bound to the callback argument value',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: number[] = [1, 2, 3];',
      '  const found = values.find((value: number, index: number, array: number[]): boolean => {',
      '    array[index] = value + 10;',
      '    return index === 1;',
      '  });',
      '  if (found !== undefined) {',
      '    return found * 100 + values[1];',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 212);
  },
);

compilerArrayTest(
  'compileProject executes owned string array forEach with callback index and array params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  let total = 0;',
      '  const values: string[] = ["a", "bee", "see"];',
      '  values.forEach((value: string, index: number, array: string[]): undefined => {',
      '    total = total + value.length + index + array.length;',
      '    return undefined;',
      '  });',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 19);
  },
);

compilerArrayTest(
  'compileProject filters owned string arrays through callback index and array params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(startIndex: number): string[] {',
      '  const values: string[] = ["ant", "bee", "see", "ox"];',
      '  return values.filter((value: string, index: number, array: string[]): boolean => {',
      '    if (value.length !== 3) {',
      '      return false;',
      '    }',
      '    if (index < startIndex) {',
      '      return false;',
      '    }',
      '    return array.length === 4;',
      '  });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      startIndex: number,
    ) => string[];

    assertEquals(main(0), ['ant', 'bee', 'see']);
    assertEquals(main(2), ['see']);
  },
);

compilerArrayTest(
  'compileProject keeps owned number array filter results bound to callback argument values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: number[] = [1, 2, 3];',
      '  const filtered = values.filter((value: number, index: number, array: number[]): boolean => {',
      '    array[index] = value + 10;',
      '    return index < 2;',
      '  });',
      '  return filtered[0] * 1000 + filtered[1] * 100 + values[0] * 10 + values[1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1322);
  },
);

compilerArrayTest(
  'compileProject executes owned number array filter across every element with mutable closure capture',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(limit: number): number {',
      '  let total = 0;',
      '  const values: number[] = [1, 2, 3, 4, 5];',
      '  const filtered = values.filter((value: number): boolean => {',
      '    total = total + value;',
      '    return value > limit;',
      '  });',
      '  return filtered.length * 100 + total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [2]), 315);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [9]), 15);
  },
);

compilerArrayTest(
  'compileProject keeps non-boolean owned array filter callbacks unsupported for now',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number[] {',
      '  const values: number[] = [1, 2, 3];',
      '  return values.filter((value: number): number => value);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.source === 'compiler'), true);
  },
);

compilerArrayTest(
  'compileProject maps owned string arrays through callback index and array params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string[] {',
      '  const values: string[] = ["a", "bee", "see"];',
      '  return values.map((value: string, index: number, array: string[]): string => {',
      '    if (index === array.length - 1) {',
      '      return value.charAt(0);',
      '    }',
      '    return value + value;',
      '  });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      string[];

    assertEquals(main(), ['aa', 'beebee', 's']);
  },
);

compilerArrayTest(
  'compileProject executes owned number array map with mutable closure capture',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(multiplier: number): number {',
      '  let total = 0;',
      '  const values: number[] = [1, 2, 3];',
      '  const mapped = values.map((value: number, index: number): number => {',
      '    total = total + value;',
      '    return value * multiplier + index;',
      '  });',
      '  return total * 1000 + mapped[0] * 100 + mapped[1] * 10 + mapped[2];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [2]), 6258);
  },
);

compilerArrayTest('compileProject maps owned number arrays across result families', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): boolean[] {',
    '  const values: number[] = [1, 2, 3];',
    '  return values.map((value: number, index: number): boolean => value > index + 1);',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
    boolean[];

  assertEquals(main(), [false, false, false]);
});

compilerArrayTest(
  'compileProject maps owned number arrays to tagged primitive array results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: boolean): number {',
      '  const values: number[] = [1, 2, 3];',
      '  const mapped: Array<number | boolean> = values.map((value: number, index: number): number | boolean => {',
      '    if (index === 0) {',
      '      if (flag) {',
      '        return value + 1;',
      '      }',
      '      return false;',
      '    }',
      '    return value > 2;',
      '  });',
      '  const first = mapped[0];',
      '  const second = mapped[1];',
      '  if (typeof first === "number") {',
      '    if (typeof second === "boolean") {',
      '      if (second) {',
      '        return mapped.length * 100 + first * 10 + 1;',
      '      }',
      '      return mapped.length * 100 + first * 10;',
      '    }',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      flag: boolean,
    ) => number;

    assertEquals(main(true), 320);
    assertEquals(main(false), 0);
  },
);

compilerArrayTest(
  'compileProject adapts exported tagged primitive array results through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): Array<number | boolean> {',
      '  const values: number[] = [1, 2, 3];',
      '  return values.map((value: number, index: number): number | boolean => {',
      '    if (index === 0) {',
      '      return value + 1;',
      '    }',
      '    return value > 2;',
      '  });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      Array<
        number | boolean
      >;

    assertEquals(main(), [2, false, true]);
  },
);

compilerArrayTest(
  'compileProject adapts exported tagged primitive array params through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Array<number | boolean>): number {',
      '  const first = values[0];',
      '  const second = values[1];',
      '  if (typeof first === "number") {',
      '    if (typeof second === "boolean") {',
      '      if (second) {',
      '        return values.length * 100 + first * 10 + 1;',
      '      }',
      '      return values.length * 100 + first * 10;',
      '    }',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<number | boolean>,
    ) => number;

    assertEquals(main([2, false, true]), 320);
  },
);

compilerArrayTest(
  'compileProject executes internal mixed heap arrays through indexing and narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(index: number): number {',
      '  const values: Array<Box | number | undefined> = [new Box(4), 7, undefined];',
      '  const value = values[index];',
      '  if (value === undefined) {',
      '    return -1;',
      '  }',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  return value.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 4);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 7);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [2]), -1);
  },
);

compilerArrayTest(
  'compileProject finds internal mixed heap array elements through callback narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const values: Array<Box | number | undefined> = [7, undefined, new Box(4)];',
      '  const found = values.find((value: Box | number | undefined): boolean => {',
      '    if (value === undefined) {',
      '      return false;',
      '    }',
      '    if (typeof value === "number") {',
      '      return false;',
      '    }',
      '    return value.get() === 4;',
      '  });',
      '  if (found === undefined) {',
      '    return -1;',
      '  }',
      '  if (typeof found === "number") {',
      '    return found;',
      '  }',
      '  return found.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 4);
  },
);

compilerArrayTest(
  'compileProject maps internal mixed heap arrays through callback narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const values: Array<Box | number | undefined> = [new Box(4), 7, undefined];',
      '  const mapped = values.map((value: Box | number | undefined): Box | number | undefined => {',
      '    if (value === undefined) {',
      '      return undefined;',
      '    }',
      '    if (typeof value === "number") {',
      '      return value + 1;',
      '    }',
      '    return new Box(value.get() + 1);',
      '  });',
      '  const first = mapped[0];',
      '  const second = mapped[1];',
      '  const third = mapped[2];',
      '  let total = 0;',
      '  if (first === undefined) {',
      '    return -1000;',
      '  }',
      '  if (typeof first === "number") {',
      '    total = total + first * 100;',
      '  } else {',
      '    total = total + first.get() * 100;',
      '  }',
      '  if (second === undefined) {',
      '    return -1001;',
      '  }',
      '  if (typeof second === "number") {',
      '    total = total + second * 10;',
      '  } else {',
      '    total = total + second.get() * 10;',
      '  }',
      '  if (third === undefined) {',
      '    total = total + 1;',
      '  } else if (typeof third === "number") {',
      '    total = total + third;',
      '  } else {',
      '    total = total + third.get();',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 581);
  },
);

compilerArrayTest(
  'compileProject adapts exported mixed heap array map results through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(): Array<Box | number | undefined> {',
      '  const first = new Box(4);',
      '  const values: Box[] = [first, first, new Box(9), new Box(12)];',
      '  return values.map((value: Box, index: number): Box | number | undefined => {',
      '    if (index === 1) {',
      '      return value.get() + 3;',
      '    }',
      '    if (index === 2) {',
      '      return undefined;',
      '    }',
      '    return first;',
      '  });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      Array<
        { get(): number } | number | undefined
      >;

    const values = main();
    assertEquals(values.length, 4);
    if (typeof values[0] === 'number' || values[0] === undefined) {
      throw new Error('Expected first mapped mixed heap-array result element to be an object.');
    }
    if (typeof values[3] === 'number' || values[3] === undefined) {
      throw new Error('Expected fourth mapped mixed heap-array result element to be an object.');
    }
    assertStrictEquals(values[0], values[3]);
    assertEquals(values[0].get(), 4);
    assertEquals(values[1], 7);
    assertEquals(values[2], undefined);
  },
);

compilerArrayTest(
  'compileProject adapts exported mixed heap array results through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(): Array<Box | number | undefined> {',
      '  const box = new Box(4);',
      '  return [box, 7, undefined, box];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      Array<
        { get(): number } | number | undefined
      >;

    const values = main();
    assertEquals(values.length, 4);
    if (typeof values[0] === 'number' || values[0] === undefined) {
      throw new Error('Expected first mixed heap-array result element to be an object.');
    }
    if (typeof values[3] === 'number' || values[3] === undefined) {
      throw new Error('Expected fourth mixed heap-array result element to be an object.');
    }
    assertStrictEquals(values[0], values[3]);
    assertEquals(values[0].get(), 4);
    assertEquals(values[1], 7);
    assertEquals(values[2], undefined);
  },
);

compilerArrayTest(
  'compileProject copies back exported mixed heap array param mutations and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'class Box {',
      '  value = 0;',
      '',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '',
      '  bump(): number {',
      '    this.value = this.value + 1;',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(values: Array<Box | number | undefined>, replacement: number): Array<Box | number | undefined> {',
      '  const first = values[0];',
      '  if (first !== undefined && typeof first !== "number") {',
      '    first.bump();',
      '  }',
      '  values[1] = new Box(replacement);',
      '  values[2] = 7;',
      '  return values;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<{ value: number } | number | undefined>,
      replacement: number,
    ) => Array<{ value: number } | number | undefined>;

    const first = { value: 3 };
    const values: Array<{ value: number } | number | undefined> = [first, undefined, 1];
    const returned = main(values, 9);

    assertStrictEquals(returned, values);
    assertStrictEquals(returned[0], first);
    if (typeof returned[1] === 'number' || returned[1] === undefined) {
      throw new Error('Expected second mixed heap-array param element to become an object.');
    }
    assertEquals(first.value, 4);
    assertEquals(returned[1].value, 9);
    assertEquals(returned[2], 7);
  },
);

compilerArrayTest(
  'compileProject executes tagged primitive array some callbacks with narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): boolean {',
      '  const values: Array<number | boolean> = [false, 0, 3];',
      '  return values.some((value: number | boolean): boolean => {',
      '    if (typeof value === "number") {',
      '      return value > 2;',
      '    }',
      '    return value;',
      '  });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      number;

    assertEquals(main(), 1);
  },
);

compilerArrayTest(
  'compileProject finds tagged primitive array elements through callback narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: Array<number | boolean> = [false, 2, true];',
      '  const found = values.find((value: number | boolean): boolean => {',
      '    if (typeof value === "number") {',
      '      return value > 1;',
      '    }',
      '    return false;',
      '  });',
      '  if (typeof found === "number") {',
      '    return found;',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 2);
  },
);

compilerArrayTest(
  'compileProject filters tagged primitive arrays through callback narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): Array<number | boolean> {',
      '  const values: Array<number | boolean> = [1, false, 3, true];',
      '  return values.filter((value: number | boolean): boolean => {',
      '    if (typeof value === "number") {',
      '      return value > 1;',
      '    }',
      '    return value;',
      '  });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      Array<
        number | boolean
      >;

    assertEquals(main(), [3, true]);
  },
);

compilerArrayTest(
  'compileProject maps tagged primitive arrays across receiver callback families',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number[] {',
      '  const values: Array<number | boolean> = [1, false, 3];',
      '  return values.map((value: number | boolean, index: number): number => {',
      '    if (typeof value === "number") {',
      '      return value + index;',
      '    }',
      '    return 0;',
      '  });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      number[];

    assertEquals(main(), [1, 0, 5]);
  },
);

compilerArrayTest(
  'compileProject reduces tagged primitive arrays through callback narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: Array<number | boolean> = [1, false, 3, true];',
      '  return values.reduce((acc: number, value: number | boolean): number => {',
      '    if (typeof value === "number") {',
      '      return acc + value;',
      '    }',
      '    if (value) {',
      '      return acc + 10;',
      '    }',
      '    return acc;',
      '  }, 0);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 14);
  },
);

compilerArrayTest(
  'compileProject adapts exported string-inclusive tagged primitive array results through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): Array<number | boolean | string> {',
      '  const values: Array<number | boolean> = [1, false, 3];',
      '  return values.map((value: number | boolean, index: number): number | boolean | string => {',
      '    if (typeof value === "number") {',
      '      return value + index;',
      '    }',
      '    return "no";',
      '  });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      Array<
        number | boolean | string
      >;

    assertEquals(main(), [1, 'no', 5]);
  },
);

compilerArrayTest(
  'compileProject reduces string-inclusive tagged primitive array params through callback narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Array<number | boolean | string>): number {',
      '  const result = values.reduce((acc: number, value: number | boolean | string): number => {',
      '    if (typeof value === "string") {',
      '      return acc + value.length;',
      '    }',
      '    if (typeof value === "number") {',
      '      return acc + value;',
      '    }',
      '    if (value) {',
      '      return acc + 10;',
      '    }',
      '    return acc;',
      '  }, 0);',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<number | boolean | string>,
    ) => number;

    assertEquals(main([1, 'xy', false, true]), 13);
  },
);

compilerArrayTest(
  'compileProject adapts exported nullish-inclusive tagged primitive array results through JS array boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): Array<number | string | null | undefined> {',
      '  const values: number[] = [1, 2, 3, 4];',
      '  return values.map((value: number, index: number): number | string | null | undefined => {',
      '    if (index === 0) {',
      '      return undefined;',
      '    }',
      '    if (index === 1) {',
      '      return null;',
      '    }',
      '    if (index === 2) {',
      '      return "three";',
      '    }',
      '    return value + 1;',
      '  });',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      Array<
        number | string | null | undefined
      >;

    assertEquals(main(), [undefined, null, 'three', 5]);
  },
);

compilerArrayTest(
  'compileProject reduces nullish-inclusive tagged primitive array params through callback narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Array<number | boolean | string | null | undefined>): number {',
      '  const result = values.reduce((acc: number, value: number | boolean | string | null | undefined): number => {',
      '    if (value === undefined) {',
      '      return acc + 100;',
      '    }',
      '    if (value === null) {',
      '      return acc + 50;',
      '    }',
      '    if (typeof value === "string") {',
      '      return acc + value.length;',
      '    }',
      '    if (typeof value === "number") {',
      '      return acc + value;',
      '    }',
      '    if (value) {',
      '      return acc + 10;',
      '    }',
      '    return acc;',
      '  }, 0);',
      '  return result;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<number | boolean | string | null | undefined>,
    ) => number;

    assertEquals(main([1, 'xy', false, true, null, undefined]), 163);
  },
);

compilerArrayTest(
  'compileProject mutates local tagged primitive arrays through indexed writes',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: Array<number | string | null | undefined> = [1, "x", null, undefined];',
      '  values[0] = "hi";',
      '  values[1] = 4;',
      '  values[2] = undefined;',
      '  values[3] = null;',
      '  return values.reduce((acc: number, value: number | string | null | undefined): number => {',
      '    if (value === undefined) {',
      '      return acc + 100;',
      '    }',
      '    if (value === null) {',
      '      return acc + 50;',
      '    }',
      '    if (typeof value === "string") {',
      '      return acc + value.length;',
      '    }',
      '    return acc + value;',
      '  }, 0);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 156);
  },
);

compilerArrayTest(
  'compileProject copies back exported tagged primitive array param mutations and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Array<number | boolean | string | null | undefined>): Array<number | boolean | string | null | undefined> {',
      '  values[0] = "hi";',
      '  values[1] = null;',
      '  values[2] = 7;',
      '  values[3] = undefined;',
      '  values[4] = false;',
      '  return values;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: Array<number | boolean | string | null | undefined>,
    ) => Array<number | boolean | string | null | undefined>;
    const values: Array<number | boolean | string | null | undefined> = [1, true, 'x', 5, null];
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, ['hi', null, 7, undefined, false]);
  },
);

compilerArrayTest('compileProject pushes local tagged primitive arrays', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  const values: Array<number | string | null | undefined> = [1, "x"];',
    '  values.push(undefined, "hi", 4, null);',
    '  return values.reduce((acc: number, value: number | string | null | undefined): number => {',
    '    if (value === undefined) {',
    '      return acc + 100;',
    '    }',
    '    if (value === null) {',
    '      return acc + 50;',
    '    }',
    '    if (typeof value === "string") {',
    '      return acc + value.length;',
    '    }',
    '    return acc + value;',
    '  }, 0);',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 158);
});

compilerArrayTest(
  'compileProject copies back exported tagged primitive array push mutations and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Array<number | string | null | undefined>): Array<number | string | null | undefined> {',
      '  values.push("hi", undefined, 4, null);',
      '  return values;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: Array<number | string | null | undefined>,
    ) => Array<number | string | null | undefined>;
    const values: Array<number | string | null | undefined> = [1, 'x'];
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, [1, 'x', 'hi', undefined, 4, null]);
  },
);

compilerArrayTest('compileProject unshifts local tagged primitive arrays', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  const values: Array<number | string | null | undefined> = [1, "x"];',
    '  values.unshift(undefined, "hi", 4, null);',
    '  return values.reduce((acc: number, value: number | string | null | undefined): number => {',
    '    if (value === undefined) {',
    '      return acc + 100;',
    '    }',
    '    if (value === null) {',
    '      return acc + 50;',
    '    }',
    '    if (typeof value === "string") {',
    '      return acc + value.length;',
    '    }',
    '    return acc + value;',
    '  }, 0);',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 158);
});

compilerArrayTest(
  'compileProject copies back exported tagged primitive array unshift mutations and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Array<number | string | null | undefined>): Array<number | string | null | undefined> {',
      '  values.unshift("hi", undefined, 4, null);',
      '  return values;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: Array<number | string | null | undefined>,
    ) => Array<number | string | null | undefined>;
    const values: Array<number | string | null | undefined> = [1, 'x'];
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, ['hi', undefined, 4, null, 1, 'x']);
  },
);

compilerArrayTest(
  'compileProject pops tagged primitive arrays through tagged results and exported mutation copy-back',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: Array<number | string | null | undefined>): number | string | null | undefined {',
      '  return values.pop();',
      '}',
      '',
      'export function score(values: Array<number | string | null | undefined>): number {',
      '  const value = values.pop();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  if (value === null) {',
      '    return values.length + 50;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length * 10 + values.length;',
      '  }',
      '  return value * 2 + values.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: Array<number | string | null | undefined>,
    ) => number | string | null | undefined;
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: Array<number | string | null | undefined>,
    ) => number;
    const first: Array<number | string | null | undefined> = [3, 'hi', null];
    const second: Array<number | string | null | undefined> = [];
    const third: Array<number | string | null | undefined> = [3, 'hi', 4];
    const fourth: Array<number | string | null | undefined> = [3, 'hi', null];
    const fifth: Array<number | string | null | undefined> = ['abcd'];

    assertEquals(maybe(first), null);
    assertEquals(first, [3, 'hi']);
    assertEquals(maybe(second), undefined);
    assertEquals(second, []);
    assertEquals(score(third), 10);
    assertEquals(third, [3, 'hi']);
    assertEquals(score(fourth), 52);
    assertEquals(fourth, [3, 'hi']);
    assertEquals(score(fifth), 40);
    assertEquals(fifth, []);
  },
);

compilerArrayTest(
  'compileProject shifts tagged primitive arrays through tagged results and exported mutation copy-back',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: Array<number | string | null | undefined>): number | string | null | undefined {',
      '  return values.shift();',
      '}',
      '',
      'export function score(values: Array<number | string | null | undefined>): number {',
      '  const value = values.shift();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  if (value === null) {',
      '    return values.length + 50;',
      '  }',
      '  if (typeof value === "string") {',
      '    return value.length * 10 + values.length;',
      '  }',
      '  return value * 2 + values.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: Array<number | string | null | undefined>,
    ) => number | string | null | undefined;
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: Array<number | string | null | undefined>,
    ) => number;
    const first: Array<number | string | null | undefined> = [null, 3, 'hi'];
    const second: Array<number | string | null | undefined> = [];
    const third: Array<number | string | null | undefined> = [4, 3, 'hi'];
    const fourth: Array<number | string | null | undefined> = ['abcd', 3];
    const fifth: Array<number | string | null | undefined> = [null, 'hi'];

    assertEquals(maybe(first), null);
    assertEquals(first, [3, 'hi']);
    assertEquals(maybe(second), undefined);
    assertEquals(second, []);
    assertEquals(score(third), 10);
    assertEquals(third, [3, 'hi']);
    assertEquals(score(fourth), 41);
    assertEquals(fourth, [3]);
    assertEquals(score(fifth), 51);
    assertEquals(fifth, ['hi']);
  },
);

compilerArrayTest(
  'compileProject concatenates tagged primitive arrays with scalar items and multiple args without mutating the inputs',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const left: Array<number | string | null | undefined> = [1, "x"];',
      '  const right: Array<number | string | null | undefined> = [null, 4];',
      '  const copy = right.concat();',
      '  const merged = left.concat(undefined, right, "hi");',
      '  return merged.reduce((acc: number, value: number | string | null | undefined): number => {',
      '    if (value === undefined) {',
      '      return acc + 100;',
      '    }',
      '    if (value === null) {',
      '      return acc + 50;',
      '    }',
      '    if (typeof value === "string") {',
      '      return acc + value.length;',
      '    }',
      '    return acc + value;',
      '  }, 0) + copy.length * 10 + left.length * 100 + right.length * 1000;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 2378);
  },
);

compilerArrayTest(
  'compileProject concatenates exported tagged primitive arrays through JS array boundaries without mutating the inputs',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(',
      '  left: Array<number | string | null | undefined>,',
      '  right: Array<number | string | null | undefined>,',
      '): Array<number | string | null | undefined> {',
      '  return left.concat(undefined, right, "hi");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      left: Array<number | string | null | undefined>,
      right: Array<number | string | null | undefined>,
    ) => Array<number | string | null | undefined>;
    const left: Array<number | string | null | undefined> = [1, 'x'];
    const right: Array<number | string | null | undefined> = [null, 4];
    const resultValues = main(left, right);

    assertEquals(resultValues, [1, 'x', undefined, null, 4, 'hi']);
    assertEquals(left, [1, 'x']);
    assertEquals(right, [null, 4]);
  },
);

compilerArrayTest(
  'compileProject slices tagged primitive arrays with omitted end and negative indices without mutating the input',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function copy(values: Array<number | string | null | undefined>): Array<number | string | null | undefined> {',
      '  return values.slice();',
      '}',
      '',
      'export function tail(values: Array<number | string | null | undefined>, start: number): Array<number | string | null | undefined> {',
      '  return values.slice(start);',
      '}',
      '',
      'export function trim(values: Array<number | string | null | undefined>, end: number): Array<number | string | null | undefined> {',
      '  return values.slice(undefined, end);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const copy = instance.exports[await resolveQualifiedExportName(tempDirectory, 'copy')] as (
      values: Array<number | string | null | undefined>,
    ) => Array<number | string | null | undefined>;
    const tail = instance.exports[await resolveQualifiedExportName(tempDirectory, 'tail')] as (
      values: Array<number | string | null | undefined>,
      start: number,
    ) => Array<number | string | null | undefined>;
    const trim = instance.exports[await resolveQualifiedExportName(tempDirectory, 'trim')] as (
      values: Array<number | string | null | undefined>,
      end: number,
    ) => Array<number | string | null | undefined>;
    const values: Array<number | string | null | undefined> = [1, 'x', null, undefined];

    assertEquals(copy(values), [1, 'x', null, undefined]);
    assertEquals(tail(values, -2), [null, undefined]);
    assertEquals(trim(values, 2), [1, 'x']);
    assertEquals(values, [1, 'x', null, undefined]);
  },
);

compilerArrayTest(
  'compileProject reverses exported tagged primitive arrays in place and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: Array<number | string | null | undefined>): Array<number | string | null | undefined> {',
      '  return values.reverse();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<number | string | null | undefined>,
    ) => Array<number | string | null | undefined>;
    const values: Array<number | string | null | undefined> = [1, 'yak', null, undefined];
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, [undefined, null, 'yak', 1]);
  },
);

compilerArrayTest(
  'compileProject fills exported tagged primitive arrays in place with optional numeric bounds and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(',
      '  values: Array<number | string | null | undefined>,',
      '  value: number | string | null | undefined,',
      '  start: number | undefined,',
      '  end: number | undefined,',
      '): Array<number | string | null | undefined> {',
      '  return values.fill(value, start, end);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<number | string | null | undefined>,
      value: number | string | null | undefined,
      start: number | undefined,
      end: number | undefined,
    ) => Array<number | string | null | undefined>;
    const values: Array<number | string | null | undefined> = [1, 'yak', null, undefined];
    const returned = main(values, 'owl', 1, undefined);

    assertStrictEquals(returned, values);
    assertEquals(values, [1, 'owl', 'owl', 'owl']);
  },
);

compilerArrayTest(
  'compileProject copyWithin mutates exported tagged primitive arrays in place and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(',
      '  values: Array<number | string | null | undefined>,',
      '  target: number,',
      '  start: number,',
      '  end: number | undefined,',
      '): Array<number | string | null | undefined> {',
      '  return values.copyWithin(target, start, end);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: Array<number | string | null | undefined>,
      target: number,
      start: number,
      end: number | undefined,
    ) => Array<number | string | null | undefined>;
    const values: Array<number | string | null | undefined> = [1, 'yak', null, undefined];
    const returned = main(values, 1, 0, 2);

    assertStrictEquals(returned, values);
    assertEquals(values, [1, 1, 'yak', undefined]);
  },
);

compilerArrayTest(
  'compileProject reads tagged primitive arrays through at with negative and out-of-range indices',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function score(values: Array<number | string | null | undefined>, index: number): number {',
      '  const found = values.at(index);',
      '  if (found === undefined) {',
      '    return 100;',
      '  }',
      '  if (found === null) {',
      '    return 50;',
      '  }',
      '  if (typeof found === "string") {',
      '    return found.length * 10;',
      '  }',
      '  return found;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: Array<number | string | null | undefined>,
      index: number,
    ) => number;
    const values: Array<number | string | null | undefined> = [1, 'yak', null, undefined, 9];

    assertEquals(score(values, -1), 9);
    assertEquals(score(values, 1), 30);
    assertEquals(score(values, -3), 50);
    assertEquals(score(values, Number.NaN), 1);
    assertEquals(score(values, 99), 100);
  },
);

compilerArrayTest(
  'compileProject checks tagged primitive array includes with SameValueZero semantics',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function score(',
      '  values: Array<number | string | null | undefined>,',
      '  needle: number,',
      '  start: number | undefined,',
      '  tailStart: number,',
      '  lateStart: number,',
      '): number {',
      '  let score = 0;',
      '  if (values.includes(needle)) {',
      '    score = score + 1;',
      '  }',
      '  if (values.includes("yak", start)) {',
      '    score = score + 10;',
      '  }',
      '  if (values.includes(null, tailStart)) {',
      '    score = score + 100;',
      '  }',
      '  if (values.includes(undefined, lateStart)) {',
      '    score = score + 1000;',
      '  }',
      '  return score;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: Array<number | string | null | undefined>,
      needle: number,
      start: number | undefined,
      tailStart: number,
      lateStart: number,
    ) => number;
    const values: Array<number | string | null | undefined> = [
      1,
      'yak',
      null,
      Number.NaN,
      undefined,
    ];

    assertEquals(score(values, Number.NaN, undefined, -3, 4), 1111);
    assertEquals(score(values, Number.NaN, 2, -3, 4), 1101);
  },
);

compilerArrayTest(
  'compileProject searches tagged primitive arrays through indexOf and lastIndexOf',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function score(',
      '  values: Array<number | string | null | undefined>,',
      '  needle: number,',
      '  start: number | undefined,',
      '  tailStart: number,',
      '): number {',
      '  return values.indexOf("yak", start) +',
      '    values.indexOf(needle) * 10 +',
      '    values.indexOf(null) * 100 +',
      '    values.lastIndexOf(undefined) * 1000 +',
      '    values.lastIndexOf("yak", tailStart) * 10000;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: Array<number | string | null | undefined>,
      needle: number,
      start: number | undefined,
      tailStart: number,
    ) => number;
    const values: Array<number | string | null | undefined> = [
      1,
      'yak',
      null,
      Number.NaN,
      undefined,
      'yak',
    ];

    assertEquals(score(values, Number.NaN, undefined, -2), 14191);
    assertEquals(score(values, Number.NaN, 2, -2), 14195);
  },
);

compilerArrayTest(
  'compileProject reduces owned string arrays through callback index and array params',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const values: string[] = ["a", "bee", "see"];',
      '  return values.reduce((acc: string, value: string, index: number, array: string[]): string => {',
      '    if (index === array.length - 1) {',
      '      return acc + value.charAt(0);',
      '    }',
      '    return acc + value;',
      '  }, "-");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      string;

    assertEquals(main(), '-abees');
  },
);

compilerArrayTest(
  'compileProject executes owned number array reduce with mutable closure capture',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(start: number): number {',
      '  let seen = 0;',
      '  const values: number[] = [1, 2, 3];',
      '  const total = values.reduce((acc: number, value: number): number => {',
      '    seen = seen + 1;',
      '    return acc + value;',
      '  }, start);',
      '  return seen * 100 + total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4]), 310);
  },
);

compilerArrayTest(
  'compileProject keeps owned array reduce without an explicit initial value unsupported for now',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: number[] = [1, 2, 3];',
      '  return values.reduce((acc: number, value: number): number => acc + value);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.source === 'compiler'), true);
  },
);

compilerArrayTest(
  'compileProject reduces owned number arrays across accumulator families',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): boolean {',
      '  const values: number[] = [1, 2, 3];',
      '  return values.reduce((acc: boolean, value: number): boolean => {',
      '    if (acc) {',
      '      return true;',
      '    }',
      '    return value > 1;',
      '  }, false);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as () =>
      number;

    assertEquals(main(), 1);
  },
);

compilerArrayTest(
  'compileProject reduces owned number arrays through tagged union accumulators',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(useNumber: boolean): number {',
      '  const values: number[] = [1, 2, 3];',
      '  let initial: number | boolean = false;',
      '  if (useNumber) {',
      '    initial = 0;',
      '  }',
      '  const result = values.reduce((acc: number | boolean, value: number): number | boolean => {',
      '    if (typeof acc === "number") {',
      '      return acc + value;',
      '    }',
      '    if (acc) {',
      '      return value > 1;',
      '    }',
      '    return value;',
      '  }, initial);',
      '  if (typeof result === "number") {',
      '    return result;',
      '  }',
      '  if (result) {',
      '    return 100;',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      useNumber: boolean,
    ) => number;

    assertEquals(main(true), 6);
    assertEquals(main(false), 6);
  },
);

compilerArrayTest(
  'compileProject keeps non-boolean owned array find callbacks unsupported for now',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: number[] = [1, 2, 3];',
      '  const found = values.find((value: number): number => value);',
      '  if (found !== undefined) {',
      '    return found;',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.source === 'compiler'), true);
  },
);

compilerArrayTest(
  'compileProject checks owned string array indexOf with content equality and JS fromIndex normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(fromIndex: number): number {',
      '  const derived = "ants".slice(0, 3);',
      '  const values: string[] = [derived, "bee", "ant"];',
      '  return values.indexOf("ant", fromIndex);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);

    assertEquals(watOutput.includes('(import "soundscript_string" "index_of"'), false);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 0);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 2);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [3]), -1);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [-1]), 2);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [Number.POSITIVE_INFINITY]), -1);
  },
);

compilerArrayTest(
  'compileProject checks owned string array lastIndexOf with content equality and JS fromIndex normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(fromIndex: number): number {',
      '  const derived = "ants".slice(0, 3);',
      '  const values: string[] = [derived, "bee", "ant"];',
      '  return values.lastIndexOf("ant", fromIndex);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);

    assertEquals(watOutput.includes('(import "soundscript_string" "last_index_of"'), false);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 0);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 0);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [2]), 2);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [3]), 2);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [-2]), 0);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [Number.POSITIVE_INFINITY]), 2);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [Number.NEGATIVE_INFINITY]), -1);
  },
);

compilerArrayTest(
  'compileProject adapts exported string array at through tagged host boundaries with JS index normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[], index: number): string | undefined {',
      '  return values.at(index);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: string[],
      index: number,
    ) => string | undefined;
    const values = ['ant', 'bee', 'cat'];

    assertEquals(main(values, 0), 'ant');
    assertEquals(main(values, -1), 'cat');
    assertEquals(main(values, 1.9), 'bee');
    assertEquals(main(values, -1.9), 'cat');
    assertEquals(main(values, Number.NaN), 'ant');
    assertEquals(main(values, Number.POSITIVE_INFINITY), undefined);
    assertEquals(main(values, -99), undefined);
  },
);

compilerArrayTest(
  'compileProject passes user-authored number array literals through internal helper params and returns',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function build(left: number, right: number): number[] {',
      '  return [left, right, 9];',
      '}',
      '',
      'function pick(values: number[], index: number): number {',
      '  return values[index];',
      '}',
      '',
      'export function main(left: number, right: number, index: number): number {',
      '  return pick(build(left, right), index);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const build = moduleIR.functions.find((func) => func.name === 'build');
    const pick = moduleIR.functions.find((func) => func.name === 'pick');
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      left: number,
      right: number,
      index: number,
    ) => number;

    assertEquals(build?.resultType, 'owned_number_array_ref');
    assertEquals(pick?.params[0]?.type, 'owned_number_array_ref');
    assertEquals(main(3, 5, 0), 3);
    assertEquals(main(3, 5, 1), 5);
    assertEquals(main(3, 5, 2), 9);
  },
);

compilerArrayTest(
  'compileProject materializes user-authored number array literals onto the owned array runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(index: number): number {',
      '  const values: number[] = [1, 2, 5];',
      '  return values.length + values[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);

    assertStringIncludes(watOutput, '(type $owned_number_array_data (array (mut f64)))');
    assertStringIncludes(
      watOutput,
      '(type $owned_number_array (struct (field (mut (ref null $owned_number_array_data)))))',
    );
    assertStringIncludes(watOutput, 'array.new_default $owned_number_array_data');
    assertStringIncludes(watOutput, 'array.set $owned_number_array_data');
    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $string_to_owned'), false);
    assertEquals(watOutput.includes('call $owned_string_to_host'), false);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 3 + 1);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [2]), 3 + 5);
  },
);

compilerArrayTest(
  'compileProject scalarizes number-array length views through structural call boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type NumberView = { length: number };',
      '',
      'function consume(values: NumberView): number {',
      '  return values.length;',
      '}',
      '',
      'export function main(): number {',
      '  return consume([1, 2, 3]);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as () => number;

    assertEquals(main(), 3);
  },
);

compilerArrayTest(
  'compileProject scalarizes non-exported number-array length-view helper returns through helper chaining',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type NumberView = { length: number };',
      '',
      'function build(): NumberView {',
      '  return [1, 2, 3];',
      '}',
      '',
      'function consume(values: NumberView): number {',
      '  return values.length;',
      '}',
      '',
      'export function main(): number {',
      '  return consume(build());',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as () => number;

    assertEquals(main(), 3);
  },
);

compilerArrayTest(
  'compileProject adapts exported number array params through the owned array runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[], index: number): number {',
      '  return values.length + values[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: number[], index: number) => number;

    assertStringIncludes(watOutput, '(import "soundscript_array" "length"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "get_number"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "clear"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "push_number"');
    assertEquals(watOutput.includes('(import "soundscript_array" "empty_number"'), false);
    assertEquals(main([3, 5, 8], 1), 3 + 5);
  },
);

compilerArrayTest(
  'compileProject executes owned number array at(index) through tagged nullable results and narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: number[], index: number): number | undefined {',
      '  return values.at(index);',
      '}',
      '',
      'export function next(values: number[], index: number): number {',
      '  const value = values.at(index);',
      '  if (value === undefined) {',
      '    return 0;',
      '  }',
      '  return value * 2;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: number[],
      index: number,
    ) => number | undefined;
    const next = instance.exports[await resolveQualifiedExportName(tempDirectory, 'next')] as (
      values: number[],
      index: number,
    ) => number;

    assertEquals(maybe([3, 5, 8], 0), 3);
    assertEquals(maybe([3, 5, 8], -1), 8);
    assertEquals(maybe([3, 5, 8], 3), undefined);
    assertEquals(next([3, 5, 8], -1), 16);
    assertEquals(next([3, 5, 8], 7), 0);
  },
);

compilerArrayTest(
  'compileProject pops owned number arrays through tagged results and exported mutation copy-back without string runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: number[]): number | undefined {',
      '  return values.pop();',
      '}',
      '',
      'export function score(values: number[]): number {',
      '  const value = values.pop();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  return value * 2 + values.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: number[],
    ) => number | undefined;
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: number[],
    ) => number;
    const first = [3, 5, 8];
    const second: number[] = [];
    const third = [3, 5, 8];
    const fourth: number[] = [];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $tag_string'), false);
    assertEquals(maybe(first), 8);
    assertEquals(first, [3, 5]);
    assertEquals(maybe(second), undefined);
    assertEquals(second, []);
    assertEquals(score(third), 18);
    assertEquals(third, [3, 5]);
    assertEquals(score(fourth), 0);
    assertEquals(fourth, []);
  },
);

compilerArrayTest(
  'compileProject shifts owned number arrays through tagged results and exported mutation copy-back without string runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: number[]): number | undefined {',
      '  return values.shift();',
      '}',
      '',
      'export function score(values: number[]): number {',
      '  const value = values.shift();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  return value * 2 + values.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: number[],
    ) => number | undefined;
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: number[],
    ) => number;
    const first = [3, 5, 8];
    const second: number[] = [];
    const third = [3, 5, 8];
    const fourth: number[] = [];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $tag_string'), false);
    assertEquals(maybe(first), 3);
    assertEquals(first, [5, 8]);
    assertEquals(maybe(second), undefined);
    assertEquals(second, []);
    assertEquals(score(third), 8);
    assertEquals(third, [5, 8]);
    assertEquals(score(fourth), 0);
    assertEquals(fourth, []);
  },
);

compilerArrayTest(
  'compileProject adapts exported number array results through the owned array runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: number, right: number): number[] {',
      '  return [left, right, 9];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: number, right: number) => number[];

    assertStringIncludes(watOutput, '(import "soundscript_array" "empty_number"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "push_number"');
    assertEquals(watOutput.includes('(import "soundscript_array" "get_number"'), false);
    assertEquals(main(3, 5), [3, 5, 9]);
  },
);

compilerArrayTest(
  'compileProject supports user-authored number array reassignment across branches',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: boolean, index: number): number {',
      '  let values: number[] = [0];',
      '  if (flag) {',
      '    values = [1, 2];',
      '  } else {',
      '    values = [3, 4];',
      '  }',
      '  return values[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (flag: boolean, index: number) => number;

    assertEquals(main(true, 1), 2);
    assertEquals(main(false, 0), 3);
  },
);

compilerArrayTest(
  'compileProject adapts sliced exported number arrays through the owned array runtime without mutating the input',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[], start: number, end: number): number[] {',
      '  return values.slice(start, end);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: number[],
      start: number,
      end: number,
    ) => number[];
    const values = [1, 2, 3, 4];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(main(values, 1, -1), [2, 3]);
    assertEquals(values, [1, 2, 3, 4]);
  },
);

compilerArrayTest(
  'compileProject splices owned number arrays by mutating the receiver and returning removed values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function localScore(): number {',
      '  const values: number[] = [3, 5, 8, 13];',
      '  const removed = values.splice(1, 2);',
      '  return values.length + removed.length + values[1] + removed[0] + removed[1];',
      '}',
      '',
      'export function exported(values: number[]): number[] {',
      '  return values.splice(1, 2);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const localScore = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'localScore')] as () => number;
    const exported = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'exported')] as (
        values: number[],
      ) => number[];
    const values = [3, 5, 8, 13];
    const removed = exported(values);

    assertEquals(localScore(), 2 + 2 + 13 + 5 + 8);
    assertEquals(removed, [5, 8]);
    assertEquals(values, [3, 13]);
    assertEquals(removed === values, false);
  },
);

compilerArrayTest(
  'compileProject clamps owned number array splice deleteCount like JS for infinity-valued expressions',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number[] {',
      '  const deleteCount = 1 / 0;',
      '  return values.splice(1, deleteCount);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: number[],
    ) => number[];
    const values = [3, 5, 8, 13];

    assertEquals(main(values), [5, 8, 13]);
    assertEquals(values, [3]);
  },
);

compilerArrayTest(
  'compileProject treats zero deleteCount owned number array splice as insertion-only',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number[] {',
      '  return values.splice(1, 0, 21, 34);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: number[],
    ) => number[];
    const values = [3, 5, 8, 13];

    assertEquals(main(values), []);
    assertEquals(values, [3, 21, 34, 5, 8, 13]);
  },
);

compilerArrayTest(
  'compileProject splices owned number arrays with same-kind scalar insert args',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function exported(values: number[]): number[] {',
      '  return values.splice(1, 2, 21, 34);',
      '}',
      '',
      'export function localScore(): number {',
      '  const values: number[] = [3, 5, 8, 13];',
      '  const removed = values.splice(1, 2, 21, 34);',
      '  return values.length + removed.length + values[1] + values[2] + removed[0] + removed[1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const localScore = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'localScore')] as () => number;
    const exported = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'exported')] as (
        values: number[],
      ) => number[];
    const values = [3, 5, 8, 13];
    const removed = exported(values);

    assertEquals(localScore(), 4 + 2 + 21 + 34 + 5 + 8);
    assertEquals(removed, [5, 8]);
    assertEquals(values, [3, 21, 34, 13]);
  },
);

compilerArrayTest(
  'compileProject fills exported number arrays in place with JS start/end normalization and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[], start: number, end: number): number[] {',
      '  return values.fill(9, start, end);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: number[],
      start: number,
      end: number,
    ) => number[];
    const values = [1, 2, 3, 4];
    const returned = main(values, 1, -1);

    assertStrictEquals(returned, values);
    assertEquals(values, [1, 9, 9, 4]);
  },
);

compilerArrayTest(
  'compileProject reverses exported number arrays in place and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number[] {',
      '  return values.reverse();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: number[]) => number[];
    const values = [1, 2, 5];
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, [5, 2, 1]);
  },
);

compilerArrayTest(
  'compileProject copyWithin mutates owned number arrays in place and preserves host identity',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[], target: number, start: number, end: number): number[] {',
      '  return values.copyWithin(target, start, end);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: number[],
      target: number,
      start: number,
      end: number,
    ) => number[];
    const values = [1, 2, 3, 4, 5];
    const expected = [...values];
    expected.copyWithin(-4, 2, -1);
    const returned = main(values, -4, 2, -1);

    assertStrictEquals(returned, values);
    assertEquals(values, expected);
  },
);

compilerArrayTest(
  'compileProject copies back exported number array copyWithin mutations through local aliases',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number[] {',
      '  const alias = values;',
      '  return alias.copyWithin(1, 0, 1);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: number[]) => number[];
    const values = [1, 2, 5];
    const expected = [...values];
    expected.copyWithin(1, 0, 1);
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, expected);
  },
);

compilerArrayTest(
  'compileProject concatenates exported number arrays with scalar items and multiple args through the owned array runtime without mutating the inputs',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: number[], right: number[]): number[] {',
      '  return left.concat(3, right, 8);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: number[], right: number[]) => number[];
    const left = [1, 2];
    const right = [5, 8];

    assertEquals(main(left, right), [1, 2, 3, 5, 8, 8]);
    assertEquals(left, [1, 2]);
    assertEquals(right, [5, 8]);
  },
);

compilerArrayTest(
  'compileProject joins owned number arrays with JS number stringification and pay-for-play host bridges',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[], separator: string): string {',
      '  return values.join(separator);',
      '}',
      '',
      'export function defaults(values: number[]): string {',
      '  return values.join();',
      '}',
      '',
      'export function maybe(values: number[], separator: string | undefined): string {',
      '  return values.join(separator);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: number[],
      separator: string,
    ) => string;
    const defaults = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'defaults')] as (
        values: number[],
      ) => string;
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: number[],
      separator: string | undefined,
    ) => string;

    assertStringIncludes(watOutput, 'call $tagged_from_number');
    assertStringIncludes(watOutput, '(import "soundscript_string" "concat"');
    assertStringIncludes(watOutput, 'call $string_to_owned');
    assertEquals(watOutput.includes('call $tagged_from_boolean'), false);
    assertEquals(main([1.5, Number.NaN, Number.POSITIVE_INFINITY], '|'), '1.5|NaN|Infinity');
    assertEquals(main([], '|'), '');
    assertEquals(defaults([1, 23, 0]), '1,23,0');
    assertEquals(maybe([1, 23], undefined), '1,23');
    assertEquals(maybe([1, 23], ':'), '1:23');
  },
);

compilerArrayTest(
  'compileProject supports omitted and undefined array slice bounds on exported number arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function copy(values: number[]): number[] {',
      '  return values.slice();',
      '}',
      '',
      'export function trim(values: number[], end: number): number[] {',
      '  return values.slice(undefined, end);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const copyExportName = await resolveQualifiedExportName(tempDirectory, 'copy');
    const trimExportName = await resolveQualifiedExportName(tempDirectory, 'trim');
    const copy = instance.exports[copyExportName] as (values: number[]) => number[];
    const trim = instance.exports[trimExportName] as (values: number[], end: number) => number[];
    const values = [1, 2, 3, 4];

    assertEquals(copy(values), [1, 2, 3, 4]);
    assertEquals(trim(values, -1), [1, 2, 3]);
    assertEquals(values, [1, 2, 3, 4]);
  },
);

compilerArrayTest(
  'compileProject checks owned number array includes with SameValueZero and JS fromIndex normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function hasNeedle(needle: number, fromIndex: number): boolean {',
      '  const values: number[] = [0, 0 / 0, 7, 0];',
      '  return values.includes(needle, fromIndex);',
      '}',
      '',
      'export function hasZero(search: number, fromIndex: number): boolean {',
      '  const values: number[] = [0, 0 / 0, 7];',
      '  return values.includes(search, fromIndex);',
      '}',
      '',
      'export function hasSeven(values: number[], fromIndex: number): boolean {',
      '  return values.includes(7, fromIndex);',
      '}',
      '',
      'export function hasSevenMaybe(values: number[], useFromIndex: boolean, fromIndex: number): boolean {',
      '  let maybe: number | undefined = undefined;',
      '  if (useFromIndex) {',
      '    maybe = fromIndex;',
      '  }',
      '  return values.includes(7, maybe);',
      '}',
      '',
      'export function hasSevenUndefined(): boolean {',
      '  const values: number[] = [7];',
      '  return values.includes(7, undefined);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const hasNeedleName = await resolveQualifiedExportName(tempDirectory, 'hasNeedle');
    const hasZeroName = await resolveQualifiedExportName(tempDirectory, 'hasZero');
    const hasSevenName = await resolveQualifiedExportName(tempDirectory, 'hasSeven');
    const hasSevenMaybeName = await resolveQualifiedExportName(tempDirectory, 'hasSevenMaybe');
    const hasSevenUndefinedName = await resolveQualifiedExportName(
      tempDirectory,
      'hasSevenUndefined',
    );
    const hasNeedle = instance.exports[hasNeedleName] as (
      needle: number,
      fromIndex: number,
    ) => number;
    const hasZero = instance.exports[hasZeroName] as (search: number, fromIndex: number) => number;
    const hasSeven = instance.exports[hasSevenName] as (
      values: number[],
      fromIndex: number,
    ) => number;
    const hasSevenMaybe = instance.exports[hasSevenMaybeName] as (
      values: number[],
      useFromIndex: number,
      fromIndex: number,
    ) => number;
    const hasSevenUndefined = instance.exports[hasSevenUndefinedName] as () => number;
    const values = [1, 7, 9];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $string_to_owned'), false);
    assertEquals(watOutput.includes('call $owned_string_to_host'), false);
    assertEquals(hasNeedle(Number.NaN, 0), 1);
    assertEquals(hasNeedle(Number.NaN, 2), 0);
    assertEquals(hasZero(-0, 0), 1);
    assertEquals(hasZero(-0, 1), 0);
    assertEquals(hasSeven(values, Number.NaN), 1);
    assertEquals(hasSeven(values, 1.8), 1);
    assertEquals(hasSeven(values, Number.POSITIVE_INFINITY), 0);
    assertEquals(hasSeven(values, Number.NEGATIVE_INFINITY), 1);
    assertEquals(hasSevenMaybe(values, 0, 2), 1);
    assertEquals(hasSevenMaybe(values, 1, 2), 0);
    assertEquals(hasSevenUndefined(), 1);
    assertEquals(values, [1, 7, 9]);
  },
);

compilerArrayTest(
  'compileProject checks owned number array indexOf with strict equality and JS fromIndex normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function findNeedle(needle: number, fromIndex: number): number {',
      '  const values: number[] = [0, 0 / 0, 7, 0];',
      '  return values.indexOf(needle, fromIndex);',
      '}',
      '',
      'export function findSeven(values: number[], fromIndex: number): number {',
      '  return values.indexOf(7, fromIndex);',
      '}',
      '',
      'export function findSevenMaybe(values: number[], useFromIndex: boolean, fromIndex: number): number {',
      '  let maybe: number | undefined = undefined;',
      '  if (useFromIndex) {',
      '    maybe = fromIndex;',
      '  }',
      '  return values.indexOf(7, maybe);',
      '}',
      '',
      'export function findSevenUndefined(): number {',
      '  const values: number[] = [7];',
      '  return values.indexOf(7, undefined);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const findNeedleName = await resolveQualifiedExportName(tempDirectory, 'findNeedle');
    const findSevenName = await resolveQualifiedExportName(tempDirectory, 'findSeven');
    const findSevenMaybeName = await resolveQualifiedExportName(tempDirectory, 'findSevenMaybe');
    const findSevenUndefinedName = await resolveQualifiedExportName(
      tempDirectory,
      'findSevenUndefined',
    );
    const findNeedle = instance.exports[findNeedleName] as (
      needle: number,
      fromIndex: number,
    ) => number;
    const findSeven = instance.exports[findSevenName] as (
      values: number[],
      fromIndex: number,
    ) => number;
    const findSevenMaybe = instance.exports[findSevenMaybeName] as (
      values: number[],
      useFromIndex: number,
      fromIndex: number,
    ) => number;
    const findSevenUndefined = instance.exports[findSevenUndefinedName] as () => number;
    const values = [1, 7, 9, 7];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $string_to_owned'), false);
    assertEquals(watOutput.includes('call $owned_string_to_host'), false);
    assertEquals(findNeedle(Number.NaN, 0), -1);
    assertEquals(findNeedle(-0, 1), 3);
    assertEquals(findSeven(values, Number.NaN), 1);
    assertEquals(findSeven(values, 1.8), 1);
    assertEquals(findSeven(values, Number.POSITIVE_INFINITY), -1);
    assertEquals(findSeven(values, Number.NEGATIVE_INFINITY), 1);
    assertEquals(findSevenMaybe(values, 0, 3), 1);
    assertEquals(findSevenMaybe(values, 1, 3), 3);
    assertEquals(findSevenUndefined(), 0);
    assertEquals(values, [1, 7, 9, 7]);
  },
);

compilerArrayTest(
  'compileProject checks owned number array lastIndexOf with strict equality and JS fromIndex normalization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function findNeedle(needle: number, fromIndex: number): number {',
      '  const values: number[] = [0, 0 / 0, 7, 0];',
      '  return values.lastIndexOf(needle, fromIndex);',
      '}',
      '',
      'export function findSeven(values: number[], fromIndex: number): number {',
      '  return values.lastIndexOf(7, fromIndex);',
      '}',
      '',
      'export function findSevenMaybe(values: number[], useFromIndex: boolean, fromIndex: number): number {',
      '  let maybe: number | undefined = undefined;',
      '  if (useFromIndex) {',
      '    maybe = fromIndex;',
      '  }',
      '  return values.lastIndexOf(7, maybe);',
      '}',
      '',
      'export function findSevenUndefined(): number {',
      '  const values: number[] = [7];',
      '  return values.lastIndexOf(7, undefined);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const findNeedleName = await resolveQualifiedExportName(tempDirectory, 'findNeedle');
    const findSevenName = await resolveQualifiedExportName(tempDirectory, 'findSeven');
    const findSevenMaybeName = await resolveQualifiedExportName(tempDirectory, 'findSevenMaybe');
    const findSevenUndefinedName = await resolveQualifiedExportName(
      tempDirectory,
      'findSevenUndefined',
    );
    const findNeedle = instance.exports[findNeedleName] as (
      needle: number,
      fromIndex: number,
    ) => number;
    const findSeven = instance.exports[findSevenName] as (
      values: number[],
      fromIndex: number,
    ) => number;
    const findSevenMaybe = instance.exports[findSevenMaybeName] as (
      values: number[],
      useFromIndex: number,
      fromIndex: number,
    ) => number;
    const findSevenUndefined = instance.exports[findSevenUndefinedName] as () => number;
    const values = [1, 7, 9, 7];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $string_to_owned'), false);
    assertEquals(watOutput.includes('call $owned_string_to_host'), false);
    assertEquals(findNeedle(Number.NaN, Number.POSITIVE_INFINITY), -1);
    assertEquals(findNeedle(-0, Number.POSITIVE_INFINITY), 3);
    assertEquals(findSeven(values, Number.NaN), -1);
    assertEquals(findSeven(values, 2.8), 1);
    assertEquals(findSeven(values, Number.POSITIVE_INFINITY), 3);
    assertEquals(findSeven(values, Number.NEGATIVE_INFINITY), -1);
    assertEquals(findSevenMaybe(values, 0, 1), 3);
    assertEquals(findSevenMaybe(values, 1, 2), 1);
    assertEquals(findSevenUndefined(), 0);
    assertEquals(values, [1, 7, 9, 7]);
  },
);

compilerArrayTest(
  'compileProject adapts exported number array at through tagged host boundaries without string runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[], index: number): number | undefined {',
      '  return values.at(index);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: number[],
      index: number,
    ) => number | undefined;
    const values = [1, 2, 3];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $tag_string'), false);
    assertEquals(main(values, 0), 1);
    assertEquals(main(values, -1), 3);
    assertEquals(main(values, 1.9), 2);
    assertEquals(main(values, -1.9), 3);
    assertEquals(main(values, Number.NaN), 1);
    assertEquals(main(values, Number.NEGATIVE_INFINITY), undefined);
    assertEquals(main(values, 99), undefined);
  },
);

compilerArrayTest(
  'compileProject passes user-authored boolean array literals through internal helper params and returns',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'function build(left: boolean, right: boolean): boolean[] {',
      '  return [left, right, true];',
      '}',
      '',
      'function pick(values: boolean[], index: number): boolean {',
      '  return values[index];',
      '}',
      '',
      'export function main(left: boolean, right: boolean, index: number): boolean {',
      '  return pick(build(left, right), index);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const build = moduleIR.functions.find((func) => func.name === 'build');
    const pick = moduleIR.functions.find((func) => func.name === 'pick');
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      left: boolean,
      right: boolean,
      index: number,
    ) => number;

    assertEquals(build?.resultType, 'owned_boolean_array_ref');
    assertEquals(pick?.params[0]?.type, 'owned_boolean_array_ref');
    assertEquals(main(false, true, 0), 0);
    assertEquals(main(false, true, 1), 1);
    assertEquals(main(false, true, 2), 1);
  },
);

compilerArrayTest(
  'compileProject materializes user-authored boolean array literals onto the owned array runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(index: number): boolean {',
      '  const values: boolean[] = [false, true, false];',
      '  return values[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);

    assertStringIncludes(watOutput, '(type $owned_boolean_array_data (array (mut i32)))');
    assertStringIncludes(
      watOutput,
      '(type $owned_boolean_array (struct (field (mut (ref null $owned_boolean_array_data)))))',
    );
    assertStringIncludes(watOutput, 'array.new_default $owned_boolean_array_data');
    assertStringIncludes(watOutput, 'array.set $owned_boolean_array_data');
    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('(type $owned_number_array'), false);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 0);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 1);
  },
);

compilerArrayTest(
  'compileProject scalarizes boolean-array length views through structural call boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type BooleanView = { length: number };',
      '',
      'function consume(values: BooleanView): number {',
      '  return values.length;',
      '}',
      '',
      'export function main(): number {',
      '  return consume([true, false, true, false]);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as () => number;

    assertEquals(main(), 4);
  },
);

compilerArrayTest(
  'compileProject scalarizes non-exported boolean-array length-view helper returns through helper chaining',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type BooleanView = { length: number };',
      '',
      'function build(): BooleanView {',
      '  return [true, false, true, false];',
      '}',
      '',
      'function consume(values: BooleanView): number {',
      '  return values.length;',
      '}',
      '',
      'export function main(): number {',
      '  return consume(build());',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as () => number;

    assertEquals(main(), 4);
  },
);

compilerArrayTest(
  'compileProject scalarizes branch-joined number-array length views through structural locals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type NumberView = { length: number };',
      '',
      'export function main(flag: boolean): number {',
      '  let values: NumberView = [1, 2, 3];',
      '  if (flag) {',
      '    values = { length: 7 };',
      '  }',
      '  return values.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (flag: boolean) => number;

    assertEquals(main(false), 3);
    assertEquals(main(true), 7);
  },
);

compilerArrayTest(
  'compileProject scalarizes non-exported number-array length-view helper returns',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type NumberView = { length: number };',
      '',
      'function build(): NumberView {',
      '  return [1, 2, 3];',
      '}',
      '',
      'export function main(): number {',
      '  return build().length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerArrayTest(
  'compileProject scalarizes non-exported boolean-array length-view helper returns',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type BooleanView = { length: number };',
      '',
      'function build(): BooleanView {',
      '  return [true, false, true, false];',
      '}',
      '',
      'export function main(): number {',
      '  return build().length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 4);
  },
);

compilerArrayTest(
  'compileProject adapts exported boolean array params through the owned array runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[], index: number): boolean {',
      '  return values[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[], index: number) => number;

    assertStringIncludes(watOutput, '(import "soundscript_array" "length"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "get_boolean"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "clear"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "push_boolean"');
    assertEquals(watOutput.includes('(import "soundscript_array" "empty_boolean"'), false);
    assertEquals(main([false, true, false], 1), 1);
  },
);

compilerArrayTest(
  'compileProject executes owned boolean array at(index) through tagged nullable results and narrowing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: boolean[], index: number): boolean | undefined {',
      '  return values.at(index);',
      '}',
      '',
      'export function keep(values: boolean[], index: number): boolean {',
      '  const value = values.at(index);',
      '  if (value === undefined) {',
      '    return false;',
      '  }',
      '  return value;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: boolean[],
      index: number,
    ) => boolean | undefined;
    const keep = instance.exports[await resolveQualifiedExportName(tempDirectory, 'keep')] as (
      values: boolean[],
      index: number,
    ) => number;

    assertEquals(maybe([false, true, false], 1), true);
    assertEquals(maybe([false, true, false], -1), false);
    assertEquals(maybe([false, true, false], -4), undefined);
    assertEquals(keep([false, true, false], 1), 1);
    assertEquals(keep([false, true, false], 9), 0);
  },
);

compilerArrayTest(
  'compileProject pops owned boolean arrays through tagged results and exported mutation copy-back without string runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: boolean[]): boolean | undefined {',
      '  return values.pop();',
      '}',
      '',
      'export function score(values: boolean[]): number {',
      '  const value = values.pop();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  if (value) {',
      '    return values.length + 1;',
      '  }',
      '  return values.length + 2;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: boolean[],
    ) => boolean | undefined;
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: boolean[],
    ) => number;
    const first = [false, true, false];
    const second: boolean[] = [];
    const third = [false, true, true];
    const fourth: boolean[] = [];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $tag_string'), false);
    assertEquals(maybe(first), false);
    assertEquals(first, [false, true]);
    assertEquals(maybe(second), undefined);
    assertEquals(second, []);
    assertEquals(score(third), 3);
    assertEquals(third, [false, true]);
    assertEquals(score(fourth), 0);
    assertEquals(fourth, []);
  },
);

compilerArrayTest(
  'compileProject shifts owned boolean arrays through tagged results and exported mutation copy-back without string runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function maybe(values: boolean[]): boolean | undefined {',
      '  return values.shift();',
      '}',
      '',
      'export function score(values: boolean[]): number {',
      '  const value = values.shift();',
      '  if (value === undefined) {',
      '    return values.length;',
      '  }',
      '  if (value) {',
      '    return values.length + 1;',
      '  }',
      '  return values.length + 2;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      values: boolean[],
    ) => boolean | undefined;
    const score = instance.exports[await resolveQualifiedExportName(tempDirectory, 'score')] as (
      values: boolean[],
    ) => number;
    const first = [false, true, false];
    const second: boolean[] = [];
    const third = [true, false, true];
    const fourth: boolean[] = [];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $tag_string'), false);
    assertEquals(maybe(first), false);
    assertEquals(first, [true, false]);
    assertEquals(maybe(second), undefined);
    assertEquals(second, []);
    assertEquals(score(third), 3);
    assertEquals(third, [false, true]);
    assertEquals(score(fourth), 0);
    assertEquals(fourth, []);
  },
);

compilerArrayTest(
  'compileProject adapts exported boolean array results through the owned array runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: boolean, right: boolean): boolean[] {',
      '  return [left, right, true];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: boolean, right: boolean) => boolean[];

    assertStringIncludes(watOutput, '(import "soundscript_array" "empty_boolean"');
    assertStringIncludes(watOutput, '(import "soundscript_array" "push_boolean"');
    assertEquals(watOutput.includes('(import "soundscript_array" "get_boolean"'), false);
    assertEquals(main(false, true), [false, true, true]);
  },
);

compilerArrayTest(
  'compileProject supports user-authored boolean array reassignment across branches',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: boolean, index: number): boolean {',
      '  let values: boolean[] = [false];',
      '  if (flag) {',
      '    values = [false, true];',
      '  } else {',
      '    values = [true, false];',
      '  }',
      '  return values[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (flag: boolean, index: number) => number;

    assertEquals(main(true, 1), 1);
    assertEquals(main(false, 0), 1);
  },
);

compilerArrayTest(
  'compileProject slices owned boolean arrays with omitted end and negative indices',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(start: number, end: number, hasEnd: boolean): number {',
      '  const values: boolean[] = [false, true, false, true];',
      '  let sliced: boolean[] = [false];',
      '  let total = 0;',
      '  if (hasEnd) {',
      '    sliced = values.slice(start, end);',
      '  } else {',
      '    sliced = values.slice(start);',
      '  }',
      '  total = total + sliced.length;',
      '  if (sliced[0]) {',
      '    total = total + 1;',
      '  }',
      '  if (sliced[sliced.length - 1]) {',
      '    total = total + 1;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1, -1, 1]), 3);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [-2, 0, 0]), 3);
  },
);

compilerArrayTest(
  'compileProject splices owned boolean arrays by mutating the receiver and returning removed values',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function localScore(): number {',
      '  const values: boolean[] = [false, true, false, true];',
      '  const removed = values.splice(1, 2);',
      '  let total = values.length + removed.length;',
      '  if (values[1]) {',
      '    total = total + 1;',
      '  }',
      '  if (removed[0]) {',
      '    total = total + 1;',
      '  }',
      '  if (removed[1]) {',
      '    total = total + 1;',
      '  }',
      '  return total;',
      '}',
      '',
      'export function exported(values: boolean[]): boolean[] {',
      '  return values.splice(1, 2);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const localScore = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'localScore')] as () => number;
    const exported = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'exported')] as (
        values: boolean[],
      ) => boolean[];
    const values = [false, true, false, true];
    const removed = exported(values);

    assertEquals(localScore(), 2 + 2 + 1 + 1);
    assertEquals(removed, [true, false]);
    assertEquals(values, [false, true]);
    assertEquals(removed === values, false);
  },
);

compilerArrayTest(
  'compileProject splices owned boolean arrays with same-kind scalar insert args',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function exported(values: boolean[]): boolean[] {',
      '  return values.splice(1, 2, true, false);',
      '}',
      '',
      'export function localScore(): number {',
      '  const values: boolean[] = [false, true, false, true];',
      '  const removed = values.splice(1, 2, true, false);',
      '  let total = values.length + removed.length;',
      '  if (values[1]) {',
      '    total = total + 1;',
      '  }',
      '  if (values[2]) {',
      '    total = total + 1;',
      '  }',
      '  if (removed[0]) {',
      '    total = total + 1;',
      '  }',
      '  if (removed[1]) {',
      '    total = total + 1;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const localScore = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'localScore')] as () => number;
    const exported = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'exported')] as (
        values: boolean[],
      ) => boolean[];
    const values = [false, true, false, true];
    const removed = exported(values);

    assertEquals(localScore(), 4 + 2 + 1 + 1);
    assertEquals(removed, [true, false]);
    assertEquals(values, [false, true, false, true]);
  },
);

compilerArrayTest(
  'compileProject fills exported boolean arrays in place with omitted end',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[], start: number): boolean[] {',
      '  return values.fill(true, start);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[], start: number) => boolean[];
    const values = [false, false, true];
    const returned = main(values, 1);

    assertStrictEquals(returned, values);
    assertEquals(values, [false, true, true]);
  },
);

compilerArrayTest(
  'compileProject reverses exported boolean arrays in place without losing visible mutation',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[]): boolean {',
      '  values.reverse();',
      '  return values[0];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[]) => number;
    const values = [false, true, true];

    assertEquals(main(values), 1);
    assertEquals(values, [false, true, true].reverse());
  },
);

compilerArrayTest(
  'compileProject copyWithin mutates owned boolean arrays in place with omitted end',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[], target: number, start: number): boolean[] {',
      '  return values.copyWithin(target, start);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: boolean[],
      target: number,
      start: number,
    ) => boolean[];
    const values = [false, true, false, true];
    const expected = [...values];
    expected.copyWithin(1, -2);
    const returned = main(values, 1, -2);

    assertStrictEquals(returned, values);
    assertEquals(values, expected);
  },
);

compilerArrayTest(
  'compileProject copies back exported boolean array copyWithin mutations through local aliases',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[]): boolean[] {',
      '  const alias = values;',
      '  return alias.copyWithin(1, 0, 1);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[]) => boolean[];
    const values = [false, true, false];
    const expected = [...values];
    expected.copyWithin(1, 0, 1);
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, expected);
  },
);

compilerArrayTest(
  'compileProject concatenates exported boolean arrays with scalar items and multiple args without mutating the inputs',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: boolean[], right: boolean[], index: number): boolean {',
      '  const merged = left.concat(true, right, false);',
      '  return merged[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      left: boolean[],
      right: boolean[],
      index: number,
    ) => number;
    const left = [false, true];
    const right = [true, false];

    assertEquals(main(left, right, 2), 1);
    assertEquals(main(left, right, 4), 0);
    assertEquals(left, [false, true]);
    assertEquals(right, [true, false]);
  },
);

compilerArrayTest(
  'compileProject joins owned boolean arrays with JS boolean stringification and pay-for-play host bridges',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[], separator: string): string {',
      '  return values.join(separator);',
      '}',
      '',
      'export function defaults(values: boolean[]): string {',
      '  return values.join();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const main = instance.exports[await resolveQualifiedExportName(tempDirectory, 'main')] as (
      values: boolean[],
      separator: string,
    ) => string;
    const defaults = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'defaults')] as (
        values: boolean[],
      ) => string;

    assertStringIncludes(watOutput, 'call $tagged_from_boolean');
    assertStringIncludes(watOutput, '(import "soundscript_string" "concat"');
    assertStringIncludes(watOutput, 'call $string_to_owned');
    assertEquals(watOutput.includes('call $tagged_from_number'), false);
    assertEquals(main([false, true, false], '|'), 'false|true|false');
    assertEquals(main([], '|'), '');
    assertEquals(defaults([true, false]), 'true,false');
  },
);

compilerArrayTest(
  'compileProject checks exported boolean array includes without copy-back side effects',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function anyTrue(values: boolean[]): boolean {',
      '  return values.includes(true);',
      '}',
      '',
      'export function lateTrue(values: boolean[], fromIndex: number): boolean {',
      '  return values.includes(true, fromIndex);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const anyTrueName = await resolveQualifiedExportName(tempDirectory, 'anyTrue');
    const lateTrueName = await resolveQualifiedExportName(tempDirectory, 'lateTrue');
    const anyTrue = instance.exports[anyTrueName] as (values: boolean[]) => number;
    const lateTrue = instance.exports[lateTrueName] as (
      values: boolean[],
      fromIndex: number,
    ) => number;
    const values = [false, true, false];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(anyTrue(values), 1);
    assertEquals(lateTrue(values, 2), 0);
    assertEquals(lateTrue(values, -2), 1);
    assertEquals(values, [false, true, false]);
  },
);

compilerArrayTest(
  'compileProject checks exported boolean array indexOf without copy-back side effects',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function firstTrue(values: boolean[]): number {',
      '  return values.indexOf(true);',
      '}',
      '',
      'export function lateTrue(values: boolean[], fromIndex: number): number {',
      '  return values.indexOf(true, fromIndex);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const firstTrueName = await resolveQualifiedExportName(tempDirectory, 'firstTrue');
    const lateTrueName = await resolveQualifiedExportName(tempDirectory, 'lateTrue');
    const firstTrue = instance.exports[firstTrueName] as (values: boolean[]) => number;
    const lateTrue = instance.exports[lateTrueName] as (
      values: boolean[],
      fromIndex: number,
    ) => number;
    const values = [false, true, false, true];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(firstTrue(values), 1);
    assertEquals(lateTrue(values, 2), 3);
    assertEquals(lateTrue(values, -1), 3);
    assertEquals(lateTrue(values, 4), -1);
    assertEquals(values, [false, true, false, true]);
  },
);

compilerArrayTest(
  'compileProject checks exported boolean array lastIndexOf without copy-back side effects',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function lastTrue(values: boolean[]): number {',
      '  return values.lastIndexOf(true);',
      '}',
      '',
      'export function earlierTrue(values: boolean[], fromIndex: number): number {',
      '  return values.lastIndexOf(true, fromIndex);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const lastTrueName = await resolveQualifiedExportName(tempDirectory, 'lastTrue');
    const earlierTrueName = await resolveQualifiedExportName(tempDirectory, 'earlierTrue');
    const lastTrue = instance.exports[lastTrueName] as (values: boolean[]) => number;
    const earlierTrue = instance.exports[earlierTrueName] as (
      values: boolean[],
      fromIndex: number,
    ) => number;
    const values = [false, true, false, true];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(lastTrue(values), 3);
    assertEquals(earlierTrue(values, 2), 1);
    assertEquals(earlierTrue(values, -1), 3);
    assertEquals(earlierTrue(values, -2), 1);
    assertEquals(earlierTrue(values, 4), 3);
    assertEquals(values, [false, true, false, true]);
  },
);

compilerArrayTest(
  'compileProject adapts exported boolean array at through tagged host boundaries without string runtime',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[], index: number): boolean | undefined {',
      '  return values.at(index);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      values: boolean[],
      index: number,
    ) => boolean | undefined;
    const values = [false, true, false];

    assertEquals(watOutput.includes('(type $string_runtime'), false);
    assertEquals(watOutput.includes('call $tag_string'), false);
    assertEquals(main(values, 0), false);
    assertEquals(main(values, -2), true);
    assertEquals(main(values, 1.9), true);
    assertEquals(main(values, -1.2), false);
    assertEquals(main(values, Number.NaN), false);
    assertEquals(main(values, Number.POSITIVE_INFINITY), undefined);
    assertEquals(main(values, -99), undefined);
  },
);

compilerArrayTest('compileProject mutates local string arrays through indexed writes', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(index: number): string {',
    '  const values: string[] = ["ant", "bee", "cat"];',
    '  values[index] = "zebra";',
    '  return values[index];',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const main = instance.exports[exportName] as (index: number) => string;

  assertEquals(main(0), 'zebra');
  assertEquals(main(2), 'zebra');
});

compilerArrayTest(
  'compileProject preserves local string-array aliases across push growth',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: string[] = ["ant"];',
      '  const alias = values;',
      '  const nextLength = values.push("yak", "zebra");',
      '  return nextLength + alias[1].length + alias[2].length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(
      await invokeCompiledEntry(tempDirectory, 'main', []),
      3 + 'yak'.length + 'zebra'.length,
    );
  },
);

compilerArrayTest(
  'compileProject preserves local string-array aliases across unshift growth',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: string[] = ["ant"];',
      '  const alias = values;',
      '  const nextLength = values.unshift("yak", "zebra");',
      '  return nextLength + alias[0].length + alias[1].length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(
      await invokeCompiledEntry(tempDirectory, 'main', []),
      3 + 'yak'.length + 'zebra'.length,
    );
  },
);

compilerArrayTest('compileProject mutates local number arrays through indexed writes', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(index: number): number {',
    '  const values: number[] = [1, 2, 5];',
    '  values[index] = 9;',
    '  return values[0] + values[1] + values[2];',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 9 + 2 + 5);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 1 + 9 + 5);
});

compilerArrayTest(
  'compileProject preserves local number-array aliases across push growth',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: number[] = [1];',
      '  const alias = values;',
      '  const nextLength = values.push(7, 9);',
      '  return nextLength + alias[1] + alias[2];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3 + 7 + 9);
  },
);

compilerArrayTest(
  'compileProject preserves local number-array aliases across unshift growth',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const values: number[] = [1];',
      '  const alias = values;',
      '  const nextLength = values.unshift(7, 9);',
      '  return nextLength + alias[0] + alias[1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3 + 7 + 9);
  },
);

compilerArrayTest(
  'compileProject evaluates multi-arg number array push and unshift arguments before mutating the receiver',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export function lengthTimesTen(values: number[]): number {',
          '  return values.length * 10;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { lengthTimesTen } from './helpers';",
          '',
          'export function pushMain(): number {',
          '  const values: number[] = [1];',
          '  const nextLength = values.push(values.length, lengthTimesTen(values));',
          '  return nextLength * 100 + values[1] * 10 + values[2];',
          '}',
          '',
          'export function unshiftMain(): number {',
          '  const values: number[] = [9];',
          '  const nextLength = values.unshift(values.length, lengthTimesTen(values));',
          '  return nextLength * 100 + values[0] * 10 + values[1];',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const pushExportName = await resolveQualifiedExportName(tempDirectory, 'pushMain');
    const unshiftExportName = await resolveQualifiedExportName(tempDirectory, 'unshiftMain');
    const pushMain = instance.exports[pushExportName] as () => number;
    const unshiftMain = instance.exports[unshiftExportName] as () => number;

    assertEquals(pushMain(), 3 * 100 + 1 * 10 + 10);
    assertEquals(unshiftMain(), 3 * 100 + 1 * 10 + 10);
  },
);

compilerArrayTest(
  'compileProject mutates local boolean arrays through indexed writes',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(index: number): boolean {',
      '  const values: boolean[] = [false, false, true];',
      '  values[index] = true;',
      '  if (values[0] === values[1]) {',
      '    return values[2];',
      '  }',
      '  return values[0];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 1);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 0);
  },
);

compilerArrayTest(
  'compileProject preserves local boolean-array aliases across push growth',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): boolean {',
      '  const values: boolean[] = [false];',
      '  const alias = values;',
      '  values.push(true, true);',
      '  return alias[2];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1);
  },
);

compilerArrayTest(
  'compileProject preserves local boolean-array aliases across unshift growth',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): boolean {',
      '  const values: boolean[] = [false];',
      '  const alias = values;',
      '  values.unshift(true, true);',
      '  return alias[1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 1);
  },
);

compilerArrayTest(
  'compileProject scalarizes imported exported array length-view helpers through .length-only boundaries',
  async () => {
    const tempDirectory = await createTempProject([
      {
        path: 'tsconfig.json',
        contents: JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
            },
            include: ['src/**/*.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/helpers.ts',
        contents: [
          'export type StringView = { length: number };',
          'export type NumberView = { length: number };',
          'export type BooleanView = { length: number };',
          '',
          'export function buildString(left: string, right: string): StringView {',
          '  return [left, right, "zebra"];',
          '}',
          '',
          'export function consumeString(values: StringView): number {',
          '  return values.length;',
          '}',
          '',
          'export function buildNumber(left: number, right: number): NumberView {',
          '  return [left, right, 9];',
          '}',
          '',
          'export function consumeNumber(values: NumberView): number {',
          '  return values.length;',
          '}',
          '',
          'export function buildBoolean(left: boolean, right: boolean): BooleanView {',
          '  return [left, right, true, false];',
          '}',
          '',
          'export function consumeBoolean(values: BooleanView): number {',
          '  return values.length;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { buildBoolean, buildNumber, buildString, consumeBoolean, consumeNumber, consumeString } from './helpers';",
          '',
          'export function stringMain(left: string, right: string): number {',
          '  return consumeString(buildString(left, right));',
          '}',
          '',
          'export function numberMain(left: number, right: number): number {',
          '  return consumeNumber(buildNumber(left, right));',
          '}',
          '',
          'export function booleanMain(left: boolean, right: boolean): number {',
          '  return consumeBoolean(buildBoolean(left, right));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, '(import "soundscript_length_view" "length"');
    assertStringIncludes(watOutput, '(import "soundscript_length_view" "from_length"');

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const stringExportName = await resolveQualifiedExportName(tempDirectory, 'stringMain');
    const numberExportName = await resolveQualifiedExportName(tempDirectory, 'numberMain');
    const booleanExportName = await resolveQualifiedExportName(tempDirectory, 'booleanMain');
    const stringMain = instance.exports[stringExportName] as (
      left: string,
      right: string,
    ) => number;
    const numberMain = instance.exports[numberExportName] as (
      left: number,
      right: number,
    ) => number;
    const booleanMain = instance.exports[booleanExportName] as (
      left: boolean,
      right: boolean,
    ) => number;

    assertEquals(stringMain('ant', 'bee'), 3);
    assertEquals(numberMain(4, 7), 3);
    assertEquals(booleanMain(false, true), 4);
  },
);

compilerArrayTest(
  'compileProject copies back exported string array param mutations to the host array',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[]): string {',
      '  values[1] = "zebra";',
      '  return values[1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: string[]) => string;
    const values = ['ant', 'bee', 'cat'];

    assertEquals(main(values), 'zebra');
    assertEquals(values, ['ant', 'zebra', 'cat']);
  },
);

compilerArrayTest(
  'compileProject copies back exported string array push mutations to the host array',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[]): number {',
      '  return values.push("yak", "zebra");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: string[]) => number;
    const values = ['ant', 'bee'];

    assertEquals(main(values), 4);
    assertEquals(values, ['ant', 'bee', 'yak', 'zebra']);
  },
);

compilerArrayTest(
  'compileProject treats exported string array zero-arg push as a no-op that returns length',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[]): number {',
      '  return values.push();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: string[]) => number;
    const values = ['ant', 'bee'];

    assertEquals(main(values), 2);
    assertEquals(values, ['ant', 'bee']);
  },
);

compilerArrayTest(
  'compileProject copies back exported string array unshift mutations to the host array',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[]): number {',
      '  return values.unshift("yak", "zebra");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: string[]) => number;
    const values = ['ant', 'bee'];

    assertEquals(main(values), 4);
    assertEquals(values, ['yak', 'zebra', 'ant', 'bee']);
  },
);

compilerArrayTest(
  'compileProject treats exported string array zero-arg unshift as a no-op that returns length',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[]): number {',
      '  return values.unshift();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: string[]) => number;
    const values = ['ant', 'bee'];

    assertEquals(main(values), 2);
    assertEquals(values, ['ant', 'bee']);
  },
);

compilerArrayTest(
  'compileProject preserves aliased host string array params through owned-array adaptation',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: string[], right: string[]): string {',
      '  left.push("yak", "zebra");',
      '  return right[3];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: string[], right: string[]) => string;
    const values = ['ant', 'bee'];

    assertEquals(main(values, values), 'zebra');
    assertEquals(values, ['ant', 'bee', 'yak', 'zebra']);
  },
);

compilerArrayTest(
  'compileProject preserves aliased host string array params through owned-array unshift adaptation',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: string[], right: string[]): string {',
      '  left.unshift("yak", "zebra");',
      '  return right[0];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: string[], right: string[]) => string;
    const values = ['ant', 'bee'];

    assertEquals(main(values, values), 'yak');
    assertEquals(values, ['yak', 'zebra', 'ant', 'bee']);
  },
);

compilerArrayTest(
  'compileProject preserves host identity when returning a mutated string array param',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: string[]): string[] {',
      '  values[0] = "zebra";',
      '  return values;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: string[]) => string[];
    const values = ['ant', 'bee'];
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, ['zebra', 'bee']);
  },
);

compilerArrayTest(
  'compileProject copies back exported number array param mutations to the host array',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  values[0] = 9;',
      '  return values[0] + values[1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: number[]) => number;
    const values = [1, 2, 5];

    assertEquals(main(values), 11);
    assertEquals(values, [9, 2, 5]);
  },
);

compilerArrayTest(
  'compileProject copies back exported number array push mutations to the host array',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  return values.push(7, 9);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: number[]) => number;
    const values = [1, 2];

    assertEquals(main(values), 4);
    assertEquals(values, [1, 2, 7, 9]);
  },
);

compilerArrayTest(
  'compileProject treats exported number array zero-arg push as a no-op that returns length',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  return values.push();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: number[]) => number;
    const values = [1, 2];

    assertEquals(main(values), 2);
    assertEquals(values, [1, 2]);
  },
);

compilerArrayTest(
  'compileProject copies back exported number array unshift mutations to the host array',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  return values.unshift(7, 9);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: number[]) => number;
    const values = [1, 2];

    assertEquals(main(values), 4);
    assertEquals(values, [7, 9, 1, 2]);
  },
);

compilerArrayTest(
  'compileProject treats exported number array zero-arg unshift as a no-op that returns length',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number {',
      '  return values.unshift();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: number[]) => number;
    const values = [1, 2];

    assertEquals(main(values), 2);
    assertEquals(values, [1, 2]);
  },
);

compilerArrayTest(
  'compileProject preserves aliased host number array params through owned-array adaptation',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: number[], right: number[]): number {',
      '  left.push(7, 9);',
      '  return right[3];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: number[], right: number[]) => number;
    const values = [1, 2];

    assertEquals(main(values, values), 9);
    assertEquals(values, [1, 2, 7, 9]);
  },
);

compilerArrayTest(
  'compileProject preserves aliased host number array params through owned-array unshift adaptation',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: number[], right: number[]): number {',
      '  left.unshift(7, 9);',
      '  return right[0];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: number[], right: number[]) => number;
    const values = [1, 2];

    assertEquals(main(values, values), 7);
    assertEquals(values, [7, 9, 1, 2]);
  },
);

compilerArrayTest(
  'compileProject preserves host identity when returning a mutated number array param',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: number[]): number[] {',
      '  values[0] = 9;',
      '  return values;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: number[]) => number[];
    const values = [1, 2, 5];
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, [9, 2, 5]);
  },
);

compilerArrayTest(
  'compileProject copies back exported boolean array param mutations to the host array',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[]): boolean {',
      '  values[0] = true;',
      '  return values[0];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[]) => number;
    const values = [false, false, true];

    assertEquals(main(values), 1);
    assertEquals(values, [true, false, true]);
  },
);

compilerArrayTest(
  'compileProject copies back exported boolean array push mutations to the host array',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[]): number {',
      '  return values.push(true, true);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[]) => number;
    const values = [false, false];

    assertEquals(main(values), 4);
    assertEquals(values, [false, false, true, true]);
  },
);

compilerArrayTest(
  'compileProject treats exported boolean array zero-arg push as a no-op that returns length',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[]): number {',
      '  return values.push();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[]) => number;
    const values = [false, false];

    assertEquals(main(values), 2);
    assertEquals(values, [false, false]);
  },
);

compilerArrayTest(
  'compileProject copies back exported boolean array unshift mutations to the host array',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[]): number {',
      '  return values.unshift(true, true);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[]) => number;
    const values = [false, false];

    assertEquals(main(values), 4);
    assertEquals(values, [true, true, false, false]);
  },
);

compilerArrayTest(
  'compileProject treats exported boolean array zero-arg unshift as a no-op that returns length',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[]): number {',
      '  return values.unshift();',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[]) => number;
    const values = [false, false];

    assertEquals(main(values), 2);
    assertEquals(values, [false, false]);
  },
);

compilerArrayTest(
  'compileProject preserves aliased host boolean array params through owned-array adaptation',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: boolean[], right: boolean[]): boolean {',
      '  left.push(true, true);',
      '  return right[3];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: boolean[], right: boolean[]) => number;
    const values = [false, false];

    assertEquals(main(values, values), 1);
    assertEquals(values, [false, false, true, true]);
  },
);

compilerArrayTest(
  'compileProject preserves aliased host boolean array params through owned-array unshift adaptation',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: boolean[], right: boolean[]): boolean {',
      '  left.unshift(true, true);',
      '  return right[0];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: boolean[], right: boolean[]) => number;
    const values = [false, false];

    assertEquals(main(values, values), 1);
    assertEquals(values, [true, true, false, false]);
  },
);

compilerArrayTest(
  'compileProject preserves host identity when returning a mutated boolean array param',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(values: boolean[]): boolean[] {',
      '  values[0] = true;',
      '  return values;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (values: boolean[]) => boolean[];
    const values = [false, false, true];
    const returned = main(values);

    assertStrictEquals(returned, values);
    assertEquals(values, [true, false, true]);
  },
);
