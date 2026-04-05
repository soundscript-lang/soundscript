import { basename, dirname, join } from './platform/path.ts';

import {
  ASYNC_STDLIB_DECLARATION_TEXT,
  CODEC_STDLIB_DECLARATION_TEXT,
  COMPARE_STDLIB_DECLARATION_TEXT,
  CSS_STDLIB_DECLARATION_TEXT,
  DEBUG_STDLIB_DECLARATION_TEXT,
  DECODE_STDLIB_DECLARATION_TEXT,
  DERIVE_STDLIB_DECLARATION_TEXT,
  ENCODE_STDLIB_DECLARATION_TEXT,
  FAILURES_STDLIB_DECLARATION_TEXT,
  FETCH_STDLIB_DECLARATION_TEXT,
  GRAPHQL_STDLIB_DECLARATION_TEXT,
  HASH_STDLIB_DECLARATION_TEXT,
  HKT_STDLIB_DECLARATION_TEXT,
  JSON_STDLIB_DECLARATION_TEXT,
  MATCH_STDLIB_DECLARATION_TEXT,
  NUMERICS_STDLIB_DECLARATION_TEXT,
  RANDOM_STDLIB_DECLARATION_TEXT,
  RESULT_STDLIB_DECLARATION_TEXT,
  STDLIB_DECLARATION_TEXT,
  TEXT_STDLIB_DECLARATION_TEXT,
  THUNK_STDLIB_DECLARATION_TEXT,
  TYPECLASSES_STDLIB_DECLARATION_TEXT,
  URL_STDLIB_DECLARATION_TEXT,
  VALUE_STDLIB_DECLARATION_TEXT,
} from './frontend/std_package_support.ts';
import { SQL_STDLIB_DECLARATION_TEXT } from './frontend/sql_stdlib_support.ts';
import { rewriteModuleSpecifiersForEmit } from './runtime/transform.ts';
import { transpileTypeScriptModuleToEsm } from './runtime/transform.ts';

const STABLE_RUNTIME_MODULES = [
  ['hkt', HKT_STDLIB_DECLARATION_TEXT],
  ['typeclasses', TYPECLASSES_STDLIB_DECLARATION_TEXT],
  ['result', RESULT_STDLIB_DECLARATION_TEXT],
  ['value', VALUE_STDLIB_DECLARATION_TEXT],
  ['match', MATCH_STDLIB_DECLARATION_TEXT],
  ['failures', FAILURES_STDLIB_DECLARATION_TEXT],
  ['url', URL_STDLIB_DECLARATION_TEXT],
  ['fetch', FETCH_STDLIB_DECLARATION_TEXT],
  ['text', TEXT_STDLIB_DECLARATION_TEXT],
  ['random', RANDOM_STDLIB_DECLARATION_TEXT],
  ['json', JSON_STDLIB_DECLARATION_TEXT],
  ['compare', COMPARE_STDLIB_DECLARATION_TEXT],
  ['hash', HASH_STDLIB_DECLARATION_TEXT],
  ['derive', DERIVE_STDLIB_DECLARATION_TEXT],
  ['decode', DECODE_STDLIB_DECLARATION_TEXT],
  ['encode', ENCODE_STDLIB_DECLARATION_TEXT],
  ['codec', CODEC_STDLIB_DECLARATION_TEXT],
  ['async', ASYNC_STDLIB_DECLARATION_TEXT],
  ['numerics', NUMERICS_STDLIB_DECLARATION_TEXT],
] as const;

const EXPERIMENTAL_RUNTIME_MODULES = [
  ['thunk', THUNK_STDLIB_DECLARATION_TEXT],
  ['sql', SQL_STDLIB_DECLARATION_TEXT],
  ['css', CSS_STDLIB_DECLARATION_TEXT],
  ['graphql', GRAPHQL_STDLIB_DECLARATION_TEXT],
  ['debug', DEBUG_STDLIB_DECLARATION_TEXT],
] as const;

function createStdlibPackageJsonText(): string {
  return `${
    JSON.stringify(
      {
        name: '@soundscript/soundscript',
        version: '0.0.0-test',
        type: 'module',
        types: './index.d.ts',
        soundscript: {
          version: 1,
          exports: {
            '.': { source: './soundscript/index.sts' },
            ...Object.fromEntries(
              STABLE_RUNTIME_MODULES.map(([moduleName]) => [
                `./${moduleName}`,
                { source: `./soundscript/${moduleName}.sts` },
              ]),
            ),
          },
        },
        exports: {
          '.': {
            types: './index.d.ts',
            import: './index.js',
          },
          ...Object.fromEntries(
            STABLE_RUNTIME_MODULES.map(([moduleName]) => [
              `./${moduleName}`,
              {
                types: `./${moduleName}.d.ts`,
                import: `./${moduleName}.js`,
              },
            ]),
          ),
        },
      },
      null,
      2,
    )
  }\n`;
}

function readRepoStdlibSource(fileName: string): string {
  return Deno.readTextFileSync(new URL(`./stdlib/${fileName}`, import.meta.url));
}

function createPublishedStdlibSource(packageRoot: string, relativeFileName: string): string {
  return rewriteModuleSpecifiersForEmit(
    readRepoStdlibSource(relativeFileName),
    join(packageRoot, 'soundscript', relativeFileName.replace(/\.ts$/u, '.sts')),
    { moduleSpecifierMode: 'source-sts' },
  );
}

function readPublishedStdlibRuntime(fileName: string): string {
  const publishedRuntimeUrl = new URL(
    `../dist/npm/soundscript-canonical/${fileName}`,
    import.meta.url,
  );
  try {
    return Deno.readTextFileSync(publishedRuntimeUrl);
  } catch {
    const relativeSourceFileName = fileName.replace(/\.js$/u, '.ts');
    const publishedSourcePath = join(
      '/virtual/node_modules/@soundscript/soundscript/soundscript',
      relativeSourceFileName.replace(/\.ts$/u, '.sts'),
    );
    return transpileTypeScriptModuleToEsm(
      publishedSourcePath,
      join('/virtual/node_modules/@soundscript/soundscript', fileName),
      rewriteModuleSpecifiersForEmit(
        readRepoStdlibSource(relativeSourceFileName),
        publishedSourcePath,
      ),
    ).code;
  }
}

export function createInstalledStdlibPackageFiles(
  projectRoot: string,
): ReadonlyMap<string, string> {
  const packageRoot = join(projectRoot, 'node_modules', '@soundscript', 'soundscript');
  const files = new Map<string, string>([
    [join(packageRoot, 'package.json'), createStdlibPackageJsonText()],
    [
      join(packageRoot, 'index.d.ts'),
      rewriteModuleSpecifiersForEmit(STDLIB_DECLARATION_TEXT, `${packageRoot}/index.d.ts`),
    ],
    [join(packageRoot, 'index.js'), readPublishedStdlibRuntime('index.js')],
    [
      join(packageRoot, 'soundscript', 'index.sts'),
      createPublishedStdlibSource(packageRoot, 'index.ts'),
    ],
  ]);

  for (const [moduleName, declarationText] of STABLE_RUNTIME_MODULES) {
    if (declarationText !== null) {
      files.set(
        join(packageRoot, `${moduleName}.d.ts`),
        rewriteModuleSpecifiersForEmit(declarationText, `${packageRoot}/${moduleName}.d.ts`),
      );
    }

    files.set(
      join(packageRoot, `${moduleName}.js`),
      readPublishedStdlibRuntime(`${moduleName}.js`),
    );
    files.set(
      join(packageRoot, 'soundscript', `${moduleName}.sts`),
      createPublishedStdlibSource(packageRoot, `${moduleName}.ts`),
    );
  }

  for (const [moduleName, declarationText] of EXPERIMENTAL_RUNTIME_MODULES) {
    files.set(
      join(packageRoot, 'experimental', `${moduleName}.d.ts`),
      rewriteModuleSpecifiersForEmit(
        declarationText,
        `${packageRoot}/experimental/${moduleName}.d.ts`,
      ),
    );
    files.set(
      join(packageRoot, 'soundscript', 'experimental', `${moduleName}.sts`),
      rewriteModuleSpecifiersForEmit(
        readRepoStdlibSource(`${moduleName}.ts`),
        join(packageRoot, 'soundscript', 'experimental', `${moduleName}.sts`),
        { moduleSpecifierMode: 'source-sts' },
      ),
    );
  }

  return files;
}

export async function writeInstalledStdlibPackage(projectRoot: string): Promise<void> {
  for (const [filePath, text] of createInstalledStdlibPackageFiles(projectRoot)) {
    await Deno.mkdir(dirname(filePath), { recursive: true });
    await Deno.writeTextFile(filePath, text);
  }
}

export function normalizeTsconfigForInstalledStdlib(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return text;
  }

  const config = parsed as Record<string, unknown>;
  const compilerOptions = config.compilerOptions && typeof config.compilerOptions === 'object' &&
      !Array.isArray(config.compilerOptions)
    ? { ...(config.compilerOptions as Record<string, unknown>) }
    : {};

  if (compilerOptions.moduleResolution !== undefined) {
    return `${JSON.stringify({ ...config, compilerOptions }, null, 2)}\n`;
  }

  const moduleOption = compilerOptions.module;
  if (moduleOption === undefined || moduleOption === 'ESNext' || moduleOption === 'Preserve') {
    compilerOptions.moduleResolution = 'Bundler';
    return `${JSON.stringify({ ...config, compilerOptions }, null, 2)}\n`;
  }

  return `${JSON.stringify({ ...config, compilerOptions }, null, 2)}\n`;
}

export function maybeNormalizeTsconfigForInstalledStdlib(
  filePath: string,
  text: string,
): string {
  const baseName = basename(filePath);
  if (!baseName.startsWith('tsconfig') || !baseName.endsWith('.json')) {
    return text;
  }

  return normalizeTsconfigForInstalledStdlib(text);
}
