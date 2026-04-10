import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';
import { createAnyTypeDiagnostic } from '../proof_escape_hatch_diagnostics.ts';
import {
  initializeForeignProjectionFacts,
  isAllowedProjectedUnknownUse,
  isNestedMemberAccessExpression,
  isProjectedUnknownIdentifier,
  isProjectedUnknownMemberExpression,
} from './foreign_projection.ts';
import {
  getForeignImportBindingInfos,
  isImportCall,
  isRequireCall,
  isUnsoundImportedModule,
  resolveImportedModule,
} from './foreign_boundary.ts';
import {
  markUnsafeValueOrigin,
  propagateUnsafeValueAliases,
  type UnsafeValueOriginSymbolIds,
} from './unsafe_value_origin.ts';

import { hasDirectInteropAnnotation } from './trust.ts';

function createUnsoundImportDiagnostic(node: ts.Node): SoundDiagnostic {
  const example = '// #[interop]\nimport { value } from "./lib";';
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.unsoundImportUse,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.unsoundImportUse,
    metadata: {
      rule: 'unsound_import_boundary',
      fixability: 'boundary_annotation',
      invariant:
        'Values from non-soundscript modules cannot enter checked soundscript code without an explicit interop boundary.',
      replacementFamily: 'interop_boundary',
      example,
    },
    notes: [
      'Values imported from ordinary `.ts`, JavaScript, or declaration-only modules remain outside checked soundscript code until an explicit interop boundary acknowledges the trust boundary.',
      `Example: ${example}`,
    ],
    hint:
      'Add `// #[interop]` immediately above the import boundary and validate the imported value before it flows deeper into soundscript.',
    ...getNodeDiagnosticRange(node),
  };
}

function isImportBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  return (ts.isImportClause(parent) && parent.name === node) ||
    ts.isNamespaceImport(parent) ||
    (ts.isImportSpecifier(parent) && parent.name === node);
}

function isDeclarationBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  return (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node);
}

function isTypePositionIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  return (ts.isTypeReferenceNode(parent) && parent.typeName === node) ||
    (ts.isExpressionWithTypeArguments(parent) && parent.expression === node) ||
    ts.isTypeQueryNode(parent) ||
    ts.isImportTypeNode(parent) ||
    ts.isQualifiedName(parent);
}

function collectUnsoundImportOrigins(context: AnalysisContext): UnsafeValueOriginSymbolIds {
  const origins: UnsafeValueOriginSymbolIds = new Set();

  context.forEachSourceFile((sourceFile) => {
    for (const statement of sourceFile.statements) {
      if (context.isGeneratedNode(statement)) {
        continue;
      }

      const bindingInfos = getForeignImportBindingInfos(context, statement, sourceFile);
      if (bindingInfos.length > 0) {
        if (hasDirectInteropAnnotation(context, statement)) {
          continue;
        }

        if (!bindingInfos.some((info) => isUnsoundImportedModule(sourceFile, info.resolution))) {
          continue;
        }

        for (const info of bindingInfos) {
          if (!isUnsoundImportedModule(sourceFile, info.resolution)) {
            continue;
          }

          markUnsafeValueOrigin(context, origins, info.bindingName, {
            kind: 'unsoundImport',
            sourceNode: info.moduleSpecifier,
            stickyAliasable: true,
          });
        }
      }
    }

    context.traverse(sourceFile, (node) => {
      if (ts.isCallExpression(node) && isRequireCall(node)) {
        const resolution = resolveImportedModule(context, node.arguments[0], sourceFile);
        if (!isUnsoundImportedModule(sourceFile, resolution)) {
          return;
        }

        const parent = node.parent;
        if (
          ts.isVariableDeclaration(parent) &&
          parent.initializer === node
        ) {
          if (hasDirectInteropAnnotation(context, parent)) {
            return;
          }

          markUnsafeValueOrigin(context, origins, parent.name, {
            kind: 'unsoundImport',
            sourceNode: node.arguments[0],
            stickyAliasable: true,
          });
        }

        return;
      }

      if (
        !ts.isCallExpression(node) ||
        !isImportCall(node)
      ) {
        return;
      }

      const resolution = resolveImportedModule(context, node.arguments[0], sourceFile);
      if (!isUnsoundImportedModule(sourceFile, resolution)) {
        return;
      }

      const parent = node.parent;
      if (
        ts.isAwaitExpression(parent) &&
        ts.isVariableDeclaration(parent.parent) &&
        parent.parent.initializer === parent
      ) {
        if (hasDirectInteropAnnotation(context, parent.parent)) {
          return;
        }

        markUnsafeValueOrigin(context, origins, parent.parent.name, {
          kind: 'unsoundImport',
          sourceNode: node.arguments[0],
          stickyAliasable: true,
        });
      }

      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node
      ) {
        if (hasDirectInteropAnnotation(context, parent)) {
          return;
        }

        markUnsafeValueOrigin(context, origins, parent.name, {
          kind: 'unsoundImport',
          sourceNode: node.arguments[0],
          stickyAliasable: true,
        });
      }
    });
  });

  return origins;
}

export function runUnsoundImportRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];
  const origins = collectUnsoundImportOrigins(context);

  if (origins.size > 0) {
    propagateUnsafeValueAliases(context, origins);
  }

  initializeForeignProjectionFacts(context, origins);

  context.forEachSourceFile((sourceFile) => {
    for (const statement of sourceFile.statements) {
      if (context.isGeneratedNode(statement)) {
        continue;
      }

      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly) {
          continue;
        }
        if (
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          const resolution = resolveImportedModule(context, statement.moduleSpecifier, sourceFile);
          if (
            isUnsoundImportedModule(sourceFile, resolution) &&
            !hasDirectInteropAnnotation(context, statement)
          ) {
            diagnostics.push(createUnsoundImportDiagnostic(statement.moduleSpecifier));
          }
        }
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteral(statement.moduleReference.expression)
      ) {
        const resolution = resolveImportedModule(
          context,
          statement.moduleReference.expression,
          sourceFile,
        );
        if (
          isUnsoundImportedModule(sourceFile, resolution) &&
          !hasDirectInteropAnnotation(context, statement)
        ) {
          diagnostics.push(createUnsoundImportDiagnostic(statement.moduleReference.expression));
        }
      }
    }

    context.traverse(sourceFile, (node) => {
      if (ts.isCallExpression(node) && isRequireCall(node)) {
        const resolution = resolveImportedModule(context, node.arguments[0], sourceFile);
        if (
          isUnsoundImportedModule(sourceFile, resolution) &&
          !hasDirectInteropAnnotation(context, node)
        ) {
          diagnostics.push(createUnsoundImportDiagnostic(node.arguments[0]));
          return;
        }
      }

      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const resolution = resolveImportedModule(context, node.arguments[0], sourceFile);
        if (
          isUnsoundImportedModule(sourceFile, resolution) &&
          !hasDirectInteropAnnotation(context, node)
        ) {
          diagnostics.push(createUnsoundImportDiagnostic(node.arguments[0]));
          return;
        }
      }

      if (
        isProjectedUnknownMemberExpression(context, node) &&
        !isNestedMemberAccessExpression(node) &&
        !isAllowedProjectedUnknownUse(context, node)
      ) {
        diagnostics.push(createAnyTypeDiagnostic(node));
        return;
      }

      if (
        !ts.isIdentifier(node) ||
        isImportBindingIdentifier(node) ||
        isDeclarationBindingIdentifier(node) ||
        isTypePositionIdentifier(node)
      ) {
        return;
      }

      const symbol = context.checker.getSymbolAtLocation(node);
      if (!symbol) {
        return;
      }

      const symbolId = context.getSymbolId(symbol);
      if (origins.has(symbolId)) {
        diagnostics.push(createUnsoundImportDiagnostic(node));
        return;
      }

      if (isProjectedUnknownIdentifier(context, node)) {
        if (!isAllowedProjectedUnknownUse(context, node)) {
          diagnostics.push(createAnyTypeDiagnostic(node));
        }
      }
    });
  });

  return diagnostics;
}
