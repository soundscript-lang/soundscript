import { assertEquals, assertStringIncludes } from '@std/assert';
import { join } from '@std/path';

import { compileProject } from './compiler/compile_project.ts';
import {
  createIsolatedTestRegistrar,
  createTempProject,
  instantiateCompiledModuleInJs,
  lowerTempProjectToCompilerIR,
  readWatArtifact,
  resolveQualifiedExportName,
} from './compiler_test_helpers.ts';

const compilerTaggedTest = createIsolatedTestRegistrar(import.meta.url);

compilerTaggedTest(
  'compileProject adapts exported nullable string returns through owned helper flows',
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
          'function helper(text: string): string {',
          '  return text.trim();',
          '}',
          '',
          'export function main(flag: boolean, text: string): string | null {',
          '  if (flag) {',
          '    return null;',
          '  }',
          '  return helper(text);',
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
    assertStringIncludes(watOutput, '(func $main__export (export "src/index.ts:main")');
    assertStringIncludes(watOutput, '(param $text externref)');
    assertStringIncludes(watOutput, 'call $string_to_owned');
    assertStringIncludes(watOutput, '(local $result__host_tagged (ref null $tagged_value))');
    assertStringIncludes(watOutput, 'call $owned_string_to_host');
    assertEquals(watOutput.includes('call $tagged_string_to_host'), false);
  },
);

compilerTaggedTest(
  'lowerProgramToCompilerIR routes exported nullable string returns through tagged host result metadata',
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
          'export function main(flag: boolean, text: string): string | undefined {',
          '  if (flag) {',
          '    return undefined;',
          '  }',
          '  return text.trim();',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const [main] = lowerTempProjectToCompilerIR(tempDirectory).functions;

    assertEquals(main.resultType, 'tagged_ref');
    assertEquals(main.hostTaggedPrimitiveResultKinds, {
      includesBoolean: undefined,
      includesNull: undefined,
      includesNumber: undefined,
      includesString: true,
      includesUndefined: true,
    });
  },
);

compilerTaggedTest(
  'lowerProgramToCompilerIR routes exported nullable string params and returns through tagged host boundary metadata',
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
          'export function main(value: string | null | undefined): string | null | undefined {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const [main] = lowerTempProjectToCompilerIR(tempDirectory).functions;

    assertEquals(main.params[0]?.type, 'tagged_ref');
    assertEquals(main.resultType, 'tagged_ref');
    assertEquals(main.hostTaggedPrimitiveParams, [{
      name: 'value',
      includesBoolean: undefined,
      includesNull: true,
      includesNumber: undefined,
      includesString: true,
      includesUndefined: true,
    }]);
    assertEquals(main.hostTaggedPrimitiveResultKinds, {
      includesBoolean: undefined,
      includesNull: true,
      includesNumber: undefined,
      includesString: true,
      includesUndefined: true,
    });
  },
);

compilerTaggedTest(
  'compileProject keeps nullable string tagged host boundaries on string-only pay-for-play helpers',
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
          'export function main(value: string | null | undefined): string | null | undefined {',
          '  return value;',
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
    assertStringIncludes(watOutput, '(func $main__export (export "src/index.ts:main")');
    assertStringIncludes(watOutput, 'call $tagged_type_tag');
    assertStringIncludes(watOutput, 'call $tag_string');
    assertStringIncludes(watOutput, 'call $untag_owned_string');
    assertStringIncludes(watOutput, 'call $string_to_owned');
    assertStringIncludes(watOutput, 'call $owned_string_to_host');
    assertEquals(watOutput.includes('call $tagged_number_value'), false);
    assertEquals(watOutput.includes('call $tagged_boolean_value'), false);
    assertEquals(watOutput.includes('call $tagged_from_number'), false);
    assertEquals(watOutput.includes('call $tagged_from_boolean'), false);
  },
);

compilerTaggedTest(
  'compileProject executes tagged string params after typeof narrowing without early untagging',
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
          'export function main(value: number | string): number {',
          '  if (typeof value !== "string") {',
          '    return 0;',
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

    assertEquals(exported(7), 0);
    assertEquals(exported('abc'), 3);
  },
);

compilerTaggedTest(
  'compileProject aliases tagged string params once across repeated owned helper calls',
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
          'function helper(text: string): number {',
          '  return text.length;',
          '}',
          '',
          'export function main(value: number | string): number {',
          '  if (typeof value !== "string") {',
          '    return 0;',
          '  }',
          '  return helper(value) + helper(value);',
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
    assertEquals((watOutput.match(/call \$untag_owned_string/g) ?? []).length, 1);
  },
);

compilerTaggedTest(
  'compileProject adapts owned string returns at each public return branch without duplicate branch-local work',
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
          'function helper(text: string): string {',
          '  return text.trim();',
          '}',
          '',
          'export function main(flag: boolean, text: string): string {',
          '  if (flag) {',
          '    return helper(text);',
          '  }',
          '  return helper(text);',
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
    assertEquals((watOutput.match(/call \$owned_string_to_host/g) ?? []).length, 2);
  },
);

compilerTaggedTest(
  'compileProject executes mixed primitive roundtrips through imported helpers and exported tagged boundaries',
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
          'export function identity(value: number | string | boolean | null | undefined): number | string | boolean | null | undefined {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { identity } from './helpers';",
          '',
          'export function main(value: number | string | boolean | null | undefined): number | string | boolean | null | undefined {',
          '  return identity(value);',
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

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const helper = moduleIR.functions.find((func) => func.name === 'identity');
    const main = moduleIR.functions.find((func) => func.name === 'main');
    assertEquals(helper?.params[0]?.type, 'tagged_ref');
    assertEquals(helper?.resultType, 'tagged_ref');
    assertEquals(main?.hostTaggedPrimitiveParams, [{
      name: 'value',
      includesBoolean: true,
      includesNull: true,
      includesNumber: true,
      includesString: true,
      includesUndefined: true,
    }]);
    assertEquals(main?.hostTaggedPrimitiveResultKinds, {
      includesBoolean: true,
      includesNull: true,
      includesNumber: true,
      includesString: true,
      includesUndefined: true,
    });
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, 'call $tagged_type_tag');
    assertStringIncludes(watOutput, 'call $tag_string');
    assertStringIncludes(watOutput, 'call $untag_owned_string');
    assertStringIncludes(watOutput, 'call $tagged_number_value');
    assertStringIncludes(watOutput, 'call $tagged_boolean_value');
    assertStringIncludes(watOutput, 'call $tagged_from_number');
    assertStringIncludes(watOutput, 'call $tagged_from_boolean');

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(7), 7);
    assertEquals(exported('abc'), 'abc');
    assertEquals(exported(true), true);
    assertEquals(exported(false), false);
    assertEquals(exported(null), null);
    assertEquals(exported(undefined), undefined);
  },
);

compilerTaggedTest(
  'compileProject executes boolean nullish roundtrips through imported helpers and exported tagged boundaries',
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
          'export function identity(value: boolean | null | undefined): boolean | null | undefined {',
          '  return value;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { identity } from './helpers';",
          '',
          'export function main(value: boolean | null | undefined): boolean | null | undefined {',
          '  if (value === null || value === undefined) {',
          '    return value;',
          '  }',
          '  return identity(value);',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const helper = moduleIR.functions.find((func) => func.name === 'identity');
    const main = moduleIR.functions.find((func) => func.name === 'main');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(helper?.params[0]?.type, 'tagged_ref');
    assertEquals(helper?.resultType, 'tagged_ref');
    assertEquals(main?.hostTaggedPrimitiveParams, [{
      name: 'value',
      includesBoolean: true,
      includesNull: true,
      includesNumber: undefined,
      includesString: undefined,
      includesUndefined: true,
    }]);
    assertEquals(main?.hostTaggedPrimitiveResultKinds, {
      includesBoolean: true,
      includesNull: true,
      includesNumber: undefined,
      includesString: undefined,
      includesUndefined: true,
    });

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }

    assertEquals(exported(true), true);
    assertEquals(exported(false), false);
    assertEquals(exported(null), null);
    assertEquals(exported(undefined), undefined);
  },
);
