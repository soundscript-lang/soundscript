import { assertEquals, assertStrictEquals } from '@std/assert';
import { join } from '@std/path';

import { compileProject } from './compile_project.ts';
import {
  createIsolatedTestRegistrar,
  createTempProject,
  instantiateCompiledModuleInJs,
  resolveQualifiedExportName,
} from '../../tests/support/compiler_test_helpers.ts';

const compilerClosureTest = createIsolatedTestRegistrar(import.meta.url);

async function createClosureProject(source: string): Promise<string> {
  return await createTempProject([
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
      path: 'src/index.ts',
      contents: source,
    },
  ]);
}

compilerClosureTest(
  'compileProject executes direct local closure calls with captured params',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(value: number): number {',
      '  const next = (delta: number): number => value + delta;',
      '  return next(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject executes closure literals with object binding params and defaults',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(values: Record<string, number | undefined>): number {',
      '  const sum = ({ left: first = 0, right: second = 0 }: Record<string, number | undefined>): number => {',
      '    return first + second;',
      '  };',
      '  return sum(values);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ left: 6, right: 1 }), 7);
    assertEquals(exported({ left: 6 }), 6);
  },
);

compilerClosureTest(
  'compileProject executes returned closures with mutable captured locals',
  async () => {
    const tempDirectory = await createClosureProject([
      'function makeCounter(start: number): () => number {',
      '  let value = start;',
      '  return (): number => {',
      '    value = value + 1;',
      '    return value;',
      '  };',
      '}',
      '',
      'export function main(start: number): number {',
      '  const counter = makeCounter(start);',
      '  counter();',
      '  return counter();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(10), 12);
  },
);

compilerClosureTest(
  'compileProject executes nested returned closures with captured outer params',
  async () => {
    const tempDirectory = await createClosureProject([
      'function makeOuter(value: number): () => () => number {',
      '  return (): (() => number) => () => value + 1;',
      '}',
      '',
      'export function main(value: number): number {',
      '  const inner = makeOuter(value)();',
      '  return inner();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(4), 5);
  },
);

compilerClosureTest('compileProject passes closures through internal helper params', async () => {
  const tempDirectory = await createClosureProject([
    'function invokeTwice(next: () => number): number {',
    '  next();',
    '  return next();',
    '}',
    '',
    'export function main(start: number): number {',
    '  let value = start;',
    '  const counter = (): number => {',
    '    value = value + 1;',
    '    return value;',
    '  };',
    '  return invokeTwice(counter);',
    '}',
    '',
  ].join('\n'));

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}".`);
  }
  assertEquals(exported(3), 5);
});

compilerClosureTest('compileProject lets closures capture sibling closure values', async () => {
  const tempDirectory = await createClosureProject([
    'export function main(value: number): number {',
    '  const add = (delta: number): number => value + delta;',
    '  const invoke = (): number => add(2);',
    '  return invoke();',
    '}',
    '',
  ].join('\n'));

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}".`);
  }
  assertEquals(exported(5), 7);
});

compilerClosureTest(
  'compileProject lets closures capture closure params through helper calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'function applyTwice(fn: (value: number) => number, value: number): number {',
      '  return fn(fn(value));',
      '}',
      '',
      'export function main(value: number): number {',
      '  const add = (current: number): number => current + 1;',
      '  const run = (): number => applyTwice(add, value);',
      '  return run();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported closure params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(value: number, next: (current: number) => number): number {',
      '  return next(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let observed = 0;
    assertEquals(
      exported(5, (current: number): number => {
        observed += current;
        return current + 2;
      }),
      7,
    );
    assertEquals(observed, 5);
  },
);

compilerClosureTest(
  'compileProject adapts exported closure results through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function makeCounter(start: number): () => number {',
      '  let value = start;',
      '  return (): number => {',
      '    value = value + 1;',
      '    return value;',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeCounter');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const counter = exported(10);
    if (typeof counter !== 'function') {
      throw new Error('Expected exported closure result to adapt to a JS function.');
    }
    assertEquals(counter(), 11);
    assertEquals(counter(), 12);
  },
);

compilerClosureTest(
  'compileProject adapts exported closure results with object binding params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function makeSum(): (values: Record<string, number | undefined>) => number {',
      '  return ({ left: first = 0, right: second = 0 }: Record<string, number | undefined>): number => {',
      '    return first + second;',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeSum');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const sum = exported();
    if (typeof sum !== 'function') {
      throw new Error('Expected exported closure result to adapt to a JS function.');
    }
    assertEquals(sum({ left: 6, right: 7 }), 13);
    assertEquals(sum({ left: 6 }), 6);
    assertEquals(sum({}), 0);
  },
);

compilerClosureTest(
  'compileProject executes closure literals with array binding params and defaults',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(values: number[]): number {',
      '  const sum = ([first = 0, second = 0]: number[]): number => {',
      '    return first + second;',
      '  };',
      '  return sum(values);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported([4, 5]), 9);
    assertEquals(exported([4]), 4);
    assertEquals(exported([]), 0);
  },
);

compilerClosureTest(
  'compileProject executes closure literals with array binding rest params',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(values: number[]): number {',
      '  const summarize = ([first = 0, ...rest]: number[]): number => {',
      '    const readRestLength = (): number => rest.length;',
      '    return first * 10 + readRestLength();',
      '  };',
      '  return summarize(values);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
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

compilerClosureTest(
  'compileProject adapts exported closure results with array binding params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function makeSum(): (values: number[]) => number {',
      '  return ([first = 0, second = 0]: number[]): number => {',
      '    return first + second;',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeSum');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const sum = exported();
    if (typeof sum !== 'function') {
      throw new Error('Expected exported closure result to adapt to a JS function.');
    }
    assertEquals(sum([6, 7]), 13);
    assertEquals(sum([6]), 6);
    assertEquals(sum([]), 0);
  },
);

compilerClosureTest(
  'compileProject adapts exported closure results with array binding rest params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function makeSummarize(): (values: number[]) => number {',
      '  return ([first = 0, ...rest]: number[]): number => {',
      '    const readRestLength = (): number => rest.length;',
      '    return first * 10 + readRestLength();',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeSummarize');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const summarize = exported();
    if (typeof summarize !== 'function') {
      throw new Error('Expected exported closure result to adapt to a JS function.');
    }
    assertEquals(summarize([6, 7, 8]), 62);
    assertEquals(summarize([6]), 60);
    assertEquals(summarize([]), 0);
  },
);

compilerClosureTest(
  'compileProject adapts exported optional closure params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(next: (value?: number) => number): number {',
      '  return next(1);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported((value?: number): number => value === undefined ? 10 : value + 1), 2);
  },
);

compilerClosureTest(
  'compileProject adapts exported optional closure results through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(base: number): (value?: number) => number {',
      '  return (value?: number): number => {',
      '    if (value === undefined) {',
      '      return base;',
      '    }',
      '    return base + value;',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const next = exported(7);
    if (typeof next !== 'function') {
      throw new Error('Expected exported closure result to adapt to a JS function.');
    }
    assertEquals(next(), 7);
    assertEquals(next(2), 9);
  },
);

compilerClosureTest(
  'compileProject adapts exported tagged closure params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(next: (value: number | undefined) => number): number {',
      '  return next(undefined) + next(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(
      exported((value: number | undefined): number => value === undefined ? 10 : value + 1),
      13,
    );
  },
);

compilerClosureTest(
  'compileProject adapts exported tagged closure results through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function makeTrim(flag: boolean): () => string | null {',
      '  return (): string | null => {',
      '    if (flag) {',
      '      return null;',
      '    }',
      '    return " hi ".trim();',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeTrim');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const whenFalse = exported(false);
    const whenTrue = exported(true);
    if (typeof whenFalse !== 'function' || typeof whenTrue !== 'function') {
      throw new Error('Expected exported tagged closure results to adapt to JS functions.');
    }
    assertEquals(whenFalse(), 'hi');
    assertEquals(whenTrue(), null);
  },
);

compilerClosureTest(
  'compileProject adapts exported heap-object closure params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  value = 0;',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(next: (box: Box) => number): number {',
      '  return next(new Box(5));',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let observed = 0;
    assertEquals(
      exported((box: { value: number; get(): number }): number => {
        observed = box.get();
        return box.get() + 2;
      }),
      7,
    );
    assertEquals(observed, 5);
  },
);

compilerClosureTest(
  'compileProject adapts exported heap-object closure results through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  value = 0;',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(next: () => Box): number {',
      '  return next().get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported((): { value: number } => ({ value: 6 })), 6);
  },
);

compilerClosureTest(
  'compileProject adapts exported heap-inclusive closure params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  value = 0;',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(next: (value: Box | number) => number): number {',
      '  return next(new Box(5)) + next(7);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(
      exported((value: { get(): number } | number): number =>
        typeof value === 'number' ? value : value.get()
      ),
      12,
    );
  },
);

compilerClosureTest(
  'compileProject adapts exported heap-inclusive closure results through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  value = 0;',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function make(): (flag: number) => Box | number {',
      '  return (flag: number): Box | number => {',
      '    if (flag === 0) {',
      '      return new Box(6);',
      '    }',
      '    return flag + 8;',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'make');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const callback = exported();
    if (typeof callback !== 'function') {
      throw new Error('Expected exported closure result to adapt to a JS function.');
    }
    const box = callback(0) as { get(): number };
    assertEquals(box.get(), 6);
    assertEquals(callback(4), 12);
  },
);

compilerClosureTest(
  'compileProject adapts exported heap-array closure params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  value = 0;',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(next: (boxes: Box[]) => number): number {',
      '  const shared = new Box(5);',
      '  return next([shared, shared]);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    let sameIdentity = false;
    assertEquals(
      exported((boxes: Array<{ value: number; get(): number }>): number => {
        sameIdentity = boxes[0] === boxes[1];
        return boxes[0]!.get() + boxes[1]!.get();
      }),
      10,
    );
    assertEquals(sameIdentity, true);
  },
);

compilerClosureTest(
  'compileProject adapts exported heap-array closure results through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  value = 0;',
      '  constructor(value: number) {',
      '    this.value = value;',
      '  }',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'export function main(next: () => Box[]): number {',
      '  return next().reduce((sum, box) => sum + box.get(), 0);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported((): Array<{ value: number }> => [{ value: 4 }, { value: 6 }]), 10);
  },
);

compilerClosureTest(
  'compileProject adapts exported closure params with class constructor args through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '}',
      '',
      'export function invoke(',
      '  value: number,',
      '  next: (C: typeof Box, current: number) => number,',
      '): number {',
      '  return next(Box, value);',
      '}',
      '',
      'export function makeBox(offset: number): Box {',
      '  return new Box(offset);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const invokeExportName = await resolveQualifiedExportName(tempDirectory, 'invoke');
    const invokeExport = instance.exports[invokeExportName];
    if (typeof invokeExport !== 'function') {
      throw new Error(`Expected exported function "${invokeExportName}".`);
    }
    const makeBoxExportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const makeBoxExport = instance.exports[makeBoxExportName];
    if (typeof makeBoxExport !== 'function') {
      throw new Error(`Expected exported function "${makeBoxExportName}".`);
    }

    const ctor = (makeBoxExport(1) as { constructor: Function }).constructor;
    assertEquals(
      invokeExport(2, (C: Function, current: number): number => {
        assertStrictEquals(C, ctor);
        return current + 1;
      }),
      3,
    );
  },
);

compilerClosureTest(
  'compileProject adapts exported closure results with class constructor args through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function makeUse(): (C: typeof Box, value: number) => number {',
      '  return (C: typeof Box, value: number): number => C.run(value) + new C(5).apply(value);',
      '}',
      '',
      'export function makeBox(offset: number): Box {',
      '  return new Box(offset);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const makeUseExportName = await resolveQualifiedExportName(tempDirectory, 'makeUse');
    const makeUseExport = instance.exports[makeUseExportName];
    if (typeof makeUseExport !== 'function') {
      throw new Error(`Expected exported function "${makeUseExportName}".`);
    }
    const makeBoxExportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const makeBoxExport = instance.exports[makeBoxExportName];
    if (typeof makeBoxExport !== 'function') {
      throw new Error(`Expected exported function "${makeBoxExportName}".`);
    }

    const use = makeUseExport() as (C: Function, value: number) => number;
    const ctor = (makeBoxExport(1) as { constructor: Function }).constructor;
    assertEquals(use(ctor, 2), 14);
  },
);

compilerClosureTest(
  'compileProject adapts exported closure params with class constructor results through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function choose(next: () => typeof Box, value: number): number {',
      '  const C = next();',
      '  return C.run(value) + new C(5).apply(value);',
      '}',
      '',
      'export function makeBox(offset: number): Box {',
      '  return new Box(offset);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseExportName = await resolveQualifiedExportName(tempDirectory, 'choose');
    const chooseExport = instance.exports[chooseExportName];
    if (typeof chooseExport !== 'function') {
      throw new Error(`Expected exported function "${chooseExportName}".`);
    }
    const makeBoxExportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const makeBoxExport = instance.exports[makeBoxExportName];
    if (typeof makeBoxExport !== 'function') {
      throw new Error(`Expected exported function "${makeBoxExportName}".`);
    }

    const ctor = (makeBoxExport(1) as { constructor: Function }).constructor;
    assertEquals(chooseExport((): Function => ctor, 2), 14);
  },
);

compilerClosureTest(
  'compileProject adapts exported closure results with class constructor results through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '}',
      '',
      'export function makeChoose(): () => typeof Box {',
      '  return (): typeof Box => Box;',
      '}',
      '',
      'export function makeBox(offset: number): Box {',
      '  return new Box(offset);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const makeChooseExportName = await resolveQualifiedExportName(tempDirectory, 'makeChoose');
    const makeChooseExport = instance.exports[makeChooseExportName];
    if (typeof makeChooseExport !== 'function') {
      throw new Error(`Expected exported function "${makeChooseExportName}".`);
    }
    const makeBoxExportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const makeBoxExport = instance.exports[makeBoxExportName];
    if (typeof makeBoxExport !== 'function') {
      throw new Error(`Expected exported function "${makeBoxExportName}".`);
    }

    const choose = makeChooseExport() as () => Function;
    const ctor = (makeBoxExport(1) as { constructor: Function }).constructor;
    assertStrictEquals(choose(), ctor);
  },
);

compilerClosureTest(
  'compileProject lets returned closures capture closure-valued params',
  async () => {
    const tempDirectory = await createClosureProject([
      'function wrap(fn: (value: number) => number): () => number {',
      '  return (): number => fn(2);',
      '}',
      '',
      'export function main(value: number): number {',
      '  const add = (delta: number): number => value + delta;',
      '  return wrap(add)();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject executes local function declarations after their declaration',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(value: number): number {',
      '  function add(delta: number): number {',
      '    return value + delta;',
      '  }',
      '  return add(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject lets closures capture local function declarations',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(value: number): number {',
      '  function add(delta: number): number {',
      '    return value + delta;',
      '  }',
      '  const invoke = (): number => add(2);',
      '  return invoke();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest('compileProject lets closures capture mutable object locals', async () => {
  const tempDirectory = await createClosureProject([
    'export function main(start: number): number {',
    '  let state = { value: start };',
    '  const read = (): number => state.value;',
    '  return read();',
    '}',
    '',
  ].join('\n'));

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}".`);
  }
  assertEquals(exported(5), 5);
});

compilerClosureTest('compileProject lets closures observe reassigned object locals', async () => {
  const tempDirectory = await createClosureProject([
    'export function main(start: number): number {',
    '  let state = { value: start };',
    '  const read = (): number => state.value;',
    '  state = { value: 7 };',
    '  return read();',
    '}',
    '',
  ].join('\n'));

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}".`);
  }
  assertEquals(exported(5), 7);
});

compilerClosureTest(
  'compileProject executes closure-valued object property calls with mutable captures',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(start: number): number {',
      '  let offset = start;',
      '  const box = {',
      '    run: (value: number): number => {',
      '      offset = offset + 1;',
      '      return value + offset;',
      '    },',
      '  };',
      '  return box.run(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(3), 6);
  },
);

compilerClosureTest(
  'compileProject executes closure-valued bag-like property calls with mutable captures',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = {',
      '  [key: string]: number | ((value: number) => number);',
      '  offset: number;',
      '  run: (value: number) => number;',
      '};',
      '',
      'export function main(start: number): number {',
      '  let offset = start;',
      '  const bag: Bag = {',
      '    offset: start,',
      '    run: (value: number): number => {',
      '      offset = offset + 1;',
      '      return value + offset;',
      '    },',
      '  };',
      '  return bag.run(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(3), 6);
  },
);

compilerClosureTest(
  'compileProject lets extracted object closure properties stay callable',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(start: number): number {',
      '  let offset = start;',
      '  const box = {',
      '    run: (value: number): number => {',
      '      offset = offset + 1;',
      '      return value + offset;',
      '    },',
      '  };',
      '  const run = box.run;',
      '  return run(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(1), 4);
  },
);

compilerClosureTest(
  'compileProject passes closure-valued bag-like properties through internal helper params',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = {',
      '  [key: string]: number | ((value: number) => number);',
      '  offset: number;',
      '  run: (value: number) => number;',
      '};',
      '',
      'function invoke(bag: Bag): number {',
      '  const run = bag.run;',
      '  return run(2);',
      '}',
      '',
      'export function main(start: number): number {',
      '  let offset = start;',
      '  const bag: Bag = {',
      '    offset: start,',
      '    run: (value: number): number => {',
      '      offset = offset + 1;',
      '      return value + offset;',
      '    },',
      '  };',
      '  return invoke(bag);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(3), 6);
  },
);

compilerClosureTest(
  'compileProject passes closure-valued object properties through internal helper params',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { run: (value: number) => number };',
      '',
      'function invoke(box: Box): number {',
      '  return box.run(2);',
      '}',
      '',
      'export function main(start: number): number {',
      '  let offset = start;',
      '  const box: Box = {',
      '    run: (value: number): number => {',
      '      offset = offset + 1;',
      '      return value + offset;',
      '    },',
      '  };',
      '  return invoke(box);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(3), 6);
  },
);

compilerClosureTest(
  'compileProject returns closure-valued bag-like properties from internal helpers',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = {',
      '  [key: string]: number | ((value: number) => number);',
      '  offset: number;',
      '  run: (value: number) => number;',
      '};',
      '',
      'function makeBag(start: number): Bag {',
      '  let offset = start;',
      '  return {',
      '    offset: start,',
      '    run: (value: number): number => {',
      '      offset = offset + 1;',
      '      return value + offset;',
      '    },',
      '  };',
      '}',
      '',
      'export function main(start: number): number {',
      '  const bag = makeBag(start);',
      '  return bag.run(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(3), 6);
  },
);

compilerClosureTest(
  'compileProject executes bag-like object-literal methods with this',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = {',
      '  [key: string]: number | ((value: number) => number);',
      '  offset: number;',
      '  run(value: number): number;',
      '};',
      '',
      'export function main(start: number): number {',
      '  const bag: Bag = {',
      '    offset: start,',
      '    run(value: number): number {',
      '      return value + this.offset;',
      '    },',
      '  };',
      '  return bag.run(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject passes bag-like object-literal methods with this through internal helpers',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = {',
      '  [key: string]: number | ((value: number) => number);',
      '  offset: number;',
      '  run(value: number): number;',
      '};',
      '',
      'function invoke(bag: Bag): number {',
      '  return bag.run(2);',
      '}',
      '',
      'export function main(start: number): number {',
      '  const bag: Bag = {',
      '    offset: start,',
      '    run(value: number): number {',
      '      return value + this.offset;',
      '    },',
      '  };',
      '  return invoke(bag);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported bag-like objects with closure-valued properties through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = {',
      '  [key: string]: number | ((value: number) => number);',
      '  offset: number;',
      '  run: (value: number) => number;',
      '};',
      '',
      'export function main(start: number): Bag {',
      '  return {',
      '    offset: start,',
      '    run: (value: number): number => value + start,',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const bag = exported(5) as { offset: number; run: (value: number) => number };
    assertEquals(bag.offset, 5);
    assertEquals(bag.run(2), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported bag-like objects with closure-valued params through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = {',
      '  [key: string]: number | ((value: number) => number);',
      '  offset: number;',
      '  run: (value: number) => number;',
      '};',
      '',
      'export function main(bag: Bag, value: number): number {',
      '  return bag.run(value) + bag.offset;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ offset: 5, run: (value: number) => value * 2 }, 4), 13);
  },
);

compilerClosureTest(
  'compileProject adapts exported bag-like object-literal methods with this through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = {',
      '  [key: string]: number | ((value: number) => number);',
      '  offset: number;',
      '  run(value: number): number;',
      '};',
      '',
      'export function main(start: number): Bag {',
      '  return {',
      '    offset: start,',
      '    run(value: number): number {',
      '      return value + this.offset;',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const bag = exported(5) as { offset: number; run: (value: number) => number };
    assertEquals(bag.offset, 5);
    assertEquals(bag.run(2), 7);
  },
);

compilerClosureTest(
  'compileProject returns closure-valued object properties from internal helpers',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { run: (value: number) => number };',
      '',
      'function makeBox(start: number): Box {',
      '  let offset = start;',
      '  return {',
      '    run: (value: number): number => {',
      '      offset = offset + 1;',
      '      return value + offset;',
      '    },',
      '  };',
      '}',
      '',
      'export function main(start: number): number {',
      '  const box = makeBox(start);',
      '  return box.run(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(4), 7);
  },
);

compilerClosureTest(
  'compileProject executes object-literal methods with this on direct property calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { offset: number; run(value: number): number };',
      '',
      'export function main(start: number): number {',
      '  const box: Box = {',
      '    offset: start,',
      '    run(value: number): number {',
      '      return value + this.offset;',
      '    },',
      '  };',
      '  return box.run(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(3), 5);
  },
);

compilerClosureTest(
  'compileProject executes object-literal methods with this mutation on direct property calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { offset: number; run(value: number): number };',
      '',
      'export function main(start: number): number {',
      '  const box: Box = {',
      '    offset: start,',
      '    run(value: number): number {',
      '      this.offset = this.offset + value;',
      '      return this.offset;',
      '    },',
      '  };',
      '  box.run(2);',
      '  return box.run(3);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(4), 9);
  },
);

compilerClosureTest(
  'compileProject passes object-literal methods with this through internal helper params',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { offset: number; run(value: number): number };',
      '',
      'function invoke(box: Box): number {',
      '  return box.run(2);',
      '}',
      '',
      'export function main(start: number): number {',
      '  const box: Box = {',
      '    offset: start,',
      '    run(value: number): number {',
      '      return value + this.offset;',
      '    },',
      '  };',
      '  return invoke(box);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(4), 6);
  },
);

compilerClosureTest(
  'compileProject returns object-literal methods with this from internal helpers',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { offset: number; run(value: number): number };',
      '',
      'function makeBox(start: number): Box {',
      '  return {',
      '    offset: start,',
      '    run(value: number): number {',
      '      return value + this.offset;',
      '    },',
      '  };',
      '}',
      '',
      'export function main(start: number): number {',
      '  const box = makeBox(start);',
      '  return box.run(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject executes object-literal methods with explicit this parameters',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(value: number): number {',
      '  const box = {',
      '    offset: 2,',
      '    apply(this: { offset: number }, current: number): number {',
      '      return current + this.offset;',
      '    },',
      '  };',
      '  return box.apply(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject returns object-literal methods with this mutation from internal helpers',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { offset: number; run(value: number): number };',
      '',
      'function makeBox(start: number): Box {',
      '  return {',
      '    offset: start,',
      '    run(value: number): number {',
      '      this.offset = this.offset + value;',
      '      return this.offset;',
      '    },',
      '  };',
      '}',
      '',
      'export function main(start: number): number {',
      '  const box = makeBox(start);',
      '  box.run(2);',
      '  return box.run(3);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 10);
  },
);

compilerClosureTest(
  'compileProject keeps extracted object-literal methods with this unsupported for now',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { offset: number; run(value: number): number };',
      '',
      'export function main(start: number): number {',
      '  const box: Box = {',
      '    offset: start,',
      '    run(value: number): number {',
      '      return value + this.offset;',
      '    },',
      '  };',
      '  const run = box.run;',
      '  return run(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1035'), true);
  },
);

compilerClosureTest(
  'compileProject preserves extracted object-literal methods with this through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { offset: number; run(value: number): number };',
      '',
      'export function main(start: number): Box {',
      '  return {',
      '    offset: start,',
      '    run(value: number): number {',
      '      return value + this.offset;',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported(5) as { run: (value: number) => number };
    const run = box.run;
    assertEquals(run(2), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported objects with closure-valued properties through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(start: number): { run: (value: number) => number } {',
      '  return {',
      '    run: (value: number): number => value + start,',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported(5) as { run: (value: number) => number };
    assertEquals(box.run(2), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported objects with closure-valued params through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { run: (value: number) => number };',
      '',
      'export function main(box: Box, value: number): number {',
      '  return box.run(value) + 1;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported({ run: (value: number) => value * 2 }, 4), 9);
  },
);

compilerClosureTest(
  'compileProject adapts exported object params with method-valued properties and this through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { offset: number; run(value: number): number };',
      '',
      'export function main(box: Box, value: number): number {',
      '  return box.run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = {
      offset: 5,
      run(value: number): number {
        return value + this.offset;
      },
    };
    assertEquals(exported(box, 2), 7);
  },
);

compilerClosureTest(
  'compileProject preserves identity when returning exported closure-valued object params',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { run: (value: number) => number };',
      '',
      'export function main(box: Box): Box {',
      '  return box;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = { run: (value: number) => value + 3 };
    assertEquals(exported(box), box);
    assertEquals(box.run(2), 5);
  },
);

compilerClosureTest(
  'compileProject adapts exported object-literal methods with this through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = { offset: number; run(value: number): number };',
      '',
      'export function main(start: number): Box {',
      '  return {',
      '    offset: start,',
      '    run(value: number): number {',
      '      return value + this.offset;',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported(5) as { offset: number; run: (value: number) => number };
    assertEquals(box.offset, 5);
    assertEquals(box.run(2), 7);
  },
);

compilerClosureTest(
  'compileProject syncs exported fixed-layout object array fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Box = {',
      '  values: number[];',
      '  names: string[];',
      '  flags: boolean[];',
      '  grow(value: number, name: string): number;',
      '};',
      '',
      'export function main(): Box {',
      '  const values: number[] = [1];',
      '  const names: string[] = ["a"];',
      '  const flags: boolean[] = [true];',
      '  return {',
      '    values,',
      '    names,',
      '    flags,',
      '    grow(value: number, name: string): number {',
      '      this.values.push(value);',
      '      this.names.push(name);',
      '      this.flags.push(false);',
      '      let flagBonus = 0;',
      '      if (this.flags[1] === false) {',
      '        flagBonus = 1;',
      '      }',
      '      return this.values[0] + this.values[1] + this.names.join(",").length + flagBonus;',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      values: number[];
      names: string[];
      flags: boolean[];
      grow(value: number, name: string): number;
    };
    const values = box.values;
    const names = box.names;
    const flags = box.flags;
    assertEquals(box.grow(2, 'b'), 7);
    assertStrictEquals(box.values, values);
    assertStrictEquals(box.names, names);
    assertStrictEquals(box.flags, flags);
    assertEquals(box.values, [1, 2]);
    assertEquals(box.names, ['a', 'b']);
    assertEquals(box.flags, [true, false]);
  },
);

compilerClosureTest(
  'compileProject syncs exported bag-like object array fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = {',
      '  [key: string]: string[] | number[] | boolean[] | ((value: number, name: string) => number);',
      '  counts: number[];',
      '  names: string[];',
      '  flags: boolean[];',
      '  grow(value: number, name: string): number;',
      '};',
      '',
      'export function main(): Bag {',
      '  const counts: number[] = [1];',
      '  const names: string[] = ["a"];',
      '  const flags: boolean[] = [true];',
      '  return {',
      '    counts,',
      '    names,',
      '    flags,',
      '    grow(value: number, name: string): number {',
      '      this.counts.push(value);',
      '      this.names.push(name);',
      '      this.flags.push(false);',
      '      let flagBonus = 0;',
      '      if (this.flags[1] === false) {',
      '        flagBonus = 1;',
      '      }',
      '      return this.counts[0] + this.counts[1] + this.names.join(",").length + flagBonus;',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const bag = exported() as {
      counts: number[];
      names: string[];
      flags: boolean[];
      grow(value: number, name: string): number;
    };
    const counts = bag.counts;
    const names = bag.names;
    const flags = bag.flags;
    assertEquals(bag.grow(2, 'b'), 7);
    assertStrictEquals(bag.counts, counts);
    assertStrictEquals(bag.names, names);
    assertStrictEquals(bag.flags, flags);
    assertEquals(bag.counts, [1, 2]);
    assertEquals(bag.names, ['a', 'b']);
    assertEquals(bag.flags, [true, false]);
  },
);

compilerClosureTest(
  'compileProject syncs exported fixed-layout object mixed heap-array fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  items: Array<Item | number | undefined>;',
      '  grow(value: number): number;',
      '};',
      '',
      'export function main(): Box {',
      '  return {',
      '    items: [new Item(1), 7, undefined],',
      '    grow(value: number): number {',
      '      this.items.push(new Item(value));',
      '      return this.items.length;',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ get(): number } | number | undefined>;
      grow(value: number): number;
    };
    const items = box.items;
    const first = box.items[0];
    assertEquals((first as { get(): number }).get(), 1);
    assertEquals(box.grow(2), 4);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals((box.items[0] as { get(): number }).get(), 1);
    assertEquals(box.items[1], 7);
    assertEquals(box.items[2], undefined);
    assertEquals((box.items[3] as { get(): number }).get(), 2);
  },
);

compilerClosureTest(
  'compileProject syncs exported bag-like object mixed heap-array properties after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Bag = {',
      '  [key: string]: Array<Item | number | undefined> | ((value: number) => number);',
      '  items: Array<Item | number | undefined>;',
      '  grow(value: number): number;',
      '};',
      '',
      'export function main(): Bag {',
      '  return {',
      '    items: [new Item(1), 7, undefined],',
      '    grow(value: number): number {',
      '      this.items.push(new Item(value));',
      '      return this.items.length;',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const bag = exported() as {
      items: Array<{ get(): number } | number | undefined>;
      grow(value: number): number;
    };
    const items = bag.items;
    const first = bag.items[0];
    assertEquals((first as { get(): number }).get(), 1);
    assertEquals(bag.grow(2), 4);
    assertStrictEquals(bag.items, items);
    assertStrictEquals(bag.items[0], first);
    assertEquals((bag.items[0] as { get(): number }).get(), 1);
    assertEquals(bag.items[1], 7);
    assertEquals(bag.items[2], undefined);
    assertEquals((bag.items[3] as { get(): number }).get(), 2);
  },
);

compilerClosureTest(
  'compileProject hoists local function declarations within a function body',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(value: number): number {',
      '  return add(2);',
      '  function add(delta: number): number {',
      '    return value + delta;',
      '  }',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject executes self-recursive local function declarations',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(value: number): number {',
      '  function countdown(current: number): number {',
      '    if (current === 0) {',
      '      return 0;',
      '    }',
      '    return countdown(current - 1) + 1;',
      '  }',
      '  return countdown(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(4), 4);
  },
);

compilerClosureTest(
  'compileProject executes mutually recursive local function declarations',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(value: number): number {',
      '  function isEven(current: number): number {',
      '    if (current === 0) {',
      '      return 1;',
      '    }',
      '    return isOdd(current - 1);',
      '  }',
      '  function isOdd(current: number): number {',
      '    if (current === 0) {',
      '      return 0;',
      '    }',
      '    return isEven(current - 1);',
      '  }',
      '  return isOdd(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 1);
    assertEquals(exported(4), 0);
  },
);

compilerClosureTest(
  'compileProject treats named top-level functions as first-class values',
  async () => {
    const tempDirectory = await createClosureProject([
      'function addTwo(value: number): number {',
      '  return value + 2;',
      '}',
      '',
      'export function main(value: number): number {',
      '  const fn = addTwo;',
      '  return fn(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject adapts named top-level functions through exported closure results',
  async () => {
    const tempDirectory = await createClosureProject([
      'function addTwo(value: number): number {',
      '  return value + 2;',
      '}',
      '',
      'export function makeAdder(): (value: number) => number {',
      '  return addTwo;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeAdder');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const addTwo = exported();
    if (typeof addTwo !== 'function') {
      throw new Error('Expected exported named function result to adapt to a JS function.');
    }
    assertEquals(addTwo(5), 7);
  },
);

compilerClosureTest(
  'compileProject lets closures capture named top-level functions as values',
  async () => {
    const tempDirectory = await createClosureProject([
      'function addTwo(value: number): number {',
      '  return value + 2;',
      '}',
      '',
      'export function main(value: number): number {',
      '  const invoke = (): number => addTwo(value);',
      '  return invoke();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject adapts nested exported closure results through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function makeOuter(start: number): () => () => number {',
      '  return (): (() => number) => () => start + 1;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeOuter');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const outer = exported(10);
    if (typeof outer !== 'function') {
      throw new Error('Expected exported outer closure result to adapt to a JS function.');
    }
    const inner = outer();
    if (typeof inner !== 'function') {
      throw new Error('Expected nested exported closure result to adapt to a JS function.');
    }
    assertEquals(inner(), 11);
  },
);

compilerClosureTest(
  'compileProject adapts nested exported closure params through JS callback boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'export function main(factory: () => () => number): number {',
      '  return factory()();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(() => () => 7), 7);
  },
);

compilerClosureTest(
  'compileProject executes default-constructed class instances with initialized fields and methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 5;',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  const box = new Box();',
      '  return box.run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject executes class instance methods that mutate owned scalar array fields',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  values = [1];',
      '  names = ["a"];',
      '  flags = [true];',
      '',
      '  grow(value: number, name: string): number {',
      '    this.values.push(value);',
      '    this.names.push(name);',
      '    this.flags.push(false);',
      '    let flagBonus = 0;',
      '    if (this.flags[1] === false) {',
      '      flagBonus = 1;',
      '    }',
      '    return this.values[0] + this.values[1] + this.names.join(",").length + flagBonus;',
      '  }',
      '}',
      '',
      'export function main(): number {',
      '  return new Box().grow(2, "b");',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 7);
  },
);

compilerClosureTest(
  'compileProject keeps extracted class methods unsupported for now',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 5;',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  const box = new Box();',
      '  const run = box.run;',
      '  return run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1035'), true);
  },
);

compilerClosureTest(
  'compileProject passes class instances with owned scalar array fields through internal helpers',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  values = [1];',
      '  names = ["a"];',
      '  flags = [true];',
      '}',
      '',
      'function read(box: Box): number {',
      '  box.values.push(2);',
      '  box.names.push("b");',
      '  box.flags.push(false);',
      '  let flagBonus = 0;',
      '  if (box.flags[1] === false) {',
      '    flagBonus = 1;',
      '  }',
      '  return box.values[0] + box.values[1] + box.names.join(",").length + flagBonus;',
      '}',
      '',
      'export function main(): number {',
      '  return read(new Box());',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 7);
  },
);

compilerClosureTest(
  'compileProject executes class methods with explicit this parameters',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 5;',
      '',
      '  run(this: Box, value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return new Box().run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject passes default-constructed class instances through internal helper params',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 5;',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'function apply(box: Box, value: number): number {',
      '  return box.run(value);',
      '}',
      '',
      'export function main(value: number): number {',
      '  return apply(new Box(), value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject returns default-constructed class instances through internal helpers',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 5;',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'function makeBox(): Box {',
      '  return new Box();',
      '}',
      '',
      'export function main(value: number): number {',
      '  return makeBox().run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest('compileProject reads class static fields in compiled code', async () => {
  const tempDirectory = await createClosureProject([
    'class Box {',
    '  static offset = 5;',
    '}',
    '',
    'export function main(value: number): number {',
    '  return value + Box.offset;',
    '}',
    '',
  ].join('\n'));

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}".`);
  }
  assertEquals(exported(2), 7);
});

compilerClosureTest('compileProject executes class static methods in compiled code', async () => {
  const tempDirectory = await createClosureProject([
    'class Box {',
    '  static offset = 5;',
    '',
    '  static run(value: number): number {',
    '    return value + Box.offset;',
    '  }',
    '}',
    '',
    'export function main(value: number): number {',
    '  return Box.run(value);',
    '}',
    '',
  ].join('\n'));

  const result = compileProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });
  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);

  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}".`);
  }
  assertEquals(exported(2), 7);
});

compilerClosureTest(
  'compileProject executes class static methods with explicit this parameters',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '',
      '  static run(this: typeof Box, value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return Box.run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject executes extracted class static methods with bound this',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  const run = Box.run;',
      '  return run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject supports const aliases of class constructor values for static access and new',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  const C = Box;',
      '  return C.run(value) + new C(5).apply(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject supports captured const aliases of class constructor values for static access and new',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  const C = Box;',
      '  function helper(): number {',
      '    return C.run(value) + new C(5).apply(value);',
      '  }',
      '  return helper();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject passes concrete class constructor values through same-file helper params',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'function use(C: typeof Box, value: number): number {',
      '  return C.run(value) + new C(5).apply(value);',
      '}',
      '',
      'export function main(value: number): number {',
      '  return use(Box, value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject returns concrete class constructor values through same-file helper aliases',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
      'export function main(value: number): number {',
      '  const C = choose();',
      '  return C.run(value) + new C(5).apply(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject passes helper-returned class constructor values through same-file helper params',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
      'function use(C: typeof Box, value: number): number {',
      '  return C.run(value) + new C(5).apply(value);',
      '}',
      '',
      'export function main(value: number): number {',
      '  return use(choose(), value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject adapts exported class constructor params through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function use(C: typeof Box, value: number): number {',
      '  return C.run(value) + new C(5).apply(value);',
      '}',
      '',
      'export function makeBox(offset: number): Box {',
      '  return new Box(offset);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);

    const useExportName = await resolveQualifiedExportName(tempDirectory, 'use');
    const useExport = instance.exports[useExportName];
    if (typeof useExport !== 'function') {
      throw new Error(`Expected exported function "${useExportName}".`);
    }

    const makeBoxExportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const makeBoxExport = instance.exports[makeBoxExportName];
    if (typeof makeBoxExport !== 'function') {
      throw new Error(`Expected exported function "${makeBoxExportName}".`);
    }

    const ctor = (makeBoxExport(1) as { constructor: Function }).constructor;
    assertEquals(useExport(ctor, 2), 14);
  },
);

compilerClosureTest(
  'compileProject adapts exported class constructor results through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
      'export function use(C: typeof Box, value: number): number {',
      '  return C.run(value) + new C(5).apply(value);',
      '}',
      '',
      'export function makeBox(offset: number): Box {',
      '  return new Box(offset);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);

    const chooseExportName = await resolveQualifiedExportName(tempDirectory, 'choose');
    const chooseExport = instance.exports[chooseExportName];
    if (typeof chooseExport !== 'function') {
      throw new Error(`Expected exported function "${chooseExportName}".`);
    }

    const useExportName = await resolveQualifiedExportName(tempDirectory, 'use');
    const useExport = instance.exports[useExportName];
    if (typeof useExport !== 'function') {
      throw new Error(`Expected exported function "${useExportName}".`);
    }

    const makeBoxExportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const makeBoxExport = instance.exports[makeBoxExportName];
    if (typeof makeBoxExport !== 'function') {
      throw new Error(`Expected exported function "${makeBoxExportName}".`);
    }

    const chosen = chooseExport() as Function;
    const instanceCtor = (makeBoxExport(1) as { constructor: Function }).constructor;

    assertStrictEquals(chosen, chooseExport());
    assertStrictEquals(chosen, instanceCtor);
    assertEquals(useExport(chosen, 2), 14);
  },
);

compilerClosureTest(
  'compileProject returns JS-usable exported class constructor wrappers',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseExportName = await resolveQualifiedExportName(tempDirectory, 'choose');
    const chooseExport = instance.exports[chooseExportName];
    if (typeof chooseExport !== 'function') {
      throw new Error(`Expected exported function "${chooseExportName}".`);
    }

    const BoxCtor = chooseExport() as {
      new (offset: number): { apply(value: number): number; constructor: unknown };
      offset: number;
      run(value: number): number;
    };

    assertEquals(BoxCtor.offset, 5);
    assertEquals(BoxCtor.run(2), 7);

    const created = new BoxCtor(5);
    assertEquals(created.apply(2), 7);
    assertStrictEquals(created.constructor, BoxCtor);
  },
);

compilerClosureTest(
  'compileProject returns JS-usable class constructor wrappers through exported closure results',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function makeChoose(): () => typeof Box {',
      '  return (): typeof Box => Box;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const makeChooseExportName = await resolveQualifiedExportName(tempDirectory, 'makeChoose');
    const makeChooseExport = instance.exports[makeChooseExportName];
    if (typeof makeChooseExport !== 'function') {
      throw new Error(`Expected exported function "${makeChooseExportName}".`);
    }

    const choose = makeChooseExport() as () => {
      new (offset: number): { apply(value: number): number; constructor: unknown };
      offset: number;
      run(value: number): number;
    };
    const BoxCtor = choose();

    assertEquals(BoxCtor.offset, 5);
    assertEquals(BoxCtor.run(2), 7);

    const created = new BoxCtor(5);
    assertEquals(created.apply(2), 7);
    assertStrictEquals(created.constructor, BoxCtor);
  },
);

compilerClosureTest(
  'compileProject returns JS-usable subclass constructor wrappers with JS inheritance semantics',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  constructor(offset: number) {',
      '    super(offset);',
      '  }',
      '}',
      '',
      'export function chooseBase(): typeof Base {',
      '  return Base;',
      '}',
      '',
      'export function chooseDerived(): typeof Derived {',
      '  return Derived;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseBaseExportName = await resolveQualifiedExportName(tempDirectory, 'chooseBase');
    const chooseDerivedExportName = await resolveQualifiedExportName(
      tempDirectory,
      'chooseDerived',
    );
    const chooseBaseExport = instance.exports[chooseBaseExportName];
    const chooseDerivedExport = instance.exports[chooseDerivedExportName];
    if (typeof chooseBaseExport !== 'function' || typeof chooseDerivedExport !== 'function') {
      throw new Error('Expected exported class constructor chooser functions.');
    }

    const BaseCtor = chooseBaseExport() as {
      prototype: object;
    };
    const DerivedCtor = chooseDerivedExport() as {
      prototype: object;
      new (offset: number): { apply(value: number): number; constructor: unknown };
    };
    const created = new DerivedCtor(5);

    assertStrictEquals(Object.getPrototypeOf(DerivedCtor), BaseCtor);
    assertStrictEquals(Object.getPrototypeOf(DerivedCtor.prototype), BaseCtor.prototype);
    assertEquals(created.apply(2), 7);
    assertEquals(created instanceof DerivedCtor, true);
    assertEquals(created instanceof (BaseCtor as unknown as Function), true);
  },
);

compilerClosureTest(
  'compileProject keeps inherited static methods on JS constructor wrappers bound to dynamic static this',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  static baseOffset = 2;',
      '',
      '  static run(value: number): number {',
      '    return value + this.baseOffset;',
      '  }',
      '',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  static baseOffset = 4;',
      '',
      '  constructor(offset: number) {',
      '    super(offset);',
      '  }',
      '}',
      '',
      'export function chooseBase(): typeof Base {',
      '  return Base;',
      '}',
      '',
      'export function chooseDerived(): typeof Derived {',
      '  return Derived;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseBaseExportName = await resolveQualifiedExportName(tempDirectory, 'chooseBase');
    const chooseDerivedExportName = await resolveQualifiedExportName(
      tempDirectory,
      'chooseDerived',
    );
    const chooseBaseExport = instance.exports[chooseBaseExportName];
    const chooseDerivedExport = instance.exports[chooseDerivedExportName];
    if (typeof chooseBaseExport !== 'function' || typeof chooseDerivedExport !== 'function') {
      throw new Error('Expected exported class constructor chooser functions.');
    }

    const BaseCtor = chooseBaseExport() as { run(value: number): number };
    const DerivedCtor = chooseDerivedExport() as { run(value: number): number };

    assertEquals(BaseCtor.run(2), 4);
    assertEquals(DerivedCtor.run(2), 6);
  },
);

compilerClosureTest(
  'compileProject refreshes exported class constructor wrappers after compiled static heap-field mutation',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static values = [1];',
      '}',
      '',
      'export function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
      'export function grow(): number {',
      '  Box.values.push(2);',
      '  return Box.values.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseExportName = await resolveQualifiedExportName(tempDirectory, 'choose');
    const growExportName = await resolveQualifiedExportName(tempDirectory, 'grow');
    const chooseExport = instance.exports[chooseExportName];
    const growExport = instance.exports[growExportName];
    if (typeof chooseExport !== 'function' || typeof growExport !== 'function') {
      throw new Error('Expected exported class constructor chooser functions.');
    }

    const BoxCtor = chooseExport() as { values: number[] };
    assertEquals(BoxCtor.values.length, 1);
    assertEquals(growExport(), 2);
    assertStrictEquals(chooseExport(), BoxCtor);
    assertEquals(BoxCtor.values.length, 2);
    assertEquals(BoxCtor.values[1], 2);
  },
);

compilerClosureTest(
  'compileProject refreshes exported class constructor wrappers after compiled static string and boolean array mutation',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static names = ["a"];',
      '  static flags = [true];',
      '}',
      '',
      'export function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
      'export function grow(): number {',
      '  Box.names.push("b");',
      '  Box.flags.push(false);',
      '  return Box.flags.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseExportName = await resolveQualifiedExportName(tempDirectory, 'choose');
    const growExportName = await resolveQualifiedExportName(tempDirectory, 'grow');
    const chooseExport = instance.exports[chooseExportName];
    const growExport = instance.exports[growExportName];
    if (typeof chooseExport !== 'function' || typeof growExport !== 'function') {
      throw new Error('Expected exported class constructor chooser functions.');
    }

    const BoxCtor = chooseExport() as { flags: boolean[]; names: string[] };
    assertEquals(BoxCtor.names[0], 'a');
    assertEquals(BoxCtor.flags[0], true);
    assertEquals(growExport(), 2);
    assertStrictEquals(chooseExport(), BoxCtor);
    assertEquals(BoxCtor.names[1], 'b');
    assertEquals(BoxCtor.flags[1], false);
  },
);

compilerClosureTest(
  'compileProject syncs exported class constructor wrappers after JS-invoked compiled static mixed heap-array methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  static items: Array<Item | number | undefined> = [new Item(1), 7, undefined];',
      '',
      '  static grow(value: number): number {',
      '    this.items.push(new Item(value));',
      '    return this.items.length;',
      '  }',
      '}',
      '',
      'export function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseExportName = await resolveQualifiedExportName(tempDirectory, 'choose');
    const chooseExport = instance.exports[chooseExportName];
    if (typeof chooseExport !== 'function') {
      throw new Error('Expected exported class constructor chooser function.');
    }

    const BoxCtor = chooseExport() as {
      items: Array<{ value: number; get(): number } | number | undefined>;
      grow(value: number): number;
    };
    const items = BoxCtor.items;
    const first = BoxCtor.items[0] as { value: number; get(): number };
    assertEquals(first.get(), 1);
    assertEquals(BoxCtor.grow(2), 4);
    assertStrictEquals(chooseExport(), BoxCtor);
    assertStrictEquals(BoxCtor.items, items);
    assertStrictEquals(BoxCtor.items[0], first);
    assertEquals(BoxCtor.items[0]!.get(), 1);
    assertEquals(BoxCtor.items[1], 7);
    assertEquals(BoxCtor.items[2], undefined);
    assertEquals((BoxCtor.items[3] as { get(): number }).get(), 2);
  },
);

compilerClosureTest(
  'compileProject observes JS-side mixed heap-array mutations on exported class constructor wrappers before compiled static method calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  static items: Array<Item | number | undefined> = [new Item(1), 7, undefined];',
      '',
      '  static read(): number {',
      '    const first = this.items[0];',
      '    if (typeof first === "number" || first === undefined) {',
      '      return -1;',
      '    }',
      '    return first.get();',
      '  }',
      '}',
      '',
      'export function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseExportName = await resolveQualifiedExportName(tempDirectory, 'choose');
    const chooseExport = instance.exports[chooseExportName];
    if (typeof chooseExport !== 'function') {
      throw new Error('Expected exported class constructor chooser function.');
    }

    const BoxCtor = chooseExport() as {
      items: Array<{ value: number; get(): number } | number | undefined>;
      read(): number;
    };
    assertEquals(BoxCtor.read(), 1);
    const first = BoxCtor.items[0] as { value: number; get(): number };
    first.value = 5;
    assertEquals((BoxCtor.items[0] as { get(): number }).get(), 5);
    assertEquals(BoxCtor.read(), 5);
  },
);

compilerClosureTest(
  'compileProject syncs exported class constructor wrappers after JS-invoked compiled static nested-object methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  static child: Item = new Item(1);',
      '',
      '  static replace(value: number): number {',
      '    Box.child.value = value;',
      '    return Box.child.get();',
      '  }',
      '}',
      '',
      'export function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseExportName = await resolveQualifiedExportName(tempDirectory, 'choose');
    const chooseExport = instance.exports[chooseExportName];
    if (typeof chooseExport !== 'function') {
      throw new Error('Expected exported class constructor chooser function.');
    }

    const BoxCtor = chooseExport() as {
      child: { get(): number };
      replace(value: number): number;
    };
    const first = BoxCtor.child;
    assertEquals(first.get(), 1);
    assertEquals(BoxCtor.replace(2), 2);
    assertStrictEquals(chooseExport(), BoxCtor);
    assertStrictEquals(BoxCtor.child, first);
    assertEquals(BoxCtor.child.get(), 2);
  },
);

compilerClosureTest(
  'compileProject observes JS-side nested object mutations on exported class constructor wrappers before compiled static method calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  static child: Item = new Item(1);',
      '',
      '  static read(): number {',
      '    return Box.child.get();',
      '  }',
      '}',
      '',
      'export function choose(): typeof Box {',
      '  return Box;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const chooseExportName = await resolveQualifiedExportName(tempDirectory, 'choose');
    const chooseExport = instance.exports[chooseExportName];
    if (typeof chooseExport !== 'function') {
      throw new Error('Expected exported class constructor chooser function.');
    }

    const BoxCtor = chooseExport() as {
      child: { value: number; get(): number };
      read(): number;
    };
    assertEquals(BoxCtor.read(), 1);
    BoxCtor.child.value = 7;
    assertEquals(BoxCtor.child.get(), 7);
    assertEquals(BoxCtor.read(), 7);
  },
);

compilerClosureTest(
  'compileProject keeps nested closures from capturing static class this unsupported for now',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '',
      '  static make(delta: number): () => number {',
      '    return (): number => this.offset + delta;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return Box.make(value)();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1022'), true);
  },
);

compilerClosureTest(
  'compileProject executes local function declarations with concrete class constructor params and results',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  function choose(): typeof Box {',
      '    return Box;',
      '  }',
      '  function use(C: typeof Box, current: number): number {',
      '    return C.run(current) + new C(5).apply(current);',
      '  }',
      '  return use(choose(), value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject executes arrow closures with concrete class constructor params and results',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  const choose = (): typeof Box => Box;',
      '  const use = (C: typeof Box, current: number): number => C.run(current) + new C(5).apply(current);',
      '  return use(choose(), value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject executes object-literal methods with concrete class constructor params and results',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  const tools = {',
      '    choose(): typeof Box {',
      '      return Box;',
      '    },',
      '    use(C: typeof Box, current: number): number {',
      '      return C.run(current) + new C(5).apply(current);',
      '    },',
      '  };',
      '  return tools.use(tools.choose(), value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject executes closure-valued object properties with concrete class constructor params and results',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  const tools = {',
      '    choose: (): typeof Box => Box,',
      '    use: (C: typeof Box, current: number): number => C.run(current) + new C(5).apply(current),',
      '  };',
      '  return tools.use(tools.choose(), value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject executes class static methods with concrete class constructor params and results',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Tools {',
      '  static choose(): typeof Box {',
      '    return Box;',
      '  }',
      '',
      '  static use(C: typeof Box, current: number): number {',
      '    return C.run(current) + new C(5).apply(current);',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return Tools.use(Tools.choose(), value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject executes fixed-layout object fields that store concrete class constructor values',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  const holder = { ctor: Box };',
      '  const C = holder.ctor;',
      '  return C.run(value) + new C(5).apply(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject adapts exported fixed-layout object results with class-constructor fields through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'interface Holder {',
      '  ctor: typeof Box;',
      '}',
      '',
      'export function makeHolder(): Holder {',
      '  return { ctor: Box };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeHolder');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const holder = exported() as {
      ctor: {
        new (offset: number): { apply(value: number): number };
        run(value: number): number;
      };
    };
    assertEquals(holder.ctor.run(2), 7);
    assertEquals(new holder.ctor(5).apply(2), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported fixed-layout object params with class-constructor fields through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'interface Holder {',
      '  ctor: typeof Box;',
      '}',
      '',
      'export function makeHolder(): Holder {',
      '  return { ctor: Box };',
      '}',
      '',
      'export function runHolder(holder: Holder): number {',
      '  return holder.ctor.run(2) + new holder.ctor(5).apply(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const makeHolderExportName = await resolveQualifiedExportName(tempDirectory, 'makeHolder');
    const runHolderExportName = await resolveQualifiedExportName(tempDirectory, 'runHolder');
    const makeHolder = instance.exports[makeHolderExportName];
    const runHolder = instance.exports[runHolderExportName];
    if (typeof makeHolder !== 'function' || typeof runHolder !== 'function') {
      throw new Error('Expected exported functions.');
    }
    const holder = makeHolder() as {
      ctor: {
        new (offset: number): { apply(value: number): number };
        run(value: number): number;
      };
    };
    assertEquals(runHolder(holder), 14);
  },
);

compilerClosureTest(
  'compileProject adapts exported bag-like object results with class-constructor properties through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'interface Holder {',
      '  [key: string]: typeof Box | number;',
      '  ctor: typeof Box;',
      '  count: number;',
      '}',
      '',
      'export function makeHolder(): Holder {',
      '  return { ctor: Box, count: 1 };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeHolder');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const holder = exported() as {
      ctor: {
        new (offset: number): { apply(value: number): number };
        run(value: number): number;
      };
      count: number;
    };
    assertEquals(holder.count, 1);
    assertEquals(holder.ctor.run(2), 7);
    assertEquals(new holder.ctor(5).apply(2), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported bag-like object params with class-constructor properties through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'interface Holder {',
      '  [key: string]: typeof Box | number;',
      '  ctor: typeof Box;',
      '  count: number;',
      '}',
      '',
      'export function makeHolder(): Holder {',
      '  return { ctor: Box, count: 1 };',
      '}',
      '',
      'export function runHolder(holder: Holder): number {',
      '  return holder.count + holder.ctor.run(2) + new holder.ctor(5).apply(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const makeHolderExportName = await resolveQualifiedExportName(tempDirectory, 'makeHolder');
    const runHolderExportName = await resolveQualifiedExportName(tempDirectory, 'runHolder');
    const makeHolder = instance.exports[makeHolderExportName];
    const runHolder = instance.exports[runHolderExportName];
    if (typeof makeHolder !== 'function' || typeof runHolder !== 'function') {
      throw new Error('Expected exported functions.');
    }
    const holder = makeHolder() as {
      ctor: {
        new (offset: number): { apply(value: number): number };
        run(value: number): number;
      };
      count: number;
    };
    assertEquals(runHolder(holder), 15);
  },
);

compilerClosureTest(
  'compileProject generalizes fixed-layout objects with class-constructor fields into bag-like results',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'type Holder = {',
      '  ctor: typeof Box;',
      '  count: number;',
      '};',
      '',
      'interface Bag {',
      '  [key: string]: typeof Box | number;',
      '  ctor: typeof Box;',
      '  count: number;',
      '}',
      '',
      'function makeFixed(): Holder {',
      '  return { ctor: Box, count: 1 };',
      '}',
      '',
      'export function makeHolder(): Bag {',
      '  return makeFixed();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeHolder');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const holder = exported() as {
      ctor: {
        new (offset: number): { apply(value: number): number };
        run(value: number): number;
      };
      count: number;
    };
    assertEquals(holder.count, 1);
    assertEquals(holder.ctor.run(2), 7);
    assertEquals(new holder.ctor(5).apply(2), 7);
  },
);

compilerClosureTest(
  'compileProject executes class static fields that store concrete class constructor values',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static offset = 5;',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Tools {',
      '  static ctor = Box;',
      '}',
      '',
      'export function main(value: number): number {',
      '  const C = Tools.ctor;',
      '  return C.run(value) + new C(5).apply(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 14);
  },
);

compilerClosureTest(
  'compileProject preserves class static heap-field identity across compiled reads',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static values = [1];',
      '}',
      '',
      'export function main(): number {',
      '  Box.values.push(2);',
      '  return Box.values[0] + Box.values[1] + Box.values.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 5);
  },
);

compilerClosureTest(
  'compileProject preserves class static string and boolean array identity across compiled reads',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  static names = ["a"];',
      '  static flags = [true];',
      '}',
      '',
      'export function main(): string {',
      '  Box.names.push("b");',
      '  Box.flags.push(false);',
      '  let lengthSuffix = ":bad";',
      '  if (Box.flags.length === 2) {',
      '    lengthSuffix = ":two";',
      '  }',
      '  let flagSuffix = ":bad";',
      '  if (Box.flags[1] === false) {',
      '    flagSuffix = ":false";',
      '  }',
      '  return Box.names.join(",") + lengthSuffix + flagSuffix;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'a,b:two:false');
  },
);

compilerClosureTest(
  'compileProject executes local function declarations inside class constructors',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    function init(delta: number): number {',
      '      return offset + delta;',
      '    }',
      '    this.offset = init(2);',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return new Box(5).apply(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(1), 8);
  },
);

compilerClosureTest(
  'compileProject keeps closures inside class constructors with captured this unsupported for now',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    const init = (): number => {',
      '      this.offset = offset + 2;',
      '      return this.offset;',
      '    };',
      '    this.offset = init();',
      '  }',
      '',
      '  apply(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return new Box(5).apply(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1036'), true);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1022'), true);
  },
);

compilerClosureTest(
  'compileProject executes inherited class static methods and fields on subclasses',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  static offset = 5;',
      '',
      '  static run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  static offset = 7;',
      '}',
      '',
      'export function main(value: number): number {',
      '  return Derived.run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 9);
  },
);

compilerClosureTest(
  'compileProject executes super method calls in derived static methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  static run(value: number): number {',
      '    return value + 1;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  static runTwice(value: number): number {',
      '    return super.run(value) + super.run(value + 1);',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return Derived.runTwice(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject executes inherited class methods and fields on subclasses',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 5;',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {}',
      '',
      'export function main(value: number): number {',
      '  return new Derived().run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported subclass results with inherited class methods through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 5;',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {}',
      '',
      'export function makeBox(): Derived {',
      '  return new Derived();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as { run: (value: number) => number };
    assertEquals(box.run(2), 7);
  },
);

compilerClosureTest(
  'compileProject preserves JS instanceof relationships for exported subclass results',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 5;',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {}',
      '',
      'export function makeBase(): Base {',
      '  return new Base();',
      '}',
      '',
      'export function makeDerived(): Derived {',
      '  return new Derived();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const makeBaseExportName = await resolveQualifiedExportName(tempDirectory, 'makeBase');
    const makeDerivedExportName = await resolveQualifiedExportName(tempDirectory, 'makeDerived');
    const makeBaseExport = instance.exports[makeBaseExportName];
    const makeDerivedExport = instance.exports[makeDerivedExportName];
    if (typeof makeBaseExport !== 'function' || typeof makeDerivedExport !== 'function') {
      throw new Error('Expected exported subclass result factories.');
    }

    const base = makeBaseExport() as { constructor: Function };
    const derived = makeDerivedExport() as { constructor: Function; run(value: number): number };

    assertEquals(derived instanceof derived.constructor, true);
    assertEquals(derived instanceof base.constructor, true);
    assertEquals(derived.run(2), 7);
  },
);

compilerClosureTest(
  'compileProject executes derived class fields without constructors across inherited methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 5;',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  bonus = 3;',
      '',
      '  total(value: number): number {',
      '    return this.run(value) + this.bonus;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return new Derived().total(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 10);
  },
);

compilerClosureTest(
  'compileProject forwards subclass construction args to inherited base constructors',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {}',
      '',
      'export function main(value: number): number {',
      '  return new Derived(5).run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject executes explicit derived constructors with super calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  constructor(offset: number) {',
      '    super(offset + 1);',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return new Derived(4).run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported subclass results built by explicit derived constructors through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  constructor(offset: number) {',
      '    super(offset + 1);',
      '  }',
      '}',
      '',
      'export function makeBox(offset: number): Derived {',
      '  return new Derived(offset);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported(4) as { run: (value: number) => number };
    assertEquals(box.run(2), 7);
  },
);

compilerClosureTest(
  'compileProject executes explicit derived constructors with derived field initializers',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  bonus = this.offset + 2;',
      '',
      '  constructor(offset: number) {',
      '    super(offset);',
      '  }',
      '',
      '  value(): number {',
      '    return this.bonus;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return new Derived(value).value();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(5), 7);
  },
);

compilerClosureTest(
  'compileProject executes super method calls in derived instance methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  run(value: number): number {',
      '    return value + 1;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  runTwice(value: number): number {',
      '    return super.run(value) + super.run(value);',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return new Derived().runTwice(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 6);
  },
);

compilerClosureTest(
  'compileProject adapts exported subclass results with super-backed methods through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  run(value: number): number {',
      '    return value + 1;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  runTwice(value: number): number {',
      '    return super.run(value) + super.run(value);',
      '  }',
      '}',
      '',
      'export function makeBox(): Derived {',
      '  return new Derived();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as { runTwice: (value: number) => number };
    assertEquals(box.runTwice(2), 6);
  },
);

compilerClosureTest(
  'compileProject keeps super method calls inside derived constructors unsupported for now',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  run(value: number): number {',
      '    return value + 1;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  constructor(offset: number) {',
      '    super(offset);',
      '    this.offset = super.run(offset);',
      '  }',
      '',
      '  value(): number {',
      '    return this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return new Derived(value).value();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1036'), true);
  },
);

compilerClosureTest(
  'compileProject executes class constructors with params and field assignments',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function main(value: number): number {',
      '  return new Box(5).run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject passes constructed class instances with params through internal helpers',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'function apply(box: Box, value: number): number {',
      '  return box.run(value);',
      '}',
      '',
      'export function main(value: number): number {',
      '  return apply(new Box(5), value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(2), 7);
  },
);

compilerClosureTest(
  'compileProject keeps exported class param method extraction unsupported for now',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function apply(box: Box, value: number): number {',
      '  const run = box.run;',
      '  return run(value);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1035'), true);
  },
);

compilerClosureTest(
  'compileProject adapts exported class results through JS object boundaries with callable methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function makeBox(offset: number): Box {',
      '  return new Box(offset);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported(5);
    assertEquals(box.run(2), 7);
  },
);

compilerClosureTest(
  'compileProject preserves JS-side constructor identity on exported class results',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  offset = 0;',
      '',
      '  constructor(offset: number) {',
      '    this.offset = offset;',
      '  }',
      '',
      '  run(value: number): number {',
      '    return value + this.offset;',
      '  }',
      '}',
      '',
      'export function makeBox(offset: number): Box {',
      '  return new Box(offset);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = exported(5) as { constructor: Function; run(value: number): number };
    const second = exported(8) as { constructor: Function; run(value: number): number };

    assertStrictEquals(first.constructor, second.constructor);
    assertEquals(first.constructor === Object, false);
    assertEquals(first instanceof first.constructor, true);
    assertEquals(second instanceof first.constructor, true);
    assertEquals(first.run(2), 7);
    assertEquals(second.run(2), 10);
  },
);

compilerClosureTest(
  'compileProject adapts exported class results with owned scalar array fields through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  values = [1];',
      '  names = ["a"];',
      '  flags = [true];',
      '',
      '  total(): number {',
      '    let flagBonus = 0;',
      '    if (this.flags[1] === false) {',
      '      flagBonus = 1;',
      '    }',
      '    return this.values[0] + this.values[1] + this.names.join(",").length + flagBonus;',
      '  }',
      '}',
      '',
      'export function makeBox(): Box {',
      '  const box = new Box();',
      '  box.values.push(2);',
      '  box.names.push("b");',
      '  box.flags.push(false);',
      '  return box;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      values: number[];
      names: string[];
      flags: boolean[];
      total(): number;
    };
    assertEquals(box.values, [1, 2]);
    assertEquals(box.names, ['a', 'b']);
    assertEquals(box.flags, [true, false]);
    assertEquals(box.total(), 7);
  },
);

compilerClosureTest(
  'compileProject copies back exported class param array-field mutations through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  values = [1];',
      '  names = ["a"];',
      '  flags = [true];',
      '',
      '  grow(value: number, name: string): number {',
      '    this.values.push(value);',
      '    this.names.push(name);',
      '    this.flags.push(false);',
      '    let flagBonus = 0;',
      '    if (this.flags[1] === false) {',
      '      flagBonus = 1;',
      '    }',
      '    return this.values[0] + this.values[1] + this.names.join(",").length + flagBonus;',
      '  }',
      '}',
      '',
      'export function apply(box: Box): number {',
      '  return box.grow(2, "b");',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = {
      values: [1],
      names: ['a'],
      flags: [true],
    };
    const values = box.values;
    const names = box.names;
    const flags = box.flags;
    assertEquals(exported(box), 7);
    assertStrictEquals(box.values, values);
    assertStrictEquals(box.names, names);
    assertStrictEquals(box.flags, flags);
    assertEquals(box.values, [1, 2]);
    assertEquals(box.names, ['a', 'b']);
    assertEquals(box.flags, [true, false]);
  },
);

compilerClosureTest(
  'compileProject syncs exported bag-like object nested object fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  [key: string]: Item | ((value: number) => number);',
      '  child: Item;',
      '  replace(value: number): number;',
      '};',
      '',
      'export function main(): Box {',
      '  return {',
      '    child: new Item(1),',
      '    replace(value: number): number {',
      '      this.child = new Item(value);',
      '      return this.child.get();',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      child: { get(): number };
      replace(value: number): number;
    };
    const first = box.child;
    assertEquals(first.get(), 1);
    assertEquals(box.replace(2), 2);
    assertEquals(box.child.get(), 2);
    assertStrictEquals(box.child === first, false);
  },
);

compilerClosureTest(
  'compileProject syncs exported class result array fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  values = [1];',
      '  names = ["a"];',
      '  flags = [true];',
      '',
      '  grow(value: number, name: string): number {',
      '    this.values.push(value);',
      '    this.names.push(name);',
      '    this.flags.push(false);',
      '    let flagBonus = 0;',
      '    if (this.flags[1] === false) {',
      '      flagBonus = 1;',
      '    }',
      '    return this.values[0] + this.values[1] + this.names.join(",").length + flagBonus;',
      '  }',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return new Box();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      values: number[];
      names: string[];
      flags: boolean[];
      grow(value: number, name: string): number;
    };
    const values = box.values;
    const names = box.names;
    const flags = box.flags;
    assertEquals(box.grow(2, 'b'), 7);
    assertStrictEquals(box.values, values);
    assertStrictEquals(box.names, names);
    assertStrictEquals(box.flags, flags);
    assertEquals(box.values, [1, 2]);
    assertEquals(box.names, ['a', 'b']);
    assertEquals(box.flags, [true, false]);
  },
);

compilerClosureTest(
  'compileProject syncs exported class result heap-array fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  items: Item[] = [new Item(1)];',
      '',
      '  grow(value: number): number {',
      '    this.items.push(new Item(value));',
      '    return this.items[0].get() + this.items[1].get();',
      '  }',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return new Box();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ get(): number }>;
      grow(value: number): number;
    };
    const items = box.items;
    const first = box.items[0];
    assertEquals(first.get(), 1);
    assertEquals(box.grow(2), 3);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals(box.items.length, 2);
    assertEquals(box.items[0].get(), 1);
    assertEquals(box.items[1].get(), 2);
  },
);

compilerClosureTest(
  'compileProject observes JS-side heap-array mutations on exported class results before compiled method calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  items: Item[] = [new Item(1)];',
      '',
      '  read(): number {',
      '    return this.items[0].get();',
      '  }',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return new Box();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ value: number; get(): number }>;
      read(): number;
    };
    assertEquals(box.read(), 1);
    box.items[0]!.value = 7;
    assertEquals(box.items[0]!.get(), 7);
    assertEquals(box.read(), 7);
  },
);

compilerClosureTest(
  'compileProject adapts exported class results with mixed heap-array fields through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  items: Array<Item | number | undefined> = [new Item(1), 7, undefined];',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return new Box();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ get(): number } | number | undefined>;
    };
    assertEquals(box.items.length, 3);
    assertEquals((box.items[0] as { get(): number }).get(), 1);
    assertEquals(box.items[1], 7);
    assertEquals(box.items[2], undefined);
  },
);

compilerClosureTest(
  'compileProject syncs exported class result mixed heap-array fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  items: Array<Item | number | undefined> = [new Item(1), 7, undefined];',
      '',
      '  grow(value: number): number {',
      '    const first = this.items[0];',
      '    if (typeof first === "number" || first === undefined) {',
      '      return -1;',
      '    }',
      '    this.items.push(new Item(value));',
      '    return first.get() + this.items.length;',
      '  }',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return new Box();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ value: number; get(): number } | number | undefined>;
      grow(value: number): number;
    };
    const items = box.items;
    const first = box.items[0] as { value: number; get(): number };
    first.value = 5;
    assertEquals(box.grow(2), 9);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals(box.items[0]!.get(), 5);
    assertEquals(box.items[1], 7);
    assertEquals(box.items[2], undefined);
    assertEquals((box.items[3] as { get(): number }).get(), 2);
  },
);

compilerClosureTest(
  'compileProject syncs exported class result nested object fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  child: Item = new Item(1);',
      '',
      '  replace(value: number): number {',
      '    this.child = new Item(value);',
      '    return this.child.get();',
      '  }',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return new Box();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      child: { get(): number };
      replace(value: number): number;
    };
    const first = box.child;
    assertEquals(first.get(), 1);
    assertEquals(box.replace(2), 2);
    assertEquals(box.child.get(), 2);
    assertStrictEquals(box.child === first, false);
  },
);

compilerClosureTest(
  'compileProject observes JS-side nested object mutations on exported class results before compiled method calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  child: Item = new Item(1);',
      '',
      '  read(): number {',
      '    return this.child.get();',
      '  }',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return new Box();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      child: { value: number; get(): number };
      read(): number;
    };
    assertEquals(box.read(), 1);
    box.child.value = 7;
    assertEquals(box.child.get(), 7);
    assertEquals(box.read(), 7);
  },
);

compilerClosureTest(
  'compileProject syncs exported class param heap-array fields after compiled calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  items: Item[] = [new Item(1)];',
      '',
      '  grow(value: number): number {',
      '    this.items.push(new Item(value));',
      '    return this.items[0].get() + this.items[1].get();',
      '  }',
      '}',
      '',
      'export function apply(box: Box): number {',
      '  return box.grow(2);',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      items: [first] as Array<{ value: number; get?: () => number }>,
    };
    const items = box.items;
    assertEquals(exported(box), 3);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals(box.items.length, 2);
    assertEquals(box.items[0].get?.(), 1);
    assertEquals(box.items[1]?.get?.(), 2);
  },
);

compilerClosureTest(
  'compileProject observes JS-side mixed heap-array mutations on exported class params before compiled calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  items: Array<Item | number | undefined> = [new Item(1), 7, undefined];',
      '}',
      '',
      'export function apply(box: Box): number {',
      '  const first = box.items[0];',
      '  if (typeof first === "number" || first === undefined) {',
      '    return -1;',
      '  }',
      '  return first.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      items: [first, 7, undefined] as Array<
        { value: number; get?: () => number } | number | undefined
      >,
    };
    assertEquals(exported(box), 1);
    first.value = 7;
    assertEquals((box.items[0] as { get?: () => number } | undefined)?.get?.(), 7);
    assertEquals(exported(box), 7);
  },
);

compilerClosureTest(
  'compileProject syncs exported class param nested object fields after compiled calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'class Box {',
      '  child: Item = new Item(1);',
      '}',
      '',
      'export function apply(box: Box): number {',
      '  box.child = new Item(2);',
      '  return box.child.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      child: first as { value: number; get?: () => number },
    };
    assertEquals(exported(box), 2);
    assertStrictEquals(box.child === first, false);
    assertEquals(box.child.get?.(), 2);
  },
);

compilerClosureTest(
  'compileProject syncs exported fixed-layout object result nested object fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'interface Box {',
      '  child: Item;',
      '  replace(value: number): number;',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return {',
      '    child: new Item(1),',
      '    replace(value: number): number {',
      '      this.child = new Item(value);',
      '      return this.child.get();',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      child: { get(): number };
      replace(value: number): number;
    };
    const first = box.child;
    assertEquals(first.get(), 1);
    assertEquals(box.replace(2), 2);
    assertEquals(box.child.get(), 2);
    assertStrictEquals(box.child === first, false);
  },
);

compilerClosureTest(
  'compileProject observes JS-side nested object mutations on exported fixed-layout object results before compiled method calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  child: Item;',
      '  read(): number;',
      '};',
      '',
      'export function main(): Box {',
      '  return {',
      '    child: new Item(1),',
      '    read(): number {',
      '      return this.child.get();',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      child: { value: number; get(): number };
      read(): number;
    };
    assertEquals(box.read(), 1);
    box.child.value = 7;
    assertEquals(box.child.get(), 7);
    assertEquals(box.read(), 7);
  },
);

compilerClosureTest(
  'compileProject observes JS-side nested object mutations on exported bag-like object results before compiled method calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  [key: string]: Item | (() => number);',
      '  child: Item;',
      '  read(): number;',
      '};',
      '',
      'export function main(): Box {',
      '  return {',
      '    child: new Item(1),',
      '    read(): number {',
      '      return this.child.get();',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      child: { value: number; get(): number };
      read(): number;
    };
    assertEquals(box.read(), 1);
    box.child.value = 7;
    assertEquals(box.child.get(), 7);
    assertEquals(box.read(), 7);
  },
);

compilerClosureTest(
  'compileProject syncs exported fixed-layout object result heap-array fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'interface Box {',
      '  items: Item[];',
      '  grow(value: number): number;',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return {',
      '    items: [new Item(1)],',
      '    grow(value: number): number {',
      '      this.items.push(new Item(value));',
      '      return this.items[0].get() + this.items[1].get();',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ get(): number }>;
      grow(value: number): number;
    };
    const items = box.items;
    const first = box.items[0];
    assertEquals(first.get(), 1);
    assertEquals(box.grow(2), 3);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals(box.items.length, 2);
    assertEquals(box.items[0].get(), 1);
    assertEquals(box.items[1].get(), 2);
  },
);

compilerClosureTest(
  'compileProject adapts exported fixed-layout object results with mixed heap-array fields through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'interface Box {',
      '  items: Array<Item | number | undefined>;',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return {',
      '    items: [new Item(1), 7, undefined],',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ get(): number } | number | undefined>;
    };
    assertEquals(box.items.length, 3);
    assertEquals(typeof box.items[0], 'object');
    assertEquals((box.items[0] as { get(): number }).get(), 1);
    assertEquals(box.items[1], 7);
    assertEquals(box.items[2], undefined);
  },
);

compilerClosureTest(
  'compileProject copies back exported fixed-layout object mixed heap-array field mutations through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'interface Box {',
      '  items: Array<Item | number | undefined>;',
      '}',
      '',
      'export function apply(box: Box): number {',
      '  box.items.push(new Item(2));',
      '  return box.items.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      items: [first, 7, undefined] as Array<
        { value: number; get?: () => number } | number | undefined
      >,
    };
    const items = box.items;
    assertEquals(exported(box), 4);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals((box.items[0] as { get?: () => number }).get?.(), 1);
    assertEquals(box.items[1], 7);
    assertEquals(box.items[2], undefined);
    assertEquals((box.items[3] as { get?: () => number }).get?.(), 2);
  },
);

compilerClosureTest(
  'compileProject observes JS-side mixed heap-array field replacements on exported fixed-layout object results before compiled method calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'interface Box {',
      '  items: Array<Item | number | undefined>;',
      '  read(): number;',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return {',
      '    items: [new Item(1), 7, undefined],',
      '    read(): number {',
      '      const first = this.items[0];',
      '      if (typeof first === "number" || first === undefined) {',
      '        return -1;',
      '      }',
      '      return first.get();',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ value: number; get(): number } | number | undefined>;
      read(): number;
    };
    assertEquals(box.read(), 1);
    const first = box.items[0] as { value: number; get(): number };
    first.value = 9;
    box.items = [first, 2, undefined];
    assertEquals((box.items[0] as { get(): number }).get(), 9);
    assertEquals(box.read(), 9);
  },
);

compilerClosureTest(
  'compileProject adapts exported bag-like object results with mixed heap-array properties through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  [key: string]: Array<Item | number | undefined>;',
      '  items: Array<Item | number | undefined>;',
      '};',
      '',
      'export function makeBox(): Box {',
      '  return {',
      '    items: [new Item(1), 7, undefined],',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ get(): number } | number | undefined>;
    };
    assertEquals(box.items.length, 3);
    assertEquals(typeof box.items[0], 'object');
    assertEquals((box.items[0] as { get(): number }).get(), 1);
    assertEquals(box.items[1], 7);
    assertEquals(box.items[2], undefined);
  },
);

compilerClosureTest(
  'compileProject copies back exported bag-like object mixed heap-array property mutations through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  [key: string]: Array<Item | number | undefined>;',
      '  items: Array<Item | number | undefined>;',
      '};',
      '',
      'export function apply(box: Box): number {',
      '  box.items.push(new Item(2));',
      '  return box.items.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      items: [first, 7, undefined] as Array<
        { value: number; get?: () => number } | number | undefined
      >,
    };
    const items = box.items;
    assertEquals(exported(box), 4);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals((box.items[0] as { get?: () => number }).get?.(), 1);
    assertEquals(box.items[1], 7);
    assertEquals(box.items[2], undefined);
    assertEquals((box.items[3] as { get?: () => number }).get?.(), 2);
  },
);

compilerClosureTest(
  'compileProject observes JS-side mixed heap-array property replacements on exported bag-like object results before compiled method calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  [key: string]: Array<Item | number | undefined> | (() => number);',
      '  items: Array<Item | number | undefined>;',
      '  read(): number;',
      '};',
      '',
      'export function makeBox(): Box {',
      '  return {',
      '    items: [new Item(1), 7, undefined],',
      '    read(): number {',
      '      const first = this.items[0];',
      '      if (typeof first === "number" || first === undefined) {',
      '        return -1;',
      '      }',
      '      return first.get();',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ value: number; get(): number } | number | undefined>;
      read(): number;
    };
    assertEquals(box.read(), 1);
    const first = box.items[0] as { value: number; get(): number };
    first.value = 11;
    box.items = [first, 2, undefined];
    assertEquals((box.items[0] as { get(): number }).get(), 11);
    assertEquals(box.read(), 11);
  },
);

compilerClosureTest(
  'compileProject syncs exported fixed-layout object param heap-array fields after compiled calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'interface Box {',
      '  items: Item[];',
      '}',
      '',
      'export function apply(box: Box): number {',
      '  box.items.push(new Item(2));',
      '  return box.items[0].get() + box.items[1].get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      items: [first] as Array<{ value: number; get?: () => number }>,
    };
    const items = box.items;
    assertEquals(exported(box), 3);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals(box.items.length, 2);
    assertEquals(box.items[0].get?.(), 1);
    assertEquals(box.items[1]?.get?.(), 2);
  },
);

compilerClosureTest(
  'compileProject observes JS-side mixed heap-array mutations on exported fixed-layout object params before compiled calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'interface Box {',
      '  items: Array<Item | number | undefined>;',
      '}',
      '',
      'export function apply(box: Box): number {',
      '  const first = box.items[0];',
      '  if (typeof first === "number" || first === undefined) {',
      '    return -1;',
      '  }',
      '  return first.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      items: [first, 7, undefined] as Array<
        { value: number; get?: () => number } | number | undefined
      >,
    };
    assertEquals(exported(box), 1);
    first.value = 7;
    assertEquals((box.items[0] as { get?: () => number } | undefined)?.get?.(), 7);
    assertEquals(exported(box), 7);
  },
);

compilerClosureTest(
  'compileProject syncs exported fixed-layout object param nested object fields after compiled calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'interface Box {',
      '  child: Item;',
      '}',
      '',
      'export function apply(box: Box): number {',
      '  box.child = new Item(2);',
      '  return box.child.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      child: first as { value: number; get?: () => number },
    };
    assertEquals(exported(box), 2);
    assertStrictEquals(box.child === first, false);
    assertEquals(box.child.get?.(), 2);
  },
);

compilerClosureTest(
  'compileProject syncs exported bag-like object result heap-array fields after JS-invoked compiled methods',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  [key: string]: Item[] | ((value: number) => number);',
      '  items: Item[];',
      '  grow(value: number): number;',
      '};',
      '',
      'export function makeBox(): Box {',
      '  return {',
      '    items: [new Item(1)],',
      '    grow(value: number): number {',
      '      this.items.push(new Item(value));',
      '      return this.items[0].get() + this.items[1].get();',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const box = exported() as {
      items: Array<{ get(): number }>;
      grow(value: number): number;
    };
    const items = box.items;
    const first = box.items[0];
    assertEquals(first.get(), 1);
    assertEquals(box.grow(2), 3);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals(box.items.length, 2);
    assertEquals(box.items[0].get(), 1);
    assertEquals(box.items[1].get(), 2);
  },
);

compilerClosureTest(
  'compileProject syncs exported bag-like object param heap-array fields after compiled calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  [key: string]: Item[];',
      '  items: Item[];',
      '};',
      '',
      'export function apply(box: Box): number {',
      '  box.items.push(new Item(2));',
      '  return box.items[0].get() + box.items[1].get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      items: [first] as Array<{ value: number; get?: () => number }>,
    };
    const items = box.items;
    assertEquals(exported(box), 3);
    assertStrictEquals(box.items, items);
    assertStrictEquals(box.items[0], first);
    assertEquals(box.items.length, 2);
    assertEquals(box.items[0].get?.(), 1);
    assertEquals(box.items[1]?.get?.(), 2);
  },
);

compilerClosureTest(
  'compileProject observes JS-side mixed heap-array mutations on exported bag-like object params before compiled calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  [key: string]: Array<Item | number | undefined>;',
      '  items: Array<Item | number | undefined>;',
      '};',
      '',
      'export function apply(box: Box): number {',
      '  const first = box.items[0];',
      '  if (typeof first === "number" || first === undefined) {',
      '    return -1;',
      '  }',
      '  return first.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      items: [first, 7, undefined] as Array<
        { value: number; get?: () => number } | number | undefined
      >,
    };
    assertEquals(exported(box), 1);
    first.value = 7;
    assertEquals((box.items[0] as { get?: () => number } | undefined)?.get?.(), 7);
    assertEquals(exported(box), 7);
  },
);

compilerClosureTest(
  'compileProject syncs exported bag-like object param nested object fields after compiled calls',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Item {',
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
      'type Box = {',
      '  [key: string]: Item;',
      '  child: Item;',
      '};',
      '',
      'export function apply(box: Box): number {',
      '  box.child = new Item(2);',
      '  return box.child.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'apply');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    const first = { value: 1 } as { value: number; get?: () => number };
    const box = {
      child: first as { value: number; get?: () => number },
    };
    assertEquals(exported(box), 2);
    assertStrictEquals(box.child === first, false);
    assertEquals(box.child.get?.(), 2);
  },
);

compilerClosureTest(
  'compileProject keeps same-shape exported class methods distinct across JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  value = 1;',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'class Crate {',
      '  value = 2;',
      '',
      '  get(): number {',
      '    return this.value + 10;',
      '  }',
      '}',
      '',
      'export function makeBox(): Box {',
      '  return new Box();',
      '}',
      '',
      'export function makeCrate(): Crate {',
      '  return new Crate();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);

    const boxExportName = await resolveQualifiedExportName(tempDirectory, 'makeBox');
    const boxExport = instance.exports[boxExportName];
    if (typeof boxExport !== 'function') {
      throw new Error(`Expected exported function "${boxExportName}".`);
    }
    const box = boxExport() as { get: () => number };
    assertEquals(box.get(), 1);

    const crateExportName = await resolveQualifiedExportName(tempDirectory, 'makeCrate');
    const crateExport = instance.exports[crateExportName];
    if (typeof crateExport !== 'function') {
      throw new Error(`Expected exported function "${crateExportName}".`);
    }
    const crate = crateExport() as { get: () => number };
    assertEquals(crate.get(), 12);
    assertEquals(box instanceof (box.constructor as Function), true);
    assertEquals(crate instanceof (crate.constructor as Function), true);
    assertEquals(box instanceof (crate.constructor as Function), false);
    assertEquals(crate instanceof (box.constructor as Function), false);
    assertEquals(box.constructor === crate.constructor, false);
  },
);

compilerClosureTest(
  'compileProject executes class instanceof checks across inheritance and same-shape classes',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {}',
      'class Derived extends Base {}',
      'class Other {}',
      '',
      'export function main(): boolean {',
      '  const BaseAlias = Base;',
      '  const value = new Derived();',
      '  if ((value instanceof Derived) === false) {',
      '    return false;',
      '  }',
      '  if ((value instanceof BaseAlias) === false) {',
      '    return false;',
      '  }',
      '  return (value instanceof Other) === false;',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 1);
  },
);

compilerClosureTest(
  'compileProject passes derived class instances with extra fields through base-typed helper params',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  value = 1;',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  extra = 2;',
      '}',
      '',
      'function read(base: Base): number {',
      '  return base.get();',
      '}',
      '',
      'export function main(): number {',
      '  return read(new Derived());',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 1);
  },
);

compilerClosureTest(
  'compileProject returns derived class instances through base-typed helpers without losing identity',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  value = 1;',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  extra = 2;',
      '}',
      '',
      'function makeBase(): Base {',
      '  return new Derived();',
      '}',
      '',
      'export function main(): number {',
      '  const value = makeBase();',
      '  if ((value instanceof Derived) === false) {',
      '    return 0;',
      '  }',
      '  return value.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 1);
  },
);

compilerClosureTest(
  'compileProject preserves derived identity through exported base-typed class params',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Base {',
      '  value = 1;',
      '',
      '  get(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  extra = 2;',
      '}',
      '',
      'export function makeDerived(): Derived {',
      '  return new Derived();',
      '}',
      '',
      'export function read(base: Base): number {',
      '  if ((base instanceof Derived) === false) {',
      '    return 0;',
      '  }',
      '  return base.get();',
      '}',
      '',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const makeExportName = await resolveQualifiedExportName(tempDirectory, 'makeDerived');
    const makeExport = instance.exports[makeExportName];
    if (typeof makeExport !== 'function') {
      throw new Error(`Expected exported function "${makeExportName}".`);
    }
    const readExportName = await resolveQualifiedExportName(tempDirectory, 'read');
    const readExport = instance.exports[readExportName];
    if (typeof readExport !== 'function') {
      throw new Error(`Expected exported function "${readExportName}".`);
    }
    assertEquals(readExport(makeExport()), 1);
  },
);

compilerClosureTest(
  'compileProject adapts exported nullable class params and results through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
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
      'export function passthrough(box: Box | undefined): Box | undefined {',
      '  if (box === undefined) {',
      '    return undefined;',
      '  }',
      '  if (box.get() < 0) {',
      '    return undefined;',
      '  }',
      '  return box;',
      '}',
      '',
      'export function maybe(flag: number): Box | undefined {',
      '  if (flag === 0) {',
      '    return undefined;',
      '  }',
      '  return new Box(flag);',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const passthrough = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'passthrough')] as (
        box: { value: number; get(): number } | undefined,
      ) => { value: number; get(): number } | undefined;
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      flag: number,
    ) => { value: number; get(): number } | undefined;

    assertEquals(passthrough(undefined), undefined);
    assertEquals(maybe(0), undefined);

    const box = maybe(4);
    if (box === undefined) {
      throw new Error('Expected boxed result for positive flag.');
    }
    assertEquals(box.get(), 4);
    assertStrictEquals(passthrough(box), box);

    const negative = maybe(-1);
    if (negative === undefined) {
      throw new Error('Expected boxed result for negative flag.');
    }
    assertEquals(passthrough(negative), undefined);
  },
);

compilerClosureTest(
  'compileProject adapts exported nullable bag-like object params and results through JS object boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
      'type Bag = Record<string, number>;',
      '',
      'export function passthrough(bag: Bag | null): Bag | null {',
      '  if (bag === null) {',
      '    return null;',
      '  }',
      '  if (bag.count < 0) {',
      '    return null;',
      '  }',
      '  return bag;',
      '}',
      '',
      'export function maybe(flag: number): Bag | null {',
      '  if (flag === 0) {',
      '    return null;',
      '  }',
      '  return { count: 4, extra: 5 };',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const passthrough = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'passthrough')] as (
        bag: Record<string, number> | null,
      ) => Record<string, number> | null;
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      flag: number,
    ) => Record<string, number> | null;
    const bag: Record<string, number> = { count: 2, extra: 9 };

    assertEquals(passthrough(null), null);
    const passed = passthrough(bag);
    assertStrictEquals(passed, bag);
    assertEquals(bag, { count: 2, extra: 9 });
    assertEquals(maybe(0), null);
    assertEquals(maybe(4), { count: 4, extra: 5 });
  },
);

compilerClosureTest(
  'compileProject executes internal class-or-number unions through typeof narrowing',
  async () => {
    const tempDirectory = await createClosureProject([
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
      'function choose(flag: number): Box | number {',
      '  if (flag === 0) {',
      '    return new Box(3);',
      '  }',
      '  return flag + 4;',
      '}',
      '',
      'function read(value: Box | number): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  return value.get();',
      '}',
      '',
      'export function main(flag: number): number {',
      '  return read(choose(flag));',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(0), 3);
    assertEquals(exported(5), 9);
  },
);

compilerClosureTest(
  'compileProject executes internal class-or-number-or-undefined unions through typeof and nullish narrowing',
  async () => {
    const tempDirectory = await createClosureProject([
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
      'function choose(flag: number): Box | number | undefined {',
      '  if (flag === 0) {',
      '    return undefined;',
      '  }',
      '  if (flag === 1) {',
      '    return new Box(4);',
      '  }',
      '  return flag + 6;',
      '}',
      '',
      'function read(value: Box | number | undefined): number {',
      '  if (value === undefined) {',
      '    return 7;',
      '  }',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  return value.get();',
      '}',
      '',
      'export function main(flag: number): number {',
      '  return read(choose(flag));',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(0), 7);
    assertEquals(exported(1), 4);
    assertEquals(exported(5), 11);
  },
);

compilerClosureTest(
  'compileProject executes instanceof checks on internal class-or-number unions',
  async () => {
    const tempDirectory = await createClosureProject([
      'class Box {',
      '  value = 0;',
      '}',
      '',
      'function choose(flag: number): Box | number {',
      '  if (flag === 0) {',
      '    return new Box();',
      '  }',
      '  return flag + 1;',
      '}',
      '',
      'export function main(flag: number): boolean {',
      '  return choose(flag) instanceof Box;',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(0), 1);
    assertEquals(exported(3), 0);
  },
);

compilerClosureTest(
  'compileProject executes closure params and results with internal class-or-number unions',
  async () => {
    const tempDirectory = await createClosureProject([
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
      'function makeChoose(): (flag: number) => Box | number {',
      '  return (flag: number): Box | number => {',
      '    if (flag === 0) {',
      '      return new Box(5);',
      '    }',
      '    return flag + 8;',
      '  };',
      '}',
      '',
      'function makeRead(): (value: Box | number) => number {',
      '  return (value: Box | number): number => {',
      '    if (typeof value === "number") {',
      '      return value;',
      '    }',
      '    return value.get();',
      '  };',
      '}',
      '',
      'export function main(flag: number): number {',
      '  const choose = makeChoose();',
      '  const read = makeRead();',
      '  return read(choose(flag));',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(0), 5);
    assertEquals(exported(4), 12);
  },
);

compilerClosureTest(
  'compileProject adapts exported class-or-number params and results through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
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
      'export function passthrough(value: Box | number): Box | number {',
      '  return value;',
      '}',
      '',
      'export function maybe(flag: number): Box | number {',
      '  if (flag === 0) {',
      '    return new Box(6);',
      '  }',
      '  return flag + 9;',
      '}',
      '',
      'export function read(value: Box | number): number {',
      '  if (typeof value === "number") {',
      '    return value;',
      '  }',
      '  return value.get();',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const passthrough = instance
      .exports[await resolveQualifiedExportName(tempDirectory, 'passthrough')] as (
        value: { value: number; get(): number } | number,
      ) => { value: number; get(): number } | number;
    const maybe = instance.exports[await resolveQualifiedExportName(tempDirectory, 'maybe')] as (
      flag: number,
    ) => { value: number; get(): number } | number;
    const read = instance.exports[await resolveQualifiedExportName(tempDirectory, 'read')] as (
      value: { value: number; get(): number } | number,
    ) => number;

    const box = maybe(0) as { value: number; get(): number };
    assertEquals(box.get(), 6);
    assertStrictEquals(passthrough(box), box);
    assertEquals(passthrough(4), 4);
    assertEquals(read(box), 6);
    assertEquals(read(12), 12);
  },
);

compilerClosureTest(
  'compileProject adapts exported fixed-layout object params and results with class-or-number fields through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
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
      'interface Holder {',
      '  readonly item: Box | number;',
      '}',
      '',
      'export function make(flag: number): Holder {',
      '  if (flag === 0) {',
      '    return { item: new Box(6) };',
      '  }',
      '  return { item: 13 };',
      '}',
      '',
      'export function read(holder: Holder): number {',
      '  if (typeof holder.item === "number") {',
      '    return holder.item;',
      '  }',
      '  return holder.item.get();',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const make = instance.exports[await resolveQualifiedExportName(tempDirectory, 'make')] as (
      flag: number,
    ) => { item: { value: number; get(): number } | number };
    const read = instance.exports[await resolveQualifiedExportName(tempDirectory, 'read')] as (
      holder: { item: { value: number; get(): number } | number },
    ) => number;

    const heapHolder = make(0);
    const inlineHolder = make(4);
    assertEquals((heapHolder.item as { get(): number }).get(), 6);
    assertEquals(inlineHolder.item, 13);
    assertEquals(read(heapHolder), 6);
    assertEquals(read({ item: 12 }), 12);
  },
);

compilerClosureTest(
  'compileProject adapts exported bag-like object params and results with class-or-number properties through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
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
      'interface Holder {',
      '  readonly [key: string]: Box | number;',
      '  readonly item: Box | number;',
      '}',
      '',
      'export function make(flag: number): Holder {',
      '  if (flag === 0) {',
      '    return { item: new Box(6) };',
      '  }',
      '  return { item: 13 };',
      '}',
      '',
      'export function read(holder: Holder): number {',
      '  if (typeof holder.item === "number") {',
      '    return holder.item;',
      '  }',
      '  return holder.item.get();',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const make = instance.exports[await resolveQualifiedExportName(tempDirectory, 'make')] as (
      flag: number,
    ) => { item: { value: number; get(): number } | number };
    const read = instance.exports[await resolveQualifiedExportName(tempDirectory, 'read')] as (
      holder: { item: { value: number; get(): number } | number },
    ) => number;

    const heapHolder = make(0);
    const inlineHolder = make(4);
    assertEquals((heapHolder.item as { get(): number }).get(), 6);
    assertEquals(inlineHolder.item, 13);
    assertEquals(read(heapHolder), 6);
    assertEquals(read({ item: 12 }), 12);
  },
);

compilerClosureTest(
  'compileProject adapts exported fixed-layout object params and results with class-or-number-or-undefined fields through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
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
      'interface Holder {',
      '  readonly item: Box | number | undefined;',
      '}',
      '',
      'export function make(flag: number): Holder {',
      '  if (flag === 0) {',
      '    return { item: new Box(6) };',
      '  }',
      '  if (flag === 1) {',
      '    return { item: 13 };',
      '  }',
      '  return { item: undefined };',
      '}',
      '',
      'export function read(holder: Holder): number {',
      '  if (holder.item === undefined) {',
      '    return -1;',
      '  }',
      '  if (typeof holder.item === "number") {',
      '    return holder.item;',
      '  }',
      '  return holder.item.get();',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const make = instance.exports[await resolveQualifiedExportName(tempDirectory, 'make')] as (
      flag: number,
    ) => { item: { value: number; get(): number } | number | undefined };
    const read = instance.exports[await resolveQualifiedExportName(tempDirectory, 'read')] as (
      holder: { item: { value: number; get(): number } | number | undefined },
    ) => number;

    const heapHolder = make(0);
    const inlineHolder = make(1);
    const missingHolder = make(2);
    assertEquals((heapHolder.item as { get(): number }).get(), 6);
    assertEquals(inlineHolder.item, 13);
    assertEquals(missingHolder.item, undefined);
    assertEquals(read(heapHolder), 6);
    assertEquals(read({ item: 12 }), 12);
    assertEquals(read({ item: undefined }), -1);
  },
);

compilerClosureTest(
  'compileProject adapts exported bag-like object params and results with class-or-number-or-undefined properties through JS boundaries',
  async () => {
    const tempDirectory = await createClosureProject([
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
      'interface Holder {',
      '  readonly [key: string]: Box | number | undefined;',
      '  readonly item: Box | number | undefined;',
      '}',
      '',
      'export function make(flag: number): Holder {',
      '  if (flag === 0) {',
      '    return { item: new Box(6) };',
      '  }',
      '  if (flag === 1) {',
      '    return { item: 13 };',
      '  }',
      '  return { item: undefined };',
      '}',
      '',
      'export function read(holder: Holder): number {',
      '  if (holder.item === undefined) {',
      '    return -1;',
      '  }',
      '  if (typeof holder.item === "number") {',
      '    return holder.item;',
      '  }',
      '  return holder.item.get();',
      '}',
    ].join('\n'));

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const make = instance.exports[await resolveQualifiedExportName(tempDirectory, 'make')] as (
      flag: number,
    ) => { item: { value: number; get(): number } | number | undefined };
    const read = instance.exports[await resolveQualifiedExportName(tempDirectory, 'read')] as (
      holder: { item: { value: number; get(): number } | number | undefined },
    ) => number;

    const heapHolder = make(0);
    const inlineHolder = make(1);
    const missingHolder = make(2);
    assertEquals((heapHolder.item as { get(): number }).get(), 6);
    assertEquals(inlineHolder.item, 13);
    assertEquals(missingHolder.item, undefined);
    assertEquals(read(heapHolder), 6);
    assertEquals(read({ item: 12 }), 12);
    assertEquals(read({ item: undefined }), -1);
  },
);
