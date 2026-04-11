import ts from 'typescript';

import { BUILTIN_DIRECTIVE_NAMES, createAnnotationLookup } from '../language/annotation_syntax.ts';
import { scanMacroCandidates } from './macro_scanner.ts';
import type {
  MacroGeneratedSpan,
  MacroParseDiagnostic,
  MacroReplacement,
  ParsedMacroArgument,
  ParsedMacroInvocation,
  RewriteResult,
  SourceSpan,
} from './macro_types.ts';

type MacroSite =
  | {
    argumentSpans: readonly ParsedMacroArgument[];
    declarationKind?: never;
    declarationName?: never;
    declarationSpan?: never;
    invocationKind: 'arglist';
    kind: 'call' | 'tag';
    nameSpan: SourceSpan;
    nameText: string;
    replacementSpan: SourceSpan;
    span: SourceSpan;
    rewriteKind: 'expr' | 'stmt';
    trailingBlockSpan?: never;
  }
  | {
    argumentSpans: readonly ParsedMacroArgument[];
    declarationKind: 'class' | 'function' | 'interface' | 'typeAlias';
    declarationName: string | null;
    declarationSpan: SourceSpan;
    invocationKind: 'decl';
    kind: 'annotation';
    nameSpan: SourceSpan;
    nameText: string;
    preserveDeclaration: boolean;
    replacementSpan: SourceSpan;
    span: SourceSpan;
    rewriteKind: 'stmt';
    trailingBlockSpan?: never;
  };

interface ImportedMacroBindings {
  readonly annotationNames: ReadonlySet<string>;
  readonly callNames: ReadonlySet<string>;
  readonly tagNames: ReadonlySet<string>;
}

export type ImportedMacroSiteKind = 'annotation' | 'call' | 'tag';

function createSpan(fileName: string, start: number, end: number): SourceSpan {
  return { fileName, start, end };
}

function createPlaceholder(
  id: number,
  rewriteKind: ParsedMacroInvocation['rewriteKind'],
): string {
  return rewriteKind === 'expr' ? `__sts_macro_expr(${id})` : `__sts_macro_stmt(${id});`;
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

function collectImportedMacroBindings(
  sourceFile: ts.SourceFile,
  importedMacroSiteKindsBySpecifier: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  >,
): ImportedMacroBindings {
  const callNames = new Set<string>();
  const tagNames = new Set<string>();
  const annotationNames = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    const explicitKinds = ts.isStringLiteral(statement.moduleSpecifier)
      ? importedMacroSiteKindsBySpecifier.get(statement.moduleSpecifier.text)
      : undefined;
    if (!explicitKinds) {
      continue;
    }

    if (statement.importClause?.name) {
      const localName = statement.importClause.name.text;
      const explicitKind = explicitKinds.get('default');
      if (explicitKind === 'annotation' && !BUILTIN_DIRECTIVE_NAMES.has(localName)) {
        annotationNames.add(localName);
      } else if (explicitKind === 'call') {
        callNames.add(localName);
      } else if (explicitKind === 'tag') {
        tagNames.add(localName);
      }
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const element of namedBindings.elements) {
      const localName = element.name.text;
      const exportName = element.propertyName?.text ?? localName;
      const explicitKind = explicitKinds?.get(exportName);
      if (explicitKind === 'annotation' && !BUILTIN_DIRECTIVE_NAMES.has(localName)) {
        annotationNames.add(localName);
        continue;
      }
      if (explicitKind === 'call') {
        callNames.add(localName);
        continue;
      }
      if (explicitKind === 'tag') {
        tagNames.add(localName);
        continue;
      }
    }
  }

  return { annotationNames, callNames, tagNames };
}

function parentExpressionStatement(node: ts.Node): ts.ExpressionStatement | null {
  return ts.isExpressionStatement(node.parent) && node.parent.expression === node
    ? node.parent
    : null;
}

function getRewriteKindForCall(node: ts.CallExpression): 'expr' | 'stmt' {
  return parentExpressionStatement(node) ? 'stmt' : 'expr';
}

function createCallSite(sourceFile: ts.SourceFile, node: ts.CallExpression): MacroSite {
  const statement = parentExpressionStatement(node);
  return {
    kind: 'call',
    argumentSpans: node.arguments.map((argument) => ({
      kind: 'ExprArg' as const,
      span: createSpan(sourceFile.fileName, argument.getStart(sourceFile), argument.getEnd()),
    })),
    invocationKind: 'arglist',
    nameSpan: createSpan(
      sourceFile.fileName,
      node.expression.getStart(sourceFile),
      node.expression.getEnd(),
    ),
    nameText: (node.expression as ts.Identifier).text,
    replacementSpan: createSpan(
      sourceFile.fileName,
      statement?.getStart(sourceFile) ?? node.getStart(sourceFile),
      statement?.getEnd() ?? node.getEnd(),
    ),
    span: createSpan(sourceFile.fileName, node.getStart(sourceFile), node.getEnd()),
    rewriteKind: getRewriteKindForCall(node),
  };
}

function createTagSite(sourceFile: ts.SourceFile, node: ts.TaggedTemplateExpression): MacroSite {
  return {
    kind: 'tag',
    argumentSpans: [{
      kind: 'ExprArg',
      span: createSpan(
        sourceFile.fileName,
        node.template.getStart(sourceFile),
        node.template.getEnd(),
      ),
    }],
    invocationKind: 'arglist',
    nameSpan: createSpan(sourceFile.fileName, node.tag.getStart(sourceFile), node.tag.getEnd()),
    nameText: (node.tag as ts.Identifier).text,
    replacementSpan: createSpan(sourceFile.fileName, node.getStart(sourceFile), node.getEnd()),
    span: createSpan(sourceFile.fileName, node.getStart(sourceFile), node.getEnd()),
    rewriteKind: 'expr',
  };
}

function isMacroDeclarationTarget(
  node: ts.Statement,
): node is
  | ts.ClassDeclaration
  | ts.FunctionDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration {
  return ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) ||
    ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
}

function findAnnotationSites(
  annotationLookup: ReturnType<typeof createAnnotationLookup>,
  sourceFile: ts.SourceFile,
  node:
    | ts.ClassDeclaration
    | ts.FunctionDeclaration
    | ts.InterfaceDeclaration
    | ts.TypeAliasDeclaration,
  annotationNames: ReadonlySet<string>,
): readonly MacroSite[] {
  if (annotationNames.size === 0) {
    return [];
  }

  const block = annotationLookup.getAttachedAnnotationBlock(node);
  const matchedAnnotations =
    block?.annotations.filter((annotation) =>
      annotation.nameRange && annotationNames.has(annotation.name)
    ) ?? [];
  if (!block || matchedAnnotations.length === 0) {
    return [];
  }

  const nodeStart = node.getStart(sourceFile);
  const declarationKind = ts.isClassDeclaration(node)
    ? 'class'
    : ts.isFunctionDeclaration(node)
    ? 'function'
    : ts.isInterfaceDeclaration(node)
    ? 'interface'
    : 'typeAlias';
  return matchedAnnotations.map((annotation, index) => ({
    kind: 'annotation',
    argumentSpans: [],
    declarationKind,
    declarationName: node.name?.text ?? null,
    declarationSpan: createSpan(sourceFile.fileName, nodeStart, node.getEnd()),
    invocationKind: 'decl',
    nameSpan: createSpan(
      sourceFile.fileName,
      annotation.nameRange!.start,
      annotation.nameRange!.end,
    ),
    nameText: annotation.name,
    preserveDeclaration: index === 0,
    replacementSpan: createSpan(sourceFile.fileName, block.range.start, node.getEnd()),
    span: createSpan(sourceFile.fileName, block.range.start, node.getEnd()),
    rewriteKind: 'stmt',
  }));
}

function collectMacroSites(
  sourceFile: ts.SourceFile,
  importedMacroSiteKindsBySpecifier: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  >,
  alwaysAvailableMacroSiteKinds: ReadonlyMap<string, ImportedMacroSiteKind>,
): readonly MacroSite[] {
  const bindings = collectImportedMacroBindings(sourceFile, importedMacroSiteKindsBySpecifier);
  const annotationLookup = createAnnotationLookup(sourceFile);
  for (const [name, kind] of alwaysAvailableMacroSiteKinds.entries()) {
    if (kind === 'annotation') {
      (bindings.annotationNames as Set<string>).add(name);
      continue;
    }
    if (kind === 'call') {
      (bindings.callNames as Set<string>).add(name);
      continue;
    }
    (bindings.tagNames as Set<string>).add(name);
  }
  const sites: MacroSite[] = [];

  for (const statement of sourceFile.statements) {
    if (!isMacroDeclarationTarget(statement)) {
      continue;
    }

    const annotationSites = findAnnotationSites(
      annotationLookup,
      sourceFile,
      statement,
      bindings.annotationNames,
    );
    sites.push(...annotationSites);
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      bindings.callNames.has(node.expression.text)
    ) {
      sites.push(createCallSite(sourceFile, node));
      return;
    }

    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      bindings.tagNames.has(node.tag.text)
    ) {
      sites.push(createTagSite(sourceFile, node));
      return;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  sites.sort((left, right) => left.replacementSpan.start - right.replacementSpan.start);

  const filtered: MacroSite[] = [];
  let currentEnd = -1;
  let currentStart = -1;
  for (const site of sites) {
    const sameReplacementSpan = site.replacementSpan.start === currentStart &&
      site.replacementSpan.end === currentEnd;
    if (site.replacementSpan.start < currentEnd && !sameReplacementSpan) {
      continue;
    }
    filtered.push(site);
    currentStart = site.replacementSpan.start;
    currentEnd = site.replacementSpan.end;
  }

  return filtered;
}

function createLegacySyntaxDiagnostic(
  fileName: string,
  start: number,
  end: number,
): MacroParseDiagnostic {
  return {
    fileName,
    reason: 'legacy-syntax',
    span: createSpan(fileName, start, end),
  };
}

function toParsedInvocation(site: MacroSite): ParsedMacroInvocation {
  return {
    argumentSpans: site.argumentSpans,
    declarationKind: site.kind === 'annotation' ? site.declarationKind : undefined,
    declarationName: site.kind === 'annotation' ? site.declarationName : undefined,
    preserveDeclaration: site.kind === 'annotation' ? site.preserveDeclaration : undefined,
    declarationSpan: site.kind === 'annotation' ? site.declarationSpan : undefined,
    fileName: site.span.fileName,
    hashSpan: site.nameSpan,
    nameSpan: site.nameSpan,
    nameText: site.nameText,
    siteKind: site.kind,
    span: site.span,
    trailingBlockSpan: undefined,
    invocationKind: site.invocationKind,
    rewriteKind: site.rewriteKind,
  };
}

function buildRewriteResult(
  text: string,
  sites: readonly MacroSite[],
): RewriteResult {
  const replacements: MacroReplacement[] = [];
  const generatedSpans: MacroGeneratedSpan[] = [];
  const macrosById = new Map<number, ParsedMacroInvocation>();
  let rewrittenText = '';
  let cursor = 0;
  let nextId = 1;

  for (const site of sites) {
    const id = nextId;
    nextId += 1;
    const placeholder = createPlaceholder(id, site.rewriteKind);
    rewrittenText += text.slice(cursor, site.replacementSpan.start);
    const generatedStart = rewrittenText.length;
    rewrittenText += placeholder;
    const generatedEnd = rewrittenText.length;
    cursor = site.replacementSpan.end;

    const rewrittenSpan = {
      fileName: site.span.fileName,
      start: generatedStart,
      end: generatedEnd,
    };
    replacements.push({
      id,
      originalSpan: site.replacementSpan,
      rewriteText: placeholder,
      rewrittenSpan,
    });
    generatedSpans.push({
      generatedEnd,
      generatedFileName: site.span.fileName,
      generatedStart,
      id,
      originalSpan: site.replacementSpan,
    });
    macrosById.set(id, toParsedInvocation(site));
  }

  rewrittenText += text.slice(cursor);
  return {
    diagnostics: [],
    generatedSpans,
    macrosById,
    replacements,
    rewrittenText,
  };
}

export function rewriteMacroSource(
  fileName: string,
  text: string,
  importedMacroSiteKindsBySpecifier: ReadonlyMap<
    string,
    ReadonlyMap<string, ImportedMacroSiteKind>
  > = new Map(),
  alwaysAvailableMacroSiteKinds: ReadonlyMap<string, ImportedMacroSiteKind> = new Map(),
): RewriteResult {
  const legacyHashes = scanMacroCandidates(fileName, text).hashes.filter((hash) =>
    hash.kind === 'macro-start'
  );
  if (legacyHashes.length > 0) {
    const firstLegacyHash = legacyHashes[0]!;
    return {
      diagnostics: [
        createLegacySyntaxDiagnostic(
          fileName,
          firstLegacyHash.span.start,
          firstLegacyHash.span.end,
        ),
      ],
      generatedSpans: [],
      macrosById: new Map(),
      replacements: [],
      rewrittenText: text,
    };
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(fileName),
  );
  return buildRewriteResult(
    text,
    collectMacroSites(sourceFile, importedMacroSiteKindsBySpecifier, alwaysAvailableMacroSiteKinds),
  );
}
