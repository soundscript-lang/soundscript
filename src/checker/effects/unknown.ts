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

export function formatEffectUnknownReason(reason: EffectUnknownReasonFact): string {
  switch (reason.kind) {
    case 'annotatedUnknownDirectEffect':
      return reason.detail === undefined
        ? 'annotation declares unknown direct effects'
        : `annotation declares unknown direct effects (${reason.detail})`;
    case 'opaqueCallableExpression':
      return 'opaque callable expression';
    case 'unresolvedForwardedCallback':
      return 'unresolved forwarded callback';
    case 'unsummarizedDeclarationFrontier':
      return 'unsummarized declaration frontier';
  }
}

export function formatEffectUnknownReasons(
  reasons: readonly EffectUnknownReasonFact[],
): readonly string[] {
  return reasons.map((reason) => formatEffectUnknownReason(reason));
}
