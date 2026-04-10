import ts from 'typescript';

import type { NestedMacroRegistries } from './macro_advanced_backend_adapter.ts';
import { expandPreparedProgramWithFileRegistries } from './macro_expander.ts';
import {
  createPreparedProgram,
  mapProgramPositionToSource,
  mapSourcePositionToProgram,
  type PreparedProgram,
  type PreparedSourceFile,
} from './project_frontend.ts';
import { rewriteMacroSource } from './macro_rewrite.ts';
import { createMacroSemantics } from './macro_semantics.ts';
import type {
  CanonicalResultCarrierInfo,
  CanonicalResultInfo,
  MacroFunctionContext,
  MacroType,
} from './macro_semantic_types.ts';
import type { ResolvedMacroPlaceholder } from './macro_resolver.ts';
import type { ParsedMacroInvocation, SourceSpan } from './macro_types.ts';

export interface ResolvedExprArgumentOperand {
  expandedText: string;
  preludeTexts: readonly string[];
  node: ts.Expression;
  semantics: ReturnType<typeof createMacroSemantics>;
  sourceFile: ts.SourceFile;
}

export interface ResolvedPrimaryExprOperand extends ResolvedExprArgumentOperand {}

interface SharedExprOperandFileSource {
  semantics: ReturnType<typeof createMacroSemantics>;
  sourceFile: ts.SourceFile;
  spansByPlaceholderId: ReadonlyMap<number, SourceSpan>;
}

export interface MaterializedMacroMappingSegment {
  generatedEnd: number;
  generatedStart: number;
  sourceEnd: number;
  sourceStart: number;
}

export interface MaterializedMacroHoverRegion {
  hoverPosition: number;
  mappings: readonly MaterializedMacroMappingSegment[];
  text: string;
}

export interface MaterializedSourceRange {
  end: number;
  intersectsUnmapped: boolean;
  start: number;
}

export interface PatchedMacroRegion {
  checker: ts.TypeChecker;
  materializedRegion: MaterializedMacroHoverRegion;
  originalReplacementEnd: number;
  originalReplacementStart: number;
  rewrittenStart: number;
  semantics: ReturnType<typeof createMacroSemantics>;
  sourceFile: ts.SourceFile;
}

export interface ResolvedMacroHoverNode extends PatchedMacroRegion {
  node: ts.Node;
}

export interface ResolvedMacroBlockNode extends ResolvedMacroHoverNode {
  originalBlockSpan: SourceSpan;
}

export interface NestedMacroHoverTarget {
  invocation: ParsedMacroInvocation;
  kind: 'macro';
}

const COMPLETION_PLACEHOLDER_IDENTIFIER = '__sts_completion_target';
const sharedExprOperandFileSourceCache = new WeakMap<
  PreparedProgram,
  Map<string, SharedExprOperandFileSource | null>
>();

function isNestedMacroHoverTarget(
  value: MaterializedMacroHoverRegion | NestedMacroHoverTarget,
): value is NestedMacroHoverTarget {
  return 'kind' in value;
}

function _getPrimaryExprSpan(invocation: ParsedMacroInvocation): SourceSpan | undefined {
  if (getBlockSpan(invocation) || invocation.declarationSpan) {
    return undefined;
  }

  const expressionArguments = invocation.argumentSpans.filter((argument) =>
    argument.kind === 'ExprArg'
  );
  if (
    expressionArguments.length !== 1 ||
    expressionArguments.length !== invocation.argumentSpans.length
  ) {
    return undefined;
  }

  return expressionArguments[0]?.span;
}

function getExprArgumentSpan(
  invocation: ParsedMacroInvocation,
  index: number,
): SourceSpan | undefined {
  const argument = invocation.argumentSpans[index];
  return argument?.kind === 'ExprArg' ? argument.span : undefined;
}

function exprArgumentContainsNestedMacroInvocation(
  fileName: string,
  originalText: string,
  exprSpan: SourceSpan,
  nestedRegistries: NestedMacroRegistries,
): boolean {
  const sourceFile = ts.createSourceFile(
    fileName,
    originalText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const importPrelude = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => statement.getText(sourceFile))
    .join('\n');
  const operandText = originalText.slice(exprSpan.start, exprSpan.end);
  const probeSourceText = importPrelude.length > 0
    ? `${importPrelude}\nconst __sts_nested_probe = ${operandText};\n`
    : `const __sts_nested_probe = ${operandText};\n`;

  return rewriteMacroSource(
    fileName,
    probeSourceText,
    nestedRegistries.siteKindsBySpecifier ?? new Map(),
    getAlwaysAvailableBuiltinMacroSiteKinds(),
  ).replacements.length > 0;
}

function _getExpressionArgumentSpan(
  invocation: ParsedMacroInvocation,
  expressionArgumentIndex: number,
): SourceSpan | undefined {
  const expressionArguments = invocation.argumentSpans.filter((argument) =>
    argument.kind === 'ExprArg'
  );
  return expressionArguments[expressionArgumentIndex]?.span;
}

function getBlockSpan(invocation: ParsedMacroInvocation): SourceSpan | undefined {
  if (invocation.trailingBlockSpan) {
    return invocation.trailingBlockSpan;
  }

  if (invocation.invocationKind === 'block') {
    const [firstArgument] = invocation.argumentSpans;
    if (firstArgument?.kind === 'BlockArg') {
      return firstArgument.span;
    }
  }

  return undefined;
}

function containsPosition(span: SourceSpan, position: number): boolean {
  return position >= span.start && position < span.end;
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Continue}_$\u200C\u200D]/u.test(character);
}

function neutralizeMacroInvocation(invocation: ParsedMacroInvocation): string {
  return invocation.rewriteKind === 'expr' ? 'undefined' : '{}';
}

function replaceRange(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

function createStageTwoPreparedFile(preparedFile: PreparedSourceFile): PreparedSourceFile | null {
  if (!preparedFile.postRewriteStage) {
    return null;
  }

  return {
    diagnostics: preparedFile.diagnostics,
    originalText: preparedFile.rewriteResult.rewrittenText,
    rewriteResult: preparedFile.postRewriteStage as typeof preparedFile.rewriteResult,
    rewrittenText: preparedFile.rewrittenText,
  };
}

function mapProgramPositionToStageOne(
  preparedFile: PreparedSourceFile,
  position: number,
): number {
  const stageTwoPreparedFile = createStageTwoPreparedFile(preparedFile);
  return stageTwoPreparedFile
    ? mapProgramPositionToSource(stageTwoPreparedFile, position).position
    : position;
}

function mapStageOnePositionToProgram(
  preparedFile: PreparedSourceFile,
  position: number,
): number {
  const stageTwoPreparedFile = createStageTwoPreparedFile(preparedFile);
  return stageTwoPreparedFile
    ? mapSourcePositionToProgram(stageTwoPreparedFile, position).position
    : position;
}

function appendMappedText(
  output: string,
  mappings: MaterializedMacroMappingSegment[],
  text: string,
  sourceStart: number,
): string {
  if (text.length === 0) {
    return output;
  }

  const generatedStart = output.length;
  mappings.push({
    generatedStart,
    generatedEnd: generatedStart + text.length,
    sourceStart,
    sourceEnd: sourceStart + text.length,
  });
  return output + text;
}

function collectInvocationsInRegion(
  fileName: string,
  originalText: string,
  regionSpan: SourceSpan,
): readonly ParsedMacroInvocation[] {
  const rewriteResult = rewriteMacroSource(
    fileName,
    originalText,
    new Map(),
    getAlwaysAvailableBuiltinMacroSiteKinds(),
  );
  if (rewriteResult.replacements.length === 0) {
    return [];
  }

  return rewriteResult.replacements
    .map((replacement) => rewriteResult.macrosById.get(replacement.id))
    .filter((invocation): invocation is ParsedMacroInvocation =>
      invocation !== undefined &&
      invocation.span.start >= regionSpan.start &&
      invocation.span.start < regionSpan.end &&
      invocation.span.end <= regionSpan.end
    )
    .sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end);
}

function findContainingStatement(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node;

  while (current && !ts.isSourceFile(current)) {
    if (ts.isStatement(current)) {
      let statement = current;
      while (statement.parent && ts.isLabeledStatement(statement.parent)) {
        statement = statement.parent;
      }
      return statement;
    }
    current = current.parent;
  }

  return undefined;
}

function isSentinelStatement(statement: ts.Statement, name: string): boolean {
  return ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression) &&
    statement.expression.expression.text === name &&
    statement.expression.arguments.length === 0;
}

function findStatementRegionBetweenSentinels(
  node: ts.Node,
  beforeName: string,
  afterName: string,
): readonly ts.Statement[] | null {
  const statements = (() => {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
      return node.statements;
    }
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      return node.statements;
    }
    return null;
  })();

  if (statements) {
    const beforeIndex = statements.findIndex((statement) =>
      isSentinelStatement(statement, beforeName)
    );
    const afterIndex = statements.findIndex((statement) =>
      isSentinelStatement(statement, afterName)
    );
    if (beforeIndex >= 0 && afterIndex > beforeIndex) {
      return statements.slice(beforeIndex + 1, afterIndex);
    }
  }

  return ts.forEachChild(
    node,
    (child) => findStatementRegionBetweenSentinels(child, beforeName, afterName),
  ) ?? null;
}

function findCaptureCallInStatement(
  statement: ts.Statement,
  captureName: string,
): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === captureName
    ) {
      found = node;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(statement);
  return found;
}

function printNode(sourceFile: ts.SourceFile, node: ts.Node, hint: ts.EmitHint): string {
  return ts.createPrinter({ removeComments: false }).printNode(hint, node, sourceFile);
}

function collectSyntheticNames(
  statements: readonly ts.Statement[],
): ReadonlySet<string> {
  const names = new Set<string>();

  function collectBindingName(name: ts.BindingName) {
    if (ts.isIdentifier(name) && name.text.startsWith('__sts_')) {
      names.add(name.text);
      return;
    }

    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          collectBindingName(element.name);
        }
      }
    }
  }

  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node)) {
      collectBindingName(node.name);
    } else if (ts.isLabeledStatement(node) && node.label.text.startsWith('__sts_')) {
      names.add(node.label.text);
    }

    ts.forEachChild(node, visit);
  }

  for (const statement of statements) {
    visit(statement);
  }

  return names;
}

function renameSyntheticNamesInNode<T extends ts.Node>(
  node: T,
  renameMap: ReadonlyMap<string, string>,
): T {
  if (renameMap.size === 0) {
    return node;
  }

  const transformed = ts.transform(node, [
    (context) => {
      const visitor: ts.Visitor = (current) => {
        if (ts.isIdentifier(current)) {
          const renamed = renameMap.get(current.text);
          if (renamed) {
            return ts.factory.createIdentifier(renamed);
          }
          return current;
        }

        if (ts.isLabeledStatement(current)) {
          const renamed = renameMap.get(current.label.text);
          if (renamed) {
            return ts.factory.updateLabeledStatement(
              current,
              ts.factory.createIdentifier(renamed),
              ts.visitNode(current.statement, visitor) as ts.Statement,
            );
          }
        }

        if (ts.isBreakStatement(current) && current.label) {
          const renamed = renameMap.get(current.label.text);
          if (renamed) {
            return ts.factory.updateBreakStatement(
              current,
              ts.factory.createIdentifier(renamed),
            );
          }
        }

        if (ts.isContinueStatement(current) && current.label) {
          const renamed = renameMap.get(current.label.text);
          if (renamed) {
            return ts.factory.updateContinueStatement(
              current,
              ts.factory.createIdentifier(renamed),
            );
          }
        }

        return ts.visitEachChild(current, visitor, context);
      };

      return (root) => ts.visitNode(root, visitor) as T;
    },
  ]);
  try {
    return transformed.transformed[0] as T;
  } finally {
    transformed.dispose();
  }
}

function containsNestedAdvancedMacroCall(
  fileName: string,
  operandText: string,
  advancedRegistry: NestedMacroRegistries['advanced'],
): boolean {
  if (advancedRegistry.size === 0) {
    return false;
  }

  const sourceFile = ts.createSourceFile(
    fileName,
    `const __sts_probe = ${operandText};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^[A-Z]/u.test(node.expression.text) &&
      advancedRegistry.has(node.expression.text)
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function expandNestedOperandSource(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  patchedText: string,
  nestedRegistries: NestedMacroRegistries,
): ts.SourceFile | null {
  const replacement = resolved.placeholder.replacement;
  const rewrittenProgramFileName = preparedProgram.toProgramFileName(
    replacement.rewrittenSpan.fileName,
  );
  const nestedPreparedProgram = createPreparedProgram({
    baseHost: preparedProgram.preparedHost.host,
    fileOverrides: new Map([[replacement.rewrittenSpan.fileName, patchedText]]),
    importedMacroSiteKindsBySpecifier: nestedRegistries.siteKindsBySpecifier ?? new Map(),
    options: preparedProgram.options,
    rootNames: preparedProgram.rootNames,
  });
  const expandedFiles = expandPreparedProgramWithFileRegistries(
    nestedPreparedProgram,
    new Map([[
      rewrittenProgramFileName,
      {
        registry: nestedRegistries.rewrite,
        advancedRegistry: nestedRegistries.advanced,
      },
    ]]),
  );
  const expandedSourceFile = expandedFiles.get(rewrittenProgramFileName);
  if (!expandedSourceFile) {
    return null;
  }

  const expandedText = printNode(expandedSourceFile, expandedSourceFile, ts.EmitHint.Unspecified);
  const overrideHost: ts.CompilerHost = {
    ...nestedPreparedProgram.preparedHost.host,
    getSourceFile(
      fileName: string,
      languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): ts.SourceFile | undefined {
      if (fileName === rewrittenProgramFileName) {
        return ts.createSourceFile(fileName, expandedText, languageVersion, true);
      }

      return nestedPreparedProgram.preparedHost.host.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    readFile(fileName: string): string | undefined {
      if (fileName === rewrittenProgramFileName) {
        return expandedText;
      }

      return nestedPreparedProgram.preparedHost.host.readFile(fileName);
    },
  };
  const finalProgram = ts.createProgram({
    host: overrideHost,
    oldProgram: nestedPreparedProgram.program,
    options: nestedPreparedProgram.options,
    rootNames: nestedPreparedProgram.rootNames.map((fileName) =>
      nestedPreparedProgram.toProgramFileName(fileName)
    ),
  });
  return finalProgram.getSourceFile(rewrittenProgramFileName) ?? null;
}

function materializeNestedOperandExpansionViaCapture(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  operandText: string,
  nestedRegistries: NestedMacroRegistries,
): { expressionText: string; preludeTexts: readonly string[] } | null {
  const replacement = resolved.placeholder.replacement;
  const preparedFile = resolved.placeholder.preparedFile;
  const sourceFile = resolved.callExpression.getSourceFile();
  const containingStatement = findContainingStatement(resolved.callExpression);
  if (!containingStatement) {
    return null;
  }

  const captureName = '__sts_nested_capture';
  const beforeName = '__sts_nested_before';
  const afterName = '__sts_nested_after';
  const statementStart = mapProgramPositionToStageOne(
    preparedFile,
    containingStatement.getStart(sourceFile),
  );
  const statementEnd = mapProgramPositionToStageOne(
    preparedFile,
    containingStatement.getEnd(),
  );
  const replacementStart = replacement.rewrittenSpan.start;
  const replacementEnd = replacement.rewrittenSpan.end;
  const statementText = preparedFile.rewriteResult.rewrittenText.slice(
    statementStart,
    statementEnd,
  );
  const patchedStatementText = replaceRange(
    statementText,
    replacementStart - statementStart,
    replacementEnd - statementStart,
    `${captureName}(${operandText})`,
  );
  const patchedText = [
    preparedFile.rewriteResult.rewrittenText.slice(0, statementStart),
    `${beforeName}();\n${patchedStatementText}\n${afterName}();`,
    preparedFile.rewriteResult.rewrittenText.slice(statementEnd),
  ].join('');

  const finalSourceFile = expandNestedOperandSource(
    preparedProgram,
    resolved,
    patchedText,
    nestedRegistries,
  );
  if (!finalSourceFile) {
    return null;
  }

  const statementRegion = findStatementRegionBetweenSentinels(
    finalSourceFile,
    beforeName,
    afterName,
  );
  if (!statementRegion || statementRegion.length === 0) {
    return null;
  }
  const filteredRegion = statementRegion.filter((statement) =>
    !isSentinelStatement(statement, beforeName) && !isSentinelStatement(statement, afterName)
  );
  if (filteredRegion.length === 0) {
    return null;
  }

  const statementIndex = filteredRegion.findIndex((statement) =>
    findCaptureCallInStatement(statement, captureName) !== undefined
  );
  if (statementIndex < 0) {
    return null;
  }

  const captureCall = findCaptureCallInStatement(filteredRegion[statementIndex]!, captureName);
  if (!captureCall || captureCall.arguments.length !== 1) {
    return null;
  }

  const syntheticNames = collectSyntheticNames(filteredRegion);
  const renameMap = new Map<string, string>();
  for (const syntheticName of syntheticNames) {
    renameMap.set(syntheticName, `${syntheticName}__nested_${resolved.placeholder.id}`);
  }

  const renamedPreludeStatements = filteredRegion
    .slice(0, statementIndex)
    .map((statement) => renameSyntheticNamesInNode(statement, renameMap));
  const renamedExpression = renameSyntheticNamesInNode(captureCall.arguments[0]!, renameMap);

  return {
    expressionText: printNode(finalSourceFile, renamedExpression, ts.EmitHint.Expression),
    preludeTexts: renamedPreludeStatements.map((statement) =>
      printNode(finalSourceFile, statement, ts.EmitHint.Unspecified)
    ),
  };
}

function materializeNestedOperandExpansionViaTempBinding(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  operandText: string,
  nestedRegistries: NestedMacroRegistries,
): { expressionText: string; preludeTexts: readonly string[] } | null {
  const preparedFile = resolved.placeholder.preparedFile;
  const sourceFile = resolved.callExpression.getSourceFile();
  const containingStatement = findContainingStatement(resolved.callExpression);
  if (!containingStatement) {
    return null;
  }

  const beforeName = '__sts_nested_before';
  const afterName = '__sts_nested_after';
  const resultName = '__sts_nested_result';
  const statementStart = mapProgramPositionToStageOne(
    preparedFile,
    containingStatement.getStart(sourceFile),
  );
  const patchedText = [
    preparedFile.rewriteResult.rewrittenText.slice(0, statementStart),
    `${beforeName}();\nconst ${resultName} = ${operandText};\n${afterName}();\n`,
    preparedFile.rewriteResult.rewrittenText.slice(statementStart),
  ].join('');

  const finalSourceFile = expandNestedOperandSource(
    preparedProgram,
    resolved,
    patchedText,
    nestedRegistries,
  );
  if (!finalSourceFile) {
    return null;
  }

  const statementRegion = findStatementRegionBetweenSentinels(
    finalSourceFile,
    beforeName,
    afterName,
  );
  if (!statementRegion || statementRegion.length === 0) {
    return null;
  }
  const filteredRegion = statementRegion.filter((statement) =>
    !isSentinelStatement(statement, beforeName) && !isSentinelStatement(statement, afterName)
  );
  if (filteredRegion.length === 0) {
    return null;
  }

  const syntheticNames = collectSyntheticNames(filteredRegion);
  const renameMap = new Map<string, string>();
  for (const syntheticName of syntheticNames) {
    renameMap.set(syntheticName, `${syntheticName}__nested_${resolved.placeholder.id}`);
  }

  const renamedPreludeStatements = filteredRegion.map((statement) =>
    renameSyntheticNamesInNode(statement, renameMap)
  );
  const renamedResultName = renameMap.get(resultName) ?? resultName;

  return {
    expressionText: renamedResultName,
    preludeTexts: renamedPreludeStatements.map((statement) =>
      printNode(finalSourceFile, statement, ts.EmitHint.Unspecified)
    ),
  };
}

function materializeNestedOperandExpansion(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  operandText: string,
  nestedRegistries: NestedMacroRegistries,
): { expressionText: string; preludeTexts: readonly string[] } | null {
  return containsNestedAdvancedMacroCall(
      resolved.placeholder.invocation.fileName,
      operandText,
      nestedRegistries.advanced,
    )
    ? materializeNestedOperandExpansionViaTempBinding(
      preparedProgram,
      resolved,
      operandText,
      nestedRegistries,
    )
    : materializeNestedOperandExpansionViaCapture(
      preparedProgram,
      resolved,
      operandText,
      nestedRegistries,
    );
}

function findExpressionAtSpan(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): ts.Expression | undefined {
  let found: ts.Expression | undefined;

  function visit(node: ts.Node) {
    if (
      ts.isExpression(node) &&
      node.getStart(sourceFile) === start &&
      node.getEnd() === end
    ) {
      found = node;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function sharedExprOperandFileSourceCacheKey(
  rewrittenProgramFileName: string,
  index: number,
): string {
  return `${rewrittenProgramFileName}\0${index}`;
}

function buildSharedExprOperandFileSource(
  preparedProgram: PreparedProgram,
  preparedFile: PreparedSourceFile,
  sourceFileName: string,
  index: number,
  nestedRegistries: NestedMacroRegistries,
): SharedExprOperandFileSource | null {
  const rewrittenProgramFileName = preparedProgram.toProgramFileName(sourceFileName);
  const replacements: Array<{ end: number; id: number; operandText: string; start: number }> = [];
  for (const replacement of preparedFile.rewriteResult.replacements) {
    const invocation = preparedFile.rewriteResult.macrosById.get(replacement.id);
    if (!invocation) {
      continue;
    }

    const exprSpan = getExprArgumentSpan(invocation, index);
    if (!exprSpan) {
      continue;
    }

    if (
      exprArgumentContainsNestedMacroInvocation(
        sourceFileName,
        preparedFile.originalText,
        exprSpan,
        nestedRegistries,
      )
    ) {
      continue;
    }

    const operandText = preparedFile.originalText.slice(exprSpan.start, exprSpan.end);
    replacements.push({
      id: replacement.id,
      end: mapStageOnePositionToProgram(preparedFile, replacement.rewrittenSpan.end),
      operandText,
      start: mapStageOnePositionToProgram(preparedFile, replacement.rewrittenSpan.start),
    });
  }
  replacements.sort((left, right) => left.start - right.start);

  if (replacements.length === 0) {
    return null;
  }

  let patchedText = '';
  let cursor = 0;
  const spansByPlaceholderId = new Map<number, SourceSpan>();
  for (const replacement of replacements) {
    patchedText += preparedFile.rewrittenText.slice(cursor, replacement.start);
    const patchedStart = patchedText.length;
    patchedText += replacement.operandText;
    spansByPlaceholderId.set(replacement.id, {
      end: patchedStart + replacement.operandText.length,
      fileName: sourceFileName,
      start: patchedStart,
    });
    cursor = replacement.end;
  }
  patchedText += preparedFile.rewrittenText.slice(cursor);

  const overrideHost: ts.CompilerHost = {
    ...preparedProgram.preparedHost.host,
    getSourceFile(
      fileName: string,
      languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): ts.SourceFile | undefined {
      if (fileName === rewrittenProgramFileName) {
        return ts.createSourceFile(fileName, patchedText, languageVersion, true);
      }

      return preparedProgram.preparedHost.host.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    readFile(fileName: string): string | undefined {
      if (fileName === rewrittenProgramFileName) {
        return patchedText;
      }

      return preparedProgram.preparedHost.host.readFile(fileName);
    },
  };

  const patchedProgram = ts.createProgram({
    host: overrideHost,
    oldProgram: preparedProgram.program,
    options: preparedProgram.options,
    rootNames: preparedProgram.rootNames.map((fileName) =>
      preparedProgram.toProgramFileName(fileName)
    ),
  });
  const patchedSourceFile = patchedProgram.getSourceFile(rewrittenProgramFileName);
  if (!patchedSourceFile) {
    return null;
  }

  return {
    semantics: createMacroSemantics(patchedProgram),
    sourceFile: patchedSourceFile,
    spansByPlaceholderId,
  };
}

function getSharedExprOperandFileSource(
  preparedProgram: PreparedProgram,
  preparedFile: PreparedSourceFile,
  sourceFileName: string,
  index: number,
  nestedRegistries: NestedMacroRegistries,
): SharedExprOperandFileSource | null {
  let programCache = sharedExprOperandFileSourceCache.get(preparedProgram);
  if (!programCache) {
    programCache = new Map();
    sharedExprOperandFileSourceCache.set(preparedProgram, programCache);
  }

  const rewrittenProgramFileName = preparedProgram.toProgramFileName(sourceFileName);
  const cacheKey = sharedExprOperandFileSourceCacheKey(rewrittenProgramFileName, index);
  if (!programCache.has(cacheKey)) {
    programCache.set(
      cacheKey,
      buildSharedExprOperandFileSource(
        preparedProgram,
        preparedFile,
        sourceFileName,
        index,
        nestedRegistries,
      ),
    );
  }

  return programCache.get(cacheKey) ?? null;
}

function findDeepestNodeContainingPosition(node: ts.Node, position: number): ts.Node | undefined {
  if (position < node.getFullStart() || position >= node.getEnd()) {
    return undefined;
  }

  const child = ts.forEachChild(
    node,
    (currentChild) => findDeepestNodeContainingPosition(currentChild, position),
  );
  return child ?? node;
}

function createPatchedMacroSource(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  replacementText: string,
): {
  checker: ts.TypeChecker;
  originalReplacementEnd: number;
  originalReplacementStart: number;
  rewrittenStart: number;
  semantics: ReturnType<typeof createMacroSemantics>;
  sourceFile: ts.SourceFile;
} | null {
  const replacement = resolved.placeholder.replacement;
  const preparedFile = resolved.placeholder.preparedFile;
  const rewrittenFileName = preparedProgram.toProgramFileName(replacement.rewrittenSpan.fileName);
  const programReplacementStart = mapStageOnePositionToProgram(
    preparedFile,
    replacement.rewrittenSpan.start,
  );
  const programReplacementEnd = mapStageOnePositionToProgram(
    preparedFile,
    replacement.rewrittenSpan.end,
  );
  const patchedText = replaceRange(
    preparedFile.rewrittenText,
    programReplacementStart,
    programReplacementEnd,
    replacementText,
  );

  const overrideHost: ts.CompilerHost = {
    ...preparedProgram.preparedHost.host,
    getSourceFile(
      fileName: string,
      languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): ts.SourceFile | undefined {
      if (fileName === rewrittenFileName) {
        return ts.createSourceFile(fileName, patchedText, languageVersion, true);
      }

      return preparedProgram.preparedHost.host.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    readFile(fileName: string): string | undefined {
      if (fileName === rewrittenFileName) {
        return patchedText;
      }

      return preparedProgram.preparedHost.host.readFile(fileName);
    },
  };

  const patchedProgram = ts.createProgram({
    host: overrideHost,
    oldProgram: preparedProgram.program,
    options: preparedProgram.options,
    rootNames: preparedProgram.rootNames.map((fileName) =>
      preparedProgram.toProgramFileName(fileName)
    ),
  });

  const patchedSourceFile = patchedProgram.getSourceFile(rewrittenFileName);
  if (!patchedSourceFile) {
    return null;
  }

  return {
    checker: patchedProgram.getTypeChecker(),
    originalReplacementEnd: programReplacementEnd,
    originalReplacementStart: programReplacementStart,
    rewrittenStart: programReplacementStart,
    semantics: createMacroSemantics(patchedProgram),
    sourceFile: patchedSourceFile,
  };
}

export function materializeRegionForHover(
  fileName: string,
  originalText: string,
  regionSpan: SourceSpan,
  sourcePosition: number,
): MaterializedMacroHoverRegion | NestedMacroHoverTarget {
  let cursor = regionSpan.start;
  let output = '';
  let hoverPosition: number | undefined;
  const mappings: MaterializedMacroMappingSegment[] = [];

  for (const parsed of collectInvocationsInRegion(fileName, originalText, regionSpan)) {
    if (parsed.span.start < cursor || parsed.span.start >= regionSpan.end) {
      continue;
    }

    output = appendMappedText(
      output,
      mappings,
      originalText.slice(cursor, parsed.span.start),
      cursor,
    );
    if (hoverPosition === undefined && sourcePosition < parsed.span.start) {
      hoverPosition = output.length - (parsed.span.start - sourcePosition);
    }

    if (!containsPosition(parsed.span, sourcePosition)) {
      output += neutralizeMacroInvocation(parsed);
      cursor = parsed.span.end;
      continue;
    }

    if (
      containsPosition(parsed.nameSpan, sourcePosition) ||
      containsPosition(parsed.hashSpan, sourcePosition)
    ) {
      return {
        kind: 'macro',
        invocation: parsed,
      };
    }

    const expressionArguments = parsed.argumentSpans.filter((argument) =>
      argument.kind === 'ExprArg'
    );
    const hoveredExpressionArgument = expressionArguments.find((argument) =>
      containsPosition(argument.span, sourcePosition)
    );
    if (hoveredExpressionArgument) {
      const nested = materializeRegionForHover(
        fileName,
        originalText,
        hoveredExpressionArgument.span,
        sourcePosition,
      );
      if (isNestedMacroHoverTarget(nested)) {
        return nested;
      }
      hoverPosition = output.length + nested.hoverPosition;
      const generatedOffset = output.length;
      mappings.push(
        ...nested.mappings.map((mapping) => ({
          generatedStart: mapping.generatedStart + generatedOffset,
          generatedEnd: mapping.generatedEnd + generatedOffset,
          sourceStart: mapping.sourceStart,
          sourceEnd: mapping.sourceEnd,
        })),
      );
      output += nested.text;
      cursor = parsed.span.end;
      continue;
    }

    const blockSpan = getBlockSpan(parsed);
    if (blockSpan && containsPosition(blockSpan, sourcePosition)) {
      const nested = materializeRegionForHover(
        fileName,
        originalText,
        blockSpan,
        sourcePosition,
      );
      if (isNestedMacroHoverTarget(nested)) {
        return nested;
      }
      hoverPosition = output.length + nested.hoverPosition;
      const generatedOffset = output.length;
      mappings.push(
        ...nested.mappings.map((mapping) => ({
          generatedStart: mapping.generatedStart + generatedOffset,
          generatedEnd: mapping.generatedEnd + generatedOffset,
          sourceStart: mapping.sourceStart,
          sourceEnd: mapping.sourceEnd,
        })),
      );
      output += nested.text;
      cursor = parsed.span.end;
      continue;
    }

    return {
      kind: 'macro',
      invocation: parsed,
    };
  }

  output = appendMappedText(
    output,
    mappings,
    originalText.slice(cursor, regionSpan.end),
    cursor,
  );
  if (hoverPosition === undefined) {
    hoverPosition = output.length - (regionSpan.end - sourcePosition);
  }

  return {
    hoverPosition,
    mappings,
    text: output,
  };
}

export function materializeRegionForAnalysis(
  fileName: string,
  originalText: string,
  regionSpan: SourceSpan,
): MaterializedMacroHoverRegion {
  let cursor = regionSpan.start;
  let output = '';
  const mappings: MaterializedMacroMappingSegment[] = [];

  for (const parsed of collectInvocationsInRegion(fileName, originalText, regionSpan)) {
    if (parsed.span.start < cursor || parsed.span.start >= regionSpan.end) {
      continue;
    }

    output = appendMappedText(
      output,
      mappings,
      originalText.slice(cursor, parsed.span.start),
      cursor,
    );
    output += neutralizeMacroInvocation(parsed);
    cursor = parsed.span.end;
  }

  output = appendMappedText(
    output,
    mappings,
    originalText.slice(cursor, regionSpan.end),
    cursor,
  );

  return {
    hoverPosition: 0,
    mappings,
    text: output,
  };
}

function patchMaterializedRegionForCompletion(
  materializedRegion: MaterializedMacroHoverRegion,
): { lookupPosition: number; text: string } {
  let prefixStart = materializedRegion.hoverPosition;
  while (prefixStart > 0 && isIdentifierPart(materializedRegion.text[prefixStart - 1])) {
    prefixStart -= 1;
  }

  if (prefixStart > 0 && materializedRegion.text[prefixStart - 1] === '.') {
    const patchedText = materializedRegion.text.slice(0, materializedRegion.hoverPosition) +
      COMPLETION_PLACEHOLDER_IDENTIFIER +
      materializedRegion.text.slice(materializedRegion.hoverPosition);
    return {
      lookupPosition: materializedRegion.hoverPosition + COMPLETION_PLACEHOLDER_IDENTIFIER.length -
        1,
      text: patchedText,
    };
  }

  return {
    lookupPosition: Math.max(0, materializedRegion.hoverPosition - 1),
    text: materializedRegion.text,
  };
}

function resolveNodeFromMaterializedRegion(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  materializedRegion: MaterializedMacroHoverRegion,
  useCompletionPatch = false,
): ResolvedMacroHoverNode | null {
  const patchedMaterializedRegion = useCompletionPatch
    ? patchMaterializedRegionForCompletion(materializedRegion)
    : {
      lookupPosition: materializedRegion.hoverPosition,
      text: materializedRegion.text,
    };
  const patchedSource = createPatchedMacroSource(
    preparedProgram,
    resolved,
    patchedMaterializedRegion.text,
  );
  if (!patchedSource) {
    return null;
  }

  const patchedPosition = patchedSource.rewrittenStart + patchedMaterializedRegion.lookupPosition;
  const node = findDeepestNodeContainingPosition(patchedSource.sourceFile, patchedPosition);
  if (!node || ts.isSourceFile(node) || ts.isBlock(node)) {
    return null;
  }

  return {
    checker: patchedSource.checker,
    materializedRegion,
    node,
    originalReplacementEnd: patchedSource.originalReplacementEnd,
    originalReplacementStart: patchedSource.originalReplacementStart,
    rewrittenStart: patchedSource.rewrittenStart,
    semantics: patchedSource.semantics,
    sourceFile: patchedSource.sourceFile,
  };
}

export function wrapMaterializedRegion(
  materializedRegion: MaterializedMacroHoverRegion,
  prefixText: string,
  suffixText: string,
): MaterializedMacroHoverRegion {
  const generatedOffset = prefixText.length;
  return {
    hoverPosition: generatedOffset + materializedRegion.hoverPosition,
    mappings: materializedRegion.mappings.map((mapping) => ({
      generatedStart: mapping.generatedStart + generatedOffset,
      generatedEnd: mapping.generatedEnd + generatedOffset,
      sourceStart: mapping.sourceStart,
      sourceEnd: mapping.sourceEnd,
    })),
    text: `${prefixText}${materializedRegion.text}${suffixText}`,
  };
}

export function resolveNodeAtMaterializedRegion(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  materializedRegion: MaterializedMacroHoverRegion,
): ResolvedMacroHoverNode | null {
  return resolveNodeFromMaterializedRegion(
    preparedProgram,
    resolved,
    materializedRegion,
  );
}

export function resolveCompletionNodeAtMaterializedRegion(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  materializedRegion: MaterializedMacroHoverRegion,
): ResolvedMacroHoverNode | null {
  return resolveNodeFromMaterializedRegion(
    preparedProgram,
    resolved,
    materializedRegion,
    true,
  );
}

export function createPatchedMacroRegion(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  materializedRegion: MaterializedMacroHoverRegion,
): PatchedMacroRegion | null {
  const patchedSource = createPatchedMacroSource(
    preparedProgram,
    resolved,
    materializedRegion.text,
  );
  if (!patchedSource) {
    return null;
  }

  return {
    checker: patchedSource.checker,
    materializedRegion,
    originalReplacementEnd: patchedSource.originalReplacementEnd,
    originalReplacementStart: patchedSource.originalReplacementStart,
    rewrittenStart: patchedSource.rewrittenStart,
    semantics: patchedSource.semantics,
    sourceFile: patchedSource.sourceFile,
  };
}

export function mapMaterializedRangeToSource(
  materializedRegion: MaterializedMacroHoverRegion,
  generatedStart: number,
  generatedEnd: number,
): MaterializedSourceRange | null {
  const clampedStart = Math.max(0, Math.min(generatedStart, materializedRegion.text.length));
  const clampedEnd = Math.max(clampedStart, Math.min(generatedEnd, materializedRegion.text.length));
  const intersectingMappings = materializedRegion.mappings.filter((mapping) =>
    !(clampedEnd <= mapping.generatedStart || clampedStart >= mapping.generatedEnd)
  );
  if (intersectingMappings.length === 0) {
    return null;
  }

  const first = intersectingMappings[0]!;
  const last = intersectingMappings[intersectingMappings.length - 1]!;
  const start = first.sourceStart + Math.max(0, clampedStart - first.generatedStart);
  const end = last.sourceStart + Math.max(0, clampedEnd - last.generatedStart);

  let previousGeneratedEnd = Math.max(clampedStart, first.generatedStart);
  let intersectsUnmapped = first.generatedStart > clampedStart;
  for (const mapping of intersectingMappings) {
    if (mapping.generatedStart > previousGeneratedEnd) {
      intersectsUnmapped = true;
      break;
    }
    previousGeneratedEnd = Math.max(previousGeneratedEnd, mapping.generatedEnd);
  }
  if (previousGeneratedEnd < clampedEnd) {
    intersectsUnmapped = true;
  }

  return {
    start,
    end: Math.max(start, end),
    intersectsUnmapped,
  };
}

export function resolveExpressionNodeAtSourcePosition(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  sourcePosition: number,
): ResolvedMacroHoverNode | NestedMacroHoverTarget | null {
  const invocation = resolved.placeholder.invocation;
  const expressionArguments = invocation.argumentSpans.filter((argument) =>
    argument.kind === 'ExprArg'
  );
  const hoveredExpressionArgument = expressionArguments.find((argument) =>
    containsPosition(argument.span, sourcePosition)
  );
  if (!hoveredExpressionArgument) {
    return null;
  }

  const preparedFile = resolved.placeholder.preparedFile;
  const materialized = materializeRegionForHover(
    invocation.fileName,
    preparedFile.originalText,
    hoveredExpressionArgument.span,
    sourcePosition,
  );
  if (isNestedMacroHoverTarget(materialized)) {
    return materialized;
  }

  return resolveNodeFromMaterializedRegion(
    preparedProgram,
    resolved,
    materialized,
  );
}

export function resolveBlockNodeAtSourcePosition(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  sourcePosition: number,
): ResolvedMacroBlockNode | NestedMacroHoverTarget | null {
  const blockSpan = getBlockSpan(resolved.placeholder.invocation);
  if (!blockSpan || sourcePosition < blockSpan.start || sourcePosition >= blockSpan.end) {
    return null;
  }

  const preparedFile = resolved.placeholder.preparedFile;
  const materialized = materializeRegionForHover(
    resolved.placeholder.invocation.fileName,
    preparedFile.originalText,
    blockSpan,
    sourcePosition,
  );
  if (isNestedMacroHoverTarget(materialized)) {
    return materialized;
  }
  const resolvedNode = resolveNodeFromMaterializedRegion(
    preparedProgram,
    resolved,
    materialized,
  );
  if (!resolvedNode) {
    return null;
  }

  return {
    ...resolvedNode,
    originalBlockSpan: blockSpan,
  };
}

export function resolveExpressionCompletionNodeAtSourcePosition(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  sourcePosition: number,
): ResolvedMacroHoverNode | NestedMacroHoverTarget | null {
  const invocation = resolved.placeholder.invocation;
  const expressionArguments = invocation.argumentSpans.filter((argument) =>
    argument.kind === 'ExprArg'
  );
  const hoveredExpressionArgument = expressionArguments.find((argument) =>
    containsPosition(argument.span, sourcePosition) || argument.span.end === sourcePosition
  );
  if (!hoveredExpressionArgument) {
    return null;
  }
  const effectiveSourcePosition = sourcePosition === hoveredExpressionArgument.span.end
    ? Math.max(hoveredExpressionArgument.span.start, sourcePosition - 1)
    : sourcePosition;

  const preparedFile = resolved.placeholder.preparedFile;
  const materialized = materializeRegionForHover(
    invocation.fileName,
    preparedFile.originalText,
    hoveredExpressionArgument.span,
    effectiveSourcePosition,
  );
  if (isNestedMacroHoverTarget(materialized)) {
    return materialized;
  }
  const completionMaterialized = sourcePosition === hoveredExpressionArgument.span.end
    ? { ...materialized, hoverPosition: materialized.text.length }
    : materialized;

  return resolveNodeFromMaterializedRegion(
    preparedProgram,
    resolved,
    completionMaterialized,
    true,
  );
}

export function resolveBlockCompletionNodeAtSourcePosition(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  sourcePosition: number,
): ResolvedMacroBlockNode | NestedMacroHoverTarget | null {
  const blockSpan = getBlockSpan(resolved.placeholder.invocation);
  if (!blockSpan || sourcePosition < blockSpan.start || sourcePosition > blockSpan.end) {
    return null;
  }
  const effectiveSourcePosition = sourcePosition === blockSpan.end
    ? Math.max(blockSpan.start, sourcePosition - 1)
    : sourcePosition;

  const preparedFile = resolved.placeholder.preparedFile;
  const materialized = materializeRegionForHover(
    resolved.placeholder.invocation.fileName,
    preparedFile.originalText,
    blockSpan,
    effectiveSourcePosition,
  );
  if (isNestedMacroHoverTarget(materialized)) {
    return materialized;
  }
  const completionMaterialized = sourcePosition === blockSpan.end
    ? { ...materialized, hoverPosition: materialized.text.length }
    : materialized;

  const resolvedNode = resolveNodeFromMaterializedRegion(
    preparedProgram,
    resolved,
    completionMaterialized,
    true,
  );
  if (!resolvedNode) {
    return null;
  }

  return {
    ...resolvedNode,
    originalBlockSpan: blockSpan,
  };
}

export function resolveExprArgumentOperand(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  index: number,
  nestedRegistries: NestedMacroRegistries = { advanced: new Map(), rewrite: new Map() },
): ResolvedExprArgumentOperand | null {
  const invocation = resolved.placeholder.invocation;
  const exprSpan = getExprArgumentSpan(invocation, index);
  if (!exprSpan) {
    return null;
  }

  const replacement = resolved.placeholder.replacement;
  const preparedFile = resolved.placeholder.preparedFile;
  const operandText = preparedFile.originalText.slice(exprSpan.start, exprSpan.end);
  const nestedExpansion = exprArgumentContainsNestedMacroInvocation(
      resolved.placeholder.invocation.fileName,
      preparedFile.originalText,
      exprSpan,
      nestedRegistries,
    )
    ? materializeNestedOperandExpansion(
      preparedProgram,
      resolved,
      operandText,
      nestedRegistries,
    ) ?? { expressionText: operandText, preludeTexts: [] as readonly string[] }
    : { expressionText: operandText, preludeTexts: [] as readonly string[] };
  if (!nestedExpansion) {
    return null;
  }
  const expandedText = nestedExpansion.expressionText;
  if (nestedExpansion.preludeTexts.length === 0 && expandedText === operandText) {
    const sharedSource = getSharedExprOperandFileSource(
      preparedProgram,
      preparedFile,
      resolved.placeholder.invocation.fileName,
      index,
      nestedRegistries,
    );
    const sharedSpan = sharedSource?.spansByPlaceholderId.get(resolved.placeholder.id);
    if (sharedSource && sharedSpan) {
      const patchedExpression = findExpressionAtSpan(
        sharedSource.sourceFile,
        sharedSpan.start,
        sharedSpan.end,
      );
      if (patchedExpression) {
        return {
          expandedText,
          preludeTexts: nestedExpansion.preludeTexts,
          node: patchedExpression,
          semantics: sharedSource.semantics,
          sourceFile: sharedSource.sourceFile,
        };
      }
    }
  }

  const containingStatement = findContainingStatement(resolved.callExpression);
  const programReplacementStart = mapStageOnePositionToProgram(
    preparedFile,
    replacement.rewrittenSpan.start,
  );
  const programReplacementEnd = mapStageOnePositionToProgram(
    preparedFile,
    replacement.rewrittenSpan.end,
  );
  const statementStart = containingStatement?.getStart(resolved.callExpression.getSourceFile()) ??
    programReplacementStart;
  const insertedPrelude = nestedExpansion.preludeTexts.length > 0
    ? `${nestedExpansion.preludeTexts.join('\n')}\n`
    : '';
  const preludeAdjustedText = insertedPrelude.length > 0
    ? preparedFile.rewrittenText.slice(0, statementStart) + insertedPrelude +
      preparedFile.rewrittenText.slice(statementStart)
    : preparedFile.rewrittenText;
  const replacementOffset = statementStart <= programReplacementStart ? insertedPrelude.length : 0;
  const patchedExpressionStart = programReplacementStart + replacementOffset;
  const patchedText = replaceRange(
    preludeAdjustedText,
    programReplacementStart + replacementOffset,
    programReplacementEnd + replacementOffset,
    expandedText,
  );
  const rewrittenProgramFileName = preparedProgram.toProgramFileName(
    replacement.rewrittenSpan.fileName,
  );

  const overrideHost: ts.CompilerHost = {
    ...preparedProgram.preparedHost.host,
    getSourceFile(
      fileName: string,
      languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean,
    ): ts.SourceFile | undefined {
      if (fileName === rewrittenProgramFileName) {
        return ts.createSourceFile(fileName, patchedText, languageVersion, true);
      }

      return preparedProgram.preparedHost.host.getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    readFile(fileName: string): string | undefined {
      if (fileName === rewrittenProgramFileName) {
        return patchedText;
      }

      return preparedProgram.preparedHost.host.readFile(fileName);
    },
  };

  const patchedProgram = ts.createProgram({
    host: overrideHost,
    oldProgram: preparedProgram.program,
    options: preparedProgram.options,
    rootNames: preparedProgram.rootNames.map((fileName) =>
      preparedProgram.toProgramFileName(fileName)
    ),
  });

  const patchedSourceFile = patchedProgram.getSourceFile(rewrittenProgramFileName);
  if (!patchedSourceFile) {
    return null;
  }

  const patchedExpression = findExpressionAtSpan(
    patchedSourceFile,
    patchedExpressionStart,
    patchedExpressionStart + expandedText.length,
  );
  if (!patchedExpression) {
    return null;
  }

  return {
    expandedText,
    preludeTexts: nestedExpansion.preludeTexts,
    node: patchedExpression,
    semantics: createMacroSemantics(patchedProgram),
    sourceFile: patchedSourceFile,
  };
}

export function resolvePrimaryExprOperand(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  nestedRegistries: NestedMacroRegistries = { advanced: new Map(), rewrite: new Map() },
): ResolvedPrimaryExprOperand | null {
  const invocation = resolved.placeholder.invocation;
  if (!_getPrimaryExprSpan(invocation)) {
    return null;
  }

  return resolveExprArgumentOperand(preparedProgram, resolved, 0, nestedRegistries);
}

export function typeOfPrimaryExprOperand(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  nestedRegistries: NestedMacroRegistries = { advanced: new Map(), rewrite: new Map() },
): MacroType | null {
  const operand = resolvePrimaryExprOperand(preparedProgram, resolved, nestedRegistries);
  return operand ? operand.semantics.typeOfNode(operand.node) : null;
}

export function enclosingFunctionOfPrimaryExprOperand(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  nestedRegistries: NestedMacroRegistries = { advanced: new Map(), rewrite: new Map() },
): MacroFunctionContext | null {
  const operand = resolvePrimaryExprOperand(preparedProgram, resolved, nestedRegistries);
  return operand ? operand.semantics.enclosingFunctionOfNode(operand.node) ?? null : null;
}

export function classifyCanonicalResultOfPrimaryExprOperand(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  nestedRegistries: NestedMacroRegistries = { advanced: new Map(), rewrite: new Map() },
): CanonicalResultInfo | null {
  const operand = resolvePrimaryExprOperand(preparedProgram, resolved, nestedRegistries);
  if (!operand) {
    return null;
  }

  return operand.semantics.classifyCanonicalResultType(
    operand.semantics.typeOfNode(operand.node),
  );
}

export function classifyCanonicalResultCarrierOfPrimaryExprOperand(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  nestedRegistries: NestedMacroRegistries = { advanced: new Map(), rewrite: new Map() },
): CanonicalResultCarrierInfo | null {
  const operand = resolvePrimaryExprOperand(preparedProgram, resolved, nestedRegistries);
  if (!operand) {
    return null;
  }

  return operand.semantics.classifyCanonicalResultCarrierType(
    operand.semantics.typeOfNode(operand.node),
  );
}
import { getAlwaysAvailableBuiltinMacroSiteKinds } from './builtin_macro_support.ts';
