import ts from 'typescript';

import type {
  AnalysisContext,
  EffectForwardedParameterFact,
  EffectSummaryFact,
  EffectUnknownReasonFact,
  EffectUnknownReasonKind,
} from '../engine/types.ts';

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

function formatForwardedParameterLabel(
  forwardedParameter: EffectForwardedParameterFact,
): string | undefined {
  return forwardedParameter.parameterName
    ? [forwardedParameter.parameterName, ...forwardedParameter.memberPath].join('.')
    : forwardedParameter.memberPath.length > 0
    ? `<param ${forwardedParameter.parameterIndex + 1}>.${forwardedParameter.memberPath.join('.')}`
    : `<param ${forwardedParameter.parameterIndex + 1}>`;
}

function getUnresolvedForwardedStepForType(
  context: AnalysisContext,
  location: ts.Node,
  currentType: ts.Type,
  memberPath: readonly string[],
): string | undefined {
  if (memberPath.length === 0) {
    return undefined;
  }

  for (let index = 0; index < memberPath.length; index += 1) {
    const step = memberPath[index]!;
    const property = currentType.getProperty(step);
    if (!property) {
      return step;
    }
    const isOptionalProperty = (property.flags & ts.SymbolFlags.Optional) !== 0;
    if (isOptionalProperty) {
      return index === memberPath.length - 1 ? step : memberPath[index + 1]!;
    }
    const memberType = context.checker.getTypeOfSymbolAtLocation(property, location);
    if (index === memberPath.length - 1) {
      const callSignatures = context.checker.getSignaturesOfType(memberType, ts.SignatureKind.Call);
      const constructSignatures = context.checker.getSignaturesOfType(
        memberType,
        ts.SignatureKind.Construct,
      );
      return callSignatures.length === 0 && constructSignatures.length === 0 ? step : undefined;
    }
    currentType = memberType;
  }

  return undefined;
}

function formatForwardedParameterDetailForSignature(
  context: AnalysisContext,
  signature: ts.Signature,
  forwardedParameter: EffectForwardedParameterFact,
): string | undefined {
  const label = formatForwardedParameterLabel(forwardedParameter);
  const parameterSymbol = signature.getParameters()[forwardedParameter.parameterIndex];
  const location = parameterSymbol?.valueDeclaration ?? signature.getDeclaration();
  if (!parameterSymbol || !location) {
    return label;
  }

  const parameterType = context.checker.getTypeOfSymbolAtLocation(parameterSymbol, location);
  const unresolvedStep = getUnresolvedForwardedStepForType(
    context,
    location,
    parameterType,
    forwardedParameter.memberPath,
  );
  return unresolvedStep && label ? `${label}; failed at ${unresolvedStep}` : label;
}

export function unknownReasonsForForwardedParameters(
  forwardedParameters: readonly EffectForwardedParameterFact[],
): readonly EffectUnknownReasonFact[] {
  return forwardedParameters.length === 0
    ? []
    : forwardedParameters.map((forwardedParameter) =>
      createEffectUnknownReason(
        'unresolvedForwardedCallback',
        formatForwardedParameterLabel(forwardedParameter),
      )
    );
}

export function unknownReasonsForForwardedParametersAtSignature(
  context: AnalysisContext,
  signature: ts.Signature,
  forwardedParameters: readonly EffectForwardedParameterFact[],
): readonly EffectUnknownReasonFact[] {
  return forwardedParameters.length === 0
    ? []
    : forwardedParameters.map((forwardedParameter) =>
      createEffectUnknownReason(
        'unresolvedForwardedCallback',
        formatForwardedParameterDetailForSignature(context, signature, forwardedParameter),
      )
    );
}

export function getEffectSummaryUnknownReasons(
  summary: EffectSummaryFact,
): readonly EffectUnknownReasonFact[] {
  return mergeEffectUnknownReasons(
    summary.unknownDirectReasons,
    unknownReasonsForForwardedParameters(summary.forwardedParameters),
  );
}

export function getEffectSummaryUnknownReasonsForSignature(
  context: AnalysisContext,
  signature: ts.Signature,
  summary: EffectSummaryFact,
): readonly EffectUnknownReasonFact[] {
  return mergeEffectUnknownReasons(
    summary.unknownDirectReasons,
    unknownReasonsForForwardedParametersAtSignature(context, signature, summary.forwardedParameters),
  );
}

export function effectSummaryHasUnknown(summary: EffectSummaryFact): boolean {
  return hasUnknownEffectReasons(getEffectSummaryUnknownReasons(summary));
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
      return reason.detail === undefined
        ? 'unresolved forwarded callback'
        : `unresolved forwarded callback (${reason.detail})`;
    case 'unsummarizedDeclarationFrontier':
      return 'unsummarized declaration frontier';
  }
}

export function formatEffectUnknownReasons(
  reasons: readonly EffectUnknownReasonFact[],
): readonly string[] {
  return reasons.map((reason) => formatEffectUnknownReason(reason));
}
