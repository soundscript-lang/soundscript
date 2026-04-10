import ts from 'typescript';

import { createAnnotationLookup } from '../language/annotation_syntax.ts';
import type { SourceSpan } from './macro_types.ts';

export type MacroFactoryForm = 'call' | 'decl' | 'tag';
export type ImportedMacroSiteKind = 'annotation' | 'call' | 'tag';

export interface ScannedMacroFactoryExport {
  readonly exportName: string;
  readonly form: MacroFactoryForm;
  readonly span: SourceSpan;
}

const MACRO_API_SPECIFIERS = new Set(['sts:macros', '@soundscript/macros']);
function blankPreservingLines(text: string): string {
  return text.replace(/[^\r\n]/gu, ' ');
}

function macroFactoryAnnotationForNode(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { form: MacroFactoryForm; span: SourceSpan } | null {
  const block = createAnnotationLookup(sourceFile).getAttachedAnnotationBlock(node);
  const annotation = block?.annotations.find((entry) => entry.name === 'macro');
  const formValue = annotation?.arguments?.[0]?.value;
  if (
    !block ||
    !annotation ||
    annotation.arguments?.length !== 1 ||
    annotation.arguments[0]?.kind !== 'positional' ||
    !formValue ||
    formValue.kind !== 'identifier' ||
    (formValue.name !== 'call' && formValue.name !== 'decl' && formValue.name !== 'tag')
  ) {
    return null;
  }

  return {
    form: formValue.name as MacroFactoryForm,
    span: {
      fileName: sourceFile.fileName,
      start: block.range.start,
      end: block.range.end,
    },
  };
}

function getFunctionDeclarationExportName(
  node: ts.Statement,
): 'default' | string | undefined {
  if (!ts.isFunctionDeclaration(node)) {
    return undefined;
  }

  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  const isExported = !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  if (!isExported) {
    return undefined;
  }

  const isDefault = !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  if (isDefault) {
    return 'default';
  }

  return node.name?.text;
}

function exportedDeclarationNames(statement: ts.Statement): readonly string[] {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
  const isExported = !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  if (!isExported) {
    return [];
  }

  const isDefault = !!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  if (isDefault) {
    return ['default'];
  }

  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return [statement.name.text];
  }

  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : []
    );
  }

  if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
    return ['default'];
  }

  return [];
}

export function sourceTextLooksLikeMacroModule(sourceText: string): boolean {
  return [...MACRO_API_SPECIFIERS].some((specifier) => sourceText.includes(specifier));
}

export function macroSiteKindForFactoryForm(form: MacroFactoryForm): ImportedMacroSiteKind {
  switch (form) {
    case 'call':
      return 'call';
    case 'tag':
      return 'tag';
    case 'decl':
      return 'annotation';
  }
}

export function scanMacroFactoryExports(
  fileName: string,
  sourceText: string,
): ReadonlyMap<string, ScannedMacroFactoryExport> {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    /\.(?:[cm]?tsx|jsx|sts)$/iu.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const exports = new Map<string, ScannedMacroFactoryExport>();

  for (const statement of sourceFile.statements) {
    const exportName = getFunctionDeclarationExportName(statement);
    if (!exportName || !ts.isFunctionDeclaration(statement)) {
      continue;
    }

    const annotation = macroFactoryAnnotationForNode(sourceFile, statement);
    if (!annotation) {
      continue;
    }

    exports.set(exportName, {
      exportName,
      form: annotation.form,
      span: {
        fileName,
        start: annotation.span.start,
        end: statement.getEnd(),
      },
    });
  }

  return exports;
}

export function usesLegacyDefineMacroAuthoring(sourceText: string): boolean {
  return /\bdefineMacro\s*\(/u.test(sourceText) ||
    /from ['"]@soundscript\/macros['"]/u.test(sourceText) ||
    /from ['"]sts:macros['"][^]*\bdefineMacro\b/u.test(sourceText);
}

export function stripMacroFactoryAuthoringFromText(
  fileName: string,
  sourceText: string,
): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    /\.(?:[cm]?tsx|jsx|sts)$/iu.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const spansToBlank: Array<{ start: number; end: number }> = [];
  const strippedMacroExportNames: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      MACRO_API_SPECIFIERS.has(statement.moduleSpecifier.text)
    ) {
      spansToBlank.push({
        start: statement.getFullStart(),
        end: statement.getEnd(),
      });
      continue;
    }

    const exportName = getFunctionDeclarationExportName(statement);
    if (!exportName || !ts.isFunctionDeclaration(statement)) {
      continue;
    }

    const annotation = macroFactoryAnnotationForNode(sourceFile, statement);
    if (!annotation) {
      continue;
    }

    spansToBlank.push({
      start: annotation.span.start,
      end: statement.getEnd(),
    });
    strippedMacroExportNames.push(exportName);
  }

  if (spansToBlank.length === 0) {
    return sourceText;
  }

  const originalWasModule = ts.isExternalModule(sourceFile);

  let stripped = '';
  let cursor = 0;
  for (const span of spansToBlank.sort((left, right) => left.start - right.start)) {
    if (span.start < cursor) {
      continue;
    }

    stripped += sourceText.slice(cursor, span.start);
    stripped += blankPreservingLines(sourceText.slice(span.start, span.end));
    cursor = span.end;
  }
  stripped += sourceText.slice(cursor);

  const strippedSourceFile = ts.createSourceFile(
    fileName,
    stripped,
    ts.ScriptTarget.Latest,
    true,
    /\.(?:[cm]?tsx|jsx|sts)$/iu.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const survivingExportNames = new Set(
    strippedSourceFile.statements.flatMap((statement) => exportedDeclarationNames(statement)),
  );
  const missingExportNames = strippedMacroExportNames.filter((exportName) =>
    !survivingExportNames.has(exportName)
  );

  if (missingExportNames.length > 0) {
    const namedExportNames = missingExportNames.filter((exportName) => exportName !== 'default');
    const missingDefaultExport = missingExportNames.includes('default');
    const placeholderStatements = [
      ...namedExportNames.map((exportName) => `export declare const ${exportName}: unknown;`),
      ...(missingDefaultExport
        ? [
          'declare const __soundscript_default_macro_export: unknown;',
          'export default __soundscript_default_macro_export;',
        ]
        : []),
    ];
    return `${stripped}\n/* soundscript:macros */\n${placeholderStatements.join('\n')}\n`;
  }

  if (!originalWasModule) {
    return stripped;
  }
  return ts.isExternalModule(strippedSourceFile)
    ? `${stripped}\n/* soundscript:macros */\n`
    : `${stripped}\n/* soundscript:macros */\nexport {};\n`;
}
