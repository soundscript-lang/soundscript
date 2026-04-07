import ts from 'typescript';

import type { ParsedAnnotation, ParsedAnnotationValue } from '../../annotation_syntax.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { effectMaskFromPublicName, isPublicEffectName } from './masks.ts';
import {
  type EffectCallableDeclaration,
  isCallableBodyDeclaration,
  isCallableDeclarationNode,
} from './model.ts';

export interface ParsedEffectsAnnotationContract {
  addMask: number;
  forbidMask: number;
  viaNames: readonly string[];
}

type EffectsTargetClassification =
  | {
    kind: 'callable_body';
    parameters: readonly ts.ParameterDeclaration[];
    target: EffectCallableDeclaration;
  }
  | {
    kind: 'callable_declaration';
    parameters: readonly ts.ParameterDeclaration[];
    target: EffectCallableDeclaration;
  }
  | {
    kind: 'parameter';
    target: ts.ParameterDeclaration;
  }
  | {
    kind: 'invalid';
  };

export function hasCallableType(context: AnalysisContext, parameter: ts.ParameterDeclaration): boolean {
  const type = parameter.type
    ? context.checker.getTypeFromTypeNode(parameter.type)
    : context.checker.getTypeAtLocation(parameter.name);
  return context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
}

function classifyEffectsTarget(
  context: AnalysisContext,
  targetNode: ts.Node | undefined,
): EffectsTargetClassification {
  if (!targetNode) {
    return { kind: 'invalid' };
  }

  if (ts.isParameter(targetNode)) {
    return hasCallableType(context, targetNode)
      ? { kind: 'parameter', target: targetNode }
      : { kind: 'invalid' };
  }

  if (!isCallableDeclarationNode(targetNode)) {
    return { kind: 'invalid' };
  }

  return isCallableBodyDeclaration(targetNode)
    ? {
      kind: 'callable_body',
      parameters: targetNode.parameters,
      target: targetNode,
    }
    : {
      kind: 'callable_declaration',
      parameters: targetNode.parameters,
      target: targetNode,
    };
}

export function getEffectsAnnotation(
  context: AnalysisContext,
  node: ts.Node,
): ParsedAnnotation | undefined {
  return context.getAnnotationLookup(node.getSourceFile()).getAttachedAnnotations(node).find((annotation) =>
    annotation.name === 'effects'
  );
}

function parseEffectIdentifierList(
  value: ParsedAnnotationValue,
  fieldName: 'add' | 'forbid',
): number | string {
  if (value.kind !== 'array') {
    return `Effects annotation field \`${fieldName}\` must use an array literal such as \`[fails]\`.`;
  }

  let mask = 0;
  const seen = new Set<string>();
  for (const element of value.elements) {
    if (element.kind !== 'identifier') {
      return `Effects annotation field \`${fieldName}\` must list bare public effect identifiers.`;
    }
    if (!isPublicEffectName(element.name)) {
      return `Public effect names in v0.2.0 are \`fails\`, \`suspend\`, \`mut\`, and \`host\`; found \`${element.name}\`.`;
    }
    if (seen.has(element.name)) {
      return `Effects annotation field \`${fieldName}\` mentions \`${element.name}\` more than once.`;
    }
    seen.add(element.name);
    mask |= effectMaskFromPublicName(element.name);
  }

  return mask;
}

function parseViaIdentifierList(value: ParsedAnnotationValue): readonly string[] | string {
  if (value.kind !== 'array') {
    return 'Effects annotation field `via` must use an array literal such as `[callback]`.';
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const element of value.elements) {
    if (element.kind !== 'identifier') {
      return 'Effects annotation field `via` must list bare parameter names.';
    }
    if (seen.has(element.name)) {
      return `Effects annotation field \`via\` mentions \`${element.name}\` more than once.`;
    }
    seen.add(element.name);
    names.push(element.name);
  }

  return names;
}

export function parseEffectsAnnotationContract(
  annotation: ParsedAnnotation,
): ParsedEffectsAnnotationContract | string {
  const args = annotation.arguments ?? [];
  const fieldValues = new Map<'add' | 'forbid' | 'via', ParsedAnnotationValue>();
  for (const arg of args) {
    if (arg.kind !== 'named') {
      return 'Effects annotations only accept named fields: `add`, `forbid`, and `via`.';
    }
    if (arg.name !== 'add' && arg.name !== 'forbid' && arg.name !== 'via') {
      return `Unknown effects annotation field \`${arg.name}\`. Use only \`add\`, \`forbid\`, and \`via\`.`;
    }
    if (fieldValues.has(arg.name)) {
      return `Effects annotation field \`${arg.name}\` appears more than once.`;
    }
    fieldValues.set(arg.name, arg.value);
  }

  const addValue = fieldValues.get('add');
  const forbidValue = fieldValues.get('forbid');
  const viaValue = fieldValues.get('via');
  const addMask = addValue ? parseEffectIdentifierList(addValue, 'add') : 0;
  if (typeof addMask === 'string') {
    return addMask;
  }
  const forbidMask = forbidValue ? parseEffectIdentifierList(forbidValue, 'forbid') : 0;
  if (typeof forbidMask === 'string') {
    return forbidMask;
  }
  const viaNames = viaValue ? parseViaIdentifierList(viaValue) : [];
  if (typeof viaNames === 'string') {
    return viaNames;
  }

  return {
    addMask,
    forbidMask,
    viaNames,
  };
}

export function validateEffectsAnnotation(
  context: AnalysisContext,
  targetNode: ts.Node | undefined,
  annotation: ParsedAnnotation,
): string | undefined {
  const classification = classifyEffectsTarget(context, targetNode);
  if (classification.kind === 'invalid') {
    return '`#[effects(...)]` must attach to a callable declaration, callable signature, or function-valued parameter.';
  }

  const parsed = parseEffectsAnnotationContract(annotation);
  if (typeof parsed === 'string') {
    return parsed;
  }

  if (classification.kind === 'parameter') {
    if (parsed.addMask !== 0 || parsed.viaNames.length > 0) {
      return 'Function-valued parameters only support `#[effects(forbid: [...])]` in v0.2.0.';
    }
    return undefined;
  }

  if (classification.kind === 'callable_body' && parsed.addMask !== 0) {
    return 'Bodyful callable declarations infer direct effects from their implementation; use `forbid` and `via`, not `add`.';
  }

  if (classification.kind === 'callable_declaration' && parsed.forbidMask !== 0) {
    return 'Declaration-only callable surfaces use `add` and `via`; `forbid` is only supported on bodyful callables and function-valued parameters.';
  }

  if (parsed.viaNames.length === 0) {
    return undefined;
  }

  const parameterNames = new Map<string, ts.ParameterDeclaration>();
  for (const parameter of classification.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      parameterNames.set(parameter.name.text, parameter);
    }
  }

  for (const viaName of parsed.viaNames) {
    const parameter = parameterNames.get(viaName);
    if (!parameter) {
      return `Effects annotation field \`via\` references unknown parameter \`${viaName}\`.`;
    }
    if (!hasCallableType(context, parameter)) {
      return `Effects annotation field \`via\` may only reference function-valued parameters; \`${viaName}\` is not callable.`;
    }
  }

  return undefined;
}
