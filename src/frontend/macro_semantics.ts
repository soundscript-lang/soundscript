import ts from 'typescript';

import { ERROR_STDLIB_DECLARATION_FILE } from './error_stdlib_support.ts';
import {
  RESULT_STDLIB_DECLARATION_FILE,
  STDLIB_DECLARATION_FILE,
} from './std_package_support.ts';
import { toSourceFileName } from './project_frontend.ts';
import type {
  CanonicalFailureInfo,
  MacroDependencyReference,
  MacroDependencySet,
  CanonicalResultCarrierInfo,
  CanonicalResultInfo,
  MacroFiniteCase,
  MacroFunctionContext,
  MacroRuntimeKind,
  MacroTryCarrierInfo,
  MacroType,
} from './macro_semantic_types.ts';
import {
  createMacroType,
  getInternalChecker,
  getInternalType,
} from './macro_type_internal.ts';
import type { SourceSpan } from './macro_types.ts';

const MAX_FINITE_CASE_COMBINATIONS = 64;
const BUILTIN_RUNTIME_CONSTRUCTOR_NAMES = new Set([
  'AggregateError',
  'ArrayBuffer',
  'BigInt64Array',
  'BigUint64Array',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'Float32Array',
  'Float64Array',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Map',
  'Promise',
  'RangeError',
  'ReferenceError',
  'RegExp',
  'Set',
  'SharedArrayBuffer',
  'SyntaxError',
  'TypeError',
  'URIError',
  'URL',
  'URLSearchParams',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakSet',
]);

export interface MacroSemantics {
  awaitedType(type: MacroType): MacroType;
  canonicalResultOfEnclosingFunctionNode(node: ts.Node): CanonicalResultInfo | undefined;
  classDeclarationOfTypeNode(node: ts.TypeNode): ts.ClassDeclaration | null;
  classifyCanonicalFailureType(type: MacroType): CanonicalFailureInfo | null;
  classifyCanonicalResultCarrierType(type: MacroType): CanonicalResultCarrierInfo | null;
  classifyCanonicalResultType(type: MacroType): CanonicalResultInfo | null;
  classifyTryCarrierType(type: MacroType): MacroTryCarrierInfo | null;
  enclosingFunctionOfNode(node: ts.Node): MacroFunctionContext | undefined;
  finiteCases(type: MacroType): readonly MacroFiniteCase[] | null;
  isAssignable(from: MacroType, to: MacroType): boolean;
  nullType(): MacroType;
  readSetOfNode(node: ts.Node): MacroDependencySet;
  typeOfNode(node: ts.Node): MacroType;
  undefinedType(): MacroType;
  valueBindingPromiseLikeInScope(name: string, node: ts.Node): boolean;
  valueBindingCallableInScope(name: string, node: ts.Node): boolean;
  valueBindingTypeInScope(name: string, node: ts.Node): MacroType | null;
  valueBindingInScope(name: string, node: ts.Node): boolean;
  writeSetOfNode(node: ts.Node): MacroDependencySet;
}

function createSourceSpan(node: ts.Node): SourceSpan {
  const sourceFile = node.getSourceFile();
  return {
    fileName: sourceFile.fileName,
    start: node.getStart(sourceFile),
    end: node.getEnd(),
  };
}

function getNodeType(checker: ts.TypeChecker, node: ts.Node): ts.Type {
  return ts.isTypeNode(node) ? checker.getTypeFromTypeNode(node) : checker.getTypeAtLocation(node);
}

function getFunctionReturnType(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Type | undefined {
  if (
    !ts.isFunctionLike(node) ||
    node.kind === ts.SyntaxKind.Constructor
  ) {
    return undefined;
  }

  const signature = checker.getSignatureFromDeclaration(node);
  return signature ? checker.getReturnTypeOfSignature(signature) : undefined;
}

function isAsyncFunctionLike(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ===
      true;
}

function isGeneratorFunctionLike(node: ts.Node): boolean {
  return 'asteriskToken' in node && !!node.asteriskToken;
}

function getDeclarationNameText(name: ts.DeclarationName | undefined): string | undefined {
  if (!name) {
    return undefined;
  }

  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function getFunctionLikeName(node: ts.Node): string | undefined {
  if (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)
  ) {
    const directName = getDeclarationNameText(node.name);
    if (directName) {
      return directName;
    }
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
  }

  return undefined;
}

function getTypeSymbol(type: ts.Type): ts.Symbol | undefined {
  return type.aliasSymbol ?? type.getSymbol();
}

function resolveClassDeclarationForTypeNode(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
): ts.ClassDeclaration | null {
  const type = checker.getTypeFromTypeNode(node);
  const symbol = (() => {
    if (ts.isTypeReferenceNode(node)) {
      return checker.getSymbolAtLocation(node.typeName) ?? getTypeSymbol(type);
    }
    return getTypeSymbol(type);
  })();
  if (!symbol) {
    return null;
  }
  return resolveAliasedSymbol(checker, symbol).declarations?.find(ts.isClassDeclaration) ?? null;
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function symbolHasValueMeaning(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  return (resolveAliasedSymbol(checker, symbol).flags & ts.SymbolFlags.Value) !== 0;
}

function findNamedValueSymbolInTable(
  checker: ts.TypeChecker,
  table: ts.SymbolTable | undefined,
  name: string,
): ts.Symbol | undefined {
  if (!table) {
    return undefined;
  }
  for (const symbol of table.values()) {
    if (symbol.getName() === name && symbolHasValueMeaning(checker, symbol)) {
      return symbol;
    }
  }
  return undefined;
}

function getLexicallyScopedValueSymbol(
  checker: ts.TypeChecker,
  node: ts.Node,
  name: string,
): ts.Symbol | undefined {
  let current: (ts.Node & { locals?: ts.SymbolTable }) | undefined =
    node as ts.Node & { locals?: ts.SymbolTable };
  while (current) {
    const symbol = findNamedValueSymbolInTable(checker, current.locals, name);
    if (symbol) {
      return symbol;
    }
    current = current.parent as (ts.Node & { locals?: ts.SymbolTable }) | undefined;
  }

  const sourceFile = node.getSourceFile() as ts.SourceFile & {
    locals?: ts.SymbolTable;
    symbol?: ts.Symbol & { exports?: ts.SymbolTable };
  };
  return findNamedValueSymbolInTable(checker, sourceFile.locals, name) ??
    findNamedValueSymbolInTable(checker, sourceFile.symbol?.exports, name);
}

function getSafeValueLookupAnchor(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Node {
  let current: ts.Node | undefined = node;
  let lastError: unknown = undefined;
  while (current) {
    try {
      checker.getSymbolsInScope(current, ts.SymbolFlags.Value | ts.SymbolFlags.Alias);
      return current;
    } catch (error) {
      lastError = error;
      current = current.parent;
    }
  }

  const sourceFile = node.getSourceFile();
  if (sourceFile !== node) {
    try {
      checker.getSymbolsInScope(sourceFile, ts.SymbolFlags.Value | ts.SymbolFlags.Alias);
      return sourceFile;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError !== undefined) {
    throw lastError;
  }

  return node;
}

function getValuePathBindingInScope(
  checker: ts.TypeChecker,
  node: ts.Node,
  name: string,
): { readonly fromAlias: boolean; readonly symbol: ts.Symbol; readonly type: ts.Type } | null {
  const segments = name.split('.').map((segment) => segment.trim()).filter((segment) =>
    segment.length > 0
  );
  const [root, ...rest] = segments;
  if (!root) {
    return null;
  }

  const sourceFile = node.getSourceFile();
  const rootSymbol = getLexicallyScopedValueSymbol(checker, node, root) ?? (() => {
    try {
      const lookupAnchor = getSafeValueLookupAnchor(checker, node);
      return checker.getSymbolsInScope(lookupAnchor, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
        .find((symbol) => symbol.getName() === root && symbolHasValueMeaning(checker, symbol));
    } catch {
      return undefined;
    }
  })();
  if (!rootSymbol) {
    return null;
  }

  const fromAlias = (rootSymbol.flags & ts.SymbolFlags.Alias) !== 0;
  let currentType = checker.getTypeOfSymbolAtLocation(
    rootSymbol,
    rootSymbol.valueDeclaration ?? rootSymbol.declarations?.[0] ?? sourceFile,
  );
  let currentSymbol = resolveAliasedSymbol(checker, rootSymbol);
  for (const segment of rest) {
    const property = checker.getPropertyOfType(currentType, segment);
    if (!property) {
      return null;
    }
    currentSymbol = property;
    currentType = checker.getTypeOfSymbolAtLocation(
      property,
      property.valueDeclaration ?? property.declarations?.[0] ?? sourceFile,
    );
  }

  return {
    fromAlias,
    symbol: resolveAliasedSymbol(checker, currentSymbol),
    type: currentType,
  };
}

function declarationIsCallable(declaration: ts.Declaration): boolean {
  return ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isCallSignatureDeclaration(declaration) ||
    (ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer)));
}

function typeIsPromiseLike(
  checker: ts.TypeChecker,
  type: ts.Type,
): boolean {
  const awaitedType = checker.getAwaitedType(type);
  return awaitedType !== undefined && awaitedType !== type;
}

function unwrapDependencyNode(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isPartiallyEmittedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isAssignmentOperatorToken(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isCompoundAssignmentOperatorToken(kind: ts.SyntaxKind): boolean {
  return kind !== ts.SyntaxKind.EqualsToken && isAssignmentOperatorToken(kind);
}

function isDeclarationNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === node && !!parent.objectAssignmentInitializer) ||
    (ts.isEnumMember(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeParameterDeclaration(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportEqualsDeclaration(parent) && parent.name === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    (ts.isBreakOrContinueStatement(parent) && parent.label === node) ||
    (ts.isJsxAttribute(parent) && parent.name === node) ||
    (ts.isJsxOpeningElement(parent) && parent.tagName === node) ||
    (ts.isJsxSelfClosingElement(parent) && parent.tagName === node) ||
    (ts.isJsxClosingElement(parent) && parent.tagName === node)
  );
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return true;
  }
  if (isDeclarationNameIdentifier(node)) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }
  if (ts.isQualifiedName(parent)) {
    return false;
  }
  if (ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)) {
    return false;
  }
  return true;
}

function collectDeclaredValueSymbols(
  checker: ts.TypeChecker,
  root: ts.Node,
): { readonly names: ReadonlySet<string>; readonly symbols: ReadonlySet<ts.Symbol> } {
  const names = new Set<string>();
  const symbols = new Set<ts.Symbol>();

  function addBindingName(name: ts.BindingName | ts.DeclarationName | undefined) {
    if (!name) {
      return;
    }
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol) {
        symbols.add(resolveAliasedSymbol(checker, symbol));
      }
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isOmittedExpression(element)) {
          continue;
        }
        addBindingName(element.name);
      }
    }
  }

  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      addBindingName(node.name);
    } else if (ts.isParameter(node)) {
      addBindingName(node.name);
    } else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
      addBindingName(node.name);
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      addBindingName(node.name);
    } else if (ts.isImportClause(node)) {
      addBindingName(node.name);
    } else if (ts.isNamespaceImport(node)) {
      addBindingName(node.name);
    } else if (ts.isImportSpecifier(node)) {
      addBindingName(node.name);
    }

    ts.forEachChild(node, visit);
  }

  visit(root);
  return { names, symbols };
}

function createDependencySetBuilder() {
  const dependencies = new Map<string, MacroDependencyReference>();
  let unknown = false;

  return {
    add(kind: MacroDependencyReference['kind'], name: string) {
      dependencies.set(`${kind}:${name}`, { kind, name });
    },
    markUnknown() {
      unknown = true;
    },
    build(): MacroDependencySet {
      return {
        dependencies: [...dependencies.values()],
        unknown,
      };
    },
  };
}

function collectDependencySets(
  checker: ts.TypeChecker,
  root: ts.Node,
): { readonly readSet: MacroDependencySet; readonly writeSet: MacroDependencySet } {
  const localDeclarations = collectDeclaredValueSymbols(checker, root);
  const rootSourceFile = root.getSourceFile();
  const rootStart = root.getStart(rootSourceFile, false);
  const rootEnd = root.end;
  const reads = createDependencySetBuilder();
  const writes = createDependencySetBuilder();

  function symbolDeclaredWithinRoot(symbol: ts.Symbol): boolean {
    return (resolveAliasedSymbol(checker, symbol).declarations ?? []).some((declaration) => {
      const sourceFile = declaration.getSourceFile();
      return sourceFile === rootSourceFile &&
        declaration.getStart(sourceFile, false) >= rootStart &&
        declaration.end <= rootEnd;
    });
  }

  function addBinding(builder: ReturnType<typeof createDependencySetBuilder>, identifier: ts.Identifier) {
    if (!isReferenceIdentifier(identifier)) {
      return;
    }
    if (localDeclarations.names.has(identifier.text)) {
      return;
    }
    const symbol = checker.getSymbolAtLocation(identifier);
    if (symbol) {
      const resolved = resolveAliasedSymbol(checker, symbol);
      if (
        localDeclarations.symbols.has(resolved) ||
        symbolDeclaredWithinRoot(resolved)
      ) {
        return;
      }
    }
    builder.add('binding', identifier.text);
  }

  function collectAccessRoot(
    node: ts.Expression,
    builder: ReturnType<typeof createDependencySetBuilder>,
    includeDynamicReads: boolean,
  ): void {
    const current = unwrapDependencyNode(node);
    if (ts.isIdentifier(current)) {
      addBinding(builder, current);
      return;
    }
    if (current.kind === ts.SyntaxKind.ThisKeyword) {
      return;
    }
    if (ts.isPropertyAccessExpression(current)) {
      const base = unwrapDependencyNode(current.expression);
      if (base.kind === ts.SyntaxKind.ThisKeyword) {
        builder.add('this-member', current.name.text);
        return;
      }
      collectAccessRoot(current.expression, builder, includeDynamicReads);
      return;
    }
    if (ts.isElementAccessExpression(current)) {
      const base = unwrapDependencyNode(current.expression);
      if (base.kind === ts.SyntaxKind.ThisKeyword) {
        builder.markUnknown();
      } else {
        collectAccessRoot(current.expression, builder, includeDynamicReads);
        builder.markUnknown();
      }
      if (includeDynamicReads && current.argumentExpression) {
        collectReadDependencies(current.argumentExpression);
      }
      return;
    }
    collectReadDependencies(current);
  }

  function collectAssignmentTarget(node: ts.Node): void {
    const current = unwrapDependencyNode(node);
    if (ts.isIdentifier(current)) {
      addBinding(writes, current);
      return;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      collectAccessRoot(current, writes, false);
      if (ts.isElementAccessExpression(current)) {
        writes.markUnknown();
      }
      return;
    }
    if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (ts.isOmittedExpression(element)) {
          continue;
        }
        if (ts.isSpreadElement(element)) {
          collectAssignmentTarget(element.expression);
        } else {
          collectAssignmentTarget(element);
        }
      }
      return;
    }
    if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          collectAssignmentTarget(property.name);
        } else if (ts.isPropertyAssignment(property)) {
          collectAssignmentTarget(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          collectAssignmentTarget(property.expression);
        }
      }
      return;
    }
    writes.markUnknown();
  }

  function collectReadDependencies(node: ts.Node): void {
    const current = unwrapDependencyNode(node);
    if (ts.isIdentifier(current)) {
      addBinding(reads, current);
      return;
    }
    if (ts.isPropertyAccessExpression(current)) {
      const parent = current.parent;
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === current
      ) {
        return;
      }
      collectAccessRoot(current, reads, true);
      return;
    }
    if (ts.isElementAccessExpression(current)) {
      const parent = current.parent;
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === current
      ) {
        return;
      }
      collectAccessRoot(current, reads, true);
      return;
    }
    if (ts.isBinaryExpression(current) && isAssignmentOperatorToken(current.operatorToken.kind)) {
      if (isCompoundAssignmentOperatorToken(current.operatorToken.kind)) {
        collectAccessRoot(current.left as ts.Expression, reads, true);
      }
      collectAssignmentTarget(current.left);
      collectReadDependencies(current.right);
      return;
    }
    if (
      ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)
    ) {
      if (
        current.operator === ts.SyntaxKind.PlusPlusToken ||
        current.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        collectAccessRoot(current.operand, reads, true);
        collectAssignmentTarget(current.operand);
        return;
      }
    }
    if (ts.isVariableDeclaration(current)) {
      if (current.initializer) {
        collectReadDependencies(current.initializer);
      }
      return;
    }
    if (ts.isParameter(current)) {
      if (current.initializer) {
        collectReadDependencies(current.initializer);
      }
      return;
    }
    if (ts.isPropertyAssignment(current)) {
      collectReadDependencies(current.initializer);
      return;
    }
    if (ts.isShorthandPropertyAssignment(current)) {
      addBinding(reads, current.name);
      if (current.objectAssignmentInitializer) {
        collectReadDependencies(current.objectAssignmentInitializer);
      }
      return;
    }
    ts.forEachChild(current, collectReadDependencies);
  }

  function collectWriteDependencies(node: ts.Node): void {
    const current = unwrapDependencyNode(node);
    if (ts.isBinaryExpression(current) && isAssignmentOperatorToken(current.operatorToken.kind)) {
      collectAssignmentTarget(current.left);
      collectWriteDependencies(current.right);
      return;
    }
    if (
      ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)
    ) {
      if (
        current.operator === ts.SyntaxKind.PlusPlusToken ||
        current.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        collectAssignmentTarget(current.operand);
        return;
      }
    }
    if (ts.isVariableDeclaration(current)) {
      if (current.initializer) {
        collectWriteDependencies(current.initializer);
      }
      return;
    }
    if (ts.isParameter(current)) {
      if (current.initializer) {
        collectWriteDependencies(current.initializer);
      }
      return;
    }
    ts.forEachChild(current, collectWriteDependencies);
  }

  collectReadDependencies(root);
  collectWriteDependencies(root);
  return {
    readSet: reads.build(),
    writeSet: writes.build(),
  };
}

function normalizeFileNameForComparison(fileName: string): string {
  return fileName.replaceAll('\\', '/');
}

function isCheckedInResultStdlibFile(fileName: string): boolean {
  return fileName.endsWith('/src/stdlib/result.d.ts') ||
    fileName.endsWith('/src/stdlib/result.ts') ||
    fileName.endsWith('/src/stdlib/index.d.ts') ||
    fileName.endsWith('/src/stdlib/index.ts');
}

function isInstalledResultStdlibFile(fileName: string): boolean {
  return fileName.endsWith('/node_modules/@soundscript/soundscript/result.d.ts') ||
    fileName.endsWith('/node_modules/@soundscript/soundscript/result.js') ||
    fileName.endsWith('/node_modules/@soundscript/soundscript/index.d.ts') ||
    fileName.endsWith('/node_modules/@soundscript/soundscript/index.js');
}

function isCheckedInErrorStdlibFile(fileName: string): boolean {
  return fileName.endsWith('/src/stdlib/failures.d.ts') ||
    fileName.endsWith('/src/stdlib/failures.ts') ||
    fileName.endsWith('/src/stdlib/index.d.ts') ||
    fileName.endsWith('/src/stdlib/index.ts');
}

function isInstalledErrorStdlibFile(fileName: string): boolean {
  return fileName.endsWith('/node_modules/@soundscript/soundscript/failures.d.ts') ||
    fileName.endsWith('/node_modules/@soundscript/soundscript/failures.js') ||
    fileName.endsWith('/node_modules/@soundscript/soundscript/index.d.ts') ||
    fileName.endsWith('/node_modules/@soundscript/soundscript/index.js');
}

function isCheckedInRootStdlibFile(fileName: string): boolean {
  return fileName.endsWith('/src/stdlib/index.d.ts') || fileName.endsWith('/src/stdlib/index.ts');
}

function isInstalledRootStdlibFile(fileName: string): boolean {
  return fileName.endsWith('/node_modules/@soundscript/soundscript/index.d.ts') ||
    fileName.endsWith('/node_modules/@soundscript/soundscript/index.js');
}

function symbolIsOwnedByResultStdlibModule(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  exportName: string,
): boolean {
  const resolved = resolveAliasedSymbol(checker, symbol);
  if (resolved.getName() !== exportName) {
    return false;
  }

  return (resolved.declarations ?? []).some((declaration) => {
    const fileName = normalizeFileNameForComparison(declaration.getSourceFile().fileName);
    return fileName === RESULT_STDLIB_DECLARATION_FILE ||
      fileName === STDLIB_DECLARATION_FILE ||
      isCheckedInResultStdlibFile(fileName) ||
      isInstalledResultStdlibFile(fileName) ||
      isCheckedInRootStdlibFile(fileName) ||
      isInstalledRootStdlibFile(fileName);
  });
}

function symbolIsOwnedByErrorStdlibModule(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  exportName: string,
): boolean {
  const resolved = resolveAliasedSymbol(checker, symbol);
  if (resolved.getName() !== exportName) {
    return false;
  }

  return (resolved.declarations ?? []).some((declaration) => {
    const fileName = normalizeFileNameForComparison(declaration.getSourceFile().fileName);
    return fileName === ERROR_STDLIB_DECLARATION_FILE ||
      fileName === STDLIB_DECLARATION_FILE ||
      isCheckedInErrorStdlibFile(fileName) ||
      isInstalledErrorStdlibFile(fileName);
  });
}

function getBaseTypes(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return [];
  }

  const objectType = type as ts.ObjectType;
  if (
    (objectType.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface |
      ts.ObjectFlags.Reference)) === 0
  ) {
    return [];
  }

  return checker.getBaseTypes(objectType as ts.InterfaceType);
}

function typeExtendsCanonicalFailure(
  checker: ts.TypeChecker,
  type: ts.Type,
  seen = new Set<ts.Type>(),
): boolean {
  if (seen.has(type)) {
    return false;
  }
  seen.add(type);

  const symbol = getTypeSymbol(type);
  if (symbol && symbolIsOwnedByErrorStdlibModule(checker, symbol, 'Failure')) {
    return true;
  }

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.every((member) =>
      typeExtendsCanonicalFailure(checker, member, seen)
    );
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((member) =>
      typeExtendsCanonicalFailure(checker, member, seen)
    );
  }

  return getBaseTypes(checker, type).some((baseType) =>
    typeExtendsCanonicalFailure(checker, baseType, seen)
  );
}

function getTypeArguments(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  if (type.aliasTypeArguments && type.aliasTypeArguments.length > 0) {
    return type.aliasTypeArguments;
  }

  return checker.getTypeArguments(type as ts.TypeReference);
}

function getLiteralCodeForType(checker: ts.TypeChecker, type: ts.Type): string | null {
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    return JSON.stringify((type as ts.StringLiteralType).value);
  }

  if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
    return String((type as ts.NumberLiteralType).value);
  }

  if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    return checker.typeToString(type);
  }

  if ((type.flags & ts.TypeFlags.Null) !== 0) {
    return 'null';
  }

  return null;
}

function isClassInstanceType(checker: ts.TypeChecker, type: ts.Type): string | null {
  const symbol = getTypeSymbol(type);
  if (!symbol) {
    return null;
  }

  const resolved = resolveAliasedSymbol(checker, symbol);
  const declaration = resolved.declarations?.find((candidate) => ts.isClassLike(candidate));
  if (!declaration) {
    return null;
  }

  return resolved.getName();
}

function builtinRuntimeConstructorName(checker: ts.TypeChecker, type: ts.Type): string | null {
  const displayText = checker.typeToString(type);
  const baseName = displayText.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0] ?? null;
  if (!baseName || !BUILTIN_RUNTIME_CONSTRUCTOR_NAMES.has(baseName)) {
    return null;
  }

  return baseName;
}

function combineFiniteCaseOptions(
  optionSets: readonly (readonly (MacroFiniteCase | null)[])[],
): readonly (readonly (MacroFiniteCase | null)[])[] | null {
  let combinations: (MacroFiniteCase | null)[][] = [[]];

  for (const optionSet of optionSets) {
    const next: (MacroFiniteCase | null)[][] = [];
    for (const combination of combinations) {
      for (const option of optionSet) {
        next.push([...combination, option]);
        if (next.length > MAX_FINITE_CASE_COMBINATIONS) {
          return null;
        }
      }
    }
    combinations = next;
  }

  return combinations;
}

function getSingleFiniteTupleCase(
  checker: ts.TypeChecker,
  type: ts.Type,
  visiting: Set<ts.Type>,
): MacroFiniteCase | null {
  if (!checker.isTupleType(type) || (type.flags & ts.TypeFlags.Object) === 0) {
    return null;
  }

  const tupleType = type as ts.TypeReference;
  const tupleTarget = tupleType.target as ts.TupleType;
  if (
    (tupleTarget.combinedFlags & ts.ElementFlags.Variable) ||
    tupleTarget.minLength !== tupleTarget.fixedLength
  ) {
    return null;
  }
  if (visiting.has(type)) {
    return null;
  }

  visiting.add(type);
  try {
    const elements = checker.getTypeArguments(tupleType).map((elementType) => ({
      finiteCase: getSingleFiniteCaseForTsType(checker, elementType, visiting),
    }));
    return {
      elements,
      exactLength: tupleTarget.fixedLength,
      kind: 'array',
    };
  } finally {
    visiting.delete(type);
  }
}

function getFiniteTupleCases(
  checker: ts.TypeChecker,
  type: ts.Type,
  visiting: Set<ts.Type>,
): readonly MacroFiniteCase[] | null {
  if (!checker.isTupleType(type) || (type.flags & ts.TypeFlags.Object) === 0) {
    return null;
  }

  const tupleType = type as ts.TypeReference;
  const tupleTarget = tupleType.target as ts.TupleType;
  if (tupleTarget.combinedFlags & ts.ElementFlags.Variable) {
    return null;
  }
  if (visiting.has(type)) {
    return null;
  }

  visiting.add(type);
  try {
    const elementTypes = checker.getTypeArguments(tupleType);
    const finiteCases: MacroFiniteCase[] = [];
    for (let length = tupleTarget.minLength; length <= tupleTarget.fixedLength; length += 1) {
      const elementOptions = elementTypes
        .slice(0, length)
        .map((elementType) =>
          getFiniteCasesForTsTypeInternal(checker, elementType, visiting) ?? [null]
        );
      const elementCombinations = combineFiniteCaseOptions(elementOptions);
      if (!elementCombinations) {
        return null;
      }
      for (const elementCombination of elementCombinations) {
        finiteCases.push({
          elements: elementCombination.map((finiteCase) => ({ finiteCase })),
          exactLength: length,
          kind: 'array',
        });
      }
    }
    return finiteCases;
  } finally {
    visiting.delete(type);
  }
}

function getFiniteObjectCases(
  checker: ts.TypeChecker,
  type: ts.Type,
  visiting: Set<ts.Type>,
): readonly MacroFiniteCase[] | null {
  if (visiting.has(type)) {
    return null;
  }

  visiting.add(type);
  try {
    const properties = checker.getPropertiesOfType(type);
    if (properties.length === 0) {
      return null;
    }

    const propertyOptions: (readonly (MacroFiniteCase | null)[])[] = [];
    const propertyKeys: string[] = [];
    let hasFiniteDetail = false;
    for (const property of properties) {
      if ((property.flags & ts.SymbolFlags.Optional) !== 0) {
        return null;
      }

      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) {
        propertyKeys.push(property.getName());
        propertyOptions.push([null]);
        continue;
      }
      const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
      const finiteCases = getFiniteCasesForTsTypeInternal(checker, propertyType, visiting);
      if (finiteCases !== null) {
        hasFiniteDetail = true;
      }
      propertyKeys.push(property.getName());
      propertyOptions.push(finiteCases ?? [null]);
    }

    if (!hasFiniteDetail) {
      return null;
    }

    const propertyCombinations = combineFiniteCaseOptions(propertyOptions);
    if (!propertyCombinations) {
      return null;
    }

    return propertyCombinations.map((propertyCombination) => ({
      kind: 'object',
      properties: propertyCombination.map((finiteCase, index) => ({
        finiteCase,
        key: propertyKeys[index]!,
      })),
    }));
  } finally {
    visiting.delete(type);
  }
}

function getRuntimeKindFiniteCase(
  checker: ts.TypeChecker,
  type: ts.Type,
): Extract<MacroFiniteCase, { kind: 'runtime' }> | null {
  const runtimeKind = getRuntimeKindForTsType(checker, type);
  return runtimeKind ? { kind: 'runtime', typeName: runtimeKind } : null;
}

function getRuntimeKindForTsType(
  checker: ts.TypeChecker,
  type: ts.Type,
): MacroRuntimeKind | null {
  const aliasName = type.aliasSymbol?.getName();
  if (
    aliasName === 'f64' ||
    aliasName === 'f32' ||
    aliasName === 'i8' ||
    aliasName === 'i16' ||
    aliasName === 'i32' ||
    aliasName === 'i64' ||
    aliasName === 'u8' ||
    aliasName === 'u16' ||
    aliasName === 'u32' ||
    aliasName === 'u64'
  ) {
    return aliasName;
  }

  if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) {
    return 'undefined';
  }

  if ((type.flags & ts.TypeFlags.StringLike) !== 0) {
    return 'string';
  }

  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return 'number';
  }

  if ((type.flags & ts.TypeFlags.BigIntLike) !== 0) {
    return 'bigint';
  }

  if ((type.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
    return 'symbol';
  }

  if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0) {
    return 'function';
  }

  if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0) {
    return 'object';
  }

  return null;
}

function getSingleFiniteCaseForTsType(
  checker: ts.TypeChecker,
  type: ts.Type,
  visiting: Set<ts.Type> = new Set(),
): MacroFiniteCase | null {
  const literalCode = getLiteralCodeForType(checker, type);
  if (literalCode !== null) {
    return { kind: 'literal', code: literalCode };
  }

  const className = isClassInstanceType(checker, type);
  if (className) {
    return { kind: 'class', className };
  }

  const builtinClassName = builtinRuntimeConstructorName(checker, type);
  if (builtinClassName) {
    return { kind: 'class', className: builtinClassName };
  }

  return getSingleFiniteTupleCase(checker, type, visiting) ??
    getRuntimeKindFiniteCase(checker, type);
}

function getFiniteCasesForTsTypeInternal(
  checker: ts.TypeChecker,
  type: ts.Type,
  visiting: Set<ts.Type>,
): readonly MacroFiniteCase[] | null {
  if ((type.flags & ts.TypeFlags.Boolean) !== 0) {
    return [
      { kind: 'literal', code: 'true' },
      { kind: 'literal', code: 'false' },
    ];
  }

  if (type.isUnion()) {
    const finiteCases: MacroFiniteCase[] = [];
    for (const member of type.types) {
      const memberCases = getFiniteCasesForTsTypeInternal(checker, member, visiting);
      if (!memberCases) {
        return null;
      }
      finiteCases.push(...memberCases);
      if (finiteCases.length > MAX_FINITE_CASE_COMBINATIONS) {
        return null;
      }
    }
    return finiteCases;
  }

  const baseFiniteCase = getSingleFiniteCaseForTsType(checker, type, visiting);
  if (baseFiniteCase?.kind === 'literal' || baseFiniteCase?.kind === 'class') {
    return [baseFiniteCase];
  }
  if (baseFiniteCase?.kind === 'runtime' && baseFiniteCase.typeName !== 'object') {
    return [baseFiniteCase];
  }

  const tupleCases = getFiniteTupleCases(checker, type, visiting);
  if (tupleCases) {
    return tupleCases;
  }

  const objectCases = getFiniteObjectCases(checker, type, visiting);
  if (objectCases) {
    return objectCases;
  }

  return baseFiniteCase ? [baseFiniteCase] : null;
}

function getFiniteCasesForTsType(
  checker: ts.TypeChecker,
  type: ts.Type,
): readonly MacroFiniteCase[] | null {
  return getFiniteCasesForTsTypeInternal(checker, type, new Set());
}

function classifyCanonicalResultTsType(
  checker: ts.TypeChecker,
  tsType: ts.Type,
): CanonicalResultInfo | null {
  const symbol = getTypeSymbol(tsType);
  if (symbol) {
    if (symbolIsOwnedByResultStdlibModule(checker, symbol, 'Result')) {
      const typeArguments = getTypeArguments(checker, tsType);
      if (typeArguments.length !== 2) {
        return null;
      }

      const [okType, errType] = typeArguments;
      return {
        errType: createMacroType(checker, errType),
        family: 'result',
        okType: createMacroType(checker, okType),
        resultType: createMacroType(checker, tsType),
      };
    }

    if (symbolIsOwnedByResultStdlibModule(checker, symbol, 'Option')) {
      const typeArguments = getTypeArguments(checker, tsType);
      if (typeArguments.length !== 1) {
        return null;
      }

      const [okType] = typeArguments;
      const voidType = checker.getVoidType();
      return {
        errType: createMacroType(checker, voidType),
        family: 'option',
        okType: createMacroType(checker, okType),
        resultType: createMacroType(checker, tsType),
      };
    }
  }

  if ((tsType.flags & ts.TypeFlags.Union) === 0) {
    return null;
  }

  const members = (tsType as ts.UnionType).types;
  const okMember = members.find((member) => {
    const memberSymbol = getTypeSymbol(member);
    return memberSymbol !== undefined && symbolIsOwnedByResultStdlibModule(checker, memberSymbol, 'Ok');
  });
  const errMember = members.find((member) => {
    const memberSymbol = getTypeSymbol(member);
    return memberSymbol !== undefined && symbolIsOwnedByResultStdlibModule(checker, memberSymbol, 'Err');
  });
  if (okMember && errMember) {
    const [okType] = getTypeArguments(checker, okMember);
    const [errType] = getTypeArguments(checker, errMember);
    if (!okType || !errType) {
      return null;
    }

    return {
      errType: createMacroType(checker, errType),
      family: 'result',
      okType: createMacroType(checker, okType),
      resultType: createMacroType(checker, tsType),
    };
  }

  const someMember = members.find((member) => {
    const memberSymbol = getTypeSymbol(member);
    return memberSymbol !== undefined && symbolIsOwnedByResultStdlibModule(checker, memberSymbol, 'Some');
  });
  const noneMember = members.find((member) => {
    const memberSymbol = getTypeSymbol(member);
    return memberSymbol !== undefined && symbolIsOwnedByResultStdlibModule(checker, memberSymbol, 'None');
  });
  if (someMember && noneMember) {
    const [okType] = getTypeArguments(checker, someMember);
    if (!okType) {
      return null;
    }

    const voidType = checker.getVoidType();
    return {
      errType: createMacroType(checker, voidType),
      family: 'option',
      okType: createMacroType(checker, okType),
      resultType: createMacroType(checker, tsType),
    };
  }

  return null;
}

function classifyCanonicalPromiseResultTsType(
  checker: ts.TypeChecker,
  tsType: ts.Type,
): CanonicalResultInfo | null {
  const symbol = getTypeSymbol(tsType);
  if (!symbol || resolveAliasedSymbol(checker, symbol).getName() !== 'Promise') {
    return null;
  }

  const [promisedType] = getTypeArguments(checker, tsType);
  return promisedType ? classifyCanonicalResultTsType(checker, promisedType) : null;
}

function mergeInferredResultSideTypes(
  checker: ts.TypeChecker,
  current: ts.Type,
  next: ts.Type,
): ts.Type | null {
  if ((current.flags & ts.TypeFlags.Never) !== 0) {
    return next;
  }
  if ((next.flags & ts.TypeFlags.Never) !== 0) {
    return current;
  }
  if (checker.isTypeAssignableTo(next, current)) {
    return current;
  }
  if (checker.isTypeAssignableTo(current, next)) {
    return next;
  }
  return null;
}

function inferCanonicalResultTsTypeFromFunctionReturns(
  checker: ts.TypeChecker,
  node: ts.Node,
): CanonicalResultInfo | null {
  if (
    !ts.isFunctionLike(node) ||
    node.kind === ts.SyntaxKind.Constructor
  ) {
    return null;
  }

  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
    return classifyCanonicalResultTsType(checker, checker.getTypeAtLocation(node.body));
  }

  const body = 'body' in node ? node.body : undefined;
  if (!body || !ts.isBlock(body)) {
    return null;
  }

  let inferred: CanonicalResultInfo | null = null;
  let sawReturn = false;
  let failed = false;

  function visit(current: ts.Node) {
    if (failed) {
      return;
    }
    if (ts.isFunctionLike(current) && current !== node) {
      return;
    }
    if (ts.isReturnStatement(current)) {
      sawReturn = true;
      if (!current.expression) {
        failed = true;
        return;
      }

      const info = classifyCanonicalResultTsType(
        checker,
        checker.getTypeAtLocation(current.expression),
      );
      if (!info) {
        failed = true;
        return;
      }

      if (!inferred) {
        inferred = info;
        return;
      }

      if (inferred.family !== info.family) {
        failed = true;
        return;
      }

      const mergedOkType = mergeInferredResultSideTypes(
        checker,
        getInternalType(inferred.okType),
        getInternalType(info.okType),
      );
      const mergedErrType = mergeInferredResultSideTypes(
        checker,
        getInternalType(inferred.errType),
        getInternalType(info.errType),
      );
      if (!mergedOkType || !mergedErrType) {
        failed = true;
        return;
      }

      inferred = {
        errType: createMacroType(checker, mergedErrType),
        family: inferred.family,
        okType: createMacroType(checker, mergedOkType),
        resultType: inferred.resultType,
      };
      return;
    }

    ts.forEachChild(current, visit);
  }

  visit(body);
  return failed || !sawReturn ? null : inferred;
}

function classifyEffectiveFunctionResultTsType(
  checker: ts.TypeChecker,
  node: ts.Node,
): CanonicalResultInfo | null {
  if (
    !ts.isFunctionLike(node) ||
    node.kind === ts.SyntaxKind.Constructor
  ) {
    return null;
  }

  const returnType = getFunctionReturnType(checker, node);
  if (returnType) {
    const signatureResult = isAsyncFunctionLike(node)
      ? classifyCanonicalPromiseResultTsType(checker, returnType)
      : classifyCanonicalResultTsType(checker, returnType);
    if (signatureResult || node.type) {
      return signatureResult;
    }
  }

  return inferCanonicalResultTsTypeFromFunctionReturns(checker, node);
}

function classifyTryCarrierTsType(
  checker: ts.TypeChecker,
  tsType: ts.Type,
): MacroTryCarrierInfo | null {
  const resultInfo = classifyCanonicalResultTsType(checker, tsType);
  if (resultInfo) {
    return {
      ...resultInfo,
      kind: 'result',
    };
  }

  const hasNull = checker.isTypeAssignableTo(checker.getNullType(), tsType);
  const hasUndefined = checker.isTypeAssignableTo(checker.getUndefinedType(), tsType);
  if (!hasNull && !hasUndefined) {
    return null;
  }

  const valueType = checker.getNonNullableType(tsType);
  if ((valueType.flags & ts.TypeFlags.Never) !== 0) {
    return null;
  }
  if (valueType === tsType) {
    return null;
  }

  return {
    carrierType: createMacroType(checker, tsType),
    kind: 'nullish',
    nullishKinds: [
      ...(hasNull ? ['null' as const] : []),
      ...(hasUndefined ? ['undefined' as const] : []),
    ],
    valueType: createMacroType(checker, valueType),
  };
}

export function createMacroSemantics(program: ts.Program): MacroSemantics {
  const checker = program.getTypeChecker();

  return {
    awaitedType(type: MacroType): MacroType {
      const typeChecker = getInternalChecker(type);
      const tsType = getInternalType(type);
      return createMacroType(typeChecker, typeChecker.getAwaitedType(tsType) ?? tsType);
    },

    classDeclarationOfTypeNode(node: ts.TypeNode): ts.ClassDeclaration | null {
      return resolveClassDeclarationForTypeNode(checker, node);
    },

    canonicalResultOfEnclosingFunctionNode(node: ts.Node): CanonicalResultInfo | undefined {
      let current: ts.Node | undefined = node;
      while (current) {
        if (ts.isFunctionLike(current) && current.kind !== ts.SyntaxKind.Constructor) {
          return classifyEffectiveFunctionResultTsType(checker, current) ?? undefined;
        }

        current = current.parent;
      }

      return undefined;
    },

    classifyCanonicalFailureType(type: MacroType): CanonicalFailureInfo | null {
      const tsType = getInternalType(type);
      if (!typeExtendsCanonicalFailure(checker, tsType)) {
        return null;
      }
      return {
        failureType: createMacroType(getInternalChecker(type), tsType),
      };
    },

    classifyCanonicalResultCarrierType(type: MacroType): CanonicalResultCarrierInfo | null {
      const typeChecker = getInternalChecker(type);
      const tsType = getInternalType(type);
      const directResult = classifyCanonicalResultTsType(typeChecker, tsType);
      if (directResult) {
        return {
          ...directResult,
          requiresAwait: false,
        };
      }

      const awaitedType = typeChecker.getAwaitedType(tsType);
      if (!awaitedType || awaitedType === tsType) {
        const promisedResult = classifyCanonicalPromiseResultTsType(typeChecker, tsType);
        return promisedResult
          ? {
            ...promisedResult,
            requiresAwait: true,
          }
          : null;
      }

      const awaitedResult = classifyCanonicalResultTsType(typeChecker, awaitedType);
      if (!awaitedResult) {
        const promisedResult = classifyCanonicalPromiseResultTsType(typeChecker, tsType);
        return promisedResult
          ? {
            ...promisedResult,
            requiresAwait: true,
          }
          : null;
      }

      return {
        ...awaitedResult,
        requiresAwait: true,
      };
    },

    classifyCanonicalResultType(type: MacroType): CanonicalResultInfo | null {
      return classifyCanonicalResultTsType(getInternalChecker(type), getInternalType(type));
    },

    classifyTryCarrierType(type: MacroType): MacroTryCarrierInfo | null {
      return classifyTryCarrierTsType(getInternalChecker(type), getInternalType(type));
    },

    finiteCases(type: MacroType): readonly MacroFiniteCase[] | null {
      return getFiniteCasesForTsType(getInternalChecker(type), getInternalType(type));
    },

    enclosingFunctionOfNode(node: ts.Node): MacroFunctionContext | undefined {
      let current: ts.Node | undefined = node;
      while (current) {
        if (ts.isFunctionLike(current) && current.kind !== ts.SyntaxKind.Constructor) {
          const returnType = getFunctionReturnType(checker, current);
          if (!returnType) {
            return undefined;
          }

          return {
            fileName: toSourceFileName(current.getSourceFile().fileName),
            hasDeclaredReturnType: current.type !== undefined,
            isAsync: isAsyncFunctionLike(current),
            isGenerator: isGeneratorFunctionLike(current),
            name: getFunctionLikeName(current),
            returnType: createMacroType(checker, returnType),
            span: createSourceSpan(current),
          };
        }

        current = current.parent;
      }

      return undefined;
    },

    isAssignable(from: MacroType, to: MacroType): boolean {
      const fromChecker = getInternalChecker(from);
      const toChecker = getInternalChecker(to);
      if (fromChecker === toChecker) {
        return fromChecker.isTypeAssignableTo(getInternalType(from), getInternalType(to));
      }

      return checker.isTypeAssignableTo(getInternalType(from), getInternalType(to));
    },

    nullType(): MacroType {
      return createMacroType(checker, checker.getNullType());
    },

    readSetOfNode(node: ts.Node): MacroDependencySet {
      return collectDependencySets(checker, node).readSet;
    },

    typeOfNode(node: ts.Node): MacroType {
      return createMacroType(checker, getNodeType(checker, node));
    },

    undefinedType(): MacroType {
      return createMacroType(checker, checker.getUndefinedType());
    },

    valueBindingPromiseLikeInScope(name: string, node: ts.Node): boolean {
      const binding = getValuePathBindingInScope(checker, node, name);
      if (!binding) {
        return false;
      }
      if (typeIsPromiseLike(checker, binding.type)) {
        return true;
      }
      return checker.getSignaturesOfType(binding.type, ts.SignatureKind.Call).some((signature) =>
        typeIsPromiseLike(checker, checker.getReturnTypeOfSignature(signature))
      );
    },

    valueBindingCallableInScope(name: string, node: ts.Node): boolean {
      const binding = getValuePathBindingInScope(checker, node, name);
      if (!binding) {
        return false;
      }
      return checker.getSignaturesOfType(binding.type, ts.SignatureKind.Call).length > 0 ||
        (binding.fromAlias && (binding.type.flags & ts.TypeFlags.Any) !== 0) ||
        (binding.symbol.declarations ?? []).some(declarationIsCallable);
    },

    valueBindingTypeInScope(name: string, node: ts.Node): MacroType | null {
      const binding = getValuePathBindingInScope(checker, node, name);
      return binding ? createMacroType(checker, binding.type) : null;
    },

    valueBindingInScope(name: string, node: ts.Node): boolean {
      return getValuePathBindingInScope(checker, node, name) !== null;
    },

    writeSetOfNode(node: ts.Node): MacroDependencySet {
      return collectDependencySets(checker, node).writeSet;
    },
  };
}
