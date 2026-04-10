import ts from 'typescript';

import type {
  AnalysisContext,
  EffectNameFact,
  EffectSummaryFact,
  EffectUnknownReasonFact,
  PublicEffectName,
} from '../engine/types.ts';
import { effectSetsOverlap, subtractEffectSet } from './names.ts';
import { effectSummaryHasUnknown, getEffectSummaryUnknownReasonsForSignature } from './unknown.ts';

export interface CallableEffectContractMismatch {
  forbiddenEffects: readonly EffectNameFact[];
  kind: 'outer' | 'parameter';
  unknownReasons?: readonly EffectUnknownReasonFact[];
  parameterName?: string;
}

export function classifyCallableEffectContractMismatch(
  context: AnalysisContext,
  sourceSummary: EffectSummaryFact | undefined,
  targetSummary: EffectSummaryFact | undefined,
  sourceSignature: ts.Signature,
  targetSignature: ts.Signature,
): CallableEffectContractMismatch | undefined {
  const targetForbidEffects = targetSummary?.forbidEffects ?? [];
  if (
    targetForbidEffects.length !== 0 &&
    (!sourceSummary ||
      effectSummaryHasUnknown(sourceSummary) ||
      effectSetsOverlap(sourceSummary.directEffects, targetForbidEffects))
  ) {
    return {
      forbiddenEffects: targetForbidEffects,
      kind: 'outer',
      unknownReasons: sourceSummary
        ? getEffectSummaryUnknownReasonsForSignature(context, sourceSignature, sourceSummary)
        : undefined,
    };
  }

  const sourceParameterContracts = new Map(
    (sourceSummary?.parameterContracts ?? []).map((
      contract,
    ) => [contract.parameterIndex, contract]),
  );
  const targetParameterContracts = new Map(
    (targetSummary?.parameterContracts ?? []).map((
      contract,
    ) => [contract.parameterIndex, contract]),
  );
  const parameterCount = Math.max(
    sourceSignature.getParameters().length,
    targetSignature.getParameters().length,
  );
  for (let index = 0; index < parameterCount; index += 1) {
    const sourceForbidEffects = sourceParameterContracts.get(index)?.forbidEffects ?? [];
    const targetForbidEffects = targetParameterContracts.get(index)?.forbidEffects ?? [];
    const missingEffects = subtractEffectSet(sourceForbidEffects, targetForbidEffects);
    if (missingEffects.length === 0) {
      continue;
    }
    return {
      forbiddenEffects: missingEffects,
      kind: 'parameter',
      parameterName: targetSignature.getParameters()[index]?.getName() ??
        sourceSignature.getParameters()[index]?.getName(),
    };
  }

  return undefined;
}
