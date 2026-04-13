import {
  formatDiagnostics,
  hasErrorDiagnostics,
  type MergedDiagnostic,
} from '../checker/diagnostics.ts';
import { analyzeProject } from '../checker/analyze_project.ts';
import type { RuntimeTarget } from '../project/config.ts';

export interface RunProgramOptions {
  projectPath: string;
  target?: RuntimeTarget;
  workingDirectory: string;
}

export interface RunProgramResult {
  diagnostics: MergedDiagnostic[];
  output: string;
  exitCode: number;
}

export function runProgram(options: RunProgramOptions): RunProgramResult {
  const analysis = analyzeProject({
    projectPath: options.projectPath,
    target: options.target,
    workingDirectory: options.workingDirectory,
  });

  return {
    diagnostics: analysis.diagnostics,
    output: formatDiagnostics(analysis.diagnostics, options.workingDirectory),
    exitCode: hasErrorDiagnostics(analysis.diagnostics) ? 1 : 0,
  };
}
