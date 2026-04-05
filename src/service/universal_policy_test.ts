import { assertEquals } from '@std/assert';
import { dirname, join } from '@std/path';

import { analyzeProject } from '../checker/analyze_project.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../test_installed_stdlib.ts';

async function createTempProject(files: Readonly<Record<string, string>>): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-ts-universal-policy-' });

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(tempDirectory, relativePath);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(
      absolutePath,
      maybeNormalizeTsconfigForInstalledStdlib(relativePath, contents),
    );
  }

  await writeInstalledStdlibPackage(tempDirectory);
  return tempDirectory;
}

async function analyzeCodes(files: Readonly<Record<string, string>>): Promise<string[]> {
  const tempDirectory = await createTempProject(files);
  const result = await analyzeProject({
    projectPath: join(tempDirectory, 'tsconfig.json'),
    workingDirectory: tempDirectory,
  });
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

const LOCAL_PROJECTS = [
  {
    extension: 'sts',
    include: ['src/**/*.sts'],
    label: 'sound',
  },
  {
    extension: 'ts',
    include: ['src/**/*.ts'],
    label: 'typescript',
  },
] as const;

const RECEIVER_CASES = [
  {
    code: 'class-method-assignment',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'const extracted = box.read;',
      'void extracted;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-destructuring',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'const { read } = box;',
      'void read;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-bind',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'const bound = box.read.bind(box);',
      'void bound;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-return',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'function forward(): unknown {',
      '  return box.read;',
      '}',
      '',
      'void forward;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-tuple',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'const pair = [box.read] as const;',
      'void pair;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-readonly-array',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'const values: readonly unknown[] = [box.read];',
      'void values;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-readonly-tuple',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'const values: readonly [unknown] = [box.read];',
      'void values;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-object-property',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'const holder = { read: box.read };',
      'void holder;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-export',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'export const extracted = box.read;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-call',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'box.read.call(box);',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-apply',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'box.read.apply(box, []);',
      '',
    ].join('\n'),
  },
  {
    code: 'class-method-reflect-apply',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'Reflect.apply(box.read, box, []);',
      '',
    ].join('\n'),
  },
  {
    code: 'object-method-argument',
    source: [
      'function consume(value: unknown): void {',
      '  void value;',
      '}',
      '',
      'const box = {',
      '  value: 1,',
      '  read(): number {',
      '    return this.value;',
      '  },',
      '};',
      '',
      'consume(box.read);',
      '',
    ].join('\n'),
  },
  {
    code: 'object-method-assignment',
    source: [
      'const box = {',
      '  value: 1,',
      '  read(): number {',
      '    return this.value;',
      '  },',
      '};',
      '',
      'const extracted = box.read;',
      'void extracted;',
      '',
    ].join('\n'),
  },
] as const;

const TYPESCRIPT_ONLY_RECEIVER_CASES = [
  {
    code: 'explicit-this-function-value',
    source: [
      'class Box {',
      '  value = 1;',
      '}',
      '',
      'function read(this: Box): number {',
      '  return this.value;',
      '}',
      '',
      'const extracted = read;',
      'void extracted;',
      '',
    ].join('\n'),
  },
  {
    code: 'imported-explicit-this-function-value',
    source: [
      'import { read } from "./lib";',
      '',
      'const extracted = read;',
      'void extracted;',
      '',
    ].join('\n'),
    extraFiles: {
      'src/lib.ts': [
        'export class Box {',
        '  value = 1;',
        '}',
        '',
        'export function read(this: Box): number {',
        '  return this.value;',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    code: 'inline-import-explicit-this-function-value',
    source: [
      'export {};',
      '',
      'const extracted: typeof import("./lib").read = (await import("./lib")).read;',
      'void extracted;',
      '',
    ].join('\n'),
    extraFiles: {
      'src/lib.ts': [
        'export class Box {',
        '  value = 1;',
        '}',
        '',
        'export function read(this: Box): number {',
        '  return this.value;',
        '}',
        '',
      ].join('\n'),
    },
  },
  {
    code: 'explicit-this-function-bind',
    source: [
      'class Box {',
      '  value = 1;',
      '}',
      '',
      'function read(this: Box): number {',
      '  return this.value;',
      '}',
      '',
      'const box = new Box();',
      'const rebound = read.bind(box);',
      'void rebound;',
      '',
    ].join('\n'),
  },
] as const;

const LIFECYCLE_CASES = [
  {
    code: 'constructor-method-dispatch',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '',
      '  constructor() {',
      '    this.read();',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'constructor-this-escape',
    source: [
      'function consume(value: unknown): void {',
      '  void value;',
      '}',
      '',
      'class Box {',
      '  constructor() {',
      '    consume(this);',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'constructor-alias-method-dispatch',
    source: [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '',
      '  constructor() {',
      '    const self = this;',
      '    self.read();',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'constructor-return-this',
    source: [
      'class Box {',
      '  constructor() {',
      '    return this;',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'field-initializer-read-before-init',
    source: [
      'class Box {',
      '  first = this.second;',
      '  second = 1;',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'branch-read-before-init',
    source: [
      'class Box {',
      '  value: number;',
      '',
      '  constructor(flag: boolean) {',
      '    if (flag) {',
      '      this.value = 1;',
      '    }',
      '',
      '    const exact: number = this.value;',
      '    this.value = 2;',
      '    void exact;',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'alias-read-before-init',
    source: [
      'class Box {',
      '  value: number;',
      '',
      '  constructor() {',
      '    const self = this;',
      '    const exact: number = self.value;',
      '    self.value = 1;',
      '    void exact;',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'loop-read-before-init',
    source: [
      'class Box {',
      '  value: number;',
      '',
      '  constructor(values: readonly number[]) {',
      '    for (const current of values) {',
      '      this.value = current;',
      '    }',
      '',
      '    const exact: number = this.value;',
      '    void exact;',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'captured-this-closure-escape',
    source: [
      'function consume(callback: () => number): void {',
      '  void callback;',
      '}',
      '',
      'class Box {',
      '  value = 1;',
      '',
      '  constructor() {',
      '    consume(() => this.value);',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'constructor-accessor-dispatch',
    source: [
      'class Box {',
      '  value = 1;',
      '  get current(): number {',
      '    return this.value;',
      '  }',
      '',
      '  constructor() {',
      '    const exact = this.current;',
      '    void exact;',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'constructor-property-storage-this-escape',
    source: [
      'class Box {',
      '  constructor() {',
      '    const holder: { current?: unknown } = {};',
      '    holder.current = this;',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'early-return-read-before-init',
    source: [
      'class Box {',
      '  value: number;',
      '',
      '  constructor(flag: boolean) {',
      '    if (flag) {',
      '      this.value = 1;',
      '      return;',
      '    }',
      '',
      '    const exact: number = this.value;',
      '    void exact;',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
] as const;

const TYPESCRIPT_ONLY_LIFECYCLE_CASES = [
  {
    code: 'super-method-dispatch',
    source: [
      'class Base {',
      '  read(): number {',
      '    return 1;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  constructor() {',
      '    super();',
      '    super.read();',
      '  }',
      '}',
      '',
      'void Derived;',
      '',
    ].join('\n'),
  },
  {
    code: 'captured-this-closure-call',
    source: [
      'class Box {',
      '  value: number;',
      '',
      '  constructor() {',
      '    const later = () => this.value;',
      '    this.value = 1;',
      '    later();',
      '  }',
      '}',
      '',
      'void Box;',
      '',
    ].join('\n'),
  },
  {
    code: 'super-accessor-dispatch',
    source: [
      'class Base {',
      '  get value(): number {',
      '    return 1;',
      '  }',
      '}',
      '',
      'class Derived extends Base {',
      '  constructor() {',
      '    super();',
      '    const exact = super.value;',
      '    void exact;',
      '  }',
      '}',
      '',
      'void Derived;',
      '',
    ].join('\n'),
  },
] as const;

const PROTOTYPE_CASES = [
  {
    code: 'class-prototype-assignment',
    source: [
      'class Box {',
      '  read(): number {',
      '    return 1;',
      '  }',
      '}',
      '',
      'Box.prototype.read = function () {',
      '  return 2;',
      '};',
      '',
    ].join('\n'),
  },
  {
    code: 'class-prototype-define-property',
    source: [
      'class Box {',
      '  read(): number {',
      '    return 1;',
      '  }',
      '}',
      '',
      'Object.defineProperty(Box.prototype, "read", {',
      '  value() {',
      '    return 2;',
      '  },',
      '});',
      '',
    ].join('\n'),
  },
  {
    code: 'class-prototype-set-prototype-of',
    source: [
      'class Box {}',
      '',
      'Object.setPrototypeOf(Box.prototype, null);',
      '',
    ].join('\n'),
  },
  {
    code: 'class-instance-reflect-set-prototype-of',
    source: [
      'class Box {}',
      '',
      'const box = new Box();',
      'Reflect.setPrototypeOf(box, null);',
      '',
    ].join('\n'),
  },
  {
    code: 'class-expression-prototype-assignment',
    source: [
      'const Box = class {',
      '  read(): number {',
      '    return 1;',
      '  }',
      '};',
      '',
      'Box.prototype.read = function () {',
      '  return 2;',
      '};',
      '',
    ].join('\n'),
  },
  {
    code: 'class-prototype-alias-assignment',
    source: [
      'class Box {',
      '  read(): number {',
      '    return 1;',
      '  }',
      '}',
      '',
      'const proto = Box.prototype;',
      'proto.read = function () {',
      '  return 2;',
      '};',
      '',
    ].join('\n'),
  },
  {
    code: 'class-prototype-computed-alias-assignment',
    source: [
      'class Box {',
      '  read(): number {',
      '    return 1;',
      '  }',
      '}',
      '',
      'const proto = Box["prototype"];',
      'proto.read = function () {',
      '  return 2;',
      '};',
      '',
    ].join('\n'),
  },
  {
    code: 'class-prototype-set-prototype-of-apply-wrapper',
    source: [
      'class Box {}',
      '',
      'Reflect.setPrototypeOf.apply(Reflect, [Box.prototype, null]);',
      '',
    ].join('\n'),
  },
  {
    code: 'class-instance-proto-write',
    expectedCodes: ['TS2339'],
    source: [
      'class Box {}',
      '',
      'const box = new Box();',
      'box.__proto__ = null;',
      '',
    ].join('\n'),
  },
  {
    code: 'class-instance-reflect-set-prototype-of-apply',
    source: [
      'class Box {}',
      '',
      'const box = new Box();',
      'Reflect.setPrototypeOf.apply(Reflect, [box, null]);',
      '',
    ].join('\n'),
  },
] as const;

for (const project of LOCAL_PROJECTS) {
  for (const testCase of RECEIVER_CASES) {
    Deno.test(
      `universal policy rejects receiver extraction in ${project.label} ${testCase.code}`,
      async () => {
        const codes = await analyzeCodes({
          'tsconfig.json': JSON.stringify(
            {
              compilerOptions: {
                strict: true,
                noEmit: true,
                target: 'ES2022',
                module: 'ESNext',
              },
              include: project.include,
            },
            null,
            2,
          ),
          [`src/index.${project.extension}`]: testCase.source,
        });

        assertEquals(codes.includes('SOUND1035'), true);
      },
    );
  }

  for (const testCase of LIFECYCLE_CASES) {
    Deno.test(
      `universal policy rejects lifecycle hazard in ${project.label} ${testCase.code}`,
      async () => {
        const codes = await analyzeCodes({
          'tsconfig.json': JSON.stringify(
            {
              compilerOptions: {
                strict: true,
                noEmit: true,
                target: 'ES2022',
                module: 'ESNext',
              },
              include: project.include,
            },
            null,
            2,
          ),
          [`src/index.${project.extension}`]: testCase.source,
        });

        assertEquals(codes.some((code) => code === 'SOUND1036' || code === 'SOUND1037'), true);
      },
    );
  }

  for (const testCase of PROTOTYPE_CASES) {
    Deno.test(
      `universal policy rejects class prototype mutation in ${project.label} ${testCase.code}`,
      async () => {
        const codes = await analyzeCodes({
          'tsconfig.json': JSON.stringify(
            {
              compilerOptions: {
                strict: true,
                noEmit: true,
                target: 'ES2022',
                module: 'ESNext',
              },
              include: project.include,
            },
            null,
            2,
          ),
          [`src/index.${project.extension}`]: testCase.source,
      });

        const expectedCodes = 'expectedCodes' in testCase
          ? testCase.expectedCodes
          : ['SOUND1022'];
        assertEquals(
          codes.some((code) => expectedCodes.includes(code)),
          true,
        );
      },
    );
  }
}

for (const testCase of TYPESCRIPT_ONLY_RECEIVER_CASES) {
  Deno.test(
    `universal policy rejects receiver extraction in typescript ${testCase.code}`,
    async () => {
      const codes = await analyzeCodes({
        'tsconfig.json': JSON.stringify(
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
        'src/index.ts': testCase.source,
        ...('extraFiles' in testCase ? testCase.extraFiles : {}),
      });

      assertEquals(codes.includes('SOUND1035'), true);
    },
  );
}

for (const testCase of TYPESCRIPT_ONLY_LIFECYCLE_CASES) {
  Deno.test(
    `universal policy rejects lifecycle hazard in typescript ${testCase.code}`,
    async () => {
      const codes = await analyzeCodes({
        'tsconfig.json': JSON.stringify(
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
        'src/index.ts': testCase.source,
      });

      assertEquals(codes.some((code) => code === 'SOUND1036' || code === 'SOUND1037'), true);
    },
  );
}

Deno.test(
  'universal policy rejects receiver extraction in source-published package roots',
  async () => {
    const codes = await analyzeCodes({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        "import { value } from 'receiver-pkg';",
        'void value;',
        '',
      ].join('\n'),
      'node_modules/receiver-pkg/package.json': JSON.stringify(
        {
          name: 'receiver-pkg',
          version: '1.0.0',
          type: 'module',
          types: './dist/index.d.ts',
          soundscript: {
            source: './src/index.sts',
          },
        },
        null,
        2,
      ),
      'node_modules/receiver-pkg/dist/index.d.ts': [
        'export declare const value: unknown;',
        '',
      ].join('\n'),
      'node_modules/receiver-pkg/src/index.sts': [
        'class Box {',
        '  value = 1;',
        '  read(): number {',
        '    return this.value;',
        '  }',
        '}',
        '',
        'const box = new Box();',
        'export const value = box.read;',
        '',
      ].join('\n'),
    });

    assertEquals(codes.includes('SOUND1035'), true);
  },
);

Deno.test(
  'universal policy rejects lifecycle hazards in source-published package subpaths',
  async () => {
    const codes = await analyzeCodes({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        "import { Box } from 'lifecycle-pkg/sub';",
        'void Box;',
        '',
      ].join('\n'),
      'node_modules/lifecycle-pkg/package.json': JSON.stringify(
        {
          name: 'lifecycle-pkg',
          version: '1.0.0',
          type: 'module',
          exports: {
            './sub': {
              types: './dist/sub.d.ts',
              default: './dist/sub.js',
            },
          },
          soundscript: {
            exports: {
              './sub': {
                source: './src/sub.sts',
              },
            },
          },
        },
        null,
        2,
      ),
      'node_modules/lifecycle-pkg/dist/sub.d.ts': [
        'export declare class Box {}',
        '',
      ].join('\n'),
      'node_modules/lifecycle-pkg/dist/sub.js': 'export class Box {}\n',
      'node_modules/lifecycle-pkg/src/sub.sts': [
        'export class Box {',
        '  value: number;',
        '',
        '  constructor() {',
        '    const exact: number = this.value;',
        '    this.value = 1;',
        '    void exact;',
        '  }',
        '}',
        '',
      ].join('\n'),
    });

    assertEquals(codes.includes('SOUND1037'), true);
  },
);

Deno.test(
  'universal policy rejects class prototype mutation in source-published package roots',
  async () => {
    const codes = await analyzeCodes({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
      'src/index.ts': [
        "import { Box } from 'prototype-pkg';",
        'void Box;',
        '',
      ].join('\n'),
      'node_modules/prototype-pkg/package.json': JSON.stringify(
        {
          name: 'prototype-pkg',
          version: '1.0.0',
          type: 'module',
          types: './dist/index.d.ts',
          soundscript: {
            source: './src/index.sts',
          },
        },
        null,
        2,
      ),
      'node_modules/prototype-pkg/dist/index.d.ts': [
        'export declare class Box {}',
        '',
      ].join('\n'),
      'node_modules/prototype-pkg/src/index.sts': [
        'export class Box {',
        '  read(): number {',
        '    return 1;',
        '  }',
        '}',
        '',
        'Box.prototype.read = function () {',
        '  return 2;',
        '};',
        '',
      ].join('\n'),
    });

    assertEquals(codes.includes('SOUND1022'), true);
  },
);
