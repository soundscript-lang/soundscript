import { assertEquals } from '@std/assert';
import { dirname, join } from '@std/path';

import { collectRuntimeProgramRootNames } from './project_roots.ts';

async function writeProjectFile(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const filePath = join(root, relativePath);
  await Deno.mkdir(dirname(filePath), { recursive: true }).catch(() => undefined);
  await Deno.writeTextFile(filePath, contents);
}

Deno.test('collectRuntimeProgramRootNames excludes unrelated TypeScript roots while keeping soundscript, declarations, and explicit entries', async () => {
  const root = await Deno.makeTempDir({ prefix: 'soundscript-runtime-roots-' });

  try {
    await writeProjectFile(
      root,
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.sts', 'src/**/*.ts', 'src/**/*.d.ts'],
        },
        null,
        2,
      ),
    );
    await writeProjectFile(root, 'src/main.sts', 'export const answer = 42;\n');
    await writeProjectFile(root, 'src/helper.sts', 'export const helper = 41;\n');
    await writeProjectFile(root, 'src/ambient.d.ts', 'declare const ambient: number;\n');
    await writeProjectFile(root, 'src/unrelated.ts', 'export const unrelated = 1;\n');
    await writeProjectFile(root, 'scripts/manual-entry.sts', 'export const manual = 7;\n');

    const rootNames = new Set(
      collectRuntimeProgramRootNames(
        join(root, 'tsconfig.json'),
        [join(root, 'scripts/manual-entry.sts')],
      ),
    );

    assertEquals(rootNames.has(join(root, 'src/main.sts')), true);
    assertEquals(rootNames.has(join(root, 'src/helper.sts')), true);
    assertEquals(rootNames.has(join(root, 'src/ambient.d.ts')), true);
    assertEquals(rootNames.has(join(root, 'scripts/manual-entry.sts')), true);
    assertEquals(rootNames.has(join(root, 'src/unrelated.ts')), false);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
