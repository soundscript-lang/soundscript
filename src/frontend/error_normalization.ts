import ts from 'typescript';

import {
  isSoundscriptSourceFile,
  type PreparedRewriteStage,
  type PreparedRewriteStageLineMapping,
  toSourceFileName,
} from './project_frontend.ts';
import type { MacroReplacement, MacroReplacementMappedSegment } from './macro_types.ts';

export const SOUNDSCRIPT_NORMALIZE_ERROR_HELPER_NAME = '__sts_normalize_error';

export interface ErrorNormalizedFile {
  rewriteStage: PreparedRewriteStage;
  sourceFile: ts.SourceFile;
}

export interface ErrorNormalizedProgramResult {
  changedFiles: ReadonlyMap<string, ErrorNormalizedFile>;
}

function repairBuiltinMacroModuleSpecifiers(text: string): string {
  return text;
}

function isBuiltInPromiseDeclarationFile(fileName: string): boolean {
  return fileName.includes('/sound-libs/lib.') || /\/lib\..+\.d\.ts$/u.test(fileName);
}

function isBuiltInPromiseMethodCall(
  callExpression: ts.CallExpression,
  checker: ts.TypeChecker,
  methodName: 'catch' | 'then',
): boolean {
  if (
    !ts.isPropertyAccessExpression(callExpression.expression) ||
    callExpression.expression.name.text !== methodName
  ) {
    return false;
  }

  const signature = checker.getResolvedSignature(callExpression);
  const declaration = signature?.getDeclaration();
  if (!declaration || !('name' in declaration) || !declaration.name) {
    return false;
  }
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== methodName) {
    return false;
  }

  const parent = declaration.parent;
  return ts.isInterfaceDeclaration(parent) &&
    parent.name.text === 'Promise' &&
    isBuiltInPromiseDeclarationFile(declaration.getSourceFile().fileName);
}

function createHelperDeclaration(): ts.Statement {
  const valueIdentifier = ts.factory.createIdentifier('value');
  const detailsIdentifier = ts.factory.createIdentifier('details');
  const messageIdentifier = ts.factory.createIdentifier('message');
  const errorIdentifier = ts.factory.createIdentifier('error');
  const detailsType = ts.factory.createTypeLiteralNode([
    ts.factory.createPropertySignature(
      undefined,
      'message',
      ts.factory.createToken(ts.SyntaxKind.QuestionToken),
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    ),
    ts.factory.createPropertySignature(
      undefined,
      'name',
      ts.factory.createToken(ts.SyntaxKind.QuestionToken),
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    ),
    ts.factory.createPropertySignature(
      undefined,
      'stack',
      ts.factory.createToken(ts.SyntaxKind.QuestionToken),
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    ),
  ]);

  return ts.factory.createFunctionDeclaration(
    undefined,
    undefined,
    SOUNDSCRIPT_NORMALIZE_ERROR_HELPER_NAME,
    undefined,
    [
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        'value',
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        undefined,
      ),
    ],
    ts.factory.createTypeReferenceNode('Error'),
    ts.factory.createBlock(
      [
        ts.factory.createIfStatement(
          ts.factory.createBinaryExpression(
            valueIdentifier,
            ts.SyntaxKind.InstanceOfKeyword,
            ts.factory.createIdentifier('Error'),
          ),
          ts.factory.createBlock([ts.factory.createReturnStatement(valueIdentifier)], true),
        ),
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                detailsIdentifier,
                undefined,
                undefined,
                ts.factory.createConditionalExpression(
                  ts.factory.createBinaryExpression(
                    ts.factory.createBinaryExpression(
                      ts.factory.createTypeOfExpression(valueIdentifier),
                      ts.SyntaxKind.EqualsEqualsEqualsToken,
                      ts.factory.createStringLiteral('object'),
                    ),
                    ts.SyntaxKind.AmpersandAmpersandToken,
                    ts.factory.createBinaryExpression(
                      valueIdentifier,
                      ts.SyntaxKind.ExclamationEqualsEqualsToken,
                      ts.factory.createNull(),
                    ),
                  ),
                  ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                  ts.factory.createParenthesizedExpression(
                    ts.factory.createAsExpression(valueIdentifier, detailsType),
                  ),
                  ts.factory.createToken(ts.SyntaxKind.ColonToken),
                  ts.factory.createIdentifier('undefined'),
                ),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                messageIdentifier,
                undefined,
                undefined,
                ts.factory.createConditionalExpression(
                  ts.factory.createBinaryExpression(
                    detailsIdentifier,
                    ts.SyntaxKind.AmpersandAmpersandToken,
                    ts.factory.createBinaryExpression(
                      ts.factory.createTypeOfExpression(
                        ts.factory.createPropertyAccessExpression(detailsIdentifier, 'message'),
                      ),
                      ts.SyntaxKind.EqualsEqualsEqualsToken,
                      ts.factory.createStringLiteral('string'),
                    ),
                  ),
                  ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                  ts.factory.createPropertyAccessExpression(detailsIdentifier, 'message'),
                  ts.factory.createToken(ts.SyntaxKind.ColonToken),
                  ts.factory.createStringLiteral('Non-Error thrown value.'),
                ),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [
              ts.factory.createVariableDeclaration(
                errorIdentifier,
                undefined,
                undefined,
                ts.factory.createNewExpression(
                  ts.factory.createIdentifier('Error'),
                  undefined,
                  [
                    messageIdentifier,
                    ts.factory.createObjectLiteralExpression([
                      ts.factory.createPropertyAssignment('cause', valueIdentifier),
                    ]),
                  ],
                ),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
        ts.factory.createIfStatement(
          ts.factory.createBinaryExpression(
            detailsIdentifier,
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.factory.createBinaryExpression(
              ts.factory.createTypeOfExpression(
                ts.factory.createPropertyAccessExpression(detailsIdentifier, 'name'),
              ),
              ts.SyntaxKind.EqualsEqualsEqualsToken,
              ts.factory.createStringLiteral('string'),
            ),
          ),
          ts.factory.createBlock(
            [
              ts.factory.createExpressionStatement(
                ts.factory.createBinaryExpression(
                  ts.factory.createPropertyAccessExpression(errorIdentifier, 'name'),
                  ts.SyntaxKind.EqualsToken,
                  ts.factory.createPropertyAccessExpression(detailsIdentifier, 'name'),
                ),
              ),
            ],
            true,
          ),
        ),
        ts.factory.createIfStatement(
          ts.factory.createBinaryExpression(
            detailsIdentifier,
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.factory.createBinaryExpression(
              ts.factory.createTypeOfExpression(
                ts.factory.createPropertyAccessExpression(detailsIdentifier, 'stack'),
              ),
              ts.SyntaxKind.EqualsEqualsEqualsToken,
              ts.factory.createStringLiteral('string'),
            ),
          ),
          ts.factory.createBlock(
            [
              ts.factory.createExpressionStatement(
                ts.factory.createBinaryExpression(
                  ts.factory.createPropertyAccessExpression(errorIdentifier, 'stack'),
                  ts.SyntaxKind.EqualsToken,
                  ts.factory.createPropertyAccessExpression(detailsIdentifier, 'stack'),
                ),
              ),
            ],
            true,
          ),
        ),
        ts.factory.createReturnStatement(errorIdentifier),
      ],
      true,
    ),
  );
}

function createInternalParameter(name: string): ts.ParameterDeclaration {
  return ts.factory.createParameterDeclaration(
    undefined,
    undefined,
    name,
    undefined,
    undefined,
    undefined,
  );
}

function createNormalizedBindingStatement(
  name: ts.BindingName,
  valueExpression: ts.Expression,
): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          name,
          undefined,
          undefined,
          ts.factory.createCallExpression(
            ts.factory.createIdentifier(SOUNDSCRIPT_NORMALIZE_ERROR_HELPER_NAME),
            undefined,
            [valueExpression],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}

function insertHelperDeclaration(sourceFile: ts.SourceFile): ts.SourceFile {
  const statements = [...sourceFile.statements];
  let insertIndex = 0;
  while (insertIndex < statements.length && ts.isImportDeclaration(statements[insertIndex]!)) {
    insertIndex += 1;
  }

  return ts.factory.updateSourceFile(sourceFile, [
    ...statements.slice(0, insertIndex),
    createHelperDeclaration(),
    ...statements.slice(insertIndex),
  ]);
}

interface TextLine {
  end: number;
  matchText: string;
  start: number;
  text: string;
}

function splitTextLines(text: string): readonly TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n') {
      continue;
    }

    const end = index + 1;
    lines.push({
      start,
      end,
      matchText: createLineMatchText(text.slice(start, end)),
      text: text.slice(start, end),
    });
    start = end;
  }

  if (start < text.length || text.length === 0) {
    lines.push({
      start,
      end: text.length,
      matchText: createLineMatchText(text.slice(start)),
      text: text.slice(start),
    });
  }

  return lines;
}

function createLineMatchText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : text;
}

function computeAlignedLinePairs(
  originalLines: readonly TextLine[],
  rewrittenLines: readonly TextLine[],
): readonly { originalIndex: number; rewrittenIndex: number }[] {
  const dp = Array.from(
    { length: originalLines.length + 1 },
    () => new Uint32Array(rewrittenLines.length + 1),
  );

  for (let originalIndex = originalLines.length - 1; originalIndex >= 0; originalIndex -= 1) {
    for (
      let rewrittenIndex = rewrittenLines.length - 1;
      rewrittenIndex >= 0;
      rewrittenIndex -= 1
    ) {
      dp[originalIndex]![rewrittenIndex] =
        originalLines[originalIndex]!.matchText === rewrittenLines[rewrittenIndex]!.matchText
          ? dp[originalIndex + 1]![rewrittenIndex + 1]! + 1
          : Math.max(
            dp[originalIndex + 1]![rewrittenIndex]!,
            dp[originalIndex]![rewrittenIndex + 1]!,
          );
    }
  }

  const pairs: Array<{ originalIndex: number; rewrittenIndex: number }> = [];
  let originalIndex = 0;
  let rewrittenIndex = 0;
  while (originalIndex < originalLines.length && rewrittenIndex < rewrittenLines.length) {
    if (
      originalLines[originalIndex]!.matchText === rewrittenLines[rewrittenIndex]!.matchText &&
      dp[originalIndex]![rewrittenIndex] === dp[originalIndex + 1]![rewrittenIndex + 1]! + 1
    ) {
      pairs.push({ originalIndex, rewrittenIndex });
      originalIndex += 1;
      rewrittenIndex += 1;
      continue;
    }

    if (dp[originalIndex + 1]![rewrittenIndex]! >= dp[originalIndex]![rewrittenIndex + 1]!) {
      originalIndex += 1;
    } else {
      rewrittenIndex += 1;
    }
  }

  return pairs;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < limit &&
    left[left.length - 1 - index] === right[right.length - 1 - index]
  ) {
    index += 1;
  }
  return index;
}

function computeTrailingLineMappedSegments(
  originalText: string,
  rewrittenText: string,
  originalBase: number,
  rewrittenBase: number,
): readonly MacroReplacementMappedSegment[] {
  const originalLines = splitTextLines(originalText);
  const rewrittenLines = splitTextLines(rewrittenText);
  if (originalLines.length === 0 || rewrittenLines.length === 0) {
    return [];
  }

  const rewrittenLineOffset = Math.max(0, rewrittenLines.length - originalLines.length);
  const segments: MacroReplacementMappedSegment[] = [];

  for (let originalIndex = 0; originalIndex < originalLines.length; originalIndex += 1) {
    const rewrittenIndex = originalIndex + rewrittenLineOffset;
    const originalLine = originalLines[originalIndex];
    const rewrittenLine = rewrittenLines[rewrittenIndex];
    if (!originalLine || !rewrittenLine) {
      continue;
    }

    const prefixLength = commonPrefixLength(originalLine.text, rewrittenLine.text);
    const maxSuffixLength = Math.min(
      originalLine.text.length - prefixLength,
      rewrittenLine.text.length - prefixLength,
    );
    const suffixLength = Math.min(
      commonSuffixLength(
        originalLine.text.slice(prefixLength),
        rewrittenLine.text.slice(prefixLength),
      ),
      maxSuffixLength,
    );

    if (prefixLength > 0) {
      segments.push({
        originalStart: originalBase + originalLine.start,
        originalEnd: originalBase + originalLine.start + prefixLength,
        rewrittenStart: rewrittenBase + rewrittenLine.start,
        rewrittenEnd: rewrittenBase + rewrittenLine.start + prefixLength,
      });
    }

    if (suffixLength > 0) {
      segments.push({
        originalStart: originalBase + originalLine.end - suffixLength,
        originalEnd: originalBase + originalLine.end,
        rewrittenStart: rewrittenBase + rewrittenLine.end - suffixLength,
        rewrittenEnd: rewrittenBase + rewrittenLine.end,
      });
    }
  }

  return segments.filter((segment) => segment.originalStart < segment.originalEnd);
}

export function buildRewriteStageFromTexts(
  fileName: string,
  originalText: string,
  rewrittenText: string,
): PreparedRewriteStage {
  if (originalText === rewrittenText) {
    return {
      replacements: [],
      rewrittenText,
    };
  }

  const originalLines = splitTextLines(originalText);
  const rewrittenLines = splitTextLines(rewrittenText);
  const alignedPairs = computeAlignedLinePairs(originalLines, rewrittenLines);
  const lineMappings: PreparedRewriteStageLineMapping[] = alignedPairs.map((pair) => ({
    originalStart: originalLines[pair.originalIndex]?.start ?? originalText.length,
    originalEnd: originalLines[pair.originalIndex]?.end ?? originalText.length,
    rewrittenStart: rewrittenLines[pair.rewrittenIndex]?.start ?? rewrittenText.length,
    rewrittenEnd: rewrittenLines[pair.rewrittenIndex]?.end ?? rewrittenText.length,
  }));
  const replacements: MacroReplacement[] = [];
  let replacementId = 1;
  let originalIndex = 0;
  let rewrittenIndex = 0;

  for (
    const pair of [...alignedPairs, {
      originalIndex: originalLines.length,
      rewrittenIndex: rewrittenLines.length,
    }]
  ) {
    const originalStart = originalLines[originalIndex]?.start ?? originalText.length;
    const rewrittenStart = rewrittenLines[rewrittenIndex]?.start ?? rewrittenText.length;
    const originalEnd = originalLines[pair.originalIndex]?.start ?? originalText.length;
    const rewrittenEnd = rewrittenLines[pair.rewrittenIndex]?.start ?? rewrittenText.length;

    if (originalStart !== originalEnd || rewrittenStart !== rewrittenEnd) {
      replacements.push({
        id: replacementId,
        mappedSegments: computeTrailingLineMappedSegments(
          originalText.slice(originalStart, originalEnd),
          rewrittenText.slice(rewrittenStart, rewrittenEnd),
          originalStart,
          rewrittenStart,
        ),
        originalSpan: {
          fileName,
          start: originalStart,
          end: originalEnd,
        },
        rewriteText: rewrittenText.slice(rewrittenStart, rewrittenEnd),
        rewrittenSpan: {
          fileName,
          start: rewrittenStart,
          end: rewrittenEnd,
        },
      });
      replacementId += 1;
    }

    originalIndex = pair.originalIndex + 1;
    rewrittenIndex = pair.rewrittenIndex + 1;
  }

  return {
    lineMappings,
    replacements,
    rewrittenText,
  };
}

function normalizeSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ErrorNormalizedFile | undefined {
  let changed = false;
  let needsHelper = false;
  let caughtCounter = 0;
  let onRejectedCounter = 0;
  let rejectionValueCounter = 0;

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    function nextCaughtName(): string {
      caughtCounter += 1;
      return `__sts_caught_${caughtCounter}`;
    }

    function nextOnRejectedName(): string {
      onRejectedCounter += 1;
      return `__sts_onRejected_${onRejectedCounter}`;
    }

    function nextRejectedValueName(): string {
      rejectionValueCounter += 1;
      return `__sts_rejected_${rejectionValueCounter}`;
    }

    function rewriteRejectedHandler(
      handler: ts.ArrowFunction | ts.FunctionExpression,
    ): ts.ArrowFunction | ts.FunctionExpression {
      if (handler.parameters.length === 0) {
        return handler;
      }

      changed = true;
      needsHelper = true;

      const [firstParameter, ...remainingParameters] = handler.parameters;
      const internalName = nextCaughtName();
      const normalizationStatement = createNormalizedBindingStatement(
        firstParameter.name,
        ts.factory.createIdentifier(internalName),
      );
      const parameters = [
        createInternalParameter(internalName),
        ...remainingParameters,
      ];

      if (ts.isArrowFunction(handler)) {
        const visitedBody = ts.visitNode(handler.body, visit);
        const block = visitedBody && ts.isBlock(visitedBody)
          ? ts.factory.updateBlock(visitedBody, [
            normalizationStatement,
            ...visitedBody.statements,
          ])
          : ts.factory.createBlock(
            [
              normalizationStatement,
              ts.factory.createReturnStatement(
                visitedBody && ts.isExpression(visitedBody)
                  ? visitedBody
                  : handler.body as ts.Expression,
              ),
            ],
            true,
          );
        return ts.factory.updateArrowFunction(
          handler,
          handler.modifiers,
          handler.typeParameters,
          parameters,
          handler.type,
          handler.equalsGreaterThanToken,
          block,
        );
      }

      const visitedBody = ts.visitNode(handler.body, visit);
      const block = visitedBody && ts.isBlock(visitedBody)
        ? ts.factory.updateBlock(visitedBody, [
          normalizationStatement,
          ...visitedBody.statements,
        ])
        : ts.factory.createBlock([normalizationStatement], true);
      return ts.factory.updateFunctionExpression(
        handler,
        handler.modifiers,
        handler.asteriskToken,
        handler.name,
        handler.typeParameters,
        parameters,
        handler.type,
        block,
      );
    }

    function createRejectedHandlerAdapter(handlerExpression: ts.Expression): ts.Expression {
      changed = true;
      needsHelper = true;

      const capturedName = nextOnRejectedName();
      const rejectionValueName = nextRejectedValueName();
      const capturedIdentifier = ts.factory.createIdentifier(capturedName);
      const rejectionValueIdentifier = ts.factory.createIdentifier(rejectionValueName);
      return ts.factory.createCallExpression(
        ts.factory.createParenthesizedExpression(
          ts.factory.createArrowFunction(
            undefined,
            undefined,
            [createInternalParameter(capturedName)],
            undefined,
            undefined,
            ts.factory.createConditionalExpression(
              ts.factory.createBinaryExpression(
                ts.factory.createBinaryExpression(
                  capturedIdentifier,
                  ts.SyntaxKind.EqualsEqualsEqualsToken,
                  ts.factory.createIdentifier('undefined'),
                ),
                ts.SyntaxKind.BarBarToken,
                ts.factory.createBinaryExpression(
                  capturedIdentifier,
                  ts.SyntaxKind.EqualsEqualsEqualsToken,
                  ts.factory.createNull(),
                ),
              ),
              ts.factory.createToken(ts.SyntaxKind.QuestionToken),
              capturedIdentifier,
              ts.factory.createToken(ts.SyntaxKind.ColonToken),
              ts.factory.createArrowFunction(
                undefined,
                undefined,
                [createInternalParameter(rejectionValueName)],
                undefined,
                undefined,
                ts.factory.createCallExpression(
                  capturedIdentifier,
                  undefined,
                  [
                    ts.factory.createCallExpression(
                      ts.factory.createIdentifier(SOUNDSCRIPT_NORMALIZE_ERROR_HELPER_NAME),
                      undefined,
                      [rejectionValueIdentifier],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        undefined,
        [handlerExpression],
      );
    }

    const visit: ts.Visitor = (node) => {
      if (ts.isTryStatement(node) && node.catchClause?.variableDeclaration) {
        const visitedTry = ts.visitEachChild(node, visit, context);
        const visitedCatchClause = visitedTry.catchClause;
        const originalCatchClause = node.catchClause;
        if (!visitedCatchClause || !originalCatchClause?.variableDeclaration) {
          return visitedTry;
        }

        changed = true;
        needsHelper = true;
        const internalName = nextCaughtName();
        const normalizationStatement = createNormalizedBindingStatement(
          originalCatchClause.variableDeclaration.name,
          ts.factory.createIdentifier(internalName),
        );
        const updatedCatchClause = ts.factory.updateCatchClause(
          visitedCatchClause,
          ts.factory.createVariableDeclaration(internalName),
          ts.factory.updateBlock(visitedCatchClause.block, [
            normalizationStatement,
            ...visitedCatchClause.block.statements,
          ]),
        );
        return ts.factory.updateTryStatement(
          visitedTry,
          visitedTry.tryBlock,
          updatedCatchClause,
          visitedTry.finallyBlock,
        );
      }

      if (ts.isCallExpression(node)) {
        const visitedCall = ts.visitEachChild(node, visit, context);
        if (!ts.isCallExpression(visitedCall)) {
          return visitedCall;
        }

        if (isBuiltInPromiseMethodCall(node, checker, 'catch')) {
          if (visitedCall.arguments.length === 0) {
            return visitedCall;
          }

          const [handler, ...restArguments] = visitedCall.arguments;
          const rewrittenHandler = ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)
            ? rewriteRejectedHandler(handler)
            : createRejectedHandlerAdapter(handler);
          return ts.factory.updateCallExpression(
            visitedCall,
            visitedCall.expression,
            visitedCall.typeArguments,
            [rewrittenHandler, ...restArguments],
          );
        }

        if (isBuiltInPromiseMethodCall(node, checker, 'then')) {
          if (visitedCall.arguments.length < 2) {
            return visitedCall;
          }

          const [onFulfilled, onRejected, ...restArguments] = visitedCall.arguments;
          const rewrittenRejected =
            ts.isArrowFunction(onRejected) || ts.isFunctionExpression(onRejected)
              ? rewriteRejectedHandler(onRejected)
              : createRejectedHandlerAdapter(onRejected);
          return ts.factory.updateCallExpression(
            visitedCall,
            visitedCall.expression,
            visitedCall.typeArguments,
            [onFulfilled, rewrittenRejected, ...restArguments],
          );
        }

        return visitedCall;
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (node: ts.SourceFile) => {
      const visited = ts.visitNode(node, visit);
      const visitedSourceFile = visited && ts.isSourceFile(visited) ? visited : node;
      return changed && needsHelper
        ? insertHelperDeclaration(visitedSourceFile)
        : visitedSourceFile;
    };
  };

  const result = ts.transform(sourceFile, [transformer]);
  const [transformed] = result.transformed;
  result.dispose();
  if (!changed || !transformed) {
    return undefined;
  }

  const printer = ts.createPrinter();
  const rewrittenText = repairBuiltinMacroModuleSpecifiers(printer.printFile(transformed));
  return {
    rewriteStage: buildRewriteStageFromTexts(
      sourceFile.fileName,
      sourceFile.text,
      rewrittenText,
    ),
    sourceFile: ts.createSourceFile(
      sourceFile.fileName,
      rewrittenText,
      sourceFile.languageVersion,
      true,
    ),
  };
}

export function normalizeErrorBoundariesInProgram(
  program: ts.Program,
): ErrorNormalizedProgramResult {
  const checker = program.getTypeChecker();
  const changedFiles = new Map<string, ErrorNormalizedFile>();

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      !isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))
    ) {
      continue;
    }

    const normalized = normalizeSourceFile(sourceFile, checker);
    if (normalized) {
      changedFiles.set(sourceFile.fileName, normalized);
    }
  }

  return { changedFiles };
}
