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

Deno.test(
  'analyzeProject invalidates narrowing for conservative fresh-local builder paths',
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
        'let observed = 0;',
        '',
        'function mutateOuter(): void {',
        '  observed += 1;',
        '}',
        '',
        'class MyMap extends Map<string, number> {',
        '  override set(key: string, value: number): this {',
        '    mutateOuter();',
        '    return super.set(key, value);',
        '  }',
        '}',
        '',
        'function useStored(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const map = new Map<string, number>();',
        '    const holders: [Map<string, number>] = [map];',
        '    holders[0].set("value", 1);',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'function useSubclass(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const map: Map<string, number> = new MyMap();',
        '    map.set("value", 1);',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'void useStored({ value: "ok" });',
        'void useSubclass({ value: "ok" });',
        '',
      ].join('\n'),
    });

    const result = await analyzeProject({
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    });

    assertEquals(result.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1020',
      'SOUND1020',
    ]);
  },
);

Deno.test(
  'analyzeProject preserves narrowing for accepted fresh-local builder paths',
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
        'function useRecord(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const record = { count: 0 };',
        '    const out = record;',
        '    out.count = 1;',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'function useArray(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const values = [0];',
        '    const out = values;',
        '    out[0] = 1;',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'function useMap(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const map = new Map<string, number>();',
        '    const out = map;',
        '    out.set("value", 1);',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'function useSet(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const values = new Set<number>();',
        '    const out = values;',
        '    out.add(1);',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'function useWeakMap(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const key = {};',
        '    const values = new WeakMap<object, number>();',
        '    const out = values;',
        '    out.set(key, 1);',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'function useWeakSet(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const key = {};',
        '    const values = new WeakSet<object>();',
        '    const out = values;',
        '    out.add(key);',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'function useParams(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const params = new URLSearchParams();',
        '    const out = params;',
        '    out.set("q", "music");',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'function useHeaders(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const headers = new Headers();',
        '    const out = headers;',
        '    out.set("accept", "application/json");',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'function useFormData(box: { value: string | null }): string {',
        '  if (box.value !== null) {',
        '    const data = new FormData();',
        '    const out = data;',
        '    out.append("q", "music");',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
        'void useRecord({ value: "ok" });',
        'void useArray({ value: "ok" });',
        'void useMap({ value: "ok" });',
        'void useSet({ value: "ok" });',
        'void useWeakMap({ value: "ok" });',
        'void useWeakSet({ value: "ok" });',
        'void useParams({ value: "ok" });',
        'void useHeaders({ value: "ok" });',
        'void useFormData({ value: "ok" });',
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
