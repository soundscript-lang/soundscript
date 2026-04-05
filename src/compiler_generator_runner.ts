import { assertEquals } from '@std/assert';

import { compileTempProject, createCompilerTestProject } from './compiler_object_test_helpers.ts';
import {
  instantiateCompiledModuleInJs,
  resolveQualifiedExportName,
} from './compiler_test_helpers.ts';

type GeneratorCompilerCase = {
  name: string;
  source: string;
  expected?: number;
  expectedThrow?: unknown;
  run?: (
    exported: unknown,
    instance: WebAssembly.Instance,
    tempDirectory: string,
  ) => Promise<void> | void;
  exportName?: string;
};

async function runGeneratorCompilerCase(testCase: GeneratorCompilerCase): Promise<void> {
  const tempDirectory = await createCompilerTestProject(testCase.source);
  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0, testCase.name);
  assertEquals(result.diagnostics, [], testCase.name);
  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, testCase.exportName ?? 'main');
  const exported = instance.exports[exportName];
  if (testCase.run) {
    await testCase.run(exported, instance, tempDirectory);
    return;
  }
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}" for ${testCase.name}.`);
  }
  if ('expectedThrow' in testCase) {
    let threw = false;
    try {
      exported();
    } catch (error) {
      threw = true;
      assertEquals(error, testCase.expectedThrow, testCase.name);
    }
    assertEquals(threw, true, `${testCase.name} should throw.`);
    return;
  }
  assertEquals(exported(), testCase.expected, testCase.name);
}

async function main(): Promise<void> {
  if (Deno.env.get('SOUNDSCRIPT_GENERATOR_LIST_CASES') === '1') {
    console.log(JSON.stringify(cases.map((testCase) => testCase.name)));
    return;
  }

  const caseFilter = Deno.env.get('SOUNDSCRIPT_GENERATOR_CASE');
  const caseFiltersValue = Deno.env.get('SOUNDSCRIPT_GENERATOR_CASES');
  const caseFilters = caseFiltersValue
    ? new Set(JSON.parse(caseFiltersValue) as string[])
    : undefined;
  const selectedCases = cases.filter((testCase) =>
    caseFilter ? testCase.name === caseFilter : caseFilters ? caseFilters.has(testCase.name) : true
  );
  for (const testCase of selectedCases) {
    await runGeneratorCompilerCase(testCase);
  }
}

const cases: GeneratorCompilerCase[] = [
  {
    name: 'compileProject lowers sync generator next calls with resume values',
    expected: 101237,
    source: [
      'function* iterate(): Generator<number, number, number> {',
      '  const received = yield 10;',
      '  yield received + 5;',
      '  return received + 20;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next(7);',
      '  const third = iterator.next();',
      '  const firstValue = first.done ? 0 : first.value;',
      '  const secondValue = second.done ? 0 : second.value;',
      '  const thirdValue = third.done ? third.value : 0;',
      '  return (first.done ? 1000000 : 0) + (firstValue * 10000) + (second.done ? 1000 : 0)' +
      ' + (secondValue * 100) + (third.done ? 10 : 0) + thirdValue;',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator return calls',
    expected: 42011,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  yield 4;',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.return(20);',
      '  const third = iterator.next();',
      '  const firstValue = first.done ? 0 : first.value;',
      '  const secondValue = second.done ? second.value : 0;',
      '  return (firstValue * 10000)' +
      ' + (first.done ? 1000 : 0)' +
      ' + (secondValue * 100)' +
      ' + (second.done ? 10 : 0)' +
      ' + (third.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject exports sync generator functions as host iterators',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<number, number, unknown> {',
      '  yield 3;',
      '  yield 5;',
      '  return 7;',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const next = (iterator as { next?: unknown }).next;
      if (typeof next !== 'function') {
        throw new Error('Expected exported sync generator iterator to expose next().');
      }
      const first = (iterator as Iterator<number, number, unknown>).next();
      const second = (iterator as Iterator<number, number, unknown>).next();
      const third = (iterator as Iterator<number, number, unknown>).next();
      assertEquals(first, { value: 3, done: false });
      assertEquals(second, { value: 5, done: false });
      assertEquals(third, { value: 7, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator yielded Promises as host Promises',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<Promise<number>, void, unknown> {',
      '  yield Promise.resolve(3);',
      '}',
      '',
    ].join('\n'),
    run: async (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<Promise<number>, void, unknown>).next();
      if (!(first.value instanceof Promise)) {
        throw new Error('Expected yielded sync generator Promise to bridge to a host Promise.');
      }
      const second = (iterator as Iterator<Promise<number>, void, unknown>).next();
      assertEquals(await first.value, 3);
      assertEquals(first.done, false);
      assertEquals(second, { value: undefined, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator return calls as host iterators',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<number, number, unknown> {',
      '  yield 3;',
      '  yield 5;',
      '  return 7;',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, unknown>).next();
      const second = (iterator as Iterator<number, number, unknown>).return?.(20);
      const third = (iterator as Iterator<number, number, unknown>).next();
      assertEquals(first, { value: 3, done: false });
      assertEquals(second, { value: 20, done: true });
      assertEquals(third, { value: undefined, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator throw calls as host iterators',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<number, number, number> {',
      '  try {',
      '    yield 3;',
      '    return 8;',
      '  } catch {',
      '    yield 7;',
      '    return 9;',
      '  }',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, number>).next();
      const second = (iterator as Iterator<number, number, number>).throw?.(5);
      const third = (iterator as Iterator<number, number, number>).next();
      assertEquals(first, { value: 3, done: false });
      assertEquals(second, { value: 7, done: false });
      assertEquals(third, { value: 9, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator yield star over local arrays as host iterators',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<number, number, unknown> {',
      '  const values = [3, 5, 7];',
      '  yield* values;',
      '  return 9;',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, unknown>).next();
      const second = (iterator as Iterator<number, number, unknown>).next();
      const third = (iterator as Iterator<number, number, unknown>).next();
      const fourth = (iterator as Iterator<number, number, unknown>).next();
      assertEquals(first, { value: 3, done: false });
      assertEquals(second, { value: 5, done: false });
      assertEquals(third, { value: 7, done: false });
      assertEquals(fourth, { value: 9, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator yield star over local Promise arrays as host iterators',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<Promise<number>, number, unknown> {',
      '  const values = [Promise.resolve(3), Promise.resolve(5), Promise.resolve(7)];',
      '  yield* values;',
      '  return 9;',
      '}',
      '',
    ].join('\n'),
    run: async (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<Promise<number>, number, unknown>).next();
      const second = (iterator as Iterator<Promise<number>, number, unknown>).next();
      const third = (iterator as Iterator<Promise<number>, number, unknown>).next();
      const fourth = (iterator as Iterator<Promise<number>, number, unknown>).next();
      if (!(first.value instanceof Promise) || !(second.value instanceof Promise) ||
        !(third.value instanceof Promise)) {
        throw new Error('Expected yielded Promise-array values to bridge to host Promises.');
      }
      assertEquals(await first.value, 3);
      assertEquals(await second.value, 5);
      assertEquals(await third.value, 7);
      assertEquals(fourth, { value: 9, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator throw through array yield star as host iterators',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<number, number, unknown> {',
      '  yield* [3, 5, 7];',
      '  return 9;',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, unknown>).next();
      assertEquals(first, { value: 3, done: false });
      let threw = false;
      try {
        (iterator as Iterator<number, number, unknown>).throw?.(5);
      } catch (error) {
        threw = true;
        assertEquals(error, {
          name: 'TypeError',
          message: 'yield* delegate does not support throw',
        });
      }
      assertEquals(threw, true, 'Expected exported array yield* throw to rethrow to host.');
    },
  },
  {
    name: 'compileProject exports sync generator yield star over iterator-valued locals as host iterators',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<number, number, unknown> {',
      '  const values = new Map([["a", 3], ["b", 5], ["c", 7]]).values();',
      '  yield* values;',
      '  return 9;',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, unknown>).next();
      const second = (iterator as Iterator<number, number, unknown>).next();
      const third = (iterator as Iterator<number, number, unknown>).next();
      const fourth = (iterator as Iterator<number, number, unknown>).next();
      assertEquals(first, { value: 3, done: false });
      assertEquals(second, { value: 5, done: false });
      assertEquals(third, { value: 7, done: false });
      assertEquals(fourth, { value: 9, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator yield star through sync generator delegates as host iterators',
    exportName: 'outer',
    source: [
      'function* inner(): Generator<number, number, number> {',
      '  const received = yield 10;',
      '  yield received + 1;',
      '  return received + 2;',
      '}',
      '',
      'export function* outer(): Generator<number, number, number> {',
      '  const delegated = yield* inner();',
      '  yield delegated + 3;',
      '  return delegated + 4;',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, number>).next();
      const second = (iterator as Iterator<number, number, number>).next(7);
      const third = (iterator as Iterator<number, number, number>).next();
      const fourth = (iterator as Iterator<number, number, number>).next();
      assertEquals(first, { value: 10, done: false });
      assertEquals(second, { value: 8, done: false });
      assertEquals(third, { value: 12, done: false });
      assertEquals(fourth, { value: 13, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator throw delegation through yield star as host iterators',
    exportName: 'outer',
    source: [
      'function* inner(): Generator<number, number, number> {',
      '  try {',
      '    yield 3;',
      '    return 8;',
      '  } catch {',
      '    yield 7;',
      '    return 9;',
      '  }',
      '}',
      '',
      'export function* outer(): Generator<number, number, number> {',
      '  const delegated = yield* inner();',
      '  yield delegated + 1;',
      '  return delegated + 2;',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, number>).next();
      const second = (iterator as Iterator<number, number, number>).throw?.(5);
      const third = (iterator as Iterator<number, number, number>).next();
      const fourth = (iterator as Iterator<number, number, number>).next();
      assertEquals(first, { value: 3, done: false });
      assertEquals(second, { value: 7, done: false });
      assertEquals(third, { value: 10, done: false });
      assertEquals(fourth, { value: 11, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator return delegation through yield star as host iterators',
    exportName: 'outer',
    source: [
      'function* inner(): Generator<number, number, number> {',
      '  try {',
      '    yield 3;',
      '    yield 5;',
      '    return 7;',
      '  } finally {',
      '    yield 9;',
      '  }',
      '}',
      '',
      'export function* outer(): Generator<number, number, number> {',
      '  const delegated = yield* inner();',
      '  return delegated + 1;',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, number>).next();
      const second = (iterator as Iterator<number, number, number>).return?.(4);
      const third = (iterator as Iterator<number, number, number>).next();
      const fourth = (iterator as Iterator<number, number, number>).next();
      assertEquals(first, { value: 3, done: false });
      assertEquals(second, { value: 9, done: false });
      assertEquals(third, { value: 5, done: true });
      assertEquals(fourth, { value: undefined, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator yielded delegated Promises as host Promises',
    exportName: 'outer',
    source: [
      'function* inner(): Generator<Promise<number>, number, unknown> {',
      '  const values = [Promise.resolve(3), Promise.resolve(5)];',
      '  yield* values;',
      '  return 7;',
      '}',
      '',
      'export function* outer(): Generator<Promise<number>, number, unknown> {',
      '  const delegated = yield* inner();',
      '  return delegated + 1;',
      '}',
      '',
    ].join('\n'),
    run: async (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<Promise<number>, number, unknown>).next();
      const second = (iterator as Iterator<Promise<number>, number, unknown>).next();
      const third = (iterator as Iterator<Promise<number>, number, unknown>).next();
      if (!(first.value instanceof Promise) || !(second.value instanceof Promise)) {
        throw new Error('Expected delegated yielded Promise values to bridge to host Promises.');
      }
      assertEquals(await first.value, 3);
      assertEquals(await second.value, 5);
      assertEquals(third, { value: 8, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator class methods as host iterators',
    exportName: 'iterateFromCounter',
    source: [
      'class Counter {',
      '  base = 4;',
      '',
      '  *iterate(): Generator<number, number, unknown> {',
      '    yield this.base;',
      '    yield this.base + 1;',
      '    return this.base + 2;',
      '  }',
      '}',
      '',
      'export function iterateFromCounter(): Generator<number, number, unknown> {',
      '  return new Counter().iterate();',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported generator wrapper function.');
      }
      const iterator = (exported as () => Iterator<number, number, unknown>)();
      const first = iterator.next();
      const second = iterator.next();
      const third = iterator.next();
      assertEquals(first, { value: 4, done: false });
      assertEquals(second, { value: 5, done: false });
      assertEquals(third, { value: 6, done: true });
    },
  },
  {
    name: 'compileProject exports sync generator class methods with super calls as host iterators',
    exportName: 'iterateFromCounter',
    source: [
      'class Base {',
      '  bump(value: number): number {',
      '    return value + 1;',
      '  }',
      '}',
      '',
      'class Counter extends Base {',
      '  base = 4;',
      '',
      '  *iterate(): Generator<number, number, unknown> {',
      '    yield super.bump(this.base);',
      '    yield super.bump(this.base + 1);',
      '    return super.bump(this.base + 2);',
      '  }',
      '}',
      '',
      'export function iterateFromCounter(): Generator<number, number, unknown> {',
      '  return new Counter().iterate();',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported generator wrapper function.');
      }
      const iterator = (exported as () => Iterator<number, number, unknown>)();
      const first = iterator.next();
      const second = iterator.next();
      const third = iterator.next();
      assertEquals(first, { value: 5, done: false });
      assertEquals(second, { value: 6, done: false });
      assertEquals(third, { value: 7, done: true });
    },
  },
  {
    name: 'compileProject exports uncaught sync generator builtin Error throws to host iterators',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<number, number, unknown> {',
      '  yield 3;',
      '  throw new Error("boom");',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, unknown>).next();
      assertEquals(first, { value: 3, done: false });
      let threw = false;
      try {
        (iterator as Iterator<number, number, unknown>).next();
      } catch (error) {
        threw = true;
        assertEquals(error, { name: 'Error', message: 'boom' });
      }
      assertEquals(threw, true, 'Expected exported sync generator next() to rethrow Error.');
    },
  },
  {
    name: 'compileProject exports uncaught sync generator throw Error calls to host iterators',
    exportName: 'iterate',
    source: [
      'export function* iterate(): Generator<number, number, number> {',
      '  yield 3;',
      '  return 8;',
      '}',
      '',
    ].join('\n'),
    run: (exported) => {
      if (typeof exported !== 'function') {
        throw new Error('Expected exported sync generator function.');
      }
      const iterator = exported();
      if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
        throw new Error('Expected exported sync generator to return an iterator object.');
      }
      const first = (iterator as Iterator<number, number, number>).next();
      assertEquals(first, { value: 3, done: false });
      let threw = false;
      try {
        (iterator as Iterator<number, number, number>).throw?.(new Error('boom'));
      } catch (error) {
        threw = true;
        assertEquals(error, { name: 'Error', message: 'boom' });
      }
      assertEquals(threw, true, 'Expected exported sync generator throw(Error) to rethrow.');
    },
  },
  {
    name: 'compileProject lowers for-of over sync generator results',
    expected: 357,
    source: [
      'function* iterate(): Generator<number, void, unknown> {',
      '  yield 3;',
      '  yield 5;',
      '  yield 7;',
      '}',
      '',
      'export function main(): number {',
      '  let total = 0;',
      '  for (const value of iterate()) {',
      '    total = (total * 10) + value;',
      '  }',
      '  return total;',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator while bodies',
    expected: 10239,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let index = 0;',
      '  while (index < 3) {',
      '    index = index + 1;',
      '    yield index;',
      '  }',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return (first.done ? 100000 : 0) + ((first.done ? 0 : first.value) * 10000)' +
      ' + (second.done ? 1000 : 0) + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10) + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator do while bodies',
    expected: 456,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let index = 0;',
      '  do {',
      '    yield index + 4;',
      '    index = index + 1;',
      '  } while (index < 2);',
      '  return index + 4;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject preserves outer locals across sync generator block scoped yields',
    expected: 122,
    source: [
      'function* iterate(): Generator<number, number, number> {',
      '  let total = 20;',
      '  {',
      '    let total = 0;',
      '    total = yield 1;',
      '  }',
      '  return total + 2;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next(5);',
      '  return ((first.done ? 0 : first.value) * 100) + (second.done ? second.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject preserves sync generator do while continue and break through finally',
    expected: 357621,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let index = 0;',
      '  let total = 0;',
      '  do {',
      '    try {',
      '      index = index + 1;',
      '      if (index === 1) {',
      '        yield 3;',
      '        continue;',
      '      }',
      '      yield 7;',
      '      break;',
      '    } finally {',
      '      total = total + 5;',
      '      yield 5;',
      '    }',
      '  } while (index < 3);',
      '  return total + index;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  const fifth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100000)' +
      ' + ((second.done ? 0 : second.value) * 10000)' +
      ' + ((third.done ? 0 : third.value) * 1000)' +
      ' + ((fourth.done ? 0 : fourth.value) * 100)' +
      ' + ((fifth.done ? fifth.value : 0) * 10)' +
      ' + (fifth.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for of loops over Sets',
    expected: 359,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  for (const value of new Set([2, 4])) {',
      '    yield value + 1;',
      '  }',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for of loops over sync generator results',
    expected: 358,
    source: [
      'function* values(): Generator<number, number, unknown> {',
      '  yield 2;',
      '  yield 4;',
      '  return 9;',
      '}',
      '',
      'function* iterate(): Generator<number, number, unknown> {',
      '  for (const value of values()) {',
      '    yield value + 1;',
      '  }',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for of loops over Map values iterators',
    expected: 358,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      "  for (const value of new Map<string, number>([['a', 2], ['b', 4]]).values()) {",
      '    yield value + 1;',
      '  }',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for of loops over iterator-valued locals',
    expected: 1238,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  const values = new Map([["a", 1], ["b", 2], ["c", 3]]).values();',
      '  for (const value of values) {',
      '    yield value;',
      '  }',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for of loops over owned number array locals',
    expected: 2468,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  const values = [2, 4, 6];',
      '  for (const value of values) {',
      '    yield value;',
      '  }',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for of loops over owned string array locals',
    expected: 128,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      "  const values = ['a', 'b'];",
      '  for (const value of values) {',
      "    yield value === 'a' ? 1 : 2;",
      '  }',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for of loops over owned boolean array locals',
    expected: 1018,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  const values = [true, false, true];',
      '  for (const value of values) {',
      '    yield value ? 1 : 0;',
      '  }',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for of loops over owned tagged array locals',
    expected: 2948,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      "  const values: Array<number | string> = [2, 'a', 4];",
      '  for (const value of values) {',
      "    yield typeof value === 'number' ? value : 9;",
      '  }',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for in loops over ordinary objects',
    expected: 12119,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  const pair = { left: 1, right: 2, stop: 3 };',
      '  for (const key in pair) {',
      '    try {',
      '      if (key === "left") {',
      '        continue;',
      '      }',
      '      if (key === "stop") {',
      '        break;',
      '      }',
      '      yield key === "right" ? 2 : 9;',
      '    } finally {',
      '      yield 1;',
      '    }',
      '  }',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  const fifth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 10000)' +
      ' + ((second.done ? 0 : second.value) * 1000)' +
      ' + ((third.done ? 0 : third.value) * 100)' +
      ' + ((fourth.done ? 0 : fourth.value) * 10)' +
      ' + (fifth.done ? fifth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for bodies',
    expected: 4568,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let index = 0;',
      '  for (; index < 3; index = index + 1) {',
      '    yield index + 4;',
      '  }',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for let bodies and preserves outer locals',
    expected: 1223,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let current = 20;',
      '  for (let current = 0; current < 2; current = current + 1) {',
      '    yield current + 1;',
      '  }',
      '  return current + 3;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for let continue statements and preserves outer locals',
    expected: 1323,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let current = 20;',
      '  for (let current = 0; current < 3; current = current + 1) {',
      '    if (current === 1) {',
      '      continue;',
      '    }',
      '    yield current + 1;',
      '  }',
      '  return current + 3;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator for let continue through finally and preserves outer locals',
    expected: 15503731,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let current = 20;',
      '  for (let current = 0; current < 3; current = current + 1) {',
      '    try {',
      '      if (current === 1) {',
      '        continue;',
      '      }',
      '      yield current + 1;',
      '    } finally {',
      '      yield 5;',
      '    }',
      '  }',
      '  return current + 3;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  const fifth = iterator.next();',
      '  const sixth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 10000000)' +
      ' + ((second.done ? 0 : second.value) * 1000000)' +
      ' + ((third.done ? 0 : third.value) * 100000)' +
      ' + ((fourth.done ? 0 : fourth.value) * 1000)' +
      ' + ((fifth.done ? 0 : fifth.value) * 100)' +
      ' + ((sixth.done ? sixth.value : 0) * 10)' +
      ' + (sixth.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers nested sync generator try finally regions',
    expected: 15,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let total = 0;',
      '  try {',
      '    try {',
      '      yield 1;',
      '    } finally {',
      '      total = total + 2;',
      '    }',
      '  } finally {',
      '    total = total + 3;',
      '  }',
      '  return total;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 10) + (second.done ? second.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject hoists local function declarations inside sync generators across yield boundaries',
    expected: 222,
    source: [
      'function* iterate(): Generator<number, number, number> {',
      '  function addTwo(value: number): number {',
      '    return value + 2;',
      '  }',
      '  const received = yield 20;',
      '  return addTwo(received);',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next(20);',
      '  return ((first.done ? 0 : first.value) * 10) + (second.done ? second.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject preserves hoisted local function captures over persisted generator locals',
    expected: 22,
    source: [
      'function* iterate(): Generator<number, number, number> {',
      '  let total = 20;',
      '  function readTotal(offset: number): number {',
      '    return total + offset;',
      '  }',
      '  total = yield 0;',
      '  return readTotal(1);',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  iterator.next();',
      '  const result = iterator.next(21);',
      '  return result.done ? result.value : 0;',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject hoists block-scoped local function declarations inside sync generators across yield boundaries',
    expected: 24,
    source: [
      'function* iterate(): Generator<number, number, number> {',
      '  if (true) {',
      '    let total = 20;',
      '    function readTotal(offset: number): number {',
      '      return total + offset;',
      '    }',
      '    total = yield 0;',
      '    return readTotal(3);',
      '  }',
      '  return 0;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  iterator.next();',
      '  const result = iterator.next(21);',
      '  return result.done ? result.value : 0;',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator class methods',
    expected: 456,
    source: [
      'class Counter {',
      '  *iterate(): Generator<number, number, unknown> {',
      '    yield 4;',
      '    yield 5;',
      '    return 6;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = new Counter().iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator class methods with this field reads',
    expected: 456,
    source: [
      'class Counter {',
      '  base = 4;',
      '',
      '  *iterate(): Generator<number, number, unknown> {',
      '    yield this.base;',
      '    yield this.base + 1;',
      '    return this.base + 2;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = new Counter().iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator class methods with super calls',
    expected: 567,
    source: [
      'class Base {',
      '  bump(value: number): number {',
      '    return value + 1;',
      '  }',
      '}',
      '',
      'class Counter extends Base {',
      '  base = 4;',
      '',
      '  *iterate(): Generator<number, number, unknown> {',
      '    yield super.bump(this.base);',
      '    yield super.bump(this.base + 1);',
      '    return super.bump(this.base + 2);',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = new Counter().iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator static class methods',
    expected: 456,
    source: [
      'class Counter {',
      '  static *iterate(): Generator<number, number, unknown> {',
      '    yield 4;',
      '    yield 5;',
      '    return 6;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = Counter.iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator static class methods with this field reads',
    expected: 456,
    source: [
      'class Counter {',
      '  static base = 4;',
      '',
      '  static *iterate(): Generator<number, number, unknown> {',
      '    yield this.base;',
      '    yield this.base + 1;',
      '    return this.base + 2;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = Counter.iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers local object literal sync generator methods',
    expected: 456,
    source: [
      'export function main(): number {',
      '  const counter = {',
      '    *iterate(): Generator<number, number, unknown> {',
      '      yield 4;',
      '      yield 5;',
      '      return 6;',
      '    },',
      '  };',
      '  const iterator = counter.iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers local object literal sync generator methods with this field reads',
    expected: 456,
    source: [
      'export function main(): number {',
      '  const counter = {',
      '    base: 4,',
      '    *iterate(): Generator<number, number, unknown> {',
      '      yield this.base;',
      '      yield this.base + 1;',
      '      return this.base + 2;',
      '    },',
      '  };',
      '  const iterator = counter.iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100)' +
      ' + ((second.done ? 0 : second.value) * 10)' +
      ' + (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star delegation',
    expected: 10081213,
    source: [
      'function* inner(): Generator<number, number, number> {',
      '  const received = yield 10;',
      '  yield received + 1;',
      '  return received + 2;',
      '}',
      '',
      'function* outer(): Generator<number, number, number> {',
      '  const delegated = yield* inner();',
      '  yield delegated + 3;',
      '  return delegated + 4;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next(7);',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000000)' +
      ' + ((second.done ? 0 : second.value) * 10000)' +
      ' + ((third.done ? 0 : third.value) * 100)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over arrays',
    expected: 3579,
    source: [
      'function* outer(): Generator<number, number, unknown> {',
      '  yield* [3, 5, 7];',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator return during array yield star',
    expected: 3081,
    source: [
      'function* outer(): Generator<number, number, unknown> {',
      '  yield* [3, 5, 7];',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.return(8);',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? second.value : 0) * 10)' +
      ' + (third.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over iterator-valued locals',
    expected: 3579,
    source: [
      'function* outer(): Generator<number, number, unknown> {',
      '  const values = new Map([["a", 3], ["b", 5], ["c", 7]]).values();',
      '  yield* values;',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over strings',
    expected: 1359,
    source: [
      'function* outer(): Generator<string, number, unknown> {',
      '  yield* "ace";',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  const firstValue = first.done ? 0 : first.value.charCodeAt(0) - 96;',
      '  const secondValue = second.done ? 0 : second.value.charCodeAt(0) - 96;',
      '  const thirdValue = third.done ? 0 : third.value.charCodeAt(0) - 96;',
      '  return (firstValue * 1000) + (secondValue * 100) + (thirdValue * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over local string arrays',
    expected: 1359,
    source: [
      'function* outer(): Generator<string, number, unknown> {',
      "  const values = ['a', 'c', 'e'];",
      '  yield* values;',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  const firstValue = first.done ? 0 : first.value.charCodeAt(0) - 96;',
      '  const secondValue = second.done ? 0 : second.value.charCodeAt(0) - 96;',
      '  const thirdValue = third.done ? 0 : third.value.charCodeAt(0) - 96;',
      '  return (firstValue * 1000) + (secondValue * 100) + (thirdValue * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over local boolean arrays',
    expected: 1018,
    source: [
      'function* outer(): Generator<boolean, number, unknown> {',
      '  const values = [true, false, true];',
      '  yield* values;',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : (first.value ? 1 : 0)) * 1000)' +
      ' + ((second.done ? 0 : (second.value ? 1 : 0)) * 100)' +
      ' + ((third.done ? 0 : (third.value ? 1 : 0)) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over local tagged arrays',
    expected: 2948,
    source: [
      'function* outer(): Generator<number | string, number, unknown> {',
      "  const values: Array<number | string> = [2, 'a', 4];",
      '  yield* values;',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      "  const firstValue = first.done ? 0 : (typeof first.value === 'number' ? first.value : 9);",
      "  const secondValue = second.done ? 0 : (typeof second.value === 'number' ? second.value : 9);",
      "  const thirdValue = third.done ? 0 : (typeof third.value === 'number' ? third.value : 9);",
      '  return (firstValue * 1000) + (secondValue * 100) + (thirdValue * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over primitive Sets',
    expected: 3579,
    source: [
      'function* outer(): Generator<number, number, unknown> {',
      '  yield* new Set([3, 5, 7]);',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over Map values iterables',
    expected: 3579,
    source: [
      'function* outer(): Generator<number, number, unknown> {',
      '  yield* new Map([["a", 3], ["b", 5], ["c", 7]]).values();',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over Map key iterables',
    expected: 1359,
    source: [
      'function* outer(): Generator<string, number, unknown> {',
      '  yield* new Map([["a", 3], ["c", 5], ["e", 7]]).keys();',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  const firstValue = first.done ? 0 : first.value.charCodeAt(0) - 96;',
      '  const secondValue = second.done ? 0 : second.value.charCodeAt(0) - 96;',
      '  const thirdValue = third.done ? 0 : third.value.charCodeAt(0) - 96;',
      '  return (firstValue * 1000) + (secondValue * 100) + (thirdValue * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over direct Set iterables',
    expected: 3579,
    source: [
      'function* outer(): Generator<number, number, unknown> {',
      '  const values = new Set([3, 5, 7]);',
      '  yield* values;',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? 0 : third.value) * 10)' +
      ' + (fourth.done ? fourth.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over direct Map iterables',
    expected: 133557,
    source: [
      'function* outer(): Generator<[string, number], number, unknown> {',
      '  const values = new Map([["a", 3], ["c", 5], ["e", 7]]);',
      '  yield* values;',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  const firstValue = first.done ? 0 : ((first.value[0].charCodeAt(0) - 96) * 10) + first.value[1];',
      '  const secondValue = second.done ? 0 : ((second.value[0].charCodeAt(0) - 96) * 10) + second.value[1];',
      '  const thirdValue = third.done ? 0 : ((third.value[0].charCodeAt(0) - 96) * 10) + third.value[1];',
      '  return (firstValue * 10000) + (secondValue * 100) + (thirdValue) + (fourth.done ? 0 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator yield star over Set entries iterables',
    expected: 336677,
    source: [
      'function* outer(): Generator<[number, number], number, unknown> {',
      '  yield* new Set([3, 6, 7]).entries();',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  const firstValue = first.done ? 0 : (first.value[0] * 10) + first.value[1];',
      '  const secondValue = second.done ? 0 : (second.value[0] * 10) + second.value[1];',
      '  const thirdValue = third.done ? 0 : (third.value[0] * 10) + third.value[1];',
      '  return (firstValue * 10000) + (secondValue * 100) + thirdValue + (fourth.done ? 0 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator try finally on natural completion',
    expected: 3591,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  try {',
      '    yield 3;',
      '    return 9;',
      '  } finally {',
      '    yield 5;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? third.value : 0) * 10)' +
      ' + (third.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator return through finally',
    expected: 3581,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  try {',
      '    yield 3;',
      '    return 9;',
      '  } finally {',
      '    yield 5;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.return(8);',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? third.value : 0) * 10)' +
      ' + (third.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator external return through finally cleanup yields',
    expected: 175,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  try {',
        '    yield 1;',
        '    yield 2;',
      '  } finally {',
      '    yield 7;',
      '  }',
      '  return 3;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.return(5);',
      '  const third = iterator.next();',
      '  return ((first.done ? 9 : first.value) * 100)' +
      ' + ((second.done ? 9 : second.value) * 10)' +
      ' + (third.done ? third.value : 9);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator break through finally',
    expected: 3591,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let index = 0;',
      '  while (index < 1) {',
      '    try {',
      '      index = index + 1;',
      '      yield 3;',
      '      break;',
      '    } finally {',
      '      yield 5;',
      '    }',
      '  }',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? third.value : 0) * 10)' +
      ' + (third.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator continue through finally',
    expected: 3507591,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let index = 0;',
      '  while (index < 2) {',
      '    try {',
      '      index = index + 1;',
      '      if (index === 1) {',
      '        yield 3;',
      '        continue;',
      '      }',
      '      yield 7;',
      '    } finally {',
      '      yield 5;',
      '    }',
      '  }',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  const fifth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000000)' +
      ' + ((second.done ? 0 : second.value) * 100000)' +
      ' + ((third.done ? 0 : third.value) * 1000)' +
      ' + ((fourth.done ? 0 : fourth.value) * 100)' +
      ' + ((fifth.done ? fifth.value : 0) * 10)' +
      ' + (fifth.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator throw calls caught by try catch',
    expected: 37091,
    source: [
      'function* iterate(): Generator<number, number, number> {',
      '  try {',
      '    yield 3;',
      '    return 8;',
      '  } catch {',
      '    yield 7;',
      '    return 9;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.throw(5);',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 10000)' +
      ' + ((second.done ? 0 : second.value) * 1000)' +
      ' + ((third.done ? third.value : 0) * 10)' +
      ' + (third.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator throw calls caught by try catch finally',
    expected: 37591,
    source: [
      'function* iterate(): Generator<number, number, number> {',
      '  try {',
      '    yield 3;',
      '    return 8;',
      '  } catch {',
      '    yield 7;',
      '    return 9;',
      '  } finally {',
      '    yield 5;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.throw(5);',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 10000)' +
      ' + ((second.done ? 0 : second.value) * 1000)' +
      ' + ((third.done ? 0 : third.value) * 100)' +
      ' + ((fourth.done ? fourth.value : 0) * 10)' +
      ' + (fourth.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers authored sync generator throw caught by try catch',
    expected: 3791,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  try {',
      '    yield 3;',
      '    throw new Error("boom");',
      '  } catch {',
      '    yield 7;',
      '    return 9;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? third.value : 0) * 10)' +
      ' + (third.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers authored sync generator throw caught by try catch finally',
    expected: 37591,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  try {',
      '    yield 3;',
      '    throw new Error("boom");',
      '  } catch {',
      '    yield 7;',
      '    return 9;',
      '  } finally {',
      '    yield 5;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 10000)' +
      ' + ((second.done ? 0 : second.value) * 1000)' +
      ' + ((third.done ? 0 : third.value) * 100)' +
      ' + ((fourth.done ? fourth.value : 0) * 10)' +
      ' + (fourth.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator throw delegation through yield star',
    expected: 3071111,
    source: [
      'function* inner(): Generator<number, number, number> {',
      '  try {',
      '    yield 3;',
      '    return 8;',
      '  } catch {',
      '    yield 7;',
      '    return 9;',
      '  }',
      '}',
      '',
      'function* outer(): Generator<number, number, number> {',
      '  const delegated = yield* inner();',
      '  yield delegated + 1;',
      '  return delegated + 2;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.throw(5);',
      '  const third = iterator.next();',
      '  const fourth = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000000)' +
      ' + ((second.done ? 0 : second.value) * 10000)' +
      ' + ((third.done ? 0 : third.value) * 100)' +
      ' + ((fourth.done ? fourth.value : 0) * 10)' +
      ' + (fourth.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject rethrows TypeError for sync generator throw through array yield star',
    expectedThrow: { name: 'TypeError', message: 'yield* delegate does not support throw' },
    source: [
      'function* outer(): Generator<number, number, unknown> {',
      '  yield* [3, 5, 7];',
      '  return 9;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  iterator.next();',
      '  iterator.throw(5);',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject catches TypeError for sync generator throw through array yield star',
    expected: 3861,
    source: [
      'function* outer(): Generator<number, number, unknown> {',
      '  try {',
      '    yield* [3, 5, 7];',
      '    return 9;',
      '  } catch (error) {',
      '    if (error instanceof TypeError) {',
      '      yield 8;',
      '      return 6;',
      '    }',
      '    return 0;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = outer();',
      '  const first = iterator.next();',
      '  const second = iterator.throw(5);',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 1000)' +
      ' + ((second.done ? 0 : second.value) * 100)' +
      ' + ((third.done ? third.value : 0) * 10)' +
      ' + (third.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator catch bindings for thrown values',
    expected: 37091,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  try {',
      '    yield 3;',
      '    return 8;',
      '  } catch (error) {',
      '    if (typeof error === "number") {',
      '      yield error + 2;',
      '      return error + 4;',
      '    }',
      '    return 0;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.throw(5);',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 10000)' +
      ' + ((second.done ? 0 : second.value) * 1000)' +
      ' + ((third.done ? third.value : 0) * 10)' +
      ' + (third.done ? 1 : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject rethrows uncaught sync generator throw calls to host',
    expectedThrow: 5,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  yield 3;',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  iterator.next();',
      '  iterator.throw(5);',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject rethrows uncaught authored builtin Error throws from sync generators to host',
    expectedThrow: { name: 'Error', message: 'boom' },
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  yield 3;',
      '  throw new Error("boom");',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  iterator.next();',
      '  iterator.next();',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject rethrows uncaught sync generator throw Error calls to host',
    expectedThrow: { name: 'Error', message: 'boom' },
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  yield 3;',
      '  return 8;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  iterator.next();',
      '  iterator.throw(new Error("boom"));',
      '  return 0;',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator switch statements with fallthrough',
    expected: 12021844,
    source: [
      'function* iterate(flag: number): Generator<number, number, unknown> {',
      '  let total = 1;',
      '  switch (flag) {',
      '    case 1:',
      '      yield total + 10;',
      '      break;',
      '    case 2:',
      '      yield total + 20;',
      '    default:',
      '      total = total + 3;',
      '      yield total;',
      '      break;',
      '  }',
      '  return total * 10;',
      '}',
      '',
      'export function main(): number {',
      '  const one = iterate(1);',
      '  const oneFirst = one.next();',
      '  const oneSecond = one.next();',
      '  const two = iterate(2);',
      '  const twoFirst = two.next();',
      '  const twoSecond = two.next();',
      '  const twoThird = two.next();',
      '  const three = iterate(3);',
      '  const threeFirst = three.next();',
      '  const threeSecond = three.next();',
      '  return ((oneFirst.done ? 0 : oneFirst.value) * 1000000)' +
      ' + ((oneSecond.done ? oneSecond.value : 0) * 100000)' +
      ' + ((twoFirst.done ? 0 : twoFirst.value) * 1000)' +
      ' + ((twoSecond.done ? 0 : twoSecond.value) * 100)' +
      ' + ((twoThird.done ? twoThird.value : 0) * 10)' +
      ' + (threeFirst.done ? 0 : threeFirst.value)' +
      ' + (threeSecond.done ? threeSecond.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject lowers sync generator string switch statements with fallthrough',
    expected: 12021844,
    source: [
      'function* iterate(flag: string): Generator<number, number, unknown> {',
      '  let total = 1;',
      '  switch (flag) {',
      '    case "one":',
      '      yield total + 10;',
      '      break;',
      '    case "two":',
      '      yield total + 20;',
      '    default:',
      '      total = total + 3;',
      '      yield total;',
      '      break;',
      '  }',
      '  return total * 10;',
      '}',
      '',
      'export function main(): number {',
      '  const one = iterate("one");',
      '  const oneFirst = one.next();',
      '  const oneSecond = one.next();',
      '  const two = iterate("two");',
      '  const twoFirst = two.next();',
      '  const twoSecond = two.next();',
      '  const twoThird = two.next();',
      '  const three = iterate("other");',
      '  const threeFirst = three.next();',
      '  const threeSecond = three.next();',
      '  return ((oneFirst.done ? 0 : oneFirst.value) * 1000000)' +
      ' + ((oneSecond.done ? oneSecond.value : 0) * 100000)' +
      ' + ((twoFirst.done ? 0 : twoFirst.value) * 1000)' +
      ' + ((twoSecond.done ? 0 : twoSecond.value) * 100)' +
      ' + ((twoThird.done ? twoThird.value : 0) * 10)' +
      ' + (threeFirst.done ? 0 : threeFirst.value)' +
      ' + (threeSecond.done ? threeSecond.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
  {
    name: 'compileProject preserves sync generator switch break inside try finally loops',
    expected: 213223,
    source: [
      'function* iterate(): Generator<number, number, unknown> {',
      '  let count = 0;',
      '  let total = 0;',
      '  while (count < 2) {',
      '    try {',
      '      switch (count) {',
      '        case 0:',
      '          total = total + 1;',
      '          break;',
      '        default:',
      '          total = total + 2;',
      '          break;',
      '      }',
      '      yield total;',
      '      total = total + 10;',
      '    } finally {',
      '      count = count + 1;',
      '      total = total + 100;',
      '    }',
      '  }',
      '  return total;',
      '}',
      '',
      'export function main(): number {',
      '  const iterator = iterate();',
      '  const first = iterator.next();',
      '  const second = iterator.next();',
      '  const third = iterator.next();',
      '  return ((first.done ? 0 : first.value) * 100000) +',
      '    ((second.done ? 0 : second.value) * 1000) +',
      '    (third.done ? third.value : 0);',
      '}',
      '',
    ].join('\n'),
  },
];

await main();
