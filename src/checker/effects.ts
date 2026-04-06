import ts from 'typescript';

import type { ParsedAnnotation, ParsedAnnotationValue } from '../annotation_syntax.ts';
import type {
  AnalysisContext,
  EffectFailureBoundary,
  EffectForwardedParameterFact,
  EffectParameterContractFact,
  EffectSummaryFact,
  PublicEffectName,
} from './engine/types.ts';

export const INTERNAL_EFFECT_MASKS = {
  failsRejects: 1 << 0,
  failsThrows: 1 << 1,
  hostDom: 1 << 2,
  hostInterop: 1 << 3,
  hostIo: 1 << 4,
  hostRandom: 1 << 5,
  hostTime: 1 << 6,
  mut: 1 << 7,
  suspend: 1 << 8,
} as const;

export const PUBLIC_EFFECT_NAMES = ['fails', 'host', 'mut', 'suspend'] as const satisfies
  readonly PublicEffectName[];

export const PUBLIC_EFFECT_MASKS: Readonly<Record<PublicEffectName, number>> = {
  fails: INTERNAL_EFFECT_MASKS.failsRejects | INTERNAL_EFFECT_MASKS.failsThrows,
  host: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.hostInterop |
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.hostTime,
  mut: INTERNAL_EFFECT_MASKS.mut,
  suspend: INTERNAL_EFFECT_MASKS.suspend,
};

const ARRAY_CALLBACK_METHODS = new Set([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
]);

const ASYNC_TASK_CONSTRUCTOR_FUNCTIONS = new Set([
  'fail',
  'flatMap',
  'fromPromise',
  'fromResult',
  'map',
  'mapError',
  'parallel',
  'race',
  'recover',
  'succeed',
  'tap',
  'tapError',
  'taskApplicative',
  'taskAsyncMonad',
  'taskFunctor',
  'taskMonad',
  'timeout',
]);

const inProgressSummaries = new WeakMap<ts.Node, EffectSummaryFact>();

export interface ParsedEffectsAnnotationContract {
  addMask: number;
  forbidMask: number;
  viaNames: readonly string[];
}

interface EffectComposition {
  mask: number;
  unknown: boolean;
}

interface BuiltinForwardedArgumentBehavior {
  argumentIndex: number;
  failureBoundary: EffectFailureBoundary;
}

interface BuiltinCallBehavior {
  directMask: number;
  forwardedArguments: readonly BuiltinForwardedArgumentBehavior[];
}

type PromiseLikeChecker = ts.TypeChecker & {
  getPromisedTypeOfPromise(type: ts.Type): ts.Type | undefined;
};

type EffectCallableDeclaration =
  | ts.ArrowFunction
  | ts.CallSignatureDeclaration
  | ts.ConstructorDeclaration
  | ts.ConstructSignatureDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.MethodSignature;

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

function isPublicEffectName(name: string): name is PublicEffectName {
  return PUBLIC_EFFECT_NAMES.includes(name as PublicEffectName);
}

function effectMaskFromPublicName(name: PublicEffectName): number {
  return PUBLIC_EFFECT_MASKS[name];
}

export function effectMaskToPublicNames(mask: number): readonly PublicEffectName[] {
  return PUBLIC_EFFECT_NAMES.filter((name) => (mask & PUBLIC_EFFECT_MASKS[name]) !== 0);
}

function hasCallableType(context: AnalysisContext, parameter: ts.ParameterDeclaration): boolean {
  const type = parameter.type
    ? context.checker.getTypeFromTypeNode(parameter.type)
    : context.checker.getTypeAtLocation(parameter.name);
  return context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
}

function isCallableDeclarationNode(node: ts.Node): node is EffectCallableDeclaration {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
}

function isCallableBodyDeclaration(
  node: EffectCallableDeclaration,
): node is
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration {
  return 'body' in node && node.body !== undefined;
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

function getEffectsAnnotation(
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

function getParameterName(parameter: ts.ParameterDeclaration, index: number): string {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : `<param ${index + 1}>`;
}

function resolveViaParameters(
  parameters: readonly ts.ParameterDeclaration[],
  viaNames: readonly string[],
): readonly EffectForwardedParameterFact[] {
  const forwardedParameters: EffectForwardedParameterFact[] = [];
  for (const viaName of viaNames) {
    const parameterIndex = parameters.findIndex((parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === viaName
    );
    if (parameterIndex >= 0) {
      forwardedParameters.push({
        failureBoundary: 'preserve',
        parameterIndex,
      });
    }
  }
  return forwardedParameters;
}

function getParameterContracts(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
): readonly EffectParameterContractFact[] {
  const contracts: EffectParameterContractFact[] = [];
  for (const [index, parameter] of parameters.entries()) {
    const annotation = getEffectsAnnotation(context, parameter);
    if (!annotation) {
      continue;
    }
    const parsed = parseEffectsAnnotationContract(annotation);
    if (typeof parsed === 'string') {
      continue;
    }
    if (parsed.forbidMask === 0) {
      continue;
    }
    contracts.push({
      forbidMask: parsed.forbidMask,
      parameterIndex: index,
    });
  }
  return contracts;
}

function emptySummary(nodeId: number): EffectSummaryFact {
  return {
    directMask: 0,
    forbidMask: 0,
    forwardedParameters: [],
    hasUnknownDirectEffects: false,
    nodeId,
    parameterContracts: [],
  };
}

function normalizeFailuresForAsyncBoundary(mask: number): number {
  const withoutFailures = mask & ~PUBLIC_EFFECT_MASKS.fails;
  const hasFailure = (mask & PUBLIC_EFFECT_MASKS.fails) !== 0;
  return hasFailure ? withoutFailures | INTERNAL_EFFECT_MASKS.failsRejects : withoutFailures;
}

function applyContainingCallableBoundary(mask: number, isAsyncBoundary: boolean): number {
  return isAsyncBoundary ? normalizeFailuresForAsyncBoundary(mask) : mask;
}

function applyForwardedFailureBoundary(mask: number, failureBoundary: EffectFailureBoundary): number {
  return failureBoundary === 'reject' ? normalizeFailuresForAsyncBoundary(mask) : mask;
}

function createForwardedParameterKey(
  parameterIndex: number,
  failureBoundary: EffectFailureBoundary,
): string {
  return `${parameterIndex}:${failureBoundary}`;
}

function addForwardedParameter(
  forwardedParameters: Map<string, EffectForwardedParameterFact>,
  parameterIndex: number,
  failureBoundary: EffectFailureBoundary,
): void {
  forwardedParameters.set(
    createForwardedParameterKey(parameterIndex, failureBoundary),
    {
      failureBoundary,
      parameterIndex,
    },
  );
}

function collectLocalBindingSymbolIds(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): ReadonlySet<number> {
  const localSymbols = new Set<number>();
  for (const parameter of declaration.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      const symbol = context.checker.getSymbolAtLocation(parameter.name);
      if (symbol) {
        localSymbols.add(context.getSymbolId(symbol));
      }
    }
  }

  const body = 'body' in declaration ? declaration.body : undefined;
  if (!body) {
    return localSymbols;
  }

  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node)
    ) {
      if ('name' in node && node.name && ts.isIdentifier(node.name)) {
        const symbol = context.checker.getSymbolAtLocation(node.name);
        if (symbol) {
          localSymbols.add(context.getSymbolId(symbol));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return localSymbols;
}

function mutationTouchesObservableState(
  context: AnalysisContext,
  expression: ts.Expression,
  localBindingSymbolIds: ReadonlySet<number>,
): boolean {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return true;
  }

  if (!ts.isIdentifier(expression)) {
    return true;
  }

  const symbol = context.checker.getSymbolAtLocation(expression);
  return !symbol || !localBindingSymbolIds.has(context.getSymbolId(symbol));
}

function getCurrentFunctionParameterIndex(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
  expression: ts.Expression,
): number | undefined {
  if (!ts.isIdentifier(expression)) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return undefined;
  }

  for (const [index, parameter] of parameters.entries()) {
    if (!ts.isIdentifier(parameter.name)) {
      continue;
    }
    const parameterSymbol = context.checker.getSymbolAtLocation(parameter.name);
    if (parameterSymbol === symbol && hasCallableType(context, parameter)) {
      return index;
    }
  }

  return undefined;
}

function isArrayLikeType(context: AnalysisContext, type: ts.Type): boolean {
  return context.checker.isArrayType(type) ||
    context.checker.isTupleType(type) ||
    type.symbol?.getName() === 'ReadonlyArray';
}

function normalizeFileName(fileName: string): string {
  return fileName.replaceAll('\\', '/');
}

function isInstalledSoundStdlibModuleFile(fileName: string, moduleName: string): boolean {
  const normalizedFileName = normalizeFileName(fileName);
  return normalizedFileName.includes('/node_modules/@soundscript/soundscript/') &&
    normalizedFileName.endsWith(`/${moduleName}.d.ts`);
}

function isLocalSoundStdlibModuleFile(fileName: string, moduleName: string): boolean {
  const normalizedFileName = normalizeFileName(fileName);
  return normalizedFileName.includes('/src/stdlib/') &&
    (
      normalizedFileName.endsWith(`/${moduleName}.d.ts`) ||
      normalizedFileName.endsWith(`/${moduleName}.ts`)
    );
}

function isTrustedSoundStdlibModuleFile(fileName: string, moduleName: string): boolean {
  return isInstalledSoundStdlibModuleFile(fileName, moduleName) ||
    isLocalSoundStdlibModuleFile(fileName, moduleName);
}

function isBundledDomDeclarationFile(fileName: string): boolean {
  return normalizeFileName(fileName).endsWith('/lib.dom.d.ts');
}

function getKnownFetchObjectFamilyBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  if (
    ts.isNewExpression(expression) &&
    (ownerName === 'Headers' || ownerName === 'Request' || ownerName === 'Response')
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostInterop,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'Headers') {
    if (memberName === 'append' || memberName === 'delete' || memberName === 'set') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }
    if (
      memberName === 'entries' || memberName === 'get' || memberName === 'has' ||
      memberName === 'keys' || memberName === 'values'
    ) {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
    if (memberName === 'forEach' && ts.isCallExpression(expression) && expression.arguments.length > 0) {
      return {
        directMask: 0,
        forwardedArguments: [{ argumentIndex: 0, failureBoundary: 'preserve' }],
      };
    }
  }

  if (ownerName === 'Request' || ownerName === 'Response') {
    if (memberName === 'clone') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
  }

  if (ownerName === 'Body' || ownerName === 'Request' || ownerName === 'Response') {
    if (
      memberName === 'arrayBuffer' || memberName === 'blob' || memberName === 'formData' ||
      memberName === 'json' || memberName === 'text'
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
        forwardedArguments: [],
      };
    }
  }

  return undefined;
}

function getKnownUrlAndTextBehavior(
  ownerName: string | undefined,
  memberName: string | undefined,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  if (ts.isNewExpression(expression)) {
    if (ownerName === 'URL' || ownerName === 'TextDecoder') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.failsThrows,
        forwardedArguments: [],
      };
    }

    if (
      ownerName === 'URLSearchParams' || ownerName === 'TextEncoder'
    ) {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
  }

  if ((ownerName === 'URL' || ownerName === 'URLConstructor') && memberName === 'canParse') {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'URL' && (memberName === 'toJSON' || memberName === 'toString')) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (ownerName === 'URLSearchParams') {
    if (
      memberName === 'append' || memberName === 'delete' || memberName === 'set' ||
      memberName === 'sort'
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }

    if (
      memberName === 'entries' || memberName === 'get' || memberName === 'has' ||
      memberName === 'keys' || memberName === 'toString' || memberName === 'values'
    ) {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }

    if (memberName === 'forEach' && ts.isCallExpression(expression) && expression.arguments.length > 0) {
      return {
        directMask: 0,
        forwardedArguments: [{ argumentIndex: 0, failureBoundary: 'preserve' }],
      };
    }
  }

  if (ownerName === 'TextEncoder') {
    if (memberName === 'encode') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }

    if (memberName === 'encodeInto') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }
  }

  if (ownerName === 'TextDecoder' && memberName === 'decode') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.failsThrows,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  while ((current.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(current);
    if (aliased === current) {
      break;
    }
    current = aliased;
  }
  return current;
}

function isDeclarationBackedBuiltinSymbolNamed(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  name: string,
): boolean {
  if (!symbol) {
    return false;
  }

  const resolved = resolveAliasedSymbol(checker, symbol);
  if (resolved.getName() !== name) {
    return false;
  }

  const declarations = resolved.declarations ?? [];
  return declarations.length > 0 &&
    declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
}

function isPromiseType(context: AnalysisContext, type: ts.Type): boolean {
  const promisedType = (context.checker as PromiseLikeChecker).getPromisedTypeOfPromise(type);
  if (!promisedType) {
    return false;
  }

  return isDeclarationBackedBuiltinSymbolNamed(context.checker, type.aliasSymbol, 'Promise') ||
    isDeclarationBackedBuiltinSymbolNamed(context.checker, type.getSymbol(), 'Promise');
}

function isOmittedPromiseHandlerArgument(argument: ts.Expression | undefined): boolean {
  return !argument || (ts.isIdentifier(argument) && argument.text === 'undefined');
}

function getDeclarationName(declaration: ts.Declaration | undefined): string | undefined {
  if (!declaration) {
    return undefined;
  }

  const name = (declaration as ts.NamedDeclaration).name;
  return name && ts.isIdentifier(name) ? name.text : undefined;
}

function getDeclarationOwnerName(
  declaration: ts.SignatureDeclarationBase | undefined,
): string | undefined {
  let current: ts.Node | undefined = declaration?.parent;

  while (current) {
    if (
      ts.isInterfaceDeclaration(current) || ts.isClassDeclaration(current) ||
      ts.isModuleDeclaration(current)
    ) {
      return getDeclarationName(current);
    }

    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }

    current = current.parent;
  }

  return undefined;
}

function getKnownPortableBuiltinBehavior(
  context: AnalysisContext,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  const declaration = context.checker.getResolvedSignature(expression)?.getDeclaration();
  const memberName = declaration ? getDeclarationName(declaration) : undefined;
  const ownerName = declaration ? getDeclarationOwnerName(declaration) : undefined;
  const sourceFileName = declaration?.getSourceFile().fileName;

  if (memberName === 'random' && ownerName === 'Math') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostRandom,
      forwardedArguments: [],
    };
  }

  if (memberName === 'now' && ownerName === 'DateConstructor') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostTime,
      forwardedArguments: [],
    };
  }

  if (sourceFileName && isBundledDomDeclarationFile(sourceFileName)) {
    const urlAndTextBehavior = getKnownUrlAndTextBehavior(ownerName, memberName, expression);
    if (urlAndTextBehavior) {
      return urlAndTextBehavior;
    }

    const fetchObjectBehavior = getKnownFetchObjectFamilyBehavior(ownerName, memberName, expression);
    if (fetchObjectBehavior) {
      return fetchObjectBehavior;
    }

    if (
      memberName === 'queueMicrotask' &&
      (ownerName === undefined || ownerName === 'WindowOrWorkerGlobalScope')
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostInterop,
        forwardedArguments: [],
      };
    }

    if (
      (memberName === 'setTimeout' || memberName === 'setInterval' ||
        memberName === 'clearTimeout' || memberName === 'clearInterval') &&
      (ownerName === undefined || ownerName === 'WindowOrWorkerGlobalScope')
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostTime,
        forwardedArguments: [],
      };
    }

    if (
      memberName === 'fetch' &&
      (ownerName === undefined || ownerName === 'WindowOrWorkerGlobalScope')
    ) {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
        forwardedArguments: [],
      };
    }

    if (memberName === 'randomUUID' && ownerName === 'Crypto') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostRandom,
        forwardedArguments: [],
      };
    }

    if (memberName === 'getRandomValues' && ownerName === 'Crypto') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut,
        forwardedArguments: [],
      };
    }
  }

  if (
    ts.isNewExpression(expression) &&
    (ownerName === 'MapConstructor' || ownerName === 'SetConstructor' ||
      ownerName === 'WeakMapConstructor' || ownerName === 'WeakSetConstructor')
  ) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (memberName === 'forEach' && ts.isCallExpression(expression) && expression.arguments.length > 0) {
    if (
      ownerName === 'Map' || ownerName === 'ReadonlyMap' || ownerName === 'Set' ||
      ownerName === 'ReadonlySet'
    ) {
      return {
        directMask: 0,
        forwardedArguments: [{ argumentIndex: 0, failureBoundary: 'preserve' }],
      };
    }
  }

  if (
    ownerName === 'Map' || ownerName === 'ReadonlyMap' || ownerName === 'WeakMap'
  ) {
    if (memberName === 'get' || memberName === 'has') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
    if (ownerName === 'Map' || ownerName === 'WeakMap') {
      if (memberName === 'set' || memberName === 'delete' || memberName === 'clear') {
        return {
          directMask: INTERNAL_EFFECT_MASKS.mut,
          forwardedArguments: [],
        };
      }
    }
  }

  if (
    ownerName === 'Set' || ownerName === 'ReadonlySet' || ownerName === 'WeakSet'
  ) {
    if (memberName === 'has') {
      return {
        directMask: 0,
        forwardedArguments: [],
      };
    }
    if (ownerName === 'Set' || ownerName === 'WeakSet') {
      if (memberName === 'add' || memberName === 'delete' || memberName === 'clear') {
        return {
          directMask: INTERNAL_EFFECT_MASKS.mut,
          forwardedArguments: [],
        };
      }
    }
  }

  return undefined;
}

function getKnownStdlibBehavior(
  context: AnalysisContext,
  expression: ts.CallExpression | ts.NewExpression,
): BuiltinCallBehavior | undefined {
  const declaration = context.checker.getResolvedSignature(expression)?.getDeclaration();
  const declarationName = getDeclarationName(declaration);
  const ownerName = declaration ? getDeclarationOwnerName(declaration) : undefined;
  const sourceFileName = declaration?.getSourceFile().fileName;
  if (
    ts.isCallExpression(expression) &&
    declarationName &&
    ASYNC_TASK_CONSTRUCTOR_FUNCTIONS.has(declarationName) &&
    declaration &&
    isTrustedSoundStdlibModuleFile(declaration.getSourceFile().fileName, 'async')
  ) {
    return {
      directMask: 0,
      forwardedArguments: [],
    };
  }

  if (sourceFileName && isTrustedSoundStdlibModuleFile(sourceFileName, 'fetch')) {
    const fetchObjectBehavior = getKnownFetchObjectFamilyBehavior(ownerName, declarationName, expression);
    if (fetchObjectBehavior) {
      return fetchObjectBehavior;
    }

    if (declarationName === 'fetch') {
      return {
        directMask: INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
        forwardedArguments: [],
      };
    }
  }

  if (
    sourceFileName &&
    (isTrustedSoundStdlibModuleFile(sourceFileName, 'text') ||
      isTrustedSoundStdlibModuleFile(sourceFileName, 'url'))
  ) {
    const urlAndTextBehavior = getKnownUrlAndTextBehavior(ownerName, declarationName, expression);
    if (urlAndTextBehavior) {
      return urlAndTextBehavior;
    }
  }

  if (
    declarationName === 'getRandomValues' &&
    ownerName === 'Crypto' &&
    sourceFileName &&
    isTrustedSoundStdlibModuleFile(sourceFileName, 'random')
  ) {
    return {
      directMask: INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut,
      forwardedArguments: [],
    };
  }

  return undefined;
}

function getKnownBuiltinCallBehavior(
  context: AnalysisContext,
  expression: ts.CallExpression,
): BuiltinCallBehavior | undefined {
  const stdlib = getKnownStdlibBehavior(context, expression);
  if (stdlib) {
    return stdlib;
  }

  const portableBuiltin = getKnownPortableBuiltinBehavior(context, expression);
  if (portableBuiltin) {
    return portableBuiltin;
  }

  if (!ts.isPropertyAccessExpression(expression.expression)) {
    return undefined;
  }

  const receiverType = context.checker.getTypeAtLocation(expression.expression.expression);
  const memberName = expression.expression.name.text;
  if (isArrayLikeType(context, receiverType) && ARRAY_CALLBACK_METHODS.has(memberName)) {
    return {
      directMask: 0,
      forwardedArguments: expression.arguments.length > 0
        ? [{ argumentIndex: 0, failureBoundary: 'preserve' }]
        : [],
    };
  }

  if (!isPromiseType(context, receiverType)) {
    return undefined;
  }

  if (memberName === 'then') {
    const forwardedArguments: BuiltinForwardedArgumentBehavior[] = [];
    if (!isOmittedPromiseHandlerArgument(expression.arguments[0])) {
      forwardedArguments.push({ argumentIndex: 0, failureBoundary: 'reject' });
    }
    if (!isOmittedPromiseHandlerArgument(expression.arguments[1])) {
      forwardedArguments.push({ argumentIndex: 1, failureBoundary: 'reject' });
    }
    return {
      directMask: INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments,
    };
  }

  if (memberName === 'catch') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: isOmittedPromiseHandlerArgument(expression.arguments[0])
        ? []
        : [{ argumentIndex: 0, failureBoundary: 'reject' }],
    };
  }

  if (memberName === 'finally') {
    return {
      directMask: INTERNAL_EFFECT_MASKS.suspend,
      forwardedArguments: isOmittedPromiseHandlerArgument(expression.arguments[0])
        ? []
        : [{ argumentIndex: 0, failureBoundary: 'reject' }],
    };
  }

  return undefined;
}

function getSummaryForCallableExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): EffectComposition | undefined {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    const summary = getEffectSummaryForDeclaration(context, expression);
    return {
      mask: summary.directMask,
      unknown: summary.hasUnknownDirectEffects || summary.forwardedParameters.length > 0,
    };
  }

  const type = context.checker.getTypeAtLocation(expression);
  const callSignatures = context.checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const constructSignatures = context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
  const signatures = [...callSignatures, ...constructSignatures];
  if (signatures.length === 0) {
    return undefined;
  }

  let mask = 0;
  let unknown = false;
  for (const signature of signatures) {
    const declaration = signature.getDeclaration();
    if (!declaration || !isCallableDeclarationNode(declaration)) {
      unknown = true;
      continue;
    }
    const summary = getEffectSummaryForDeclaration(context, declaration);
    mask |= summary.directMask;
    if (summary.hasUnknownDirectEffects || summary.forwardedParameters.length > 0) {
      unknown = true;
    }
  }

  return { mask, unknown };
}

function summarizeForwardedArgumentInBody(
  context: AnalysisContext,
  parameters: readonly ts.ParameterDeclaration[],
  argument: ts.Expression | undefined,
  forwardedParameters: Map<string, EffectForwardedParameterFact>,
  failureBoundary: EffectFailureBoundary,
): EffectComposition {
  if (!argument) {
    return { mask: 0, unknown: true };
  }

  const parameterIndex = getCurrentFunctionParameterIndex(context, parameters, argument);
  if (parameterIndex !== undefined) {
    addForwardedParameter(forwardedParameters, parameterIndex, failureBoundary);
    return { mask: 0, unknown: false };
  }

  const summary = getSummaryForCallableExpression(context, argument) ?? { mask: 0, unknown: true };
  return {
    mask: applyForwardedFailureBoundary(summary.mask, failureBoundary),
    unknown: summary.unknown,
  };
}

function hasAsyncBoundary(declaration: EffectCallableDeclaration): boolean {
  return ts.canHaveModifiers(declaration) &&
    ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ===
      true;
}

function hasHostBoundaryAnnotation(context: AnalysisContext, node: ts.Node): boolean {
  const lookup = context.getAnnotationLookup(node.getSourceFile());
  return lookup.hasAttachedAnnotation(node, 'extern') || lookup.hasAttachedAnnotation(node, 'interop');
}

function buildDeclarationSummary(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): EffectSummaryFact {
  const explicitEffects = getEffectsAnnotation(context, declaration);
  const parsedEffects = explicitEffects ? parseEffectsAnnotationContract(explicitEffects) : undefined;
  const parameters = declaration.parameters;
  const parameterContracts = getParameterContracts(context, parameters);
  const summary = emptySummary(context.getNodeId(declaration));
  summary.parameterContracts = parameterContracts;

  if (parsedEffects && typeof parsedEffects !== 'string') {
    summary.forbidMask = parsedEffects.forbidMask;
    summary.forwardedParameters = resolveViaParameters(parameters, parsedEffects.viaNames);
  }

  if (!isCallableBodyDeclaration(declaration)) {
    if (parsedEffects && typeof parsedEffects !== 'string') {
      summary.directMask |= parsedEffects.addMask;
      summary.hasUnknownDirectEffects = false;
    } else {
      summary.hasUnknownDirectEffects = true;
    }
    if (hasHostBoundaryAnnotation(context, declaration)) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.hostInterop;
    }
    return summary;
  }

  const body = declaration.body;
  if (!body) {
    inProgressSummaries.delete(declaration);
    return summary;
  }
  const asyncBoundary = hasAsyncBoundary(declaration);
  if (asyncBoundary) {
    summary.directMask |= INTERNAL_EFFECT_MASKS.suspend;
  }

  const localBindingSymbolIds = collectLocalBindingSymbolIds(context, declaration);
  const forwardedParameters = new Map<string, EffectForwardedParameterFact>(
    summary.forwardedParameters.map((forwardedParameter) => [
      createForwardedParameterKey(
        forwardedParameter.parameterIndex,
        forwardedParameter.failureBoundary,
      ),
      forwardedParameter,
    ]),
  );
  inProgressSummaries.set(declaration, summary);

  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) {
      return;
    }

    if (ts.isThrowStatement(node)) {
      summary.directMask |= asyncBoundary
        ? INTERNAL_EFFECT_MASKS.failsRejects
        : INTERNAL_EFFECT_MASKS.failsThrows;
    } else if (
      ts.isAwaitExpression(node) || ts.isYieldExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier)
    ) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.suspend;
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        summary.directMask |= INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.suspend;
      } else {
        const directParameterIndex = getCurrentFunctionParameterIndex(context, parameters, node.expression);
        if (directParameterIndex !== undefined) {
          addForwardedParameter(forwardedParameters, directParameterIndex, 'preserve');
        } else {
          const builtin = getKnownBuiltinCallBehavior(context, node);
          if (builtin) {
            summary.directMask |= builtin.directMask;
            for (const forwardedArgument of builtin.forwardedArguments) {
              const forwarded = summarizeForwardedArgumentInBody(
                context,
                parameters,
                node.arguments[forwardedArgument.argumentIndex],
                forwardedParameters,
                forwardedArgument.failureBoundary,
              );
              summary.directMask |= applyContainingCallableBoundary(forwarded.mask, asyncBoundary);
              summary.hasUnknownDirectEffects ||= forwarded.unknown;
            }
          } else {
            const calleeSummary = getEffectCompositionForCallLike(context, node);
            summary.directMask |= applyContainingCallableBoundary(calleeSummary.mask, asyncBoundary);
            summary.hasUnknownDirectEffects ||= calleeSummary.unknown;
          }
        }
      }
    } else if (ts.isNewExpression(node)) {
      const calleeSummary = getEffectCompositionForCallLike(context, node);
      summary.directMask |= applyContainingCallableBoundary(calleeSummary.mask, asyncBoundary);
      summary.hasUnknownDirectEffects ||= calleeSummary.unknown;
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      mutationTouchesObservableState(context, node.left, localBindingSymbolIds)
    ) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.mut;
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      mutationTouchesObservableState(context, node.operand, localBindingSymbolIds)
    ) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.mut;
    } else if (ts.isDeleteExpression(node)) {
      summary.directMask |= INTERNAL_EFFECT_MASKS.mut;
    }

    ts.forEachChild(node, visit);
  };
  visit(body);

  summary.forwardedParameters = [...forwardedParameters.values()].sort((left, right) =>
    left.parameterIndex - right.parameterIndex ||
    left.failureBoundary.localeCompare(right.failureBoundary)
  );
  inProgressSummaries.delete(declaration);
  return summary;
}

export function getEffectSummaryForDeclaration(
  context: AnalysisContext,
  declaration: EffectCallableDeclaration,
): EffectSummaryFact {
  const inProgress = inProgressSummaries.get(declaration);
  if (inProgress) {
    return inProgress;
  }

  return context.facts.getEffectSummary(
    declaration,
    () => buildDeclarationSummary(context, declaration),
  );
}

export function getEffectSummaryForSignature(
  context: AnalysisContext,
  signature: ts.Signature | undefined,
): EffectSummaryFact | undefined {
  const declaration = signature?.getDeclaration();
  if (!declaration || !isCallableDeclarationNode(declaration)) {
    return undefined;
  }
  return getEffectSummaryForDeclaration(context, declaration);
}

export function getEffectCompositionForCallLike(
  context: AnalysisContext,
  expression: ts.CallExpression | ts.NewExpression,
): EffectComposition {
  const builtin = getKnownStdlibBehavior(context, expression) ??
    (ts.isCallExpression(expression)
      ? getKnownBuiltinCallBehavior(context, expression)
      : getKnownPortableBuiltinBehavior(context, expression));
  if (builtin) {
    let mask = builtin.directMask;
    let unknown = false;
    for (const forwardedArgument of builtin.forwardedArguments) {
      const forwarded = getSummaryForCallableExpression(
        context,
        expression.arguments?.[forwardedArgument.argumentIndex]!,
      );
      if (!forwarded) {
        unknown = true;
        continue;
      }
      mask |= applyForwardedFailureBoundary(forwarded.mask, forwardedArgument.failureBoundary);
      unknown ||= forwarded.unknown;
    }
    return { mask, unknown };
  }

  const signature = ts.isCallExpression(expression)
    ? context.checker.getResolvedSignature(expression)
    : context.checker.getResolvedSignature(expression);
  const summary = getEffectSummaryForSignature(context, signature);
  if (!summary) {
    return { mask: 0, unknown: true };
  }

  let mask = summary.directMask;
  let unknown = summary.hasUnknownDirectEffects;
  for (const forwardedParameter of summary.forwardedParameters) {
    const forwarded = getSummaryForCallableExpression(
      context,
      expression.arguments?.[forwardedParameter.parameterIndex]!,
    );
    if (!forwarded) {
      unknown = true;
      continue;
    }
    mask |= applyForwardedFailureBoundary(forwarded.mask, forwardedParameter.failureBoundary);
    unknown ||= forwarded.unknown;
  }

  return { mask, unknown };
}

export function getCallableContractSummary(
  context: AnalysisContext,
  expression: ts.CallExpression | ts.NewExpression,
): EffectSummaryFact | undefined {
  const signature = context.checker.getResolvedSignature(expression);
  return getEffectSummaryForSignature(context, signature);
}

export function callableExpressionMayViolateForbidMask(
  context: AnalysisContext,
  expression: ts.Expression,
  forbidMask: number,
): boolean {
  const summary = getSummaryForCallableExpression(context, expression);
  if (!summary) {
    return true;
  }
  return summary.unknown || (summary.mask & forbidMask) !== 0;
}

export function declarationMayViolateOwnForbid(summary: EffectSummaryFact): boolean {
  return summary.forbidMask !== 0 &&
    (summary.hasUnknownDirectEffects || (summary.directMask & summary.forbidMask) !== 0);
}

export function isEffectFreeForCompiler(mask: number, unknown: boolean): boolean {
  return !unknown &&
    (mask & (PUBLIC_EFFECT_MASKS.fails | PUBLIC_EFFECT_MASKS.host | PUBLIC_EFFECT_MASKS.mut |
      PUBLIC_EFFECT_MASKS.suspend)) === 0;
}

export function getEffectContractName(node: ts.Node): string {
  if (
    (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isClassDeclaration(node) ||
      ts.isParameter(node)
    ) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }

  return '<anonymous>';
}

export function getParameterContractName(
  declaration: ts.SignatureDeclarationBase,
  parameterIndex: number,
): string {
  const parameter = declaration.parameters[parameterIndex];
  return parameter ? getParameterName(parameter, parameterIndex) : `<param ${parameterIndex + 1}>`;
}
