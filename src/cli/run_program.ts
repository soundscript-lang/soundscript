import {
  formatDiagnostics,
  hasErrorDiagnostics,
  type MergedDiagnostic,
} from '../checker/diagnostics.ts';
import { analyzeProjectWithPersistentCache } from '../checker/checker_cache.ts';
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
  const analysis = analyzeProjectWithPersistentCache({
    cacheDir: options.cacheDir,
    projectPath: options.projectPath,
    target: options.target,
    useCache: options.useCache,
    workingDirectory: options.workingDirectory,
  });

  return {
    diagnostics: analysis.diagnostics,
    output: formatDiagnostics(analysis.diagnostics, options.workingDirectory),
    exitCode: hasErrorDiagnostics(analysis.diagnostics) ? 1 : 0,
  };
}
