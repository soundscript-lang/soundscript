import ts from 'typescript';

import type { EffectNameFact, EffectSummaryFact, EffectUnknownReasonFact, PublicEffectName } from '../engine/types.ts';
import { subtractEffectSet, effectSetsOverlap } from './names.ts';

export interface CallableEffectContractMismatch {
  forbiddenEffects: readonly EffectNameFact[];
  kind: 'outer' | 'parameter';
  unknownReasons?: readonly EffectUnknownReasonFact[];
  parameterName?: string;
}

export function classifyCallableEffectContractMismatch(
  sourceSummary: EffectSummaryFact | undefined,
  targetSummary: EffectSummaryFact | undefined,
  sourceSignature: ts.Signature,
  targetSignature: ts.Signature,
): CallableEffectContractMismatch | undefined {
  const targetForbidEffects = targetSummary?.forbidEffects ?? [];
  if (
    targetForbidEffects.length !== 0 &&
    (!sourceSummary ||
      sourceSummary.hasUnknownDirectEffects ||
      effectSetsOverlap(sourceSummary.directEffects, targetForbidEffects))
  ) {
    return {
      forbiddenEffects: targetForbidEffects,
      kind: 'outer',
      unknownReasons: sourceSummary?.hasUnknownDirectEffects ? sourceSummary.unknownDirectReasons : undefined,
    };
  }

  const sourceParameterContracts = new Map(
    (sourceSummary?.parameterContracts ?? []).map((contract) => [contract.parameterIndex, contract]),
  );
  const targetParameterContracts = new Map(
    (targetSummary?.parameterContracts ?? []).map((contract) => [contract.parameterIndex, contract]),
  );
  const parameterCount = Math.max(sourceSignature.getParameters().length, targetSignature.getParameters().length);
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
