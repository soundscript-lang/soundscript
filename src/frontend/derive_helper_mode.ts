import ts from 'typescript';

import type { MacroSyntaxNode } from './macro_api.ts';
import type { MacroType } from './macro_semantic_types.ts';
import {
  CODEC_STDLIB_DECLARATION_FILE,
  DECODE_STDLIB_DECLARATION_FILE,
  ENCODE_STDLIB_DECLARATION_FILE,
} from './std_package_support.ts';
import { getInternalChecker, getInternalType } from './macro_type_internal.ts';
import { getValuePathBindingInScope, resolveAliasedSymbol } from './value_binding_internal.ts';

type HelperDirection = 'decode' | 'encode';
type HelperMode = 'async' | 'sync';
type StdlibHelperModule = 'codec' | 'decode' | 'encode';
type HelperInferenceState = {
  readonly parameterBindings?: ReadonlyMap<ts.Symbol, ts.Expression>;
  readonly seenSymbols: Set<ts.Symbol>;
};
type HelperTypeAliasBindings = ReadonlyMap<ts.Symbol, ts.Type>;
type HelperTypeInferenceState = {
  readonly bindings?: HelperTypeAliasBindings;
  readonly seenTypeAliasSymbols: Set<ts.Symbol>;
};

function helperModeFromModeType(type: ts.Type): HelperMode | null {
  const candidateTypes = (type.flags & ts.TypeFlags.Union) !== 0
    ? (type as ts.UnionType).types
    : [type];
  const concreteTypes = candidateTypes.filter((candidateType) =>
    (candidateType.flags & ts.TypeFlags.Undefined) === 0
  );
  if (concreteTypes.length !== 1) {
    return null;
  }
  const [candidateType] = concreteTypes;
  if (!candidateType || (candidateType.flags & ts.TypeFlags.StringLiteral) === 0) {
    return null;
  }
  const value = (candidateType as ts.StringLiteralType).value;
  return value === 'async' || value === 'sync' ? value : null;
}

function combineHelperModes(
  modes: readonly (HelperMode | null)[],
): HelperMode | null {
  let sawUnknown = false;
  for (const mode of modes) {
    if (mode === 'async') {
      return 'async';
    }
    if (mode === null) {
      sawUnknown = true;
    }
  }
  return sawUnknown ? null : 'sync';
}

function normalizeFileNameForComparison(fileName: string): string {
  return fileName.replace(/\\/gu, '/');
}

function stdlibModuleForDeclarationFile(fileName: string): StdlibHelperModule | null {
  const normalized = normalizeFileNameForComparison(fileName);
  if (
    normalized === normalizeFileNameForComparison(DECODE_STDLIB_DECLARATION_FILE) ||
    /(?:^|\/)decode(?:\.d)?\.ts$/u.test(normalized)
  ) {
    return 'decode';
  }
  if (
    normalized === normalizeFileNameForComparison(ENCODE_STDLIB_DECLARATION_FILE) ||
    /(?:^|\/)encode(?:\.d)?\.ts$/u.test(normalized)
  ) {
    return 'encode';
  }
  if (
    normalized === normalizeFileNameForComparison(CODEC_STDLIB_DECLARATION_FILE) ||
    /(?:^|\/)codec(?:\.d)?\.ts$/u.test(normalized)
  ) {
    return 'codec';
  }
  return null;
}

function stdlibHelperIdentityForSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): { readonly module: StdlibHelperModule; readonly name: string } | null {
  const resolved = resolveAliasedSymbol(checker, symbol);
  const module = (resolved.declarations ?? [])
    .map((declaration) => stdlibModuleForDeclarationFile(declaration.getSourceFile().fileName))
    .find((value) => value !== null) ?? null;
  if (!module) {
    return null;
  }
  return {
    module,
    name: resolved.getName(),
  };
}

function helperModeTypeArgumentIndex(
  identity: { readonly module: StdlibHelperModule; readonly name: string },
  direction: HelperDirection,
): number | null {
  if (identity.module === 'decode' && identity.name === 'Decoder') {
    return 2;
  }
  if (identity.module === 'encode' && identity.name === 'Encoder') {
    return 3;
  }
  if (identity.module === 'codec' && identity.name === 'Codec') {
    return direction === 'decode' ? 4 : 5;
  }
  return null;
}

function helperModeFromStdlibHelperTypeArguments(
  identity: { readonly module: StdlibHelperModule; readonly name: string },
  typeArguments: readonly ts.Type[] | undefined,
  direction: HelperDirection,
): HelperMode | null {
  const index = helperModeTypeArgumentIndex(identity, direction);
  if (index === null) {
    return null;
  }
  if (!typeArguments || index >= typeArguments.length) {
    return 'sync';
  }
  const argumentType = typeArguments[index];
  return argumentType ? helperModeFromModeType(argumentType) : null;
}

function typeArgumentsForTypeReference(
  checker: ts.TypeChecker,
  type: ts.Type,
): readonly ts.Type[] | undefined {
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return undefined;
  }
  const objectType = type as ts.ObjectType;
  if ((objectType.objectFlags & ts.ObjectFlags.Reference) === 0) {
    return undefined;
  }
  try {
    return checker.getTypeArguments(type as ts.TypeReference);
  } catch {
    return undefined;
  }
}

function getTypeSymbol(type: ts.Type): ts.Symbol | undefined {
  return type.aliasSymbol ?? type.getSymbol();
}

function getTypeReferenceTargetSymbol(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
): ts.Symbol | null {
  if (ts.isTypeReferenceNode(node)) {
    return checker.getSymbolAtLocation(node.typeName) ?? null;
  }
  if (ts.isImportTypeNode(node) && node.qualifier) {
    return checker.getSymbolAtLocation(node.qualifier) ?? null;
  }
  return null;
}

function getTypeReferenceArgumentNodes(node: ts.TypeNode): readonly ts.TypeNode[] | undefined {
  if (ts.isTypeReferenceNode(node)) {
    return node.typeArguments;
  }
  if (ts.isImportTypeNode(node)) {
    return node.typeArguments;
  }
  return undefined;
}

function resolveBoundTypeFromTypeNode(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
  state: HelperTypeInferenceState,
): ts.Type | null {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    const symbol = checker.getSymbolAtLocation(node.typeName);
    const resolved = symbol ? resolveAliasedSymbol(checker, symbol) : null;
    if (resolved && (resolved.flags & ts.SymbolFlags.TypeParameter) !== 0) {
      return state.bindings?.get(resolved) ?? null;
    }
  }
  return checker.getTypeFromTypeNode(node);
}

function createHelperTypeInferenceState(
  seenTypeAliasSymbols?: ReadonlySet<ts.Symbol>,
  bindings?: HelperTypeAliasBindings,
): HelperTypeInferenceState {
  return {
    ...(bindings ? { bindings } : {}),
    seenTypeAliasSymbols: new Set(seenTypeAliasSymbols ?? []),
  };
}

function helperModeFromTypeNode(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
  direction: HelperDirection,
  state: HelperTypeInferenceState,
): HelperMode | null {
  if (ts.isParenthesizedTypeNode(node)) {
    return helperModeFromTypeNode(checker, node.type, direction, state);
  }

  if (ts.isIntersectionTypeNode(node)) {
    return combineHelperModes(
      node.types.map((member) => helperModeFromTypeNode(checker, member, direction, state)),
    );
  }

  const symbol = getTypeReferenceTargetSymbol(checker, node);
  if (!symbol) {
    return null;
  }
  const resolved = resolveAliasedSymbol(checker, symbol);
  const helperIdentity = stdlibHelperIdentityForSymbol(checker, resolved);
  const typeArgumentNodes = getTypeReferenceArgumentNodes(node);
  if (helperIdentity) {
    const index = helperModeTypeArgumentIndex(helperIdentity, direction);
    if (index === null) {
      return null;
    }
    if (!typeArgumentNodes || index >= typeArgumentNodes.length) {
      return 'sync';
    }
    const modeType = resolveBoundTypeFromTypeNode(checker, typeArgumentNodes[index]!, state);
    return modeType ? helperModeFromModeType(modeType) : null;
  }

  if (
    (resolved.flags & ts.SymbolFlags.TypeAlias) === 0 ||
    state.seenTypeAliasSymbols.has(resolved)
  ) {
    return null;
  }

  const typeAliasDeclaration = resolved.declarations?.find(ts.isTypeAliasDeclaration);
  if (!typeAliasDeclaration) {
    return null;
  }

  const nextBindings = new Map(state.bindings ? Array.from(state.bindings.entries()) : []);
  const typeParameters = typeAliasDeclaration.typeParameters ?? [];
  for (const [index, parameter] of typeParameters.entries()) {
    const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
    if (!parameterSymbol) {
      continue;
    }
    const argumentNode = typeArgumentNodes?.[index];
    const resolvedType = argumentNode
      ? resolveBoundTypeFromTypeNode(checker, argumentNode, state)
      : parameter.default
      ? resolveBoundTypeFromTypeNode(checker, parameter.default, state)
      : null;
    if (resolvedType) {
      nextBindings.set(resolveAliasedSymbol(checker, parameterSymbol), resolvedType);
    }
  }

  const nextState = createHelperTypeInferenceState(state.seenTypeAliasSymbols, nextBindings);
  nextState.seenTypeAliasSymbols.add(resolved);
  return helperModeFromTypeNode(checker, typeAliasDeclaration.type, direction, nextState);
}

function helperModeFromTypeStructure(
  checker: ts.TypeChecker,
  type: ts.Type,
  direction: HelperDirection,
): HelperMode | null {
  const anyType = type as ts.Type & {
    aliasSymbol?: ts.Symbol;
    aliasTypeArguments?: readonly ts.Type[];
  };
  const aliasSymbol = anyType.aliasSymbol
    ? resolveAliasedSymbol(checker, anyType.aliasSymbol)
    : null;
  if (aliasSymbol) {
    const helperIdentity = stdlibHelperIdentityForSymbol(checker, aliasSymbol);
    if (helperIdentity) {
      const direct = helperModeFromStdlibHelperTypeArguments(
        helperIdentity,
        anyType.aliasTypeArguments,
        direction,
      );
      if (direct) {
        return direct;
      }
    }

    if ((aliasSymbol.flags & ts.SymbolFlags.TypeAlias) !== 0) {
      const typeAliasDeclaration = aliasSymbol.declarations?.find(ts.isTypeAliasDeclaration);
      if (typeAliasDeclaration) {
        const aliasBindings = new Map<ts.Symbol, ts.Type>();
        const typeParameters = typeAliasDeclaration.typeParameters ?? [];
        for (const [index, parameter] of typeParameters.entries()) {
          const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
          const argumentType = anyType.aliasTypeArguments?.[index];
          if (parameterSymbol && argumentType) {
            aliasBindings.set(resolveAliasedSymbol(checker, parameterSymbol), argumentType);
          }
        }
        const aliasMode = helperModeFromTypeNode(
          checker,
          typeAliasDeclaration.type,
          direction,
          createHelperTypeInferenceState(undefined, aliasBindings),
        );
        if (aliasMode) {
          return aliasMode;
        }
      }
    }
  }

  const directSymbol = getTypeSymbol(type);
  if (directSymbol) {
    const helperIdentity = stdlibHelperIdentityForSymbol(checker, directSymbol);
    if (helperIdentity) {
      const direct = helperModeFromStdlibHelperTypeArguments(
        helperIdentity,
        typeArgumentsForTypeReference(checker, type),
        direction,
      );
      if (direct) {
        return direct;
      }
    }
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return combineHelperModes(
      (type as ts.IntersectionType).types.map((member) =>
        helperModeFromTypeStructure(checker, member, direction)
      ),
    );
  }

  return null;
}

function helperModeFromType(
  checker: ts.TypeChecker,
  type: ts.Type,
  direction: HelperDirection,
): HelperMode | null {
  return helperModeFromTypeStructure(checker, type, direction);
}

function getNodeType(checker: ts.TypeChecker, node: ts.Node): ts.Type {
  return ts.isTypeNode(node) ? checker.getTypeFromTypeNode(node) : checker.getTypeAtLocation(node);
}

function typeIsPromiseLike(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  const awaitedType = checker.getAwaitedType(type);
  return awaitedType !== undefined && awaitedType !== type;
}

function callableExpressionReturnsPromiseLike(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): boolean {
  const type = getNodeType(checker, expression);
  return checker.getSignaturesOfType(type, ts.SignatureKind.Call).some((signature) =>
    typeIsPromiseLike(checker, checker.getReturnTypeOfSignature(signature))
  );
}

function initializerExpressionForBindingDeclaration(
  declaration: ts.Declaration,
): ts.Expression | null {
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertyAssignment(declaration)
  ) {
    return declaration.initializer ?? null;
  }
  if (ts.isShorthandPropertyAssignment(declaration)) {
    return declaration.objectAssignmentInitializer ?? declaration.name;
  }
  return null;
}

function callableImplementationForDeclaration(
  declaration: ts.Declaration,
):
  | { readonly body: ts.ConciseBody; readonly parameters: readonly ts.ParameterDeclaration[] }
  | null {
  if (
    (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) &&
    declaration.body
  ) {
    return {
      body: declaration.body,
      parameters: declaration.parameters,
    };
  }

  const initializer = initializerExpressionForBindingDeclaration(declaration);
  if (
    initializer &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  ) {
    return {
      body: initializer.body,
      parameters: initializer.parameters,
    };
  }

  return null;
}

function bindCallableParameters(
  checker: ts.TypeChecker,
  parameters: readonly ts.ParameterDeclaration[],
  argumentsList: readonly ts.Expression[],
  state: HelperInferenceState,
): ReadonlyMap<ts.Symbol, ts.Expression> | undefined {
  let bindings: Map<ts.Symbol, ts.Expression> | undefined = state.parameterBindings
    ? new Map(state.parameterBindings)
    : undefined;

  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    if (!parameter || !ts.isIdentifier(parameter.name)) {
      continue;
    }
    const argument = argumentsList[index] ?? parameter.initializer;
    if (!argument) {
      continue;
    }
    const symbol = checker.getSymbolAtLocation(parameter.name);
    if (!symbol) {
      continue;
    }
    if (!bindings) {
      bindings = new Map();
    }
    bindings.set(resolveAliasedSymbol(checker, symbol), argument);
  }

  return bindings;
}

function combineFunctionReturnModes(
  checker: ts.TypeChecker,
  body: ts.ConciseBody,
  direction: HelperDirection,
  state: HelperInferenceState,
): HelperMode | null {
  if (!ts.isBlock(body)) {
    return inferHelperModeFromExpression(checker, body, direction, state);
  }

  const modes: (HelperMode | null)[] = [];
  function visit(node: ts.Node) {
    if (ts.isReturnStatement(node)) {
      modes.push(
        node.expression
          ? inferHelperModeFromExpression(checker, node.expression, direction, state)
          : null,
      );
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(body, visit);
  return modes.length > 0 ? combineHelperModes(modes) : null;
}

function helperModeFromShapeLiteral(
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
  direction: HelperDirection,
  state: HelperInferenceState,
): HelperMode | null {
  if (!expression || !ts.isObjectLiteralExpression(expression)) {
    return null;
  }
  const modes: (HelperMode | null)[] = [];
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      return null;
    }
    if (ts.isPropertyAssignment(property)) {
      modes.push(inferHelperModeFromExpression(checker, property.initializer, direction, state));
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      modes.push(inferHelperModeFromExpression(checker, property.name, direction, state));
      continue;
    }
    return null;
  }
  return combineHelperModes(modes);
}

function stdlibHelperIdentityForCallee(
  checker: ts.TypeChecker,
  callee: ts.LeftHandSideExpression,
): { readonly module: StdlibHelperModule; readonly name: string } | null {
  const symbolTarget = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
  const symbol = checker.getSymbolAtLocation(symbolTarget);
  if (!symbol) {
    return null;
  }
  return stdlibHelperIdentityForSymbol(checker, symbol);
}

function inferHelperModeFromLocalCallable(
  checker: ts.TypeChecker,
  callExpression: ts.CallExpression,
  direction: HelperDirection,
  state: HelperInferenceState,
): HelperMode | null {
  const symbolTarget = ts.isPropertyAccessExpression(callExpression.expression)
    ? callExpression.expression.name
    : callExpression.expression;
  const symbol = checker.getSymbolAtLocation(symbolTarget);
  if (!symbol) {
    return null;
  }

  const resolvedSymbol = resolveAliasedSymbol(checker, symbol);
  if (state.seenSymbols.has(resolvedSymbol)) {
    return null;
  }

  state.seenSymbols.add(resolvedSymbol);
  try {
    const declarationModes = (resolvedSymbol.declarations ?? [])
      .map((declaration) => {
        const implementation = callableImplementationForDeclaration(declaration);
        if (!implementation) {
          return null;
        }
        return combineFunctionReturnModes(checker, implementation.body, direction, {
          parameterBindings: bindCallableParameters(
            checker,
            implementation.parameters,
            callExpression.arguments,
            state,
          ),
          seenSymbols: state.seenSymbols,
        });
      });
    return declarationModes.length > 0 ? combineHelperModes(declarationModes) : null;
  } finally {
    state.seenSymbols.delete(resolvedSymbol);
  }
}

function inferHelperModeFromCallExpression(
  checker: ts.TypeChecker,
  callExpression: ts.CallExpression,
  direction: HelperDirection,
  state: HelperInferenceState,
): HelperMode | null {
  const helper = stdlibHelperIdentityForCallee(checker, callExpression.expression);
  if (!helper) {
    return inferHelperModeFromLocalCallable(checker, callExpression, direction, state);
  }

  const inferArgMode = (index: number): HelperMode | null =>
    index < callExpression.arguments.length
      ? inferHelperModeFromExpression(checker, callExpression.arguments[index]!, direction, state)
      : null;
  const inferThunkMode = (index: number): HelperMode | null => {
    const argument = callExpression.arguments[index];
    if (!argument) {
      return null;
    }
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
      return combineFunctionReturnModes(checker, argument.body, direction, state);
    }
    return inferHelperModeFromExpression(checker, argument, direction, state);
  };

  switch (helper.module) {
    case 'decode': {
      switch (helper.name) {
        case 'array':
        case 'nullable':
        case 'optional':
        case 'option':
        case 'readonlyRecord':
        case 'undefinedable':
          return inferArgMode(0);
        case 'defaulted':
          return combineHelperModes([
            inferArgMode(0),
            callableExpressionReturnsPromiseLike(checker, callExpression.arguments[1]!)
              ? 'async'
              : 'sync',
          ]);
        case 'lazy':
          return inferThunkMode(0);
        case 'map':
        case 'refine':
        case 'preprocess':
          return combineHelperModes([
            inferArgMode(0),
            callableExpressionReturnsPromiseLike(checker, callExpression.arguments[1]!)
              ? 'async'
              : 'sync',
          ]);
        case 'object':
        case 'passthroughObject':
        case 'strictObject':
          return helperModeFromShapeLiteral(checker, callExpression.arguments[0], direction, state);
        case 'result':
        case 'union':
          return combineHelperModes([inferArgMode(0), inferArgMode(1)]);
        case 'tuple':
          return combineHelperModes(
            callExpression.arguments.map((argument) =>
              inferHelperModeFromExpression(checker, argument, direction, state)
            ),
          );
        default:
          return null;
      }
    }
    case 'encode': {
      switch (helper.name) {
        case 'array':
        case 'nullable':
        case 'optional':
        case 'option':
        case 'record':
        case 'undefinedable':
          return inferArgMode(0);
        case 'contramap':
        case 'refine':
          return combineHelperModes([
            inferArgMode(0),
            callableExpressionReturnsPromiseLike(checker, callExpression.arguments[1]!)
              ? 'async'
              : 'sync',
          ]);
        case 'lazy':
          return inferThunkMode(0);
        case 'object':
        case 'passthroughObject':
        case 'strictObject':
          return helperModeFromShapeLiteral(checker, callExpression.arguments[0], direction, state);
        case 'result':
          return combineHelperModes([inferArgMode(0), inferArgMode(1)]);
        case 'tuple':
          return combineHelperModes(
            callExpression.arguments.map((argument) =>
              inferHelperModeFromExpression(checker, argument, direction, state)
            ),
          );
        default:
          return null;
      }
    }
    case 'codec': {
      switch (helper.name) {
        case 'codec':
          return direction === 'decode' ? inferArgMode(0) : inferArgMode(1);
        case 'imap':
          return inferArgMode(0);
        default:
          return null;
      }
    }
  }
}

function inferHelperModeFromBinding(
  checker: ts.TypeChecker,
  binding: { readonly symbol: ts.Symbol; readonly type: ts.Type },
  direction: HelperDirection,
  state: HelperInferenceState,
): HelperMode | null {
  const resolvedSymbol = resolveAliasedSymbol(checker, binding.symbol);
  if (state.seenSymbols.has(resolvedSymbol)) {
    return null;
  }

  const typeMode = helperModeFromType(checker, binding.type, direction);
  if (typeMode === 'async') {
    return 'async';
  }

  state.seenSymbols.add(resolvedSymbol);
  try {
    const declarationModes = (resolvedSymbol.declarations ?? [])
      .map((declaration) => {
        const implementation = callableImplementationForDeclaration(declaration);
        if (implementation) {
          return combineFunctionReturnModes(checker, implementation.body, direction, state);
        }
        const expression = initializerExpressionForBindingDeclaration(declaration);
        return expression
          ? inferHelperModeFromExpression(checker, expression, direction, state)
          : null;
      });
    const declarationMode = declarationModes.length > 0
      ? combineHelperModes(declarationModes)
      : null;
    return declarationMode ?? typeMode;
  } finally {
    state.seenSymbols.delete(resolvedSymbol);
  }
}

function inferHelperModeFromExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  direction: HelperDirection,
  state: HelperInferenceState,
): HelperMode | null {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isPartiallyEmittedExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return inferHelperModeFromExpression(checker, expression.expression, direction, state);
  }

  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (symbol) {
      const overrideExpression = state.parameterBindings?.get(
        resolveAliasedSymbol(checker, symbol),
      );
      if (overrideExpression) {
        return inferHelperModeFromExpression(checker, overrideExpression, direction, state);
      }
    }
    const binding = getValuePathBindingInScope(checker, expression, expression.text);
    return binding ? inferHelperModeFromBinding(checker, binding, direction, state) : null;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const binding = getValuePathBindingInScope(checker, expression, expression.getText());
    return binding ? inferHelperModeFromBinding(checker, binding, direction, state) : null;
  }

  if (ts.isCallExpression(expression)) {
    return inferHelperModeFromCallExpression(checker, expression, direction, state);
  }

  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return combineFunctionReturnModes(checker, expression.body, direction, state);
  }

  if (ts.isConditionalExpression(expression)) {
    return combineHelperModes([
      inferHelperModeFromExpression(checker, expression.whenTrue, direction, state),
      inferHelperModeFromExpression(checker, expression.whenFalse, direction, state),
    ]);
  }

  return null;
}

export function inferDeriveHelperMode(
  helperType: MacroType,
  helperIdentifier: string,
  direction: HelperDirection,
  lookupNode: ts.Node | null,
): HelperMode | null {
  const checker = getInternalChecker(helperType);
  const type = getInternalType(helperType);
  if (!lookupNode) {
    return helperModeFromType(checker, type, direction);
  }

  const binding = getValuePathBindingInScope(checker, lookupNode, helperIdentifier);
  return binding
    ? inferHelperModeFromBinding(checker, binding, direction, { seenSymbols: new Set() })
    : helperModeFromType(checker, type, direction);
}
