import { dirname, isAbsolute, join } from '@std/path';

import {
  analyzePreparedProject,
  type PreparedAnalysisProject,
  prepareProjectAnalysis,
} from '../../src/checker/analyze_project.ts';
import {
  sourceTextLooksLikeMacroModule,
  usesLegacyDefineMacroAuthoring,
} from '../../src/frontend/macro_factory_support.ts';

interface HarnessOptions {
  macroFile?: string;
  projectPath: string;
  stsFile?: string;
  tsFile?: string;
  workingDirectory?: string;
}

interface ScenarioResult {
  analyzeMs: number;
  diagnostics: number;
  errors: number;
  messages: number;
  name: string;
  prepareMs: number;
  warnings: number;
}

function printUsage(): void {
  console.error(
    [
      'Usage:',
      '  deno run -A scripts/perf/checker_real_project.ts --project /abs/path/to/tsconfig.soundscript.json',
      '',
      'Optional flags:',
      '  --working-directory /abs/path/to/project/root',
      '  --sts-file /abs/path/to/file.sts',
      '  --ts-file /abs/path/to/file.ts',
      '  --macro-file /abs/path/to/file.macro.sts',
    ].join('\n'),
  );
}

function parseArgs(args: readonly string[]): HarnessOptions {
  const options: HarnessOptions = { projectPath: '' };

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
    if (argument === '--ts-file') {
      options.tsFile = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--macro-file') {
      options.macroFile = args[index + 1];
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
  kind: 'macro' | 'sts' | 'ts',
): string | undefined {
  if (kind === 'ts') {
    const tsView = preparedProject.tsView;
    if (!tsView) {
      return undefined;
    }

    return tsView.program.getSourceFiles()
      .map((sourceFile) => tsView.preparedProgram.toSourceFileName(sourceFile.fileName))
      .filter((fileName) => fileName.endsWith('.ts') && !fileName.endsWith('.d.ts'))
      .filter((fileName) => !fileName.includes('/node_modules/'))
      .sort()[0];
  }

  const stsView = preparedProject.stsView;
  if (!stsView) {
    return undefined;
  }

  const candidateFiles = stsView.program.getSourceFiles()
    .map((sourceFile) => stsView.preparedProgram.toSourceFileName(sourceFile.fileName))
    .filter((fileName) => fileName.endsWith('.sts'))
    .filter((fileName) => !fileName.includes('/node_modules/'))
    .sort();

  if (kind === 'sts') {
    return candidateFiles.find((fileName) => !fileName.endsWith('.macro.sts')) ?? candidateFiles[0];
  }

  return candidateFiles.find((fileName) => {
    const sourceText =
      stsView.preparedProgram.preparedHost.getPreparedSourceFile(fileName)?.originalText ??
        Deno.readTextFileSync(fileName);
    return sourceTextLooksLikeMacroModule(sourceText) || usesLegacyDefineMacroAuthoring(sourceText);
  });
}

function createFileOverrideText(fileName: string, sourceText: string): string {
  if (fileName.endsWith('.sts')) {
    return `${sourceText}\nexport const __codex_perf_probe__: number = 1;\n`;
  }

  return `${sourceText}\nexport const __codex_perf_probe__ = 1 as const;\n`;
}

function runScenario(
  name: string,
  projectPath: string,
  workingDirectory: string,
  reusableProject?: PreparedAnalysisProject,
  fileOverride?: readonly [string, string],
): { preparedProject: PreparedAnalysisProject; result: ScenarioResult } {
  const prepare = measure(() =>
    prepareProjectAnalysis(
      {
        projectPath,
        workingDirectory,
        fileOverrides: fileOverride ? new Map([fileOverride]) : undefined,
      },
      reusableProject,
    )
  );
  const analyze = measure(() => analyzePreparedProject(prepare.result));
  return {
    preparedProject: prepare.result,
    result: {
      analyzeMs: analyze.durationMs,
      diagnostics: analyze.result.summary.total,
      errors: analyze.result.summary.errors,
      messages: analyze.result.summary.messages,
      name,
      prepareMs: prepare.durationMs,
      warnings: analyze.result.summary.warnings,
    },
  };
}

function printHeader(
  projectPath: string,
  workingDirectory: string,
  stsFile: string | undefined,
  tsFile: string | undefined,
  macroFile: string | undefined,
): void {
  console.log(`# projectPath\t${projectPath}`);
  console.log(`# workingDirectory\t${workingDirectory}`);
  if (stsFile) {
    console.log(`# stsFile\t${stsFile}`);
  }
  if (tsFile) {
    console.log(`# tsFile\t${tsFile}`);
  }
  if (macroFile) {
    console.log(`# macroFile\t${macroFile}`);
  }
  console.log('scenario\tprepareMs\tanalyzeMs\tdiagnostics\terrors\twarnings\tmessages');
}

function printScenario(result: ScenarioResult): void {
  console.log(
    [
      result.name,
      result.prepareMs.toFixed(1),
      result.analyzeMs.toFixed(1),
      String(result.diagnostics),
      String(result.errors),
      String(result.warnings),
      String(result.messages),
    ].join('\t'),
  );
}

function main(): void {
  let options: HarnessOptions;
  try {
    options = parseArgs(Deno.args);
  } catch (error) {
    printUsage();
    throw error;
  }

  const projectPath = resolveCliPath(options.projectPath);
  const workingDirectory = resolveCliPath(options.workingDirectory ?? dirname(projectPath));
  const coldScenario = runScenario('cold', projectPath, workingDirectory);
  const warmNoopScenario = runScenario(
    'warm.noop',
    projectPath,
    workingDirectory,
    coldScenario.preparedProject,
  );

  const stsFile = options.stsFile
    ? resolveCliPath(options.stsFile)
    : chooseRepresentativeSourceFile(warmNoopScenario.preparedProject, 'sts');
  const tsFile = options.tsFile
    ? resolveCliPath(options.tsFile)
    : chooseRepresentativeSourceFile(warmNoopScenario.preparedProject, 'ts');
  const macroFile = options.macroFile
    ? resolveCliPath(options.macroFile)
    : chooseRepresentativeSourceFile(warmNoopScenario.preparedProject, 'macro');

  printHeader(projectPath, workingDirectory, stsFile, tsFile, macroFile);
  printScenario(coldScenario.result);
  printScenario(warmNoopScenario.result);

  const runEditedScenario = (name: string, fileName: string | undefined): void => {
    if (!fileName) {
      return;
    }

    const sourceText = Deno.readTextFileSync(fileName);
    const { result } = runScenario(
      name,
      projectPath,
      workingDirectory,
      warmNoopScenario.preparedProject,
      [fileName, createFileOverrideText(fileName, sourceText)],
    );
    printScenario(result);
  };

  runEditedScenario('warm.stsEdit', stsFile);
  runEditedScenario('warm.tsEdit', tsFile);
  runEditedScenario('warm.macroEdit', macroFile);
}

if (import.meta.main) {
  main();
}
