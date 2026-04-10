import ts from 'typescript';

export interface ValuePathBinding {
  readonly fromAlias: boolean;
  readonly symbol: ts.Symbol;
  readonly type: ts.Type;
}

export function resolveAliasedSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): ts.Symbol {
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
  let current: (ts.Node & { locals?: ts.SymbolTable }) | undefined = node as ts.Node & {
    locals?: ts.SymbolTable;
  };
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

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error('Unable to resolve a value-lookup anchor for the current node.');
}

export function getValuePathBindingInScope(
  checker: ts.TypeChecker,
  node: ts.Node,
  name: string,
): ValuePathBinding | null {
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
