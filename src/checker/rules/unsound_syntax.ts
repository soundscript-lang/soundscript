import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';
import {
  createAnyTypeDiagnostic,
  createDefiniteAssignmentAssertionDiagnostic,
  createNonNullAssertionDiagnostic,
  createTypeAssertionDiagnostic,
} from '../proof_escape_hatch_diagnostics.ts';
import {
  describeUnsupportedFeature,
  type UnsupportedFeatureDiagnosticText,
  type UnsupportedFeatureKind,
} from '../unsupported_feature_messages.ts';
import { isForeignSourceFile } from '../../soundscript_packages.ts';

import {
  getResolvedBuiltinSignatureInfo,
  getWrappedBuiltinInvocation,
  matchesResolvedBuiltinCallableValue,
  matchesResolvedBuiltinSignature,
  resolvesToBuiltinGlobalValue,
  type WrappedBuiltinInvocation,
} from './resolved_builtins.ts';
import { isInsideSyntheticErrorNormalizationHelper } from './generated_helpers.ts';
import { getLocalUnsafeProofOverrideChainRoot, isLocallyUnsafe } from './trust.ts';

const LEGACY_ACCESSOR_MEMBER_NAMES = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

const LEGACY_FUNCTION_MEMBER_NAMES = new Set([
  'arguments',
  'caller',
]);

const BANNED_SYMBOL_HOOK_MEMBER_NAMES = new Set([
  'asyncIterator',
  'hasInstance',
  'iterator',
  'match',
  'replace',
  'search',
  'species',
  'split',
  'toPrimitive',
  'toStringTag',
]);

const ALWAYS_BANNED_DECLARATION_FILE_TYPE_NAMES = new Set([
  'String',
  'Number',
  'Boolean',
  'CallableFunction',
  'NewableFunction',
  'PromiseLike',
  'PromiseConstructorLike',
  'WeakRef',
  'FinalizationRegistry',
  'Iterator',
  'Iterable',
  'IterableIterator',
  'IteratorObject',
  'AsyncIterator',
  'AsyncIterable',
  'AsyncIterableIterator',
  'AsyncIteratorObject',
]);

const CONDITIONALLY_BANNED_DECLARATION_FILE_TYPE_NAMES = new Set([
  'WeakMap',
  'WeakSet',
]);

const PRIMITIVE_CONVERSION_HOOK_MEMBER_NAMES = new Set([
  'toString',
  'valueOf',
]);

function isAnyType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

function isUnknownType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Unknown) !== 0;
}

function isAnyOrUnknownType(type: ts.Type): boolean {
  return isAnyType(type) || isUnknownType(type);
}

function isUnsafeBridgeCast(context: AnalysisContext, node: ts.AsExpression): boolean {
  const sourceType = context.checker.getTypeAtLocation(node.expression);
  const targetType = context.checker.getTypeAtLocation(node.type);
  return isAnyOrUnknownType(sourceType) && !isAnyOrUnknownType(targetType);
}

function createDiagnostic(
  node: ts.Node,
  code:
    | typeof SOUND_DIAGNOSTIC_CODES.anyType
    | typeof SOUND_DIAGNOSTIC_CODES.ambientRuntimeDeclarationRequiresExtern
    | typeof SOUND_DIAGNOSTIC_CODES.exportedAmbientRuntimeDeclaration
    | typeof SOUND_DIAGNOSTIC_CODES.nullPrototypeObjectCreation
    | typeof SOUND_DIAGNOSTIC_CODES.nonNullAssertion
    | typeof SOUND_DIAGNOSTIC_CODES.throwNonError
    | typeof SOUND_DIAGNOSTIC_CODES.typeAssertion
    | typeof SOUND_DIAGNOSTIC_CODES.unsupportedJavaScriptFeature,
  message: string,
  options?: {
    hint?: string;
    metadata?: SoundDiagnostic['metadata'];
    notes?: string[];
  },
): SoundDiagnostic {
  return {
    source: 'sound',
    code,
    category: 'error',
    message,
    metadata: options?.metadata,
    notes: options?.notes,
    hint: options?.hint,
    ...getNodeDiagnosticRange(node),
  };
}

interface UnsupportedFeatureDiagnostic extends UnsupportedFeatureDiagnosticText {
  node: ts.Node;
}

interface AmbientRuntimeExportDiagnostic {
  declarationNode: AmbientRuntimeDeclarationNode;
  diagnosticNode: ts.Node;
  exportForm: 'direct export' | 'local re-export' | 'default export alias';
}

function unsupportedFeature(
  node: ts.Node,
  kind: UnsupportedFeatureKind,
  options?: {
    name?: string;
  },
): UnsupportedFeatureDiagnostic {
  return {
    node,
    ...describeUnsupportedFeature(kind, options),
  };
}

function createThrowNonErrorDiagnostic(
  context: AnalysisContext,
  expression: ts.Expression,
): SoundDiagnostic {
  const thrownType = context.checker.typeToString(context.checker.getTypeAtLocation(expression));
  const example =
    'Write `throw new Error(String(problem));` or throw a concrete `Error` subclass instead.';

  return createDiagnostic(
    expression,
    SOUND_DIAGNOSTIC_CODES.throwNonError,
    SOUND_DIAGNOSTIC_MESSAGES.throwNonError,
    {
      metadata: {
        rule: 'throw_non_error',
        fixability: 'local_rewrite',
        invariant:
          'Thrown values must be real `Error` objects so downstream code can rely on the standard `Error` surface.',
        replacementFamily: 'error_object_construction',
        evidence: [{ label: 'thrownType', value: thrownType }],
        counterexample:
          'Throwing a bare value drops the `Error` surface that downstream code relies on for `message`, `name`, stack, and cause information.',
        example,
      },
      notes: [
        `The thrown value has type '${thrownType}', but soundscript only permits \`Error\`-family throws.`,
        `Example: ${example}`,
      ],
      hint:
        'Wrap the payload in `Error` or a concrete `Error` subclass before throwing.',
    },
  );
}

function createNullPrototypeObjectCreationDiagnostic(
  expression: ts.Expression,
  apiName: string,
): SoundDiagnostic {
  const example =
    'Use `Object.create(null)` and keep the value as `BareObject`, or use an ordinary object or `Map` if you want normal object behavior.';

  return createDiagnostic(
    expression,
    SOUND_DIAGNOSTIC_CODES.nullPrototypeObjectCreation,
    SOUND_DIAGNOSTIC_MESSAGES.nullPrototypeObjectCreation,
    {
      metadata: {
        rule: 'null_prototype_object_creation',
        fixability: 'local_rewrite',
        invariant:
          'Null-prototype values must flow through the explicit `BareObject` construction path instead of being created by prototype mutation.',
        replacementFamily: 'bare_object_or_map',
        evidence: [{ label: 'api', value: apiName }],
        counterexample:
          'Prototype surgery can create null-prototype objects after allocation, which breaks the ordinary object assumptions soundscript relies on.',
        example,
      },
      notes: [
        'This call creates a null-prototype object through prototype mutation instead of through the explicit `BareObject` path.',
        `Example: ${example}`,
      ],
      hint:
        'Use `Object.create(null)` with `BareObject`, or use an ordinary object or `Map` instead of prototype surgery.',
    },
  );
}

function getAmbientRuntimeDeclarationInfo(
  node: AmbientRuntimeDeclarationNode,
): { kind: string; name?: string } {
  if (ts.isVariableStatement(node)) {
    const firstDeclaration = node.declarationList.declarations[0];
    return {
      kind: 'const declaration',
      name: firstDeclaration && ts.isIdentifier(firstDeclaration.name) ? firstDeclaration.name.text : undefined,
    };
  }

  if (ts.isFunctionDeclaration(node)) {
    return { kind: 'function declaration', name: node.name?.text };
  }

  return { kind: 'class declaration', name: node.name?.text };
}

function createAmbientRuntimeRequiresExternDiagnostic(
  declarationNode: AmbientRuntimeDeclarationNode,
): SoundDiagnostic {
  const diagnosticNode = getAmbientRuntimeDeclarationDiagnosticNode(declarationNode);
  const info = getAmbientRuntimeDeclarationInfo(declarationNode);
  const example =
    'Add `// #[extern]` immediately above the declaration, or replace the declaration with a real implementation.';

  return createDiagnostic(
    diagnosticNode,
    SOUND_DIAGNOSTIC_CODES.ambientRuntimeDeclarationRequiresExtern,
    SOUND_DIAGNOSTIC_MESSAGES.ambientRuntimeDeclarationRequiresExtern,
    {
      metadata: {
        rule: 'ambient_runtime_requires_extern',
        primarySymbol: info.name,
        fixability: 'boundary_annotation',
        invariant:
          'Declaration-only runtime names in `.sts` files must be marked as explicit extern boundaries instead of looking like ordinary checked implementations.',
        replacementFamily: 'site_local_extern_boundary',
        evidence: [
          { label: 'declarationKind', value: info.kind },
          ...(info.name ? [{ label: 'declarationName', value: info.name }] : []),
        ],
        counterexample:
          'Without `#[extern]`, a declaration-only runtime name looks like ordinary checked soundscript even though there is no local implementation.',
        example,
      },
      notes: [
        `This local ambient runtime declaration introduces \`${info.name ?? 'this name'}\` without a site-local extern boundary.`,
        `Example: ${example}`,
      ],
      hint:
        "Use '// #[extern]' only for local runtime-provided declarations, or replace the declaration with a real implementation.",
    },
  );
}

function createAmbientRuntimeExportDiagnostic(
  info: AmbientRuntimeExportDiagnostic,
): SoundDiagnostic {
  const declarationInfo = getAmbientRuntimeDeclarationInfo(info.declarationNode);
  const example =
    "Move the declaration to '.d.ts', keep it local with `// #[extern]`, or replace it with a real implementation.";

  return createDiagnostic(
    info.diagnosticNode,
    SOUND_DIAGNOSTIC_CODES.exportedAmbientRuntimeDeclaration,
    SOUND_DIAGNOSTIC_MESSAGES.exportedAmbientRuntimeDeclaration,
    {
      metadata: {
        rule: 'ambient_runtime_export_forbidden',
        primarySymbol: declarationInfo.name,
        fixability: 'api_redesign',
        invariant:
          'Declaration-only runtime names may stay local extern boundaries, but they may not become exported checked module surfaces without implementations.',
        replacementFamily: 'ambient_surface_split_or_real_implementation',
        evidence: [
          { label: 'declarationKind', value: declarationInfo.kind },
          ...(declarationInfo.name ? [{ label: 'declarationName', value: declarationInfo.name }] : []),
          { label: 'exportForm', value: info.exportForm },
        ],
        counterexample:
          'An exported declaration-only runtime name creates a module API without a local implementation, so downstream code would treat a nonexistent checked value as real.',
        example,
      },
      notes: [
        `This ambient runtime declaration exports \`${declarationInfo.name ?? 'this name'}\` from a soundscript module even though there is no local implementation.`,
        `Example: ${example}`,
      ],
      hint:
        "Keep declaration-only runtime names local with '// #[extern]', move exported declaration-only surfaces to '.d.ts', or provide a real implementation.",
    },
  );
}

function getNullPrototypeObjectCreationDiagnostic(
  context: AnalysisContext,
  node: ts.Node,
): SoundDiagnostic | undefined {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }

  const wrappedInvocation = getWrappedBuiltinInvocation(node);
  if (
    wrappedInvocation &&
    matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
      ownerNames: ['ObjectConstructor', 'Reflect'],
      memberNames: ['setPrototypeOf'],
    })
  ) {
    const prototypeArgument = getWrappedInvocationArgument(node, wrappedInvocation, 1);
    if (prototypeArgument && isDefinitelyNullExpression(context, prototypeArgument)) {
      const ownerName = matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['Reflect'],
          memberNames: ['setPrototypeOf'],
        })
        ? 'Reflect.setPrototypeOf'
        : 'Object.setPrototypeOf';
      return createNullPrototypeObjectCreationDiagnostic(node.expression, ownerName);
    }
  }

  if (
    matchesResolvedBuiltinSignature(context, node, {
      ownerNames: ['ObjectConstructor', 'Reflect'],
      memberNames: ['setPrototypeOf'],
    }) ||
    matchesResolvedBuiltinCallableValue(context, node.expression, {
      ownerNames: ['ObjectConstructor', 'Reflect'],
      memberNames: ['setPrototypeOf'],
    })
  ) {
    const prototypeArgument = node.arguments[1];
    if (prototypeArgument && isDefinitelyNullExpression(context, prototypeArgument)) {
      const ownerName = matchesResolvedBuiltinSignature(context, node, {
          ownerNames: ['Reflect'],
          memberNames: ['setPrototypeOf'],
        }) ||
          matchesResolvedBuiltinCallableValue(context, node.expression, {
            ownerNames: ['Reflect'],
            memberNames: ['setPrototypeOf'],
          })
        ? 'Reflect.setPrototypeOf'
        : 'Object.setPrototypeOf';
      return createNullPrototypeObjectCreationDiagnostic(node.expression, ownerName);
    }
  }

  return undefined;
}

function isConstAssertion(node: ts.AsExpression): boolean {
  return ts.isTypeReferenceNode(node.type) &&
    ts.isIdentifier(node.type.typeName) &&
    node.type.typeName.text === 'const' &&
    node.type.typeArguments === undefined;
}

function unwrapParenthesizedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }

  return current;
}

function getAmbientAugmentationDiagnosticNode(node: ts.Node): ts.Node | undefined {
  if (!ts.isModuleDeclaration(node)) {
    return undefined;
  }

  if (!hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
    return undefined;
  }

  if ((node.flags & ts.NodeFlags.GlobalAugmentation) !== 0) {
    return node.name;
  }

  if (ts.isStringLiteralLike(node.name)) {
    return node.name;
  }

  if (ts.isIdentifier(node.name)) {
    return node.name;
  }

  return undefined;
}

function getAmbientEnumDiagnosticNode(node: ts.Node): ts.Node | undefined {
  if (!ts.isEnumDeclaration(node) || !hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
    return undefined;
  }

  return node.name;
}

function getScriptScopeInterfaceMergeDiagnosticNode(
  context: AnalysisContext,
  node: ts.Node,
): ts.Node | undefined {
  if (!ts.isInterfaceDeclaration(node)) {
    return undefined;
  }

  const sourceFile = node.getSourceFile();
  if (node.parent !== sourceFile) {
    return undefined;
  }

  const mergedSymbol = context.checker.getSymbolAtLocation(node.name);
  const mergedDeclarations = mergedSymbol?.getDeclarations() ?? [];
  if (
    mergedDeclarations.some((declaration) =>
      declaration !== node && declaration.getSourceFile().isDeclarationFile
    )
  ) {
    return node.name;
  }

  if (ts.isExternalModule(sourceFile)) {
    return undefined;
  }

  for (const candidateSourceFile of context.program.getSourceFiles()) {
    if (candidateSourceFile === sourceFile || ts.isExternalModule(candidateSourceFile)) {
      continue;
    }

    for (const statement of candidateSourceFile.statements) {
      if (context.isGeneratedNode(statement)) {
        continue;
      }

      if (ts.isInterfaceDeclaration(statement) && statement.name.text === node.name.text) {
        return node.name;
      }
    }
  }

  return undefined;
}

function getClassInterfaceMergeDiagnosticNode(
  context: AnalysisContext,
  node: ts.Node,
): ts.Node | undefined {
  const nameNode = ts.isClassDeclaration(node)
    ? node.name
    : ts.isInterfaceDeclaration(node)
    ? node.name
    : undefined;
  if (!nameNode) {
    return undefined;
  }

  const currentKind = ts.isClassDeclaration(node) ? 'class' : 'interface';
  const isOppositeKind = (candidate: ts.Statement): boolean =>
    candidate !== node &&
    ((currentKind === 'class' && ts.isInterfaceDeclaration(candidate)) ||
      (currentKind === 'interface' && ts.isClassDeclaration(candidate))) &&
    candidate.name?.text === nameNode.text;

  const container = node.parent as ts.Node & { statements?: ts.NodeArray<ts.Statement> };
  for (const statement of container.statements ?? []) {
    if (context.isGeneratedNode(statement)) {
      continue;
    }

    if (isOppositeKind(statement)) {
      return nameNode;
    }
  }

  const sourceFile = node.getSourceFile();
  if (node.parent !== sourceFile || ts.isExternalModule(sourceFile)) {
    return undefined;
  }

  for (const candidateSourceFile of context.program.getSourceFiles()) {
    if (candidateSourceFile === sourceFile || ts.isExternalModule(candidateSourceFile)) {
      continue;
    }

    for (const statement of candidateSourceFile.statements) {
      if (context.isGeneratedNode(statement)) {
        continue;
      }

      if (isOppositeKind(statement)) {
        return nameNode;
      }
    }
  }

  return undefined;
}

function isDefinitelyNullExpression(context: AnalysisContext, expression: ts.Expression): boolean {
  return context.checker.typeToString(context.checker.getTypeAtLocation(expression)) === 'null';
}

function isDefinitelyBooleanType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  return getPrimitiveFamily(checker, type) === 'boolean';
}

function isDefinitelyStringType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  return getPrimitiveFamily(checker, type) === 'string';
}

function isDefinitelyNumericType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  const family = getPrimitiveFamily(checker, type);
  return family === 'number' || family === 'bigint';
}

function isDefinitelyNumberType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  return getPrimitiveFamily(checker, type) === 'number';
}

function isDefinitelyBigIntType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  return getPrimitiveFamily(checker, type) === 'bigint';
}

function isDefinitelyPrimitiveType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  return getPrimitiveFamily(checker, type) !== undefined;
}

function isDefinitelyNonNullishPrimitiveType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  const family = getPrimitiveFamily(checker, type);
  return family !== undefined && family !== 'null' && family !== 'undefined';
}

function isSupportedTemplateSpanType(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  return getPrimitiveFamily(checker, type) === 'string';
}

function isBuiltinErrorFamilyType(
  checker: ts.TypeChecker,
  type: ts.Type,
  visited = new Set<ts.Type>(),
): boolean {
  if (visited.has(type)) {
    return false;
  }
  visited.add(type);

  const constraint = checker.getBaseConstraintOfType(type);
  if (constraint && constraint !== type) {
    return isBuiltinErrorFamilyType(checker, constraint, visited);
  }

  if (type.isUnion()) {
    return type.types.every((member) => isBuiltinErrorFamilyType(checker, member, visited));
  }

  if (type.isIntersection()) {
    return type.types.some((member) => isBuiltinErrorFamilyType(checker, member, visited));
  }

  const normalized = checker.getBaseTypeOfLiteralType(type);
  const symbol = normalized.getSymbol();
  if (symbol?.getName() === 'Error') {
    const declarations = symbol.getDeclarations() ?? [];
    if (declarations.some((declaration) => declaration.getSourceFile().isDeclarationFile)) {
      return true;
    }
  }

  if (!symbol || (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) === 0) {
    return false;
  }

  const baseTypes = checker.getBaseTypes?.(normalized as ts.InterfaceType) ?? [];
  return baseTypes.some((baseType) => isBuiltinErrorFamilyType(checker, baseType, visited));
}

function isAllowedThrownExpression(context: AnalysisContext, expression: ts.Expression): boolean {
  return isBuiltinErrorFamilyType(context.checker, context.checker.getTypeAtLocation(expression));
}

type PrimitiveFamily =
  | 'bigint'
  | 'boolean'
  | 'null'
  | 'number'
  | 'string'
  | 'symbol'
  | 'undefined';

function getPrimitiveFamily(
  checker: ts.TypeChecker,
  type: ts.Type,
  visited = new Set<ts.Type>(),
): PrimitiveFamily | undefined {
  if (visited.has(type)) {
    return undefined;
  }
  visited.add(type);

  const constraint = checker.getBaseConstraintOfType(type);
  if (constraint && constraint !== type) {
    return getPrimitiveFamily(checker, constraint, visited);
  }

  if (type.isUnion()) {
    const families = new Set(
      type.types.map((member) => getPrimitiveFamily(checker, member, visited)),
    );
    if (families.size !== 1) {
      return undefined;
    }

    const [family] = families;
    return family;
  }

  if (type.isIntersection()) {
    const families = new Set<PrimitiveFamily>();
    for (const member of type.types) {
      const family = getPrimitiveFamily(checker, member, visited);
      if (family !== undefined) {
        families.add(family);
      }
    }
    if (families.size !== 1) {
      return undefined;
    }

    const [family] = families;
    return family;
  }

  const normalized = checker.getBaseTypeOfLiteralType(type);
  if ((normalized.flags & ts.TypeFlags.StringLike) !== 0) {
    return 'string';
  }

  if ((normalized.flags & ts.TypeFlags.NumberLike) !== 0) {
    return 'number';
  }

  if ((normalized.flags & ts.TypeFlags.BigIntLike) !== 0) {
    return 'bigint';
  }

  if ((normalized.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return 'boolean';
  }

  if ((normalized.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
    return 'symbol';
  }

  if ((normalized.flags & ts.TypeFlags.Null) !== 0) {
    return 'null';
  }

  if ((normalized.flags & ts.TypeFlags.Undefined) !== 0) {
    return 'undefined';
  }

  return undefined;
}

function isBooleanConditionExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  return isDefinitelyBooleanType(context.checker, context.checker.getTypeAtLocation(expression));
}

function isAllowedPlusOperandPair(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
): boolean {
  return (
    isDefinitelyStringType(checker, left) && isDefinitelyStringType(checker, right)
  ) || (
    isDefinitelyNumberType(checker, left) && isDefinitelyNumberType(checker, right)
  ) || (
    isDefinitelyBigIntType(checker, left) && isDefinitelyBigIntType(checker, right)
  );
}

function isAllowedRelationalOperandPair(
  checker: ts.TypeChecker,
  left: ts.Type,
  right: ts.Type,
): boolean {
  return (
    isDefinitelyStringType(checker, left) && isDefinitelyStringType(checker, right)
  ) || (
    isDefinitelyNumberType(checker, left) && isDefinitelyNumberType(checker, right)
  ) || (
    isDefinitelyBigIntType(checker, left) && isDefinitelyBigIntType(checker, right)
  );
}

function isProtoPropertyName(name: ts.PropertyName): ts.Node | undefined {
  if (
    (ts.isIdentifier(name) || ts.isStringLiteral(name) ||
      ts.isNoSubstitutionTemplateLiteral(name)) &&
    name.text === '__proto__'
  ) {
    return name;
  }

  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression)) &&
    name.expression.text === '__proto__'
  ) {
    return name.expression;
  }

  return undefined;
}

function isVoidZeroExpression(node: ts.VoidExpression): boolean {
  const expression = unwrapParenthesizedExpression(node.expression);
  return ts.isNumericLiteral(expression) && expression.text === '0';
}

function isLegacyOctalNumericLiteral(node: ts.Node): node is ts.NumericLiteral {
  return ts.isNumericLiteral(node) && /^0[0-7]+$/.test(node.getText());
}

function hasLegacyOctalEscape(rawText: string): boolean {
  let consecutiveBackslashes = 0;

  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index];
    if (char === '\\') {
      consecutiveBackslashes += 1;
      continue;
    }

    const escaped = consecutiveBackslashes % 2 === 1;
    consecutiveBackslashes = 0;
    if (!escaped) {
      continue;
    }

    if (/[1-7]/.test(char)) {
      return true;
    }

    if (char === '0' && /[0-7]/.test(rawText[index + 1] ?? '')) {
      return true;
    }
  }

  return false;
}

function isLegacyOctalEscapeLiteral(node: ts.Node): node is ts.StringLiteralLike {
  return ts.isStringLiteralLike(node) && hasLegacyOctalEscape(node.getText().slice(1, -1));
}

function getDeclarationParameterName(parameter: ts.ParameterDeclaration): string | undefined {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

function isLengthOnlyArrayConstructorCall(
  context: AnalysisContext,
  node: ts.CallExpression | ts.NewExpression,
): boolean {
  if (node.arguments?.length !== 1) {
    return false;
  }

  const info = getResolvedBuiltinSignatureInfo(context, node);
  if (info?.ownerName !== 'ArrayConstructor') {
    return false;
  }

  const [parameter] = info.declaration.parameters;
  return parameter !== undefined &&
    parameter.dotDotDotToken === undefined &&
    getDeclarationParameterName(parameter) === 'arrayLength';
}

function isBroadObjectEnumerationTarget(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  const unwrapped = unwrapParenthesizedExpression(expression);
  if (ts.isObjectLiteralExpression(unwrapped) && unwrapped.properties.length === 0) {
    return false;
  }

  const type = context.checker.getTypeAtLocation(unwrapped);
  if (!isInspectableObjectType(type)) {
    return false;
  }

  if (context.checker.getPropertiesOfType(type).length > 0) {
    return false;
  }

  return context.checker.getIndexTypeOfType(type, ts.IndexKind.String) === undefined &&
    context.checker.getIndexTypeOfType(type, ts.IndexKind.Number) === undefined;
}

function getStaticMemberAccess(node: ts.Node): {
  expression: ts.Expression;
  memberName: string;
  memberNode: ts.Node;
} | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return {
      expression: node.expression,
      memberName: node.name.text,
      memberNode: node.name,
    };
  }

  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return {
      expression: node.expression,
      memberName: node.argumentExpression.text,
      memberNode: node.argumentExpression,
    };
  }

  return undefined;
}

function isFunctionLikeValue(context: AnalysisContext, expression: ts.Expression): boolean {
  return typeHasFunctionLikeBrand(context.checker, context.checker.getTypeAtLocation(expression));
}

function typeHasFunctionLikeBrand(
  checker: ts.TypeChecker,
  type: ts.Type,
  visited: Set<ts.Type> = new Set(),
): boolean {
  if (visited.has(type)) {
    return false;
  }
  visited.add(type);

  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return true;
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((member) =>
      typeHasFunctionLikeBrand(checker, member, visited)
    );
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((member) =>
      typeHasFunctionLikeBrand(checker, member, visited)
    );
  }

  const normalized = checker.getBaseTypeOfLiteralType(type);
  if (
    hasFunctionLikeTypeName(normalized.aliasSymbol) || hasFunctionLikeTypeName(normalized.getSymbol())
  ) {
    return true;
  }

  const symbol = normalized.getSymbol();
  if (!symbol || (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) === 0) {
    return false;
  }

  const baseTypes = checker.getBaseTypes?.(normalized as ts.InterfaceType) ?? [];
  return baseTypes.some((baseType) => typeHasFunctionLikeBrand(checker, baseType, visited));
}

function hasFunctionLikeTypeName(symbol: ts.Symbol | undefined): boolean {
  const name = symbol?.getName();
  return name === 'Function' || name === 'CallableFunction' || name === 'NewableFunction';
}

function isInspectableObjectType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

function getCallableMutationTarget(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Node | undefined {
  if (
    ts.isPropertyAccessExpression(expression) && isFunctionLikeValue(context, expression.expression)
  ) {
    return expression.name;
  }

  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression !== undefined &&
    isFunctionLikeValue(context, expression.expression)
  ) {
    return expression.argumentExpression;
  }

  return undefined;
}

function getCallableMutationTargetInAssignmentPattern(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Node | undefined {
  const directTarget = getCallableMutationTarget(context, expression);
  if (directTarget) {
    return directTarget;
  }

  if (ts.isParenthesizedExpression(expression)) {
    return getCallableMutationTargetInAssignmentPattern(context, expression.expression);
  }

  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)) {
        const target = getCallableMutationTargetInAssignmentPattern(context, property.initializer);
        if (target) {
          return target;
        }
      }
    }
  }

  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      if (!ts.isExpression(element)) {
        continue;
      }

      const target = getCallableMutationTargetInAssignmentPattern(context, element);
      if (target) {
        return target;
      }
    }
  }

  return undefined;
}

function isAssignmentOperatorToken(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isArgumentsIdentifier(node: ts.Identifier): boolean {
  if (node.text !== 'arguments') {
    return false;
  }

  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
    return false;
  }

  if (ts.isQualifiedName(node.parent) && node.parent.right === node) {
    return false;
  }

  if (
    (ts.isPropertyAssignment(node.parent) ||
      ts.isPropertyDeclaration(node.parent) ||
      ts.isPropertySignature(node.parent) ||
      ts.isMethodDeclaration(node.parent) ||
      ts.isGetAccessorDeclaration(node.parent) ||
      ts.isSetAccessorDeclaration(node.parent)) &&
    node.parent.name === node
  ) {
    return false;
  }

  return true;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function isSoundSourceFile(sourceFile: ts.SourceFile): boolean {
  return !sourceFile.isDeclarationFile &&
    (sourceFile.fileName.endsWith('.sts') || sourceFile.fileName.endsWith('.sts.ts'));
}

function isMacroAuthoringSourceFile(sourceFile: ts.SourceFile): boolean {
  return sourceFile.fileName.endsWith('.macro.sts') ||
    sourceFile.fileName.endsWith('.macro.sts.ts');
}

function isSynthesizedNode(node: ts.Node): boolean {
  return node.pos < 0 || (node.flags & ts.NodeFlags.Synthesized) !== 0;
}

function getCanonicalSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (!symbol) {
    return undefined;
  }

  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

type AmbientRuntimeDeclarationNode =
  | ts.ClassDeclaration
  | ts.FunctionDeclaration
  | ts.VariableStatement;

function isMacroHelperAmbientRuntimeDeclaration(node: AmbientRuntimeDeclarationNode): boolean {
  return ts.isFunctionDeclaration(node) &&
    (node.name?.text === '__sts_macro_expr' || node.name?.text === '__sts_macro_stmt');
}

function isStrippedMacroFactoryPlaceholderDeclaration(
  node: AmbientRuntimeDeclarationNode,
): boolean {
  if (!ts.isVariableStatement(node)) {
    return false;
  }

  if (!node.getSourceFile().text.includes('/* soundscript:macros */')) {
    return false;
  }

  return node.declarationList.declarations.length > 0 &&
    node.declarationList.declarations.every((declaration) =>
      ts.isIdentifier(declaration.name) &&
      declaration.initializer === undefined &&
      declaration.type?.kind === ts.SyntaxKind.UnknownKeyword
    );
}

function getAmbientRuntimeDeclarationNode(
  context: AnalysisContext,
  node: ts.Node,
): AmbientRuntimeDeclarationNode | undefined {
  const sourceFile = node.getSourceFile();
  if (
    isSynthesizedNode(node) ||
    context.isGeneratedNode(node) ||
    !isSoundSourceFile(sourceFile) ||
    isMacroAuthoringSourceFile(sourceFile)
  ) {
    return undefined;
  }

  if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.DeclareKeyword)) {
    return isStrippedMacroFactoryPlaceholderDeclaration(node) ? undefined : node;
  }

  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    hasModifier(node, ts.SyntaxKind.DeclareKeyword)
  ) {
    return isMacroHelperAmbientRuntimeDeclaration(node) ? undefined : node;
  }

  return undefined;
}

function getAmbientRuntimeDeclarationDiagnosticNode(
  node: AmbientRuntimeDeclarationNode,
): ts.Node {
  if (ts.isVariableStatement(node)) {
    const firstDeclaration = node.declarationList.declarations[0];
    if (firstDeclaration && ts.isIdentifier(firstDeclaration.name)) {
      return firstDeclaration.name;
    }

    return node;
  }

  return node.name ?? node;
}

function getAmbientRuntimeDeclarationSymbols(
  context: AnalysisContext,
  node: AmbientRuntimeDeclarationNode,
): readonly ts.Symbol[] {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations
      .map((declaration) =>
        ts.isIdentifier(declaration.name)
          ? getCanonicalSymbol(
            context.checker,
            context.checker.getSymbolAtLocation(declaration.name),
          )
          : undefined
      )
      .filter((symbol): symbol is ts.Symbol => symbol !== undefined);
  }

  if (!node.name) {
    return [];
  }

  const symbol = getCanonicalSymbol(
    context.checker,
    context.checker.getSymbolAtLocation(node.name),
  );
  return symbol ? [symbol] : [];
}

function getAmbientRuntimeDeclarationFromSymbolDeclaration(
  context: AnalysisContext,
  declaration: ts.Declaration,
): AmbientRuntimeDeclarationNode | undefined {
  if (ts.isVariableDeclaration(declaration)) {
    return ts.isVariableDeclarationList(declaration.parent) &&
        ts.isVariableStatement(declaration.parent.parent)
      ? getAmbientRuntimeDeclarationNode(context, declaration.parent.parent)
      : undefined;
  }

  return getAmbientRuntimeDeclarationNode(context, declaration);
}

function nodeReferencesAmbientRuntimeDeclaration(
  context: AnalysisContext,
  node: ts.Node,
  declarationSymbols: readonly ts.Symbol[],
): boolean {
  if (declarationSymbols.length === 0) {
    return false;
  }

  if (ts.isExportAssignment(node)) {
    if (!ts.isIdentifier(node.expression)) {
      return false;
    }

    const symbol = getCanonicalSymbol(
      context.checker,
      context.checker.getSymbolAtLocation(node.expression),
    );
    return symbol !== undefined && declarationSymbols.includes(symbol);
  }

  if (ts.isExportSpecifier(node)) {
    const localNode = node.propertyName ?? node.name;
    const symbol = getCanonicalSymbol(
      context.checker,
      context.checker.getSymbolAtLocation(localNode),
    );
    return symbol !== undefined && declarationSymbols.includes(symbol);
  }

  return false;
}

function isAmbientRuntimeDeclarationReexported(
  context: AnalysisContext,
  node: AmbientRuntimeDeclarationNode,
): boolean {
  const declarationSymbols = getAmbientRuntimeDeclarationSymbols(context, node);
  if (declarationSymbols.length === 0) {
    return false;
  }

  const sourceFile = node.getSourceFile();
  for (const statement of sourceFile.statements) {
    if (context.isGeneratedNode(statement)) {
      continue;
    }

    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      nodeReferencesAmbientRuntimeDeclaration(context, statement, declarationSymbols)
    ) {
      return true;
    }

    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause.elements.some((element) =>
        nodeReferencesAmbientRuntimeDeclaration(context, element, declarationSymbols)
      )
    ) {
      return true;
    }
  }

  return false;
}

function hasExternDirective(context: AnalysisContext, node: ts.Node): boolean {
  return context.getAnnotationLookup(node.getSourceFile()).hasAttachedAnnotation(node, 'extern');
}

function isAmbientRuntimeDeclarationExported(node: AmbientRuntimeDeclarationNode): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function getAmbientRuntimeExportDiagnostic(
  context: AnalysisContext,
  node: ts.Node,
): AmbientRuntimeExportDiagnostic | undefined {
  const declarationNode = getAmbientRuntimeDeclarationNode(context, node);
  if (declarationNode && isAmbientRuntimeDeclarationExported(declarationNode)) {
    return {
      declarationNode,
      diagnosticNode: getAmbientRuntimeDeclarationDiagnosticNode(declarationNode),
      exportForm: 'direct export',
    };
  }

  if (
    ts.isExportAssignment(node) &&
    !node.isExportEquals &&
    ts.isIdentifier(node.expression)
  ) {
    const symbol = getCanonicalSymbol(
      context.checker,
      context.checker.getSymbolAtLocation(node.expression),
    );
    if (
      symbol?.declarations?.some((declaration) =>
        declaration.getSourceFile() === node.getSourceFile() &&
        getAmbientRuntimeDeclarationFromSymbolDeclaration(context, declaration) !== undefined
      )
    ) {
      const declarationNode = symbol.declarations
        ?.filter((declaration) => declaration.getSourceFile() === node.getSourceFile())
        .map((declaration) => getAmbientRuntimeDeclarationFromSymbolDeclaration(context, declaration))
        .find((declaration): declaration is AmbientRuntimeDeclarationNode => declaration !== undefined);
      if (declarationNode) {
        return {
          declarationNode,
          diagnosticNode: node.expression,
          exportForm: 'default export alias',
        };
      }
    }
  }

  if (
    ts.isExportSpecifier(node) &&
    node.parent.parent.moduleSpecifier === undefined
  ) {
    const localNode = node.propertyName ?? node.name;
    const symbol = getCanonicalSymbol(
      context.checker,
      context.checker.getSymbolAtLocation(localNode),
    );
    if (
      symbol?.declarations?.some((declaration) => {
        return declaration.getSourceFile() === node.getSourceFile() &&
          getAmbientRuntimeDeclarationFromSymbolDeclaration(context, declaration) !== undefined;
      })
    ) {
      const declarationNode = symbol.declarations
        ?.filter((declaration) => declaration.getSourceFile() === node.getSourceFile())
        .map((declaration) => getAmbientRuntimeDeclarationFromSymbolDeclaration(context, declaration))
        .find((declaration): declaration is AmbientRuntimeDeclarationNode => declaration !== undefined);
      if (declarationNode) {
        return {
          declarationNode,
          diagnosticNode: node.name,
          exportForm: 'local re-export',
        };
      }
    }
  }

  return undefined;
}

function getAmbientRuntimeRequiresExternDeclarationNode(
  context: AnalysisContext,
  node: ts.Node,
): AmbientRuntimeDeclarationNode | undefined {
  const declarationNode = getAmbientRuntimeDeclarationNode(context, node);
  if (!declarationNode) {
    return undefined;
  }

  if (
    isAmbientRuntimeDeclarationExported(declarationNode) ||
    isAmbientRuntimeDeclarationReexported(context, declarationNode)
  ) {
    return undefined;
  }

  if (hasExternDirective(context, declarationNode)) {
    return undefined;
  }

  return declarationNode;
}

function getProtoDefinitionNode(node: ts.Node): ts.Node | undefined {
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    return isProtoPropertyName(node.name);
  }

  if (
    node.parent !== undefined &&
    ts.isObjectLiteralExpression(node.parent) &&
    (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node))
  ) {
    return isProtoPropertyName(node.name);
  }

  return undefined;
}

function isSoundScriptSourceFilePath(fileName: string): boolean {
  return /\.sts(?:\.ts)?$/.test(fileName);
}

function getDecoratorDiagnosticNode(node: ts.Node): ts.Node | undefined {
  if (!isSoundScriptSourceFilePath(node.getSourceFile().fileName) || !ts.canHaveDecorators(node)) {
    return undefined;
  }

  const decorators = ts.getDecorators(node);
  return decorators && decorators.length > 0 ? decorators[0] : undefined;
}

function isTopLevelThisExpression(node: ts.ThisExpression): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (
      ts.isFunctionLike(current) ||
      ts.isClassLike(current) ||
      current.kind === ts.SyntaxKind.ClassStaticBlockDeclaration
    ) {
      return false;
    }

    if (ts.isSourceFile(current)) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function isAllowedThisContainer(node: ts.SignatureDeclarationBase): boolean {
  return ts.isConstructorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
}

function isBannedThisExpression(node: ts.ThisExpression): boolean {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isFunctionLike(current)) {
      return !isAllowedThisContainer(current);
    }

    if (
      ts.isClassLike(current) ||
      current.kind === ts.SyntaxKind.ClassStaticBlockDeclaration
    ) {
      return false;
    }

    if (ts.isSourceFile(current)) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function isBannedDeclarationFileTypeReference(
  context: AnalysisContext,
  node: ts.TypeReferenceNode,
): ts.Node | undefined {
  if (
    !ts.isIdentifier(node.typeName) ||
    !isBannedDeclarationFileTypeName(context, node.typeName.text)
  ) {
    return undefined;
  }

  const symbol = context.checker.getSymbolAtLocation(node.typeName);
  if (!symbol) {
    return undefined;
  }

  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? context.checker.getAliasedSymbol(symbol)
    : symbol;
  const declarations = resolved.declarations ?? [];
  if (
    declarations.length === 0 ||
    !declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
  ) {
    return undefined;
  }

  return node.typeName;
}

function supportsWeakCollections(context: AnalysisContext): boolean {
  return context.runtime.target !== 'wasm-wasi';
}

function isBannedDeclarationFileTypeName(
  context: AnalysisContext,
  typeName: string,
): boolean {
  if (ALWAYS_BANNED_DECLARATION_FILE_TYPE_NAMES.has(typeName)) {
    return true;
  }
  if (
    CONDITIONALLY_BANNED_DECLARATION_FILE_TYPE_NAMES.has(typeName) &&
    !supportsWeakCollections(context)
  ) {
    return true;
  }
  return false;
}

function getBannedConstructorOwnerNames(
  context: AnalysisContext,
): readonly string[] {
  return supportsWeakCollections(context)
    ? [
      'StringConstructor',
      'NumberConstructor',
      'BooleanConstructor',
      'FunctionConstructor',
      'ProxyConstructor',
      'WeakRefConstructor',
      'FinalizationRegistryConstructor',
    ]
    : [
      'StringConstructor',
      'NumberConstructor',
      'BooleanConstructor',
      'FunctionConstructor',
      'ProxyConstructor',
      'WeakMapConstructor',
      'WeakSetConstructor',
      'WeakRefConstructor',
      'FinalizationRegistryConstructor',
    ];
}

function isBannedSymbolHookName(
  context: AnalysisContext,
  name: ts.PropertyName,
): ts.Node | undefined {
  if (!ts.isComputedPropertyName(name)) {
    return undefined;
  }

  const expression = unwrapParenthesizedExpression(name.expression);
  if (
    ts.isPropertyAccessExpression(expression) &&
    resolvesToBuiltinGlobalValue(context, expression.expression, 'Symbol', {
      ownerNames: ['SymbolConstructor'],
    }) &&
    BANNED_SYMBOL_HOOK_MEMBER_NAMES.has(expression.name.text)
  ) {
    return expression.name;
  }

  if (
    ts.isElementAccessExpression(expression) &&
    resolvesToBuiltinGlobalValue(context, expression.expression, 'Symbol', {
      ownerNames: ['SymbolConstructor'],
    }) &&
    expression.argumentExpression !== undefined &&
    ts.isStringLiteralLike(expression.argumentExpression) &&
    BANNED_SYMBOL_HOOK_MEMBER_NAMES.has(expression.argumentExpression.text)
  ) {
    return expression.argumentExpression;
  }

  return undefined;
}

function getWrappedInvocationArgument(
  node: ts.CallExpression,
  invocation: WrappedBuiltinInvocation,
  directArgumentIndex: number,
): ts.Expression | undefined {
  if (invocation.wrapperKind === 'call') {
    return node.arguments[directArgumentIndex + 1];
  }

  const argumentList = node.arguments[1];
  if (!argumentList || !ts.isArrayLiteralExpression(argumentList)) {
    return undefined;
  }

  const element = argumentList.elements[directArgumentIndex];
  return element && ts.isExpression(element) ? element : undefined;
}

function getObjectBindingElementPropertyName(
  element: ts.BindingElement,
): string | undefined {
  const propertyName = element.propertyName ?? element.name;
  if (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)) {
    return propertyName.text;
  }

  return undefined;
}

function isObjectPrototypePrimitiveConversionHookAlias(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  if (!ts.isIdentifier(expression)) {
    return false;
  }

  const symbol = context.checker.getSymbolAtLocation(expression);
  if (!symbol) {
    return false;
  }

  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? context.checker.getAliasedSymbol(symbol)
    : symbol;
  for (const declaration of resolved.declarations ?? []) {
    if (!ts.isBindingElement(declaration)) {
      continue;
    }

    if (
      !PRIMITIVE_CONVERSION_HOOK_MEMBER_NAMES.has(
        getObjectBindingElementPropertyName(declaration) ?? '',
      )
    ) {
      continue;
    }

    const bindingPattern = declaration.parent;
    if (!ts.isObjectBindingPattern(bindingPattern)) {
      continue;
    }

    const variableDeclaration = bindingPattern.parent;
    if (
      !ts.isVariableDeclaration(variableDeclaration) ||
      variableDeclaration.initializer === undefined
    ) {
      continue;
    }

    const initializer = unwrapParenthesizedExpression(variableDeclaration.initializer);
    if (
      ts.isPropertyAccessExpression(initializer) &&
      initializer.name.text === 'prototype' &&
      resolvesToBuiltinGlobalValue(context, initializer.expression, 'Object', {
        ownerNames: ['ObjectConstructor'],
      })
    ) {
      return true;
    }
  }

  return false;
}

function isObjectPrototypePrimitiveConversionHookValue(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  return matchesResolvedBuiltinCallableValue(context, expression, {
    ownerNames: ['Object'],
    memberNames: ['toString', 'valueOf'],
  }) || isObjectPrototypePrimitiveConversionHookAlias(context, expression);
}

function isBannedConstructorValue(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  return matchesResolvedBuiltinCallableValue(context, expression, {
    ownerNames: getBannedConstructorOwnerNames(context),
  }, 'construct');
}

function getBannedPrimitiveConversionHookCallNode(
  context: AnalysisContext,
  node: ts.CallExpression,
): ts.Node | undefined {
  const memberAccess = getStaticMemberAccess(node.expression);
  if (
    memberAccess &&
    PRIMITIVE_CONVERSION_HOOK_MEMBER_NAMES.has(memberAccess.memberName) &&
    !isDefinitelyNonNullishPrimitiveType(
      context.checker,
      context.checker.getTypeAtLocation(memberAccess.expression),
    )
  ) {
    return memberAccess.memberNode;
  }

  const wrappedInvocation = getWrappedBuiltinInvocation(node);
  if (
    wrappedInvocation &&
    isObjectPrototypePrimitiveConversionHookValue(context, wrappedInvocation.target)
  ) {
    return node.expression;
  }

  if (ts.isCallExpression(node.expression)) {
    const bindTarget = getStaticMemberAccess(node.expression.expression);
    if (
      bindTarget?.memberName === 'bind' &&
      isObjectPrototypePrimitiveConversionHookValue(context, bindTarget.expression)
    ) {
      return node.expression;
    }

    const wrappedBindInvocation = getWrappedBuiltinInvocation(node.expression);
    if (
      wrappedBindInvocation &&
      (wrappedBindInvocation.wrapperKind === 'call' ||
        wrappedBindInvocation.wrapperKind === 'apply')
    ) {
      const bindMember = getStaticMemberAccess(wrappedBindInvocation.target);
      if (
        bindMember?.memberName === 'bind' &&
        isObjectPrototypePrimitiveConversionHookValue(context, bindMember.expression)
      ) {
        return node.expression;
      }
    }
  }

  return undefined;
}

function getUnsupportedFeatureDiagnostic(
  context: AnalysisContext,
  node: ts.Node,
): UnsupportedFeatureDiagnostic | undefined {
  const ambientAugmentationNode = getAmbientAugmentationDiagnosticNode(node);
  if (ambientAugmentationNode) {
    return unsupportedFeature(ambientAugmentationNode, 'ambientAugmentation');
  }

  const ambientEnumNode = getAmbientEnumDiagnosticNode(node);
  if (ambientEnumNode) {
    return unsupportedFeature(ambientEnumNode, 'ambientEnum');
  }

  const scriptScopeInterfaceMergeNode = getScriptScopeInterfaceMergeDiagnosticNode(context, node);
  if (scriptScopeInterfaceMergeNode) {
    return unsupportedFeature(scriptScopeInterfaceMergeNode, 'scriptScopeInterfaceMerge');
  }

  const classInterfaceMergeNode = getClassInterfaceMergeDiagnosticNode(context, node);
  if (classInterfaceMergeNode) {
    return unsupportedFeature(classInterfaceMergeNode, 'classInterfaceMerge');
  }

  const decoratorNode = getDecoratorDiagnosticNode(node);
  if (decoratorNode) {
    return unsupportedFeature(decoratorNode, 'decorators');
  }

  if (ts.isWithStatement(node)) {
    return unsupportedFeature(node, 'withStatement');
  }

  if (
    (ts.isIfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)) &&
    !isBooleanConditionExpression(context, node.expression)
  ) {
    return unsupportedFeature(node.expression, 'nonBooleanCondition');
  }

  if (
    ts.isForStatement(node) &&
    node.condition !== undefined &&
    !isBooleanConditionExpression(context, node.condition)
  ) {
    return unsupportedFeature(node.condition, 'nonBooleanCondition');
  }

  if (
    ts.isConditionalExpression(node) &&
    !isBooleanConditionExpression(context, node.condition)
  ) {
    return unsupportedFeature(node.condition, 'nonBooleanCondition');
  }

  if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
    return unsupportedFeature(node, 'varDeclaration');
  }

  if (isLegacyOctalNumericLiteral(node) || isLegacyOctalEscapeLiteral(node)) {
    return unsupportedFeature(node, 'legacyOctalLiteral');
  }

  if (ts.isTypeReferenceNode(node)) {
    const bannedTypeReference = isBannedDeclarationFileTypeReference(context, node);
    if (bannedTypeReference) {
      return unsupportedFeature(bannedTypeReference, 'bannedDeclarationFileTypeReference', {
        name: bannedTypeReference.getText(bannedTypeReference.getSourceFile()),
      });
    }
  }

  if (ts.isIdentifier(node) && isArgumentsIdentifier(node)) {
    return unsupportedFeature(node, 'argumentsObject');
  }

  if (ts.isDebuggerStatement(node)) {
    return unsupportedFeature(node, 'debuggerStatement');
  }

  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
  ) {
    return unsupportedFeature(node.operatorToken, 'looseEquality');
  }

  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
    (
      !isDefinitelyBooleanType(context.checker, context.checker.getTypeAtLocation(node.left)) ||
      !isDefinitelyBooleanType(context.checker, context.checker.getTypeAtLocation(node.right))
    )
  ) {
    return unsupportedFeature(node.operatorToken, 'nonBooleanLogicalOperator');
  }

  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.ExclamationToken &&
    !isDefinitelyBooleanType(context.checker, context.checker.getTypeAtLocation(node.operand))
  ) {
    return unsupportedFeature(node, 'nonBooleanLogicalNot');
  }

  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
  ) {
    const leftFamily = getPrimitiveFamily(
      context.checker,
      context.checker.getTypeAtLocation(node.left),
    );
    const rightFamily = getPrimitiveFamily(
      context.checker,
      context.checker.getTypeAtLocation(node.right),
    );
    const nullishFamilies = new Set<PrimitiveFamily>(['null', 'undefined']);

    if (
      leftFamily !== undefined &&
      rightFamily !== undefined &&
      leftFamily !== rightFamily &&
      !nullishFamilies.has(leftFamily) &&
      !nullishFamilies.has(rightFamily)
    ) {
      return unsupportedFeature(node.operatorToken, 'incompatibleStrictEquality');
    }
  }

  if (
    ts.isBinaryExpression(node) &&
    (
      node.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
      node.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
      node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken
    ) &&
    !isAllowedRelationalOperandPair(
      context.checker,
      context.checker.getTypeAtLocation(node.left),
      context.checker.getTypeAtLocation(node.right),
    )
  ) {
    return unsupportedFeature(node.operatorToken, 'relationalComparison');
  }

  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
    !isAllowedPlusOperandPair(
      context.checker,
      context.checker.getTypeAtLocation(node.left),
      context.checker.getTypeAtLocation(node.right),
    )
  ) {
    return unsupportedFeature(node.operatorToken, 'plusOperator');
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return unsupportedFeature(node.operatorToken, 'commaOperator');
  }

  if (ts.isVoidExpression(node) && isVoidZeroExpression(node)) {
    return unsupportedFeature(node, 'voidZero');
  }

  if (ts.isDeleteExpression(node)) {
    return unsupportedFeature(node, 'deleteExpression');
  }

  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      if (
        !isSupportedTemplateSpanType(
          context.checker,
          context.checker.getTypeAtLocation(span.expression),
        )
      ) {
        return unsupportedFeature(span.expression, 'templateInterpolation');
      }
    }
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ((ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === 'prototype' &&
      isFunctionLikeValue(context, node.left.expression)) ||
      (ts.isElementAccessExpression(node.left) &&
        node.left.argumentExpression !== undefined &&
        ts.isStringLiteralLike(node.left.argumentExpression) &&
        node.left.argumentExpression.text === 'prototype' &&
        isFunctionLikeValue(context, node.left.expression)))
  ) {
    return unsupportedFeature(
      ts.isPropertyAccessExpression(node.left) ? node.left.name : node.left.argumentExpression,
      'prototypeMutation',
    );
  }

  if (
    ts.isBinaryExpression(node) &&
    isAssignmentOperatorToken(node.operatorToken.kind)
  ) {
    const callableMutationTarget = getCallableMutationTargetInAssignmentPattern(context, node.left);
    if (callableMutationTarget) {
      return unsupportedFeature(callableMutationTarget, 'functionObjectMutation');
    }
  }

  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (
      node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken
    )
  ) {
    const callableMutationTarget = getCallableMutationTarget(context, node.operand);
    if (callableMutationTarget) {
      return unsupportedFeature(callableMutationTarget, 'functionObjectMutation');
    }
  }

  if (
    (ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
    (hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(node, ts.SyntaxKind.ProtectedKeyword))
  ) {
    return unsupportedFeature(
      ts.isConstructorDeclaration(node) ? node : node.name,
      'privateOrProtectedMember',
    );
  }

  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return unsupportedFeature(node.name, 'accessors');
  }

  if (
    ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) ||
    ts.isPropertyAssignment(node)
  ) {
    const bannedSymbolHookNode = isBannedSymbolHookName(context, node.name);
    if (bannedSymbolHookNode) {
      return unsupportedFeature(bannedSymbolHookNode, 'symbolHook');
    }
  }

  if (ts.isArrayLiteralExpression(node) && node.elements.some(ts.isOmittedExpression)) {
    return unsupportedFeature(node, 'sparseArrayLiteral');
  }

  const protoDefinitionNode = getProtoDefinitionNode(node);
  if (protoDefinitionNode) {
    return unsupportedFeature(protoDefinitionNode, 'protoProperty');
  }

  const memberAccess = getStaticMemberAccess(node);
  if (memberAccess) {
    if (memberAccess.memberName === '__proto__') {
      return unsupportedFeature(memberAccess.memberNode, 'protoProperty');
    }

    if (LEGACY_ACCESSOR_MEMBER_NAMES.has(memberAccess.memberName)) {
      return unsupportedFeature(memberAccess.memberNode, 'legacyAccessorApi');
    }

    if (
      memberAccess.memberName === 'callee' &&
      ts.isIdentifier(memberAccess.expression) &&
      memberAccess.expression.text === 'arguments'
    ) {
      return unsupportedFeature(memberAccess.memberNode, 'argumentsCallee');
    }

    if (
      LEGACY_FUNCTION_MEMBER_NAMES.has(memberAccess.memberName) &&
      isFunctionLikeValue(context, memberAccess.expression)
    ) {
      return unsupportedFeature(memberAccess.memberNode, 'legacyFunctionMetadata');
    }
  }

  if (ts.isCallExpression(node)) {
    const bannedPrimitiveConversionHookCallNode = getBannedPrimitiveConversionHookCallNode(
      context,
      node,
    );
    if (bannedPrimitiveConversionHookCallNode) {
      return unsupportedFeature(bannedPrimitiveConversionHookCallNode, 'primitiveConversionHookCall');
    }

    if (
      matchesResolvedBuiltinSignature(context, node, { ownerNames: ['SymbolConstructor'] }) ||
      matchesResolvedBuiltinCallableValue(context, node.expression, {
        ownerNames: ['SymbolConstructor'],
      }) ||
      matchesResolvedBuiltinSignature(context, node, {
        ownerNames: ['SymbolConstructor'],
        memberNames: ['for'],
      }) ||
      matchesResolvedBuiltinCallableValue(context, node.expression, {
        ownerNames: ['SymbolConstructor'],
        memberNames: ['for'],
      })
    ) {
      return unsupportedFeature(node.expression, 'symbolApi');
    }

    if (
      matchesResolvedBuiltinSignature(context, node, { memberNames: ['eval'] }) ||
      matchesResolvedBuiltinCallableValue(context, node.expression, { memberNames: ['eval'] })
    ) {
      return unsupportedFeature(node.expression, 'eval');
    }

    if (
      matchesResolvedBuiltinSignature(context, node, { ownerNames: ['FunctionConstructor'] }) ||
      matchesResolvedBuiltinCallableValue(context, node.expression, {
        ownerNames: ['FunctionConstructor'],
      })
    ) {
      return unsupportedFeature(node.expression, 'functionConstructor');
    }

    if (
      matchesResolvedBuiltinSignature(context, node, {
        ownerNames: ['ObjectConstructor'],
        memberNames: ['create'],
      }) ||
      matchesResolvedBuiltinCallableValue(context, node.expression, {
        ownerNames: ['ObjectConstructor'],
        memberNames: ['create'],
      })
    ) {
      const prototypeArgument = node.arguments[0];
      if (prototypeArgument && !isDefinitelyNullExpression(context, prototypeArgument)) {
        return unsupportedFeature(node.expression, 'objectCreateNonNull');
      }
    }
  }

  if (ts.isNewExpression(node)) {
    if (
      matchesResolvedBuiltinSignature(context, node, {
        ownerNames: getBannedConstructorOwnerNames(context),
      }) ||
      isBannedConstructorValue(context, node.expression)
    ) {
      return unsupportedFeature(node.expression, 'bannedConstructor', {
        name: node.expression.getText(node.getSourceFile()),
      });
    }

    if (isLengthOnlyArrayConstructorCall(context, node)) {
      return unsupportedFeature(node.expression, 'arrayLengthConstructor');
    }
  }

  if (ts.isCallExpression(node)) {
    if (
      resolvesToBuiltinGlobalValue(context, node.expression, 'Object', {
        ownerNames: ['ObjectConstructor'],
      }) &&
      node.arguments.length > 0 &&
      isDefinitelyPrimitiveType(
        context.checker,
        context.checker.getTypeAtLocation(node.arguments[0]),
      )
    ) {
      return unsupportedFeature(node.expression, 'objectPrimitiveBoxing');
    }

    if (
      (
        matchesResolvedBuiltinSignature(context, node, {
          ownerNames: ['ObjectConstructor'],
          memberNames: ['entries', 'values'],
        }) ||
        matchesResolvedBuiltinCallableValue(context, node.expression, {
          ownerNames: ['ObjectConstructor'],
          memberNames: ['entries', 'values'],
        })
      ) &&
      node.arguments.length > 0 &&
      isBroadObjectEnumerationTarget(context, node.arguments[0])
    ) {
      return unsupportedFeature(node.arguments[0], 'broadObjectEnumeration');
    }

    if (
      (
        matchesResolvedBuiltinSignature(context, node, {
          ownerNames: ['Reflect'],
          memberNames: ['apply'],
        }) ||
        matchesResolvedBuiltinCallableValue(context, node.expression, {
          ownerNames: ['Reflect'],
          memberNames: ['apply'],
        })
      ) &&
      node.arguments.length > 0 &&
      isObjectPrototypePrimitiveConversionHookValue(context, node.arguments[0])
    ) {
      return unsupportedFeature(node.expression, 'reflectApplyPrimitiveHook');
    }

    if (
      (
        matchesResolvedBuiltinSignature(context, node, {
          ownerNames: ['Reflect'],
          memberNames: ['construct'],
        }) ||
        matchesResolvedBuiltinCallableValue(context, node.expression, {
          ownerNames: ['Reflect'],
          memberNames: ['construct'],
        })
      ) &&
      (
        (node.arguments[0] !== undefined && isBannedConstructorValue(context, node.arguments[0])) ||
        (node.arguments[2] !== undefined && isBannedConstructorValue(context, node.arguments[2]))
      )
    ) {
      return unsupportedFeature(node.expression, 'reflectConstructBannedConstructor');
    }

    if (
      matchesResolvedBuiltinSignature(context, node, {
        ownerNames: ['ProxyConstructor'],
        memberNames: ['revocable'],
      }) ||
      matchesResolvedBuiltinCallableValue(context, node.expression, {
        ownerNames: ['ProxyConstructor'],
        memberNames: ['revocable'],
      })
    ) {
      return unsupportedFeature(node.expression, 'proxyRevocable');
    }

    if (
      (
        matchesResolvedBuiltinSignature(context, node, {
          ownerNames: ['ObjectConstructor'],
          memberNames: ['assign'],
        }) ||
        matchesResolvedBuiltinCallableValue(context, node.expression, {
          ownerNames: ['ObjectConstructor'],
          memberNames: ['assign'],
        }) ||
        matchesResolvedBuiltinSignature(context, node, {
          ownerNames: ['Reflect'],
          memberNames: ['set'],
        }) ||
        matchesResolvedBuiltinCallableValue(context, node.expression, {
          ownerNames: ['Reflect'],
          memberNames: ['set'],
        })
      ) &&
      node.arguments.length > 0 &&
      isFunctionLikeValue(context, node.arguments[0])
    ) {
      return unsupportedFeature(node.expression, 'reflectivePropertyMutation');
    }

    const wrappedInvocation = getWrappedBuiltinInvocation(node);
    if (wrappedInvocation) {
      if (
        (
          matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
            ownerNames: ['ObjectConstructor'],
            memberNames: ['assign'],
          }) ||
          matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
            ownerNames: ['Reflect'],
            memberNames: ['set'],
          })
        )
      ) {
        const targetArgument = getWrappedInvocationArgument(node, wrappedInvocation, 0);
        if (targetArgument && isFunctionLikeValue(context, targetArgument)) {
          return unsupportedFeature(node.expression, 'reflectivePropertyMutation');
        }
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['ObjectConstructor'],
          memberNames: ['entries', 'values'],
        })
      ) {
        const targetArgument = getWrappedInvocationArgument(node, wrappedInvocation, 0);
        if (targetArgument && isBroadObjectEnumerationTarget(context, targetArgument)) {
          return unsupportedFeature(node.expression, 'broadObjectEnumeration');
        }
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['Reflect'],
          memberNames: ['apply'],
        })
      ) {
        const targetArgument = getWrappedInvocationArgument(node, wrappedInvocation, 0);
        if (
          targetArgument && isObjectPrototypePrimitiveConversionHookValue(context, targetArgument)
        ) {
          return unsupportedFeature(node.expression, 'reflectApplyPrimitiveHook');
        }
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['Reflect'],
          memberNames: ['construct'],
        })
      ) {
        const targetArgument = getWrappedInvocationArgument(node, wrappedInvocation, 0);
        const newTargetArgument = getWrappedInvocationArgument(node, wrappedInvocation, 2);
        if (
          (targetArgument && isBannedConstructorValue(context, targetArgument)) ||
          (newTargetArgument && isBannedConstructorValue(context, newTargetArgument))
        ) {
          return unsupportedFeature(node.expression, 'reflectConstructBannedConstructor');
        }
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['ProxyConstructor'],
          memberNames: ['revocable'],
        })
      ) {
        return unsupportedFeature(node.expression, 'proxyRevocable');
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['SymbolConstructor'],
        }) ||
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['SymbolConstructor'],
          memberNames: ['for'],
        })
      ) {
        return unsupportedFeature(node.expression, 'symbolApi');
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          memberNames: ['eval'],
        })
      ) {
        return unsupportedFeature(node.expression, 'eval');
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['FunctionConstructor'],
        })
      ) {
        return unsupportedFeature(node.expression, 'functionConstructor');
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['ObjectConstructor'],
          memberNames: ['create'],
        })
      ) {
        const prototypeArgument = getWrappedInvocationArgument(node, wrappedInvocation, 0);
        if (prototypeArgument && !isDefinitelyNullExpression(context, prototypeArgument)) {
          return unsupportedFeature(node.expression, 'objectCreateNonNull');
        }
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['ObjectConstructor'],
          memberNames: [
            'defineProperties',
            'defineProperty',
            'freeze',
            'getOwnPropertyDescriptor',
            'getOwnPropertyDescriptors',
            'getOwnPropertyNames',
            'getOwnPropertySymbols',
            'preventExtensions',
            'seal',
          ],
        }) ||
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['Reflect'],
          memberNames: ['defineProperty', 'ownKeys'],
        })
      ) {
        return unsupportedFeature(node.expression, 'reflectiveMetaObjectOperation');
      }

      if (
        matchesResolvedBuiltinCallableValue(context, wrappedInvocation.target, {
          ownerNames: ['ObjectConstructor', 'Reflect'],
          memberNames: ['setPrototypeOf'],
        })
      ) {
        return unsupportedFeature(node.expression, 'prototypeMutation');
      }
    }

    if (
      matchesResolvedBuiltinSignature(context, node, {
        ownerNames: ['ObjectConstructor'],
        memberNames: [
          'defineProperties',
          'defineProperty',
          'freeze',
          'getOwnPropertyDescriptor',
          'getOwnPropertyDescriptors',
          'getOwnPropertyNames',
          'getOwnPropertySymbols',
          'preventExtensions',
          'seal',
        ],
      }) ||
      matchesResolvedBuiltinCallableValue(context, node.expression, {
        ownerNames: ['ObjectConstructor'],
        memberNames: [
          'defineProperties',
          'defineProperty',
          'freeze',
          'getOwnPropertyDescriptor',
          'getOwnPropertyDescriptors',
          'getOwnPropertyNames',
          'getOwnPropertySymbols',
          'preventExtensions',
          'seal',
        ],
      }) ||
      matchesResolvedBuiltinSignature(context, node, {
        ownerNames: ['Reflect'],
        memberNames: ['defineProperty', 'ownKeys'],
      }) ||
      matchesResolvedBuiltinCallableValue(context, node.expression, {
        ownerNames: ['Reflect'],
        memberNames: ['defineProperty', 'ownKeys'],
      })
    ) {
      return unsupportedFeature(node.expression, 'reflectiveMetaObjectOperation');
    }

    if (isLengthOnlyArrayConstructorCall(context, node)) {
      return unsupportedFeature(node.expression, 'arrayLengthConstructor');
    }

    if (
      matchesResolvedBuiltinSignature(context, node, {
        ownerNames: ['ObjectConstructor', 'Reflect'],
        memberNames: ['setPrototypeOf'],
      }) ||
      matchesResolvedBuiltinCallableValue(context, node.expression, {
        ownerNames: ['ObjectConstructor', 'Reflect'],
        memberNames: ['setPrototypeOf'],
      })
    ) {
      return unsupportedFeature(node.expression, 'prototypeMutation');
    }
  }

  if (ts.isLabeledStatement(node)) {
    return unsupportedFeature(node.label, 'labeledStatement');
  }

  if (
    node.kind === ts.SyntaxKind.ThisKeyword &&
    (
      isTopLevelThisExpression(node as ts.ThisExpression) ||
      isBannedThisExpression(node as ts.ThisExpression)
    )
  ) {
    return unsupportedFeature(node, 'disallowedThis');
  }

  return undefined;
}

export function runUnsoundSyntaxRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    if (isForeignSourceFile(sourceFile.fileName, ts.sys)) {
      return;
    }

    context.traverse(sourceFile, (node) => {
      if (isInsideSyntheticErrorNormalizationHelper(node)) {
        return;
      }

      const nullPrototypeObjectCreationDiagnostic = getNullPrototypeObjectCreationDiagnostic(
        context,
        node,
      );
      if (nullPrototypeObjectCreationDiagnostic) {
        diagnostics.push(nullPrototypeObjectCreationDiagnostic);
        return;
      }

      const unsupportedFeatureDiagnostic = getUnsupportedFeatureDiagnostic(context, node);
      if (unsupportedFeatureDiagnostic) {
        diagnostics.push(
          createDiagnostic(
            unsupportedFeatureDiagnostic.node,
            SOUND_DIAGNOSTIC_CODES.unsupportedJavaScriptFeature,
            unsupportedFeatureDiagnostic.message,
            {
              hint: unsupportedFeatureDiagnostic.hint,
              metadata: unsupportedFeatureDiagnostic.metadata,
              notes: unsupportedFeatureDiagnostic.example
                ? [`Example: ${unsupportedFeatureDiagnostic.example}`]
                : undefined,
            },
          ),
        );
        return;
      }

      const exportedAmbientRuntimeDiagnostic = getAmbientRuntimeExportDiagnostic(context, node);
      if (exportedAmbientRuntimeDiagnostic) {
        diagnostics.push(createAmbientRuntimeExportDiagnostic(exportedAmbientRuntimeDiagnostic));
        return;
      }

      const ambientRequiresExternDeclaration = getAmbientRuntimeRequiresExternDeclarationNode(
        context,
        node,
      );
      if (ambientRequiresExternDeclaration) {
        diagnostics.push(createAmbientRuntimeRequiresExternDiagnostic(ambientRequiresExternDeclaration));
        return;
      }

      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        diagnostics.push(createAnyTypeDiagnostic(node));
        return;
      }

      if (ts.isTypeAssertionExpression(node)) {
        diagnostics.push(createTypeAssertionDiagnostic(context, node));
        return;
      }

      if (ts.isThrowStatement(node) && !isAllowedThrownExpression(context, node.expression)) {
        diagnostics.push(createThrowNonErrorDiagnostic(context, node.expression));
        return;
      }

      if (ts.isAsExpression(node)) {
        if (getLocalUnsafeProofOverrideChainRoot(node) !== node) {
          return;
        }

        if (isConstAssertion(node)) {
          return;
        }

        if (isUnsafeBridgeCast(context, node)) {
          diagnostics.push(createTypeAssertionDiagnostic(context, node));
          return;
        }

        if (isLocallyUnsafe(context, node)) {
          return;
        }

        diagnostics.push(createTypeAssertionDiagnostic(context, node));
        return;
      }

      if (ts.isNonNullExpression(node)) {
        if (getLocalUnsafeProofOverrideChainRoot(node) !== node) {
          return;
        }

        if (isLocallyUnsafe(context, node)) {
          return;
        }

        diagnostics.push(createNonNullAssertionDiagnostic(context, node));
        return;
      }

      if (
        ts.isVariableDeclaration(node) &&
        node.exclamationToken !== undefined &&
        node.initializer === undefined
      ) {
        if (isLocallyUnsafe(context, node)) {
          return;
        }

        diagnostics.push(createDefiniteAssignmentAssertionDiagnostic(context, node));
        return;
      }

      if (
        ts.isPropertyDeclaration(node) &&
        node.exclamationToken !== undefined &&
        node.initializer === undefined
      ) {
        diagnostics.push(createDefiniteAssignmentAssertionDiagnostic(context, node));
        return;
      }

      if (isLocallyUnsafe(context, node)) {
        return;
      }
    });
  });

  return diagnostics;
}
