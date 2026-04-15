import { dirname, fromFileUrl, isAbsolute, join } from '@std/path';

import { loadConfig } from '../../src/project/config.ts';

interface HarnessOptions {
  cacheDir?: string;
  compareTsc: boolean;
  frontierFiles: string[];
  keepOverlay: boolean;
  projectPath: string;
  workingDirectory?: string;
}

interface TimedCommandResult {
  durationMs: number;
  exitCode: number;
  stderr: string;
  stdout: string;
}

function printUsage(): void {
  console.error(
    [
      'Usage:',
      '  deno run -A scripts/perf/checker_frontier_overlay.ts --project /abs/path/to/tsconfig.json --frontier-file /abs/path/to/file.ts',
      '',
      'Optional flags:',
      '  --frontier-file /abs/path/to/another-frontier.ts',
      '  --working-directory /abs/path/to/project/root',
      '  --cache-dir /abs/path/to/cache/root',
      '  --compare-tsc',
      '  --keep-overlay',
    ].join('\n'),
  );
}

function parseArgs(args: readonly string[]): HarnessOptions {
  const options: HarnessOptions = {
    compareTsc: false,
    frontierFiles: [],
    keepOverlay: false,
    projectPath: '',
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--project') {
      options.projectPath = args[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (argument === '--frontier-file') {
      const frontierFile = args[index + 1];
      if (!frontierFile || frontierFile.startsWith('-')) {
        throw new Error('Missing value for --frontier-file.');
      }
      options.frontierFiles.push(frontierFile);
      index += 1;
      continue;
    }
    if (argument === '--working-directory') {
      options.workingDirectory = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--cache-dir') {
      options.cacheDir = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--compare-tsc') {
      options.compareTsc = true;
      continue;
    }
    if (argument === '--keep-overlay') {
      options.keepOverlay = true;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.projectPath) {
    throw new Error('Missing required --project argument.');
  }
  if (options.frontierFiles.length === 0) {
    throw new Error('At least one --frontier-file is required.');
  }

  return options;
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : join(Deno.cwd(), path);
}

function repoRoot(): string {
  return dirname(dirname(dirname(fromFileUrl(import.meta.url))));
}

async function createOverlayProject(
  baseProjectPath: string,
  frontierFiles: readonly string[],
): Promise<{ overlayDirectory: string; overlayProjectPath: string }> {
  const overlayDirectory = await Deno.makeTempDir({ prefix: 'soundscript-frontier-overlay-' });
  const overlayProjectPath = join(overlayDirectory, 'tsconfig.json');
  await Deno.writeTextFile(
    overlayProjectPath,
    JSON.stringify(
      {
        extends: baseProjectPath,
        soundscript: {
          include: frontierFiles,
        },
      },
      null,
      2,
    ),
  );
  return { overlayDirectory, overlayProjectPath };
}

async function runCommand(
  command: Deno.Command,
): Promise<TimedCommandResult> {
  const start = performance.now();
  const output = await command.output();
  return {
    durationMs: performance.now() - start,
    exitCode: output.code,
    stderr: new TextDecoder().decode(output.stderr),
    stdout: new TextDecoder().decode(output.stdout),
  };
}

function createSoundscriptCheckCommand(
  overlayProjectPath: string,
  cacheDir: string | undefined,
  useCache: boolean,
): Deno.Command {
  const args = [
    'run',
    '-A',
    join(repoRoot(), 'src/cli/cli.ts'),
    'check',
    '--project',
    overlayProjectPath,
    '--format',
    'json',
  ];
  if (!useCache) {
    args.push('--no-cache');
  }
  if (cacheDir) {
    args.push('--cache-dir', cacheDir);
  }
  return new Deno.Command(Deno.execPath(), {
    args,
    cwd: repoRoot(),
    stderr: 'piped',
    stdout: 'piped',
  });
}

function createTscCommand(
  baseProjectPath: string,
  workingDirectory: string,
): Deno.Command {
  return new Deno.Command('npx', {
    args: ['tsc', '--noEmit', '-p', baseProjectPath],
    cwd: workingDirectory,
    stderr: 'piped',
    stdout: 'piped',
  });
}

function printHeader(
  baseProjectPath: string,
  overlayProjectPath: string,
  workingDirectory: string,
  cacheDir: string | undefined,
  loadedConfig: ReturnType<typeof loadConfig>,
): void {
  console.log(`# baseProjectPath\t${baseProjectPath}`);
  console.log(`# overlayProjectPath\t${overlayProjectPath}`);
  console.log(`# workingDirectory\t${workingDirectory}`);
  if (cacheDir) {
    console.log(`# cacheDir\t${cacheDir}`);
  }
  console.log(`# commandLineFiles\t${loadedConfig.commandLine.fileNames.length}`);
  console.log(`# hostRootNames\t${loadedConfig.hostRootNames.length}`);
  console.log(`# frontierRootNames\t${loadedConfig.frontierRootNames.length}`);
  console.log('scenario\tdurationMs\texitCode\tstdoutBytes\tstderrBytes');
}

function printScenario(
  name: string,
  result: TimedCommandResult,
): void {
  console.log(
    [
      name,
      result.durationMs.toFixed(1),
      String(result.exitCode),
      String(result.stdout.length),
      String(result.stderr.length),
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

  const baseProjectPath = resolveCliPath(options.projectPath);
  const frontierFiles = options.frontierFiles.map(resolveCliPath);
  const workingDirectory = resolveCliPath(options.workingDirectory ?? dirname(baseProjectPath));
  const cacheDir = options.cacheDir
    ? resolveCliPath(options.cacheDir)
    : await Deno.makeTempDir({ prefix: 'soundscript-frontier-cache-' });
  const { overlayDirectory, overlayProjectPath } = await createOverlayProject(
    baseProjectPath,
    frontierFiles,
  );

  try {
    const loadedConfig = loadConfig(overlayProjectPath);
    printHeader(baseProjectPath, overlayProjectPath, workingDirectory, cacheDir, loadedConfig);

    if (options.compareTsc) {
      printScenario('tsc.noEmit', await runCommand(createTscCommand(baseProjectPath, workingDirectory)));
    }

    printScenario(
      'soundscript.cold.noCache',
      await runCommand(createSoundscriptCheckCommand(overlayProjectPath, cacheDir, false)),
    );
    printScenario(
      'soundscript.warm.seed',
      await runCommand(createSoundscriptCheckCommand(overlayProjectPath, cacheDir, true)),
    );
    printScenario(
      'soundscript.warm.hit',
      await runCommand(createSoundscriptCheckCommand(overlayProjectPath, cacheDir, true)),
    );
  } finally {
    if (!options.keepOverlay) {
      await Deno.remove(overlayDirectory, { recursive: true });
    }
  }
}

if (import.meta.main) {
  await main();
}
