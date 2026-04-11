import ts from 'typescript';

import {
  createAnnotationLookup,
  type ParsedAnnotationValue,
} from '../language/annotation_syntax.ts';
import type { SourceSpan } from './macro_types.ts';

export type ImportedBindingUsage = 'compileTimeOnly' | 'mixed' | 'runtimeOnly';

function spanKey(start: number, end: number): string {
  return `${start}:${end}`;
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isArrowFunction(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isLabeledStatement(parent) && parent.label === node) ||
    (ts.isBreakStatement(parent) && parent.label === node) ||
    (ts.isContinueStatement(parent) && parent.label === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isImportEqualsDeclaration(parent) && parent.name === node) ||
    (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isTypeParameterDeclaration(parent) && parent.name === node)
  ) {
    return false;
  }

  return true;
}

function collectImportedLocalNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }

    if (statement.importClause.name) {
      names.add(statement.importClause.name.text);
    }

    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) {
      continue;
    }

    if (ts.isNamespaceImport(namedBindings)) {
      names.add(namedBindings.name.text);
      continue;
    }

    for (const element of namedBindings.elements) {
      names.add(element.name.text);
    }
  }

  return names;
}

function collectAnnotationIdentifierReferences(
  value: ParsedAnnotationValue,
  names: Set<string>,
): void {
  switch (value.kind) {
    case 'identifier':
      names.add(value.name);
      return;
    case 'array':
      for (const element of value.elements) {
        collectAnnotationIdentifierReferences(element, names);
      }
      return;
    case 'object':
      for (const property of value.properties) {
        collectAnnotationIdentifierReferences(property.value, names);
      }
      return;
    case 'boolean':
    case 'number':
    case 'string':
      return;
  }
}

function collectCompileTimeAnnotationNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const annotationLookup = createAnnotationLookup(sourceFile);

  for (const block of annotationLookup.getBlocks()) {
    for (const annotation of block.annotations) {
      const rootName = annotation.name.split('.')[0];
      if (rootName) {
        names.add(rootName);
      }
      for (const argument of annotation.arguments ?? []) {
        collectAnnotationIdentifierReferences(argument.value, names);
      }
    }
  }

  return names;
}

export function collectRuntimeReferencedImportedBindings(
  sourceFile: ts.SourceFile,
  candidateNames: ReadonlySet<string> = collectImportedLocalNames(sourceFile),
  excludedReferenceSpans: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const referenced = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) && candidateNames.has(node.text) && isIdentifierReference(node) &&
      !excludedReferenceSpans.has(spanKey(node.getStart(sourceFile, false), node.end))
    ) {
      referenced.add(node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return referenced;
}

export function classifyImportedBindingUsage(
  sourceFile: ts.SourceFile,
  compileTimeMacroNames: ReadonlySet<string> = new Set(),
  compileTimeReferenceSpans: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, ImportedBindingUsage> {
  const importedLocalNames = collectImportedLocalNames(sourceFile);
  const compileTimeNames = new Set<string>(compileTimeMacroNames);
  for (const name of collectCompileTimeAnnotationNames(sourceFile)) {
    compileTimeNames.add(name);
  }
  const runtimeNames = collectRuntimeReferencedImportedBindings(
    sourceFile,
    importedLocalNames,
    compileTimeReferenceSpans,
  );
  const usage = new Map<string, ImportedBindingUsage>();

  for (const localName of importedLocalNames) {
    const hasCompileTimeUse = compileTimeNames.has(localName);
    const hasRuntimeUse = runtimeNames.has(localName);
    if (hasCompileTimeUse && hasRuntimeUse) {
      usage.set(localName, 'mixed');
    } else if (hasCompileTimeUse) {
      usage.set(localName, 'compileTimeOnly');
    } else if (hasRuntimeUse) {
      usage.set(localName, 'runtimeOnly');
    }
  }

  return usage;
}

export function macroInvocationReferenceSpans(
  invocations: Iterable<{ readonly nameSpan: SourceSpan }>,
): ReadonlySet<string> {
  const spans = new Set<string>();
  for (const invocation of invocations) {
    spans.add(spanKey(invocation.nameSpan.start, invocation.nameSpan.end));
  }
  return spans;
}

function stripImportedBindings(
  sourceFile: ts.SourceFile,
  strippedImportNames: ReadonlySet<string>,
  preserveRemovedImportStatements: boolean,
): ts.SourceFile {
  if (strippedImportNames.size === 0) {
    return sourceFile;
  }

  const statements: ts.Statement[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      statements.push(statement);
      continue;
    }

    const importClause = statement.importClause;
    const keptDefaultImport = importClause.name && !strippedImportNames.has(importClause.name.text)
      ? importClause.name
      : undefined;
    const namedBindings = importClause.namedBindings;
    let keptNamedBindings = namedBindings;

    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      keptNamedBindings = strippedImportNames.has(namedBindings.name.text)
        ? undefined
        : namedBindings;
    }

    if (namedBindings && ts.isNamedImports(namedBindings)) {
      const remainingElements = namedBindings.elements.filter((element) =>
        !strippedImportNames.has(element.name.text)
      );
      keptNamedBindings = remainingElements.length > 0
        ? ts.factory.updateNamedImports(namedBindings, remainingElements)
        : undefined;
    }

    if (keptDefaultImport === importClause.name && keptNamedBindings === namedBindings) {
      statements.push(statement);
      continue;
    }

    if (!keptDefaultImport && !keptNamedBindings) {
      if (preserveRemovedImportStatements) {
        statements.push(ts.factory.createEmptyStatement());
      }
      continue;
    }

    statements.push(
      ts.factory.updateImportDeclaration(
        statement,
        statement.modifiers,
        ts.factory.updateImportClause(
          importClause,
          importClause.isTypeOnly,
          keptDefaultImport,
          keptNamedBindings,
        ),
        statement.moduleSpecifier,
        statement.attributes,
      ),
    );
  }

  return ts.factory.updateSourceFile(sourceFile, statements);
}

export function stripCompileTimeOnlyImportedBindings(
  sourceFile: ts.SourceFile,
  usageByBinding: ReadonlyMap<string, ImportedBindingUsage>,
  preserveRemovedImportStatements = false,
): ts.SourceFile {
  const runtimeReferenced = collectRuntimeReferencedImportedBindings(
    sourceFile,
    new Set(usageByBinding.keys()),
  );
  const strippedImportNames = new Set<string>();

  for (const [localName, usage] of usageByBinding.entries()) {
    if (usage === 'compileTimeOnly' && !runtimeReferenced.has(localName)) {
      strippedImportNames.add(localName);
    }
  }

  return stripImportedBindings(
    sourceFile,
    strippedImportNames,
    preserveRemovedImportStatements,
  );
}
