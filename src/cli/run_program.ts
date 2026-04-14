import {
  formatDiagnostics,
  hasErrorDiagnostics,
  type MergedDiagnostic,
} from '../checker/diagnostics.ts';
import { analyzeProjectWithPersistentCache } from '../checker/checker_cache.ts';
import { measureCheckerTiming } from '../checker/timing.ts';
import type { RuntimeTarget } from '../project/config.ts';

export interface RunProgramOptions {
  cacheDir?: string;
  projectPath: string;
  target?: RuntimeTarget;
  useCache?: boolean;
  workingDirectory: string;
}

export interface RunProgramResult {
  diagnostics: MergedDiagnostic[];
  output: string;
  exitCode: number;
}

export function runProgram(options: RunProgramOptions): RunProgramResult {
  return measureCheckerTiming(
    'runProgram.total',
    {
      cacheDir: options.cacheDir,
      projectPath: options.projectPath,
      useCache: options.useCache ?? true,
    },
    () => {
      const analysis = measureCheckerTiming(
        'runProgram.analysis',
        {
          cacheDir: options.cacheDir,
          projectPath: options.projectPath,
          useCache: options.useCache ?? true,
        },
        () =>
          analyzeProjectWithPersistentCache({
            cacheDir: options.cacheDir,
            projectPath: options.projectPath,
            target: options.target,
            useCache: options.useCache,
            workingDirectory: options.workingDirectory,
          }),
        { always: true },
      );
      const output = measureCheckerTiming(
        'runProgram.formatDiagnostics',
        {
          diagnostics: analysis.diagnostics.length,
          projectPath: options.projectPath,
        },
        () => formatDiagnostics(analysis.diagnostics, options.workingDirectory),
        { always: true },
      );

      return {
        diagnostics: analysis.diagnostics,
        output,
        exitCode: hasErrorDiagnostics(analysis.diagnostics) ? 1 : 0,
      };
    },
    { always: true },
  );
}
