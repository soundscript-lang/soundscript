import { join } from './platform/path.ts';

export interface TestMacroPackageFile {
  readonly contents: string;
  readonly path: string;
}

export const TEST_MACRO_PACKAGE_NAME = '@soundscript/test-macro-package';

const TEST_MACRO_PACKAGE_FIXTURE_ROOT = join(
  'test-fixtures',
  'packages',
  'test-macro-package',
);

const TEST_MACRO_PACKAGE_PATHS = [
  'package.json',
  'dist/index.js',
  'dist/index.d.ts',
  'src/index.macro.sts',
] as const;

const TEST_MACRO_PACKAGE_FALLBACK_FILES = new Map<string, string>([
  [
    'dist/index.js',
    [
      'export function twice() {',
      "  throw new Error('@soundscript/test-macro-package macros must be expanded before runtime.');",
      '}',
      '',
      'export function register() {',
      "  throw new Error('@soundscript/test-macro-package macros must be expanded before runtime.');",
      '}',
      '',
      'export function reflectAnnotations() {',
      "  throw new Error('@soundscript/test-macro-package macros must be expanded before runtime.');",
      '}',
      '',
    ].join('\n'),
  ],
  [
    'dist/index.d.ts',
    [
      'export declare function twice(value: unknown): never;',
      'export declare function register(): never;',
      'export declare function reflectAnnotations(): never;',
      '',
    ].join('\n'),
  ],
]);

export async function loadTestMacroPackageFiles(
  repoRoot = Deno.cwd(),
): Promise<readonly TestMacroPackageFile[]> {
  return await Promise.all(
    TEST_MACRO_PACKAGE_PATHS.map(async (relativePath) => {
      const fixturePath = join(repoRoot, TEST_MACRO_PACKAGE_FIXTURE_ROOT, relativePath);
      const contents = await Deno.readTextFile(fixturePath).catch((error: unknown) => {
        if (error instanceof Deno.errors.NotFound) {
          const fallback = TEST_MACRO_PACKAGE_FALLBACK_FILES.get(relativePath);
          if (fallback !== undefined) {
            return fallback;
          }
        }
        throw error;
      });
      return {
        path: join('node_modules', TEST_MACRO_PACKAGE_NAME, relativePath),
        contents,
      };
    }),
  );
}
