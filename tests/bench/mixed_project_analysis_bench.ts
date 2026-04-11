// This benchmark tracks the mixed .ts/.sts analysis pipeline that now backs
// incremental adoption and the LSP. It is not a product speed claim on its own.
// Compare runs only on the same machine/runtime/config, and capture raw output.

import { join } from '@std/path';

import {
  analyzePreparedProject,
  prepareProjectAnalysis,
} from '../../src/checker/analyze_project.ts';

const STS_FILE_COUNT = 12;
const TS_FILE_COUNT = 24;
const UPDATED_TS_TEXT = [
  'import { value0 } from "./lib0";',
  'import { value1 } from "./lib1";',
  'const combined = value0 + value1 + 1;',
  'void combined;',
  '',
].join('\n');
const UPDATED_STS_TEXT = [
  'export type Value0 = { readonly id: 0; readonly label: string; readonly extra: number };',
  'export const value0: number = 100;',
  'export function makeValue0(label: string): Value0 {',
  '  return { id: 0, label, extra: value0 };',
  '}',
  '',
].join('\n');

interface BenchScenario {
  baseOptions: {
    projectPath: string;
    workingDirectory: string;
  };
  basePreparedProject: ReturnType<typeof prepareProjectAnalysis>;
  updatedStsFile: string;
  updatedTsFile: string;
}

function createWorkspace(): string {
  const workspace = Deno.makeTempDirSync({ prefix: 'soundscript-mixed-bench-' });
  Deno.mkdirSync(join(workspace, 'src'), { recursive: true });
  Deno.writeTextFileSync(
    join(workspace, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
  );

  for (let index = 0; index < STS_FILE_COUNT; index += 1) {
    const filePath = join(workspace, 'src', `lib${index}.sts`);
    Deno.writeTextFileSync(
      filePath,
      [
        `export type Value${index} = { readonly id: ${index}; readonly label: string };`,
        `export const value${index}: number = ${index};`,
        `export function makeValue${index}(label: string): Value${index} {`,
        `  return { id: ${index}, label };`,
        '}',
        '',
      ].join('\n'),
    );
  }

  for (let index = 0; index < TS_FILE_COUNT; index += 1) {
    const left = index % STS_FILE_COUNT;
    const right = (index + 1) % STS_FILE_COUNT;
    const filePath = join(workspace, 'src', `consumer${index}.ts`);
    Deno.writeTextFileSync(
      filePath,
      [
        `import { value${left}, makeValue${left} } from "./lib${left}";`,
        `import { value${right} } from "./lib${right}";`,
        `const local${index} = makeValue${left}("consumer-${index}");`,
        `const total${index}: number = value${left} + value${right};`,
        `void local${index};`,
        `void total${index};`,
        '',
      ].join('\n'),
    );
  }

  return workspace;
}

function createScenario(): BenchScenario {
  const workspace = createWorkspace();
  const baseOptions = {
    projectPath: join(workspace, 'tsconfig.json'),
    workingDirectory: workspace,
  };
  return {
    baseOptions,
    basePreparedProject: prepareProjectAnalysis(baseOptions),
    updatedStsFile: join(workspace, 'src', 'lib0.sts'),
    updatedTsFile: join(workspace, 'src', 'consumer0.ts'),
  };
}

const COLD_SCENARIO = createScenario();
const TS_EDIT_SCENARIO = createScenario();
const STS_EDIT_SCENARIO = createScenario();
const ANALYZE_SCENARIO = createScenario();

Deno.bench('mixed project: cold prepareProjectAnalysis', () => {
  prepareProjectAnalysis(COLD_SCENARIO.baseOptions);
});

Deno.bench('mixed project: cold prepareProjectAnalysis for .sts-local work', () => {
  prepareProjectAnalysis(COLD_SCENARIO.baseOptions, undefined, { deferTypescriptView: true });
});

Deno.bench('mixed project: reused prepareProjectAnalysis after .ts-only edit', () => {
  prepareProjectAnalysis(
    {
      ...TS_EDIT_SCENARIO.baseOptions,
      fileOverrides: new Map([[TS_EDIT_SCENARIO.updatedTsFile, UPDATED_TS_TEXT]]),
    },
    TS_EDIT_SCENARIO.basePreparedProject,
  );
});

Deno.bench('mixed project: reused prepareProjectAnalysis after .sts-only edit', () => {
  prepareProjectAnalysis(
    {
      ...STS_EDIT_SCENARIO.baseOptions,
      fileOverrides: new Map([[STS_EDIT_SCENARIO.updatedStsFile, UPDATED_STS_TEXT]]),
    },
    STS_EDIT_SCENARIO.basePreparedProject,
  );
});

Deno.bench('mixed project: reused prepareProjectAnalysis after .sts-only edit for .sts-local work', () => {
  prepareProjectAnalysis(
    {
      ...STS_EDIT_SCENARIO.baseOptions,
      fileOverrides: new Map([[STS_EDIT_SCENARIO.updatedStsFile, UPDATED_STS_TEXT]]),
    },
    STS_EDIT_SCENARIO.basePreparedProject,
    { deferTypescriptView: true },
  );
});

Deno.bench('mixed project: analyzePreparedProject on prepared baseline', () => {
  analyzePreparedProject(ANALYZE_SCENARIO.basePreparedProject);
});
