import { assertEquals } from '@std/assert';
import { dirname, join } from '@std/path';

import { analyzeProject } from './analyze_project.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../test_installed_stdlib.ts';

async function createTempProject(files: Readonly<Record<string, string>>): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-flow-regression-' });

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

Deno.test(
  'analyzeProject does not overflow on self-recursive bound member calls during flow invalidation',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'function use(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const api = {',
        '      run(): void {',
        '        api.run();',
        '      },',
        '    };',
        '    api.run();',
        '    return box.value;',
        '  }',
        '  return "";',
        '}',
        '',
        'void use({ value: "ok" });',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);

Deno.test(
  'analyzeProject does not overflow on mutually recursive flow call summaries',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'function a(box: { value: string }): { value: string } {',
        '  return b(box);',
        '}',
        '',
        'function b(box: { value: string }): { value: string } {',
        '  return a(box);',
        '}',
        '',
        'const result = a({ value: "ok" });',
        'const exact: string = result.value;',
        'void exact;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);

Deno.test(
  'analyzeProject does not overflow on recursive callbacks passed as opaque arguments',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'type Jsonish = string | Jsonish[];',
        '',
        'function normalize(value: Jsonish): Jsonish {',
        '  if (Array.isArray(value)) {',
        '    return value.map((nestedValue): Jsonish => normalize(nestedValue));',
        '  }',
        '  return value;',
        '}',
        '',
        'const result = normalize(["ok", ["nested"]]);',
        'void result;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);

Deno.test(
  'analyzeProject does not overflow on recursive callbacks with local aliasing',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/index.sts': [
        'type Jsonish = string | Jsonish[];',
        '',
        'function normalize(value: Jsonish, scope: Record<string, unknown>): Jsonish {',
        '  if (Array.isArray(value)) {',
        '    return value.map((nestedValue): Jsonish => {',
        '      const resolvedValue = normalize(nestedValue, scope);',
        '      return resolvedValue;',
        '    });',
        '  }',
        '  return value;',
        '}',
        '',
        'const result = normalize(["ok", ["nested"]], {});',
        'void result;',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), []);
  },
);
