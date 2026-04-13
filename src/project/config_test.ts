import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import ts from 'typescript';

import { loadConfig, parseCommand } from '../config.ts';

Deno.test('parseCommand accepts lsp subcommand', () => {
  const command = parseCommand(['lsp'], '/tmp/workspace');

  assertEquals(command, {
    kind: 'lsp',
    workingDirectory: '/tmp/workspace',
  });
});

Deno.test('parseCommand accepts expand subcommand with out-dir', () => {
  const command = parseCommand(
    ['expand', '--project', './tsconfig.json', '--out-dir', './expanded', '--format', 'json'],
    '/tmp/workspace',
  );

  assertEquals(command, {
    filePath: undefined,
    kind: 'expand',
    format: 'json',
    outDir: '/tmp/workspace/expanded',
    projectPath: '/tmp/workspace/tsconfig.json',
    stage: 'expanded',
    target: undefined,
    trace: false,
    workingDirectory: '/tmp/workspace',
  });
});

Deno.test('parseCommand accepts ndjson output format', () => {
  const command = parseCommand(
    ['check', '--project', './tsconfig.json', '--format', 'ndjson'],
    '/tmp/workspace',
  );

  assertEquals(command, {
    kind: 'check',
    format: 'ndjson',
    projectPath: '/tmp/workspace/tsconfig.json',
    target: undefined,
    workingDirectory: '/tmp/workspace',
  });
});

Deno.test('parseCommand accepts build subcommand with out-dir and watch', () => {
  const command = parseCommand(
    ['build', '--project', './tsconfig.json', '--out-dir', './dist-package', '--watch'],
    '/tmp/workspace',
  );

  assertEquals(command, {
    kind: 'build',
    format: 'text',
    outDir: '/tmp/workspace/dist-package',
    projectPath: '/tmp/workspace/tsconfig.json',
    target: undefined,
    watch: true,
    workingDirectory: '/tmp/workspace',
  });
});

Deno.test('parseCommand accepts runtime target override for compile-style commands', () => {
  const checkCommand = parseCommand(
    ['check', '--project', './tsconfig.json', '--target', 'wasm-node'],
    '/tmp/workspace',
  );
  const expandCommand = parseCommand(
    ['expand', '--target', 'js-browser'],
    '/tmp/workspace',
  );

  assertEquals(checkCommand, {
    kind: 'check',
    format: 'text',
    projectPath: '/tmp/workspace/tsconfig.json',
    target: 'wasm-node',
    workingDirectory: '/tmp/workspace',
  });
  assertEquals(expandCommand, {
    filePath: undefined,
    kind: 'expand',
    format: 'text',
    outDir: '/tmp/workspace/soundscript-expanded',
    projectPath: '/tmp/workspace/tsconfig.json',
    stage: 'expanded',
    target: 'js-browser',
    trace: false,
    workingDirectory: '/tmp/workspace',
  });
});

Deno.test('parseCommand rejects removed node subcommand', () => {
  const command = parseCommand(
    ['node', './src/main.sts', '--', 'alpha', 'beta'],
    '/tmp/workspace',
  );

  assertEquals(command, {
    kind: 'invalid',
    message: 'Unknown subcommand: node',
  });
});

Deno.test('parseCommand accepts deno wrapper subcommand with passthrough args', () => {
  const command = parseCommand(
    ['deno', 'run', '--allow-env', './src/main.sts', '--', 'alpha'],
    '/tmp/workspace',
  );

  assertEquals(command, {
    kind: 'deno',
    denoSubcommand: 'run',
    forwardedArgs: ['--allow-env', './src/main.sts', '--', 'alpha'],
    workingDirectory: '/tmp/workspace',
  });
});

Deno.test('parseCommand rejects --watch outside build', () => {
  const command = parseCommand(
    ['check', '--watch'],
    '/tmp/workspace',
  );

  assertEquals(command, {
    kind: 'invalid',
    message: '--watch is only supported for build.',
  });
});

Deno.test('parseCommand rejects --target outside build, check, compile, and expand', () => {
  const command = parseCommand(
    ['init', '--target', 'wasm-node'],
    '/tmp/workspace',
  );

  assertEquals(command, {
    kind: 'invalid',
    message: '--target is not supported for init.',
  });
});

Deno.test('parseCommand accepts explain subcommand with a diagnostic code', () => {
  const command = parseCommand(
    ['explain', 'sound1002', '--format', 'json'],
    '/tmp/workspace',
  );

  assertEquals(command, {
    kind: 'explain',
    code: 'SOUND1002',
    format: 'json',
  });
});

Deno.test('loadConfig parses soundscript runtime target and rejects removed extern packs', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-config-runtime-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  await Deno.writeTextFile(
    projectPath,
    JSON.stringify(
      {
        compilerOptions: {
          module: 'ESNext',
          target: 'ES2022',
        },
        soundscript: {
          target: 'wasm-node',
          externs: ['deno', 'deno', 42],
        },
      },
      null,
      2,
    ),
  );

  const loadedConfig = loadConfig(projectPath);

  assertEquals(loadedConfig.soundscript, {
    include: [],
    target: 'wasm-node',
  });
  assertEquals(loadedConfig.runtime, {
    backend: 'wasm',
    host: 'node',
    target: 'wasm-node',
  });
  assertEquals(loadedConfig.commandLine.options.lib, ['lib.es2024.d.ts']);
  assertEquals(loadedConfig.diagnostics.length >= 1, true);
  assertEquals(
    loadedConfig.diagnostics.some((diagnostic) =>
      String(diagnostic.messageText).includes('soundscript.externs')
    ),
    true,
  );
});

Deno.test('loadConfig applies runtime target overrides over tsconfig soundscript settings', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-config-override-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  await Deno.writeTextFile(
    projectPath,
    JSON.stringify(
      {
        compilerOptions: {
          module: 'ESNext',
          target: 'ES2022',
        },
        soundscript: {
          target: 'js-node',
        },
      },
      null,
      2,
    ),
  );

  const loadedConfig = loadConfig(projectPath, { target: 'wasm-browser' });

  assertEquals(loadedConfig.soundscript, {
    include: [],
    target: 'wasm-browser',
  });
  assertEquals(loadedConfig.runtime, {
    backend: 'wasm',
    host: 'browser',
    target: 'wasm-browser',
  });
});

Deno.test('loadConfig applies ES-only default libs when compilerOptions.lib is omitted', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-config-libs-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  await Deno.writeTextFile(
    projectPath,
    JSON.stringify(
      {
        compilerOptions: {
          module: 'ESNext',
          target: 'ES2022',
        },
      },
      null,
      2,
    ),
  );

  const jsNodeConfig = loadConfig(projectPath);
  const wasmWasiConfig = loadConfig(projectPath, { target: 'wasm-wasi' });

  assertEquals(jsNodeConfig.commandLine.options.lib, ['lib.es2024.d.ts']);
  assertEquals(wasmWasiConfig.commandLine.options.lib, ['lib.es2024.d.ts']);
  assertEquals(jsNodeConfig.commandLine.options.types, ['node']);
  assertEquals(wasmWasiConfig.commandLine.options.types, undefined);
});

Deno.test('loadConfig preserves explicit compilerOptions.lib over runtime defaults', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-config-explicit-lib-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  await Deno.writeTextFile(
    projectPath,
    JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022'],
          module: 'ESNext',
          target: 'ES2022',
        },
      },
      null,
      2,
    ),
  );

  const loadedConfig = loadConfig(projectPath, { target: 'wasm-wasi' });

  assertEquals(loadedConfig.commandLine.options.lib, ['lib.es2022.d.ts']);
});

Deno.test('loadConfig preserves explicit compilerOptions.types over runtime defaults', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-config-explicit-types-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  await Deno.writeTextFile(
    projectPath,
    JSON.stringify(
      {
        compilerOptions: {
          module: 'ESNext',
          target: 'ES2022',
          types: [],
        },
      },
      null,
      2,
    ),
  );

  const loadedConfig = loadConfig(projectPath);

  assertEquals(loadedConfig.commandLine.options.types, []);
});

Deno.test('loadConfig always enables JSX emit for soundscript programs', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-config-jsx-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  await Deno.mkdir(join(tempDirectory, 'src'), { recursive: true });
  await Deno.writeTextFile(join(tempDirectory, 'src/main.sts'), 'export const main = 1;\n');
  await Deno.writeTextFile(
    projectPath,
    JSON.stringify(
      {
        compilerOptions: {
          jsx: 'preserve',
          module: 'ESNext',
          target: 'ES2022',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
  );

  const loadedConfig = loadConfig(projectPath);

  assertEquals(loadedConfig.commandLine.options.jsx, ts.JsxEmit.ReactJSX);
});

Deno.test('loadConfig preserves pure TypeScript compiler options when no soundscript roots are present', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-config-pure-ts-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  await Deno.mkdir(join(tempDirectory, 'src'), { recursive: true });
  await Deno.writeTextFile(join(tempDirectory, 'src/index.ts'), 'export const value = 1;\n');
  await Deno.writeTextFile(
    projectPath,
    JSON.stringify(
      {
        compilerOptions: {
          experimentalDecorators: true,
          jsx: 'preserve',
          module: 'ESNext',
          strict: false,
          target: 'ES2022',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );

  const loadedConfig = loadConfig(projectPath);

  assertEquals(loadedConfig.commandLine.options.experimentalDecorators, true);
  assertEquals(loadedConfig.commandLine.options.jsx, ts.JsxEmit.Preserve);
  assertEquals(loadedConfig.commandLine.options.strict, false);
});

Deno.test('loadConfig parses soundscript.include and treats matching TypeScript files as soundscript roots', async () => {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-config-include-' });
  const projectPath = join(tempDirectory, 'tsconfig.json');
  await Deno.mkdir(join(tempDirectory, 'src'), { recursive: true });
  await Deno.writeTextFile(join(tempDirectory, 'src/index.ts'), 'export const value = 1;\n');
  await Deno.writeTextFile(join(tempDirectory, 'src/view.tsx'), 'export const view = <div />;\n');
  await Deno.writeTextFile(join(tempDirectory, 'src/types.d.ts'), 'export interface Value {}\n');
  await Deno.writeTextFile(join(tempDirectory, 'src/helper.js'), 'export const helper = 1;\n');
  await Deno.writeTextFile(
    projectPath,
    JSON.stringify(
      {
        compilerOptions: {
          jsx: 'preserve',
          module: 'ESNext',
          strict: false,
          target: 'ES2022',
        },
        include: ['src/**/*'],
        soundscript: {
          include: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.d.ts', 'src/**/*.js'],
        },
      },
      null,
      2,
    ),
  );

  const loadedConfig = loadConfig(projectPath);

  assertEquals(loadedConfig.soundscript.include, ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.d.ts', 'src/**/*.js']);
  assertEquals(
    loadedConfig.soundscriptRootNames,
    [
      join(tempDirectory, 'src/index.ts'),
      join(tempDirectory, 'src/view.tsx'),
    ],
  );
  assertEquals(loadedConfig.commandLine.options.jsx, ts.JsxEmit.ReactJSX);
  assertEquals(loadedConfig.commandLine.options.strict, true);
});
