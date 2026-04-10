import ts from 'typescript';

import type {
  AnalysisContext,
  PredicateSupportedTarget,
  PredicateVerificationTargetFact,
} from '../engine/types.ts';

type SupportedPrimitive = 'bigint' | 'boolean' | 'number' | 'string' | 'symbol';
type SupportedTypeof = SupportedPrimitive | 'object';

export interface PredicateCheck {
  body: ts.ConciseBody;
  declaration: SignatureDeclarationWithBody;
  parameterName: string;
  parameterType: ts.Type;
  predicateKind: ts.TypePredicateKind;
  predicateType: ts.Type;
  target: PredicateSupportedTarget;
}

export type PredicateSignatureDeclaration =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

export type SignatureDeclarationWithBody = PredicateSignatureDeclaration;

interface ResolvedPredicateContract {
  forbiddenPredicateTypeNode?: ts.TypeNode;
  predicate: ts.TypePredicate;
  signature: ts.Signature;
}

export function isSignatureDeclarationWithBody(
  node: ts.Node,
): node is SignatureDeclarationWithBody {
  return (ts.isArrowFunction(node) && !!node.body) ||
    ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node)) &&
      !!node.body &&
      ts.isBlock(node.body));
}

function getDeclaredPredicateContract(
  context: AnalysisContext,
  declaration: PredicateSignatureDeclaration,
): ResolvedPredicateContract | undefined {
  if (!declaration.type || !ts.isTypePredicateNode(declaration.type)) {
    return undefined;
  }

  const signature = context.checker.getSignatureFromDeclaration(declaration);
  if (!signature) {
    return undefined;
  }

  const predicate = context.checker.getTypePredicateOfSignature(signature);
  if (!predicate) {
    return undefined;
  }

  return {
    forbiddenPredicateTypeNode: declaration.type && ts.isTypePredicateNode(declaration.type)
      ? declaration.type.type
      : undefined,
    predicate,
    signature,
  };
}

function getContextualFunctionTypeNode(
  declaration: PredicateSignatureDeclaration,
): ts.FunctionTypeNode | undefined {
  if (!ts.isArrowFunction(declaration) && !ts.isFunctionExpression(declaration)) {
    return undefined;
  }

  const parent = declaration.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === declaration &&
    parent.type &&
    ts.isFunctionTypeNode(parent.type)
  ) {
    return parent.type;
  }

  return undefined;
}

function getPropertyNameText(
  context: AnalysisContext,
  name: ts.PropertyName,
): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (
      ts.isStringLiteral(expression) ||
      ts.isNumericLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      return expression.text;
    }

    const constantType = context.checker.getTypeAtLocation(expression);
    if ((constantType.flags & ts.TypeFlags.StringLiteral) !== 0) {
      return (constantType as ts.StringLiteralType).value;
    }

    if ((constantType.flags & ts.TypeFlags.NumberLiteral) !== 0) {
      return String((constantType as ts.NumberLiteralType).value);
    }
  }

  return undefined;
}

function getContextualMethodType(
  context: AnalysisContext,
  declaration: ts.MethodDeclaration,
): ts.Type | undefined {
  const parent = declaration.parent;
  if (!ts.isObjectLiteralExpression(parent)) {
    return undefined;
  }

  const propertyName = getPropertyNameText(context, declaration.name);
  if (!propertyName) {
    return undefined;
  }

  const contextualObjectType = context.checker.getContextualType(parent);
  if (!contextualObjectType) {
    return undefined;
  }

  const property = context.checker.getPropertyOfType(contextualObjectType, propertyName);
  if (!property) {
    return undefined;
  }

  return context.checker.getTypeOfSymbolAtLocation(property, declaration.name);
}

function getPredicateTypeNodeFromSignatureDeclaration(
  declaration: ts.Declaration | undefined,
): ts.TypeNode | undefined {
  if (!declaration) {
    return undefined;
  }

  if (
    (ts.isFunctionTypeNode(declaration) ||
      ts.isMethodSignature(declaration) ||
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration)) &&
    declaration.type &&
    ts.isTypePredicateNode(declaration.type)
  ) {
    return declaration.type.type;
  }

  return undefined;
}

function hasExplicitPredicateSurface(
  declaration: ts.Declaration | undefined,
): boolean {
  if (!declaration) {
    return false;
  }

  return (
    (ts.isFunctionTypeNode(declaration) ||
      ts.isMethodSignature(declaration) ||
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration)) &&
    !!declaration.type &&
    ts.isTypePredicateNode(declaration.type)
  );
}

function getContextualPredicateContract(
  context: AnalysisContext,
  declaration: PredicateSignatureDeclaration,
): ResolvedPredicateContract | undefined {
  const contextualType = ts.isMethodDeclaration(declaration)
    ? getContextualMethodType(context, declaration)
    : ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)
    ? context.checker.getContextualType(declaration)
    : undefined;
  if (!contextualType) {
    return undefined;
  }

  const signature = context.checker.getSignaturesOfType(contextualType, ts.SignatureKind.Call)
    .find((candidate) => context.checker.getTypePredicateOfSignature(candidate));
  if (!signature) {
    return undefined;
  }

  const predicate = context.checker.getTypePredicateOfSignature(signature);
  if (!predicate) {
    return undefined;
  }

  const contextualTypeNode = getContextualFunctionTypeNode(declaration);
  const signatureDeclaration = signature.getDeclaration();
  if (
    !(contextualTypeNode &&
      ts.isTypePredicateNode(contextualTypeNode.type)) &&
    !hasExplicitPredicateSurface(signatureDeclaration)
  ) {
    return undefined;
  }

  const forbiddenPredicateTypeNode = contextualTypeNode &&
      ts.isTypePredicateNode(contextualTypeNode.type)
    ? contextualTypeNode.type.type
    : getPredicateTypeNodeFromSignatureDeclaration(signatureDeclaration);

  return {
    forbiddenPredicateTypeNode,
    predicate,
    signature,
  };
}

function getResolvedPredicateContract(
  context: AnalysisContext,
  declaration: PredicateSignatureDeclaration,
): ResolvedPredicateContract | undefined {
  return getDeclaredPredicateContract(context, declaration) ??
    getContextualPredicateContract(context, declaration);
}

function getSupportedPrimitive(type: ts.Type): SupportedPrimitive | undefined {
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const primitiveOptions = new Set(
      (type as ts.UnionType).types
        .map((part) => getSupportedPrimitive(part))
        .filter((primitive): primitive is SupportedPrimitive => primitive !== undefined),
    );

    return primitiveOptions.size === 1 ? primitiveOptions.values().next().value : undefined;
  }

  if ((type.flags & ts.TypeFlags.BigIntLike) !== 0) {
    return 'bigint';
  }

  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return 'boolean';
  }

  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return 'number';
  }

  if ((type.flags & ts.TypeFlags.StringLike) !== 0) {
    return 'string';
  }

  if (
    (type.flags & ts.TypeFlags.ESSymbolLike) !== 0 ||
    (type.flags & ts.TypeFlags.UniqueESSymbol) !== 0
  ) {
    return 'symbol';
  }

  return undefined;
}

function isPrimitiveLiteralLike(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.StringLiteral) !== 0 ||
    (type.flags & ts.TypeFlags.NumberLiteral) !== 0 ||
    (type.flags & ts.TypeFlags.BooleanLiteral) !== 0 ||
    (type.flags & ts.TypeFlags.BigIntLiteral) !== 0 ||
    (type.flags & ts.TypeFlags.UniqueESSymbol) !== 0;
}

function isCompleteBooleanDomain(type: ts.Type): boolean {
  const constituents = (type.flags & ts.TypeFlags.Union) !== 0
    ? (type as ts.UnionType).types
    : [type];
  let hasTrue = false;
  let hasFalse = false;

  for (const part of constituents) {
    if ((part.flags & ts.TypeFlags.BooleanLiteral) === 0) {
      return false;
    }

    const intrinsicName = (part as ts.Type & { intrinsicName?: string }).intrinsicName;
    if (intrinsicName === 'true') {
      hasTrue = true;
    } else if (intrinsicName === 'false') {
      hasFalse = true;
    } else {
      return false;
    }
  }

  return hasTrue && hasFalse;
}

function hasBroadSupportedPrimitiveConstituent(
  type: ts.Type,
  primitive: SupportedPrimitive,
): boolean {
  const constituents = (type.flags & ts.TypeFlags.Union) !== 0
    ? (type as ts.UnionType).types
    : [type];

  return constituents.some((part) =>
    getSupportedPrimitive(part) === primitive && !isPrimitiveLiteralLike(part)
  ) || (primitive === 'boolean' && isCompleteBooleanDomain(type));
}

function isExactObjectPredicateTarget(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.NonPrimitive) !== 0;
}

function getReferenceTypeArguments(
  context: AnalysisContext,
  type: ts.Type,
): readonly ts.Type[] {
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return [];
  }

  const objectType = type as ts.ObjectType;
  if ((objectType.objectFlags & ts.ObjectFlags.Reference) === 0) {
    return [];
  }

  return context.checker.getTypeArguments(objectType as ts.TypeReference);
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

function classifySupportedPredicateTarget(
  context: AnalysisContext,
  type: ts.Type,
): PredicateSupportedTarget | undefined {
  const primitive = getSupportedPrimitive(type);
  if (primitive) {
    if (!hasBroadSupportedPrimitiveConstituent(type, primitive)) {
      return undefined;
    }
    return { kind: 'primitive', primitive };
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    const options = (type as ts.UnionType).types
      .map((part) => classifySupportedPredicateTarget(context, part))
      .filter((option): option is PredicateSupportedTarget => option !== undefined);

    if (options.length > 1 && options.length === (type as ts.UnionType).types.length) {
      return { kind: 'unionOfSupported', options };
    }

    return undefined;
  }

  const normalizedType = context.checker.getNonNullableType(type);
  if (isExactObjectPredicateTarget(type)) {
    return context.checker.isArrayType(normalizedType) ||
        context.checker.isTupleType(normalizedType)
      ? undefined
      : { kind: 'nonNullObject' };
  }

  if ((normalizedType.flags & ts.TypeFlags.Object) === 0) {
    return undefined;
  }

  if (context.checker.isArrayType(normalizedType) || context.checker.isTupleType(normalizedType)) {
    return undefined;
  }

  if ((normalizedType.flags & ts.TypeFlags.TypeParameter) !== 0) {
    return undefined;
  }

  if (getReferenceTypeArguments(context, normalizedType).length > 0) {
    return undefined;
  }

  const symbol = normalizedType.getSymbol();
  if (!symbol) {
    return undefined;
  }

  return {
    kind: 'instanceof',
    constructorSymbol: resolveAliasedSymbol(context.checker, symbol),
  };
}

export function classifyPredicateVerificationTarget(
  context: AnalysisContext,
  declaration: PredicateSignatureDeclaration,
): PredicateVerificationTargetFact | undefined {
  return context.facts.getPredicateVerificationTarget(declaration, () => {
    const contract = getResolvedPredicateContract(context, declaration);
    if (!contract) {
      return undefined;
    }

    const predicate = contract.predicate;

    if (
      predicate.kind === ts.TypePredicateKind.AssertsThis ||
      predicate.kind === ts.TypePredicateKind.This
    ) {
      return {
        kind: 'unsupported',
        reason: 'receiverPredicate',
        subject: 'receiver',
      };
    }

    if (predicate.parameterIndex === undefined || !predicate.type) {
      return {
        kind: 'unsupported',
        reason: 'assertsCondition',
        subject: 'parameter',
      };
    }

    const parameter = declaration.parameters[predicate.parameterIndex];
    if (!parameter || !ts.isIdentifier(parameter.name)) {
      return {
        kind: 'unsupported',
        reason: 'unsupportedParameterName',
        subject: 'parameter',
      };
    }

    const target = classifySupportedPredicateTarget(context, predicate.type);
    if (!target) {
      return {
        kind: 'unsupported',
        reason: 'unsupportedTarget',
        subject: 'parameter',
      };
    }

    return {
      kind: 'supported',
      subject: 'parameter',
      target,
    };
  });
}

export function getPredicateCheck(
  context: AnalysisContext,
  declaration: SignatureDeclarationWithBody,
): PredicateCheck | undefined {
  return getPredicateCheckForSignature(context, declaration, declaration);
}

export function getPredicateCheckForSignature(
  context: AnalysisContext,
  signatureDeclaration: PredicateSignatureDeclaration,
  bodyDeclaration: SignatureDeclarationWithBody,
): PredicateCheck | undefined {
  const body = bodyDeclaration.body;
  if (!body) {
    return undefined;
  }

  const classification = classifyPredicateVerificationTarget(context, signatureDeclaration);
  if (!classification || classification.kind !== 'supported') {
    return undefined;
  }

  const contract = getResolvedPredicateContract(context, signatureDeclaration);
  if (!contract) {
    return undefined;
  }
  const predicate = contract.predicate;
  if (predicate.parameterIndex === undefined || !predicate.type) {
    return undefined;
  }

  const parameter = bodyDeclaration.parameters[predicate.parameterIndex];
  if (!parameter || !ts.isIdentifier(parameter.name)) {
    return undefined;
  }
  const parameterType = context.checker.getTypeAtLocation(parameter);

  return {
    body,
    declaration: bodyDeclaration,
    parameterName: parameter.name.text,
    parameterType,
    predicateKind: predicate.kind,
    predicateType: predicate.type,
    target: classification.target,
  };
}

export function getForbiddenPredicateTypeNode(
  context: AnalysisContext,
  node: PredicateSignatureDeclaration,
): ts.TypeNode | undefined {
  const predicateTypeNode = getResolvedPredicateContract(context, node)?.forbiddenPredicateTypeNode;
  return predicateTypeNode?.kind === ts.SyntaxKind.AnyKeyword ? predicateTypeNode : undefined;
}

export function requiresPredicateVerification(
  node: PredicateSignatureDeclaration,
): boolean {
  return !!node.type && ts.isTypePredicateNode(node.type);
}

export function hasPredicateVerificationContract(
  context: AnalysisContext,
  node: PredicateSignatureDeclaration,
): boolean {
  return requiresPredicateVerification(node) ||
    getContextualPredicateContract(context, node) !== undefined;
}

function isIdentifierReference(expression: ts.Expression, identifierName: string): boolean {
  return ts.isIdentifier(expression) && expression.text === identifierName;
}

function isStringLiteralValue(expression: ts.Expression, value: string): boolean {
  return ts.isStringLiteral(expression) && expression.text === value;
}

function isTypeofCheck(
  expression: ts.Expression,
  parameterName: string,
  primitive: SupportedTypeof,
  equality: 'equal' | 'not-equal',
): boolean {
  if (!ts.isBinaryExpression(expression)) {
    return false;
  }

  const operatorMatches = equality === 'equal'
    ? expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    : expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!operatorMatches) {
    return false;
  }

  const leftMatches = expression.left.kind === ts.SyntaxKind.TypeOfExpression &&
    isIdentifierReference((expression.left as ts.TypeOfExpression).expression, parameterName) &&
    isStringLiteralValue(expression.right, primitive);
  const rightMatches = expression.right.kind === ts.SyntaxKind.TypeOfExpression &&
    isStringLiteralValue(expression.left, primitive) &&
    isIdentifierReference((expression.right as ts.TypeOfExpression).expression, parameterName);

  return leftMatches || rightMatches;
}

function isNullCheck(
  expression: ts.Expression,
  parameterName: string,
  equality: 'equal' | 'not-equal',
): boolean {
  if (!ts.isBinaryExpression(expression)) {
    return false;
  }

  const operatorMatches = equality === 'equal'
    ? expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    : expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!operatorMatches) {
    return false;
  }

  const leftMatches = isIdentifierReference(expression.left, parameterName) &&
    expression.right.kind === ts.SyntaxKind.NullKeyword;
  const rightMatches = expression.left.kind === ts.SyntaxKind.NullKeyword &&
    isIdentifierReference(expression.right, parameterName);

  return leftMatches || rightMatches;
}

function getRuntimeConstructorSymbol(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Symbol | undefined {
  if (ts.isIdentifier(expression)) {
    const symbol = context.checker.getSymbolAtLocation(expression);
    return symbol ? resolveAliasedSymbol(context.checker, symbol) : undefined;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const symbol = context.checker.getSymbolAtLocation(expression.name);
    return symbol ? resolveAliasedSymbol(context.checker, symbol) : undefined;
  }

  return undefined;
}

function isInstanceofCheck(
  context: AnalysisContext,
  expression: ts.Expression,
  parameterName: string,
  constructorSymbol: ts.Symbol | undefined,
): boolean {
  if (!constructorSymbol) {
    return false;
  }

  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    isIdentifierReference(expression.left, parameterName) &&
    getRuntimeConstructorSymbol(context, expression.right) === constructorSymbol;
}

function flattenConjunction(expression: ts.Expression): readonly ts.Expression[] {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [...flattenConjunction(expression.left), ...flattenConjunction(expression.right)];
  }

  return [expression];
}

function getCompositeTypeConstituents(type: ts.Type): readonly ts.Type[] {
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types;
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types;
  }

  return [type];
}

function hasUniqueLiteralPropertyValue(
  context: AnalysisContext,
  parameterType: ts.Type,
  predicateType: ts.Type,
  propertyName: string,
  literalValue: string,
  location: ts.Node,
): boolean {
  let matchCount = 0;

  for (
    const constituentType of getCompositeTypeConstituents(
      context.checker.getNonNullableType(parameterType),
    )
  ) {
    const propertySymbol = context.checker.getPropertyOfType(constituentType, propertyName);
    if (!propertySymbol) {
      continue;
    }

    const propertyType = context.checker.getTypeOfSymbolAtLocation(propertySymbol, location);
    if ((propertyType.flags & ts.TypeFlags.StringLiteral) === 0) {
      continue;
    }

    if ((propertyType as ts.StringLiteralType).value !== literalValue) {
      continue;
    }

    if (!context.checker.isTypeAssignableTo(constituentType, predicateType)) {
      return false;
    }

    matchCount++;
    if (matchCount > 1) {
      return false;
    }
  }

  return matchCount === 1;
}

function matchesPositiveCondition(
  context: AnalysisContext,
  expression: ts.Expression,
  parameterName: string,
  parameterType: ts.Type,
  predicateType: ts.Type,
  target: PredicateSupportedTarget,
): boolean {
  switch (target.kind) {
    case 'primitive':
      return isTypeofCheck(expression, parameterName, target.primitive, 'equal');
    case 'nonNullObject': {
      const parts = flattenConjunction(expression);
      const hasObjectCheck = parts.some((part) =>
        isTypeofCheck(part, parameterName, 'object', 'equal')
      );
      const hasNonNullCheck = parts.some((part) => isNullCheck(part, parameterName, 'not-equal'));
      return parts.length === 2 && hasObjectCheck && hasNonNullCheck;
    }
    case 'instanceof': {
      if (isInstanceofCheck(context, expression, parameterName, target.constructorSymbol)) {
        return true;
      }

      if (!ts.isBinaryExpression(expression)) {
        return false;
      }

      if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
        return false;
      }

      const propertyAccess = ts.isPropertyAccessExpression(expression.left) &&
          isIdentifierReference(expression.left.expression, parameterName) &&
          ts.isStringLiteral(expression.right)
        ? expression.left
        : ts.isPropertyAccessExpression(expression.right) &&
            isIdentifierReference(expression.right.expression, parameterName) &&
            ts.isStringLiteral(expression.left)
        ? expression.right
        : undefined;
      const literal = ts.isStringLiteral(expression.right)
        ? expression.right
        : ts.isStringLiteral(expression.left)
        ? expression.left
        : undefined;
      if (!propertyAccess || !literal) {
        return false;
      }

      const propertySymbol = context.checker.getPropertyOfType(
        predicateType,
        propertyAccess.name.text,
      );
      if (!propertySymbol) {
        return false;
      }

      const propertyType = context.checker.getTypeOfSymbolAtLocation(
        propertySymbol,
        propertyAccess.name,
      );
      return (propertyType.flags & ts.TypeFlags.StringLiteral) !== 0 &&
        (propertyType as ts.StringLiteralType).value === literal.text &&
        hasUniqueLiteralPropertyValue(
          context,
          parameterType,
          predicateType,
          propertyAccess.name.text,
          literal.text,
          propertyAccess.name,
        );
    }
    case 'unionOfSupported': {
      const remainingTargets = [...target.options];
      const queue = [expression];

      while (queue.length > 0) {
        const current = queue.pop();
        if (!current) {
          break;
        }

        if (
          ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ) {
          queue.push(current.left, current.right);
          continue;
        }

        const matchIndex = remainingTargets.findIndex((option) =>
          matchesPositiveCondition(
            context,
            current,
            parameterName,
            parameterType,
            predicateType,
            option,
          )
        );
        if (matchIndex === -1) {
          return false;
        }
        remainingTargets.splice(matchIndex, 1);
      }

      return remainingTargets.length === 0;
    }
    default: {
      const exhaustiveCheck: never = target;
      return exhaustiveCheck;
    }
  }
}

function matchesNegativeCondition(
  context: AnalysisContext,
  expression: ts.Expression,
  parameterName: string,
  target: PredicateSupportedTarget,
): boolean {
  switch (target.kind) {
    case 'primitive':
      return isTypeofCheck(expression, parameterName, target.primitive, 'not-equal');
    case 'nonNullObject':
      return isTypeofCheck(expression, parameterName, 'object', 'not-equal') ||
        isNullCheck(expression, parameterName, 'equal');
    case 'instanceof':
      return ts.isPrefixUnaryExpression(expression) &&
        expression.operator === ts.SyntaxKind.ExclamationToken &&
        isInstanceofCheck(context, expression.operand, parameterName, target.constructorSymbol);
    case 'unionOfSupported': {
      const remainingTargets = [...target.options];

      for (const part of flattenConjunction(expression)) {
        const matchIndex = remainingTargets.findIndex((option) =>
          matchesNegativeCondition(context, part, parameterName, option)
        );
        if (matchIndex === -1) {
          return false;
        }
        remainingTargets.splice(matchIndex, 1);
      }

      return remainingTargets.length === 0;
    }
    default: {
      const exhaustiveCheck: never = target;
      return exhaustiveCheck;
    }
  }
}

function unwrapSingleStatement(statement: ts.Statement): ts.Statement {
  if (ts.isBlock(statement) && statement.statements.length === 1) {
    return unwrapSingleStatement(statement.statements[0]);
  }

  return statement;
}

function isBooleanReturn(statement: ts.Statement, expected: boolean): boolean {
  const unwrappedStatement = unwrapSingleStatement(statement);
  return ts.isReturnStatement(unwrappedStatement) &&
    !!unwrappedStatement.expression &&
    (expected
      ? unwrappedStatement.expression.kind === ts.SyntaxKind.TrueKeyword
      : unwrappedStatement.expression.kind === ts.SyntaxKind.FalseKeyword);
}

function isThrowStatement(statement: ts.Statement): boolean {
  return ts.isThrowStatement(unwrapSingleStatement(statement));
}

function getObjectNegativeCoverage(
  expression: ts.Expression,
  parameterName: string,
): { readonly typeofNotObject: boolean; readonly nullCheck: boolean } | undefined {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
  ) {
    const left = getObjectNegativeCoverage(expression.left, parameterName);
    const right = getObjectNegativeCoverage(expression.right, parameterName);
    if (!left || !right) {
      return undefined;
    }

    return {
      typeofNotObject: left.typeofNotObject || right.typeofNotObject,
      nullCheck: left.nullCheck || right.nullCheck,
    };
  }

  if (isTypeofCheck(expression, parameterName, 'object', 'not-equal')) {
    return { typeofNotObject: true, nullCheck: false };
  }

  if (isNullCheck(expression, parameterName, 'equal')) {
    return { typeofNotObject: false, nullCheck: true };
  }

  return undefined;
}

function verifyNegativeGuardBody(
  context: AnalysisContext,
  statements: readonly ts.Statement[],
  parameterName: string,
  target: PredicateSupportedTarget,
  guardKind: 'return-false' | 'throw',
): boolean {
  if (statements.length === 0) {
    return false;
  }

  const finalStatement = statements.at(-1);
  const guardStatements = guardKind === 'return-false' ? statements.slice(0, -1) : statements;

  if (guardKind === 'return-false' && (!finalStatement || !isBooleanReturn(finalStatement, true))) {
    return false;
  }

  if (target.kind === 'nonNullObject') {
    let sawTypeofNotObject = false;
    let sawNullCheck = false;

    for (const statement of guardStatements) {
      if (!ts.isIfStatement(statement) || statement.elseStatement) {
        return false;
      }

      if (guardKind === 'return-false' && !isBooleanReturn(statement.thenStatement, false)) {
        return false;
      }

      if (guardKind === 'throw' && !isThrowStatement(statement.thenStatement)) {
        return false;
      }

      const coverage = getObjectNegativeCoverage(statement.expression, parameterName);
      if (!coverage) {
        return false;
      }

      sawTypeofNotObject ||= coverage.typeofNotObject;
      sawNullCheck ||= coverage.nullCheck;
    }

    return sawTypeofNotObject && sawNullCheck;
  }

  return guardStatements.every((statement) => {
    if (!ts.isIfStatement(statement) || statement.elseStatement) {
      return false;
    }

    if (guardKind === 'return-false' && !isBooleanReturn(statement.thenStatement, false)) {
      return false;
    }

    if (guardKind === 'throw' && !isThrowStatement(statement.thenStatement)) {
      return false;
    }

    return matchesNegativeCondition(context, statement.expression, parameterName, target);
  });
}

function verifyPositiveBranchBody(
  context: AnalysisContext,
  statements: readonly ts.Statement[],
  parameterName: string,
  parameterType: ts.Type,
  predicateType: ts.Type,
  target: PredicateSupportedTarget,
): boolean {
  if (statements.length < 2) {
    return false;
  }

  const finalStatement = statements.at(-1);
  if (!finalStatement || !isBooleanReturn(finalStatement, false)) {
    return false;
  }

  const branchConditions: ts.Expression[] = [];

  for (const statement of statements.slice(0, -1)) {
    if (
      !ts.isIfStatement(statement) || statement.elseStatement ||
      !isBooleanReturn(statement.thenStatement, true)
    ) {
      return false;
    }

    branchConditions.push(statement.expression);
  }

  if (target.kind === 'unionOfSupported') {
    const remainingTargets = [...target.options];

    for (const condition of branchConditions) {
      const matchIndex = remainingTargets.findIndex((option) =>
        matchesPositiveCondition(
          context,
          condition,
          parameterName,
          parameterType,
          predicateType,
          option,
        )
      );
      if (matchIndex === -1) {
        return false;
      }
      remainingTargets.splice(matchIndex, 1);
    }

    return remainingTargets.length === 0;
  }

  return branchConditions.length === 1 &&
    matchesPositiveCondition(
      context,
      branchConditions[0],
      parameterName,
      parameterType,
      predicateType,
      target,
    );
}

export function verifyPredicateBody(context: AnalysisContext, check: PredicateCheck): boolean {
  if (!ts.isBlock(check.body)) {
    if (check.predicateKind !== ts.TypePredicateKind.Identifier) {
      return false;
    }

    return matchesPositiveCondition(
      context,
      check.body,
      check.parameterName,
      check.parameterType,
      check.predicateType,
      check.target,
    );
  }

  const statements = check.body.statements;

  if (statements.length === 1 && ts.isReturnStatement(statements[0]) && statements[0].expression) {
    return matchesPositiveCondition(
      context,
      statements[0].expression,
      check.parameterName,
      check.parameterType,
      check.predicateType,
      check.target,
    );
  }

  return verifyNegativeGuardBody(
    context,
    statements,
    check.parameterName,
    check.target,
    'return-false',
  ) ||
    verifyNegativeGuardBody(
      context,
      statements,
      check.parameterName,
      check.target,
      'throw',
    ) ||
    verifyPositiveBranchBody(
      context,
      statements,
      check.parameterName,
      check.parameterType,
      check.predicateType,
      check.target,
    );
}
