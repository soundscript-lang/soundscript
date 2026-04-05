import ts from 'typescript';

import type { CompilerExpressionIR, CompilerValueType } from './ir.ts';
import {
  isSupportedOwnedHeapArrayType,
  isSupportedOwnedBooleanArrayType,
  isSupportedOwnedNumberArrayType,
  isSupportedOwnedStringArrayType,
  isSupportedOwnedTaggedArrayType,
} from './lower_arrays.ts';
import { isStringLikeType } from './lower_tagged.ts';
import { isObjectKeysCall } from './lower_strings.ts';

interface LengthViewBoundSymbol {
  emittedName: string;
  type: CompilerValueType;
}

interface LengthViewContextLike {
  checker: ts.TypeChecker;
}

interface LengthViewDeps<TContext extends LengthViewContextLike> {
  lookupSymbol(context: TContext, name: string): LengthViewBoundSymbol | undefined;
  lowerExpression(
    expression: ts.Expression,
    context: TContext,
  ): CompilerExpressionIR;
  lowerObjectKeysLengthExpression(
    expression: ts.CallExpression,
    context: TContext,
  ): CompilerExpressionIR | undefined;
  lowerExpressionAsValueType(
    expression: ts.Expression,
    targetType: CompilerValueType,
    context: TContext,
  ): CompilerExpressionIR;
  lowerOwnedStringExpression(
    expression: ts.Expression,
    context: TContext,
  ): CompilerExpressionIR | undefined;
  lowerOwnedStringArrayExpression(
    expression: ts.Expression,
    context: TContext,
  ): CompilerExpressionIR | undefined;
  lowerOwnedHeapArrayExpression(
    expression: ts.Expression,
    context: TContext,
  ): CompilerExpressionIR | undefined;
  lowerOwnedNumberArrayExpression(
    expression: ts.Expression,
    context: TContext,
  ): CompilerExpressionIR | undefined;
  lowerOwnedBooleanArrayExpression(
    expression: ts.Expression,
    context: TContext,
  ): CompilerExpressionIR | undefined;
  lowerOwnedTaggedArrayExpression(
    expression: ts.Expression,
    context: TContext,
  ): CompilerExpressionIR | undefined;
}

function tryGetStaticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

export function isSupportedLengthViewType(
  checker: ts.TypeChecker,
  type: ts.Type,
  contextNode: ts.Node,
): boolean {
  if (isStringLikeType(type) || checker.isArrayType(type) || checker.isTupleType(type)) {
    return false;
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return false;
  }
  if (
    checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
  ) {
    return false;
  }
  const properties = checker.getPropertiesOfType(type);
  if (properties.length !== 1 || properties[0]?.name !== 'length') {
    return false;
  }
  const lengthSymbol = properties[0];
  if (!lengthSymbol) {
    return false;
  }
  const declaration = lengthSymbol.valueDeclaration ?? lengthSymbol.declarations?.[0] ?? contextNode;
  const lengthType = checker.getTypeOfSymbolAtLocation(lengthSymbol, declaration);
  return (lengthType.flags & ts.TypeFlags.NumberLike) !== 0;
}

export function isSupportedLengthViewSourceExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isSupportedLengthViewSourceExpression(checker, expression.expression);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const expressionType = checker.getTypeAtLocation(expression);
    return isSupportedOwnedHeapArrayType(checker, expressionType) ||
      isSupportedOwnedStringArrayType(checker, expressionType) ||
      isSupportedOwnedNumberArrayType(checker, expressionType) ||
      isSupportedOwnedBooleanArrayType(checker, expressionType) ||
      isSupportedOwnedTaggedArrayType(checker, expressionType);
  }
  if (ts.isCallExpression(expression) && isObjectKeysCall(expression)) {
    return true;
  }
  if (isStringLikeType(checker.getTypeAtLocation(expression))) {
    return true;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    if (expression.properties.length !== 1) {
      return false;
    }
    const property = expression.properties[0];
    if (!ts.isPropertyAssignment(property)) {
      return false;
    }
    const propertyName = tryGetStaticPropertyName(property.name);
    if (propertyName !== 'length') {
      return false;
    }
    const propertyType = checker.getTypeAtLocation(property.initializer);
    return (propertyType.flags & ts.TypeFlags.NumberLike) !== 0;
  }
  return false;
}

function tryLowerLengthViewObjectLiteralExpression<TContext extends LengthViewContextLike>(
  expression: ts.Expression,
  context: TContext,
  deps: Pick<LengthViewDeps<TContext>, 'lowerExpressionAsValueType'>,
): CompilerExpressionIR | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return tryLowerLengthViewObjectLiteralExpression(expression.expression, context, deps);
  }
  if (!ts.isObjectLiteralExpression(expression) || expression.properties.length !== 1) {
    return undefined;
  }
  const property = expression.properties[0];
  if (!ts.isPropertyAssignment(property)) {
    return undefined;
  }
  const propertyName = tryGetStaticPropertyName(property.name);
  if (propertyName !== 'length') {
    return undefined;
  }
  const propertyType = context.checker.getTypeAtLocation(property.initializer);
  if ((propertyType.flags & ts.TypeFlags.NumberLike) === 0) {
    return undefined;
  }
  return deps.lowerExpressionAsValueType(property.initializer, 'f64', context);
}

export function tryLowerLengthViewExpression<TContext extends LengthViewContextLike>(
  expression: ts.Expression,
  context: TContext,
  deps: LengthViewDeps<TContext>,
): CompilerExpressionIR | undefined {
  if (ts.isParenthesizedExpression(expression)) {
    return tryLowerLengthViewExpression(expression.expression, context, deps);
  }
  if (ts.isIdentifier(expression)) {
    const symbol = deps.lookupSymbol(context, expression.text);
    const expressionType = context.checker.getTypeAtLocation(expression);
    if (symbol?.type === 'f64' && isSupportedLengthViewType(context.checker, expressionType, expression)) {
      return {
        kind: 'local_get',
        name: symbol.emittedName,
        type: 'f64',
      };
    }
  }
  if (ts.isCallExpression(expression) && isObjectKeysCall(expression)) {
    const objectKeysLength = deps.lowerObjectKeysLengthExpression(expression, context);
    if (objectKeysLength) {
      return objectKeysLength;
    }
  }
  if (ts.isCallExpression(expression)) {
    const expressionType = context.checker.getTypeAtLocation(expression);
    if (isSupportedLengthViewType(context.checker, expressionType, expression)) {
      const loweredExpression = deps.lowerExpression(expression, context);
      if ('type' in loweredExpression && loweredExpression.type === 'f64') {
        return loweredExpression;
      }
    }
  }
  const ownedStringArrayExpression = deps.lowerOwnedStringArrayExpression(expression, context);
  if (ownedStringArrayExpression) {
    return {
      kind: 'owned_array_length',
      value: ownedStringArrayExpression,
      type: 'f64',
    };
  }
  const ownedHeapArrayExpression = deps.lowerOwnedHeapArrayExpression(expression, context);
  if (ownedHeapArrayExpression) {
    return {
      kind: 'owned_array_length',
      value: ownedHeapArrayExpression,
      type: 'f64',
    };
  }
  const ownedNumberArrayExpression = deps.lowerOwnedNumberArrayExpression(expression, context);
  if (ownedNumberArrayExpression) {
    return {
      kind: 'owned_array_length',
      value: ownedNumberArrayExpression,
      type: 'f64',
    };
  }
  const ownedBooleanArrayExpression = deps.lowerOwnedBooleanArrayExpression(expression, context);
  if (ownedBooleanArrayExpression) {
    return {
      kind: 'owned_array_length',
      value: ownedBooleanArrayExpression,
      type: 'f64',
    };
  }
  const ownedTaggedArrayExpression = deps.lowerOwnedTaggedArrayExpression(expression, context);
  if (ownedTaggedArrayExpression) {
    return {
      kind: 'owned_array_length',
      value: ownedTaggedArrayExpression,
      type: 'f64',
    };
  }
  if (isStringLikeType(context.checker.getTypeAtLocation(expression))) {
    const ownedStringExpression = deps.lowerOwnedStringExpression(expression, context);
    if (ownedStringExpression) {
      return {
        kind: 'owned_string_length',
        value: ownedStringExpression,
        type: 'f64',
      };
    }
  }
  return tryLowerLengthViewObjectLiteralExpression(expression, context, deps);
}
