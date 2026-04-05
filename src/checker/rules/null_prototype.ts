import type { AnalysisContext } from '../engine/types.ts';
import type { SoundDiagnostic } from '../diagnostics.ts';

export function runNullPrototypeRules(_context: AnalysisContext): SoundDiagnostic[] {
  return [];
}
