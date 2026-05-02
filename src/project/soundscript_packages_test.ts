import { assert, assertEquals } from '@std/assert';

import { dirname, join } from '../platform/path.ts';

import { getSoundScriptPackageExportInfoForResolvedModule } from './soundscript_packages.ts';

function createHost(files: ReadonlyMap<string, string>) {
  const knownDirectories = new Set<string>();
  for (const fileName of files.keys()) {
    let current = dirname(fileName);
    while (current !== dirname(current)) {
      knownDirectories.add(current);
      current = dirname(current);
    }
    knownDirectories.add(current);
  }

  return {
    directoryExists(directoryName: string): boolean {
      return knownDirectories.has(directoryName);
    },
    fileExists(fileName: string): boolean {
      return files.has(fileName);
    },
    getCurrentDirectory(): string {
      return '/workspace';
    },
    getDirectories(path: string): string[] {
      const entries = new Set<string>();
      for (const directory of knownDirectories) {
        if (dirname(directory) === path) {
          entries.add(directory.slice(path.endsWith('/') ? path.length : path.length + 1));
        }
      }
      return [...entries];
    },
    readFile(fileName: string): string | undefined {
      return files.get(fileName);
    },
  };
}

Deno.test('getSoundScriptPackageExportInfoForResolvedModule can trust macro source entrypoints for macro graph validation', () => {
  const packageRoot = '/workspace/node_modules/pkg';
  const packageJsonPath = join(packageRoot, 'package.json');
  const resolvedRuntimeFileName = join(packageRoot, 'dist/index.d.ts');
  const macroSourcePath = join(packageRoot, 'src/index.macro.sts');
  const host = createHost(
    new Map([
      [
        packageJsonPath,
        JSON.stringify({
          name: 'pkg',
          soundscript: {
            version: 1,
            exports: {
              '.': {
                source: './src/index.macro.sts',
              },
            },
          },
        }),
      ],
      [resolvedRuntimeFileName, 'export declare function m(): void;\n'],
      [macroSourcePath, "import { helper } from './helper.ts';\nexport { helper };\n"],
      [join(packageRoot, 'src/helper.ts'), 'export const helper = 1;\n'],
    ]),
  );

  assertEquals(
    getSoundScriptPackageExportInfoForResolvedModule('pkg', resolvedRuntimeFileName, host),
    undefined,
  );

  const trusted = getSoundScriptPackageExportInfoForResolvedModule(
    'pkg',
    resolvedRuntimeFileName,
    host,
    { trustMacroAuthoringSourcePath: true },
  );
  assert(trusted);
  assertEquals(trusted.sourceEntryPath, macroSourcePath);
});

Deno.test('getSoundScriptPackageExportInfoForResolvedModule returns full package export info', () => {
  const packageRoot = '/workspace/node_modules/pkg';
  const packageJsonPath = join(packageRoot, 'package.json');
  const resolvedRuntimeFileName = join(packageRoot, 'dist/extra.d.ts');
  const indexSourcePath = join(packageRoot, 'src/index.sts');
  const extraSourcePath = join(packageRoot, 'src/extra.sts');
  const host = createHost(
    new Map([
      [
        packageJsonPath,
        JSON.stringify({
          name: 'pkg',
          soundscript: {
            version: 1,
            exports: {
              '.': {
                source: './src/index.sts',
              },
              './extra': {
                source: './src/extra.sts',
              },
            },
          },
        }),
      ],
      [join(packageRoot, 'dist/index.d.ts'), 'export declare const index: number;\n'],
      [resolvedRuntimeFileName, 'export declare const extra: number;\n'],
      [indexSourcePath, 'export const index = 1;\n'],
      [extraSourcePath, 'export const extra = 2;\n'],
    ]),
  );

  const packageExport = getSoundScriptPackageExportInfoForResolvedModule(
    'pkg/extra',
    resolvedRuntimeFileName,
    host,
  );

  assert(packageExport);
  assertEquals(packageExport.sourceEntryPath, extraSourcePath);
  assertEquals([...packageExport.packageInfo.exports.entries()], [
    ['.', indexSourcePath],
    ['./extra', extraSourcePath],
  ]);
});
