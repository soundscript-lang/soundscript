import ts from 'typescript';

import type { EffectSummaryFact, EffectUnknownReasonFact, PublicEffectName } from '../engine/types.ts';
import { effectMaskToPublicNames } from './masks.ts';

export interface CallableEffectContractMismatch {
  forbiddenEffects: readonly PublicEffectName[];
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
  const targetForbidMask = targetSummary?.forbidMask ?? 0;
  if (
    targetForbidMask !== 0 &&
    (!sourceSummary ||
      sourceSummary.hasUnknownDirectEffects ||
      (sourceSummary.directMask & targetForbidMask) !== 0)
  ) {
    return {
      forbiddenEffects: effectMaskToPublicNames(targetForbidMask),
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
    const sourceForbidMask = sourceParameterContracts.get(index)?.forbidMask ?? 0;
    const targetForbidMask = targetParameterContracts.get(index)?.forbidMask ?? 0;
    if ((sourceForbidMask & ~targetForbidMask) === 0) {
      continue;
    }
    return {
      forbiddenEffects: effectMaskToPublicNames(sourceForbidMask & ~targetForbidMask),
      kind: 'parameter',
      parameterName: targetSignature.getParameters()[index]?.getName() ??
        sourceSignature.getParameters()[index]?.getName(),
    };
  }

  return undefined;
}
