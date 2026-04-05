import ts from 'typescript';

const MACHINE_NUMERIC_TYPE_NAMES = [
  'Numeric',
  'Int',
  'Float',
  'f64',
  'f32',
  'i8',
  'i16',
  'i32',
  'i64',
  'u8',
  'u16',
  'u32',
  'u64',
] as const;

const MACHINE_NUMERIC_VALUE_NAMES = [
  'F64',
  'F32',
  'I8',
  'I16',
  'I32',
  'I64',
  'U8',
  'U16',
  'U32',
  'U64',
  '__numericBinary',
  '__numericUnary',
  '__numericWasmLeaf',
] as const;

const MACHINE_NUMERIC_TYPE_PATTERNS = MACHINE_NUMERIC_TYPE_NAMES.map((name) => ({
  name,
  pattern: new RegExp(`\\b${name}\\b`, 'u'),
}));

const MACHINE_NUMERICS_MODULE_SPECIFIER = 'sts:numerics';
export const ELABORATED_F64_TYPE_IMPORT_BASENAME = '__sts_builtin_f64';
export const ELABORATED_BIGINT_TYPE_IMPORT_BASENAME = '__sts_builtin_bigint';
export const ELABORATED_BIGINT_TYPE_EXPORT_NAME = '__soundscript_builtin_bigint';

function addBindingNames(name: ts.BindingName, boundNames: Set<string>) {
  if (ts.isIdentifier(name)) {
    boundNames.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    addBindingNames(element.name, boundNames);
  }
}

function collectTopLevelBoundNames(sourceFile: ts.SourceFile): {
  readonly typeNames: Set<string>;
  readonly valueNames: Set<string>;
} {
  const typeNames = new Set<string>();
  const valueNames = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const importClause = statement.importClause;
      if (!importClause) {
        continue;
      }

      if (importClause.name) {
        if (!importClause.isTypeOnly) {
          valueNames.add(importClause.name.text);
        }
        typeNames.add(importClause.name.text);
      }

      const namedBindings = importClause.namedBindings;
      if (!namedBindings) {
        continue;
      }

      if (ts.isNamespaceImport(namedBindings)) {
        if (!importClause.isTypeOnly) {
          valueNames.add(namedBindings.name.text);
        }
        typeNames.add(namedBindings.name.text);
        continue;
      }

      for (const element of namedBindings.elements) {
        if (!importClause.isTypeOnly && !element.isTypeOnly) {
          valueNames.add(element.name.text);
        }
        typeNames.add(element.name.text);
      }
      continue;
    }

    if (ts.isImportEqualsDeclaration(statement)) {
      valueNames.add(statement.name.text);
      typeNames.add(statement.name.text);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(declaration.name, valueNames);
      }
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      valueNames.add(statement.name.text);
      continue;
    }

    if (ts.isClassDeclaration(statement) && statement.name) {
      valueNames.add(statement.name.text);
      typeNames.add(statement.name.text);
      continue;
    }

    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      typeNames.add(statement.name.text);
      continue;
    }

    if (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      valueNames.add(statement.name.text);
      typeNames.add(statement.name.text);
    }
  }

  return { typeNames, valueNames };
}

function prependPreamble(text: string, preamble: string): string {
  if (text.startsWith('#!')) {
    const newlineIndex = text.indexOf('\n');
    if (newlineIndex === -1) {
      return `${text}\n${preamble}\n`;
    }
    return `${text.slice(0, newlineIndex + 1)}${preamble}\n${text.slice(newlineIndex + 1)}`;
  }

  const { prefix, suffix } = splitLeadingNonAnnotationTrivia(text);
  return `${prefix}${preamble}\n${suffix}`;
}

function splitLeadingNonAnnotationTrivia(text: string): { prefix: string; suffix: string } {
  let index = 0;

  while (index < text.length) {
    const whitespaceStart = index;
    while (index < text.length && /\s/u.test(text[index] ?? '')) {
      index += 1;
    }

    if (text.startsWith('//', index)) {
      const lineEnd = text.indexOf('\n', index);
      const commentEnd = lineEnd === -1 ? text.length : lineEnd + 1;
      const commentText = text.slice(index, commentEnd);
      if (shouldStopPreludeInsertionAtComment(commentText)) {
        index = whitespaceStart;
        break;
      }
      index = commentEnd;
      continue;
    }

    if (text.startsWith('/*', index)) {
      const closeIndex = text.indexOf('*/', index + 2);
      if (closeIndex === -1) {
        index = whitespaceStart;
        break;
      }
      const commentText = text.slice(index, closeIndex + 2);
      if (shouldStopPreludeInsertionAtComment(commentText)) {
        index = whitespaceStart;
        break;
      }
      index = closeIndex + 2;
      continue;
    }

    index = whitespaceStart;
    break;
  }

  return {
    prefix: text.slice(0, index),
    suffix: text.slice(index),
  };
}

function shouldStopPreludeInsertionAtComment(commentText: string): boolean {
  return /^\/\/\s*#\[/u.test(commentText) ||
    (
      /@ts-/u.test(commentText) &&
      !/@ts-(?:no)?check\b/u.test(commentText)
    );
}

export function isElaboratedF64TypeImportName(_name: string): boolean {
  return false;
}

export function isElaboratedBigIntTypeImportName(_name: string): boolean {
  return false;
}

export function declarationTextUsesMachineNumerics(text: string): boolean {
  return MACHINE_NUMERIC_TYPE_PATTERNS.some(({ pattern }) => pattern.test(text));
}

export function prependMachineNumericPrelude(text: string): string {
  const usedTypeNames = MACHINE_NUMERIC_TYPE_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ name }) => name);
  if (usedTypeNames.length === 0) {
    return text;
  }

  const sourceFile = ts.createSourceFile(
    'machine-numeric-prelude.d.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let changed = false;
  let handledExistingImport = false;
  const statements = sourceFile.statements.map((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== MACHINE_NUMERICS_MODULE_SPECIFIER ||
      !statement.importClause?.isTypeOnly ||
      !statement.importClause.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      return statement;
    }

    handledExistingImport = true;
    const existingTypeNames = new Set(
      statement.importClause.namedBindings.elements.map((element) =>
        element.propertyName?.text ?? element.name.text
      ),
    );
    const missingTypeNames = usedTypeNames.filter((name) => !existingTypeNames.has(name));
    if (missingTypeNames.length === 0) {
      return statement;
    }

    changed = true;
    return ts.factory.updateImportDeclaration(
      statement,
      statement.modifiers,
      ts.factory.updateImportClause(
        statement.importClause,
        statement.importClause.isTypeOnly,
        statement.importClause.name,
        ts.factory.updateNamedImports(
          statement.importClause.namedBindings,
          [
            ...statement.importClause.namedBindings.elements,
            ...missingTypeNames.map((name) =>
              ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(name))
            ),
          ],
        ),
      ),
      statement.moduleSpecifier,
      statement.attributes,
    );
  });

  if (changed) {
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(
      ts.factory.updateSourceFile(sourceFile, statements),
    );
  }

  if (handledExistingImport) {
    return text;
  }

  return `import type { ${usedTypeNames.join(', ')} } from '${MACHINE_NUMERICS_MODULE_SPECIFIER}';\n${text}`;
}

export function prependMachineNumericSourcePrelude(fileName: string, text: string): string {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const boundNames = collectTopLevelBoundNames(sourceFile);
  const usedTypeNames = new Set<string>();
  const existingTypeImports = new Set<string>();
  const existingValueImports = new Set<string>();
  const typeNameSet = new Set<string>(MACHINE_NUMERIC_TYPE_NAMES);
  const valueNameSet = new Set<string>(MACHINE_NUMERIC_VALUE_NAMES);
  let usesMachineNumerics = false;

  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === MACHINE_NUMERICS_MODULE_SPECIFIER &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (node.importClause.isTypeOnly || element.isTypeOnly) {
          existingTypeImports.add(importedName);
        } else {
          existingValueImports.add(importedName);
        }
      }
    }

    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const typeName = node.typeName.text;
      if (typeNameSet.has(typeName) && !boundNames.typeNames.has(typeName)) {
        usedTypeNames.add(typeName);
        usesMachineNumerics = true;
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const valueName = node.expression.text;
      if (valueNameSet.has(valueName)) {
        usesMachineNumerics = true;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!usesMachineNumerics) {
    return text;
  }

  const preambleLines: string[] = [];
  const orderedTypeNames = MACHINE_NUMERIC_TYPE_NAMES.filter((name) =>
    usedTypeNames.has(name) && !existingTypeImports.has(name)
  );
  const missingValueNames = MACHINE_NUMERIC_VALUE_NAMES.filter((name) => !existingValueImports.has(name));

  if (orderedTypeNames.length > 0) {
    preambleLines.push(
      `import type { ${orderedTypeNames.join(', ')} } from '${MACHINE_NUMERICS_MODULE_SPECIFIER}';`,
    );
  }

  if (missingValueNames.length > 0) {
    preambleLines.push(
      `import { ${missingValueNames.join(', ')} } from '${MACHINE_NUMERICS_MODULE_SPECIFIER}';`,
    );
  }

  if (preambleLines.length === 0) {
    return text;
  }

  return prependPreamble(text, preambleLines.join('\n'));
}
