import { assertEquals, assertStringIncludes } from '@std/assert';
import { dirname, fromFileUrl, join } from '@std/path';

import {
  buildCliCompileArgs,
  copyCliRuntimeSupportFiles,
  createCliTargetPackageManifest,
  createShimPackageManifest,
} from './prepare_npm.ts';
import { CLI_TARGETS, parseVersion } from './npm_manifest.ts';

const ROOT = join(dirname(fromFileUrl(import.meta.url)), '..', '..');
const VERSION = parseVersion(ROOT);
const TYPESCRIPT_CLI_PATH = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

async function writeProjectFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const filePath = join(root, relativePath);
  await Deno.mkdir(dirname(filePath), { recursive: true }).catch(() => undefined);
  await Deno.writeTextFile(filePath, contents);
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<{ stderr: string; stdout: string; success: boolean }> {
  const result = await new Deno.Command(command, {
    args: [...args],
    cwd: options.cwd,
    env: options.env,
    stderr: 'piped',
    stdout: 'piped',
  }).output();
  return {
    stderr: new TextDecoder().decode(result.stderr),
    stdout: new TextDecoder().decode(result.stdout),
    success: result.success,
  };
}

async function prepareCanonicalTarball(
  distPrefix: string,
): Promise<{ canonicalRoot: string; distRoot: string; tarballPath: string }> {
  const distRoot = await Deno.makeTempDir({ prefix: distPrefix });
  const prepareResult = await runCommand(
    'deno',
    ['run', '-A', 'scripts/release/prepare_npm.ts', '--stdlib-only'],
    {
      cwd: ROOT,
      env: {
        SOUNDSCRIPT_RELEASE_DIST_ROOT: distRoot,
      },
    },
  );
  assertEquals(
    prepareResult.success,
    true,
    `prepare_npm.ts failed.\nstdout:\n${prepareResult.stdout}\nstderr:\n${prepareResult.stderr}`,
  );

  const canonicalRoot = join(distRoot, 'soundscript-canonical');
  const packResult = await runCommand('npm', ['pack', '--silent'], { cwd: canonicalRoot });
  assertEquals(
    packResult.success,
    true,
    `npm pack failed.\nstdout:\n${packResult.stdout}\nstderr:\n${packResult.stderr}`,
  );
  const tarballName = packResult.stdout.trim().split('\n').at(-1);
  assertEquals(typeof tarballName, 'string');
  return {
    canonicalRoot,
    distRoot,
    tarballPath: join(canonicalRoot, tarballName!),
  };
}

async function installNpmTarballs(
  projectRoot: string,
  tarballPaths: readonly string[],
): Promise<void> {
  const installResult = await runCommand(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--prefer-offline',
      '--legacy-peer-deps',
      ...tarballPaths,
    ],
    { cwd: projectRoot },
  );
  assertEquals(
    installResult.success,
    true,
    `npm install failed.\nstdout:\n${installResult.stdout}\nstderr:\n${installResult.stderr}`,
  );
}

async function writeAdapterMacroProject(projectRoot: string): Promise<void> {
  await writeProjectFile(
    projectRoot,
    'package.json',
    JSON.stringify(
      {
        name: 'adapter-entrypoint-smoke',
        private: true,
        type: 'module',
      },
      null,
      2,
    ),
  );
  await writeProjectFile(
    projectRoot,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
  );
  await writeProjectFile(projectRoot, 'src/helper.sts', 'export const helper = 21;\n');
  await writeProjectFile(
    projectRoot,
    'src/macros.macro.sts',
    [
      "import { macroSignature } from 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function Twice() {',
      '  return {',
      '    signature: macroSignature.of(macroSignature.expr("value")),',
      '    expand(ctx: any, signature: any) {',
      '      if (!signature) {',
      "        throw new Error('expected signature');",
      '      }',
      '      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );
  await writeProjectFile(
    projectRoot,
    'src/main.sts',
    [
      "import { Twice } from './macros.macro';",
      "import { helper } from './helper';",
      'export const doubled = Twice(helper);',
      '',
    ].join('\n'),
  );
}

async function writeHostAccessMacroProject(projectRoot: string): Promise<void> {
  await writeProjectFile(
    projectRoot,
    'package.json',
    JSON.stringify(
      {
        name: 'project-transform-host-smoke',
        private: true,
        type: 'module',
      },
      null,
      2,
    ),
  );
  await writeProjectFile(
    projectRoot,
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
  );
  await writeProjectFile(projectRoot, 'src/macros/data.txt', 'from-file\n');
  await writeProjectFile(
    projectRoot,
    'src/macros/defs.macro.sts',
    [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function Foo() {',
      '  return {',
      '    expand(ctx: any) {',
      "      const envValue = ctx.host.env.require('STS_MACRO_TEST_VALUE');",
      "      const fileValue = ctx.host.fs.readText('./data.txt', { base: 'macro' }).trim();",
      '      return ctx.output.expr(ctx.build.stringLiteral(`${envValue}:${fileValue}`));',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
  );
  await writeProjectFile(
    projectRoot,
    'src/main.sts',
    [
      "import { Foo } from './macros/defs.macro';",
      'export const value = Foo();',
      '',
    ].join('\n'),
  );
}

Deno.test('prepare_npm --stdlib-only emits canonical package source maps and .sts sources', async () => {
  const distRoot = await Deno.makeTempDir({ prefix: 'soundscript-prepare-npm-' });
  const command = new Deno.Command('deno', {
    args: ['run', '-A', 'scripts/release/prepare_npm.ts', '--stdlib-only'],
    cwd: ROOT,
    env: {
      SOUNDSCRIPT_RELEASE_DIST_ROOT: distRoot,
    },
    stderr: 'piped',
    stdout: 'piped',
  });
  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  assertEquals(
    result.success,
    true,
    `prepare_npm.ts failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );

  const canonicalRoot = join(distRoot, 'soundscript-canonical');
  const publishedSource = await Deno.readTextFile(
    join(canonicalRoot, 'soundscript', 'result.sts'),
  );
  const publishedTypeclassesSource = await Deno.readTextFile(
    join(canonicalRoot, 'soundscript', 'typeclasses.sts'),
  );
  const publishedJsonSource = await Deno.readTextFile(
    join(canonicalRoot, 'soundscript', 'json.sts'),
  );
  const publishedJsonRuntime = await Deno.readTextFile(
    join(canonicalRoot, 'json.js'),
  );
  const runtimeMap = await Deno.readTextFile(join(canonicalRoot, 'result.js.map'));
  const rootMap = await Deno.readTextFile(join(canonicalRoot, 'index.js.map'));
  const packageJson = JSON.parse(await Deno.readTextFile(join(canonicalRoot, 'package.json'))) as {
    dependencies?: Record<string, string>;
    files: string[];
    bugs?: { url?: string };
    exports?: Record<string, { default?: string; import?: string; types?: string }>;
    homepage?: string;
    repository?: { url?: string };
    soundscript?: {
      version?: number;
      exports?: Record<string, { source?: string }>;
    };
  };

  assertStringIncludes(publishedSource, 'normalizeThrown');
  assertEquals(publishedTypeclassesSource.includes('constructor(readonly effect'), false);
  assertEquals(publishedTypeclassesSource.includes('= <A>('), false);
  assertStringIncludes(publishedJsonSource, "from './numerics.sts';");
  assertStringIncludes(publishedJsonRuntime, "from './numerics.js';");
  assertEquals(publishedJsonRuntime.includes("from './numerics.sts';"), false);
  assertStringIncludes(
    publishedTypeclassesSource,
    'function bind<A>(effect: BoundEffect<F, A>): A {',
  );
  assertStringIncludes(runtimeMap, './soundscript/result.sts');
  assertStringIncludes(runtimeMap, '"sourcesContent":["');
  assertStringIncludes(rootMap, './soundscript/index.sts');
  assertEquals(
    packageJson.exports?.['./project-transform']?.import,
    './project-transform/index.js',
  );
  assertEquals(
    packageJson.exports?.['./project-transform']?.types,
    './project-transform/index.ts',
  );
  assertEquals(
    packageJson.exports?.['./project-transform']?.default,
    './project-transform/index.js',
  );
  assertEquals(packageJson.exports?.['./register'], undefined);
  assertEquals(packageJson.exports?.['./thunk'], undefined);
  assertEquals(packageJson.exports?.['./experimental/sql'], undefined);
  assertEquals(packageJson.exports?.['./experimental/component'], undefined);
  assertEquals(packageJson.exports?.['./host/dom'], undefined);
  assertEquals(packageJson.exports?.['./host/node'], undefined);
  assertEquals(packageJson.exports?.['./value'] !== undefined, true);
  assertEquals(packageJson.exports?.['./derive'] !== undefined, true);
  assertEquals(packageJson.exports?.['./numerics'] !== undefined, true);
  assertEquals(packageJson.soundscript?.version, 1);
  assertEquals(packageJson.soundscript?.exports?.['.']?.source, './soundscript/index.sts');
  assertEquals(packageJson.soundscript?.exports?.['./value']?.source, './soundscript/value.sts');
  assertEquals(
    packageJson.soundscript?.exports?.['./typeclasses']?.source,
    './soundscript/typeclasses.sts',
  );
  assertEquals(
    packageJson.soundscript?.exports?.['./numerics']?.source,
    './soundscript/numerics.sts',
  );
  assertEquals(packageJson.soundscript?.exports?.['./experimental/sql'], undefined);
  assertEquals(packageJson.files.includes('soundscript/**'), true);
  assertEquals(packageJson.files.includes('project-transform/**'), true);
  assertEquals(packageJson.files.includes('index.js.map'), true);
  assertEquals(packageJson.files.includes('experimental/**'), true);
  assertEquals(packageJson.dependencies?.typescript, '5.9.3');
  assertEquals(
    packageJson.repository?.url,
    'git+https://github.com/soundscript-lang/soundscript.git',
  );
  assertEquals(packageJson.homepage, 'https://github.com/soundscript-lang/soundscript');
  assertEquals(packageJson.bugs?.url, 'https://github.com/soundscript-lang/soundscript/issues');
  assertStringIncludes(
    await Deno.readTextFile(join(canonicalRoot, 'project-transform', 'index.ts')),
    'createOnDemandTransformer',
  );
  assertStringIncludes(
    await Deno.readTextFile(
      join(canonicalRoot, 'project-transform', 'src', 'runtime', 'on_demand.js'),
    ),
    'transformModuleSync',
  );
  const registerExists = await Deno.stat(
    join(canonicalRoot, 'project-transform', 'src', 'register.ts'),
  )
    .then(() => true)
    .catch((error) => error instanceof Deno.errors.NotFound ? false : Promise.reject(error));
  assertEquals(registerExists, false);
  assertStringIncludes(
    await Deno.readTextFile(join(canonicalRoot, 'soundscript', 'experimental', 'thunk.sts')),
    'lazy',
  );
  assertStringIncludes(
    await Deno.readTextFile(join(canonicalRoot, 'experimental', 'sql.d.ts')),
    'export',
  );
});

Deno.test('prepare_npm copies stdlib declarations for compiled cli runtime packages', async () => {
  const distRoot = await Deno.makeTempDir({ prefix: 'soundscript-prepare-cli-runtime-' });
  try {
    await copyCliRuntimeSupportFiles(distRoot);

    const indexDeclarations = await Deno.readTextFile(
      join(distRoot, 'src', 'stdlib', 'index.d.ts'),
    );
    const numericsDeclarations = await Deno.readTextFile(
      join(distRoot, 'src', 'stdlib', 'numerics.d.ts'),
    );
    const bundledLibText = await Deno.readTextFile(
      join(distRoot, 'src', 'bundled', 'typescript', 'lib', 'lib.es5.d.ts'),
    );
    const bundledNodeTypesText = await Deno.readTextFile(
      join(distRoot, 'src', 'bundled', 'typescript', 'types', 'node', 'index.d.ts'),
    );
    const bundledNodeHttpTypesText = await Deno.readTextFile(
      join(distRoot, 'src', 'bundled', 'typescript', 'types', 'node', 'http.d.ts'),
    );
    const bundledUndiciTypesText = await Deno.readTextFile(
      join(
        distRoot,
        'src',
        'bundled',
        'typescript',
        'types',
        'node_modules',
        'undici-types',
        'index.d.ts',
      ),
    );
    const bundledNodeVendorMetadata = JSON.parse(
      await Deno.readTextFile(
        join(distRoot, 'src', 'bundled', 'typescript', 'types', 'node', 'vendor.json'),
      ),
    ) as { nodeTypesVersion?: string };

    assertStringIncludes(indexDeclarations, 'export type');
    assertStringIncludes(numericsDeclarations, 'f64');
    assertStringIncludes(bundledLibText, 'declare');
    assertStringIncludes(bundledNodeTypesText, 'reference path="http.d.ts"');
    assertStringIncludes(bundledNodeHttpTypesText, 'declare module "node:http"');
    assertStringIncludes(bundledUndiciTypesText, "export * from './fetch'");
    assertEquals(bundledNodeVendorMetadata.nodeTypesVersion, '24.12.2');
  } finally {
    await Deno.remove(distRoot, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('prepare_npm emits shim package metadata for the soundscript shim package', () => {
  const packageJson = createShimPackageManifest(VERSION) as {
    bugs?: { url?: string };
    dependencies?: Record<string, string>;
    exports?: Record<string, { import?: string; types?: string }>;
    homepage?: string;
    name?: string;
    repository?: { url?: string };
  };

  assertEquals(packageJson.name, 'soundscript');
  assertEquals(packageJson.dependencies?.['@soundscript/soundscript'], VERSION);
  assertEquals(packageJson.exports?.['.']?.import, './index.js');
  assertEquals(packageJson.exports?.['./thunk'], undefined);
  assertEquals(packageJson.exports?.['./experimental/sql'], undefined);
  assertEquals(
    packageJson.repository?.url,
    'git+https://github.com/soundscript-lang/soundscript.git',
  );
  assertEquals(packageJson.homepage, 'https://github.com/soundscript-lang/soundscript');
  assertEquals(packageJson.bugs?.url, 'https://github.com/soundscript-lang/soundscript/issues');
});

Deno.test('prepare_npm emits cli target package metadata with bundled declaration support', () => {
  const target = CLI_TARGETS.find((candidate) =>
    candidate.packageName === '@soundscript/cli-linux-x64'
  );
  assertEquals(typeof target, 'object');
  const packageJson = createCliTargetPackageManifest(VERSION, target!) as {
    bugs?: { url?: string };
    cpu?: string[];
    files?: string[];
    homepage?: string;
    name?: string;
    os?: string[];
    repository?: { url?: string };
  };

  assertEquals(packageJson.name, '@soundscript/cli-linux-x64');
  assertEquals(packageJson.os, ['linux']);
  assertEquals(packageJson.cpu, ['x64']);
  assertEquals(packageJson.files?.includes('src/bundled/typescript/**'), true);
  assertEquals(packageJson.files?.includes('src/bundled/*.d.ts'), true);
  assertEquals(packageJson.files?.includes('src/stdlib/**'), true);
  assertEquals(
    packageJson.repository?.url,
    'git+https://github.com/soundscript-lang/soundscript.git',
  );
  assertEquals(packageJson.homepage, 'https://github.com/soundscript-lang/soundscript');
  assertEquals(packageJson.bugs?.url, 'https://github.com/soundscript-lang/soundscript/issues');
});

Deno.test('prepare_npm --stdlib-only emits canonical project-transform that lowers local macros under Node', async () => {
  const { distRoot, tarballPath } = await prepareCanonicalTarball(
    'soundscript-prepare-project-transform-node-',
  );
  try {
    const projectRoot = await Deno.makeTempDir({ prefix: 'soundscript-project-transform-node-' });
    try {
      await writeAdapterMacroProject(projectRoot);
      await installNpmTarballs(projectRoot, [tarballPath]);

      const loadResult = await runCommand(
        'node',
        [
          '--input-type=module',
          '--eval',
          [
            "import { join } from 'node:path';",
            "import { createOnDemandTransformer, inlineSourceMapComment } from '@soundscript/soundscript/project-transform';",
            'const projectRoot = process.cwd();',
            'const transformer = createOnDemandTransformer({ workingDirectory: projectRoot });',
            "const entryPath = join(projectRoot, 'src', 'main.sts');",
            "const resolved = transformer.resolveImportSpecifier('./helper', entryPath);",
            'const transformed = transformer.transformModuleSync(entryPath);',
            'console.log(JSON.stringify({',
            '  code: transformed.code,',
            '  inline: inlineSourceMapComment(transformed.mapText),',
            '  map: transformed.mapText,',
            '  resolved,',
            '}));',
          ].join('\n'),
        ],
        { cwd: projectRoot },
      );
      assertEquals(
        loadResult.success,
        true,
        `node project-transform smoke failed.\nstdout:\n${loadResult.stdout}\nstderr:\n${loadResult.stderr}`,
      );
      const payload = JSON.parse(loadResult.stdout) as {
        code?: string;
        inline?: string;
        map?: string;
        resolved?: string;
      };
      assertEquals((payload.resolved ?? '').endsWith('/src/helper.sts'), true);
      assertStringIncludes(payload.code ?? '', 'export const doubled = (helper) * 2;');
      assertEquals((payload.code ?? '').includes('__sts_macro_expr('), false);
      assertStringIncludes(payload.map ?? '', join(projectRoot, 'src', 'main.sts'));
      assertStringIncludes(payload.inline ?? '', 'sourceMappingURL=data:application/json;base64,');
    } finally {
      await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
  } finally {
    await Deno.remove(distRoot, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('prepare_npm --stdlib-only emits runtime stdlib JS that Node can import directly', async () => {
  const { distRoot, tarballPath } = await prepareCanonicalTarball(
    'soundscript-prepare-stdlib-runtime-node-',
  );
  try {
    const projectRoot = await Deno.makeTempDir({ prefix: 'soundscript-stdlib-runtime-node-' });
    try {
      await writeProjectFile(
        projectRoot,
        'package.json',
        JSON.stringify(
          {
            name: 'stdlib-runtime-node-smoke',
            private: true,
            type: 'module',
          },
          null,
          2,
        ),
      );
      await installNpmTarballs(projectRoot, [tarballPath]);

      const loadResult = await runCommand(
        'node',
        [
          '--input-type=module',
          '--eval',
          [
            "import { defaulted, nullable, optional, readonlyRecord, string } from '@soundscript/soundscript/decode';",
            "import { emptyJsonRecord, isJsonObject, mergeJsonRecords } from '@soundscript/soundscript/json';",
            "import { collect, err, mapErr, ok, some, tapErr, unwrapOr, unwrapOrElse, unwrapOrThrow } from '@soundscript/soundscript/result';",
            '',
            "const decodedName = defaulted(optional(string), 'anon').decode(undefined);",
            "if (decodedName.tag !== 'ok' || decodedName.value !== 'anon') {",
            "  throw new Error('defaulted decoder did not provide its fallback.');",
            '}',
            '',
            "const decodedRecord = readonlyRecord(nullable(string)).decode({ first: 'ok', second: null });",
            "if (decodedRecord.tag !== 'ok') {",
            '  throw decodedRecord.error;',
            '}',
            '',
            'const merged = mergeJsonRecords(emptyJsonRecord(), { tags: decodedRecord.value });',
            'if (!isJsonObject(merged)) {',
            "  throw new Error('expected merged json object.');",
            '}',
            '',
            'const collected = collect([ok(1), ok(2)]);',
            "if (collected.tag !== 'ok') {",
            '  throw collected.error;',
            '}',
            '',
            "let tapped = '';",
            "tapErr(err('bad'), (error) => {",
            '  tapped = error;',
            '});',
            "const mapped = mapErr(err('bad'), (error) => `ERR:${error}`);",
            "if (mapped.tag !== 'err') {",
            "  throw new Error('expected mapped err result.');",
            '}',
            '',
            'console.log(JSON.stringify({',
            '  collected: collected.value,',
            "  fallback: unwrapOr(err('missing'), 7),",
            "  recovered: unwrapOrElse(err('boom'), (error) => error.length),",
            '  required: unwrapOrThrow(ok(9)),',
            '  present: unwrapOrThrow(some("user")),',
            '  keys: Object.keys(merged).sort(),',
            '  mapped: mapped.error,',
            '  tapped,',
            '}));',
          ].join('\n'),
        ],
        { cwd: projectRoot },
      );
      assertEquals(
        loadResult.success,
        true,
        `node stdlib runtime smoke failed.\nstdout:\n${loadResult.stdout}\nstderr:\n${loadResult.stderr}`,
      );
      assertEquals(
        loadResult.stdout.trim(),
        '{"collected":[1,2],"fallback":7,"recovered":4,"required":9,"present":"user","keys":["tags"],"mapped":"ERR:bad","tapped":"bad"}',
      );
    } finally {
      await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
  } finally {
    await Deno.remove(distRoot, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('prepare_npm --stdlib-only tarball resolves NodeNext TypeScript consumers', async () => {
  const { distRoot, tarballPath } = await prepareCanonicalTarball(
    'soundscript-prepare-stdlib-types-node-next-',
  );
  try {
    const projectRoot = await Deno.makeTempDir({ prefix: 'soundscript-stdlib-types-node-next-' });
    try {
      await writeProjectFile(
        projectRoot,
        'package.json',
        JSON.stringify(
          {
            name: 'stdlib-types-node-next-smoke',
            private: true,
            type: 'module',
          },
          null,
          2,
        ),
      );
      await writeProjectFile(
        projectRoot,
        'tsconfig.json',
        JSON.stringify(
          {
            compilerOptions: {
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              noEmit: true,
              strict: true,
              target: 'ES2022',
              verbatimModuleSyntax: true,
            },
            include: ['consumer.mts'],
          },
          null,
          2,
        ),
      );
      await writeProjectFile(
        projectRoot,
        'consumer.mts',
        [
          "import { defaulted, nullable, optional, readonlyRecord, string } from '@soundscript/soundscript/decode';",
          "import { copyJsonRecord, emptyJsonRecord, isJsonObject, mergeJsonRecords, type JsonValue } from '@soundscript/soundscript/json';",
          "import { collect, err, mapErr, ok, some, tapErr, unwrapOr, unwrapOrElse, unwrapOrThrow, type Result } from '@soundscript/soundscript/result';",
          '',
          "const decodedName = defaulted(optional(string), 'anon').decode(undefined);",
          "const decodedRecord = readonlyRecord(nullable(string)).decode({ first: 'ok', second: null });",
          'const sourceJson: Readonly<Record<string, JsonValue>> = { feature: true };',
          'const copiedJson = copyJsonRecord(sourceJson);',
          'const mergedJson = mergeJsonRecords(emptyJsonRecord(), copiedJson);',
          'const collected = collect([ok(1), ok(2)] as const);',
          "const mapped = mapErr(err('bad'), (error) => error.length);",
          'const seen: string[] = [];',
          "const tapped: Result<number, string> = tapErr(err('bad'), (error) => {",
          '  seen.push(error);',
          '});',
          "const fallback = unwrapOr(err('bad'), 0);",
          "const recovered = unwrapOrElse(err('bad'), (error) => error.length);",
          'const required = unwrapOrThrow(ok(1));',
          'const present = unwrapOrThrow(some("user"));',
          '',
          'if (isJsonObject(mergedJson)) {',
          '  const feature: JsonValue | undefined = mergedJson.feature;',
          '  void feature;',
          '}',
          '',
          'void decodedName;',
          'void decodedRecord;',
          'void collected;',
          'void mapped;',
          'void tapped;',
          'void fallback;',
          'void recovered;',
          'void required;',
          'void present;',
          'void seen;',
          '',
        ].join('\n'),
      );
      await installNpmTarballs(projectRoot, [tarballPath]);

      const compileResult = await runCommand(
        'node',
        [TYPESCRIPT_CLI_PATH, '--project', join(projectRoot, 'tsconfig.json')],
        { cwd: projectRoot },
      );
      assertEquals(
        compileResult.success,
        true,
        `node-next stdlib type smoke failed.\nstdout:\n${compileResult.stdout}\nstderr:\n${compileResult.stderr}`,
      );
    } finally {
      await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
  } finally {
    await Deno.remove(distRoot, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('prepare_npm --stdlib-only project-transform preserves portable ctx.host env and fs access under Node', async () => {
  const { distRoot, tarballPath } = await prepareCanonicalTarball(
    'soundscript-prepare-project-transform-host-',
  );
  try {
    const projectRoot = await Deno.makeTempDir({ prefix: 'soundscript-project-transform-host-' });
    try {
      await writeHostAccessMacroProject(projectRoot);
      await installNpmTarballs(projectRoot, [tarballPath]);

      const loadResult = await runCommand(
        'node',
        [
          '--input-type=module',
          '--eval',
          [
            "import { join } from 'node:path';",
            "import { createOnDemandTransformer } from '@soundscript/soundscript/project-transform';",
            'const projectRoot = process.cwd();',
            'const transformer = createOnDemandTransformer({ workingDirectory: projectRoot });',
            "const transformed = await transformer.transformModule(join(projectRoot, 'src', 'main.sts'));",
            'console.log(JSON.stringify({ code: transformed.code }));',
          ].join('\n'),
        ],
        {
          cwd: projectRoot,
          env: {
            STS_MACRO_TEST_VALUE: 'from-env',
          },
        },
      );
      assertEquals(
        loadResult.success,
        true,
        `node project-transform host smoke failed.\nstdout:\n${loadResult.stdout}\nstderr:\n${loadResult.stderr}`,
      );
      const payload = JSON.parse(loadResult.stdout) as { code?: string };
      assertStringIncludes(payload.code ?? '', 'export const value = "from-env:from-file";');
      assertEquals((payload.code ?? '').includes('__sts_macro_expr('), false);
    } finally {
      await Deno.remove(projectRoot, { recursive: true }).catch(() => undefined);
    }
  } finally {
    await Deno.remove(distRoot, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('buildCliCompileArgs omits worker flags and entrypoints', () => {
  const args = buildCliCompileArgs('/tmp/soundscript', 'aarch64-apple-darwin');

  assertEquals(args.includes('--unstable-worker-options'), false);
  assertEquals(args.includes('--include'), false);
  assertEquals(args.includes('src/frontend/macro_sandbox_worker_bootstrap.ts'), false);
  assertEquals(args.includes('src/frontend/macro_sandbox_worker.ts'), false);
});

Deno.test('deno task build omits worker flags and entrypoints', async () => {
  const denoConfig = JSON.parse(await Deno.readTextFile(join(ROOT, 'deno.json'))) as {
    tasks: { build: string };
  };

  assertEquals(denoConfig.tasks.build.includes('--unstable-worker-options'), false);
  assertEquals(denoConfig.tasks.build.includes('--include'), false);
  assertEquals(
    denoConfig.tasks.build.includes('src/frontend/macro_sandbox_worker_bootstrap.ts'),
    false,
  );
  assertEquals(denoConfig.tasks.build.includes('src/frontend/macro_sandbox_worker.ts'), false);
});
