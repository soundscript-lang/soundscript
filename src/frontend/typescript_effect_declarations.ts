import ts from 'typescript';

import { createAnalysisContext } from '../checker/engine/context.ts';
import type {
  AnalysisContext,
  EffectForwardedParameterFact,
  EffectSummaryFact,
} from '../checker/engine/types.ts';
import { getEffectSummaryForDeclaration } from '../checker/effects.ts';
import { dirname, join, relative } from '../platform/path.ts';

type EffectCallableDeclaration =
  | ts.ArrowFunction
  | ts.CallSignatureDeclaration
  | ts.ConstructorDeclaration
  | ts.ConstructSignatureDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.MethodSignature;

interface CallableSummaryRecord {
  readonly declaration: EffectCallableDeclaration;
}

interface CallableSummaryGroup {
  implementationDefault?: CallableSummaryRecord;
  readonly records: CallableSummaryRecord[];
}

function isCallableDeclarationNode(node: ts.Node): node is EffectCallableDeclaration {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
}

function isCallableBodyDeclaration(
  node: EffectCallableDeclaration,
): node is
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration {
  return 'body' in node && node.body !== undefined;
}

function getNamedDeclarationText(node: ts.Node): string | undefined {
  const name = (node as ts.NamedDeclaration).name;
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function getCallableOwnerPathSegment(node: ts.Node): string | undefined {
  if (
    ts.isClassDeclaration(node) || ts.isClassExpression(node) ||
    ts.isInterfaceDeclaration(node) || ts.isModuleDeclaration(node)
  ) {
    return getNamedDeclarationText(node);
  }
  return undefined;
}

function getCallableKindKey(node: EffectCallableDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    return node.name && ts.isIdentifier(node.name) ? `function:${node.name.text}` : undefined;
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
    const name = getNamedDeclarationText(node);
    if (!name) {
      return undefined;
    }
    const isStatic = node.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.StaticKeyword
    ) ??
      false;
    return `${isStatic ? 'static-method' : 'method'}:${name}`;
  }
  if (ts.isConstructorDeclaration(node)) {
    return 'constructor';
  }
  if (ts.isCallSignatureDeclaration(node)) {
    return 'call';
  }
  if (ts.isConstructSignatureDeclaration(node)) {
    return 'construct';
  }
  return undefined;
}

function getCallableGroupKey(
  node: EffectCallableDeclaration,
  ownerPath: readonly string[],
): string | undefined {
  const kindKey = getCallableKindKey(node);
  return kindKey ? [...ownerPath, kindKey].join('>') : undefined;
}

function collectCallableSummaryGroups(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, CallableSummaryGroup> {
  const groups = new Map<string, CallableSummaryGroup>();

  function visit(node: ts.Node, ownerPath: readonly string[]): void {
    if (isCallableDeclarationNode(node)) {
      const key = getCallableGroupKey(node, ownerPath);
      if (key) {
        const record: CallableSummaryRecord = { declaration: node };
        const group = groups.get(key) ?? { records: [] };
        group.records.push(record);
        if (isCallableBodyDeclaration(node)) {
          group.implementationDefault ??= record;
        }
        groups.set(key, group);
      }
    }

    const nextSegment = getCallableOwnerPathSegment(node);
    const nextOwnerPath = nextSegment ? [...ownerPath, nextSegment] : ownerPath;
    ts.forEachChild(node, (child) => visit(child, nextOwnerPath));
  }

  visit(sourceFile, []);
  return groups;
}

function getParameterReferenceName(
  declaration: EffectCallableDeclaration,
  parameterIndex: number,
): string | undefined {
  const parameter = declaration.parameters[parameterIndex];
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

function renderRewriteList(
  forwardedParameter: EffectForwardedParameterFact,
): readonly string[] {
  if (forwardedParameter.rewrites.length > 0) {
    return forwardedParameter.rewrites.map((rewrite) =>
      `{ from: ${rewrite.from}, to: ${rewrite.to} }`
    );
  }
  if (forwardedParameter.failureBoundary === 'reject') {
    return ['{ from: fails, to: fails.rejects }'];
  }
  return [];
}

function renderHandledEffects(
  forwardedParameter: EffectForwardedParameterFact,
): readonly string[] {
  if (forwardedParameter.handledEffects.length > 0) {
    return forwardedParameter.handledEffects;
  }
  if (forwardedParameter.failureBoundary === 'capture') {
    return ['fails'];
  }
  return [];
}

function renderForwardEntry(
  forwardedParameter: EffectForwardedParameterFact,
  declaration: EffectCallableDeclaration,
): string | undefined {
  const parameterName = getParameterReferenceName(declaration, forwardedParameter.parameterIndex);
  if (!parameterName) {
    return undefined;
  }

  const path = [parameterName, ...forwardedParameter.memberPath].join('.');
  const rewrites = renderRewriteList(forwardedParameter);
  const handledEffects = renderHandledEffects(forwardedParameter);
  if (
    rewrites.length === 0 && handledEffects.length === 0 &&
    forwardedParameter.memberPath.length === 0
  ) {
    return path;
  }

  const fields = [`from: ${path}`];
  if (rewrites.length > 0) {
    fields.push(`rewrite: [${rewrites.join(', ')}]`);
  }
  if (handledEffects.length > 0) {
    fields.push(`handle: [${handledEffects.join(', ')}]`);
  }
  return `{ ${fields.join(', ')} }`;
}

function renderEffectsAnnotation(
  summary: EffectSummaryFact,
  declaration: EffectCallableDeclaration,
): string {
  const fields: string[] = [];
  fields.push(`add: [${summary.directEffects.join(', ')}]`);

  const forwardEntries = summary.forwardedParameters
    .map((forwardedParameter) => renderForwardEntry(forwardedParameter, declaration))
    .filter((entry): entry is string => entry !== undefined);
  if (forwardEntries.length > 0) {
    fields.push(`forward: [${forwardEntries.join(', ')}]`);
  }
  if (summary.hasUnknownDirectEffects) {
    fields.push('unknown: [direct]');
  }

  return `// #[effects(${fields.join(', ')})]`;
}

function addAnnotationComment(node: ts.Node, commentText: string | undefined): void {
  if (!commentText) {
    return;
  }
  ts.addSyntheticLeadingComment(
    node,
    ts.SyntaxKind.SingleLineCommentTrivia,
    ` ${commentText.slice('//'.length).trimStart()}`,
    true,
  );
}

function rewriteRelativeTypeScriptSpecifierText(
  declarationFileName: string,
  declarationText: string,
): string {
  const sourceFile = ts.createSourceFile(
    declarationFileName,
    declarationText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const replacements: { start: number; end: number; text: string }[] = [];

  function maybeQueueSpecifierRewrite(node: ts.StringLiteralLike): void {
    const specifier = node.text;
    if (
      !(specifier.startsWith('./') || specifier.startsWith('../')) ||
      !/\.(cts|mts|tsx|ts)$/u.test(specifier)
    ) {
      return;
    }

    const rawText = sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
    const quote = rawText.startsWith('"') ? '"' : "'";
    const nextSpecifier = specifier.replace(/\.(cts|mts|tsx|ts)$/u, '');
    replacements.push({
      start: node.getStart(sourceFile),
      end: node.getEnd(),
      text: `${quote}${nextSpecifier}${quote}`,
    });
  }

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
    ) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
        maybeQueueSpecifierRewrite(moduleSpecifier);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const argumentLiteral = node.argument.literal;
      if (ts.isStringLiteralLike(argumentLiteral)) {
        maybeQueueSpecifierRewrite(argumentLiteral);
      }
    } else if (
      ts.isExternalModuleReference(node) && node.expression &&
      ts.isStringLiteralLike(node.expression)
    ) {
      maybeQueueSpecifierRewrite(node.expression);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (replacements.length === 0) {
    return declarationText;
  }

  let rewrittenText = declarationText;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    rewrittenText = rewrittenText.slice(0, replacement.start) + replacement.text +
      rewrittenText.slice(replacement.end);
  }
  return rewrittenText;
}

function normalizePathForComparison(path: string): string {
  return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase();
}

function expectedDeclarationOutputPath(
  program: ts.Program,
  sourceFile: ts.SourceFile,
): string | undefined {
  const outDir = program.getCompilerOptions().outDir;
  if (!outDir) {
    return undefined;
  }
  const programSourceFiles = program.getSourceFiles().filter((candidate) =>
    !candidate.isDeclarationFile
  );
  if (programSourceFiles.length === 0) {
    return undefined;
  }

  let commonSourceDirectory = dirname(programSourceFiles[0]!.fileName);
  while (
    commonSourceDirectory.length > 1 &&
    !programSourceFiles.every((candidate) =>
      normalizePathForComparison(candidate.fileName).startsWith(
        `${normalizePathForComparison(commonSourceDirectory).replace(/[/\\\\]+$/u, '')}/`,
      ) ||
      normalizePathForComparison(candidate.fileName) ===
        normalizePathForComparison(commonSourceDirectory)
    )
  ) {
    const parentDirectory = dirname(commonSourceDirectory);
    if (parentDirectory === commonSourceDirectory) {
      break;
    }
    commonSourceDirectory = parentDirectory;
  }

  const relativeSourcePath = relative(commonSourceDirectory, sourceFile.fileName)
    .replaceAll('\\', '/');
  return join(outDir, relativeSourcePath).replace(/\.(ts|tsx|mts|cts)$/u, '.d.ts');
}

export function projectEffectAnnotationsOntoDeclarationText(
  context: AnalysisContext,
  sourceFile: ts.SourceFile,
  declarationFileName: string,
  declarationText: string,
): string {
  const callableGroups = collectCallableSummaryGroups(sourceFile);
  if (callableGroups.size === 0) {
    return declarationText;
  }

  const declarationSourceFile = ts.createSourceFile(
    declarationFileName,
    declarationText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const seenByKey = new Map<string, number>();

  function visit(node: ts.Node, ownerPath: readonly string[]): void {
    if (isCallableDeclarationNode(node)) {
      const key = getCallableGroupKey(node, ownerPath);
      if (key) {
        const ordinal = seenByKey.get(key) ?? 0;
        seenByKey.set(key, ordinal + 1);
        const group = callableGroups.get(key);
        const sourceRecord = group?.implementationDefault ?? group?.records[ordinal];
        if (sourceRecord) {
          const summary = getEffectSummaryForDeclaration(context, sourceRecord.declaration);
          addAnnotationComment(node, renderEffectsAnnotation(summary, node));
          for (const contract of summary.parameterContracts) {
            const parameter = node.parameters[contract.parameterIndex];
            if (!parameter) {
              continue;
            }
            addAnnotationComment(
              parameter,
              `// #[effects(forbid: [${contract.forbidEffects.join(', ')}])]`,
            );
          }
        }
      }
    }

    const nextSegment = getCallableOwnerPathSegment(node);
    const nextOwnerPath = nextSegment ? [...ownerPath, nextSegment] : ownerPath;
    ts.forEachChild(node, (child) => visit(child, nextOwnerPath));
  }

  visit(declarationSourceFile, []);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  return rewriteRelativeTypeScriptSpecifierText(
    declarationFileName,
    printer.printFile(declarationSourceFile),
  );
}

export function captureTypeScriptDeclarationOutputs(
  program: ts.Program,
  { workingDirectory = ts.sys.getCurrentDirectory() }: { workingDirectory?: string } = {},
): ReadonlyMap<string, string> {
  const context = createAnalysisContext({ program, workingDirectory });
  const outputs = new Map<string, string>();
  const sourceFileByOutputPath = new Map<string, ts.SourceFile>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }
    const outputPath = expectedDeclarationOutputPath(program, sourceFile);
    if (!outputPath) {
      continue;
    }
    sourceFileByOutputPath.set(normalizePathForComparison(outputPath), sourceFile);
  }
  program.emit(
    undefined,
    (fileName, text) => {
      const sourceFile = sourceFileByOutputPath.get(normalizePathForComparison(fileName));
      outputs.set(
        fileName,
        sourceFile && fileName.endsWith('.d.ts')
          ? projectEffectAnnotationsOntoDeclarationText(
            context,
            sourceFile,
            fileName,
            text,
          )
          : text,
      );
    },
    undefined,
    true,
  );
  return outputs;
}
