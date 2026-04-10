import { assertEquals } from '@std/assert';
import { join } from '@std/path';

import { compileProject } from '../../src/compiler/compile_project.ts';
import {
  createIsolatedTestRegistrar,
  createTempProject,
  instantiateCompiledModuleInJs,
  readWatArtifact,
  resolveQualifiedExportName,
} from '../support/compiler/test_helpers.ts';

const compilerStringTest = createIsolatedTestRegistrar(import.meta.url);

compilerStringTest(
  'compileProject executes owned native case transforms without host case imports',
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
        path: 'src/index.ts',
        contents: [
          'export function upper(text: string): string {',
          '  return text.toUpperCase();',
          '}',
          '',
          'export function lower(text: string): string {',
          '  return text.toLowerCase();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('(import "soundscript_string" "to_upper_case"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "to_lower_case"'), false);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const upperName = await resolveQualifiedExportName(tempDirectory, 'upper');
    const lowerName = await resolveQualifiedExportName(tempDirectory, 'lower');
    const upper = instance.exports[upperName];
    const lower = instance.exports[lowerName];

    if (typeof upper !== 'function') {
      throw new Error(`Expected exported function "${upperName}".`);
    }
    if (typeof lower !== 'function') {
      throw new Error(`Expected exported function "${lowerName}".`);
    }

    assertEquals(upper('ß'), 'SS');
    assertEquals(upper('😀'), '😀');
    assertEquals(lower('ΟΣ'), 'ος');
    assertEquals(lower('ΑΣ\u0301'), 'ας\u0301');
    assertEquals(lower('\uD834'), '\uD834');
  },
);

compilerStringTest(
  'compileProject adapts nullable string case transforms through the owned runtime without host case imports',
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
        path: 'src/index.ts',
        contents: [
          'export function main(flag: boolean, text: string): string | null {',
          '  if (flag) {',
          '    return null;',
          '  }',
          '  return text.toLowerCase();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('(import "soundscript_string" "to_lower_case"'), false);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];

    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(true, 'ΟΣ'), null);
    assertEquals(exported(false, 'ΟΣ'), 'ος');
  },
);

compilerStringTest(
  'compileProject executes compile-time String coercions for primitive literals',
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
        path: 'src/index.ts',
        contents: [
          'export function direct(): string {',
          '  return String(null) + "|" + String(true) + "|" + String(12);',
          '}',
          '',
          'export function viaGlobal(): string {',
          '  return globalThis.String(false) + "|" + globalThis.String();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const directName = await resolveQualifiedExportName(tempDirectory, 'direct');
    const viaGlobalName = await resolveQualifiedExportName(tempDirectory, 'viaGlobal');
    const direct = instance.exports[directName];
    const viaGlobal = instance.exports[viaGlobalName];

    if (typeof direct !== 'function') {
      throw new Error(`Expected exported function "${directName}".`);
    }
    if (typeof viaGlobal !== 'function') {
      throw new Error(`Expected exported function "${viaGlobalName}".`);
    }

    assertEquals(direct(), 'null|true|12');
    assertEquals(viaGlobal(), 'false|');
  },
);

compilerStringTest(
  'compileProject rejects template strings with primitive interpolation',
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
        path: 'src/index.ts',
        contents: [
          'export function main(): string {',
          '  return `${1}:${false}:${null}:${undefined}`;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 1);
    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1022']);
  },
);

compilerStringTest(
  'compileProject scalarizes string length views through structural call boundaries',
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
        path: 'src/index.ts',
        contents: [
          'type StringView = { length: number };',
          '',
          'function consume(value: StringView): number {',
          '  return value.length;',
          '}',
          '',
          'export function main(text: string): number {',
          '  return consume(text);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

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

    assertEquals(exported('ant'), 3);
    assertEquals(exported('😀a'), 3);
  },
);

compilerStringTest(
  'compileProject scalarizes branch-joined string length views through structural locals',
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
        path: 'src/index.ts',
        contents: [
          'type StringView = { length: number };',
          '',
          'export function main(flag: boolean, text: string): number {',
          '  let value: StringView = text;',
          '  if (flag) {',
          '    value = { length: 7 };',
          '  }',
          '  return value.length;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

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

    assertEquals(exported(false, 'ant'), 3);
    assertEquals(exported(true, 'ant'), 7);
  },
);

compilerStringTest(
  'compileProject scalarizes non-exported string length-view helper returns',
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
        path: 'src/index.ts',
        contents: [
          'type StringView = { length: number };',
          '',
          'function build(text: string): StringView {',
          '  return text;',
          '}',
          '',
          'export function main(text: string): number {',
          '  return build(text).length;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

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

    assertEquals(exported('ant'), 3);
    assertEquals(exported('😀a'), 3);
  },
);

compilerStringTest(
  'compileProject keeps ordinary public string observations on the owned path without legacy host string helper imports',
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
        path: 'src/index.ts',
        contents: [
          'export function lengthOf(text: string): number {',
          '  return text.length;',
          '}',
          '',
          'export function charCode(text: string, index: number): number {',
          '  return text.charCodeAt(index);',
          '}',
          '',
          'export function codePoint(text: string, index: number): number | undefined {',
          '  return text.codePointAt(index);',
          '}',
          '',
          'export function starts(text: string, search: string): boolean {',
          '  return text.startsWith(search);',
          '}',
          '',
          'export function ends(text: string, search: string): boolean {',
          '  return text.endsWith(search);',
          '}',
          '',
          'export function contains(text: string, search: string): boolean {',
          '  return text.includes(search);',
          '}',
          '',
          'export function firstIndex(text: string, search: string): number {',
          '  return text.indexOf(search);',
          '}',
          '',
          'export function lastIndex(text: string, search: string): number {',
          '  return text.lastIndexOf(search);',
          '}',
          '',
          'export function combinedLength(left: string, right: string): number {',
          '  return (left + right).length;',
          '}',
          '',
          'export function equal(left: string, right: string): boolean {',
          '  return left === right;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('(import "soundscript_string" "starts_with"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "ends_with"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "includes"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "index_of"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "last_index_of"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "equals"'), false);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const lengthOf = instance.exports[await resolveQualifiedExportName(tempDirectory, 'lengthOf')];
    const charCode = instance.exports[await resolveQualifiedExportName(tempDirectory, 'charCode')];
    const codePoint =
      instance.exports[await resolveQualifiedExportName(tempDirectory, 'codePoint')];
    const starts = instance.exports[await resolveQualifiedExportName(tempDirectory, 'starts')];
    const ends = instance.exports[await resolveQualifiedExportName(tempDirectory, 'ends')];
    const contains = instance.exports[await resolveQualifiedExportName(tempDirectory, 'contains')];
    const firstIndex =
      instance.exports[await resolveQualifiedExportName(tempDirectory, 'firstIndex')];
    const lastIndex =
      instance.exports[await resolveQualifiedExportName(tempDirectory, 'lastIndex')];
    const combinedLength = instance.exports[
      await resolveQualifiedExportName(tempDirectory, 'combinedLength')
    ];
    const equal = instance.exports[await resolveQualifiedExportName(tempDirectory, 'equal')];

    if (
      typeof lengthOf !== 'function' ||
      typeof charCode !== 'function' ||
      typeof codePoint !== 'function' ||
      typeof starts !== 'function' ||
      typeof ends !== 'function' ||
      typeof contains !== 'function' ||
      typeof firstIndex !== 'function' ||
      typeof lastIndex !== 'function' ||
      typeof combinedLength !== 'function' ||
      typeof equal !== 'function'
    ) {
      throw new Error('Expected exported observation functions.');
    }

    assertEquals(lengthOf('😀a'), 3);
    assertEquals(charCode('cab', 1), 97);
    assertEquals(codePoint('😀a', 0), 0x1F600);
    assertEquals(codePoint('abc', 8), undefined);
    assertEquals(starts('alphabet', 'alpha'), 1);
    assertEquals(ends('alphabet', 'bet'), 1);
    assertEquals(contains('alphabet', 'pha'), 1);
    assertEquals(firstIndex('bananas', 'na'), 2);
    assertEquals(lastIndex('bananas', 'na'), 4);
    assertEquals(combinedLength('ab', 'cd'), 4);
    assertEquals(equal('ant', 'ant'), 1);
    assertEquals(equal('ant', 'bee'), 0);
  },
);

compilerStringTest(
  'compileProject keeps ordinary public string-returning transforms off legacy host method imports',
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
        path: 'src/index.ts',
        contents: [
          'export function takeChar(text: string, index: number): string {',
          '  return text.charAt(index);',
          '}',
          '',
          'export function trimBoth(text: string): string {',
          '  return text.trim();',
          '}',
          '',
          'export function trimLeft(text: string): string {',
          '  return text.trimStart();',
          '}',
          '',
          'export function trimRight(text: string): string {',
          '  return text.trimEnd();',
          '}',
          '',
          'export function part(text: string, start: number, end: number): string {',
          '  return text.substring(start, end);',
          '}',
          '',
          'export function segment(text: string, start: number, end: number): string {',
          '  return text.slice(start, end);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('(import "soundscript_string" "char_at"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "trim"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "trim_start"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "trim_end"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "substring"'), false);
    assertEquals(watOutput.includes('(import "soundscript_string" "slice"'), false);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const takeChar = instance.exports[await resolveQualifiedExportName(tempDirectory, 'takeChar')];
    const trimBoth = instance.exports[await resolveQualifiedExportName(tempDirectory, 'trimBoth')];
    const trimLeft = instance.exports[await resolveQualifiedExportName(tempDirectory, 'trimLeft')];
    const trimRight =
      instance.exports[await resolveQualifiedExportName(tempDirectory, 'trimRight')];
    const part = instance.exports[await resolveQualifiedExportName(tempDirectory, 'part')];
    const segment = instance.exports[await resolveQualifiedExportName(tempDirectory, 'segment')];

    if (
      typeof takeChar !== 'function' ||
      typeof trimBoth !== 'function' ||
      typeof trimLeft !== 'function' ||
      typeof trimRight !== 'function' ||
      typeof part !== 'function' ||
      typeof segment !== 'function'
    ) {
      throw new Error('Expected exported string transform functions.');
    }

    assertEquals(takeChar('cat', 1), 'a');
    assertEquals(trimBoth('  ant  '), 'ant');
    assertEquals(trimLeft('  ant  '), 'ant  ');
    assertEquals(trimRight('  ant  '), '  ant');
    assertEquals(part('alphabet', 2, 5), 'pha');
    assertEquals(segment('alphabet', 2, 5), 'pha');
  },
);

compilerStringTest(
  'compileProject scalarizes non-exported string length-view helper returns through helper chaining',
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
        path: 'src/index.ts',
        contents: [
          'type StringView = { length: number };',
          '',
          'function build(text: string): StringView {',
          '  return text;',
          '}',
          '',
          'function consume(value: StringView): number {',
          '  return value.length;',
          '}',
          '',
          'export function main(text: string): number {',
          '  return consume(build(text));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

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

    assertEquals(exported('ant'), 3);
    assertEquals(exported('😀a'), 3);
  },
);

compilerStringTest(
  'compileProject adapts exported structural length-view params through scalarized host boundaries',
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
        path: 'src/index.ts',
        contents: [
          'type LengthView = { length: number };',
          '',
          'export function main(value: LengthView): number {',
          '  return value.length + 1;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

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

    assertEquals(exported('ant'), 4);
    assertEquals(exported([1, 2, 3]), 4);
    assertEquals(exported([true, false]), 3);
    assertEquals(exported({ length: 7 }), 8);
  },
);

compilerStringTest(
  'compileProject adapts exported structural length-view results through scalarized host boundaries',
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
        path: 'src/index.ts',
        contents: [
          'type StringView = { length: number };',
          '',
          'function build(text: string): StringView {',
          '  return text;',
          '}',
          '',
          'export function main(text: string): StringView {',
          '  return build(text);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

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

    assertEquals(exported('ant'), { length: 3 });
    assertEquals(exported('😀a'), { length: 3 });
  },
);

compilerStringTest(
  'compileProject scalarizes imported exported string length-view helpers through .length-only boundaries',
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
          '',
          'export function build(text: string): StringView {',
          '  return text;',
          '}',
          '',
          'export function consume(value: StringView): number {',
          '  return value.length;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { build, consume } from '../../src/helpers';",
          '',
          'export function main(text: string): number {',
          '  return consume(build(text));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('(import "soundscript_length_view" "length"'), true);
    assertEquals(watOutput.includes('(import "soundscript_length_view" "from_length"'), true);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];

    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported('ant'), 3);
    assertEquals(exported('😀a'), 3);
  },
);

compilerStringTest(
  'compileProject scalarizes imported exported object-literal length-view helpers through .length-only boundaries',
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
          'export type LengthView = { length: number };',
          '',
          'export function build(value: number): LengthView {',
          '  return { length: value + 1 };',
          '}',
          '',
          'export function consume(view: LengthView): number {',
          '  return view.length * 2;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { build, consume } from '../../src/helpers';",
          '',
          'export function main(value: number): number {',
          '  return consume(build(value));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('(import "soundscript_length_view" "length"'), true);
    assertEquals(watOutput.includes('(import "soundscript_length_view" "from_length"'), true);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];

    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(3), 8);
  },
);
