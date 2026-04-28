import ts from 'typescript';

import {
  EXTERN_GLOBAL_MODULE_SPECIFIER,
  EXTERN_GLOBAL_THIS_MODULE_SPECIFIER,
  isExternModuleSpecifier,
} from '../../project/soundscript_runtime_specifiers.ts';
import { toSourceFileName } from '../../frontend/project_frontend.ts';
import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';

import { hasDirectInteropAnnotation } from './trust.ts';

function createInvalidExternImportDiagnostic(
  node: ts.Node,
  options: {
    rule: string;
    primarySymbol: string;
    notes: readonly string[];
    hint: string;
    example?: string;
  },
): SoundDiagnostic {
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.invalidExternImport,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.invalidExternImport,
    metadata: {
      rule: options.rule,
      primarySymbol: options.primarySymbol,
      fixability: 'boundary_annotation',
      replacementFamily: 'extern_import_boundary',
      example: options.example ??
        [
          '// #[interop]',
          "import { __APP_CONFIG__ as config } from 'extern:globalThis';",
        ].join('\n'),
    },
    notes: [...options.notes],
    hint: options.hint,
    ...getNodeDiagnosticRange(node),
  };
}

function createMissingInteropDiagnostic(node: ts.Node, specifier: string): SoundDiagnostic {
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.unsoundImportUse,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.unsoundImportUse,
    metadata: {
      rule: 'extern_import_requires_interop',
      primarySymbol: specifier,
      fixability: 'boundary_annotation',
      replacementFamily: 'extern_import_boundary',
      example: [
        '// #[interop]',
        "import { __APP_CONFIG__ as config } from 'extern:globalThis';",
      ].join('\n'),
    },
    notes: [
      `\`${specifier}\` is a raw app/embedder boundary and must be annotated with \`// #[interop]\`.`,
      "Example: // #[interop]\nimport { __APP_CONFIG__ as config } from 'extern:globalThis';",
    ],
    hint: 'Add `// #[interop]` immediately above the extern import boundary.',
    ...getNodeDiagnosticRange(node),
  };
}

function isAmbientValueDeclaration(declaration: ts.Declaration): boolean {
  const sourceFile = declaration.getSourceFile();
  if (!sourceFile.isDeclarationFile) {
    return false;
  }

  return ts.isVariableDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isModuleDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration);
}

function hasAmbientGlobalValueDeclaration(
  context: AnalysisContext,
  name: string,
  location: ts.Node,
): boolean {
  const symbol = context.checker.resolveName(
    name,
    location,
    ts.SymbolFlags.Value,
    false,
  );
  return symbol?.declarations?.some(isAmbientValueDeclaration) === true;
}

function hasGlobalThisProperty(
  context: AnalysisContext,
  name: string,
  location: ts.Node,
): boolean {
  const globalThisSymbol = context.checker.resolveName(
    'globalThis',
    location,
    ts.SymbolFlags.Value,
    false,
  );
  if (!globalThisSymbol) {
    return false;
  }

  const globalThisType = context.checker.getTypeOfSymbolAtLocation(globalThisSymbol, location);
  return context.checker.getPropertyOfType(globalThisType, name) !== undefined;
}

function getImportedExternName(element: ts.ImportSpecifier): string | undefined {
  const importedNameNode = element.propertyName ?? element.name;
  if (ts.isIdentifier(importedNameNode) || ts.isStringLiteralLike(importedNameNode)) {
    return importedNameNode.text;
  }
  return undefined;
}

function isIdentifierText(text: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/u.test(text);
}

function validateExternImportDeclaration(
  context: AnalysisContext,
  statement: ts.ImportDeclaration,
): readonly SoundDiagnostic[] {
  if (!ts.isStringLiteralLike(statement.moduleSpecifier)) {
    return [];
  }

  const specifier = statement.moduleSpecifier.text;
  if (!isExternModuleSpecifier(specifier)) {
    return [];
  }

  const diagnostics: SoundDiagnostic[] = [];
  if (!hasDirectInteropAnnotation(context, statement)) {
    diagnostics.push(createMissingInteropDiagnostic(statement.moduleSpecifier, specifier));
  }

  const importClause = statement.importClause;
  const namedBindings = importClause?.namedBindings;
  if (!importClause || importClause.name || !namedBindings || !ts.isNamedImports(namedBindings)) {
    diagnostics.push(
      createInvalidExternImportDiagnostic(statement.moduleSpecifier, {
        rule: 'extern_import_named_only',
        primarySymbol: specifier,
        notes: [
          `\`${specifier}\` only supports named imports. Default, namespace, and side-effect extern imports are not valid boundaries.`,
        ],
        hint: 'Import the ambient value by name and use an alias if the local name should differ.',
      }),
    );
    return diagnostics;
  }

  for (const element of namedBindings.elements) {
    const importedName = getImportedExternName(element);
    if (!importedName) {
      diagnostics.push(
        createInvalidExternImportDiagnostic(element.name, {
          rule: 'extern_import_named_only',
          primarySymbol: specifier,
          notes: [
            `\`${specifier}\` imports must name an ambient identifier that can be checked by Soundscript.`,
          ],
          hint: 'Use an identifier named import from the extern module.',
        }),
      );
      continue;
    }

    if (specifier === EXTERN_GLOBAL_MODULE_SPECIFIER && !isIdentifierText(importedName)) {
      diagnostics.push(
        createInvalidExternImportDiagnostic(element.name, {
          rule: 'extern_import_global_identifier_only',
          primarySymbol: importedName,
          notes: [
            `\`${specifier}\` reads ambient bindings by identifier, so \`${importedName}\` is not a valid global binding name.`,
          ],
          hint:
            'Use `extern:globalThis` for string-named global object properties, or import an identifier binding from `extern:global`.',
        }),
      );
      continue;
    }

    const isDeclared = specifier === EXTERN_GLOBAL_THIS_MODULE_SPECIFIER
      ? hasGlobalThisProperty(context, importedName, element.name) ||
        hasAmbientGlobalValueDeclaration(context, importedName, element.name)
      : hasAmbientGlobalValueDeclaration(context, importedName, element.name);
    if (!isDeclared) {
      diagnostics.push(
        createInvalidExternImportDiagnostic(element.name, {
          rule: 'extern_import_missing_ambient',
          primarySymbol: importedName,
          notes: [
            `\`${importedName}\` is imported from \`${specifier}\`, but no included ambient value declaration provides that name.`,
          ],
          hint:
            'Add the ambient value to an included `.d.ts` file, or import from a concrete host module instead.',
        }),
      );
    }
  }

  return diagnostics;
}

function validateExternExportDeclaration(
  statement: ts.ExportDeclaration,
): readonly SoundDiagnostic[] {
  if (
    !statement.moduleSpecifier ||
    !ts.isStringLiteralLike(statement.moduleSpecifier) ||
    !isExternModuleSpecifier(statement.moduleSpecifier.text)
  ) {
    return [];
  }

  return [
    createInvalidExternImportDiagnostic(statement.moduleSpecifier, {
      rule: 'extern_import_reexport_forbidden',
      primarySymbol: statement.moduleSpecifier.text,
      notes: [
        `\`${statement.moduleSpecifier.text}\` is an app/embedder value boundary and cannot be re-exported.`,
      ],
      hint: 'Import extern values at the local boundary that uses them.',
    }),
  ];
}

export function runExternImportRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    if (!context.isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))) {
      return;
    }

    for (const statement of sourceFile.statements) {
      if (context.isGeneratedNode(statement)) {
        continue;
      }

      if (ts.isImportDeclaration(statement)) {
        diagnostics.push(...validateExternImportDeclaration(context, statement));
        continue;
      }

      if (ts.isExportDeclaration(statement)) {
        diagnostics.push(...validateExternExportDeclaration(statement));
      }
    }
  });

  return diagnostics;
}

export { EXTERN_GLOBAL_MODULE_SPECIFIER, EXTERN_GLOBAL_THIS_MODULE_SPECIFIER };
