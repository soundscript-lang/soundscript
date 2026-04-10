import ts from 'typescript';

import { BUILTIN_DIRECTIVE_NAMES, createAnnotationLookup } from '../language/annotation_syntax.ts';
import type { ImportedMacroSiteKind } from './macro_rewrite.ts';

export interface ImportedNamedBinding {
  readonly exportName: string;
  readonly localName: string;
  readonly specifier: string;
}

export interface CollectImportedMacroSiteKindsOptions {
  readonly explicitSiteKindsBySpecifier?: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  >;
  readonly resolveOnlySyntaxCandidates?: boolean;
  readonly resolveSiteKindsForSpecifier?: (
    specifier: string,
  ) => ReadonlyMap<string, ImportedMacroSiteKind> | undefined;
  readonly useSyntaxFallback?: boolean;
}

function scriptKindForFile(fileName: string): ts.ScriptKind {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.sts') || lowered.endsWith('.tsx') || lowered.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lowered.endsWith('.js') || lowered.endsWith('.mjs') || lowered.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function sourceFileForText(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(fileName),
  );
}

function isAnnotationTarget(
  node: ts.Node,
): node is
  | ts.ClassDeclaration
  | ts.FunctionDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration {
  return ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
}

export function cloneImportedMacroSiteKinds(
  source: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>,
): Map<string, Map<string, ImportedMacroSiteKind>> {
  const cloned = new Map<string, Map<string, ImportedMacroSiteKind>>();
  for (const [specifier, exportKinds] of source.entries()) {
    cloned.set(specifier, new Map(exportKinds));
  }
  return cloned;
}

export function mergeImportedMacroSiteKinds(
  base: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>,
  override: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>,
): ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>> {
  const merged = cloneImportedMacroSiteKinds(base);
  for (const [specifier, exportKinds] of override.entries()) {
    let mergedKinds = merged.get(specifier);
    if (!mergedKinds) {
      mergedKinds = new Map();
      merged.set(specifier, mergedKinds);
    }
    for (const [exportName, kind] of exportKinds.entries()) {
      mergedKinds.set(exportName, kind);
    }
  }
  return merged;
}

export function collectImportedNamedBindings(
  fileName: string,
  text: string,
): readonly ImportedNamedBinding[] {
  return collectImportedNamedBindingsFromSourceFile(sourceFileForText(fileName, text));
}

function collectImportedNamedBindingsFromSourceFile(
  sourceFile: ts.SourceFile,
): readonly ImportedNamedBinding[] {
  const bindings: ImportedNamedBinding[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    if (statement.importClause?.name) {
      bindings.push({
        exportName: 'default',
        localName: statement.importClause.name.text,
        specifier: statement.moduleSpecifier.text,
      });
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const element of namedBindings.elements) {
      bindings.push({
        exportName: element.propertyName?.text ?? element.name.text,
        localName: element.name.text,
        specifier: statement.moduleSpecifier.text,
      });
    }
  }

  return bindings;
}

function collectSyntaxFallbackKindsByLocalName(
  sourceFile: ts.SourceFile,
  bindingsByLocalName: ReadonlyMap<string, ImportedNamedBinding>,
): ReadonlyMap<string, ImportedMacroSiteKind> {
  if (bindingsByLocalName.size === 0) {
    return new Map();
  }

  const annotationLookup = createAnnotationLookup(sourceFile);
  const syntaxKindsByLocalName = new Map<string, ImportedMacroSiteKind>();
  const setKind = (localName: string, kind: ImportedMacroSiteKind) => {
    if (!syntaxKindsByLocalName.has(localName)) {
      syntaxKindsByLocalName.set(localName, kind);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (bindingsByLocalName.has(node.expression.text)) {
        setKind(node.expression.text, 'call');
      }
    }

    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag)) {
      if (bindingsByLocalName.has(node.tag.text)) {
        setKind(node.tag.text, 'tag');
      }
    }

    if (isAnnotationTarget(node)) {
      for (const annotation of annotationLookup.getAttachedAnnotations(node)) {
        const name = annotation.name;
        if (BUILTIN_DIRECTIVE_NAMES.has(name)) {
          continue;
        }
        if (bindingsByLocalName.has(name)) {
          setKind(name, 'annotation');
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return syntaxKindsByLocalName;
}

export function collectImportedMacroSiteKindsBySpecifier(
  fileName: string,
  text: string,
  options: CollectImportedMacroSiteKindsOptions = {},
): ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>> {
  const sourceFile = sourceFileForText(fileName, text);
  const importedBindings = collectImportedNamedBindingsFromSourceFile(sourceFile);
  const bindingsByLocalName = new Map<string, ImportedNamedBinding>();
  for (const binding of importedBindings) {
    bindingsByLocalName.set(binding.localName, binding);
  }
  const syntaxFallbackKindsByLocalName =
    (options.useSyntaxFallback || options.resolveOnlySyntaxCandidates)
      ? collectSyntaxFallbackKindsByLocalName(sourceFile, bindingsByLocalName)
      : new Map<string, ImportedMacroSiteKind>();

  const explicitSiteKindsBySpecifier = options.explicitSiteKindsBySpecifier ?? new Map();
  const resolvedSiteKindsCache = new Map<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind> | undefined
  >();
  const collected = new Map<string, Map<string, ImportedMacroSiteKind>>();

  const setKind = (
    binding: ImportedNamedBinding,
    kind: ImportedMacroSiteKind,
    overwrite = true,
  ) => {
    let exportKinds = collected.get(binding.specifier);
    if (!exportKinds) {
      exportKinds = new Map();
      collected.set(binding.specifier, exportKinds);
    }
    if (overwrite || !exportKinds.has(binding.exportName)) {
      exportKinds.set(binding.exportName, kind);
    }
  };

  for (const binding of importedBindings) {
    const explicitKinds = explicitSiteKindsBySpecifier.get(binding.specifier);
    const explicitKind = explicitKinds?.get(binding.exportName);
    if (explicitKind) {
      setKind(binding, explicitKind);
      continue;
    }

    if (!options.resolveSiteKindsForSpecifier) {
      continue;
    }

    if (
      options.resolveOnlySyntaxCandidates &&
      !syntaxFallbackKindsByLocalName.has(binding.localName)
    ) {
      continue;
    }

    if (!resolvedSiteKindsCache.has(binding.specifier)) {
      resolvedSiteKindsCache.set(
        binding.specifier,
        options.resolveSiteKindsForSpecifier(binding.specifier),
      );
    }
    const resolvedKind = resolvedSiteKindsCache.get(binding.specifier)?.get(binding.exportName);
    if (resolvedKind) {
      setKind(binding, resolvedKind);
    }
  }

  if (!options.useSyntaxFallback || bindingsByLocalName.size === 0) {
    return collected;
  }

  for (const [localName, kind] of syntaxFallbackKindsByLocalName.entries()) {
    const binding = bindingsByLocalName.get(localName);
    if (binding) {
      setKind(binding, kind, false);
    }
  }

  return collected;
}
