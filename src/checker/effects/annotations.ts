import ts from 'typescript';

import type { ParsedAnnotation, ParsedAnnotationValue } from '../../annotation_syntax.ts';
import type {
  AnalysisContext,
  EffectNameFact,
  EffectRewriteFact,
} from '../engine/types.ts';
import { effectMaskFromPublicName, isPublicEffectName } from './masks.ts';
import { effectNamesToMask, normalizeEffectNames } from './names.ts';
import {
  type EffectCallableDeclaration,
  isCallableBodyDeclaration,
  isCallableDeclarationNode,
} from './model.ts';

export interface ParsedEffectsForwardEntry {
  fromPath: readonly string[];
  handleEffects: readonly EffectNameFact[];
  rewrites: readonly EffectRewriteFact[];
}

export interface ParsedEffectsAnnotationContract {
  addEffects: readonly EffectNameFact[];
  addMask: number;
  forbidEffects: readonly EffectNameFact[];
  forbidMask: number;
  forwardEntries: readonly ParsedEffectsForwardEntry[];
  unknownDirect: boolean;
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
): readonly EffectNameFact[] | string {
  if (value.kind !== 'array') {
    return `Effects annotation field \`${fieldName}\` must use an array literal such as \`[fails.throws]\`.`;
  }

  const effects: EffectNameFact[] = [];
  const seen = new Set<string>();
  for (const element of value.elements) {
    if (element.kind !== 'identifier') {
      return `Effects annotation field \`${fieldName}\` must list bare effect identifiers.`;
    }
    if (!isPublicEffectName(element.name)) {
      return `Effects annotation field \`${fieldName}\` must use dotted identifier names such as \`host.node.fs\`; found \`${element.name}\`.`;
    }
    if (seen.has(element.name)) {
      return `Effects annotation field \`${fieldName}\` mentions \`${element.name}\` more than once.`;
    }
    seen.add(element.name);
    effects.push(element.name);
  }

  return normalizeEffectNames(effects);
}

function splitForwardPath(text: string): readonly string[] {
  return text.split('.');
}

function parseForwardPathList(
  value: ParsedAnnotationValue,
  fieldName: 'forward' | 'via',
): readonly ParsedEffectsForwardEntry[] | string {
  if (value.kind !== 'array') {
    return `Effects annotation field \`${fieldName}\` must use an array literal such as \`[callback]\`.`;
  }

  const entries: ParsedEffectsForwardEntry[] = [];
  const seen = new Set<string>();
  for (const element of value.elements) {
    if (element.kind !== 'identifier') {
      return `Effects annotation field \`${fieldName}\` must list parameter-rooted callable references.`;
    }
    if (seen.has(element.name)) {
      return `Effects annotation field \`${fieldName}\` mentions \`${element.name}\` more than once.`;
    }
    seen.add(element.name);
    entries.push({
      fromPath: splitForwardPath(element.name),
      handleEffects: [],
      rewrites: [],
    });
  }

  return entries;
}

function getObjectProperty(
  value: ParsedAnnotationValue,
  propertyName: string,
): ParsedAnnotationValue | undefined {
  if (value.kind !== 'object') {
    return undefined;
  }
  return value.properties.find((property) => property.name === propertyName)?.value;
}

function parseRewriteList(value: ParsedAnnotationValue): readonly EffectRewriteFact[] | string {
  if (value.kind !== 'array') {
    return 'Effects annotation `rewrite` must use an array literal.';
  }

  const rewrites: EffectRewriteFact[] = [];
  const seen = new Set<string>();
  for (const element of value.elements) {
    if (element.kind !== 'object') {
      return 'Effects annotation `rewrite` entries must use `{ from: effect, to: effect }` objects.';
    }
    const propertyNames = new Set(element.properties.map((property) => property.name));
    if (!propertyNames.has('from') || !propertyNames.has('to')) {
      return 'Effects annotation `rewrite` entries must include both `from` and `to`.';
    }
    if (propertyNames.size !== 2) {
      return 'Effects annotation `rewrite` entries only support `from` and `to`.';
    }
    const fromValue = getObjectProperty(element, 'from');
    const toValue = getObjectProperty(element, 'to');
    if (fromValue?.kind !== 'identifier' || toValue?.kind !== 'identifier') {
      return 'Effects annotation `rewrite` entries must use dotted identifier effect names.';
    }
    const key = `${fromValue.name}->${toValue.name}`;
    if (seen.has(key)) {
      return `Effects annotation \`rewrite\` mentions \`${key}\` more than once.`;
    }
    seen.add(key);
    rewrites.push({
      from: fromValue.name,
      to: toValue.name,
    });
  }

  return rewrites;
}

function parseForwardEntry(value: ParsedAnnotationValue): ParsedEffectsForwardEntry | string {
  if (value.kind === 'identifier') {
    return {
      fromPath: splitForwardPath(value.name),
      handleEffects: [],
      rewrites: [],
    };
  }

  if (value.kind !== 'object') {
    return 'Effects annotation `forward` entries must use a parameter path or an object literal.';
  }

  const properties = new Map<string, ParsedAnnotationValue>();
  for (const property of value.properties) {
    if (properties.has(property.name)) {
      return `Effects annotation \`forward\` entry field \`${property.name}\` appears more than once.`;
    }
    properties.set(property.name, property.value);
  }

  const fromValue = properties.get('from');
  if (!fromValue || fromValue.kind !== 'identifier') {
    return 'Effects annotation `forward` entries require `from: parameterOrMemberPath`.';
  }
  for (const propertyName of properties.keys()) {
    if (propertyName !== 'from' && propertyName !== 'handle' && propertyName !== 'rewrite') {
      return `Unknown effects annotation forward field \`${propertyName}\`. Use only \`from\`, \`rewrite\`, and \`handle\`.`;
    }
  }

  const rewritesValue = properties.get('rewrite');
  const rewrites = rewritesValue ? parseRewriteList(rewritesValue) : [];
  if (typeof rewrites === 'string') {
    return rewrites;
  }
  const handleValue = properties.get('handle');
  const handleEffects = handleValue ? parseEffectIdentifierList(handleValue, 'forbid') : [];
  if (typeof handleEffects === 'string') {
    return handleEffects.replace('field `forbid`', 'field `handle`');
  }

  return {
    fromPath: splitForwardPath(fromValue.name),
    handleEffects,
    rewrites,
  };
}

function parseForwardEntryList(
  value: ParsedAnnotationValue,
): readonly ParsedEffectsForwardEntry[] | string {
  if (value.kind !== 'array') {
    return 'Effects annotation field `forward` must use an array literal such as `[callback]`.';
  }

  const entries: ParsedEffectsForwardEntry[] = [];
  const seen = new Set<string>();
  for (const element of value.elements) {
    const entry = parseForwardEntry(element);
    if (typeof entry === 'string') {
      return entry;
    }
    const key = `${entry.fromPath.join('.')}|rewrite:${
      entry.rewrites.map((rewrite) => `${rewrite.from}->${rewrite.to}`).join(',')
    }|handle:${entry.handleEffects.join(',')}`;
    if (seen.has(key)) {
      return `Effects annotation field \`forward\` mentions \`${entry.fromPath.join('.')}\` more than once.`;
    }
    seen.add(key);
    entries.push(entry);
  }

  return entries;
}

function parseUnknownList(value: ParsedAnnotationValue): boolean | string {
  if (value.kind !== 'array') {
    return 'Effects annotation field `unknown` must use an array literal such as `[direct]`.';
  }

  let unknownDirect = false;
  for (const element of value.elements) {
    if (element.kind !== 'identifier') {
      return 'Effects annotation field `unknown` must list bare identifiers.';
    }
    if (element.name !== 'direct') {
      return `Effects annotation field \`unknown\` only supports \`direct\`; found \`${element.name}\`.`;
    }
    if (unknownDirect) {
      return 'Effects annotation field `unknown` mentions `direct` more than once.';
    }
    unknownDirect = true;
  }

  return unknownDirect;
}

export function parseEffectsAnnotationContract(
  annotation: ParsedAnnotation,
): ParsedEffectsAnnotationContract | string {
  const args = annotation.arguments ?? [];
  const fieldValues = new Map<'add' | 'forbid' | 'forward' | 'unknown' | 'via', ParsedAnnotationValue>();
  for (const arg of args) {
    if (arg.kind !== 'named') {
      return 'Effects annotations only accept named fields: `add`, `forbid`, `forward`, `unknown`, and `via`.';
    }
    if (
      arg.name !== 'add' && arg.name !== 'forbid' && arg.name !== 'forward' && arg.name !== 'unknown' &&
      arg.name !== 'via'
    ) {
      return `Unknown effects annotation field \`${arg.name}\`. Use only \`add\`, \`forbid\`, \`forward\`, \`unknown\`, and \`via\`.`;
    }
    if (fieldValues.has(arg.name)) {
      return `Effects annotation field \`${arg.name}\` appears more than once.`;
    }
    fieldValues.set(arg.name, arg.value);
  }

  const addValue = fieldValues.get('add');
  const forbidValue = fieldValues.get('forbid');
  const viaValue = fieldValues.get('via');
  const forwardValue = fieldValues.get('forward');
  const unknownValue = fieldValues.get('unknown');
  const addEffects = addValue ? parseEffectIdentifierList(addValue, 'add') : [];
  if (typeof addEffects === 'string') {
    return addEffects;
  }
  const forbidEffects = forbidValue ? parseEffectIdentifierList(forbidValue, 'forbid') : [];
  if (typeof forbidEffects === 'string') {
    return forbidEffects;
  }
  const viaEntries = viaValue ? parseForwardPathList(viaValue, 'via') : [];
  if (typeof viaEntries === 'string') {
    return viaEntries;
  }
  const forwardEntries = forwardValue ? parseForwardEntryList(forwardValue) : [];
  if (typeof forwardEntries === 'string') {
    return forwardEntries;
  }
  const unknownDirect = unknownValue ? parseUnknownList(unknownValue) : false;
  if (typeof unknownDirect === 'string') {
    return unknownDirect;
  }
  const viaNames = viaEntries.map((entry) => entry.fromPath.join('.'));
  const allForwardEntries = [...viaEntries, ...forwardEntries];
  if (typeof viaNames === 'string') {
    return viaNames;
  }

  return {
    addEffects,
    addMask: effectNamesToMask(addEffects),
    forbidEffects,
    forbidMask: effectNamesToMask(forbidEffects),
    forwardEntries: allForwardEntries,
    unknownDirect,
    viaNames,
  };
}

function getParameterType(
  context: AnalysisContext,
  parameter: ts.ParameterDeclaration,
): ts.Type {
  return parameter.type
    ? context.checker.getTypeFromTypeNode(parameter.type)
    : context.checker.getTypeAtLocation(parameter.name);
}

function hasCallableSignatures(context: AnalysisContext, type: ts.Type): boolean {
  return context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
}

function validateForwardTarget(
  context: AnalysisContext,
  parameters: ReadonlyMap<string, ts.ParameterDeclaration>,
  entry: ParsedEffectsForwardEntry,
  fieldName: 'forward' | 'via',
): string | undefined {
  const [rootName, ...memberPath] = entry.fromPath;
  if (!rootName) {
    return `Effects annotation field \`${fieldName}\` requires a parameter-rooted callable reference.`;
  }
  const parameter = parameters.get(rootName);
  if (!parameter) {
    return `Effects annotation field \`${fieldName}\` references unknown parameter \`${rootName}\`.`;
  }

  let currentType = getParameterType(context, parameter);
  if (memberPath.length === 0) {
    if (!hasCallableType(context, parameter)) {
      return `Effects annotation field \`${fieldName}\` may only reference function-valued parameters; \`${rootName}\` is not callable.`;
    }
    return undefined;
  }

  for (const [index, segment] of memberPath.entries()) {
    const property = currentType.getProperty(segment);
    if (!property) {
      return `Effects annotation field \`${fieldName}\` references unknown member \`${entry.fromPath.slice(0, index + 2).join('.')}\`.`;
    }
    currentType = context.checker.getTypeOfSymbolAtLocation(property, parameter);
  }

  if (!hasCallableSignatures(context, currentType)) {
    return `Effects annotation field \`${fieldName}\` may only reference callable members; \`${entry.fromPath.join('.')}\` is not callable.`;
  }

  return undefined;
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
    if (parsed.addEffects.length > 0 || parsed.forwardEntries.length > 0 || parsed.unknownDirect) {
      return 'Function-valued parameters only support `#[effects(forbid: [...])]`.';
    }
    return undefined;
  }

  if (classification.kind === 'callable_body' && (parsed.addEffects.length > 0 || parsed.unknownDirect)) {
    return 'Bodyful callable declarations infer direct effects from their implementation; use `forbid` and `forward`, not `add` or `unknown`.';
  }

  if (classification.kind === 'callable_declaration' && parsed.forbidEffects.length > 0) {
    return 'Declaration-only callable surfaces use `add`, `forward`, and `unknown`; `forbid` is only supported on bodyful callables and function-valued parameters.';
  }

  if (parsed.forwardEntries.length === 0) {
    return undefined;
  }

  const parameterNames = new Map<string, ts.ParameterDeclaration>();
  for (const parameter of classification.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      parameterNames.set(parameter.name.text, parameter);
    }
  }

  for (const entry of parsed.forwardEntries) {
    const fieldName = parsed.viaNames.includes(entry.fromPath.join('.')) && entry.rewrites.length === 0 &&
        entry.handleEffects.length === 0
      ? 'via'
      : 'forward';
    const error = validateForwardTarget(context, parameterNames, entry, fieldName);
    if (error) {
      return error;
    }
  }

  return undefined;
}
