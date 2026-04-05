import ts from 'typescript';

import { buildRewriteStageFromTexts } from './error_normalization.ts';
import {
  isSoundscriptSourceFile,
  type PreparedRewriteStage,
  toSourceFileName,
} from './project_frontend.ts';

export interface NumericNormalizedFile {
  rewriteStage: PreparedRewriteStage;
  sourceFile: ts.SourceFile;
}

export interface NumericNormalizedProgramResult {
  changedFiles: ReadonlyMap<string, NumericNormalizedFile>;
}

export interface MixedMachineNumericArithmetic {
  end: number;
  expressionText: string;
  fileName: string;
  leftLeaf: string;
  operatorText: string;
  rightLeaf: string;
  start: number;
}

export interface AbstractNumericFamilyArithmetic {
  abstractFamilies: readonly string[];
  end: number;
  expressionText: string;
  fileName: string;
  operatorText: string;
  start: number;
}

export interface SortCallWithoutComparator {
  end: number;
  expressionText: string;
  fileName: string;
  methodName: 'sort' | 'toSorted';
  start: number;
}

type SortMethodName = SortCallWithoutComparator['methodName'];

export type NumericLoweringTarget = 'js' | 'wasm';

const MACHINE_NUMERIC_CONSTRUCTOR_BY_LEAF = new Map<string, string>([
  ['f64', 'F64'],
  ['f32', 'F32'],
  ['i8', 'I8'],
  ['i16', 'I16'],
  ['i32', 'I32'],
  ['i64', 'I64'],
  ['u8', 'U8'],
  ['u16', 'U16'],
  ['u32', 'U32'],
  ['u64', 'U64'],
]);

const MACHINE_NUMERIC_BINARY_HELPER = '__numericBinary';
const MACHINE_NUMERIC_UNARY_HELPER = '__numericUnary';
const MACHINE_NUMERIC_WASM_LEAF_HELPER = '__numericWasmLeaf';
const MACHINE_NUMERIC_LEAF_NAMES = new Set(MACHINE_NUMERIC_CONSTRUCTOR_BY_LEAF.keys());
const ABSTRACT_NUMERIC_FAMILY_NAMES = new Set(['Numeric', 'Int', 'Float']);
const SORT_METHOD_OWNER_NAMES = new Set([
  'Array',
  'ReadonlyArray',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

const MACHINE_NUMERIC_BINARY_OPERATOR_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

const MACHINE_NUMERIC_COMPOUND_ASSIGNMENT_OPERATOR_KINDS = new Map<ts.SyntaxKind, ts.SyntaxKind>([
  [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
  [ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken],
  [ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskToken],
  [ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.SlashToken],
  [ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.PercentToken],
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.AsteriskAsteriskToken],
  [ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.AmpersandToken],
  [ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.BarToken],
  [ts.SyntaxKind.CaretEqualsToken, ts.SyntaxKind.CaretToken],
  [ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.LessThanLessThanToken],
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanToken],
  [
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ],
]);

const MACHINE_NUMERIC_UNARY_OPERATOR_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.TildeToken,
]);

const MACHINE_NUMERIC_UPDATE_OPERATOR_KINDS = new Map<ts.SyntaxKind, ts.SyntaxKind>([
  [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.PlusToken],
  [ts.SyntaxKind.MinusMinusToken, ts.SyntaxKind.MinusToken],
]);

type MachineNumericAssignmentTarget =
  | { kind: 'identifier'; target: ts.Identifier }
  | { kind: 'property'; base: ts.Expression; name: ts.MemberName }
  | { kind: 'element'; argument: ts.Expression; base: ts.Expression };

function repairBuiltinMacroModuleSpecifiers(text: string): string {
  return text.replaceAll(
    /from\s+soundscript:builtins(?=[;\n])/gu,
    "from 'soundscript:builtins'",
  );
}

function unwrapParenthesizedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function getDeclarationNameText(name: ts.DeclarationName | undefined): string | undefined {
  if (!name) {
    return undefined;
  }

  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  return undefined;
}

function getSignatureDeclarationOwnerName(
  declaration: ts.SignatureDeclarationBase,
): string | undefined {
  let current: ts.Node | undefined = declaration.parent;

  while (current) {
    if (
      ts.isInterfaceDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isModuleDeclaration(current)
    ) {
      return getDeclarationNameText(current.name);
    }

    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text;
    }

    current = current.parent;
  }

  return undefined;
}

function getSignatureDeclarationMemberName(
  declaration: ts.SignatureDeclarationBase,
): string | undefined {
  return getDeclarationNameText(declaration.name);
}

function getSortMethodNameFromSignatureDeclaration(
  declaration: ts.SignatureDeclarationBase | undefined,
): SortMethodName | undefined {
  if (!declaration || !declaration.getSourceFile().isDeclarationFile) {
    return undefined;
  }

  const ownerName = getSignatureDeclarationOwnerName(declaration);
  const memberName = getSignatureDeclarationMemberName(declaration);
  if (!ownerName || !memberName || !SORT_METHOD_OWNER_NAMES.has(ownerName)) {
    return undefined;
  }

  return memberName === 'sort' || memberName === 'toSorted'
    ? memberName
    : undefined;
}

function getSortMethodNameFromCallExpressionType(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): SortMethodName | undefined {
  const type = checker.getTypeAtLocation(expression);
  for (const signature of type.getCallSignatures()) {
    const methodName = getSortMethodNameFromSignatureDeclaration(signature.getDeclaration());
    if (methodName) {
      return methodName;
    }
  }

  return undefined;
}

function getSortMethodNameFromReference(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): SortMethodName | undefined {
  const methodName = getMemberAccessName(expression);
  const baseExpression = getMemberAccessBaseExpression(expression);
  if (
    baseExpression &&
    (methodName === 'sort' || methodName === 'toSorted') &&
    isArrayLikeSortTarget(checker, baseExpression)
  ) {
    return methodName;
  }

  return getSortMethodNameFromCallExpressionType(checker, expression);
}

function getMemberAccessName(
  expression: ts.Expression,
): string | undefined {
  const unwrapped = unwrapParenthesizedExpression(expression);

  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text;
  }

  if (
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression &&
    (
      ts.isStringLiteral(unwrapped.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(unwrapped.argumentExpression)
    )
  ) {
    return unwrapped.argumentExpression.text;
  }

  return undefined;
}

function getMemberAccessBaseExpression(
  expression: ts.Expression,
): ts.Expression | undefined {
  const unwrapped = unwrapParenthesizedExpression(expression);

  if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
    return unwrapped.expression;
  }

  return undefined;
}

function getConstInitializer(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Expression | undefined {
  const unwrapped = unwrapParenthesizedExpression(expression);
  if (!ts.isIdentifier(unwrapped)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol) {
    return undefined;
  }

  for (const declaration of symbol.getDeclarations() ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      declaration.initializer
    ) {
      return declaration.initializer;
    }
  }

  return undefined;
}

function getBoundSortMethodName(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seenSymbols = new Set<ts.Symbol>(),
): SortMethodName | undefined {
  const unwrapped = unwrapParenthesizedExpression(expression);

  if (ts.isCallExpression(unwrapped)) {
    const wrapperName = getMemberAccessName(unwrapped.expression);
    if (wrapperName !== 'bind' || unwrapped.arguments.length !== 1) {
      return undefined;
    }

    const targetExpression = getMemberAccessBaseExpression(unwrapped.expression);
    const methodName = targetExpression
      ? getSortMethodNameFromReference(checker, targetExpression)
      : undefined;
    return methodName && isArrayLikeSortTarget(checker, unwrapped.arguments[0]!)
      ? methodName
      : undefined;
  }

  if (!ts.isIdentifier(unwrapped)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(unwrapped);
  if (!symbol || seenSymbols.has(symbol)) {
    return undefined;
  }
  seenSymbols.add(symbol);

  const initializer = getConstInitializer(checker, unwrapped);
  return initializer ? getBoundSortMethodName(checker, initializer, seenSymbols) : undefined;
}

function getMachineNumericLeafName(type: ts.Type): string | undefined {
  const aliasName = type.aliasSymbol?.getName();
  return aliasName && MACHINE_NUMERIC_LEAF_NAMES.has(aliasName) ? aliasName : undefined;
}

function getAbstractNumericFamilyName(type: ts.Type): string | undefined {
  const aliasName = type.aliasSymbol?.getName();
  return aliasName && ABSTRACT_NUMERIC_FAMILY_NAMES.has(aliasName) ? aliasName : undefined;
}

function getDeclaredAbstractNumericFamilyName(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): string | undefined {
  const unwrapped = unwrapParenthesizedExpression(expression);
  if (!ts.isIdentifier(unwrapped)) {
    return undefined;
  }

  const symbol = checker.getSymbolAtLocation(unwrapped);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) {
    return undefined;
  }

  if (
    (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
    declaration.type &&
    ts.isTypeReferenceNode(declaration.type) &&
    ts.isIdentifier(declaration.type.typeName) &&
    ABSTRACT_NUMERIC_FAMILY_NAMES.has(declaration.type.typeName.text)
  ) {
    return declaration.type.typeName.text;
  }

  return undefined;
}

function getAbstractNumericFamilyNameForExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): string | undefined {
  return getAbstractNumericFamilyName(checker.getTypeAtLocation(expression)) ??
    getDeclaredAbstractNumericFamilyName(expression, checker);
}

function getNumericArithmeticOperandKind(type: ts.Type): string | undefined {
  const machineLeaf = getMachineNumericLeafName(type);
  if (machineLeaf) {
    return machineLeaf;
  }

  if ((type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0) {
    return 'number';
  }

  if ((type.flags & (ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral)) !== 0) {
    return 'bigint';
  }

  return undefined;
}

function getSameMachineNumericLeafName(
  expression: ts.BinaryExpression,
  checker: ts.TypeChecker,
): string | undefined {
  if (!MACHINE_NUMERIC_BINARY_OPERATOR_KINDS.has(expression.operatorToken.kind)) {
    return undefined;
  }

  const leftLeaf = getMachineNumericLeafName(checker.getTypeAtLocation(expression.left));
  const rightLeaf = getMachineNumericLeafName(checker.getTypeAtLocation(expression.right));
  return leftLeaf && leftLeaf === rightLeaf ? leftLeaf : undefined;
}

function getSameMachineNumericCompoundAssignmentLeafName(
  expression: ts.BinaryExpression,
  checker: ts.TypeChecker,
): string | undefined {
  if (!MACHINE_NUMERIC_COMPOUND_ASSIGNMENT_OPERATOR_KINDS.has(expression.operatorToken.kind)) {
    return undefined;
  }

  const leftLeaf = getMachineNumericLeafName(checker.getTypeAtLocation(expression.left));
  const rightLeaf = getMachineNumericLeafName(checker.getTypeAtLocation(expression.right));
  return leftLeaf && leftLeaf === rightLeaf ? leftLeaf : undefined;
}

function getSameMachineNumericUnaryLeafName(
  expression: ts.PrefixUnaryExpression,
  checker: ts.TypeChecker,
): string | undefined {
  if (!MACHINE_NUMERIC_UNARY_OPERATOR_KINDS.has(expression.operator)) {
    return undefined;
  }

  const leaf = getMachineNumericLeafName(checker.getTypeAtLocation(expression.operand));
  if (!leaf) {
    return undefined;
  }

  if (
    expression.operator === ts.SyntaxKind.PlusToken &&
    (leaf === 'i64' || leaf === 'u64')
  ) {
    return undefined;
  }

  return leaf;
}

function getMachineNumericUpdateLeafName(
  expression: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression,
  checker: ts.TypeChecker,
): string | undefined {
  if (!MACHINE_NUMERIC_UPDATE_OPERATOR_KINDS.has(expression.operator)) {
    return undefined;
  }

  return getMachineNumericLeafName(checker.getTypeAtLocation(expression.operand));
}

function getOperatorText(kind: ts.SyntaxKind): string {
  return ts.tokenToString(kind) ?? ts.SyntaxKind[kind];
}

function createStringLiteralOperator(kind: ts.SyntaxKind): ts.StringLiteral {
  return ts.factory.createStringLiteral(getOperatorText(kind));
}

function createLeafConstructorCall(
  leaf: string,
  expression: ts.Expression,
): ts.Expression {
  const constructorName = MACHINE_NUMERIC_CONSTRUCTOR_BY_LEAF.get(leaf);
  if (!constructorName) {
    throw new Error(`Unsupported machine numeric leaf ${leaf}.`);
  }
  return ts.factory.createCallExpression(
    ts.factory.createIdentifier(constructorName),
    undefined,
    [expression],
  );
}

function createNumericBinaryHelperCall(
  operatorKind: ts.SyntaxKind,
  left: ts.Expression,
  right: ts.Expression,
  leaf: string,
  loweringTarget: NumericLoweringTarget,
): ts.Expression {
  const helperCall = ts.factory.createCallExpression(
    ts.factory.createIdentifier(MACHINE_NUMERIC_BINARY_HELPER),
    undefined,
    [createStringLiteralOperator(operatorKind), left, right],
  );
  if (loweringTarget === 'wasm') {
    return ts.factory.createCallExpression(
      ts.factory.createIdentifier(MACHINE_NUMERIC_WASM_LEAF_HELPER),
      [ts.factory.createTypeReferenceNode(leaf)],
      [helperCall],
    );
  }
  return helperCall;
}

function createNumericUnaryHelperCall(
  operatorKind: ts.SyntaxKind,
  operand: ts.Expression,
  leaf: string,
  loweringTarget: NumericLoweringTarget,
): ts.Expression {
  const helperCall = ts.factory.createCallExpression(
    ts.factory.createIdentifier(MACHINE_NUMERIC_UNARY_HELPER),
    undefined,
    [createStringLiteralOperator(operatorKind), operand],
  );
  if (loweringTarget === 'wasm') {
    return ts.factory.createCallExpression(
      ts.factory.createIdentifier(MACHINE_NUMERIC_WASM_LEAF_HELPER),
      [ts.factory.createTypeReferenceNode(leaf)],
      [helperCall],
    );
  }
  return helperCall;
}

function createMachineNumericUnitLiteralExpression(leaf: string): ts.Expression {
  if (leaf === 'i64' || leaf === 'u64') {
    return createLeafConstructorCall(leaf, ts.factory.createBigIntLiteral('1n'));
  }
  return createLeafConstructorCall(leaf, ts.factory.createNumericLiteral('1'));
}

function getMachineNumericAssignmentTarget(
  expression: ts.Expression,
): MachineNumericAssignmentTarget | undefined {
  const unwrapped = unwrapParenthesizedExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return { kind: 'identifier', target: unwrapped };
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return {
      kind: 'property',
      base: unwrapped.expression,
      name: unwrapped.name,
    };
  }
  if (ts.isElementAccessExpression(unwrapped) && unwrapped.argumentExpression) {
    return {
      kind: 'element',
      base: unwrapped.expression,
      argument: unwrapped.argumentExpression,
    };
  }
  return undefined;
}

function createConstBinding(
  name: ts.Identifier,
  initializer: ts.Expression,
): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [ts.factory.createVariableDeclaration(name, undefined, undefined, initializer)],
      ts.NodeFlags.Const,
    ),
  );
}

function createIifeExpression(
  statements: readonly ts.Statement[],
  result: ts.Expression,
): ts.Expression {
  return ts.factory.createCallExpression(
    ts.factory.createParenthesizedExpression(
      ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        ts.factory.createBlock(
          [...statements, ts.factory.createReturnStatement(result)],
          true,
        ),
      ),
    ),
    undefined,
    [],
  );
}

function createMachineNumericReadExpression(
  target: MachineNumericAssignmentTarget,
  refs?: {
    baseTemp?: ts.Identifier;
    keyTemp?: ts.Identifier;
  },
): ts.Expression {
  switch (target.kind) {
    case 'identifier':
      return target.target;
    case 'property':
      return ts.factory.createPropertyAccessExpression(refs?.baseTemp ?? target.base, target.name);
    case 'element':
      return ts.factory.createElementAccessExpression(
        refs?.baseTemp ?? target.base,
        refs?.keyTemp ?? target.argument,
      );
  }
}

function createMachineNumericWriteExpression(
  target: MachineNumericAssignmentTarget,
  value: ts.Expression,
  refs?: {
    baseTemp?: ts.Identifier;
    keyTemp?: ts.Identifier;
  },
): ts.Expression {
  return ts.factory.createBinaryExpression(
    createMachineNumericReadExpression(target, refs),
    ts.factory.createToken(ts.SyntaxKind.EqualsToken),
    value,
  );
}

function createMachineNumericCompoundAssignmentRewrite(
  target: MachineNumericAssignmentTarget,
  right: ts.Expression,
  binaryOperatorKind: ts.SyntaxKind,
  leaf: string,
  loweringTarget: NumericLoweringTarget,
): ts.Expression {
  if (target.kind === 'identifier') {
    return createMachineNumericWriteExpression(
      target,
      createNumericBinaryHelperCall(
        binaryOperatorKind,
        createMachineNumericReadExpression(target),
        right,
        leaf,
        loweringTarget,
      ),
    );
  }

  const baseTemp = ts.factory.createUniqueName('__sts_numeric_target');
  const statements: ts.Statement[] = [createConstBinding(baseTemp, target.base)];
  const refs: {
    baseTemp?: ts.Identifier;
    keyTemp?: ts.Identifier;
  } = { baseTemp };

  if (target.kind === 'element') {
    refs.keyTemp = ts.factory.createUniqueName('__sts_numeric_key');
    statements.push(createConstBinding(refs.keyTemp, target.argument));
  }

  return createIifeExpression(
    statements,
    createMachineNumericWriteExpression(
      target,
      createNumericBinaryHelperCall(
        binaryOperatorKind,
        createMachineNumericReadExpression(target, refs),
        right,
        leaf,
        loweringTarget,
      ),
      refs,
    ),
  );
}

function createMachineNumericUpdateRewrite(
  target: MachineNumericAssignmentTarget,
  binaryOperatorKind: ts.SyntaxKind,
  leaf: string,
  loweringTarget: NumericLoweringTarget,
  postfix: boolean,
): ts.Expression {
  const delta = createMachineNumericUnitLiteralExpression(leaf);

  if (target.kind === 'identifier' && !postfix) {
    return createMachineNumericWriteExpression(
      target,
      createNumericBinaryHelperCall(
        binaryOperatorKind,
        createMachineNumericReadExpression(target),
        delta,
        leaf,
        loweringTarget,
      ),
    );
  }

  const statements: ts.Statement[] = [];
  const refs: {
    baseTemp?: ts.Identifier;
    keyTemp?: ts.Identifier;
  } = {};

  if (target.kind === 'property' || target.kind === 'element') {
    refs.baseTemp = ts.factory.createUniqueName('__sts_numeric_target');
    statements.push(createConstBinding(refs.baseTemp, target.base));
  }

  if (target.kind === 'element') {
    refs.keyTemp = ts.factory.createUniqueName('__sts_numeric_key');
    statements.push(createConstBinding(refs.keyTemp, target.argument));
  }

  if (postfix) {
    const oldTemp = ts.factory.createUniqueName('__sts_numeric_old');
    statements.push(createConstBinding(oldTemp, createMachineNumericReadExpression(target, refs)));
    statements.push(
      ts.factory.createExpressionStatement(
        createMachineNumericWriteExpression(
          target,
          createNumericBinaryHelperCall(
            binaryOperatorKind,
            createMachineNumericReadExpression(target, refs),
            delta,
            leaf,
            loweringTarget,
          ),
          refs,
        ),
      ),
    );
    return createIifeExpression(statements, oldTemp);
  }

  return createIifeExpression(
    statements,
    createMachineNumericWriteExpression(
      target,
      createNumericBinaryHelperCall(
        binaryOperatorKind,
        createMachineNumericReadExpression(target, refs),
        delta,
        leaf,
        loweringTarget,
      ),
      refs,
    ),
  );
}

function getLeafNameFromTypeNode(typeNode: ts.TypeNode | undefined): string | undefined {
  return typeNode &&
      ts.isTypeReferenceNode(typeNode) &&
      ts.isIdentifier(typeNode.typeName) &&
      MACHINE_NUMERIC_LEAF_NAMES.has(typeNode.typeName.text)
    ? typeNode.typeName.text
    : undefined;
}

function getLeafNameFromTupleElementTypeNode(
  typeNode: ts.TypeNode | undefined,
): string | undefined {
  if (!typeNode) {
    return undefined;
  }
  if (ts.isOptionalTypeNode(typeNode) || ts.isRestTypeNode(typeNode)) {
    return getLeafNameFromTupleElementTypeNode(typeNode.type);
  }
  return getLeafNameFromTypeNode(typeNode);
}

function getExplicitLeafNameForBindingElement(node: ts.BindingElement): string | undefined {
  const parentPattern = node.parent;
  if (!ts.isObjectBindingPattern(parentPattern) && !ts.isArrayBindingPattern(parentPattern)) {
    return undefined;
  }

  const patternType = (
    ts.isVariableDeclaration(parentPattern.parent) ||
      ts.isParameter(parentPattern.parent)
  )
    ? parentPattern.parent.type
    : undefined;

  if (!patternType) {
    return undefined;
  }

  if (ts.isArrayBindingPattern(parentPattern)) {
    const index = parentPattern.elements.indexOf(node);
    if (index < 0) {
      return undefined;
    }

    if (ts.isArrayTypeNode(patternType)) {
      return getLeafNameFromTypeNode(patternType.elementType);
    }
    if (ts.isTupleTypeNode(patternType)) {
      return getLeafNameFromTupleElementTypeNode(patternType.elements[index]);
    }
    return undefined;
  }

  if (!ts.isTypeLiteralNode(patternType)) {
    return undefined;
  }

  const propertyName = node.propertyName ?? node.name;
  if (!ts.isIdentifier(propertyName) && !ts.isStringLiteral(propertyName)) {
    return undefined;
  }

  const propertyText = propertyName.text;
  for (const member of patternType.members) {
    if (!ts.isPropertySignature(member) || !member.type || !member.name) {
      continue;
    }
    const memberName = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
      ? member.name.text
      : undefined;
    if (memberName === propertyText) {
      return getLeafNameFromTypeNode(member.type);
    }
  }

  return undefined;
}

type ParsedLiteral =
  | { kind: 'bigint'; value: bigint }
  | { kind: 'number'; text: string; value: number };

function parseContextualLiteral(expression: ts.Expression): ParsedLiteral | undefined {
  const unwrapped = unwrapParenthesizedExpression(expression);
  if (ts.isNumericLiteral(unwrapped)) {
    return { kind: 'number', text: unwrapped.text, value: Number(unwrapped.text) };
  }
  if (ts.isBigIntLiteral(unwrapped)) {
    return { kind: 'bigint', value: BigInt(unwrapped.text.slice(0, -1)) };
  }
  if (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(unwrapped.operand)
  ) {
    const text = `-${unwrapped.operand.text}`;
    return { kind: 'number', text, value: Number(text) };
  }
  if (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.MinusToken &&
    ts.isBigIntLiteral(unwrapped.operand)
  ) {
    return { kind: 'bigint', value: -BigInt(unwrapped.operand.text.slice(0, -1)) };
  }
  return undefined;
}

function literalFitsLeaf(literal: ParsedLiteral, leaf: string): boolean {
  switch (leaf) {
    case 'f64':
      return literal.kind === 'number';
    case 'f32':
      return literal.kind === 'number';
    case 'i8':
      return literal.kind === 'number' && Number.isInteger(literal.value) && literal.value >= -128 && literal.value <= 127;
    case 'i16':
      return literal.kind === 'number' && Number.isInteger(literal.value) && literal.value >= -32768 && literal.value <= 32767;
    case 'i32':
      return literal.kind === 'number' && Number.isInteger(literal.value) &&
        literal.value >= -2147483648 && literal.value <= 2147483647;
    case 'i64':
      if (literal.kind === 'bigint') {
        return BigInt.asIntN(64, literal.value) === literal.value;
      }
      return literal.kind === 'number' && Number.isInteger(literal.value) &&
        BigInt.asIntN(64, BigInt(literal.value)) === BigInt(literal.value);
    case 'u8':
      return literal.kind === 'number' && Number.isInteger(literal.value) && literal.value >= 0 && literal.value <= 255;
    case 'u16':
      return literal.kind === 'number' && Number.isInteger(literal.value) && literal.value >= 0 && literal.value <= 65535;
    case 'u32':
      return literal.kind === 'number' && Number.isInteger(literal.value) && literal.value >= 0 && literal.value <= 4294967295;
    case 'u64':
      if (literal.kind === 'bigint') {
        return literal.value >= 0n && BigInt.asUintN(64, literal.value) === literal.value;
      }
      return literal.kind === 'number' && Number.isInteger(literal.value) && literal.value >= 0 &&
        BigInt.asUintN(64, BigInt(literal.value)) === BigInt(literal.value);
    default:
      return false;
  }
}

function createContextualLeafLiteralRewrite(
  leaf: string,
  expression: ts.Expression,
): ts.Expression | undefined {
  const literal = parseContextualLiteral(expression);
  if (!literal || !literalFitsLeaf(literal, leaf)) {
    return undefined;
  }
  return createLeafConstructorCall(leaf, expression);
}

function createContextualLeafLiteralRewriteFromContext(
  originalExpression: ts.Expression,
  rewrittenExpression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const contextualType = checker.getContextualType(originalExpression);
  const leaf = contextualType ? getMachineNumericLeafName(contextualType) : undefined;
  return leaf ? createContextualLeafLiteralRewrite(leaf, rewrittenExpression) : undefined;
}

function isArrayLikeSortTarget(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): boolean {
  const type = checker.getTypeAtLocation(expression);
  const typeChecker = checker as unknown as {
    isArrayLikeType?: (type: ts.Type) => boolean;
  };
  if (typeChecker.isArrayLikeType?.(type)) {
    return true;
  }

  const symbolName = type.getSymbol()?.getName();
  return symbolName !== undefined && (
    symbolName === 'Array' ||
    symbolName === 'ReadonlyArray' ||
    symbolName.endsWith('Array')
  );
}

function normalizeSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  loweringTarget: NumericLoweringTarget,
): NumericNormalizedFile | undefined {
  let changed = false;

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isBindingElement(node)) {
        const initializer = node.initializer
          ? ts.visitNode(node.initializer, visit) as ts.Expression
          : undefined;
        const bindingLeaf = getExplicitLeafNameForBindingElement(node) ??
          getMachineNumericLeafName(checker.getTypeAtLocation(node.name));
        const literalRewrite = bindingLeaf && initializer
          ? createContextualLeafLiteralRewrite(bindingLeaf, initializer)
          : undefined;
        if (literalRewrite) {
          changed = true;
          return ts.factory.updateBindingElement(
            node,
            node.dotDotDotToken,
            node.propertyName,
            node.name,
            literalRewrite,
          );
        }
        if (initializer !== node.initializer) {
          changed = true;
          return ts.factory.updateBindingElement(
            node,
            node.dotDotDotToken,
            node.propertyName,
            node.name,
            initializer,
          );
        }
        return node;
      }

      if (ts.isVariableDeclaration(node)) {
        const name = ts.visitNode(node.name, visit) as ts.BindingName;
        const initializer = node.initializer
          ? ts.visitNode(node.initializer, visit) as ts.Expression
          : undefined;
        if (name !== node.name || initializer !== node.initializer) {
          changed = true;
          return ts.factory.updateVariableDeclaration(
            node,
            name,
            node.exclamationToken,
            node.type,
            initializer,
          );
        }
        return node;
      }

      if (ts.isBinaryExpression(node)) {
        const left = ts.visitNode(node.left, visit) as ts.Expression;
        const right = ts.visitNode(node.right, visit) as ts.Expression;
        const updated = left === node.left && right === node.right
          ? node
          : ts.factory.updateBinaryExpression(node, left, node.operatorToken, right);

        const compoundLeaf = getSameMachineNumericCompoundAssignmentLeafName(updated, checker);
        if (compoundLeaf) {
          const binaryOperatorKind = MACHINE_NUMERIC_COMPOUND_ASSIGNMENT_OPERATOR_KINDS.get(
            node.operatorToken.kind,
          );
          const target = getMachineNumericAssignmentTarget(left);
          if (binaryOperatorKind && target) {
            changed = true;
            return createMachineNumericCompoundAssignmentRewrite(
              target,
              right,
              binaryOperatorKind,
              compoundLeaf,
              loweringTarget,
            );
          }
        }

        const sameLeaf = getSameMachineNumericLeafName(updated, checker);
        if (!sameLeaf) {
          return updated;
        }

        changed = true;
        return createNumericBinaryHelperCall(
          updated.operatorToken.kind,
          left,
          right,
          sameLeaf,
          loweringTarget,
        );
      }

      if (ts.isPrefixUnaryExpression(node)) {
        const updateLeaf = getMachineNumericUpdateLeafName(node, checker);
        if (updateLeaf) {
          const operand = ts.visitNode(node.operand, visit) as ts.Expression;
          const target = getMachineNumericAssignmentTarget(operand);
          const binaryOperatorKind = MACHINE_NUMERIC_UPDATE_OPERATOR_KINDS.get(node.operator);
          if (target && binaryOperatorKind) {
            changed = true;
            return createMachineNumericUpdateRewrite(
              target,
              binaryOperatorKind,
              updateLeaf,
              loweringTarget,
              false,
            );
          }
        }

        const operand = ts.visitNode(node.operand, visit) as ts.Expression;
        const updated = operand === node.operand
          ? node
          : ts.factory.updatePrefixUnaryExpression(node, operand);
        const sameLeaf = getSameMachineNumericUnaryLeafName(updated, checker);
        if (!sameLeaf) {
          const literalRewrite = createContextualLeafLiteralRewriteFromContext(
            node,
            updated,
            checker,
          );
          if (literalRewrite) {
            changed = true;
            return literalRewrite;
          }
          return updated;
        }

        changed = true;
        return createNumericUnaryHelperCall(
          updated.operator,
          operand,
          sameLeaf,
          loweringTarget,
        );
      }

      if (ts.isPostfixUnaryExpression(node)) {
        const updateLeaf = getMachineNumericUpdateLeafName(node, checker);
        if (!updateLeaf) {
          return node;
        }

        const operand = ts.visitNode(node.operand, visit) as ts.Expression;
        const target = getMachineNumericAssignmentTarget(operand);
        const binaryOperatorKind = MACHINE_NUMERIC_UPDATE_OPERATOR_KINDS.get(node.operator);
        if (!target || !binaryOperatorKind) {
          return operand === node.operand ? node : ts.factory.updatePostfixUnaryExpression(node, operand);
        }

        changed = true;
        return createMachineNumericUpdateRewrite(
          target,
          binaryOperatorKind,
          updateLeaf,
          loweringTarget,
          true,
        );
      }

      const visitedNode = ts.visitEachChild(node, visit, context);
      if (ts.isExpression(node) && ts.isExpression(visitedNode)) {
        const literalRewrite = createContextualLeafLiteralRewriteFromContext(
          node,
          visitedNode,
          checker,
        );
        if (literalRewrite) {
          changed = true;
          return literalRewrite;
        }
      }

      return visitedNode;
    };

    return (node) => ts.visitNode(node, visit) as ts.SourceFile;
  };

  const result = ts.transform(sourceFile, [transformer]);
  const [transformed] = result.transformed;
  result.dispose();
  if (!changed || !transformed) {
    return undefined;
  }

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const rewrittenText = repairBuiltinMacroModuleSpecifiers(printer.printFile(transformed));
  return {
    rewriteStage: buildRewriteStageFromTexts(
      sourceFile.fileName,
      sourceFile.text,
      rewrittenText,
    ),
    sourceFile: ts.createSourceFile(
      sourceFile.fileName,
      rewrittenText,
      sourceFile.languageVersion,
      true,
    ),
  };
}

export function normalizeMachineNumericSemanticsInProgram(
  program: ts.Program,
  loweringTarget: NumericLoweringTarget = 'js',
): NumericNormalizedProgramResult {
  const checker = program.getTypeChecker();
  const changedFiles = new Map<string, NumericNormalizedFile>();

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      !isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))
    ) {
      continue;
    }

    const normalized = normalizeSourceFile(sourceFile, checker, loweringTarget);
    if (normalized) {
      changedFiles.set(sourceFile.fileName, normalized);
    }
  }

  return { changedFiles };
}

export function collectMixedMachineNumericArithmeticInProgram(
  program: ts.Program,
): readonly MixedMachineNumericArithmetic[] {
  const checker = program.getTypeChecker();
  const mixedArithmetic: MixedMachineNumericArithmetic[] = [];

  function visit(sourceFile: ts.SourceFile, node: ts.Node) {
    if (
      ts.isBinaryExpression(node) &&
      (
        MACHINE_NUMERIC_BINARY_OPERATOR_KINDS.has(node.operatorToken.kind) ||
        MACHINE_NUMERIC_COMPOUND_ASSIGNMENT_OPERATOR_KINDS.has(node.operatorToken.kind)
      )
    ) {
      const leftLeaf = getNumericArithmeticOperandKind(checker.getTypeAtLocation(node.left));
      const rightLeaf = getNumericArithmeticOperandKind(checker.getTypeAtLocation(node.right));
      if (leftLeaf && rightLeaf && leftLeaf !== rightLeaf) {
        mixedArithmetic.push({
          end: node.getEnd(),
          expressionText: node.getText(sourceFile),
          fileName: sourceFile.fileName,
          leftLeaf,
          operatorText: node.operatorToken.getText(sourceFile),
          rightLeaf,
          start: node.getStart(sourceFile),
        });
      }
    }

    ts.forEachChild(node, (child) => visit(sourceFile, child));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      !isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))
    ) {
      continue;
    }

    visit(sourceFile, sourceFile);
  }

  return mixedArithmetic;
}

export function collectAbstractNumericFamilyArithmeticInProgram(
  program: ts.Program,
): readonly AbstractNumericFamilyArithmetic[] {
  const checker = program.getTypeChecker();
  const abstractArithmetic: AbstractNumericFamilyArithmetic[] = [];

  function pushAbstractArithmetic(
    sourceFile: ts.SourceFile,
    node: ts.Node,
    operandExpression: ts.Expression,
    operatorText: string,
  ) {
    const abstractFamily = getAbstractNumericFamilyNameForExpression(operandExpression, checker);
    if (!abstractFamily) {
      return;
    }

    abstractArithmetic.push({
      abstractFamilies: [abstractFamily],
      end: node.getEnd(),
      expressionText: node.getText(sourceFile),
      fileName: sourceFile.fileName,
      operatorText,
      start: node.getStart(sourceFile),
    });
  }

  function visit(sourceFile: ts.SourceFile, node: ts.Node) {
    if (
      ts.isBinaryExpression(node) &&
      (
        MACHINE_NUMERIC_BINARY_OPERATOR_KINDS.has(node.operatorToken.kind) ||
        MACHINE_NUMERIC_COMPOUND_ASSIGNMENT_OPERATOR_KINDS.has(node.operatorToken.kind)
      )
    ) {
      const abstractFamilies = [
        getAbstractNumericFamilyNameForExpression(node.left, checker),
        getAbstractNumericFamilyNameForExpression(node.right, checker),
      ].filter((name): name is string => name !== undefined);
      if (abstractFamilies.length > 0) {
        abstractArithmetic.push({
          abstractFamilies: [...new Set(abstractFamilies)].sort(),
          end: node.getEnd(),
          expressionText: node.getText(sourceFile),
          fileName: sourceFile.fileName,
          operatorText: node.operatorToken.getText(sourceFile),
          start: node.getStart(sourceFile),
        });
      }
    }

    if (
      ts.isPrefixUnaryExpression(node) &&
      (
        MACHINE_NUMERIC_UNARY_OPERATOR_KINDS.has(node.operator) ||
        MACHINE_NUMERIC_UPDATE_OPERATOR_KINDS.has(node.operator)
      )
    ) {
      pushAbstractArithmetic(sourceFile, node, node.operand, getOperatorText(node.operator));
    }

    if (
      ts.isPostfixUnaryExpression(node) &&
      MACHINE_NUMERIC_UPDATE_OPERATOR_KINDS.has(node.operator)
    ) {
      pushAbstractArithmetic(sourceFile, node, node.operand, getOperatorText(node.operator));
    }

    ts.forEachChild(node, (child) => visit(sourceFile, child));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      !isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))
    ) {
      continue;
    }

    visit(sourceFile, sourceFile);
  }

  return abstractArithmetic;
}

export function collectSortCallsWithoutComparatorInProgram(
  program: ts.Program,
): readonly SortCallWithoutComparator[] {
  const checker = program.getTypeChecker();
  const diagnostics: SortCallWithoutComparator[] = [];

  function addDiagnostic(
    sourceFile: ts.SourceFile,
    node: ts.CallExpression,
    methodName: SortMethodName,
  ): void {
    diagnostics.push({
      end: node.getEnd(),
      expressionText: node.getText(sourceFile),
      fileName: sourceFile.fileName,
      methodName,
      start: node.getStart(sourceFile),
    });
  }

  function visit(sourceFile: ts.SourceFile, node: ts.Node) {
    if (ts.isCallExpression(node)) {
      if (node.arguments.length === 0) {
        const directMethodName = getMemberAccessName(node.expression);
        const directTarget = getMemberAccessBaseExpression(node.expression);
        if (
          directTarget &&
          (directMethodName === 'sort' || directMethodName === 'toSorted') &&
          isArrayLikeSortTarget(checker, directTarget)
        ) {
          addDiagnostic(sourceFile, node, directMethodName);
        } else {
          const boundMethodName = getBoundSortMethodName(checker, node.expression);
          if (boundMethodName) {
            addDiagnostic(sourceFile, node, boundMethodName);
          }
        }
      } else {
        const wrapperName = getMemberAccessName(node.expression);
        const wrapperTarget = getMemberAccessBaseExpression(node.expression);
        const methodName = wrapperTarget
          ? getSortMethodNameFromReference(checker, wrapperTarget)
          : undefined;
        if (
          methodName &&
          node.arguments[0] &&
          isArrayLikeSortTarget(checker, node.arguments[0]) &&
          (
            (wrapperName === 'call' && node.arguments.length === 1) ||
            (wrapperName === 'apply' && node.arguments.length === 1)
          )
        ) {
          addDiagnostic(sourceFile, node, methodName);
        }
      }
    }

    ts.forEachChild(node, (child) => visit(sourceFile, child));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      !isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))
    ) {
      continue;
    }

    visit(sourceFile, sourceFile);
  }

  return diagnostics;
}
