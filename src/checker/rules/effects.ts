import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext, PublicEffectName } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';
import {
  callableExpressionMayViolateForbidMask,
  declarationMayViolateOwnForbid,
  effectMaskToPublicNames,
  getCallableContractSummary,
  getEffectCompositionForCallLike,
  getEffectContractName,
  getEffectSummaryForDeclaration,
  getEffectSummaryForSignature,
  getParameterContractName,
} from '../effects.ts';

type EffectViolationContext =
  | {
    kind: 'call';
    primarySymbol: string;
    forbiddenEffects: readonly PublicEffectName[];
    relation: 'callee_forbid' | 'parameter_forbid';
  }
  | {
    kind: 'declaration';
    primarySymbol: string;
    forbiddenEffects: readonly PublicEffectName[];
  }
  | {
    kind: 'relation';
    primarySymbol?: string;
    forbiddenEffects: readonly PublicEffectName[];
    rule: 'callable_effect_covariance' | 'callable_effect_parameter_contravariance';
  };

function formatPublicEffectList(effects: readonly PublicEffectName[]): string {
  return effects.map((effect) => `\`${effect}\``).join(', ');
}

function createEffectContractViolationDiagnostic(
  node: ts.Node,
  context: EffectViolationContext,
): SoundDiagnostic {
  const example = context.kind === 'declaration'
    ? `Rewrite \`${context.primarySymbol}\` so it stays within ${formatPublicEffectList(context.forbiddenEffects)}, or relax the \`#[effects(forbid: [...])]\` contract.`
    : context.kind === 'call' && context.relation === 'parameter_forbid'
    ? `Pass a callback that stays within ${formatPublicEffectList(context.forbiddenEffects)}, or relax the parameter contract.`
    : context.kind === 'relation'
    ? `Align the callable assignment so it preserves ${formatPublicEffectList(context.forbiddenEffects)}.`
    : `Pass arguments whose composed effects stay within ${formatPublicEffectList(context.forbiddenEffects)}, or relax the callee contract.`;

  const message = context.kind === 'declaration'
    ? `${SOUND_DIAGNOSTIC_MESSAGES.effectContractViolation} \`${context.primarySymbol}\` forbids ${formatPublicEffectList(context.forbiddenEffects)}, but its implementation may perform those effects.`
    : context.kind === 'relation'
    ? context.rule === 'callable_effect_covariance'
      ? 'Callable effect contracts are covariant in soundscript.'
      : 'Higher-order callback effect contracts are contravariant in soundscript.'
    : context.relation === 'parameter_forbid'
    ? `${SOUND_DIAGNOSTIC_MESSAGES.effectContractViolation} Argument passed to \`${context.primarySymbol}\` may perform forbidden effects: ${formatPublicEffectList(context.forbiddenEffects)}.`
    : `${SOUND_DIAGNOSTIC_MESSAGES.effectContractViolation} Call to \`${context.primarySymbol}\` may violate its declared \`forbid\` contract with effects ${formatPublicEffectList(context.forbiddenEffects)}.`;

  return {
    source: 'sound',
    code: context.kind === 'relation'
      ? SOUND_DIAGNOSTIC_CODES.unsoundRelation
      : SOUND_DIAGNOSTIC_CODES.effectContractViolation,
    category: 'error',
    message,
    metadata: {
      rule: context.kind === 'relation' ? context.rule : 'effect_contract_violation',
      primarySymbol: context.primarySymbol,
      fixability: context.kind === 'declaration' ? 'boundary_annotation' : 'local_rewrite',
      invariant:
        'Checked effect contracts only hold when direct callable behavior and callback arguments stay within the declared forbidden-effect surface.',
      replacementFamily: 'checked_effect_contract',
      evidence: [
        {
          label: 'forbiddenEffects',
          value: context.forbiddenEffects.join(', '),
        },
      ],
      counterexample:
        'A callable that performs or forwards forbidden effects can look effect-safe even though callers cannot rely on that contract.',
      example,
    },
    notes: [
      message.replace(`${SOUND_DIAGNOSTIC_MESSAGES.effectContractViolation} `, ''),
      `Example: ${example}`,
    ],
    hint:
      'Tighten the implementation or callback argument, or loosen the forbid contract to match the actual effect surface.',
    ...getNodeDiagnosticRange(node),
  };
}

function classifyCallableRelationViolation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): EffectViolationContext | undefined {
  for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct] as const) {
    const sourceSignatures = context.checker.getSignaturesOfType(sourceType, kind);
    const targetSignatures = context.checker.getSignaturesOfType(targetType, kind);
    if (sourceSignatures.length === 0 || targetSignatures.length === 0) {
      continue;
    }

    for (const targetSignature of targetSignatures) {
      let foundSafeSource = false;
      let firstViolation: EffectViolationContext | undefined;
      for (const sourceSignature of sourceSignatures) {
        const sourceSummary = getEffectSummaryForSignature(context, sourceSignature);
        const targetSummary = getEffectSummaryForSignature(context, targetSignature);
        const targetForbidMask = targetSummary?.forbidMask ?? 0;
        if (targetForbidMask !== 0 &&
          (!sourceSummary ||
            sourceSummary.hasUnknownDirectEffects ||
            (sourceSummary.directMask & targetForbidMask) !== 0)
        ) {
          firstViolation ??= {
            kind: 'relation',
            forbiddenEffects: effectMaskToPublicNames(targetForbidMask),
            rule: 'callable_effect_covariance',
          };
          continue;
        }

        const sourceParameterContracts = new Map(
          (sourceSummary?.parameterContracts ?? []).map((contract) => [contract.parameterIndex, contract]),
        );
        const targetParameterContracts = new Map(
          (targetSummary?.parameterContracts ?? []).map((contract) => [contract.parameterIndex, contract]),
        );
        let parameterViolation: EffectViolationContext | undefined;
        const parameterCount = Math.max(
          sourceSignature.getParameters().length,
          targetSignature.getParameters().length,
        );
        for (let index = 0; index < parameterCount; index += 1) {
          const sourceForbidMask = sourceParameterContracts.get(index)?.forbidMask ?? 0;
          const targetForbidMask = targetParameterContracts.get(index)?.forbidMask ?? 0;
          if ((sourceForbidMask & ~targetForbidMask) === 0) {
            continue;
          }
          parameterViolation = {
            kind: 'relation',
            forbiddenEffects: effectMaskToPublicNames(sourceForbidMask & ~targetForbidMask),
            primarySymbol: targetSignature.getParameters()[index]?.getName() ??
              sourceSignature.getParameters()[index]?.getName(),
            rule: 'callable_effect_parameter_contravariance',
          };
          break;
        }

        if (parameterViolation) {
          firstViolation ??= parameterViolation;
          continue;
        }

        foundSafeSource = true;
        break;
      }

      if (!foundSafeSource) {
        return firstViolation;
      }
    }
  }

  return undefined;
}

function isEffectCheckedDeclaration(node: ts.Node): node is
  | ts.ArrowFunction
  | ts.CallSignatureDeclaration
  | ts.ConstructorDeclaration
  | ts.ConstructSignatureDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.MethodSignature {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
}

function isSignatureDeclarationWithParameters(node: ts.Node): node is ts.SignatureDeclarationBase {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
}

export function runEffectRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    const visit = (node: ts.Node): void => {
      if (context.isGeneratedNode(node)) {
        return;
      }

      if (isEffectCheckedDeclaration(node)) {
        const summary = getEffectSummaryForDeclaration(context, node);
        if (declarationMayViolateOwnForbid(summary)) {
          diagnostics.push(
            createEffectContractViolationDiagnostic(node, {
              kind: 'declaration',
              primarySymbol: getEffectContractName(node),
              forbiddenEffects: effectMaskToPublicNames(summary.forbidMask),
            }),
          );
        }
      }

      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const summary = getCallableContractSummary(context, node);
        if (summary) {
          for (const contract of summary.parameterContracts) {
            const argument = node.arguments?.[contract.parameterIndex];
            if (!argument || !callableExpressionMayViolateForbidMask(context, argument, contract.forbidMask)) {
              continue;
            }
            const declaration = context.checker.getResolvedSignature(node)?.getDeclaration();
            const parameterName = declaration && isSignatureDeclarationWithParameters(declaration)
              ? getParameterContractName(declaration, contract.parameterIndex)
              : `<param ${contract.parameterIndex + 1}>`;
            diagnostics.push(
              createEffectContractViolationDiagnostic(node, {
                kind: 'call',
                primarySymbol: parameterName,
                forbiddenEffects: effectMaskToPublicNames(contract.forbidMask),
                relation: 'parameter_forbid',
              }),
            );
          }

          if (summary.forbidMask !== 0) {
            const composedEffects = getEffectCompositionForCallLike(context, node);
            if (composedEffects.unknown || (composedEffects.mask & summary.forbidMask) !== 0) {
              diagnostics.push(
                createEffectContractViolationDiagnostic(node, {
                  kind: 'call',
                  primarySymbol: getEffectContractName(
                    context.checker.getResolvedSignature(node)?.getDeclaration() ?? node.expression,
                  ),
                  forbiddenEffects: effectMaskToPublicNames(summary.forbidMask),
                  relation: 'callee_forbid',
                }),
              );
            }
          }
        }
      }

      if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
        const relationViolation = classifyCallableRelationViolation(
          context,
          context.checker.getTypeAtLocation(node.initializer),
          context.checker.getTypeFromTypeNode(node.type),
        );
        if (relationViolation) {
          diagnostics.push(createEffectContractViolationDiagnostic(node, relationViolation));
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  });

  return diagnostics;
}
