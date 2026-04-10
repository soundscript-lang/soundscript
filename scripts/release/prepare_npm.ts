import { basename, dirname, join, relative } from '@std/path';
import ts from 'typescript';

import { getStdlibDeclarationTexts } from '../../src/frontend/std_package_support.ts';
import { rewriteModuleSpecifiersForEmit } from '../../src/runtime/transform.ts';
import {
  BUNDLED_TYPESCRIPT_SOURCE,
  CANONICAL_DIST,
  CANONICAL_PACKAGE_NAME,
  CLI_ENTRY,
  CLI_TARGETS,
  type CliTarget,
  DIST_ROOT,
  LICENSE_SOURCE,
  parseVersion,
  ROOT,
  SHIM_DIST,
  SOUNDSCRIPT_HOMEPAGE_URL,
  SOUNDSCRIPT_ISSUES_URL,
  SOUNDSCRIPT_REPOSITORY_URL,
  SOURCE_ONLY_RUNTIME_MODULES,
  STABLE_RUNTIME_MODULES,
  STDLIB_SOURCE,
} from './npm_manifest.ts';
import { smokeTestCliBinary } from './cli_smoke.ts';

const PROJECT_TRANSFORM_DIST = join(CANONICAL_DIST, 'project-transform');
const PROJECT_TRANSFORM_SOURCE = join(ROOT, 'src');

function requireFile(path: string, label: string): void {
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Missing required ${label} at ${path}.`);
    }
    throw error;
  }

  if (!stat.isFile) {
    throw new Error(`Expected ${label} to be a file: ${path}.`);
  }
}

function requireDirectory(path: string, label: string): void {
  let stat: Deno.FileInfo;
  try {
    stat = Deno.statSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Missing required ${label} at ${path}.`);
    }
    throw error;
  }

  if (!stat.isDirectory) {
    throw new Error(`Expected ${label} to be a directory: ${path}.`);
  }
}

function verifyReleaseInputs(): void {
  requireFile(CLI_ENTRY, 'CLI entrypoint');
  requireFile(LICENSE_SOURCE, 'LICENSE');
  requireDirectory(BUNDLED_TYPESCRIPT_SOURCE, 'bundled TypeScript libraries');
  requireDirectory(STDLIB_SOURCE, 'stdlib sources');
}

async function emptyDirectory(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true }).catch(() => undefined);
  await Deno.mkdir(path, { recursive: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyDirectory(sourcePath: string, destinationPath: string): Promise<void> {
  await Deno.mkdir(destinationPath, { recursive: true });

  for await (const entry of Deno.readDir(sourcePath)) {
    const sourceEntryPath = join(sourcePath, entry.name);
    const destinationEntryPath = join(destinationPath, entry.name);

    if (entry.isDirectory) {
      await copyDirectory(sourceEntryPath, destinationEntryPath);
    } else if (entry.isFile) {
      await Deno.copyFile(sourceEntryPath, destinationEntryPath);
    }
  }
}

async function copyLicense(destinationPath: string): Promise<void> {
  await Deno.copyFile(LICENSE_SOURCE, join(destinationPath, 'LICENSE'));
}

export async function copyCliRuntimeSupportFiles(destinationRoot: string): Promise<void> {
  await copyDirectory(
    BUNDLED_TYPESCRIPT_SOURCE,
    join(destinationRoot, 'src', 'bundled', 'typescript'),
  );
  const bundledDestination = join(destinationRoot, 'src', 'bundled');
  await Deno.mkdir(bundledDestination, { recursive: true });
  for await (const entry of Deno.readDir(join(ROOT, 'src', 'bundled'))) {
    if (!entry.isFile || !entry.name.endsWith('.d.ts')) {
      continue;
    }

    await Deno.copyFile(
      join(ROOT, 'src', 'bundled', entry.name),
      join(bundledDestination, entry.name),
    );
  }
  const stdlibDestination = join(destinationRoot, 'src', 'stdlib');
  await Deno.mkdir(stdlibDestination, { recursive: true });
  for (const [filePath, text] of getStdlibDeclarationTexts().entries()) {
    await Deno.writeTextFile(join(stdlibDestination, basename(filePath)), text);
  }
}

function transpileToEsm(sourceText: string, fileName: string): string {
  const result = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  });
  return result.outputText.trimEnd() + '\n';
}

interface TranspiledEsmArtifact {
  code: string;
  mapText: string;
}

function transpileToEsmWithSourceMap(
  sourceText: string,
  fileName: string,
  outputPath: string,
  sourceMapSourcePath: string,
): TranspiledEsmArtifact {
  const result = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ES2020,
      target: ts.ScriptTarget.ES2020,
      sourceMap: true,
      inlineSources: true,
    },
    fileName,
  });
  const codeWithoutSourceMapComment = result.outputText
    .replace(/\n?\/\/# sourceMappingURL=.*$/u, '')
    .trimEnd();
  const sourceMap = JSON.parse(result.sourceMapText ?? '{}') as {
    file?: string;
    sources?: string[];
    sourcesContent?: string[];
  };
  sourceMap.file = basename(outputPath);
  sourceMap.sources = [sourceMapSourcePath];
  sourceMap.sourcesContent = [sourceText];

  return {
    code: `${codeWithoutSourceMapComment}\n//# sourceMappingURL=${basename(outputPath)}.map\n`,
    mapText: `${JSON.stringify(sourceMap)}\n`,
  };
}

async function writeTextFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}

function publishedJavaScriptPath(destinationPath: string): string {
  if (destinationPath.endsWith('.d.ts')) {
    return destinationPath;
  }
  if (destinationPath.endsWith('.tsx')) {
    return `${destinationPath.slice(0, -4)}.js`;
  }
  if (
    destinationPath.endsWith('.ts') || destinationPath.endsWith('.mts') ||
    destinationPath.endsWith('.cts')
  ) {
    return `${destinationPath.slice(0, destinationPath.lastIndexOf('.'))}.js`;
  }
  return destinationPath;
}

function shouldPublishProjectTransformSource(relativePath: string): boolean {
  return !(
    relativePath === 'bun_plugin.ts' ||
    relativePath === 'register.ts' ||
    relativePath === 'vite.ts' ||
    relativePath === 'webpack_loader.ts' ||
    relativePath.endsWith('_test.ts') ||
    relativePath.endsWith('_test.tsx') ||
    relativePath.endsWith('_test.mts') ||
    relativePath.endsWith('_test.cts')
  );
}

async function copyProjectTransformSourceDirectory(
  sourceDirectory: string,
  destinationDirectory: string,
): Promise<void> {
  await Deno.mkdir(destinationDirectory, { recursive: true });

  for await (const entry of Deno.readDir(sourceDirectory)) {
    const sourcePath = join(sourceDirectory, entry.name);
    const relativePath = relative(PROJECT_TRANSFORM_SOURCE, sourcePath);
    if (!shouldPublishProjectTransformSource(relativePath)) {
      continue;
    }

    const destinationPath = join(destinationDirectory, entry.name);
    if (entry.isDirectory) {
      await copyProjectTransformSourceDirectory(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile) {
      continue;
    }

    if (entry.name.endsWith('.d.ts')) {
      await Deno.copyFile(sourcePath, destinationPath);
      continue;
    }

    if (
      entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ||
      entry.name.endsWith('.mts') || entry.name.endsWith('.cts')
    ) {
      const sourceText = await Deno.readTextFile(sourcePath);
      await writeTextFile(destinationPath, sourceText);
      await writeTextFile(
        publishedJavaScriptPath(destinationPath),
        rewriteModuleSpecifiersForEmit(
          transpileToEsm(sourceText, sourcePath),
          publishedJavaScriptPath(sourcePath),
        ),
      );
      continue;
    }

    await Deno.copyFile(sourcePath, destinationPath);
  }
}

async function prepareProjectTransformPackage(): Promise<void> {
  await emptyDirectory(PROJECT_TRANSFORM_DIST);
  await copyProjectTransformSourceDirectory(
    PROJECT_TRANSFORM_SOURCE,
    join(PROJECT_TRANSFORM_DIST, 'src'),
  );

  const projectTransformIndexSource = [
    "export { createOnDemandTransformer } from './src/runtime/on_demand.ts';",
    'export type {',
    '  OnDemandTransformer,',
    '  OnDemandTransformResult,',
    '  OnDemandTransformerOptions,',
    '  SyncOnDemandTransformer,',
    "} from './src/runtime/on_demand.ts';",
    "export { inlineSourceMapComment } from './src/runtime/source_maps.ts';",
    '',
  ].join('\n');
  await writeTextFile(join(PROJECT_TRANSFORM_DIST, 'index.ts'), projectTransformIndexSource);
  await writeTextFile(
    join(PROJECT_TRANSFORM_DIST, 'index.js'),
    rewriteModuleSpecifiersForEmit(
      transpileToEsm(projectTransformIndexSource, join(PROJECT_TRANSFORM_DIST, 'index.ts')),
      join(PROJECT_TRANSFORM_DIST, 'index.js'),
    ),
  );
}

async function writeTranspiledModule(
  outputPath: string,
  sourcePath: string,
  sourceText: string,
  sourceMapSourcePath: string,
): Promise<void> {
  const artifact = transpileToEsmWithSourceMap(
    sourceText,
    sourcePath,
    outputPath,
    sourceMapSourcePath,
  );
  await writeTextFile(
    outputPath,
    rewriteModuleSpecifiersForEmit(artifact.code, outputPath),
  );
  await writeTextFile(`${outputPath}.map`, artifact.mapText);
}

async function prepareStdlibPackage(version: string): Promise<void> {
  await emptyDirectory(CANONICAL_DIST);
  await Deno.mkdir(join(CANONICAL_DIST, 'experimental'), { recursive: true });
  await Deno.mkdir(join(CANONICAL_DIST, 'soundscript', 'experimental'), { recursive: true });
  await Deno.mkdir(join(CANONICAL_DIST, 'bin'), { recursive: true });

  const stdlibDeclarationsByBaseName = new Map(
    [...getStdlibDeclarationTexts().entries()].map(([filePath, text]) =>
      [basename(filePath), text] as const
    ),
  );
  const rootSource = rewriteModuleSpecifiersForEmit(
    Deno.readTextFileSync(join(ROOT, 'src', 'stdlib', 'index.ts')),
    join(ROOT, 'src', 'stdlib', 'index.ts'),
    { moduleSpecifierMode: 'source-sts' },
  );
  const rootDeclarations = rewriteModuleSpecifiersForEmit(
    stdlibDeclarationsByBaseName.get('index.d.ts') ??
      (() => {
        throw new Error('Missing generated stdlib declaration for index.d.ts.');
      })(),
    join(ROOT, 'src', 'stdlib', 'index.d.ts'),
  );
  const rootSourcePath = join(CANONICAL_DIST, 'soundscript', 'index.sts');

  await writeTextFile(rootSourcePath, rootSource);
  await writeTranspiledModule(
    join(CANONICAL_DIST, 'index.js'),
    rootSourcePath,
    rootSource,
    './soundscript/index.sts',
  );
  await writeTextFile(join(CANONICAL_DIST, 'index.d.ts'), rootDeclarations);

  for (const moduleName of STABLE_RUNTIME_MODULES) {
    const sourcePath = join(ROOT, 'src', 'stdlib', `${moduleName}.ts`);
    const rewrittenSource = rewriteModuleSpecifiersForEmit(
      Deno.readTextFileSync(sourcePath),
      sourcePath,
      { moduleSpecifierMode: 'source-sts' },
    );
    const rewrittenDeclarations = rewriteModuleSpecifiersForEmit(
      stdlibDeclarationsByBaseName.get(`${moduleName}.d.ts`) ??
        (() => {
          throw new Error(`Missing generated stdlib declaration for ${moduleName}.d.ts.`);
        })(),
      join(ROOT, 'src', 'stdlib', `${moduleName}.d.ts`),
    );
    const publishedSourcePath = join(CANONICAL_DIST, 'soundscript', `${moduleName}.sts`);
    await writeTextFile(publishedSourcePath, rewrittenSource);
    await writeTranspiledModule(
      join(CANONICAL_DIST, `${moduleName}.js`),
      publishedSourcePath,
      rewrittenSource,
      `./soundscript/${moduleName}.sts`,
    );
    await writeTextFile(
      join(CANONICAL_DIST, `${moduleName}.d.ts`),
      rewrittenDeclarations,
    );
  }

  for (const moduleName of SOURCE_ONLY_RUNTIME_MODULES) {
    const sourcePath = join(ROOT, 'src', 'stdlib', `${moduleName}.ts`);
    const rewrittenSource = rewriteModuleSpecifiersForEmit(
      Deno.readTextFileSync(sourcePath),
      sourcePath,
      { moduleSpecifierMode: 'source-sts' },
    );
    const rewrittenDeclarations = rewriteModuleSpecifiersForEmit(
      stdlibDeclarationsByBaseName.get(`${moduleName}.d.ts`) ??
        (() => {
          throw new Error(`Missing generated stdlib declaration for ${moduleName}.d.ts.`);
        })(),
      join(ROOT, 'src', 'stdlib', `${moduleName}.d.ts`),
    );
    const publishedSourcePath = join(
      CANONICAL_DIST,
      'soundscript',
      'experimental',
      `${moduleName}.sts`,
    );
    await writeTextFile(publishedSourcePath, rewrittenSource);
    await writeTranspiledModule(
      join(CANONICAL_DIST, 'experimental', `${moduleName}.js`),
      publishedSourcePath,
      rewrittenSource,
      `../soundscript/experimental/${moduleName}.sts`,
    );
    await writeTextFile(
      join(CANONICAL_DIST, 'experimental', `${moduleName}.d.ts`),
      rewrittenDeclarations,
    );
  }
  await Deno.writeTextFile(
    join(CANONICAL_DIST, 'bin', 'soundscript.js'),
    createCliLauncherSource(),
  );
  await Deno.chmod(join(CANONICAL_DIST, 'bin', 'soundscript.js'), 0o755);

  await Deno.writeTextFile(
    join(CANONICAL_DIST, 'README.md'),
    [
      '# @soundscript/soundscript',
      '',
      'Canonical Soundscript toolchain and runtime package.',
      '',
      'This package provides:',
      '',
      '- the `soundscript` CLI launcher',
      '- stable runtime and TypeScript interop modules under `@soundscript/soundscript/*`',
      '- source-published `.sts` modules and declarations for checker/editor package discovery',
      '- the canonical package identity for built Soundscript libraries',
      '',
    ].join('\n'),
  );
  await copyLicense(CANONICAL_DIST);

  const runtimeExports = Object.fromEntries(
    [
      ['.', { types: './index.d.ts', import: './index.js' }],
      [
        './project-transform',
        {
          types: './project-transform/index.ts',
          import: './project-transform/index.js',
          default: './project-transform/index.js',
        },
      ],
      ...STABLE_RUNTIME_MODULES.map((moduleName) => [
        `./${moduleName}`,
        {
          types: `./${moduleName}.d.ts`,
          import: `./${moduleName}.js`,
        },
      ]),
    ],
  );
  const soundscriptExports = Object.fromEntries(
    [
      ['.', { source: './soundscript/index.sts' }],
      ...STABLE_RUNTIME_MODULES.map((moduleName) => [
        `./${moduleName}`,
        { source: `./soundscript/${moduleName}.sts` },
      ]),
    ],
  );
  await prepareProjectTransformPackage();

  await writeJson(join(CANONICAL_DIST, 'package.json'), {
    name: CANONICAL_PACKAGE_NAME,
    version,
    license: 'ISC',
    type: 'module',
    sideEffects: false,
    types: './index.d.ts',
    bin: {
      soundscript: './bin/soundscript.js',
    },
    soundscript: {
      version: 1,
      exports: soundscriptExports,
    },
    exports: runtimeExports,
    files: [
      'LICENSE',
      'README.md',
      'bin/**',
      'experimental/**',
      'index.js',
      'index.js.map',
      'index.d.ts',
      'project-transform/**',
      ...STABLE_RUNTIME_MODULES.flatMap((moduleName) => [
        `${moduleName}.js`,
        `${moduleName}.js.map`,
        `${moduleName}.d.ts`,
      ]),
      'soundscript/**',
    ],
    dependencies: {
      typescript: '5.9.3',
    },
    optionalDependencies: Object.fromEntries(
      CLI_TARGETS.map((target) => [target.packageName, version]),
    ),
    repository: {
      type: 'git',
      url: SOUNDSCRIPT_REPOSITORY_URL,
    },
    homepage: SOUNDSCRIPT_HOMEPAGE_URL,
    bugs: {
      url: SOUNDSCRIPT_ISSUES_URL,
    },
  });
}

function createCliLauncherSource(): string {
  const targetMap = Object.fromEntries(
    CLI_TARGETS.map((target) => [
      `${target.os[0]}-${target.cpu[0]}`,
      {
        executableName: target.executableName,
        packageName: target.packageName,
      },
    ]),
  );
  const supportedTargets = Object.keys(targetMap).sort();

  return [
    '#!/usr/bin/env node',
    "import { spawnSync } from 'node:child_process';",
    "import { createRequire } from 'node:module';",
    "import { dirname, join } from 'node:path';",
    '',
    'const require = createRequire(import.meta.url);',
    `const TARGETS = ${JSON.stringify(targetMap, null, 2)};`,
    `const SUPPORTED_TARGETS = ${JSON.stringify(supportedTargets)};`,
    '',
    'const key = `${process.platform}-${process.arch}`;',
    'const target = TARGETS[key];',
    'if (!target) {',
    '  console.error(`soundscript does not publish a prebuilt CLI for ${key}.`);',
    '  console.error(`Supported platforms: ${SUPPORTED_TARGETS.join(", ")}.`);',
    '  process.exit(1);',
    '}',
    '',
    'let packageJsonPath;',
    'try {',
    '  packageJsonPath = require.resolve(`${target.packageName}/package.json`);',
    '} catch (_error) {',
    '  console.error(`soundscript could not find the installed binary package ${target.packageName}. Reinstall the package for this platform.`);',
    '  console.error("Try `npm install soundscript --include=optional` or install the platform package directly.");',
    '  process.exit(1);',
    '}',
    '',
    "const executablePath = join(dirname(packageJsonPath), 'bin', target.executableName);",
    "const result = spawnSync(executablePath, process.argv.slice(2), { stdio: 'inherit' });",
    'if (result.error) {',
    '  console.error(result.error instanceof Error ? result.error.message : String(result.error));',
    '  process.exit(1);',
    '}',
    'process.exit(result.status === null ? 1 : result.status);',
    '',
  ].join('\n');
}

async function prepareCliPackage(version: string): Promise<void> {
  await emptyDirectory(SHIM_DIST);
  await Deno.mkdir(join(SHIM_DIST, 'bin'), { recursive: true });
  await Deno.writeTextFile(
    join(SHIM_DIST, 'bin', 'soundscript.js'),
    [
      '#!/usr/bin/env node',
      "import { spawnSync } from 'node:child_process';",
      "import { createRequire } from 'node:module';",
      "import { dirname, join } from 'node:path';",
      '',
      'const require = createRequire(import.meta.url);',
      'let packageJsonPath;',
      'try {',
      `  packageJsonPath = require.resolve('${CANONICAL_PACKAGE_NAME}/package.json');`,
      '} catch (_error) {',
      `  console.error('soundscript could not find the installed canonical package ${CANONICAL_PACKAGE_NAME}.');`,
      '  process.exit(1);',
      '}',
      '',
      "const launcherPath = join(dirname(packageJsonPath), 'bin', 'soundscript.js');",
      "const result = spawnSync(process.execPath, [launcherPath, ...process.argv.slice(2)], { stdio: 'inherit' });",
      'if (result.error) {',
      '  console.error(result.error instanceof Error ? result.error.message : String(result.error));',
      '  process.exit(1);',
      '}',
      'process.exit(result.status === null ? 1 : result.status);',
      '',
    ].join('\n'),
  );
  await Deno.chmod(join(SHIM_DIST, 'bin', 'soundscript.js'), 0o755);
  await Deno.writeTextFile(
    join(SHIM_DIST, 'index.js'),
    `export * from '${CANONICAL_PACKAGE_NAME}';\n`,
  );
  await Deno.writeTextFile(
    join(SHIM_DIST, 'index.d.ts'),
    `export * from '${CANONICAL_PACKAGE_NAME}';\n`,
  );
  for (const moduleName of STABLE_RUNTIME_MODULES) {
    await Deno.writeTextFile(
      join(SHIM_DIST, `${moduleName}.js`),
      `export * from '${CANONICAL_PACKAGE_NAME}/${moduleName}';\n`,
    );
    await Deno.writeTextFile(
      join(SHIM_DIST, `${moduleName}.d.ts`),
      `export * from '${CANONICAL_PACKAGE_NAME}/${moduleName}';\n`,
    );
  }
  await Deno.writeTextFile(
    join(SHIM_DIST, 'README.md'),
    [
      '# soundscript',
      '',
      'Convenience shim package that forwards to `@soundscript/soundscript`.',
      '',
      'Use `@soundscript/soundscript` as the canonical runtime and library peer dependency.',
      '',
    ].join('\n'),
  );
  await copyLicense(SHIM_DIST);

  const shimExports = Object.fromEntries(
    [
      ['.', { types: './index.d.ts', import: './index.js' }],
      ...STABLE_RUNTIME_MODULES.map((moduleName) => [
        `./${moduleName}`,
        {
          types: `./${moduleName}.d.ts`,
          import: `./${moduleName}.js`,
        },
      ]),
    ],
  );

  await writeJson(join(SHIM_DIST, 'package.json'), createShimPackageManifest(version, shimExports));
}

export function createShimPackageManifest(
  version: string,
  exports = Object.fromEntries(
    [
      ['.', { types: './index.d.ts', import: './index.js' }],
      ...STABLE_RUNTIME_MODULES.map((moduleName) => [
        `./${moduleName}`,
        {
          types: `./${moduleName}.d.ts`,
          import: `./${moduleName}.js`,
        },
      ]),
    ],
  ),
) {
  return {
    name: 'soundscript',
    version,
    license: 'ISC',
    type: 'module',
    bin: {
      soundscript: './bin/soundscript.js',
    },
    exports,
    files: [
      'LICENSE',
      'README.md',
      'bin/**',
      'index.js',
      'index.d.ts',
      ...STABLE_RUNTIME_MODULES.flatMap((moduleName) => [
        `${moduleName}.js`,
        `${moduleName}.d.ts`,
      ]),
    ],
    dependencies: {
      [CANONICAL_PACKAGE_NAME]: version,
    },
    repository: {
      type: 'git',
      url: SOUNDSCRIPT_REPOSITORY_URL,
    },
    homepage: SOUNDSCRIPT_HOMEPAGE_URL,
    bugs: {
      url: SOUNDSCRIPT_ISSUES_URL,
    },
  };
}

function toNodeCpu(arch: string): string | undefined {
  if (arch === 'aarch64') {
    return 'arm64';
  }
  if (arch === 'x86_64') {
    return 'x64';
  }
  return undefined;
}

function isHostTarget(target: CliTarget): boolean {
  const nodeCpu = toNodeCpu(Deno.build.arch);
  return nodeCpu !== undefined && target.os.includes(Deno.build.os) && target.cpu.includes(nodeCpu);
}

export function buildCliCompileArgs(outputPath: string, target: string): string[] {
  return [
    'compile',
    '--node-modules-dir=none',
    '--allow-env',
    '--allow-read',
    '--allow-run',
    '--allow-write',
    '--output',
    outputPath,
    '--target',
    target,
    CLI_ENTRY,
  ];
}

async function compileCliTarget(version: string, target: CliTarget): Promise<void> {
  const targetDirectory = join(DIST_ROOT, target.id);
  await emptyDirectory(targetDirectory);
  await Deno.mkdir(join(targetDirectory, 'bin'), { recursive: true });
  await copyCliRuntimeSupportFiles(targetDirectory);

  const outputPath = join(targetDirectory, 'bin', target.executableName);
  const command = new Deno.Command('deno', {
    args: buildCliCompileArgs(outputPath, target.target),
    cwd: ROOT,
    stderr: 'inherit',
    stdout: 'inherit',
  });
  const child = command.spawn();
  const result = await child.status;
  if (!result.success) {
    throw new Error(`Failed to compile ${target.packageName}.`);
  }
  if (isHostTarget(target)) {
    await smokeTestCliBinary(outputPath, version);
  }

  await Deno.writeTextFile(
    join(targetDirectory, 'README.md'),
    [
      `# ${target.packageName}`,
      '',
      `Prebuilt Soundscript CLI binary for ${target.os.join('/')} ${target.cpu.join('/')}.`,
      '',
    ].join('\n'),
  );
  await copyLicense(targetDirectory);

  await writeJson(
    join(targetDirectory, 'package.json'),
    createCliTargetPackageManifest(version, target),
  );
}

export function createCliTargetPackageManifest(version: string, target: CliTarget) {
  return {
    name: target.packageName,
    version,
    license: 'ISC',
    os: [...target.os],
    cpu: [...target.cpu],
    files: [
      'LICENSE',
      'README.md',
      'bin/**',
      'src/bundled/*.d.ts',
      'src/bundled/typescript/**',
      'src/stdlib/**',
    ],
    repository: {
      type: 'git',
      url: SOUNDSCRIPT_REPOSITORY_URL,
    },
    homepage: SOUNDSCRIPT_HOMEPAGE_URL,
    bugs: {
      url: SOUNDSCRIPT_ISSUES_URL,
    },
  };
}

async function main(): Promise<void> {
  const stdlibOnly = Deno.args.includes('--stdlib-only');
  const version = parseVersion();
  verifyReleaseInputs();

  await Deno.mkdir(DIST_ROOT, { recursive: true });
  await prepareStdlibPackage(version);

  if (stdlibOnly) {
    return;
  }

  await prepareCliPackage(version);
  for (const target of CLI_TARGETS) {
    await compileCliTarget(version, target);
  }
}

if (import.meta.main) {
  await main();
}
