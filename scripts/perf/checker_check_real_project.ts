import { dirname, isAbsolute, join } from '@std/path';

import {
  disposePreparedAnalysisProject,
  prepareProjectAnalysis,
  type PreparedAnalysisProject,
} from '../../src/checker/analyze_project.ts';
import { runProgram } from '../../src/cli/run_program.ts';

interface HarnessOptions {
  cacheDir?: string;
  projectPath: string;
  scenario: 'all' | 'body-edit' | 'surface-edit' | 'unchanged';
  stsFile?: string;
  workingDirectory?: string;
}

interface ScenarioResult {
  diagnostics: number;
  exitCode: number;
  name: string;
  runMs: number;
  seedMs: number;
}

function printUsage(): void {
  console.error(
    [
      'Usage:',
      '  deno run -A scripts/perf/checker_check_real_project.ts --project /abs/path/to/tsconfig.json',
      '',
      'Optional flags:',
      '  --working-directory /abs/path/to/project/root',
      '  --sts-file /abs/path/to/file.sts',
      '  --cache-dir /abs/path/to/cache/root',
      '  --scenario unchanged|body-edit|surface-edit|all',
    ].join('\n'),
  );
}

function parseArgs(args: readonly string[]): HarnessOptions {
  const options: HarnessOptions = {
    projectPath: '',
    scenario: 'all',
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--project') {
      options.projectPath = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (argument === '--working-directory') {
      options.workingDirectory = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--sts-file') {
      options.stsFile = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--cache-dir') {
      options.cacheDir = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--scenario') {
      const scenario = args[index + 1];
      if (
        scenario !== 'all' &&
        scenario !== 'body-edit' &&
        scenario !== 'surface-edit' &&
        scenario !== 'unchanged'
      ) {
        throw new Error(`Unsupported --scenario value: ${scenario}`);
      }
      options.scenario = scenario;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.projectPath) {
    throw new Error('Missing required --project argument.');
  }

  return options;
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : join(Deno.cwd(), path);
}

function measure<T>(fn: () => T): { durationMs: number; result: T } {
  const start = performance.now();
  const result = fn();
  return {
    durationMs: performance.now() - start,
    result,
  };
}

function chooseRepresentativeSourceFile(
  preparedProject: PreparedAnalysisProject,
): string | undefined {
  const stsView = preparedProject.stsView;
  if (!stsView) {
    return undefined;
  }

  return stsView.program.getSourceFiles()
    .map((sourceFile) => stsView.preparedProgram.toSourceFileName(sourceFile.fileName))
    .filter((fileName) => fileName.endsWith('.sts') && !fileName.endsWith('.macro.sts'))
    .filter((fileName) => !fileName.includes('/dist/'))
    .filter((fileName) => !fileName.includes('/node_modules/'))
    .sort()[0];
}

function createBodyEditText(sourceText: string): string {
  const insertion = 'const __codex_body_probe = 1;';
  if (sourceText.includes(insertion)) {
    return sourceText.replace(insertion, 'const __codex_body_probe = 2;');
  }
  return `${sourceText}\nconst __codex_body_probe = 1;\n`;
}

function createSurfaceEditText(sourceText: string): string {
  const exportLine = 'export const __codex_surface_probe = 1;';
  if (sourceText.includes(exportLine)) {
    return sourceText.replace(exportLine, 'export const __codex_surface_probe = 2;');
  }

  return `${sourceText}\n${exportLine}\n`;
}

function runCachedCheck(
  projectPath: string,
  workingDirectory: string,
  cacheDir: string,
): { durationMs: number; result: ReturnType<typeof runProgram> } {
  return measure(() =>
    runProgram({
      cacheDir,
      projectPath,
      workingDirectory,
    })
  );
}

async function runScenario(
  name: ScenarioResult['name'],
  projectPath: string,
  workingDirectory: string,
  cacheDir: string,
  edit?: {
    filePath: string;
    rewrite: (sourceText: string) => string;
  },
): Promise<ScenarioResult> {
  await Deno.mkdir(cacheDir, { recursive: true });
  const seedRun = runCachedCheck(projectPath, workingDirectory, cacheDir);

  if (!edit) {
    const run = runCachedCheck(projectPath, workingDirectory, cacheDir);
    return {
      diagnostics: run.result.diagnostics.length,
      exitCode: run.result.exitCode,
      name,
      runMs: run.durationMs,
      seedMs: seedRun.durationMs,
    };
  }

  const originalText = await Deno.readTextFile(edit.filePath);
  try {
    await Deno.writeTextFile(edit.filePath, edit.rewrite(originalText));
    const run = runCachedCheck(projectPath, workingDirectory, cacheDir);
    return {
      diagnostics: run.result.diagnostics.length,
      exitCode: run.result.exitCode,
      name,
      runMs: run.durationMs,
      seedMs: seedRun.durationMs,
    };
  } finally {
    await Deno.writeTextFile(edit.filePath, originalText);
  }
}

function printHeader(
  projectPath: string,
  workingDirectory: string,
  stsFile: string,
  cacheRoot: string,
): void {
  console.log(`# projectPath\t${projectPath}`);
  console.log(`# workingDirectory\t${workingDirectory}`);
  console.log(`# stsFile\t${stsFile}`);
  console.log(`# cacheRoot\t${cacheRoot}`);
  console.log('scenario\tseedMs\trunMs\texitCode\tdiagnostics');
}

function printScenario(result: ScenarioResult): void {
  console.log(
    [
      result.name,
      result.seedMs.toFixed(1),
      result.runMs.toFixed(1),
      String(result.exitCode),
      String(result.diagnostics),
    ].join('\t'),
  );
}

async function main(): Promise<void> {
  let options: HarnessOptions;
  try {
    options = parseArgs(Deno.args);
  } catch (error) {
    printUsage();
    throw error;
  }

  const projectPath = resolveCliPath(options.projectPath);
  const workingDirectory = resolveCliPath(options.workingDirectory ?? dirname(projectPath));
  const cacheRoot = options.cacheDir
    ? resolveCliPath(options.cacheDir)
    : await Deno.makeTempDir({ prefix: 'soundscript-check-perf-' });
  const preparedProject = prepareProjectAnalysis({
    projectPath,
    workingDirectory,
  });
  const stsFile = options.stsFile
    ? resolveCliPath(options.stsFile)
    : chooseRepresentativeSourceFile(preparedProject);
  disposePreparedAnalysisProject(preparedProject);

  if (!stsFile) {
    throw new Error('Unable to find a representative .sts file. Pass --sts-file explicitly.');
  }

  printHeader(projectPath, workingDirectory, stsFile, cacheRoot);
  const scenarios = options.scenario === 'all'
    ? ['unchanged', 'body-edit', 'surface-edit'] as const
    : [options.scenario];

  for (const scenario of scenarios) {
    const scenarioCacheDir = join(cacheRoot, scenario);
    try {
      await Deno.remove(scenarioCacheDir, { recursive: true });
    } catch {
      // Ignore missing cache directories and start fresh.
    }

    if (scenario === 'unchanged') {
      printScenario(
        await runScenario(
          'unchanged',
          projectPath,
          workingDirectory,
          scenarioCacheDir,
        ),
      );
      continue;
    }

    printScenario(
      await runScenario(
        scenario,
        projectPath,
        workingDirectory,
        scenarioCacheDir,
        {
          filePath: stsFile,
          rewrite: scenario === 'body-edit' ? createBodyEditText : createSurfaceEditText,
        },
      ),
    );
  }
}

if (import.meta.main) {
  await main();
}
