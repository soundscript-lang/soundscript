import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';
import { createAnyTypeDiagnostic } from '../proof_escape_hatch_diagnostics.ts';

import {
  classifyPredicateVerificationTarget,
  getForbiddenPredicateTypeNode,
  getPredicateCheck,
  getPredicateCheckForSignature,
  hasPredicateVerificationContract,
  isSignatureDeclarationWithBody,
  type PredicateCheck,
  type PredicateSignatureDeclaration,
  requiresPredicateVerification,
  verifyPredicateBody,
} from './predicate_verification.ts';
import { hasDirectAnnotation } from './trust.ts';

function getDeclarationName(
  declaration: PredicateSignatureDeclaration,
): string | undefined {
  return declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

function getPredicateTypeText(
  context: AnalysisContext,
  declaration: PredicateSignatureDeclaration,
): string | undefined {
  const signature = context.checker.getSignatureFromDeclaration(declaration);
  const predicate = signature ? context.checker.getTypePredicateOfSignature(signature) : undefined;
  return predicate?.type ? context.checker.typeToString(predicate.type) : undefined;
}

function createUnsupportedPredicateDiagnostic(
  context: AnalysisContext,
  declaration: PredicateSignatureDeclaration,
  node: ts.Node,
  reason: Exclude<
    Extract<ReturnType<typeof classifyPredicateVerificationTarget>, { kind: 'unsupported' }>['reason'],
    undefined
  >,
): SoundDiagnostic {
  const predicateType = getPredicateTypeText(context, declaration);
  const example =
    'Return boolean and narrow at the call site, or redesign the API around a supported predicate target.';
  const message = reason === 'unsupportedTarget' && predicateType
    ? `This predicate targets '${predicateType}', which soundscript does not currently verify.`
    : reason === 'receiverPredicate'
    ? 'Receiver predicates are not currently verified by soundscript.'
    : reason === 'assertsCondition'
    ? 'Assertion signatures without a target parameter are not currently verified by soundscript.'
    : 'soundscript only verifies predicates over supported named parameter targets.';

  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.predicateBodyMismatch,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.predicateBodyMismatch,
    metadata: {
      rule: 'predicate_target_unsupported',
      primarySymbol: getDeclarationName(declaration),
      fixability: 'api_redesign',
      invariant:
        'Checked predicate signatures must target one of the predicate shapes that soundscript can verify from the function body.',
      replacementFamily: 'supported_predicate_surface',
      evidence: [
        ...(predicateType ? [{ label: 'predicateType', value: predicateType }] : []),
        { label: 'unsupportedReason', value: reason },
      ],
      counterexample:
        'soundscript does not currently verify arbitrary predicate targets like arrays, tuples, generics, or receiver predicates from function bodies alone.',
      example,
    },
    notes: [
      message,
      `Example: ${example}`,
    ],
    hint:
      'Use a boolean-returning helper plus caller-side checks, or restrict the predicate to a supported target kind.',
    ...getNodeDiagnosticRange(node),
  };
}

function createPredicateBodyMismatchDiagnostic(
  declaration: PredicateSignatureDeclaration,
  node: ts.Node,
  predicateCheck: Pick<PredicateCheck, 'parameterName' | 'predicateType'>,
  context: AnalysisContext,
): SoundDiagnostic {
  const predicateType = context.checker.typeToString(predicateCheck.predicateType);
  const example =
    'Make the body check the claimed predicate directly, or weaken the predicate to match what the function really proves.';

  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.predicateBodyMismatch,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.predicateBodyMismatch,
    metadata: {
      rule: 'predicate_body_mismatch',
      primarySymbol: getDeclarationName(declaration),
      fixability: 'local_rewrite',
      invariant:
        'A checked predicate body must prove the declared predicate on every path that returns true.',
      replacementFamily: 'supported_predicate_surface',
      evidence: [
        { label: 'parameterName', value: predicateCheck.parameterName },
        { label: 'predicateType', value: predicateType },
      ],
      counterexample:
        `Callers may narrow \`${predicateCheck.parameterName}\` to '${predicateType}' on a path where the body actually accepts non-${predicateType}s.`,
      example,
    },
    notes: [
      `This guard claims \`${predicateCheck.parameterName} is ${predicateType}\`, but the body does not prove that on every \`true\` path.`,
      `Example: ${example}`,
    ],
    hint:
      'Change the body to prove the declared predicate, or weaken the predicate to match the actual check.',
    ...getNodeDiagnosticRange(node),
  };
}

function createDiagnostic(node: ts.Node): SoundDiagnostic {
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.predicateBodyMismatch,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.predicateBodyMismatch,
    ...getNodeDiagnosticRange(node),
  };
}

type OverloadPredicateDeclaration = ts.FunctionDeclaration | ts.MethodDeclaration;

function getPredicateOverloadDeclarations(
  context: AnalysisContext,
  declaration: OverloadPredicateDeclaration,
): readonly OverloadPredicateDeclaration[] {
  if (!declaration.name || !ts.isIdentifier(declaration.name)) {
    return [];
  }

  const symbol = context.checker.getSymbolAtLocation(declaration.name);
  if (!symbol) {
    return [];
  }

  return (symbol.declarations ?? []).filter((candidate): candidate is OverloadPredicateDeclaration =>
    (ts.isFunctionDeclaration(candidate) || ts.isMethodDeclaration(candidate)) &&
    candidate !== declaration &&
    !candidate.body &&
    requiresPredicateVerification(candidate)
  );
}

export function runTypeGuardRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    context.traverse(sourceFile, (node) => {
      if (!isSignatureDeclarationWithBody(node)) {
        return;
      }

      const forbiddenPredicateTypeNode = getForbiddenPredicateTypeNode(context, node);
      if (forbiddenPredicateTypeNode) {
        diagnostics.push(createAnyTypeDiagnostic(forbiddenPredicateTypeNode));
        return;
      }

      const predicateTarget = classifyPredicateVerificationTarget(context, node);
      if (predicateTarget?.kind === 'unsupported') {
        diagnostics.push(
          createUnsupportedPredicateDiagnostic(context, node, node.name ?? node, predicateTarget.reason),
        );
        return;
      }

      if (hasDirectAnnotation(context, node, 'unsafe')) {
        return;
      }

      const hasOwnPredicate = hasPredicateVerificationContract(context, node);
      const predicateCheck = getPredicateCheck(context, node);
      if (!predicateCheck) {
        if (hasOwnPredicate) {
          diagnostics.push(createDiagnostic(node.name ?? node));
          return;
        }

        if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) {
          return;
        }

      } else {
        if (verifyPredicateBody(context, predicateCheck)) {
          if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) {
            return;
          }
        } else {
          diagnostics.push(
            createPredicateBodyMismatchDiagnostic(node, node.name ?? node, predicateCheck, context),
          );
          return;
        }
      }

      if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) {
        return;
      }

      for (const overload of getPredicateOverloadDeclarations(context, node)) {
        if (
          hasDirectAnnotation(context, overload, 'unsafe') ||
          hasDirectAnnotation(context, node, 'unsafe')
        ) {
          continue;
        }

        const overloadForbiddenPredicateTypeNode = getForbiddenPredicateTypeNode(context, overload);
        if (overloadForbiddenPredicateTypeNode) {
          diagnostics.push(createAnyTypeDiagnostic(overloadForbiddenPredicateTypeNode));
          return;
        }

        const overloadTarget = classifyPredicateVerificationTarget(context, overload);
        if (overloadTarget?.kind === 'unsupported') {
          diagnostics.push(
            createUnsupportedPredicateDiagnostic(
              context,
              overload,
              node.name ?? node,
              overloadTarget.reason,
            ),
          );
          return;
        }

        const overloadCheck = getPredicateCheckForSignature(context, overload, node);
        if (!overloadCheck || !verifyPredicateBody(context, overloadCheck)) {
          diagnostics.push(
            overloadCheck
              ? createPredicateBodyMismatchDiagnostic(node, node.name ?? node, overloadCheck, context)
              : createDiagnostic(node.name ?? node),
          );
          return;
        }
      }
    });
  });

  return diagnostics;
}
