import { assertEquals } from '@std/assert';
import { dirname, join } from '@std/path';

import {
  analyzePreparedProject,
  analyzeProject,
  prepareProjectAnalysis,
} from '../checker/analyze_project.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../../tests/support/test_installed_stdlib.ts';

async function createTempProject(files: Readonly<Record<string, string>>): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-ts-service-' });

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
  'prepareProjectAnalysis invalidates reused deep #[value] diagnostics through type-only imports',
  async () => {
    const tempDirectory = await createTempProject({
      'tsconfig.json': JSON.stringify(
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
      'src/box.sts': [
        '// #[value(deep: true)]',
        'export class Box {',
        '  readonly leaf: import("./leaf.sts").Leaf;',
        '',
        '  constructor(leaf: import("./leaf.sts").Leaf) {',
        '    this.leaf = leaf;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/leaf.sts': [
        '// #[value(deep: true)]',
        'export class Leaf {',
        '  readonly x: number;',
        '',
        '  constructor(x: number) {',
        '    this.x = x;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/index.sts': 'import { Box } from "./box.sts";\nvoid Box;\n',
    });

    const baseOptions = {
      projectPath: join(tempDirectory, 'tsconfig.json'),
      workingDirectory: tempDirectory,
    };
    const initialPreparedProject = prepareProjectAnalysis(baseOptions);

    await Deno.writeTextFile(
      join(tempDirectory, 'src/leaf.sts'),
      [
        '// #[value(deep: true)]',
        'export class Leaf {',
        '  readonly x: number;',
        '',
        '  constructor(x: number) {',
        '    this.x = x;',
        '  }',
        '',
        '  get y(): number {',
        '    return this.x;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const directResult = analyzeProject(baseOptions);
    const reusedPreparedResult = analyzePreparedProject(
      prepareProjectAnalysis(baseOptions, initialPreparedProject),
    );
    const freshPreparedResult = analyzePreparedProject(prepareProjectAnalysis(baseOptions));
    const expectedBoxPath = join(tempDirectory, 'src/box.sts');
    const expectedLeafPath = join(tempDirectory, 'src/leaf.sts');

    const diagnosticSignature = (
      diagnostics: readonly { code: string | number; filePath?: string }[],
    ) => diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.filePath]).sort();
    const expectedSignature = [
      ['SOUND1022', expectedLeafPath],
      ['SOUND1027', expectedBoxPath],
      ['SOUND1027', expectedLeafPath],
    ].sort();

    assertEquals(diagnosticSignature(directResult.diagnostics), expectedSignature);
    assertEquals(
      diagnosticSignature(freshPreparedResult.diagnostics),
      expectedSignature,
    );
    assertEquals(
      diagnosticSignature(reusedPreparedResult.diagnostics),
      expectedSignature,
    );
  },
);
