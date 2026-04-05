import type { MergedDiagnostic } from '../checker/diagnostics.ts';
import type { RuntimeTarget } from '../config.ts';

export interface AnalyzeProjectOptions {
  additionalRootNames?: readonly string[];
  fileOverrides?: ReadonlyMap<string, string>;
  projectPath: string;
  target?: RuntimeTarget;
  workingDirectory: string;
}

export interface AnalyzeProjectSummary {
  total: number;
  errors: number;
  warnings: number;
  messages: number;
}

export interface AnalyzeProjectResult {
  diagnostics: MergedDiagnostic[];
  summary: AnalyzeProjectSummary;
}
