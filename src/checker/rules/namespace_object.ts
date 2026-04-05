import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES } from '../engine/diagnostic_codes.ts';
import type {
  AnalysisContext,
  NamespacePathFact,
  NamespacePathSegment,
  NamespaceResolverFact,
  NamespaceShapeFact,
} from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';
import { collectExportedSymbolsBySourceFile } from './non_ordinary_recovery.ts';
import { isImportCall, isRequireCall } from './foreign_boundary.ts';
import { getResolvedBuiltinSignatureInfo } from './resolved_builtins.ts';

const MODULE_NAMESPACE_MESSAGE =
  'Module namespace objects cannot be assigned, aliased, passed, or returned in soundscript.';
const MODULE_NAMESPACE_NOTES = [
  'Only direct exported-member reads from a namespace import are allowed.',
];
const MODULE_NAMESPACE_HINT =
  'Read the exported member you need immediately instead of storing or forwarding the namespace object.';

type LocalFunctionLikeWithBody =
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration;

function createNamespaceEscapeDiagnostic(node: ts.Node): SoundDiagnostic {
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.exoticObjectWidening,
    category: 'error',
    message: MODULE_NAMESPACE_MESSAGE,
    metadata: {
      rule: 'module_namespace_escape',
      fixability: 'local_rewrite',
      invariant:
        'Module namespace objects may only be used for immediate exported-member reads inside soundscript.',
      replacementFamily: 'direct_exported_member_read',
      counterexample:
        'Forwarding a namespace object hides which export is actually used and lets module-namespace behavior escape ordinary code.',
      example: 'Read the member immediately, for example `const add = math.add;` instead of storing `math`.',
    },
    notes: MODULE_NAMESPACE_NOTES,
    hint: MODULE_NAMESPACE_HINT,
    ...getNodeDiagnosticRange(node),
  };
}

function createWholeNamespacePath(guard?: 'fulfilled'): NamespacePathFact {
  return { guard, path: [] };
}

function createWholeNamespaceShape(
  origin: NamespaceShapeFact['origin'],
  guard?: 'fulfilled',
): NamespaceShapeFact {
  return {
    origin,
    paths: [createWholeNamespacePath(guard)],
  };
}

function createWholeNamespaceResolver(
  origin: NamespaceResolverFact['origin'],
): NamespaceResolverFact {
  return {
    ambiguous: false,
    origin,
    paths: [createWholeNamespacePath()],
  };
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (true) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }

    return current;
  }
}

function isConstVariableDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0;
}

function isTypePositionIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  return (ts.isTypeReferenceNode(parent) && parent.typeName === node) ||
    (ts.isExpressionWithTypeArguments(parent) && parent.expression === node) ||
    ts.isTypeQueryNode(parent) ||
    ts.isImportTypeNode(parent) ||
    ts.isQualifiedName(parent);
}

function isLocalFunctionLikeWithBody(node: ts.Node): node is LocalFunctionLikeWithBody {
  return (ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)) &&
    node.body !== undefined;
}

function getLocalSymbol(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Symbol | undefined {
  if (
    ts.isIdentifier(expression) &&
    ts.isShorthandPropertyAssignment(expression.parent) &&
    expression.parent.name === expression
  ) {
    return context.checker.getShorthandAssignmentValueSymbol(expression.parent) ??
      context.checker.getSymbolAtLocation(expression);
  }

  return context.checker.getSymbolAtLocation(expression);
}

function isTransparentNamespaceUseParent(parent: ts.Node, child: ts.Node): boolean {
  return ((ts.isParenthesizedExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isAsExpression(parent)) &&
    parent.expression === child);
}

function pathSegmentEquals(left: NamespacePathSegment, right: NamespacePathSegment): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  return left.kind === 'index'
    ? left.index === (right as NamespacePathSegment & { kind: 'index' }).index
    : left.name === (right as NamespacePathSegment & { kind: 'property' }).name;
}

function getPropertySegmentName(
  expression:
    | ts.ElementAccessChain
    | ts.ElementAccessExpression
    | ts.PropertyAccessChain
    | ts.PropertyAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)) {
    return expression.name.text;
  }

  const argument = expression.argumentExpression;
  if (
    argument &&
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
  ) {
    return argument.text;
  }

  return undefined;
}

function getIndexSegmentValue(
  expression: ts.ElementAccessChain | ts.ElementAccessExpression,
): number | undefined {
  const argument = expression.argumentExpression;
  if (!argument) {
    return undefined;
  }

  if (ts.isNumericLiteral(argument)) {
    return Number(argument.text);
  }

  if (
    ts.isStringLiteral(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument)
  ) {
    const numericValue = Number(argument.text);
    return Number.isInteger(numericValue) ? numericValue : undefined;
  }

  return undefined;
}

function projectShapeBySegment(
  shape: NamespaceShapeFact,
  segment: NamespacePathSegment,
): NamespaceShapeFact | undefined {
  const nextPaths: NamespacePathFact[] = [];

  for (const pathFact of shape.paths) {
    const [head, ...tail] = pathFact.path;
    if (!head || !pathSegmentEquals(head, segment)) {
      continue;
    }

    nextPaths.push({
      guard: pathFact.guard,
      path: tail,
    });
  }

  return nextPaths.length > 0
    ? {
      origin: shape.origin,
      paths: nextPaths,
    }
    : undefined;
}

function prependPathSegment(
  pathFact: NamespacePathFact,
  segment: NamespacePathSegment,
): NamespacePathFact {
  return {
    guard: pathFact.guard,
    path: [segment, ...pathFact.path],
  };
}

function appendPathSegment(
  pathFact: NamespacePathFact,
  segment: NamespacePathSegment,
): NamespacePathFact {
  return {
    guard: pathFact.guard,
    path: [...pathFact.path, segment],
  };
}

function withFulfilledGuard(
  pathFact: NamespacePathFact,
): NamespacePathFact {
  return {
    guard: 'fulfilled',
    path: pathFact.path,
  };
}

function normalizeNamespaceShapeKey(
  shape: Pick<NamespaceResolverFact | NamespaceShapeFact, 'paths'>,
): string {
  return shape.paths.map((pathFact) =>
    `${pathFact.guard ?? 'none'}:${
      pathFact.path.map((segment) =>
        segment.kind === 'index' ? `[${segment.index}]` : `.${segment.name}`
      ).join('')
    }`
  ).sort().join('|');
}

function createArrayResolverResult(
  resolverMethod: 'all' | 'allSettled',
  elementResolvers: readonly NamespaceResolverFact[],
): NamespaceResolverFact {
  const paths: NamespacePathFact[] = [];

  for (const [index, resolver] of elementResolvers.entries()) {
    for (const pathFact of resolver.paths) {
      const indexedPath = prependPathSegment(pathFact, { index, kind: 'index' });
      paths.push(
        resolverMethod === 'allSettled'
          ? appendPathSegment(withFulfilledGuard(indexedPath), {
            kind: 'property',
            name: 'value',
          })
          : indexedPath,
      );
    }
  }

  return {
    ambiguous: false,
    origin: 'resolver',
    paths,
  };
}

function getConstInitializerForIdentifier(
  context: AnalysisContext,
  expression: ts.Expression,
  seenSymbols = new Set<ts.Symbol>(),
): ts.Expression | undefined {
  const current = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(current)) {
    return undefined;
  }

  const symbol = getLocalSymbol(context, current);
  if (!symbol || seenSymbols.has(symbol)) {
    return undefined;
  }
  seenSymbols.add(symbol);

  for (const declaration of symbol.getDeclarations() ?? []) {
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      isConstVariableDeclaration(declaration)
    ) {
      return declaration.initializer;
    }
  }

  return undefined;
}

function getResolverElementExpressions(
  context: AnalysisContext,
  expression: ts.Expression,
  seenSymbols = new Set<ts.Symbol>(),
): readonly ts.Expression[] | undefined {
  const current = unwrapTransparentExpression(expression);

  if (ts.isArrayLiteralExpression(current)) {
    if (current.elements.some(ts.isSpreadElement)) {
      return undefined;
    }

    return current.elements.filter(ts.isExpression);
  }

  const initializer = getConstInitializerForIdentifier(context, current, seenSymbols);
  return initializer ? getResolverElementExpressions(context, initializer, seenSymbols) : undefined;
}

function getPromiseStaticMethodName(
  context: AnalysisContext,
  node: ts.CallExpression,
): 'all' | 'allSettled' | 'any' | 'race' | 'resolve' | undefined {
  const info = getResolvedBuiltinSignatureInfo(context, node);
  if (!info || info.ownerName !== 'PromiseConstructor') {
    return undefined;
  }

  switch (info.memberName) {
    case 'all':
    case 'allSettled':
    case 'any':
    case 'race':
    case 'resolve':
      return info.memberName;
    default:
      return undefined;
  }
}

function getPromiseInstanceMethodInfo(
  context: AnalysisContext,
  node: ts.CallExpression,
): { method: 'catch' | 'finally' | 'then'; target: ts.Expression } | undefined {
  const info = getResolvedBuiltinSignatureInfo(context, node);
  if (
    !info ||
    (info.ownerName !== 'Promise' && info.ownerName !== 'PromiseLike') ||
    (info.memberName !== 'then' && info.memberName !== 'catch' && info.memberName !== 'finally')
  ) {
    return undefined;
  }

  if (ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    if (method === 'then' || method === 'catch' || method === 'finally') {
      return { method, target: node.expression.expression };
    }
  }

  if (
    ts.isElementAccessExpression(node.expression) &&
    node.expression.argumentExpression &&
    (ts.isStringLiteral(node.expression.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.expression.argumentExpression))
  ) {
    const method = node.expression.argumentExpression.text;
    if (method === 'then' || method === 'catch' || method === 'finally') {
      return { method, target: node.expression.expression };
    }
  }

  return undefined;
}

function getNamespaceShapeFromModuleNamespaceExportSummary(
  summary: ReturnType<AnalysisContext['exportSummaries']['get']>,
): NamespaceShapeFact | undefined {
  return summary?.kind === 'value' && summary.fact.family === 'moduleNamespace'
    ? createWholeNamespaceShape('staticImport')
    : undefined;
}

function computeNamespaceShapeFromExportSummary(
  context: AnalysisContext,
  symbol: ts.Symbol,
  seenSymbols = new Set<ts.Symbol>(),
): NamespaceShapeFact | undefined {
  const canonicalSymbol = context.exportSummaries.canonicalizeSymbol(symbol);
  if (seenSymbols.has(canonicalSymbol)) {
    return undefined;
  }
  seenSymbols.add(canonicalSymbol);

  const cachedShape = getNamespaceShapeFromModuleNamespaceExportSummary(
    context.exportSummaries.get(canonicalSymbol),
  );
  if (cachedShape) {
    return cachedShape;
  }

  for (const declaration of canonicalSymbol.getDeclarations() ?? []) {
    let shape: NamespaceShapeFact | undefined;

    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer &&
      ts.isIdentifier(declaration.name)
    ) {
      shape = getWholeNamespaceExportShape(context, declaration.initializer);
    } else if (ts.isExportAssignment(declaration) && !declaration.isExportEquals) {
      shape = getWholeNamespaceExportShape(context, declaration.expression);
    } else if (ts.isExportSpecifier(declaration)) {
      const localSymbol = context.checker.getSymbolAtLocation(
        declaration.propertyName ?? declaration.name,
      );
      shape = localSymbol
        ? computeNamespaceShapeFromExportSummary(context, localSymbol, seenSymbols) ??
          getKnownNamespaceShape(context, declaration.propertyName ?? declaration.name)
        : undefined;
    } else if (ts.isNamespaceExport(declaration)) {
      shape = createWholeNamespaceShape('staticImport');
    }

    if (shape && isWholeNamespaceShape(shape)) {
      context.exportSummaries.set(canonicalSymbol, {
        kind: 'value',
        fact: { family: 'moduleNamespace' },
      });
      return createWholeNamespaceShape('staticImport');
    }
  }

  return undefined;
}

function getNamespaceShapeFromExportSummary(
  context: AnalysisContext,
  symbol: ts.Symbol,
): NamespaceShapeFact | undefined {
  return computeNamespaceShapeFromExportSummary(context, symbol);
}

function getIdentifierNamespaceShape(
  context: AnalysisContext,
  expression: ts.Identifier,
): NamespaceShapeFact | undefined {
  const symbol = getLocalSymbol(context, expression);
  if (!symbol) {
    return undefined;
  }

  return context.facts.getNamespaceShapeSymbol(symbol) ??
    getNamespaceShapeFromExportSummary(context, symbol) ??
    ((symbol.getDeclarations() ?? []).some(ts.isNamespaceImport)
      ? createWholeNamespaceShape('staticImport')
      : undefined);
}

function getDefaultExportSymbol(
  context: AnalysisContext,
  sourceFile: ts.SourceFile,
): ts.Symbol | undefined {
  const moduleSymbol = context.checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    return undefined;
  }

  return context.checker.getExportsOfModule(moduleSymbol).find((symbol) =>
    symbol.escapedName === 'default'
  );
}

function getIdentifierNamespaceResolver(
  context: AnalysisContext,
  expression: ts.Identifier,
): NamespaceResolverFact | undefined {
  const symbol = getLocalSymbol(context, expression);
  return symbol ? context.facts.getNamespaceResolverSymbol(symbol) : undefined;
}

function getNamespaceResolverInternal(
  context: AnalysisContext,
  expression: ts.Expression,
): NamespaceResolverFact | undefined {
  const current = unwrapTransparentExpression(expression);

  if (ts.isIdentifier(current)) {
    return getIdentifierNamespaceResolver(context, current);
  }

  if (ts.isCallExpression(current)) {
    if (isImportCall(current)) {
      return createWholeNamespaceResolver('dynamicImport');
    }

    const staticMethod = getPromiseStaticMethodName(context, current);
    if (staticMethod === 'resolve') {
      const wrapped = current.arguments[0];
      return wrapped ? getNamespaceResolver(context, wrapped) : undefined;
    }

    if (
      staticMethod === 'all' ||
      staticMethod === 'allSettled' ||
      staticMethod === 'race' ||
      staticMethod === 'any'
    ) {
      const input = current.arguments[0];
      if (!input) {
        return undefined;
      }

      const elementExpressions = getResolverElementExpressions(context, input);
      if (!elementExpressions || elementExpressions.length === 0) {
        return undefined;
      }

      const elementResolvers = elementExpressions.map((element) =>
        getNamespaceResolver(context, element)
      );
      if (elementResolvers.some((resolver) => resolver?.ambiguous)) {
        return {
          ambiguous: true,
          origin: 'resolver',
          paths: [],
        };
      }

      const presentResolvers = elementResolvers.filter((
        resolver,
      ): resolver is NamespaceResolverFact => resolver !== undefined);
      if (presentResolvers.length === 0) {
        return undefined;
      }

      if (staticMethod === 'all' || staticMethod === 'allSettled') {
        return presentResolvers.length === elementResolvers.length
          ? createArrayResolverResult(staticMethod, presentResolvers)
          : {
            ambiguous: true,
            origin: 'resolver',
            paths: [],
          };
      }

      const firstShape = presentResolvers[0];
      if (!firstShape) {
        return undefined;
      }

      const normalizedKey = normalizeNamespaceShapeKey(firstShape);
      const allCompatible = presentResolvers.length === elementResolvers.length &&
        presentResolvers.every((resolver) =>
          normalizeNamespaceShapeKey(resolver) === normalizedKey
        );
      return allCompatible
        ? {
          ambiguous: false,
          origin: 'resolver',
          paths: firstShape.paths,
        }
        : {
          ambiguous: true,
          origin: 'resolver',
          paths: [],
        };
    }

    const promiseMethod = getPromiseInstanceMethodInfo(context, current);
    if (promiseMethod?.method === 'catch' || promiseMethod?.method === 'finally') {
      return getNamespaceResolver(context, promiseMethod.target);
    }
  }

  return undefined;
}

function getNamespaceShapeInternal(
  context: AnalysisContext,
  expression: ts.Expression,
): NamespaceShapeFact | undefined {
  const current = unwrapTransparentExpression(expression);

  if (ts.isIdentifier(current)) {
    return getIdentifierNamespaceShape(context, current);
  }

  if (ts.isAwaitExpression(current)) {
    const resolver = getNamespaceResolver(context, current.expression);
    return resolver && !resolver.ambiguous
      ? {
        origin: resolver.origin === 'dynamicImport' ? 'dynamicImport' : 'resolver',
        paths: resolver.paths,
      }
      : undefined;
  }

  if (ts.isCallExpression(current) && isRequireCall(current)) {
    return createWholeNamespaceShape('require');
  }

  if (ts.isPropertyAccessExpression(current) || ts.isPropertyAccessChain(current)) {
    const baseShape = getKnownNamespaceShape(context, current.expression);
    if (!baseShape) {
      return undefined;
    }

    return projectShapeBySegment(baseShape, {
      kind: 'property',
      name: current.name.text,
    });
  }

  if (ts.isElementAccessExpression(current) || ts.isElementAccessChain(current)) {
    const baseShape = getKnownNamespaceShape(context, current.expression);
    if (!baseShape) {
      return undefined;
    }

    const index = getIndexSegmentValue(current);
    if (index !== undefined) {
      return projectShapeBySegment(baseShape, {
        index,
        kind: 'index',
      });
    }

    const propertyName = getPropertySegmentName(current);
    return propertyName
      ? projectShapeBySegment(baseShape, {
        kind: 'property',
        name: propertyName,
      })
      : undefined;
  }

  return undefined;
}

export function getNamespaceResolver(
  context: AnalysisContext,
  expression: ts.Expression,
): NamespaceResolverFact | undefined {
  return context.facts.getNamespaceResolver(
    expression,
    () => getNamespaceResolverInternal(context, expression),
  );
}

export function getKnownNamespaceShape(
  context: AnalysisContext,
  expression: ts.Expression,
): NamespaceShapeFact | undefined {
  return context.facts.getNamespaceShape(
    expression,
    () => getNamespaceShapeInternal(context, expression),
  );
}

function isWholeNamespaceShape(shape: NamespaceShapeFact): boolean {
  return shape.paths.some((pathFact) => pathFact.path.length === 0);
}

function getAllowedNamespaceSeedShape(
  context: AnalysisContext,
  expression: ts.Expression,
): NamespaceShapeFact | undefined {
  const current = unwrapTransparentExpression(expression);

  if (ts.isAwaitExpression(current)) {
    const resolver = getNamespaceResolver(context, current.expression);
    return resolver && !resolver.ambiguous
      ? {
        origin: resolver.origin === 'dynamicImport' ? 'dynamicImport' : 'resolver',
        paths: resolver.paths,
      }
      : undefined;
  }

  if (ts.isCallExpression(current) && isRequireCall(current)) {
    return createWholeNamespaceShape('require');
  }

  return undefined;
}

function getWholeNamespaceExportShape(
  context: AnalysisContext,
  expression: ts.Expression,
): NamespaceShapeFact | undefined {
  const shape = getAllowedNamespaceSeedShape(context, expression) ??
    getKnownNamespaceShape(context, expression);
  return shape && isWholeNamespaceShape(shape) ? shape : undefined;
}

function getShapeAtArrayIndex(
  shape: NamespaceShapeFact,
  index: number,
): NamespaceShapeFact | undefined {
  return projectShapeBySegment(shape, {
    index,
    kind: 'index',
  });
}

function isSimpleNamespaceProjectionObjectPattern(pattern: ts.ObjectBindingPattern): boolean {
  return pattern.elements.every((element) => {
    if (element.dotDotDotToken) {
      return false;
    }

    return ts.isIdentifier(element.name);
  });
}

function seedBindingNameFromShape(
  context: AnalysisContext,
  bindingName: ts.BindingName,
  shape: NamespaceShapeFact,
): boolean {
  if (!canBindFromShape(bindingName, shape)) {
    return false;
  }

  if (ts.isIdentifier(bindingName)) {
    const symbol = context.checker.getSymbolAtLocation(bindingName);
    if (!symbol) {
      return false;
    }

    context.facts.setNamespaceShapeSymbol(symbol, shape);
    return true;
  }

  if (ts.isObjectBindingPattern(bindingName)) {
    return true;
  }

  for (const [index, element] of bindingName.elements.entries()) {
    if (!element) {
      continue;
    }

    if (ts.isOmittedExpression(element)) {
      continue;
    }

    const elementShape = getShapeAtArrayIndex(shape, index);
    if (!elementShape) {
      continue;
    }

    if (!seedBindingNameFromShape(context, element.name, elementShape)) {
      return false;
    }
  }

  return true;
}

function canBindFromShape(
  bindingName: ts.BindingName,
  shape: NamespaceShapeFact,
): boolean {
  if (ts.isIdentifier(bindingName)) {
    return true;
  }

  if (ts.isObjectBindingPattern(bindingName)) {
    return isWholeNamespaceShape(shape) && isSimpleNamespaceProjectionObjectPattern(bindingName);
  }

  if (isWholeNamespaceShape(shape)) {
    return false;
  }

  return bindingName.elements.every((element, index) => {
    if (!element || ts.isOmittedExpression(element)) {
      return true;
    }

    if (element.dotDotDotToken) {
      return false;
    }

    const elementShape = getShapeAtArrayIndex(shape, index);
    return elementShape ? canBindFromShape(element.name, elementShape) : true;
  });
}

function seedVariableDeclaration(
  context: AnalysisContext,
  node: ts.VariableDeclaration,
): boolean {
  if (!node.initializer || !isConstVariableDeclaration(node)) {
    return false;
  }

  const resolver = getNamespaceResolver(context, node.initializer);
  if (resolver && !resolver.ambiguous && ts.isIdentifier(node.name)) {
    const symbol = context.checker.getSymbolAtLocation(node.name);
    if (symbol) {
      context.facts.setNamespaceResolverSymbol(symbol, resolver);
      return true;
    }
  }

  const seedShape = getAllowedNamespaceSeedShape(context, node.initializer);
  if (seedShape) {
    return seedBindingNameFromShape(context, node.name, seedShape);
  }

  return false;
}

function getThenCallback(node: ts.CallExpression): LocalFunctionLikeWithBody | undefined {
  const callback = node.arguments[0];
  return callback && isLocalFunctionLikeWithBody(callback) ? callback : undefined;
}

function seedThenCallbackParameter(
  context: AnalysisContext,
  callback: LocalFunctionLikeWithBody,
  shape: NamespaceShapeFact,
): boolean {
  const [parameter] = callback.parameters;
  if (!parameter) {
    return true;
  }

  return seedBindingNameFromShape(context, parameter.name, shape);
}

function seedNamespaceFacts(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];
  const exportedSymbolsBySourceFile = collectExportedSymbolsBySourceFile(context);

  context.forEachSourceFile((sourceFile) => {
    for (const statement of sourceFile.statements) {
      if (context.isGeneratedNode(statement)) {
        continue;
      }

      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.namedBindings &&
        ts.isNamespaceImport(statement.importClause.namedBindings)
      ) {
        const symbol = context.checker.getSymbolAtLocation(
          statement.importClause.namedBindings.name,
        );
        if (symbol) {
          context.facts.setNamespaceShapeSymbol(symbol, createWholeNamespaceShape('staticImport'));
        }
      }

      if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference)
      ) {
        const symbol = context.checker.getSymbolAtLocation(statement.name);
        if (symbol) {
          context.facts.setNamespaceShapeSymbol(symbol, createWholeNamespaceShape('require'));
        }
      }
    }

    const exportedSymbols = exportedSymbolsBySourceFile.get(sourceFile);

    context.traverse(sourceFile, (node) => {
      if (ts.isVariableDeclaration(node)) {
        if (
          exportedSymbols &&
          isConstVariableDeclaration(node) &&
          node.initializer &&
          ts.isIdentifier(node.name)
        ) {
          const exportSymbol = context.checker.getSymbolAtLocation(node.name);
          if (
            exportSymbol &&
            exportedSymbols.has(context.exportSummaries.canonicalizeSymbol(exportSymbol)) &&
            getWholeNamespaceExportShape(context, node.initializer)
          ) {
            context.exportSummaries.set(exportSymbol, {
              kind: 'value',
              fact: { family: 'moduleNamespace' },
            });
          }
        }

        if (
          node.initializer &&
          !seedVariableDeclaration(context, node) &&
          getAllowedNamespaceSeedShape(context, node.initializer) &&
          !ts.isIdentifier(node.name)
        ) {
          diagnostics.push(createNamespaceEscapeDiagnostic(node.name));
        }
        return;
      }

      if (
        ts.isCallExpression(node) &&
        getNamespaceResolver(context, node)?.ambiguous
      ) {
        diagnostics.push(createNamespaceEscapeDiagnostic(node));
        return;
      }

      let exportSymbol: ts.Symbol | undefined;
      let exportInitializer: ts.Expression | undefined;

      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        exportSymbol = getDefaultExportSymbol(context, sourceFile);
        exportInitializer = node.expression;
      }

      const exportedSymbolsInSource = exportedSymbols;
      if (
        exportSymbol &&
        exportInitializer &&
        exportedSymbolsInSource?.has(context.exportSummaries.canonicalizeSymbol(exportSymbol)) &&
        getWholeNamespaceExportShape(context, exportInitializer)
      ) {
        context.exportSummaries.set(exportSymbol, {
          kind: 'value',
          fact: { family: 'moduleNamespace' },
        });
      }

      if (!ts.isCallExpression(node)) {
        return;
      }

      const promiseMethod = getPromiseInstanceMethodInfo(context, node);
      if (promiseMethod?.method !== 'then') {
        return;
      }

      const targetResolver = getNamespaceResolver(context, promiseMethod.target);
      if (!targetResolver || targetResolver.ambiguous) {
        return;
      }

      const callback = getThenCallback(node);
      if (!callback) {
        return;
      }

      const callbackShape: NamespaceShapeFact = {
        origin: targetResolver.origin === 'dynamicImport' ? 'dynamicImport' : 'resolver',
        paths: targetResolver.paths,
      };
      if (!seedThenCallbackParameter(context, callback, callbackShape)) {
        diagnostics.push(createNamespaceEscapeDiagnostic(callback.parameters[0]?.name ?? callback));
      }
    });

    if (!exportedSymbols) {
      return;
    }

    context.traverse(sourceFile, (node) => {
      if (
        !ts.isExportDeclaration(node) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        !node.exportClause ||
        !ts.isNamespaceExport(node.exportClause)
      ) {
        return;
      }

      const symbol = context.checker.getSymbolAtLocation(node.exportClause.name);
      if (!symbol) {
        return;
      }

      if (!exportedSymbols.has(context.exportSummaries.canonicalizeSymbol(symbol))) {
        return;
      }

      context.exportSummaries.set(symbol, {
        kind: 'value',
        fact: { family: 'moduleNamespace' },
      });
    });
  });

  return diagnostics;
}

function isAllowedNamespaceUse(
  context: AnalysisContext,
  expression: ts.Expression,
  shape: NamespaceShapeFact,
): boolean {
  const parent = expression.parent;
  if (!parent) {
    return false;
  }

  if (isTransparentNamespaceUseParent(parent, expression)) {
    return true;
  }

  if (
    (ts.isPropertyAccessExpression(parent) || ts.isPropertyAccessChain(parent)) &&
    parent.expression === expression
  ) {
    if (isWholeNamespaceShape(shape)) {
      return true;
    }

    if (
      parent.name.text === 'status' &&
      shape.paths.some((pathFact) =>
        pathFact.guard === 'fulfilled' &&
        pathFact.path[0]?.kind === 'property' &&
        pathFact.path[0].name === 'value'
      )
    ) {
      return true;
    }

    return shape.paths.some((pathFact) => {
      const [head] = pathFact.path;
      return head?.kind === 'property' && head.name === parent.name.text;
    });
  }

  if (
    (ts.isElementAccessExpression(parent) || ts.isElementAccessChain(parent)) &&
    parent.expression === expression
  ) {
    const propertyName = getPropertySegmentName(parent);
    if (isWholeNamespaceShape(shape) && propertyName !== undefined) {
      return true;
    }

    const index = getIndexSegmentValue(parent);
    return shape.paths.some((pathFact) => {
      const [head] = pathFact.path;
      if (!head) {
        return false;
      }

      if (index !== undefined) {
        return head.kind === 'index' && head.index === index;
      }

      return propertyName !== undefined && head.kind === 'property' && head.name === propertyName;
    });
  }

  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    isConstVariableDeclaration(parent)
  ) {
    const seedShape = getAllowedNamespaceSeedShape(context, expression);
    if (seedShape && canBindFromShape(parent.name, seedShape)) {
      return true;
    }

    return isWholeNamespaceShape(shape) &&
      ts.isObjectBindingPattern(parent.name) &&
      isSimpleNamespaceProjectionObjectPattern(parent.name);
  }

  if (ts.isExportAssignment(parent) && parent.expression === expression && !parent.isExportEquals) {
    return false;
  }

  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === expression
  ) {
    return false;
  }

  if (ts.isShorthandPropertyAssignment(parent) && parent.name === expression) {
    return false;
  }

  if (ts.isArrayLiteralExpression(parent)) {
    return false;
  }

  if (
    ts.isBinaryExpression(parent) &&
    parent.right === expression
  ) {
    return false;
  }

  if (
    (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.arguments?.includes(expression)
  ) {
    return false;
  }

  if (ts.isReturnStatement(parent) && parent.expression === expression) {
    return false;
  }

  if (
    (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
    parent.body === expression
  ) {
    return false;
  }

  if (ts.isConditionalExpression(parent) || ts.isExpressionStatement(parent)) {
    return false;
  }

  return false;
}

function shouldCheckNamespaceExpression(node: ts.Node): node is ts.Expression {
  if (
    !ts.isExpression(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return false;
  }

  if (!ts.isIdentifier(node)) {
    return true;
  }

  const parent = node.parent;
  if (!parent) {
    return true;
  }

  return !(
    (ts.isImportClause(parent) && parent.name === node) ||
    ts.isNamespaceImport(parent) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    isTypePositionIdentifier(node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
  );
}

function validateExportSpecifiers(
  context: AnalysisContext,
  diagnostics: SoundDiagnostic[],
): void {
  context.forEachSourceFile((sourceFile) => {
    context.traverse(sourceFile, (node) => {
      if (
        !ts.isExportSpecifier(node) ||
        node.parent.parent.moduleSpecifier
      ) {
        return;
      }

      const localName = node.propertyName ?? node.name;
      if (!ts.isIdentifier(localName)) {
        return;
      }

      const shape = getKnownNamespaceShape(context, localName);
      if (shape) {
        diagnostics.push(createNamespaceEscapeDiagnostic(node.name));
      }
    });
  });
}

export function runNamespaceObjectRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics = seedNamespaceFacts(context);
  validateExportSpecifiers(context, diagnostics);

  context.forEachSourceFile((sourceFile) => {
    context.traverse(sourceFile, (node) => {
      if (!shouldCheckNamespaceExpression(node)) {
        return;
      }

      const shape = getKnownNamespaceShape(context, node);
      if (!shape) {
        return;
      }

      if (!isAllowedNamespaceUse(context, node, shape)) {
        diagnostics.push(createNamespaceEscapeDiagnostic(node));
      }
    });
  });

  return diagnostics;
}
