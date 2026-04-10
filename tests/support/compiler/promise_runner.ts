import { assertEquals } from '@std/assert';

import { compileTempProject, createCompilerTestProject } from './object_test_helpers.ts';
import { instantiateCompiledModuleInJs, resolveQualifiedExportName } from './test_helpers.ts';

type PromiseCompilerCase = {
  name: string;
  source: string;
  expectedObserved?: number;
  hostFunctions?: Record<string, (...args: unknown[]) => unknown>;
  reducer?: 'last' | 'weighted';
  exportName?: string;
  run?: (exported: (...args: unknown[]) => unknown) => Promise<void>;
};

async function runPromiseCompilerCase(testCase: PromiseCompilerCase): Promise<void> {
  const tempDirectory = await createCompilerTestProject(testCase.source);
  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0, testCase.name);
  assertEquals(result.diagnostics, [], testCase.name);
  const instance = await instantiateCompiledModuleInJs(tempDirectory, {
    hostFunctions: testCase.hostFunctions,
  });
  const exportName = await resolveQualifiedExportName(tempDirectory, testCase.exportName ?? 'main');
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}" for ${testCase.name}.`);
  }
  if (testCase.run) {
    await testCase.run(exported as (...args: unknown[]) => unknown);
    return;
  }
  let observed = 0;
  if (testCase.expectedObserved === undefined || !testCase.reducer) {
    throw new Error(`Missing callback expectations for ${testCase.name}.`);
  }
  assertEquals(
    exported((value: number) => {
      observed = testCase.reducer === 'weighted' ? observed * 100 + value : value;
      return value;
    }),
    0,
    testCase.name,
  );
  assertEquals(observed, testCase.expectedObserved, testCase.name);
}

async function main(): Promise<void> {
  const caseFilter = Deno.env.get('SOUNDSCRIPT_PROMISE_CASE');
  const caseFiltersValue = Deno.env.get('SOUNDSCRIPT_PROMISE_CASES');
  const caseFilters = caseFiltersValue
    ? new Set(JSON.parse(caseFiltersValue) as string[])
    : undefined;
  const cases: PromiseCompilerCase[] = [
    {
      name: 'compileProject executes Promise.all over direct fulfilled Promise array literals',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.all([Promise.resolve(20), Promise.resolve(2)])',
        '    .then((values) => {',
        '      callback(values[0] + values[1]);',
        '      return values.length;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject propagates Promise.all rejections from direct Promise array literals',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.all([Promise.resolve(20), Promise.reject<number>(2)])',
        '    .catch(() => {',
        '      callback(23);',
        '      return 0;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject executes Promise.race over direct fulfilled Promise array literals',
      expectedObserved: 20,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.race([Promise.resolve(20), Promise.resolve(2)])',
        '    .then((value) => {',
        '      callback(value);',
        '      return value + 1;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject propagates Promise.race rejections from direct Promise array literals',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.race([Promise.reject<number>(20), Promise.resolve(2)])',
        '    .catch(() => {',
        '      callback(23);',
        '      return 0;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject executes Promise.resolve then callbacks before exported functions return',
      expectedObserved: 21,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.resolve(20).then((value) => {',
        '    callback(value + 1);',
        '    return value + 2;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject drains chained Promise.then callbacks before exported functions return',
      expectedObserved: 25,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.resolve(20)',
        '    .then((value) => value + 2)',
        '    .then((value) => {',
        '      callback(value + 3);',
        '      return value + 4;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject executes Promise.reject catch callbacks before exported functions return',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.reject(20)',
        '    .catch(() => 22)',
        '    .then((value) => {',
        '      callback(value + 1);',
        '      return value + 2;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject propagates rejected Promises through then without handlers',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.reject(20)',
        '    .then()',
        '    .catch(() => 22)',
        '    .then((value) => {',
        '      callback(value + 1);',
        '      return value + 2;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject adopts Promise values returned from then callbacks',
      expectedObserved: 25,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.resolve(20)',
        '    .then((value) => Promise.resolve(value + 2))',
        '    .then((value) => {',
        '      callback(value + 3);',
        '      return value + 4;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject adopts rejected Promise values returned from then callbacks',
      expectedObserved: 25,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.resolve(20)',
        '    .then((value) => Promise.reject<number>(value + 2))',
        '    .catch(() => {',
        '      callback(25);',
        '      return 26;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject treats Promise.resolve(existingPromise) as passthrough for fulfilled Promises',
      expectedObserved: 21,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  const promise = Promise.resolve(20);',
        '  Promise.resolve(promise)',
        '    .then((value) => {',
        '      callback(value + 1);',
        '      return value + 2;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject treats Promise.resolve(existingPromise) as passthrough for rejected Promises',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  const promise = Promise.reject(20);',
        '  Promise.resolve(promise)',
        '    .catch(() => {',
        '      callback(22);',
        '      return 23;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers async assignment await subexpressions on the frame path',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 1;',
        '  total = total + await Promise.resolve(10);',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async assignment-subexpression function.');
        }
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async assignment-subexpression function to return a host Promise.',
          );
        }
        assertEquals(await result, 110);
      },
    },
    {
      name:
        'compileProject lowers local async functions that await fulfilled compiler-owned Promises',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    const value = await Promise.resolve(20);',
        '    return value + 2;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers local async functions with sequential await steps',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    const left = await Promise.resolve(20);',
        '    const right = await Promise.resolve(2);',
        '    return left + right;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject lowers straight-line async awaited reassignment through persisted frame locals',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let total = await Promise.resolve(20);',
        '    total = await Promise.resolve(total + 2);',
        '    return total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject lowers async variable declarations with await subexpressions on the frame path',
      expectedObserved: 24,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    const total = 20 + await Promise.resolve(3);',
        '    return total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject hoists local function declarations inside local async functions across await boundaries',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    function addTwo(value: number): number {',
        '      return value + 2;',
        '    }',
        '    const value = await Promise.resolve(20);',
        '    return addTwo(value);',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves hoisted local function captures over persisted async locals',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let total = 20;',
        '    function readTotal(offset: number): number {',
        '      return total + offset;',
        '    }',
        '    total = await Promise.resolve(total + 1);',
        '    return readTotal(1);',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject hoists block-scoped local function declarations inside local async functions across await boundaries',
      expectedObserved: 24,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    if (true) {',
        '      let total = 20;',
        '      function readTotal(offset: number): number {',
        '        return total + offset;',
        '      }',
        '      total = await Promise.resolve(total + 1);',
        '      return readTotal(3);',
        '    }',
        '    return 0;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject propagates rejected await values through local async functions',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    const value = await Promise.reject<number>(20);',
        '    return value + 2;',
        '  }',
        '  compute().catch(() => {',
        '    callback(23);',
        '    return 0;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject hoists local function declarations inside exported async functions across await boundaries',
      source: [
        'export async function main(): Promise<number> {',
        '  function addTwo(value: number): number {',
        '    return value + 2;',
        '  }',
        '  const value = await Promise.resolve(20);',
        '  return addTwo(value);',
        '}',
        '',
      ].join('\n'),
      async run(exported): Promise<void> {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async function to return a host Promise.');
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject lowers local async arrow functions that await compiler-owned Promises',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  const compute = async (): Promise<number> => {',
        '    const value = await Promise.resolve(20);',
        '    return value + 2;',
        '  };',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers module-scope async helpers used from exported sync functions',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'async function compute(): Promise<number> {',
        '  const value = await Promise.resolve(20);',
        '  return value + 2;',
        '}',
        '',
        'export function main(callback: (value: number) => number): number {',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers await on plain fulfilled values inside local async functions',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    const value = await 20;',
        '    return value + 2;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers async helpers without await by wrapping their return values',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'async function compute(): Promise<number> {',
        '  return 22;',
        '}',
        '',
        'export function main(callback: (value: number) => number): number {',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers final async try/catch around rejected awaits',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      const value = await Promise.reject<number>(20);',
        '      return value + 2;',
        '    } catch {',
        '      return 22;',
        '    }',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers final async try/catch with catch bindings',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      const value = await Promise.reject<string>("boom");',
        '      return value.length;',
        '    } catch (error: unknown) {',
        '      return 22;',
        '    }',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers final async try/finally around fulfilled awaits',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      return await Promise.resolve(20);',
        '    } finally {',
        '      callback(2);',
        '    }',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 2);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers final async try/finally around rejected awaits',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      return await Promise.reject<number>(20);',
        '    } finally {',
        '      callback(2);',
        '    }',
        '  }',
        '  compute().catch(() => {',
        '    callback(22);',
        '    return 0;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers final async try/finally with return inside finally',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      return await Promise.resolve(20);',
        '    } finally {',
        '      return 22;',
        '    }',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name:
        'compileProject lowers final async try/finally with return inside finally after rejection',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      return await Promise.reject<number>(20);',
        '    } finally {',
        '      return 22;',
        '    }',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves non-final async try/finally returns from try bodies',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      return await Promise.resolve(22);',
        '    } finally {',
        '      callback(2);',
        '    }',
        '    callback(100);',
        '    return 0;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves non-final async try/finally returns from finally bodies',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      await Promise.resolve(20);',
        '    } finally {',
        '      return 22;',
        '    }',
        '    callback(100);',
        '    return 0;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers non-final async try/catch and continues afterward',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let total = 0;',
        '    try {',
        '      total = await Promise.reject<number>(20);',
        '    } catch {',
        '      total = 20;',
        '    }',
        '    return total + 2;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers non-final async try/catch/finally and continues afterward',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let total = 0;',
        '    try {',
        '      total = await Promise.reject<number>(20);',
        '    } catch {',
        '      total = 20;',
        '    } finally {',
        '      total = total + 1;',
        '    }',
        '    return total + 1;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers nested async try catch finally regions',
      expectedObserved: 9,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let total = 0;',
        '    try {',
        '      try {',
        '        await Promise.reject<number>(20);',
        '      } catch (reason) {',
        '        total = total + 2;',
        '      } finally {',
        '        total = total + 3;',
        '      }',
        '    } finally {',
        '      total = total + 4;',
        '    }',
        '    return total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves non-final async try/catch returns from catch bodies',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      await Promise.reject<number>(20);',
        '    } catch {',
        '      return 22;',
        '    }',
        '    callback(100);',
        '    return 0;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers top-level async if branches with awaited values',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number, flag: boolean): number {',
        '  async function compute(): Promise<number> {',
        '    if (flag) {',
        '      const left = await Promise.resolve(20);',
        '      return left + 2;',
        '    }',
        '    const right = await Promise.resolve(2);',
        '    return right + 20;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }, true),
          0,
        );
        assertEquals(observed, 23);
        observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }, false),
          0,
        );
        assertEquals(observed, 23);
      },
    },
    {
      name: 'compileProject lowers top-level async if and continues after the branch',
      expectedObserved: 24,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number, flag: boolean): number {',
        '  async function compute(): Promise<number> {',
        '    if (flag) {',
        '      await Promise.resolve(20);',
        '    } else {',
        '      await Promise.resolve(2);',
        '    }',
        '    return 23;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }, true),
          0,
        );
        assertEquals(observed, 24);
        observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }, false),
          0,
        );
        assertEquals(observed, 24);
      },
    },
    {
      name: 'compileProject lowers top-level async if with sync fallthrough branch',
      expectedObserved: 24,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number, flag: boolean): number {',
        '  async function compute(): Promise<number> {',
        '    if (flag) {',
        '      await Promise.resolve(20);',
        '    }',
        '    return 23;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }, true),
          0,
        );
        assertEquals(observed, 24);
        observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }, false),
          0,
        );
        assertEquals(observed, 24);
      },
    },
    {
      name: 'compileProject preserves mutable locals across async if branches',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number, flag: boolean): number {',
        '  async function compute(): Promise<number> {',
        '    let total = 0;',
        '    if (flag) {',
        '      total = await Promise.resolve(20);',
        '    } else {',
        '      total = await Promise.resolve(21);',
        '    }',
        '    return flag ? total + 2 : total + 1;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }, true),
          0,
        );
        assertEquals(observed, 22);
        observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }, false),
          0,
        );
        assertEquals(observed, 22);
      },
    },
    {
      name: 'compileProject preserves mutable locals across async while loops',
      expectedObserved: 6,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    while (current < 3) {',
        '      const next = await Promise.resolve(current + 1);',
        '      total = total + next;',
        '      current = current + 1;',
        '    }',
        '    return total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject supports top-level async while break statements',
      expectedObserved: 11,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    while (current < 5) {',
        '      current = current + 1;',
        '      const next = await Promise.resolve(current);',
        '      total = total + next;',
        '      break;',
        '    }',
        '    return current * 10 + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject supports top-level async while continue statements',
      expectedObserved: 3,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    while (current < 3) {',
        '      current = current + 1;',
        '      await Promise.resolve(current);',
        '      continue;',
        '      total = total + 100;',
        '    }',
        '    return current + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject supports conditional async while break and continue statements',
      expectedObserved: 8,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    while (current < 5) {',
        '      current = current + 1;',
        '      if (current === 2) {',
        '        continue;',
        '      }',
        '      const next = await Promise.resolve(current);',
        '      total = total + next;',
        '      if (current === 4) {',
        '        break;',
        '      }',
        '    }',
        '    return total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject supports return statements inside async while loops',
      expectedObserved: 21,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    while (current < 5) {',
        '      current = current + 1;',
        '      const next = await Promise.resolve(current);',
        '      return next + 20;',
        '    }',
        '    return 0;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers async do while loops with awaited mutable locals',
      expectedObserved: 6,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    do {',
        '      const next = await Promise.resolve(current + 1);',
        '      total = total + next;',
        '      current = current + 1;',
        '    } while (current < 3);',
        '    return total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves outer locals across async block scoped awaits',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let total = 20;',
        '    {',
        '      let total = 0;',
        '      total = await Promise.resolve(total + 1);',
        '    }',
        '    return total + 2;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves async do while continue and break through finally',
      expectedObserved: 32,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    do {',
        '      try {',
        '        current = current + 1;',
        '        if (current === 1) {',
        '          await Promise.resolve(current);',
        '          continue;',
        '        }',
        '        total = total + current;',
        '        break;',
        '      } finally {',
        '        total = total + 5;',
        '      }',
        '    } while (current < 3);',
        '    return (current * 10) + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers async for of loops over sync generator results',
      expectedObserved: 6,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  function* iterate(): Generator<number, void, unknown> {',
        '    yield 2;',
        '    yield 4;',
        '  }',
        '  async function compute(): Promise<number> {',
        '    let total = 0;',
        '    for (const value of iterate()) {',
        '      const current = await Promise.resolve(value);',
        '      total = total + current;',
        '    }',
        '    return total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers async for of continue and break through finally',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for (const value of new Set([1, 2, 3])) {',
        '    try {',
        '      const current = await Promise.resolve(value);',
        '      if (current === 2) {',
        '        continue;',
        '      }',
        '      total = (total * 10) + current;',
        '      if (current === 3) {',
        '        break;',
        '      }',
        '    } finally {',
        '      total = total + 5;',
        '    }',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async for-of loop to return a host Promise.');
        }
        assertEquals(await result, 118);
      },
    },
    {
      name: 'compileProject lowers awaited string equality on frame locals',
      source: [
        'export async function main(): Promise<number> {',
        "  const current = await Promise.resolve('a');",
        "  return current === 'a' ? 1 : 2;",
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async string equality to return a host Promise.');
        }
        assertEquals(await result, 1);
      },
    },
    {
      name: 'compileProject lowers async numeric conditional returns on frame locals',
      source: [
        'export async function main(): Promise<number> {',
        '  const current = await Promise.resolve(1);',
        '  return current === 1 ? 1 : 2;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async numeric conditional return to return a host Promise.',
          );
        }
        assertEquals(await result, 1);
      },
    },
    {
      name: 'compileProject lowers exported async return await subexpressions on the frame path',
      source: [
        'export async function main(): Promise<number> {',
        '  return 40 + await Promise.resolve(2);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async return-await-subexpression to return a host Promise.',
          );
        }
        assertEquals(await result, 42);
      },
    },
    {
      name: 'compileProject lowers async for of loops over strings',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        "  for (const value of 'ab') {",
        '    const current = await Promise.resolve(value);',
        "    total = (total * 10) + (current === 'a' ? 1 : 2);",
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async string for-of loop to return a host Promise.');
        }
        assertEquals(await result, 12);
      },
    },
    {
      name: 'compileProject lowers async for of loops over Map values iterators',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        "  for (const value of new Map<string, number>([['a', 2], ['b', 4]]).values()) {",
        '    const current = await Promise.resolve(value);',
        '    total = total + current;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async iterator for-of loop to return a host Promise.');
        }
        assertEquals(await result, 6);
      },
    },
    {
      name: 'compileProject lowers async for of loops over iterator-valued locals',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  const values = new Map([["a", 1], ["b", 2], ["c", 3]]).values();',
        '  for (const value of values) {',
        '    const current = await Promise.resolve(value);',
        '    total = total + current;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async iterator-local for-of loop to return a host Promise.',
          );
        }
        assertEquals(await result, 6);
      },
    },
    {
      name: 'compileProject lowers async for of loops over owned number array locals',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  const values = [2, 4, 6];',
        '  for (const value of values) {',
        '    const current = await Promise.resolve(value);',
        '    if (current === 4) {',
        '      continue;',
        '    }',
        '    total = total + current;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async owned-array for-of loop to return a host Promise.',
          );
        }
        assertEquals(await result, 8);
      },
    },
    {
      name: 'compileProject lowers async for of loops over owned string array locals',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        "  const values = ['a', 'b'];",
        '  for (const value of values) {',
        '    const current = await Promise.resolve(value);',
        "    total = (total * 10) + (current === 'a' ? 1 : 2);",
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async owned-string-array for-of loop to return a host Promise.',
          );
        }
        assertEquals(await result, 12);
      },
    },
    {
      name: 'compileProject lowers async for of loops over owned boolean array locals',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  const values = [true, false, true];',
        '  for (const value of values) {',
        '    const current = await Promise.resolve(value);',
        '    total = (total * 10) + (current ? 1 : 0);',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async owned-boolean-array for-of loop to return a host Promise.',
          );
        }
        assertEquals(await result, 101);
      },
    },
    {
      name: 'compileProject lowers async for of loops over owned tagged array locals',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        "  const values: Array<number | string> = [2, 'a', 4];",
        '  for (const value of values) {',
        '    const current = await Promise.resolve(value);',
        "    total = (total * 10) + (typeof current === 'number' ? current : 9);",
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async owned-tagged-array for-of loop to return a host Promise.',
          );
        }
        assertEquals(await result, 294);
      },
    },
    {
      name: 'compileProject lowers async for in loops over ordinary objects',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  const pair = { left: 1, right: 2, stop: 3 };',
        '  for (const key in pair) {',
        '    try {',
        '      const current = await Promise.resolve(key);',
        '      if (current === "left") {',
        '        continue;',
        '      }',
        '      if (current === "stop") {',
        '        break;',
        '      }',
        '      total = (total * 10) + (current === "right" ? 2 : 9);',
        '    } finally {',
        '      total = total + 1;',
        '    }',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async for-in loop to return a host Promise.');
        }
        assertEquals(await result, 14);
      },
    },
    {
      name: 'compileProject bridges exported async functions to host Promises',
      source: [
        'export async function main(): Promise<number> {',
        '  const value = await Promise.resolve(20);',
        '  return value + 2;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async function to return a host Promise.');
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject bridges exported async while loops with awaited mutable locals',
      source: [
        'export async function main(): Promise<number> {',
        '  let current = 0;',
        '  let total = 0;',
        '  while (current < 3) {',
        '    const next = await Promise.resolve(current + 1);',
        '    total = total + next;',
        '    current = current + 1;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async while loop to return a host Promise.');
        }
        assertEquals(await result, 6);
      },
    },
    {
      name: 'compileProject bridges exported async for loops with top-level continue statements',
      source: [
        'export async function main(): Promise<number> {',
        '  let current = 0;',
        '  let total = 0;',
        '  for (; current < 3; current = current + 1) {',
        '    await Promise.resolve(current + 1);',
        '    continue;',
        '    total = total + 100;',
        '  }',
        '  return current + total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async for loop with continue to return a host Promise.',
          );
        }
        assertEquals(await result, 3);
      },
    },
    {
      name: 'compileProject bridges exported async for let loops with continue statements',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for (let current = 0; current < 3; current = current + 1) {',
        '    if (current === 1) {',
        '      continue;',
        '    }',
        '    const next = await Promise.resolve(current + 1);',
        '    total = total + next;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async for let loop to return a host Promise.');
        }
        assertEquals(await result, 4);
      },
    },
    {
      name: 'compileProject preserves mutable locals across async for loops',
      expectedObserved: 6,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 3; current = current + 1) {',
        '      const next = await Promise.resolve(current + 1);',
        '      total = total + next;',
        '    }',
        '    return total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers async for loops with expression initializers',
      expectedObserved: 6,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (current = 0; current < 3; current = current + 1) {',
        '      const next = await Promise.resolve(current + 1);',
        '      total = total + next;',
        '    }',
        '    return total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject keeps async for let loop bindings out of later async continuations',
      expectedObserved: 27,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 20;',
        '    let total = 0;',
        '    for (let current = 0; current < 3; current = current + 1) {',
        '      const next = await Promise.resolve(current + 1);',
        '      total = total + next;',
        '    }',
        '    return current + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject supports top-level async for break statements',
      expectedObserved: 1,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 5; current = current + 1) {',
        '      const next = await Promise.resolve(current + 1);',
        '      total = total + next;',
        '      break;',
        '    }',
        '    return current * 10 + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject supports top-level async for continue statements',
      expectedObserved: 3,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 3; current = current + 1) {',
        '      await Promise.resolve(current + 1);',
        '      continue;',
        '      total = total + 100;',
        '    }',
        '    return current + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject supports conditional async for break and continue statements',
      expectedObserved: 24,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 5; current = current + 1) {',
        '      if (current === 1) {',
        '        continue;',
        '      }',
        '      const next = await Promise.resolve(current + 1);',
        '      total = total + next;',
        '      if (current === 2) {',
        '        break;',
        '      }',
        '    }',
        '    return current * 10 + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves continue completion through async for finally blocks',
      expectedObserved: 303,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 3; current = current + 1) {',
        '      try {',
        '        total = total + 100;',
        '      } finally {',
        '        await Promise.resolve(current);',
        '        continue;',
        '      }',
        '      total = total + 1;',
        '    }',
        '    return total + current;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves break completion through async for finally blocks',
      expectedObserved: 100,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 5; current = current + 1) {',
        '      try {',
        '        total = total + 100;',
        '      } finally {',
        '        await Promise.resolve(current);',
        '        break;',
        '      }',
        '      total = total + 1;',
        '    }',
        '    return total + current;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves catch bindings through async for try catch continue',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let total = 0;',
        '    for (; total < 2;) {',
        '      try {',
        '        await Promise.reject<string>("boom");',
        '        total = 100;',
        '      } catch (error: unknown) {',
        '        total = total + 1;',
        '        continue;',
        '      }',
        '    }',
        '    return total + 20;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject supports return statements inside async for loops',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    for (; current < 5; current = current + 1) {',
        '      const next = await Promise.resolve(current + 1);',
        '      return next + 21;',
        '    }',
        '    return 0;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject supports return statements inside async for finally blocks',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    for (; current < 2; current = current + 1) {',
        '      try {',
        '        await Promise.resolve(current + 1);',
        '      } finally {',
        '        return 22;',
        '      }',
        '    }',
        '    return 0;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value + 1);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves continue completion through async for try finally',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 2; current = current + 1) {',
        '      try {',
        '        await Promise.resolve(current + 1);',
        '        continue;',
        '      } finally {',
        '        total = total + 1;',
        '      }',
        '    }',
        '    return current * 10 + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves return completion through exported async for try finally',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for (; total < 1; total = total + 1) {',
        '    try {',
        '      const next = await Promise.resolve(20);',
        '      return next + 1;',
        '    } finally {',
        '      total = total + 1;',
        '    }',
        '  }',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async for loop with return to return a host Promise.');
        }
        assertEquals(await result, 21);
      },
    },
    {
      name: 'compileProject preserves break completion through async for try finally',
      expectedObserved: 11,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 5; current = current + 1) {',
        '      try {',
        '        const next = await Promise.resolve(current + 1);',
        '        total = total + next;',
        '        break;',
        '      } finally {',
        '        total = total + 10;',
        '      }',
        '    }',
        '    return current * 100 + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves continue completion through async for try catch',
      expectedObserved: 3,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 3; current = current + 1) {',
        '      try {',
        '        await Promise.reject<number>(current + 1);',
        '      } catch {',
        '        continue;',
        '      }',
        '      total = total + 100;',
        '    }',
        '    return current + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject preserves break completion through async for try catch',
      expectedObserved: 7,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    let current = 0;',
        '    let total = 0;',
        '    for (; current < 5; current = current + 1) {',
        '      try {',
        '        await Promise.reject<number>(current + 1);',
        '      } catch {',
        '        total = total + 7;',
        '        break;',
        '      }',
        '      total = total + 100;',
        '    }',
        '    return current * 10 + total;',
        '  }',
        '  compute().then((value) => {',
        '    callback(value);',
        '    return value;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject bridges exported async for loops with awaited mutable locals',
      source: [
        'export async function main(): Promise<number> {',
        '  let current = 0;',
        '  let total = 0;',
        '  for (; current < 3; current = current + 1) {',
        '    const next = await Promise.resolve(current + 1);',
        '    total = total + next;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async for loop to return a host Promise.');
        }
        assertEquals(await result, 6);
      },
    },
    {
      name: 'compileProject awaits ambient imported host Promise results',
      source: [
        'declare function fetchNumber(): Promise<number>;',
        '',
        'export async function main(): Promise<number> {',
        '  return await fetchNumber();',
        '}',
        '',
      ].join('\n'),
      hostFunctions: {
        'src/index.ts:fetchNumber': () => Promise.resolve(22),
      },
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async ambient import to return a host Promise.');
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject catches rejected ambient imported host Promise results',
      source: [
        'declare function fetchNumber(): Promise<number>;',
        '',
        'export async function main(): Promise<number> {',
        '  try {',
        '    return await fetchNumber();',
        '  } catch {',
        '    return 22;',
        '  }',
        '}',
        '',
      ].join('\n'),
      hostFunctions: {
        'src/index.ts:fetchNumber': () => Promise.reject(20),
      },
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async ambient import catch to return a host Promise.');
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject awaits ambient imported host Promise results with number params',
      source: [
        'declare function fetchNumber(input: number): Promise<number>;',
        '',
        'export async function main(): Promise<number> {',
        '  return await fetchNumber(20);',
        '}',
        '',
      ].join('\n'),
      hostFunctions: {
        'src/index.ts:fetchNumber': (input: unknown) => Promise.resolve(Number(input) + 2),
      },
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async ambient import with params to return a host Promise.',
          );
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject awaits ambient imported host Promise results with string params',
      source: [
        'declare function fetchNumber(input: string): Promise<number>;',
        '',
        'export async function main(): Promise<number> {',
        '  return await fetchNumber("20");',
        '}',
        '',
      ].join('\n'),
      hostFunctions: {
        'src/index.ts:fetchNumber': (input: unknown) => Promise.resolve(Number(String(input)) + 2),
      },
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async ambient string import to return a host Promise.',
          );
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject awaits ambient imported host Promise results with Promise params',
      source: [
        'declare function fetchNumber(input: Promise<number>): Promise<number>;',
        '',
        'export async function main(): Promise<number> {',
        '  return await fetchNumber(Promise.resolve(20));',
        '}',
        '',
      ].join('\n'),
      hostFunctions: {
        'src/index.ts:fetchNumber': async (input: unknown) =>
          Number(await (input as Promise<unknown>)) + 2,
      },
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async ambient Promise-param import to return a host Promise.',
          );
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject awaits host Promise parameters through exported Promise boundaries',
      source: [
        'async function compute(input: Promise<number>): Promise<number> {',
        '  const value = await input;',
        '  return value + 2;',
        '}',
        '',
        'export function main(input: Promise<number>): Promise<number> {',
        '  return compute(input);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported(Promise.resolve(20));
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported Promise boundary to return a host Promise.');
        }
        assertEquals(await result, 22);
      },
    },
    {
      name:
        'compileProject propagates rejected host Promise parameters through exported Promise boundaries',
      source: [
        'async function compute(input: Promise<number>): Promise<number> {',
        '  return await input;',
        '}',
        '',
        'export function main(input: Promise<number>): Promise<number> {',
        '  return compute(input);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported(Promise.reject(20));
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported Promise boundary to return a host Promise.');
        }
        try {
          await result;
          throw new Error('Expected bridged host Promise rejection.');
        } catch (error) {
          assertEquals(error, 20);
        }
      },
    },
    {
      name: 'compileProject bridges exported async try/catch over host Promise rejections',
      source: [
        'export async function main(input: Promise<number>): Promise<number> {',
        '  try {',
        '    return await input;',
        '  } catch {',
        '    return 22;',
        '  }',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported(Promise.reject(20));
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async try/catch to return a host Promise.');
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject bridges exported async try/finally with return inside finally',
      source: [
        'export async function main(input: Promise<number>): Promise<number> {',
        '  try {',
        '    return await input;',
        '  } finally {',
        '    return 22;',
        '  }',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported(Promise.reject(20));
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async try/finally to return a host Promise.');
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject bridges exported async try/catch with catch bindings',
      source: [
        'export async function main(input: Promise<number>): Promise<number> {',
        '  try {',
        '    return await input;',
        '  } catch (error: unknown) {',
        '    return 22;',
        '  }',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported(Promise.reject('boom'));
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async try/catch to return a host Promise.');
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject lowers async throw statements through compiler-owned Promise rejection',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function run(): Promise<number> {',
        '    throw new Error("boom");',
        '  }',
        '  run()',
        '    .catch(() => {',
        '      callback(22);',
        '      return 0;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }),
          0,
        );
        assertEquals(observed, 22);
      },
    },
    {
      name: 'compileProject bridges exported async throw statements to host Promise rejection',
      source: [
        'export async function main(): Promise<number> {',
        '  throw new Error("boom");',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async throw to return a host Promise.');
        }
        const observed = await result.then(() => 0, () => 22);
        assertEquals(observed, 22);
      },
    },
    {
      name: 'compileProject lowers async throw statements from builtin Error parameters',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function run(reason: Error): Promise<number> {',
        '    throw reason;',
        '  }',
        '  run(new Error("boom"))',
        '    .catch(() => {',
        '      callback(22);',
        '      return 0;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }),
          0,
        );
        assertEquals(observed, 22);
      },
    },
    {
      name: 'compileProject lowers async throw statements from inferred builtin Error locals',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function run(): Promise<number> {',
        '    const reason = new Error("boom");',
        '    throw reason;',
        '  }',
        '  run()',
        '    .catch(() => {',
        '      callback(22);',
        '      return 0;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }),
          0,
        );
        assertEquals(observed, 22);
      },
    },
    {
      name: 'compileProject lowers async throw statements from annotated builtin Error locals',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function run(): Promise<number> {',
        '    let reason: Error = new Error("boom");',
        '    throw reason;',
        '  }',
        '  run()',
        '    .catch(() => {',
        '      callback(22);',
        '      return 0;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }),
          0,
        );
        assertEquals(observed, 22);
      },
    },
    {
      name: 'compileProject lowers async catch rethrow after builtin Error instanceof narrowing',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    const rejected: Promise<number> = Promise.reject(new Error("boom"));',
        '    try {',
        '      return await rejected;',
        '    } catch (error: unknown) {',
        '      if (error instanceof Error) {',
        '        throw error;',
        '      }',
        '      return 21;',
        '    }',
        '  }',
        '  compute().catch(() => {',
        '    callback(23);',
        '    return 0;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }),
          0,
        );
        assertEquals(observed, 23);
      },
    },
    {
      name: 'compileProject lowers direct await Promise.reject builtin Error catch rethrow',
      expectedObserved: 23,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  async function compute(): Promise<number> {',
        '    try {',
        '      return await Promise.reject(new Error("boom"));',
        '    } catch (error: unknown) {',
        '      if (error instanceof Error) {',
        '        throw error;',
        '      }',
        '      return 21;',
        '    }',
        '  }',
        '  compute().catch(() => {',
        '    callback(23);',
        '    return 0;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        let observed = 0;
        assertEquals(
          exported((value: number) => {
            observed = value;
            return value;
          }),
          0,
        );
        assertEquals(observed, 23);
      },
    },
    {
      name:
        'compileProject bridges exported async builtin Error catch rethrow to host Promise rejection',
      source: [
        'export async function main(): Promise<number> {',
        '  try {',
        '    return await Promise.reject(new Error("boom"));',
        '  } catch (error: unknown) {',
        '    if (error instanceof Error) {',
        '      throw error;',
        '    }',
        '    return 21;',
        '  }',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async builtin Error rethrow to return a host Promise.',
          );
        }
        const observed = await result.then(() => 0, () => 22);
        assertEquals(observed, 22);
      },
    },
    {
      name: 'compileProject preserves builtin Error narrowing across await in async functions',
      source: [
        'export async function main(): Promise<number> {',
        '  try {',
        '    throw new Error("boom");',
        '  } catch (error: unknown) {',
        '    if (error instanceof Error) {',
        '      const marker = await Promise.resolve(2);',
        '      return error.message.length + marker;',
        '    }',
        '    return 0;',
        '  }',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async Error-narrowing function to return a host Promise.',
          );
        }
        assertEquals(await result, 6);
      },
    },
    {
      name:
        'compileProject bridges host Promise builtin Error catch rethrow through exported async functions',
      source: [
        'export async function main(input: Promise<number>): Promise<number> {',
        '  try {',
        '    return await input;',
        '  } catch (error: unknown) {',
        '    if (error instanceof Error) {',
        '      throw error;',
        '    }',
        '    return 21;',
        '  }',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported(Promise.reject(new Error('boom')));
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async host Promise Error rethrow to return a host Promise.',
          );
        }
        const observed = await result.then(() => 0, () => 22);
        assertEquals(observed, 22);
      },
    },
    {
      name: 'compileProject bridges exported async if branches with awaited mutable locals',
      source: [
        'export async function main(flag: boolean): Promise<number> {',
        '  let total = 0;',
        '  if (flag) {',
        '    total = await Promise.resolve(20);',
        '  } else {',
        '    total = await Promise.resolve(21);',
        '  }',
        '  return flag ? total + 2 : total + 1;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const trueResult = exported(true);
        if (!(trueResult instanceof Promise)) {
          throw new Error('Expected exported async if branch to return a host Promise.');
        }
        assertEquals(await trueResult, 22);
        const falseResult = exported(false);
        if (!(falseResult instanceof Promise)) {
          throw new Error('Expected exported async if branch to return a host Promise.');
        }
        assertEquals(await falseResult, 22);
      },
    },
    {
      name: 'compileProject bridges exported async non-final try/catch with mutable locals',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  try {',
        '    total = await Promise.reject<number>(20);',
        '  } catch {',
        '    total = 20;',
        '  }',
        '  return total + 2;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async try/catch to return a host Promise.');
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject exports async generator functions as host iterators',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield 3;',
        '  return 5;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 3, done: false });
        assertEquals(third, { value: 5, done: true });
      },
    },
    {
      name: 'compileProject exports async generator return calls as host iterators',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield 3;',
        '  return 5;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).return?.(20);
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 20, done: true });
        assertEquals(third, { value: undefined, done: true });
      },
    },
    {
      name: 'compileProject exports async generator throw calls as host iterators',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, number> {',
        '  try {',
        '    yield 1;',
        '    return 5;',
        '  } catch {',
        '    yield 7;',
        '    return 9;',
        '  }',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, number>).next();
        const second = await (iterator as AsyncIterator<number, number, number>).throw?.(5);
        const third = await (iterator as AsyncIterator<number, number, number>).next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 7, done: false });
        assertEquals(third, { value: 9, done: true });
      },
    },
    {
      name: 'compileProject exports uncaught async generator throw calls as rejected host Promises',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, number> {',
        '  yield 1;',
        '  return 5;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, number>).next();
        assertEquals(first, { value: 1, done: false });
        let rejected = false;
        try {
          await (iterator as AsyncIterator<number, number, number>).throw?.(5);
        } catch (error) {
          rejected = true;
          assertEquals(error, 5);
        }
        assertEquals(rejected, true, 'Expected exported uncaught async generator throw to reject.');
      },
    },
    {
      name:
        'compileProject exports uncaught async generator builtin Error throws as rejected host Promises',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  throw new Error("boom");',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        let rejected = false;
        try {
          await (iterator as AsyncIterator<number, number, unknown>).next();
        } catch (error) {
          rejected = true;
          assertEquals(error, { name: 'Error', message: 'boom' });
        }
        assertEquals(
          rejected,
          true,
          'Expected exported uncaught async generator builtin Error throw to reject.',
        );
      },
    },
    {
      name:
        'compileProject exports uncaught async generator throw Error calls as rejected host Promises',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, number> {',
        '  yield 1;',
        '  return 5;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, number>).next();
        assertEquals(first, { value: 1, done: false });
        let rejected = false;
        try {
          await (iterator as AsyncIterator<number, number, number>).throw?.(new Error('boom'));
        } catch (error) {
          rejected = true;
          assertEquals(error, { name: 'Error', message: 'boom' });
        }
        assertEquals(
          rejected,
          true,
          'Expected exported uncaught async generator throw(Error) to reject.',
        );
      },
    },
    {
      name: 'compileProject exports async generator yield star over local arrays as host iterators',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const values = [1, 3, 5];',
        '  yield* values;',
        '  return 7;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        const fourth = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 3, done: false });
        assertEquals(third, { value: 5, done: false });
        assertEquals(fourth, { value: 7, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator yield star over local Promise arrays as host iterators',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const values = [Promise.resolve(1), Promise.resolve(3), Promise.resolve(5)];',
        '  yield* values;',
        '  return 7;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        const fourth = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 3, done: false });
        assertEquals(third, { value: 5, done: false });
        assertEquals(fourth, { value: 7, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator throw through array yield star as rejected host Promises',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield* [1, 3, 5];',
        '  return 7;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        let rejected = false;
        try {
          await (iterator as AsyncIterator<number, number, unknown>).throw?.(5);
        } catch (error) {
          rejected = true;
          assertEquals(error, {
            name: 'TypeError',
            message: 'yield* delegate does not support throw',
          });
        }
        assertEquals(
          rejected,
          true,
          'Expected exported async generator array-yield* throw to reject.',
        );
      },
    },
    {
      name: 'compileProject exports async generator class methods as host iterators',
      exportName: 'iterateFromBox',
      source: [
        'class Box {',
        '  seed = 4;',
        '  async *iterate(): AsyncGenerator<number, number, unknown> {',
        '    yield this.seed + 1;',
        '    return this.seed + 3;',
        '  }',
        '}',
        '',
        'export function iterateFromBox(): AsyncGenerator<number, number, unknown> {',
        '  return new Box().iterate();',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error(
            'Expected exported async generator wrapper to return an iterator object.',
          );
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 5, done: false });
        assertEquals(second, { value: 7, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator class methods with super calls as host iterators',
      exportName: 'iterateFromBox',
      source: [
        'class Base {',
        '  bump(value: number): number {',
        '    return value + 1;',
        '  }',
        '}',
        '',
        'class Box extends Base {',
        '  seed = 4;',
        '  async *iterate(): AsyncGenerator<number, number, unknown> {',
        '    yield await Promise.resolve(super.bump(this.seed));',
        '    return await Promise.resolve(super.bump(this.seed + 2));',
        '  }',
        '}',
        '',
        'export function iterateFromBox(): AsyncGenerator<number, number, unknown> {',
        '  return new Box().iterate();',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error(
            'Expected exported async generator wrapper to return an iterator object.',
          );
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 5, done: false });
        assertEquals(second, { value: 7, done: true });
      },
    },
    {
      name: 'compileProject exports async generator object methods as host iterators',
      exportName: 'iterateFromBag',
      source: [
        'export function iterateFromBag(): AsyncGenerator<number, number, unknown> {',
        '  const bag = {',
        '    seed: 2,',
        '    async *iterate(): AsyncGenerator<number, number, unknown> {',
        '      yield await Promise.resolve(this.seed + 1);',
        '      return await Promise.resolve(this.seed + 4);',
        '    },',
        '  };',
        '  return bag.iterate();',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error(
            'Expected exported async generator wrapper to return an iterator object.',
          );
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 3, done: false });
        assertEquals(second, { value: 6, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator yield star over iterator-valued locals as host iterators',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const values = new Map([["a", 1], ["b", 3], ["c", 5]]).values();',
        '  yield* values;',
        '  return 7;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        const fourth = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 3, done: false });
        assertEquals(third, { value: 5, done: false });
        assertEquals(fourth, { value: 7, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator yield star through async generator delegates as host iterators',
      exportName: 'iterate',
      source: [
        'async function* inner(): AsyncGenerator<number, number, unknown> {',
        '  yield await Promise.resolve(1);',
        '  yield await Promise.resolve(3);',
        '  return await Promise.resolve(5);',
        '}',
        '',
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const delegated = yield* inner();',
        '  return delegated + 2;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 3, done: false });
        assertEquals(third, { value: 7, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator yield star through Promise-yielding sync generator delegates as host iterators',
      exportName: 'iterate',
      source: [
        'function* inner(): Generator<Promise<number>, number, unknown> {',
        '  yield Promise.resolve(1);',
        '  yield Promise.resolve(3);',
        '  return 5;',
        '}',
        '',
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const delegated = yield* inner();',
        '  return delegated + 2;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 3, done: false });
        assertEquals(third, { value: 7, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator return delegation through Promise-yielding sync generator delegates as host iterators',
      exportName: 'iterate',
      source: [
        'function* inner(): Generator<Promise<number>, number, number> {',
        '  try {',
        '    yield Promise.resolve(3);',
        '    yield Promise.resolve(5);',
        '    return 7;',
        '  } finally {',
        '    yield Promise.resolve(11);',
        '  }',
        '}',
        '',
        'export async function* iterate(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  return delegated + 1;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, number>).next();
        const second = await (iterator as AsyncIterator<number, number, number>).return?.(4);
        const third = await (iterator as AsyncIterator<number, number, number>).next();
        assertEquals(first, { value: 3, done: false });
        assertEquals(second, { value: 11, done: false });
        assertEquals(third, { value: 5, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator throw delegation through Promise-yielding sync generator delegates as host iterators',
      exportName: 'iterate',
      source: [
        'function* inner(): Generator<Promise<number>, number, number> {',
        '  try {',
        '    yield Promise.resolve(3);',
        '    yield Promise.resolve(5);',
        '    return 7;',
        '  } catch {',
        '    yield Promise.resolve(8);',
        '    return 9;',
        '  } finally {',
        '    yield Promise.resolve(11);',
        '  }',
        '}',
        '',
        'export async function* iterate(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  return delegated + 1;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, number>).next();
        const second = await (iterator as AsyncIterator<number, number, number>).throw?.(5);
        const third = await (iterator as AsyncIterator<number, number, number>).next();
        const fourth = await (iterator as AsyncIterator<number, number, number>).next();
        assertEquals(first, { value: 3, done: false });
        assertEquals(second, { value: 8, done: false });
        assertEquals(third, { value: 11, done: false });
        assertEquals(fourth, { value: 10, done: true });
      },
    },
    {
      name: 'compileProject exports async generators with for-await over iterator locals',
      exportName: 'iterate',
      source: [
        'async function* inner(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield 3;',
        '  return 5;',
        '}',
        '',
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const values = inner();',
        '  for await (const value of values) {',
        '    yield value + 1;',
        '  }',
        '  return 9;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 2, done: false });
        assertEquals(second, { value: 4, done: false });
        assertEquals(third, { value: 9, done: true });
      },
    },
    {
      name: 'compileProject exports async generators with for-await over sync generators',
      exportName: 'outer',
      source: [
        'function* iterate(): Generator<number, number, unknown> {',
        '  yield 1;',
        '  yield 3;',
        '  return 5;',
        '}',
        '',
        'export async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    yield value + 10;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 11, done: false });
        assertEquals(second, { value: 13, done: false });
        assertEquals(third, { value: 13, done: true });
      },
    },
    {
      name:
        'compileProject exports async generators with for-await over Promise-yielding sync generators',
      exportName: 'outer',
      source: [
        'function* iterate(): Generator<Promise<number>, number, unknown> {',
        '  yield Promise.resolve(1);',
        '  yield Promise.resolve(3);',
        '  return 5;',
        '}',
        '',
        'export async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    yield value + 10;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 11, done: false });
        assertEquals(second, { value: 13, done: false });
        assertEquals(third, { value: 13, done: true });
      },
    },
    {
      name: 'compileProject exports async generators with for-await over local Promise arrays',
      exportName: 'outer',
      source: [
        'export async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  const values = [Promise.resolve(2), Promise.resolve(4)];',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    yield value + 10;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 12, done: false });
        assertEquals(second, { value: 14, done: false });
        assertEquals(third, { value: 24, done: true });
      },
    },
    {
      name: 'compileProject exports async generators with for-await over strings',
      exportName: 'outer',
      source: [
        'export async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for await (const value of "bd") {',
        '    const code = value.charCodeAt(0) - 96;',
        '    yield code + 10;',
        '    total = (total * 10) + code;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 12, done: false });
        assertEquals(second, { value: 14, done: false });
        assertEquals(third, { value: 24, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator return delegation through async generators as host iterators',
      exportName: 'outer',
      source: [
        'async function* inner(): AsyncGenerator<number, number, number> {',
        '  try {',
        '    yield 3;',
        '    yield 5;',
        '    return 7;',
        '  } finally {',
        '    yield 9;',
        '  }',
        '}',
        '',
        'export async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  return delegated + 1;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, number>).next();
        const second = await (iterator as AsyncIterator<number, number, number>).return?.(4);
        const third = await (iterator as AsyncIterator<number, number, number>).next();
        assertEquals(first, { value: 3, done: false });
        assertEquals(second, { value: 9, done: false });
        assertEquals(third, { value: 5, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator yield star resume delegation through async generators as host iterators',
      exportName: 'outer',
      source: [
        'async function* inner(): AsyncGenerator<number, number, number> {',
        '  const received = yield 10;',
        '  yield received + 1;',
        '  return received + 2;',
        '}',
        '',
        'export async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  yield delegated + 3;',
        '  return delegated + 4;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, number>).next();
        const second = await (iterator as AsyncIterator<number, number, number>).next(7);
        const third = await (iterator as AsyncIterator<number, number, number>).next();
        const fourth = await (iterator as AsyncIterator<number, number, number>).next();
        assertEquals(first, { value: 10, done: false });
        assertEquals(second, { value: 8, done: false });
        assertEquals(third, { value: 12, done: false });
        assertEquals(fourth, { value: 13, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator throw delegation through async generator delegates as host iterators',
      exportName: 'outer',
      source: [
        'async function* inner(): AsyncGenerator<number, number, number> {',
        '  try {',
        '    yield 3;',
        '    return 8;',
        '  } catch {',
        '    yield 7;',
        '    return 9;',
        '  }',
        '}',
        '',
        'export async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  yield delegated + 1;',
        '  return delegated + 2;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, number>).next();
        const second = await (iterator as AsyncIterator<number, number, number>).throw?.(5);
        const third = await (iterator as AsyncIterator<number, number, number>).next();
        const fourth = await (iterator as AsyncIterator<number, number, number>).next();
        assertEquals(first, { value: 3, done: false });
        assertEquals(second, { value: 7, done: false });
        assertEquals(third, { value: 10, done: false });
        assertEquals(fourth, { value: 11, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator external return through finally cleanup yield await',
      exportName: 'iterate',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    yield 1;',
        '    yield 2;',
        '  } finally {',
        '    yield await Promise.resolve(7);',
        '  }',
        '  return 3;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).return?.(5);
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 7, done: false });
        assertEquals(third, { value: 5, done: true });
      },
    },
    {
      name:
        'compileProject exports async generator return delegation through awaited async generators with finally cleanup',
      exportName: 'outer',
      source: [
        'async function* inner(): AsyncGenerator<number, number, number> {',
        '  try {',
        '    yield await Promise.resolve(3);',
        '    yield await Promise.resolve(5);',
        '    return await Promise.resolve(7);',
        '  } finally {',
        '    yield await Promise.resolve(9);',
        '  }',
        '}',
        '',
        'export async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  return delegated + 1;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, number>).next();
        const second = await (iterator as AsyncIterator<number, number, number>).return?.(4);
        const third = await (iterator as AsyncIterator<number, number, number>).next();
        assertEquals(first, { value: 3, done: false });
        assertEquals(second, { value: 9, done: false });
        assertEquals(third, { value: 5, done: true });
      },
    },
    {
      name: 'compileProject exports async generators with for-await over iterator locals',
      exportName: 'outer',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield 3;',
        '  return 5;',
        '}',
        '',
        'export async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  const values = iterate();',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    yield value + 10;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        const third = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 11, done: false });
        assertEquals(second, { value: 13, done: false });
        assertEquals(third, { value: 13, done: true });
      },
    },
    {
      name: 'compileProject exports async generators with for-await continue through finally',
      exportName: 'outer',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield 2;',
        '  yield 3;',
        '  return 4;',
        '}',
        '',
        'export async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    try {',
        '      if (value === 1) {',
        '        total = 1;',
        '        continue;',
        '      }',
        '      yield value + 10;',
        '      if (value === 2) {',
        '        break;',
        '      }',
        '    } finally {',
        '      total = (total * 10) + 9;',
        '    }',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const iterator = exported();
        if ((typeof iterator !== 'object' && typeof iterator !== 'function') || iterator === null) {
          throw new Error('Expected exported async generator to return an iterator object.');
        }
        const first = await (iterator as AsyncIterator<number, number, unknown>).next();
        const second = await (iterator as AsyncIterator<number, number, unknown>).next();
        assertEquals(first, { value: 12, done: false });
        assertEquals(second, { value: 199, done: true });
      },
    },
    {
      name: 'compileProject lowers awaited async generator iterator results as dynamic objects',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  return 2;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 10 + (second.done ? second.value : 8);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported async generator consumer to return a host Promise.');
        }
        assertEquals(await result, 12);
      },
    },
    {
      name: 'compileProject lowers straight-line await inside async generators',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const value = await Promise.resolve(20);',
        '  yield value + 1;',
        '  return value + 2;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported awaited async generator consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 232);
      },
    },
    {
      name: 'compileProject lowers sequential await steps inside async generators',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const left = await Promise.resolve(20);',
        '  const right = await Promise.resolve(3);',
        '  yield left + right;',
        '  return left - right;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported sequential async generator consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 247);
      },
    },
    {
      name: 'compileProject lowers await after yielded async generator steps',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  const value = await Promise.resolve(20);',
        '  return value + 2;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported post-yield async generator consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 32);
      },
    },
    {
      name: 'compileProject lowers awaited async generator rejections through catch bindings',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    const value = await Promise.reject<number>(20);',
        '    yield value;',
        '    return 0;',
        '  } catch (error) {',
        '    if (typeof error === "number") {',
        '      yield error + 1;',
        '      return error + 2;',
        '    }',
        '    return 0;',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported caught async generator consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 232);
      },
    },
    {
      name: 'compileProject lowers yield await inside async generators',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield await Promise.resolve(20);',
        '  return 22;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported yield-await async generator consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 222);
      },
    },
    {
      name: 'compileProject lowers yield await subexpressions inside async generators',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 20 + await Promise.resolve(1);',
        '  return 23;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported yield-await-subexpression async generator consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 233);
      },
    },
    {
      name: 'compileProject lowers async generator variable declarations with await subexpressions',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const current = 20 + await Promise.resolve(1);',
        '  yield current;',
        '  return current + 1;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator await-subexpression consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 232);
      },
    },
    {
      name: 'compileProject lowers return await inside async generators',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  return await Promise.resolve(22);',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported return-await async generator consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 32);
      },
    },
    {
      name: 'compileProject lowers async generator return await subexpressions',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  return 20 + await Promise.resolve(2);',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const terminal = await iterator.next();',
        '  return terminal.done ? terminal.value : 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator return-await-subexpression consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 22);
      },
    },
    {
      name: 'compileProject lowers async generator yield star over iterator-valued locals',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const values = new Map([["a", 3], ["b", 5], ["c", 7]]).values();',
        '  yield* values;',
        '  return 9;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000)' +
        ' + ((second.done ? 0 : second.value) * 100)' +
        ' + ((third.done ? 0 : third.value) * 10)' +
        ' + (fourth.done ? fourth.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator iterator-local yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 3579);
      },
    },
    {
      name: 'compileProject lowers async generator yield star over local string arrays',
      source: [
        'async function* iterate(): AsyncGenerator<string, number, unknown> {',
        "  const values = ['a', 'c', 'e'];",
        '  yield* values;',
        '  return 9;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  const firstValue = first.done ? 0 : first.value.charCodeAt(0) - 96;',
        '  const secondValue = second.done ? 0 : second.value.charCodeAt(0) - 96;',
        '  const thirdValue = third.done ? 0 : third.value.charCodeAt(0) - 96;',
        '  return (firstValue * 1000) + (secondValue * 100) + (thirdValue * 10)' +
        ' + (fourth.done ? fourth.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator local-string-array yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1359);
      },
    },
    {
      name: 'compileProject lowers async generator yield star over local Promise arrays',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const values = [Promise.resolve(1), Promise.resolve(3), Promise.resolve(5)];',
        '  yield* values;',
        '  return 9;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000)' +
        ' + ((second.done ? 0 : second.value) * 100)' +
        ' + ((third.done ? 0 : third.value) * 10)' +
        ' + (fourth.done ? fourth.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator local-Promise-array yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1359);
      },
    },
    {
      name: 'compileProject lowers async generator yield star over local boolean arrays',
      source: [
        'async function* iterate(): AsyncGenerator<boolean, number, unknown> {',
        '  const values = [true, false, true];',
        '  yield* values;',
        '  return 8;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  return ((first.done ? 0 : (first.value ? 1 : 0)) * 1000)' +
        ' + ((second.done ? 0 : (second.value ? 1 : 0)) * 100)' +
        ' + ((third.done ? 0 : (third.value ? 1 : 0)) * 10)' +
        ' + (fourth.done ? fourth.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator local-boolean-array yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1018);
      },
    },
    {
      name: 'compileProject lowers async generator yield star over local tagged arrays',
      source: [
        'async function* iterate(): AsyncGenerator<number | string, number, unknown> {',
        "  const values: Array<number | string> = [2, 'a', 4];",
        '  yield* values;',
        '  return 8;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        "  const firstValue = first.done ? 0 : (typeof first.value === 'number' ? first.value : 9);",
        "  const secondValue = second.done ? 0 : (typeof second.value === 'number' ? second.value : 9);",
        "  const thirdValue = third.done ? 0 : (typeof third.value === 'number' ? third.value : 9);",
        '  return (firstValue * 1000) + (secondValue * 100) + (thirdValue * 10)' +
        ' + (fourth.done ? fourth.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator local-tagged-array yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 2948);
      },
    },
    {
      name: 'compileProject lowers async generator yield star over Map entries iterables',
      source: [
        'async function* iterate(): AsyncGenerator<[string, number], number, unknown> {',
        '  yield* new Map([["a", 3], ["c", 5], ["e", 7]]).entries();',
        '  return 9;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  const firstValue = first.done ? 0 : ((first.value[0].charCodeAt(0) - 96) * 10) + first.value[1];',
        '  const secondValue = second.done ? 0 : ((second.value[0].charCodeAt(0) - 96) * 10) + second.value[1];',
        '  const thirdValue = third.done ? 0 : ((third.value[0].charCodeAt(0) - 96) * 10) + third.value[1];',
        '  return (firstValue * 10000) + (secondValue * 100) + thirdValue + (fourth.done ? 0 : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator Map.entries yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 133557);
      },
    },
    {
      name: 'compileProject lowers async generator yield star over Set entries iterables',
      source: [
        'async function* iterate(): AsyncGenerator<[number, number], number, unknown> {',
        '  yield* new Set([3, 6, 7]).entries();',
        '  return 9;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  const firstValue = first.done ? 0 : (first.value[0] * 10) + first.value[1];',
        '  const secondValue = second.done ? 0 : (second.value[0] * 10) + second.value[1];',
        '  const thirdValue = third.done ? 0 : (third.value[0] * 10) + third.value[1];',
        '  return (firstValue * 10000) + (secondValue * 100) + thirdValue + (fourth.done ? 0 : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator Set.entries yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 336677);
      },
    },
    {
      name: 'compileProject lowers async generator yield star over kept iterable families',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield* [3, 5];',
        '  return 7;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 1000 +',
        '    (second.done ? 9 : second.value) * 100 +',
        '    (third.done ? 9 : third.value) * 10 +',
        '    (fourth.done ? fourth.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1357);
      },
    },
    {
      name:
        'compileProject lowers async generator return delegation through async generators with finally cleanup',
      source: [
        'async function* inner(): AsyncGenerator<number, number, number> {',
        '  try {',
        '    yield 3;',
        '    yield 5;',
        '    return 7;',
        '  } finally {',
        '    yield 9;',
        '  }',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  return delegated + 1;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.return(4);',
        '  const third = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000)' +
        ' + ((second.done ? 0 : second.value) * 100)' +
        ' + ((third.done ? third.value : 0) * 10)' +
        ' + (third.done ? 1 : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator async-yield* return consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 3951);
      },
    },
    {
      name:
        'compileProject lowers async generator yield star resume delegation through async generators',
      source: [
        'async function* inner(): AsyncGenerator<number, number, number> {',
        '  const received = yield 10;',
        '  yield received + 1;',
        '  return received + 2;',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  yield delegated + 3;',
        '  return delegated + 4;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next(7);',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000000)' +
        ' + ((second.done ? 0 : second.value) * 10000)' +
        ' + ((third.done ? 0 : third.value) * 100)' +
        ' + (fourth.done ? fourth.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator async-yield* resume consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 10081213);
      },
    },
    {
      name: 'compileProject lowers async generator yield star through async generator delegates',
      source: [
        'async function* inner(): AsyncGenerator<number, number, number> {',
        '  try {',
        '    yield 3;',
        '    return 8;',
        '  } catch {',
        '    yield 7;',
        '    return 9;',
        '  }',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  yield delegated + 1;',
        '  return delegated + 2;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.throw(5);',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000000)' +
        ' + ((second.done ? 0 : second.value) * 10000)' +
        ' + ((third.done ? 0 : third.value) * 100)' +
        ' + ((fourth.done ? fourth.value : 0) * 10)' +
        ' + (fourth.done ? 1 : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator async-yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 3071111);
      },
    },
    {
      name: 'compileProject lowers async generator throw delegation through yield star',
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
        'async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  yield delegated + 1;',
        '  return delegated + 2;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.throw(5);',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000000)' +
        ' + ((second.done ? 0 : second.value) * 10000)' +
        ' + ((third.done ? 0 : third.value) * 100)' +
        ' + ((fourth.done ? fourth.value : 0) * 10)' +
        ' + (fourth.done ? 1 : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator yield* throw consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 3071111);
      },
    },
    {
      name:
        'compileProject rejects host Promises for async generator throw through array yield star',
      source: [
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  yield* [3, 5, 7];',
        '  return 9;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  await iterator.next();',
        '  await iterator.throw(5);',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator array yield* throw consumer to return a host Promise.',
          );
        }
        await result.then(
          () => {
            throw new Error('Expected async generator array yield* throw to reject.');
          },
          (reason) => {
            if ((typeof reason !== 'object' && typeof reason !== 'function') || reason === null) {
              throw new Error(
                'Expected async generator array yield* throw to reject with an object.',
              );
            }
            const errorLike = reason as Record<string, unknown>;
            assertEquals(errorLike.name, 'TypeError');
            assertEquals(errorLike.message, 'yield* delegate does not support throw');
          },
        );
      },
    },
    {
      name:
        'compileProject rejects host Promises for async generator throw through local Promise-array yield star',
      source: [
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  const values = [Promise.resolve(3), Promise.resolve(5), Promise.resolve(7)];',
        '  yield* values;',
        '  return 9;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  await iterator.next();',
        '  await iterator.throw(5);',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator local-Promise-array yield* throw consumer to return a host Promise.',
          );
        }
        await result.then(
          () => {
            throw new Error('Expected async generator local-Promise-array yield* throw to reject.');
          },
          (reason) => {
            if ((typeof reason !== 'object' && typeof reason !== 'function') || reason === null) {
              throw new Error(
                'Expected async generator local-Promise-array yield* throw to reject with an object.',
              );
            }
            const errorLike = reason as Record<string, unknown>;
            assertEquals(errorLike.name, 'TypeError');
            assertEquals(errorLike.message, 'yield* delegate does not support throw');
          },
        );
      },
    },
    {
      name: 'compileProject catches async generator throw through array yield star',
      source: [
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    yield* [3, 5, 7];',
        '  } catch (error: unknown) {',
        '    if (error instanceof TypeError) {',
        '      yield 8;',
        '      return 6;',
        '    }',
        '    return 1;',
        '  }',
        '  return 9;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.throw(5);',
        '  const third = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000)' +
        ' + ((second.done ? 0 : second.value) * 100)' +
        ' + ((third.done ? third.value : 0) * 10)' +
        ' + (third.done ? 1 : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator caught array yield* throw consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 3861);
      },
    },
    {
      name: 'compileProject catches async generator throw through local Promise-array yield star',
      source: [
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    const values = [Promise.resolve(3), Promise.resolve(5), Promise.resolve(7)];',
        '    yield* values;',
        '  } catch (error: unknown) {',
        '    if (error instanceof TypeError) {',
        '      yield 8;',
        '      return 6;',
        '    }',
        '    return 1;',
        '  }',
        '  return 9;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.throw(5);',
        '  const third = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000)' +
        ' + ((second.done ? 0 : second.value) * 100)' +
        ' + ((third.done ? third.value : 0) * 10)' +
        ' + (third.done ? 1 : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator caught local-Promise-array yield* throw consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 3861);
      },
    },
    {
      name: 'compileProject lowers async generator return calls as Promise iterator results',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield 2;',
        '  return 3;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const closed = await iterator.return(7);',
        '  return (first.done ? 9 : first.value) * 10 + (closed.done ? closed.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator return consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 17);
      },
    },
    {
      name: 'compileProject lowers async generator throw calls through catch bindings',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, number> {',
        '  try {',
        '    const received = yield 1;',
        '    return received + 4;',
        '  } catch (error) {',
        '    return typeof error === "number" ? error + 2 : 99;',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.throw(5);',
        '  return (first.done ? 9 : first.value) * 10 + (second.done ? second.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator throw consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 17);
      },
    },
    {
      name: 'compileProject rejects host Promises for uncaught async generator throw calls',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, number> {',
        '  yield 1;',
        '  return 3;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  await iterator.next();',
        '  await iterator.throw(5);',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected uncaught async generator throw consumer to return a host Promise.',
          );
        }
        await result.then(
          () => {
            throw new Error('Expected uncaught async generator throw to reject.');
          },
          (reason) => {
            assertEquals(reason, 5);
          },
        );
      },
    },
    {
      name:
        'compileProject rejects host Promises for uncaught async generator builtin Error throw calls',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  return 3;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  await iterator.next();',
        '  await iterator.throw(new Error("boom"));',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected uncaught async generator builtin Error throw consumer to return a host Promise.',
          );
        }
        await result.then(
          () => {
            throw new Error('Expected uncaught async generator builtin Error throw to reject.');
          },
          (reason) => {
            if ((typeof reason !== 'object' && typeof reason !== 'function') || reason === null) {
              throw new Error(
                'Expected uncaught async generator builtin Error throw to reject with an object.',
              );
            }
            const errorLike = reason as Record<string, unknown>;
            assertEquals(errorLike.name, 'Error');
            assertEquals(errorLike.message, 'boom');
          },
        );
      },
    },
    {
      name: 'compileProject lowers async generator class methods with super calls across await',
      source: [
        'class Base {',
        '  bump(value: number): number {',
        '    return value + 1;',
        '  }',
        '}',
        '',
        'class Box extends Base {',
        '  seed = 2;',
        '  async *iterate(): AsyncGenerator<number, number, unknown> {',
        '    const value = await Promise.resolve(super.bump(this.seed));',
        '    yield value;',
        '    return super.bump(this.seed + 3);',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = new Box().iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 10 + (second.done ? second.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported awaited async generator super-method consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 36);
      },
    },
    {
      name: 'compileProject lowers async generator class methods with this field reads',
      source: [
        'class Box {',
        '  seed = 4;',
        '  async *iterate(): AsyncGenerator<number, number, unknown> {',
        '    yield this.seed + 1;',
        '    return this.seed + 3;',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = new Box().iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 10 + (second.done ? second.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator class-method consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 57);
      },
    },
    {
      name: 'compileProject lowers async generator object literal methods with this field reads',
      source: [
        'export async function main(): Promise<number> {',
        '  const bag = {',
        '    seed: 2,',
        '    async *iterate(): AsyncGenerator<number, number, unknown> {',
        '      yield this.seed + 1;',
        '      return this.seed + 4;',
        '    },',
        '  };',
        '  const iterator = bag.iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 10 + (second.done ? second.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator object-literal method consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 36);
      },
    },
    {
      name:
        'compileProject lowers async generator static class methods with static this field reads',
      source: [
        'class Box {',
        '  static seed = 4;',
        '  static async *iterate(): AsyncGenerator<number, number, unknown> {',
        '    yield this.seed + 1;',
        '    return this.seed + 3;',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = Box.iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 10 + (second.done ? second.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator static method consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 57);
      },
    },
    {
      name: 'compileProject lowers async generator return through finally cleanup yields',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    yield 1;',
        '    return 2;',
        '  } finally {',
        '    yield 7;',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 100 +',
        '    (second.done ? 9 : second.value) * 10 +',
        '    (third.done ? third.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator finally consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 172);
      },
    },
    {
      name: 'compileProject lowers async generator external return through finally cleanup yields',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    yield 1;',
        '    yield 2;',
        '  } finally {',
        '    yield 7;',
        '  }',
        '  return 3;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.return(5);',
        '  const third = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 100 +',
        '    (second.done ? 9 : second.value) * 10 +',
        '    (third.done ? third.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator external return consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 175);
      },
    },
    {
      name: 'compileProject lowers async generator return through finally cleanup yield await',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    yield 1;',
        '    return 2;',
        '  } finally {',
        '    yield await Promise.resolve(7);',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 100 +',
        '    (second.done ? 9 : second.value) * 10 +',
        '    (third.done ? third.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator yield-await finally consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 172);
      },
    },
    {
      name: 'compileProject lowers async generator while loops with awaited mutable locals',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  let current = 0;',
        '  while (current < 2) {',
        '    current = await Promise.resolve(current + 1);',
        '    yield current + 1;',
        '  }',
        '  return current + 2;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 +',
        '    (second.done ? 0 : second.value) * 10 +',
        '    (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator while-loop consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 234);
      },
    },
    {
      name: 'compileProject lowers async generator for of over iterator locals with yield await',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  const values = new Set([1, 2]).values();',
        '  for (const value of values) {',
        '    yield await Promise.resolve(value + 1);',
        '  }',
        '  return 4;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 +',
        '    (second.done ? 0 : second.value) * 10 +',
        '    (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator for-of consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 234);
      },
    },
    {
      name:
        'compileProject lowers async generator yield star through awaited async generator delegates',
      source: [
        'async function* inner(): AsyncGenerator<number, number, unknown> {',
        '  yield await Promise.resolve(3);',
        '  return await Promise.resolve(5);',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  const delegated = yield* inner();',
        '  return delegated + 2;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 +',
        '    (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported awaited async-yield* consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 37);
      },
    },
    {
      name: 'compileProject lowers async generator throw through awaited async generator delegates',
      source: [
        'async function* inner(): AsyncGenerator<number, number, number> {',
        '  try {',
        '    yield await Promise.resolve(3);',
        '    return await Promise.resolve(8);',
        '  } catch {',
        '    yield await Promise.resolve(7);',
        '    return await Promise.resolve(9);',
        '  }',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  yield delegated + 1;',
        '  return delegated + 2;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.throw(5);',
        '  const third = await iterator.next();',
        '  const fourth = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000000)' +
        ' + ((second.done ? 0 : second.value) * 10000)' +
        ' + ((third.done ? 0 : third.value) * 100)' +
        ' + ((fourth.done ? fourth.value : 0) * 10)' +
        ' + (fourth.done ? 1 : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported awaited async-yield* throw consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 3071111);
      },
    },
    {
      name: 'compileProject lowers async generator class methods with this reads across await',
      source: [
        'class Box {',
        '  seed = 2;',
        '  async *iterate(): AsyncGenerator<number, number, unknown> {',
        '    const value = await Promise.resolve(this.seed + 1);',
        '    yield value;',
        '    return this.seed + 4;',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = new Box().iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 10 + (second.done ? second.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported awaited async generator class-method consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 36);
      },
    },
    {
      name:
        'compileProject lowers async generator object literal methods with this reads across await',
      source: [
        'export async function main(): Promise<number> {',
        '  const bag = {',
        '    seed: 2,',
        '    async *iterate(): AsyncGenerator<number, number, unknown> {',
        '      const value = await Promise.resolve(this.seed + 1);',
        '      yield value;',
        '      return this.seed + 4;',
        '    },',
        '  };',
        '  const iterator = bag.iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 10 + (second.done ? second.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported awaited async generator object-literal method consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 36);
      },
    },
    {
      name:
        'compileProject hoists local function declarations inside async generators across await',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  let total = 1;',
        '  function read(): number {',
        '    return total;',
        '  }',
        '  total = await Promise.resolve(total + 1);',
        '  yield read();',
        '  return read() + 1;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator hoist consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 23);
      },
    },
    {
      name:
        'compileProject hoists block-scoped local function declarations inside async generators across await',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  if (true) {',
        '    let total = 1;',
        '    function readTotal(offset: number): number {',
        '      return total + offset;',
        '    }',
        '    total = await Promise.resolve(total + 1);',
        '    yield readTotal(1);',
        '    return readTotal(2);',
        '  }',
        '  return 0;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator block hoist consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 34);
      },
    },
    {
      name:
        'compileProject lowers async generator external return through finally cleanup yield await',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    yield 1;',
        '    yield 2;',
        '  } finally {',
        '    yield await Promise.resolve(7);',
        '  }',
        '  return 3;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.return(5);',
        '  const third = await iterator.next();',
        '  return (first.done ? 9 : first.value) * 100 +',
        '    (second.done ? 9 : second.value) * 10 +',
        '    (third.done ? third.value : 9);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator external yield-await finally consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 175);
      },
    },
    {
      name:
        'compileProject lowers async generator return delegation through awaited async generators with finally cleanup',
      source: [
        'async function* inner(): AsyncGenerator<number, number, number> {',
        '  try {',
        '    yield await Promise.resolve(3);',
        '    yield await Promise.resolve(5);',
        '    return await Promise.resolve(7);',
        '  } finally {',
        '    yield await Promise.resolve(9);',
        '  }',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, number> {',
        '  const delegated = yield* inner();',
        '  return delegated + 1;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.return(4);',
        '  const third = await iterator.next();',
        '  return ((first.done ? 0 : first.value) * 1000)' +
        ' + ((second.done ? 0 : second.value) * 100)' +
        ' + ((third.done ? third.value : 0) * 10)' +
        ' + (third.done ? 1 : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported awaited async-yield* return consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 3951);
      },
    },
    {
      name: 'compileProject lowers async generator for let loops with awaited mutable locals',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for (let current = 0; current < 2; current += 1) {',
        '    total = await Promise.resolve(total + current + 1);',
        '    yield total;',
        '  }',
        '  return total + 1;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 +',
        '    (second.done ? 0 : second.value) * 10 +',
        '    (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator for-let consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 134);
      },
    },
    {
      name:
        'compileProject preserves outer locals across async generator for let loop await scoping',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  let current = 9;',
        '  for (let current = 0; current < 2; current += 1) {',
        '    yield await Promise.resolve(current + 1);',
        '  }',
        '  return current;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 +',
        '    (second.done ? 0 : second.value) * 10 +',
        '    (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator for-let scope consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 129);
      },
    },
    {
      name: 'compileProject lowers async generator Error catch bindings across await',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    throw new Error("boom");',
        '  } catch (error: unknown) {',
        '    if (error instanceof Error) {',
        '      const caught = error;',
        '      yield await Promise.resolve(caught.message.length + 1);',
        '      return caught.message.length + 2;',
        '    }',
        '    return 0;',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator Error-catch consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 56);
      },
    },
    {
      name: 'compileProject preserves async generator Error narrowing across await',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  try {',
        '    throw new Error("boom");',
        '  } catch (error: unknown) {',
        '    if (error instanceof Error) {',
        '      yield await Promise.resolve(error.message.length + 1);',
        '      return error.message.length + 2;',
        '    }',
        '    return 0;',
        '  }',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = iterate();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async generator narrowing consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 56);
      },
    },
    {
      name: 'compileProject lowers for await of over compiler-owned async generators',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 3;',
        '  yield 5;',
        '  return 7;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported for-await consumer to return a host Promise.');
        }
        assertEquals(await result, 35);
      },
    },
    {
      name: 'compileProject lowers for await of over local number arrays',
      source: [
        'export async function main(): Promise<number> {',
        '  const values = [3, 5, 7];',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported array for-await consumer to return a host Promise.');
        }
        assertEquals(await result, 357);
      },
    },
    {
      name: 'compileProject lowers for await of over local Promise arrays',
      source: [
        'export async function main(): Promise<number> {',
        '  const values = [Promise.resolve(3), Promise.resolve(5), Promise.resolve(7)];',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported Promise-array for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 357);
      },
    },
    {
      name: 'compileProject lowers for await of over sync generators',
      source: [
        'function* iterate(): Generator<number, number, unknown> {',
        '  yield 4;',
        '  yield 6;',
        '  return 8;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported sync-generator for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 46);
      },
    },
    {
      name: 'compileProject lowers for await of over sync generators yielding Promises',
      source: [
        'function* iterate(): Generator<Promise<number>, number, unknown> {',
        '  yield Promise.resolve(3);',
        '  yield Promise.resolve(5);',
        '  return 7;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported Promise-yielding sync-generator for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 35);
      },
    },
    {
      name: 'compileProject lowers for await of over sync generators yielding local Promise arrays',
      source: [
        'function* iterate(): Generator<Promise<number>, number, unknown> {',
        '  const values = [Promise.resolve(3), Promise.resolve(5)];',
        '  yield* values;',
        '  return 7;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported local-Promise-array sync-generator for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 35);
      },
    },
    {
      name: 'compileProject lowers for await of over iterator-valued locals',
      source: [
        'export async function main(): Promise<number> {',
        '  const values = new Map([["a", 3], ["b", 5], ["c", 7]]).values();',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported iterator-local for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 357);
      },
    },
    {
      name:
        'compileProject lowers for await of over Promise-yielding sync generator iterator locals',
      source: [
        'function* iterate(): Generator<Promise<number>, number, unknown> {',
        '  yield Promise.resolve(3);',
        '  yield Promise.resolve(5);',
        '  return 7;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const values = iterate();',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported Promise-yielding iterator-local for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 35);
      },
    },
    {
      name: 'compileProject lowers for await of over strings',
      source: [
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for await (const value of "ace") {',
        '    total = (total * 10) + (value.charCodeAt(0) - 96);',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported string for-await consumer to return a host Promise.');
        }
        assertEquals(await result, 135);
      },
    },
    {
      name: 'compileProject lowers for await of over async generator iterator locals',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 4;',
        '  yield 6;',
        '  return 8;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const values = iterate();',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported for-await iterator-local consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 46);
      },
    },
    {
      name: 'compileProject lowers for await break and continue through finally',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield 2;',
        '  yield 3;',
        '  return 4;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    try {',
        '      if (value === 1) {',
        '        total = 1;',
        '        continue;',
        '      }',
        '      if (value === 2) {',
        '        total = (total * 10) + value;',
        '        break;',
        '      }',
        '    } finally {',
        '      total = (total * 10) + 9;',
        '    }',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported for-await finally-control consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1929);
      },
    },
    {
      name: 'compileProject lowers awaited loop steps and return through finally in for await',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 2;',
        '  yield 4;',
        '  return 6;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    try {',
        '      total = (await Promise.resolve(total)) * 10 + value;',
        '      if (value === 4) {',
        '        return total;',
        '      }',
        '    } finally {',
        '      total = total + 100;',
        '    }',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error('Expected exported awaited for-await consumer to return a host Promise.');
        }
        assertEquals(await result, 1024);
      },
    },
    {
      name: 'compileProject lowers for await of inside async generators',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 2;',
        '  yield 4;',
        '  return 6;',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    yield await Promise.resolve(value + 1);',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 + (second.done ? 0 : second.value) * 10 + (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 374);
      },
    },
    {
      name: 'compileProject lowers for await of over local arrays inside async generators',
      source: [
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  const values = [2, 4];',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    yield value + 1;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 + (second.done ? 0 : second.value) * 10 + (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator array for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 374);
      },
    },
    {
      name: 'compileProject lowers for await of over local Promise arrays inside async generators',
      source: [
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  const values = [Promise.resolve(2), Promise.resolve(4)];',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    yield value + 1;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 + (second.done ? 0 : second.value) * 10 + (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator Promise-array for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 374);
      },
    },
    {
      name: 'compileProject lowers for await of over sync generators inside async generators',
      source: [
        'function* iterate(): Generator<number, number, unknown> {',
        '  yield 1;',
        '  yield 3;',
        '  return 5;',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    yield value + 10;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 + (second.done ? 0 : second.value) * 10 + (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator sync-generator for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1243);
      },
    },
    {
      name:
        'compileProject lowers for await of over Promise-yielding sync generators inside async generators',
      source: [
        'function* iterate(): Generator<Promise<number>, number, unknown> {',
        '  yield Promise.resolve(1);',
        '  yield Promise.resolve(3);',
        '  return 5;',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    yield value + 10;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 + (second.done ? 0 : second.value) * 10 + (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator Promise-yielding sync-generator for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1243);
      },
    },
    {
      name: 'compileProject lowers for await of iterator-valued locals inside async generators',
      source: [
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  const values = new Set([1, 3]).values();',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    yield value + 10;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 + (second.done ? 0 : second.value) * 10 + (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator iterator-local for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1243);
      },
    },
    {
      name: 'compileProject lowers for await of strings inside async generators',
      source: [
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for await (const value of "bd") {',
        '    const code = value.charCodeAt(0) - 96;',
        '    yield code + 10;',
        '    total = (total * 10) + code;',
        '  }',
        '  return total;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 + (second.done ? 0 : second.value) * 10 + (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator string for-await consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1364);
      },
    },
    {
      name: 'compileProject lowers for await of iterator locals inside async generators',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield 3;',
        '  return 5;',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  const values = iterate();',
        '  let total = 0;',
        '  for await (const value of values) {',
        '    yield value + 10;',
        '    total = (total * 10) + value;',
        '  }',
        '  return total;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  const third = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 100 + (second.done ? 0 : second.value) * 10 + (third.done ? third.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator iterator-local consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 1243);
      },
    },
    {
      name: 'compileProject lowers for await continue through finally inside async generators',
      source: [
        'async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  yield 1;',
        '  yield 2;',
        '  yield 3;',
        '  return 4;',
        '}',
        '',
        'async function* outer(): AsyncGenerator<number, number, unknown> {',
        '  let total = 0;',
        '  for await (const value of iterate()) {',
        '    try {',
        '      if (value === 1) {',
        '        total = 1;',
        '        continue;',
        '      }',
        '      yield value + 10;',
        '      if (value === 2) {',
        '        break;',
        '      }',
        '    } finally {',
        '      total = (total * 10) + 9;',
        '    }',
        '  }',
        '  return total;',
        '}',
        '',
        'export async function main(): Promise<number> {',
        '  const iterator = outer();',
        '  const first = await iterator.next();',
        '  const second = await iterator.next();',
        '  return (first.done ? 0 : first.value) * 10000 + (second.done ? second.value : 0);',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async-generator finally-control consumer to return a host Promise.',
          );
        }
        assertEquals(await result, 120199);
      },
    },
    {
      name:
        'compileProject executes new Promise executors synchronously and fulfills through resolve',
      expectedObserved: 122,
      reducer: 'weighted',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  new Promise<number>((resolve) => {',
        '    callback(1);',
        '    resolve(20);',
        '  }).then((value) => {',
        '    callback(value + 2);',
        '    return value + 3;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject rejects through new Promise reject callbacks',
      expectedObserved: 122,
      reducer: 'weighted',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  new Promise<number>((_, reject) => {',
        '    callback(1);',
        '    reject(20);',
        '  }).catch(() => {',
        '    callback(22);',
        '    return 23;',
        '  });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject executes Promise.finally callbacks and preserves fulfilled values',
      expectedObserved: 122,
      reducer: 'weighted',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.resolve(20)',
        '    .finally(() => {',
        '      callback(1);',
        '    })',
        '    .then((value) => {',
        '      callback(value + 2);',
        '      return value + 3;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject executes Promise.finally callbacks and preserves rejected reasons',
      expectedObserved: 122,
      reducer: 'weighted',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  Promise.reject(20)',
        '    .finally(() => {',
        '      callback(1);',
        '    })',
        '    .catch(() => {',
        '      callback(22);',
        '      return 0;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject treats undefined Promise.finally callbacks as passthrough handlers',
      expectedObserved: 22,
      reducer: 'last',
      source: [
        'export function main(callback: (value: number) => number): number {',
        '  const cleanup = undefined;',
        '  Promise.resolve(20)',
        '    .finally(cleanup)',
        '    .then((value) => {',
        '      callback(value + 2);',
        '      return value + 3;',
        '    });',
        '  return 0;',
        '}',
        '',
      ].join('\n'),
    },
    {
      name: 'compileProject lowers async switch statements on the frame path',
      source: [
        'export async function main(flag: number): Promise<number> {',
        '  let total = 1;',
        '  switch (flag) {',
        '    case 1:',
        '      total = await Promise.resolve(total + 10);',
        '      break;',
        '    case 2:',
        '      total = await Promise.resolve(total + 20);',
        '    default:',
        '      total = total + 3;',
        '      break;',
        '  }',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async switch function.');
        }
        const one = exported(1);
        const two = exported(2);
        const three = exported(3);
        if (!(one instanceof Promise) || !(two instanceof Promise) || !(three instanceof Promise)) {
          throw new Error('Expected exported async switch function to return host Promises.');
        }
        assertEquals(await one, 110);
        assertEquals(await two, 240);
        assertEquals(await three, 40);
      },
    },
    {
      name: 'compileProject lowers async string switch statements on the frame path',
      source: [
        'export async function main(flag: string): Promise<number> {',
        '  let total = 1;',
        '  switch (flag) {',
        '    case "one":',
        '      total = await Promise.resolve(total + 10);',
        '      break;',
        '    case "two":',
        '      total = await Promise.resolve(total + 20);',
        '    default:',
        '      total = total + 3;',
        '      break;',
        '  }',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async string switch function.');
        }
        const one = exported('one');
        const two = exported('two');
        const three = exported('other');
        if (!(one instanceof Promise) || !(two instanceof Promise) || !(three instanceof Promise)) {
          throw new Error(
            'Expected exported async string switch function to return host Promises.',
          );
        }
        assertEquals(await one, 110);
        assertEquals(await two, 240);
        assertEquals(await three, 40);
      },
    },
    {
      name: 'compileProject lowers async switch statements with await subexpression assignments',
      source: [
        'export async function main(flag: number): Promise<number> {',
        '  let total = 1;',
        '  switch (flag) {',
        '    case 1:',
        '      total = total + await Promise.resolve(10);',
        '      break;',
        '    case 2:',
        '      total = total + await Promise.resolve(20);',
        '    default:',
        '      total = total + 3;',
        '      break;',
        '  }',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async switch subexpression function.');
        }
        const one = exported(1);
        const two = exported(2);
        const three = exported(3);
        if (!(one instanceof Promise) || !(two instanceof Promise) || !(three instanceof Promise)) {
          throw new Error(
            'Expected exported async switch subexpression function to return host Promises.',
          );
        }
        assertEquals(await one, 110);
        assertEquals(await two, 240);
        assertEquals(await three, 40);
      },
    },
    {
      name:
        'compileProject lowers async string switch statements with await subexpression assignments',
      source: [
        'export async function main(flag: string): Promise<number> {',
        '  let total = 1;',
        '  switch (flag) {',
        '    case "one":',
        '      total = total + await Promise.resolve(10);',
        '      break;',
        '    case "two":',
        '      total = total + await Promise.resolve(20);',
        '    default:',
        '      total = total + 3;',
        '      break;',
        '  }',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async string switch subexpression function.');
        }
        const one = exported('one');
        const two = exported('two');
        const three = exported('other');
        if (!(one instanceof Promise) || !(two instanceof Promise) || !(three instanceof Promise)) {
          throw new Error(
            'Expected exported async string switch subexpression function to return host Promises.',
          );
        }
        assertEquals(await one, 110);
        assertEquals(await two, 240);
        assertEquals(await three, 40);
      },
    },
    {
      name: 'compileProject lowers async generator switch statements with awaited yields',
      source: [
        'export async function* iterate(flag: number): AsyncGenerator<number, number, unknown> {',
        '  let total = 1;',
        '  switch (flag) {',
        '    case 1:',
        '      yield 10 + await Promise.resolve(total);',
        '      break;',
        '    case 2:',
        '      yield 20 + await Promise.resolve(total);',
        '    default:',
        '      total = total + 3;',
        '      yield total;',
        '      break;',
        '  }',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      exportName: 'iterate',
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async generator switch function.');
        }
        const oneIterator = exported(1);
        const twoIterator = exported(2);
        const threeIterator = exported(3);
        const oneFirst = await oneIterator.next();
        const oneSecond = await oneIterator.next();
        const twoFirst = await twoIterator.next();
        const twoSecond = await twoIterator.next();
        const twoThird = await twoIterator.next();
        const threeFirst = await threeIterator.next();
        const threeSecond = await threeIterator.next();
        assertEquals(oneFirst, { value: 11, done: false });
        assertEquals(oneSecond, { value: 10, done: true });
        assertEquals(twoFirst, { value: 21, done: false });
        assertEquals(twoSecond, { value: 4, done: false });
        assertEquals(twoThird, { value: 40, done: true });
        assertEquals(threeFirst, { value: 4, done: false });
        assertEquals(threeSecond, { value: 40, done: true });
      },
    },
    {
      name: 'compileProject lowers async generator string switch statements with awaited yields',
      source: [
        'export async function* iterate(flag: string): AsyncGenerator<number, number, unknown> {',
        '  let total = 1;',
        '  switch (flag) {',
        '    case "one":',
        '      yield 10 + await Promise.resolve(total);',
        '      break;',
        '    case "two":',
        '      yield 20 + await Promise.resolve(total);',
        '    default:',
        '      total = total + 3;',
        '      yield total;',
        '      break;',
        '  }',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      exportName: 'iterate',
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async generator string switch function.');
        }
        const oneIterator = exported('one');
        const twoIterator = exported('two');
        const threeIterator = exported('other');
        const oneFirst = await oneIterator.next();
        const oneSecond = await oneIterator.next();
        const twoFirst = await twoIterator.next();
        const twoSecond = await twoIterator.next();
        const twoThird = await twoIterator.next();
        const threeFirst = await threeIterator.next();
        const threeSecond = await threeIterator.next();
        assertEquals(oneFirst, { value: 11, done: false });
        assertEquals(oneSecond, { value: 10, done: true });
        assertEquals(twoFirst, { value: 21, done: false });
        assertEquals(twoSecond, { value: 4, done: false });
        assertEquals(twoThird, { value: 40, done: true });
        assertEquals(threeFirst, { value: 4, done: false });
        assertEquals(threeSecond, { value: 40, done: true });
      },
    },
    {
      name:
        'compileProject lowers async generator switch statements with await subexpression assignments',
      source: [
        'export async function* iterate(flag: number): AsyncGenerator<number, number, unknown> {',
        '  let total = 1;',
        '  switch (flag) {',
        '    case 1:',
        '      total = total + await Promise.resolve(10);',
        '      yield total;',
        '      break;',
        '    case 2:',
        '      total = total + await Promise.resolve(20);',
        '    default:',
        '      total = total + 3;',
        '      yield total;',
        '      break;',
        '  }',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      exportName: 'iterate',
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async generator switch subexpression function.');
        }
        const oneIterator = exported(1);
        const twoIterator = exported(2);
        const threeIterator = exported(3);
        const oneFirst = await oneIterator.next();
        const oneSecond = await oneIterator.next();
        const twoFirst = await twoIterator.next();
        const twoSecond = await twoIterator.next();
        const threeFirst = await threeIterator.next();
        const threeSecond = await threeIterator.next();
        assertEquals(oneFirst, { value: 11, done: false });
        assertEquals(oneSecond, { value: 110, done: true });
        assertEquals(twoFirst, { value: 24, done: false });
        assertEquals(twoSecond, { value: 240, done: true });
        assertEquals(threeFirst, { value: 4, done: false });
        assertEquals(threeSecond, { value: 40, done: true });
      },
    },
    {
      name:
        'compileProject lowers async generator string switch statements with await subexpression assignments',
      source: [
        'export async function* iterate(flag: string): AsyncGenerator<number, number, unknown> {',
        '  let total = 1;',
        '  switch (flag) {',
        '    case "one":',
        '      total = total + await Promise.resolve(10);',
        '      yield total;',
        '      break;',
        '    case "two":',
        '      total = total + await Promise.resolve(20);',
        '    default:',
        '      total = total + 3;',
        '      yield total;',
        '      break;',
        '  }',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      exportName: 'iterate',
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error(
            'Expected exported async generator string switch subexpression function.',
          );
        }
        const oneIterator = exported('one');
        const twoIterator = exported('two');
        const threeIterator = exported('other');
        const oneFirst = await oneIterator.next();
        const oneSecond = await oneIterator.next();
        const twoFirst = await twoIterator.next();
        const twoSecond = await twoIterator.next();
        const threeFirst = await threeIterator.next();
        const threeSecond = await threeIterator.next();
        assertEquals(oneFirst, { value: 11, done: false });
        assertEquals(oneSecond, { value: 110, done: true });
        assertEquals(twoFirst, { value: 24, done: false });
        assertEquals(twoSecond, { value: 240, done: true });
        assertEquals(threeFirst, { value: 4, done: false });
        assertEquals(threeSecond, { value: 40, done: true });
      },
    },
    {
      name: 'compileProject preserves async switch break inside try finally loops',
      source: [
        'export async function main(): Promise<number> {',
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
        '      total = total + await Promise.resolve(10);',
        '    } finally {',
        '      count = count + 1;',
        '      total = total + 100;',
        '    }',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async protected switch function.');
        }
        const result = exported();
        if (!(result instanceof Promise)) {
          throw new Error(
            'Expected exported async protected switch function to return a host Promise.',
          );
        }
        assertEquals(await result, 223);
      },
    },
    {
      name: 'compileProject preserves async generator switch break inside try finally loops',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
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
        '      total = total + await Promise.resolve(10);',
        '    } finally {',
        '      count = count + 1;',
        '      total = total + 100;',
        '    }',
        '  }',
        '  return total;',
        '}',
        '',
      ].join('\n'),
      exportName: 'iterate',
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async generator protected switch function.');
        }
        const iterator = exported();
        const first = await iterator.next();
        const second = await iterator.next();
        const third = await iterator.next();
        assertEquals(first, { value: 1, done: false });
        assertEquals(second, { value: 113, done: false });
        assertEquals(third, { value: 223, done: true });
      },
    },
    {
      name: 'compileProject lowers async generator assignment await subexpressions',
      source: [
        'export async function* iterate(): AsyncGenerator<number, number, unknown> {',
        '  let total = 1;',
        '  total = total + await Promise.resolve(10);',
        '  yield total;',
        '  return total * 10;',
        '}',
        '',
      ].join('\n'),
      exportName: 'iterate',
      run: async (exported) => {
        if (typeof exported !== 'function') {
          throw new Error('Expected exported async-generator assignment-subexpression function.');
        }
        const iterator = exported();
        const first = await iterator.next();
        const second = await iterator.next();
        assertEquals(first, { value: 11, done: false });
        assertEquals(second, { value: 110, done: true });
      },
    },
  ];
  if (Deno.env.get('SOUNDSCRIPT_PROMISE_LIST_CASES') === '1') {
    console.log(JSON.stringify(cases.map((testCase) => testCase.name)));
    return;
  }

  for (const testCase of cases) {
    if (caseFilters && !caseFilters.has(testCase.name)) {
      continue;
    }
    if (caseFilter && !testCase.name.includes(caseFilter)) {
      continue;
    }
    await runPromiseCompilerCase(testCase);
  }
}

await main();
