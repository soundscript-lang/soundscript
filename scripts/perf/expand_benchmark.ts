import { dirname, join } from '@std/path';

import { expandProject } from '../../src/frontend/expand_project.ts';
interface BenchmarkOptions {
  iterations: number;
  outDir: string;
  warmups: number;
}

interface FixtureFile {
  readonly path: string;
  readonly contents: string;
}

interface TimingEntry {
  readonly durationMs: number;
  readonly metadata: Record<string, string>;
  readonly stage: string;
}

interface IterationResult {
  readonly diagnostics: number;
  readonly exitCode: number;
  readonly timings: readonly TimingEntry[];
  readonly wallMs: number;
}

interface ScenarioResult {
  readonly iterations: readonly IterationResult[];
  readonly name: string;
  readonly projectPath: string;
}

const DEFAULT_OPTIONS: BenchmarkOptions = {
  iterations: 5,
  outDir: join(Deno.cwd(), '.bench', 'expand'),
  warmups: 1,
};

function parseArgs(args: readonly string[]): BenchmarkOptions {
  const options: BenchmarkOptions = { ...DEFAULT_OPTIONS };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--iterations') {
      options.iterations = Number(args[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (arg === '--warmups') {
      options.warmups = Number(args[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (arg === '--out-dir') {
      options.outDir = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error('--iterations must be a positive integer.');
  }
  if (!Number.isInteger(options.warmups) || options.warmups < 0) {
    throw new Error('--warmups must be a non-negative integer.');
  }
  if (!options.outDir) {
    throw new Error('--out-dir must not be empty.');
  }
  return options;
}

function baseProjectFiles(extraFiles: readonly FixtureFile[]): readonly FixtureFile[] {
  return [
    {
      path: 'package.json',
      contents: JSON.stringify(
        {
          name: 'soundscript-expand-benchmark-fixture',
          version: '1.0.0',
          type: 'module',
        },
        null,
        2,
      ),
    },
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
          },
          include: ['src/**/*.sts'],
        },
        null,
        2,
      ),
    },
    ...extraFiles,
  ];
}

function noMacroFixture(): readonly FixtureFile[] {
  return baseProjectFiles([
    {
      path: 'src/main.sts',
      contents: [
        'export interface Item {',
        '  readonly id: string;',
        '  readonly count: number;',
        '}',
        '',
        'export function total(items: readonly Item[]): number {',
        '  return items.reduce((sum, item) => sum + item.count, 0);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
}

function stdlibMacroFixture(): readonly FixtureFile[] {
  return baseProjectFiles([
    {
      path: 'src/main.sts',
      contents: [
        "type Ok = { tag: 'ok'; value: number };",
        "type Err = { tag: 'err'; error: string };",
        '',
        'export function score(value: Ok | Err | undefined): number {',
        '  return Match(value, [',
        '    ({ value }: Ok) => value,',
        '    ({ error }: Err) => error.length,',
        '    (_: undefined) => 0,',
        '  ]);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
}

function userMacroFixture(): readonly FixtureFile[] {
  return baseProjectFiles([
    {
      path: 'src/macros.macro.sts',
      contents: [
        "import 'sts:macros';",
        '',
        '// #[macro(call)]',
        'export function Two() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`2`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/main.sts',
      contents: [
        "import { Two } from './macros.macro';",
        '',
        'export const value = Two();',
        '',
      ].join('\n'),
    },
  ]);
}

function packageMacroFixture(): readonly FixtureFile[] {
  return baseProjectFiles([
    {
      path: 'node_modules/bench-macro-pkg/package.json',
      contents: JSON.stringify(
        {
          name: 'bench-macro-pkg',
          version: '1.0.0',
          type: 'module',
          types: './dist/index.d.ts',
          soundscript: {
            source: './src/index.sts',
          },
        },
        null,
        2,
      ),
    },
    {
      path: 'node_modules/bench-macro-pkg/dist/index.d.ts',
      contents: 'export declare function Three(): number;\n',
    },
    {
      path: 'node_modules/bench-macro-pkg/src/index.sts',
      contents: 'export { Three } from "./macros/three.macro";\n',
    },
    {
      path: 'node_modules/bench-macro-pkg/src/macros/three.macro.sts',
      contents: [
        "import 'sts:macros';",
        '',
        '// #[macro(call)]',
        'export function Three() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`3`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/main.sts',
      contents: [
        "import { Three } from 'bench-macro-pkg';",
        '',
        'export const value = Three();',
        '',
      ].join('\n'),
    },
  ]);
}

function generatedStdlibMacroFixture(): readonly FixtureFile[] {
  return baseProjectFiles([
    {
      path: 'src/model.macro.sts',
      contents: [
        "import 'sts:macros';",
        '',
        '// #[macro(call)]',
        'export function EmitTodo() {',
        '  return {',
        '    expand(ctx: any) {',
        '      return ctx.output.expr(ctx.quote.expr`todo("generated recursive macro")`);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/main.sts',
      contents: [
        "import { EmitTodo } from './model.macro';",
        '',
        'export function fail(): never {',
        '  return EmitTodo();',
        '}',
        '',
      ].join('\n'),
    },
  ]);
}

function soundstageLikeFixture(): readonly FixtureFile[] {
  return baseProjectFiles([
    {
      path: 'src/view.macro.sts',
      contents: [
        "import { macroSignature } from 'sts:macros';",
        '',
        "const DECL = macroSignature.of(macroSignature.decl('target'));",
        '',
        '// #[macro(decl)]',
        'export function view() {',
        '  return {',
        "    declarationKinds: ['class'] as const,",
        "    expansionMode: 'augment' as const,",
        '    signature: DECL,',
        '    expand(ctx: any) {',
        '      const name = ctx.syntax.declaration().name ?? ctx.error("expected class name");',
        '      return ctx.output.stmt(ctx.quote.stmt`',
        '        export function ${`mount${name}`}(target: unknown): void {',
        '          void target;',
        '        }',
        '      `);',
        '    },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/app.sts',
      contents: [
        "import { view } from './view.macro';",
        '',
        '// #[view]',
        'export class App {',
        '  title = "Bench";',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/browser.sts',
      contents: [
        "import { mountApp } from './app';",
        '',
        'export function mount(target: unknown): void {',
        '  mountApp(target);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
}

const FIXTURES: ReadonlyArray<{
  readonly name: string;
  readonly files: () => readonly FixtureFile[];
}> = [
  { name: 'no-macros', files: noMacroFixture },
  { name: 'stdlib-macros', files: stdlibMacroFixture },
  { name: 'user-macros', files: userMacroFixture },
  { name: 'package-macros', files: packageMacroFixture },
  { name: 'generated-stdlib-macros', files: generatedStdlibMacroFixture },
  { name: 'soundstage-like', files: soundstageLikeFixture },
];

async function writeFixture(root: string, files: readonly FixtureFile[]): Promise<void> {
  for (const file of files) {
    const path = join(root, file.path);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, file.contents);
  }
}

function parseTiming(line: string): TimingEntry | null {
  const match = /^\[soundscript:checker\]\s+(\S+)\s+([\d.]+)ms(?:\s+(.*))?$/u.exec(line);
  if (!match) {
    return null;
  }

  const metadata: Record<string, string> = {};
  for (const part of (match[3] ?? '').split(/\s+/u)) {
    if (!part) {
      continue;
    }
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    metadata[part.slice(0, separatorIndex)] = part.slice(separatorIndex + 1);
  }

  return {
    durationMs: Number(match[2]),
    metadata,
    stage: match[1],
  };
}

async function runExpand(
  projectPath: string,
  outDir: string,
): Promise<IterationResult> {
  const originalTiming = Deno.env.get('SOUNDSCRIPT_CHECKER_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', '1');

  const start = performance.now();
  try {
    const result = await expandProject({
      outDir,
      projectPath,
      workingDirectory: dirname(projectPath),
    });
    return {
      diagnostics: result.diagnostics.length,
      exitCode: result.exitCode,
      timings: logs.map(parseTiming).filter((entry): entry is TimingEntry => entry !== null),
      wallMs: performance.now() - start,
    };
  } finally {
    if (originalTiming === undefined) {
      Deno.env.delete('SOUNDSCRIPT_CHECKER_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_CHECKER_TIMING', originalTiming);
    }
    console.error = originalError;
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
    : sorted[midpoint]!;
}

function stageMedian(result: ScenarioResult, stage: string): number {
  return median(
    result.iterations.map((iteration) =>
      iteration.timings
        .filter((entry) => entry.stage === stage)
        .reduce((total, entry) => total + entry.durationMs, 0)
    ),
  );
}

function semanticBuildMedian(result: ScenarioResult): number {
  return median(
    result.iterations.map((iteration) =>
      iteration.timings.filter((entry) =>
        entry.stage === 'project.prepare.semanticBuilderHostReuse'
      ).length
    ),
  );
}

function macroDetailMedian(result: ScenarioResult, metadataKey: string): number {
  return median(
    result.iterations.map((iteration) =>
      iteration.timings
        .filter((entry) => entry.stage === 'project.prepare.macro.expandDetails')
        .reduce((total, entry) => total + Number(entry.metadata[metadataKey] ?? 0), 0)
    ),
  );
}

function markdownReport(results: readonly ScenarioResult[]): string {
  const lines = [
    '# Soundscript Expand Benchmark',
    '',
    '| scenario | wall median ms | initial ms | expand macros ms | package export ms | graph compile ms | generated stdlib ms | module eval ms | binding plan ms | macro exec ms | source expansion ms | annotated ms | final ms | semantic builds |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const result of results) {
    lines.push(
      `| ${result.name} | ${
        median(result.iterations.map((iteration) => iteration.wallMs)).toFixed(1)
      } | ${stageMedian(result, 'project.prepare.builtin.initialProgram').toFixed(1)} | ${
        stageMedian(result, 'project.prepare.builtin.expandMacros').toFixed(1)
      } | ${macroDetailMedian(result, 'packageExportInfoMs').toFixed(1)} | ${
        macroDetailMedian(result, 'graphCompileMs').toFixed(1)
      } | ${macroDetailMedian(result, 'generatedStdlibMs').toFixed(1)} | ${
        macroDetailMedian(result, 'moduleEvalMs').toFixed(1)
      } | ${macroDetailMedian(result, 'bindingPlanMs').toFixed(1)} | ${
        macroDetailMedian(result, 'macroExecutionMs').toFixed(1)
      } | ${macroDetailMedian(result, 'sourceExpansionMs').toFixed(1)} | ${
        stageMedian(result, 'project.prepare.builtin.annotatedProgram').toFixed(1)
      } | ${stageMedian(result, 'project.prepare.builtin.finalProgram').toFixed(1)} | ${
        semanticBuildMedian(result).toFixed(1)
      } |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function runScenario(
  name: string,
  files: readonly FixtureFile[],
  options: BenchmarkOptions,
): Promise<ScenarioResult> {
  const root = await Deno.makeTempDir({ prefix: `soundscript-expand-${name}-` });
  await writeFixture(root, files);
  const projectPath = join(root, 'tsconfig.json');
  const iterations: IterationResult[] = [];

  for (let index = 0; index < options.warmups; index += 1) {
    await runExpand(projectPath, join(root, `.warmup-${index}`));
  }

  for (let index = 0; index < options.iterations; index += 1) {
    iterations.push(await runExpand(projectPath, join(root, `.out-${index}`)));
  }

  return { iterations, name, projectPath };
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);
  await Deno.mkdir(options.outDir, { recursive: true });
  const results: ScenarioResult[] = [];
  for (const fixture of FIXTURES) {
    results.push(await runScenario(fixture.name, fixture.files(), options));
  }

  const report = {
    createdAt: new Date().toISOString(),
    options,
    results,
  };
  await Deno.writeTextFile(
    join(options.outDir, 'expand-benchmark.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const markdown = markdownReport(results);
  await Deno.writeTextFile(join(options.outDir, 'expand-benchmark.md'), markdown);
  console.log(markdown);

  const failed = results.flatMap((result) =>
    result.iterations
      .filter((iteration) => iteration.exitCode !== 0)
      .map((iteration) => `${result.name}: exit ${iteration.exitCode} (${iteration.diagnostics})`)
  );
  if (failed.length > 0) {
    console.error(failed.join('\n'));
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
