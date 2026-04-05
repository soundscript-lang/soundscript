import type { AnalysisContext } from '../engine/types.ts';
import type { SoundDiagnostic } from '../diagnostics.ts';

import { runAsyncSurfaceRules } from './async_surface.ts';
import { runClassLifecycleRules } from './class_lifecycle.ts';
import { runPrototypeHardeningRules } from './prototype_hardening.ts';
import { runReceiverDisciplineRules } from './receiver_discipline.ts';

export function runSourceSupplementalPolicyAnalysis(context: AnalysisContext): SoundDiagnostic[] {
  return [
    ...runReceiverDisciplineRules(context),
    ...runClassLifecycleRules(context),
    ...runPrototypeHardeningRules(context),
  ];
}

export function runUniversalPolicyAnalysis(context: AnalysisContext): SoundDiagnostic[] {
  return [
    ...runAsyncSurfaceRules(context),
    ...runSourceSupplementalPolicyAnalysis(context),
  ];
}
