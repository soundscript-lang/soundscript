import ts from 'typescript';

import type { AnalysisContext } from '../engine/types.ts';
import {
  isForeignPackageSourceFile,
  isForeignResolvedModule,
  resolveSoundScriptAwareModule,
} from '../../soundscript_packages.ts';
import { isSoundscriptSourceFile, toSourceFileName } from '../../frontend/project_frontend.ts';

export interface ImportedModuleResolution {
  importedSourceFile?: ts.SourceFile;
  isForeign: boolean;
}

export interface ForeignImportBindingInfo {
  bindingName: ts.Identifier;
  kind: 'namespaceImport' | 'valueImport';
  moduleSpecifier: ts.StringLiteral;
  resolution: ImportedModuleResolution;
}

function hasConfiguredNodeTypes(compilerOptions: ts.CompilerOptions): boolean {
  return compilerOptions.types?.includes('node') ?? false;
}

function isAmbientNodeHostModule(
  moduleSpecifier: string,
  compilerOptions: ts.CompilerOptions,
): boolean {
  return moduleSpecifier.startsWith('node:') && hasConfiguredNodeTypes(compilerOptions);
}

export function isRequireCall(node: ts.CallExpression): node is ts.CallExpression & {
  expression: ts.Identifier;
  arguments: [ts.StringLiteral];
} {
  return ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]);
}

export function isImportCall(node: ts.CallExpression): node is ts.CallExpression & {
  arguments: [ts.StringLiteral];
} {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]);
}

export function getUnwrappedBoundaryExpression(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression)
    ? getUnwrappedBoundaryExpression(expression.expression)
    : expression;
}

export function resolveImportedModule(
  context: AnalysisContext,
  moduleSpecifier: ts.StringLiteral,
  containingSourceFile: ts.SourceFile,
): ImportedModuleResolution {
  if (isAmbientNodeHostModule(moduleSpecifier.text, context.program.getCompilerOptions())) {
    return { isForeign: true };
  }

  const resolvedModule = resolveSoundScriptAwareModule(
    moduleSpecifier.text,
    containingSourceFile.fileName,
    context.program.getCompilerOptions(),
    ts.sys,
  );

  if (!resolvedModule) {
    return { isForeign: false };
  }

  return {
    importedSourceFile: context.program.getSourceFile(resolvedModule.resolvedFileName),
    isForeign: isForeignResolvedModule(moduleSpecifier.text, resolvedModule, ts.sys),
  };
}

export function isUnsoundImportedModule(
  containingSourceFile: ts.SourceFile,
  resolution: ImportedModuleResolution,
): boolean {
  const importedSourceFile = resolution.importedSourceFile;
  const importedFileName = importedSourceFile?.fileName ?? '';
  const importedIsTrustedPackageArtifact =
    (importedFileName.includes('/node_modules/') || importedFileName.includes('\\node_modules\\')) &&
    !isForeignPackageSourceFile(importedFileName, ts.sys);

  if (resolution.isForeign) {
    return true;
  }

  if (importedSourceFile?.isDeclarationFile) {
    return !importedIsTrustedPackageArtifact;
  }

  return isSoundscriptSourceFile(toSourceFileName(containingSourceFile.fileName)) &&
    !!importedSourceFile &&
    !isSoundscriptSourceFile(toSourceFileName(importedFileName)) &&
    !importedIsTrustedPackageArtifact;
}

export function getForeignImportBindingInfos(
  context: AnalysisContext,
  statement: ts.Statement,
  containingSourceFile: ts.SourceFile,
): readonly ForeignImportBindingInfo[] {
  if (ts.isImportDeclaration(statement)) {
    if (
      !statement.importClause || statement.importClause.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [];
    }

    const resolution = resolveImportedModule(context, statement.moduleSpecifier, containingSourceFile);
    const results: ForeignImportBindingInfo[] = [];

    if (statement.importClause.name) {
      results.push({
        bindingName: statement.importClause.name,
        kind: 'valueImport',
        moduleSpecifier: statement.moduleSpecifier,
        resolution,
      });
    }

    const namedBindings = statement.importClause.namedBindings;
    if (!namedBindings) {
      return results;
    }

    if (ts.isNamespaceImport(namedBindings)) {
      results.push({
        bindingName: namedBindings.name,
        kind: 'namespaceImport',
        moduleSpecifier: statement.moduleSpecifier,
        resolution,
      });
      return results;
    }

    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) {
        continue;
      }

      results.push({
        bindingName: element.name,
        kind: 'valueImport',
        moduleSpecifier: statement.moduleSpecifier,
        resolution,
      });
    }

    return results;
  }

  if (
    ts.isImportEqualsDeclaration(statement) &&
    ts.isExternalModuleReference(statement.moduleReference) &&
    ts.isStringLiteral(statement.moduleReference.expression)
  ) {
    return [{
      bindingName: statement.name,
      kind: 'namespaceImport',
      moduleSpecifier: statement.moduleReference.expression,
      resolution: resolveImportedModule(
        context,
        statement.moduleReference.expression,
        containingSourceFile,
      ),
    }];
  }

  return [];
}

export function getDirectUnsoundImportNamespaceExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Expression | undefined {
  const current = getUnwrappedBoundaryExpression(expression);

  if (ts.isAwaitExpression(current)) {
    return getDirectUnsoundImportNamespaceExpression(context, current.expression);
  }

  if (!ts.isCallExpression(current)) {
    return undefined;
  }

  let moduleSpecifier: ts.StringLiteral | undefined;
  if (isImportCall(current)) {
    moduleSpecifier = current.arguments[0];
  } else if (isRequireCall(current)) {
    moduleSpecifier = current.arguments[0];
  }

  if (!moduleSpecifier) {
    return undefined;
  }

  const resolution = resolveImportedModule(context, moduleSpecifier, current.getSourceFile());
  return isUnsoundImportedModule(current.getSourceFile(), resolution) ? current : undefined;
}
