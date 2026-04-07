import type { EffectUnknownReasonFact, EffectUnknownReasonKind } from '../engine/types.ts';

export function createEffectUnknownReason(
  kind: EffectUnknownReasonKind,
  detail?: string,
): EffectUnknownReasonFact {
  return detail === undefined ? { kind } : { detail, kind };
}

export function hasUnknownEffectReasons(reasons: readonly EffectUnknownReasonFact[]): boolean {
  return reasons.length > 0;
}

export function mergeEffectUnknownReasons(
  ...groups: readonly (readonly EffectUnknownReasonFact[] | undefined)[]
): readonly EffectUnknownReasonFact[] {
  const merged: EffectUnknownReasonFact[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const reason of group ?? []) {
      const key = `${reason.kind}:${reason.detail ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(reason);
    }
  }
  return merged;
}

export function effectUnknownReasonsEqual(
  left: readonly EffectUnknownReasonFact[],
  right: readonly EffectUnknownReasonFact[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftReason = left[index]!;
    const rightReason = right[index]!;
    if (leftReason.kind !== rightReason.kind || leftReason.detail !== rightReason.detail) {
      return false;
    }
  }

  return true;
}
