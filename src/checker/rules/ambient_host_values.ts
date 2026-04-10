import ts from 'typescript';

import { isSoundscriptSourceFile, toSourceFileName } from '../../frontend/project_frontend.ts';
import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';

function normalizeFileName(fileName: string): string {
  return fileName.replaceAll('\\', '/').toLowerCase();
}

function isTypePositionIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  return (ts.isTypeReferenceNode(parent) && parent.typeName === node) ||
    (ts.isExpressionWithTypeArguments(parent) && parent.expression === node) ||
    ts.isTypeQueryNode(parent) ||
    ts.isImportTypeNode(parent) ||
    ts.isQualifiedName(parent);
}

function isDeclarationNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  return (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isEnumDeclaration(parent) && parent.name === node) ||
    (ts.isModuleDeclaration(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    ts.isNamespaceImport(parent) ||
    (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node));
}

function isPropertyNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  return (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isEnumMember(parent) && parent.name === node);
}

function isTrustedCoreStdlibDeclarationFile(fileName: string): boolean {
  const normalizedFileName = normalizeFileName(fileName);
  const baseName = normalizedFileName.split('/').pop() ?? normalizedFileName;
  return normalizedFileName.includes('/src/bundled/typescript/lib/lib.es') ||
    normalizedFileName.includes('/src/bundled/typescript/lib/lib.decorators') ||
    /^lib\.(?:es|decorators)/u.test(baseName);
}

function createAmbientHostValueDiagnostic(node: ts.Identifier): SoundDiagnostic {
  const example = [
    '// #[interop]',
    "import { document } from 'host:dom';",
    '',
    '// #[extern]',
    'declare const process: NodeJS.Process;',
  ].join('\n');

  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.ambientHostValueRequiresExplicitBoundary,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.ambientHostValueRequiresExplicitBoundary,
    metadata: {
      rule: 'ambient_host_value_boundary',
      primarySymbol: node.text,
      fixability: 'boundary_annotation',
      replacementFamily: 'host_value_boundary',
      example,
      invariant:
        'Ambient host values from DOM, Node, or foreign declaration files must cross an explicit import or same-file extern boundary before use in checked soundscript.',
    },
    notes: [
      `This value resolves to an ambient host declaration for \`${node.text}\`, not to a local implementation or import boundary.`,
      `Example: ${example}`,
    ],
    hint:
      'Import the host value through an explicit boundary such as `host:dom` / `host:node`, or add a same-file `// #[extern]` declaration when the runtime truly provides it.',
    ...getNodeDiagnosticRange(node),
  };
}

export function runAmbientHostValueRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    if (!isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))) {
      return;
    }

    context.traverse(sourceFile, (node) => {
      if (!ts.isIdentifier(node)) {
        return;
      }

      if (
        isDeclarationNameIdentifier(node) || isPropertyNameIdentifier(node) ||
        isTypePositionIdentifier(node)
      ) {
        return;
      }

      const symbol = context.checker.getSymbolAtLocation(node);
      if (!symbol?.declarations || symbol.declarations.length === 0) {
        return;
      }

      if (symbol.declarations.some((declaration) => declaration.getSourceFile() === sourceFile)) {
        return;
      }

      const ambientHostDeclarations = symbol.declarations.filter((declaration) => {
        const declarationSourceFile = declaration.getSourceFile();
        return declarationSourceFile.isDeclarationFile &&
          !isTrustedCoreStdlibDeclarationFile(declarationSourceFile.fileName);
      });
      if (ambientHostDeclarations.length === 0) {
        return;
      }

      diagnostics.push(createAmbientHostValueDiagnostic(node));
    });
  });

  return diagnostics;
}
