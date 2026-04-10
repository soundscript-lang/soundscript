import ts from 'typescript';

import type { MacroRuntimeImportRequest } from './macro_output.ts';
import type { CollectedResolvedMacroPlaceholder } from './macro_resolver.ts';
import { collectResolvedMacroPlaceholders } from './macro_resolver.ts';
import type { ImportedMacroSiteKind, PreparedProgram } from './project_frontend.ts';
import type {
  AdvancedMacroExpansionResult,
  ExpandAdvancedMacroPlaceholder,
  NestedMacroRegistries,
} from './macro_advanced_backend_adapter.ts';

export type MacroExpansionResult =
  | { kind: 'expr'; node: ts.Expression; runtimeImports?: readonly MacroRuntimeImportRequest[] }
  | {
    kind: 'scope_exit';
    cleanupStatements: readonly ts.Statement[];
    runtimeImports?: readonly MacroRuntimeImportRequest[];
  }
  | {
    kind: 'stmt';
    nodes: readonly ts.Statement[];
    runtimeImports?: readonly MacroRuntimeImportRequest[];
  };

export type ExpandMacroPlaceholder = (
  resolved: CollectedResolvedMacroPlaceholder['resolved'],
) => MacroExpansionResult | undefined;

export type MacroExpanderRegistry = ReadonlyMap<string, ExpandMacroPlaceholder>;

export const MACRO_EXPANSION_START_MARKER_PREFIX = '__SS_MACRO_EXPANSION_START_';
export const MACRO_EXPANSION_END_MARKER_PREFIX = '__SS_MACRO_EXPANSION_END_';

export interface MacroModule {
  expanders: Readonly<Record<string, ExpandMacroPlaceholder>>;
  moduleName: string;
  advancedExpanders?: Readonly<Record<string, ExpandAdvancedMacroPlaceholder>>;
}

export function defineMacroModule(module: MacroModule): MacroModule {
  return module;
}

export function createMacroRegistry(
  entries: Readonly<Record<string, ExpandMacroPlaceholder>>,
): MacroExpanderRegistry {
  return new Map(Object.entries(entries));
}

export function buildMacroRegistryFromModules(
  modules: readonly MacroModule[],
): MacroExpanderRegistry {
  const registry = new Map<string, ExpandMacroPlaceholder>();

  for (const module of modules) {
    for (const [name, expander] of Object.entries(module.expanders)) {
      if (registry.has(name)) {
        throw new Error(
          `Duplicate macro expander registration for "${name}" from module "${module.moduleName}".`,
        );
      }
      registry.set(name, expander);
    }
  }

  return registry;
}

export type AdvancedMacroExpanderRegistry = ReadonlyMap<string, ExpandAdvancedMacroPlaceholder>;

export function buildAdvancedMacroRegistryFromModules(
  modules: readonly MacroModule[],
): AdvancedMacroExpanderRegistry {
  const registry = new Map<string, ExpandAdvancedMacroPlaceholder>();

  for (const module of modules) {
    for (const [name, expander] of Object.entries(module.advancedExpanders ?? {})) {
      if (registry.has(name)) {
        throw new Error(
          `Duplicate advanced macro expander registration for "${name}" from module "${module.moduleName}".`,
        );
      }
      registry.set(name, expander);
    }
  }

  return registry;
}

function asExpansionMap(
  collected: readonly CollectedResolvedMacroPlaceholder[],
): Map<number, CollectedResolvedMacroPlaceholder['resolved']> {
  return new Map(
    collected.map((entry) => [entry.resolved.placeholder.id, entry.resolved]),
  );
}

function isMacroHelperDeclaration(node: ts.Node): node is ts.FunctionDeclaration {
  return ts.isFunctionDeclaration(node) &&
    !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) &&
    !!node.name &&
    (node.name.text === '__sts_macro_expr' || node.name.text === '__sts_macro_stmt');
}

function stripMacroHelperDeclarations(sourceFile: ts.SourceFile): ts.SourceFile {
  return ts.factory.updateSourceFile(
    sourceFile,
    sourceFile.statements.filter((statement) => !isMacroHelperDeclaration(statement)),
  );
}

function injectRuntimeImports(
  sourceFile: ts.SourceFile,
  requests: readonly MacroRuntimeImportRequest[],
): ts.SourceFile {
  if (requests.length === 0) {
    return sourceFile;
  }

  const existingKeys = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) || !statement.importClause ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    const specifier = statement.moduleSpecifier.text;
    if (statement.importClause.name) {
      existingKeys.add(`default\u0000${specifier}\u0000\u0000${statement.importClause.name.text}`);
    }
    if (statement.importClause.namedBindings) {
      if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
        existingKeys.add(
          `namespace\u0000${specifier}\u0000\u0000${statement.importClause.namedBindings.name.text}`,
        );
      } else {
        for (const element of statement.importClause.namedBindings.elements) {
          existingKeys.add(
            `named\u0000${specifier}\u0000${
              element.propertyName?.text ?? element.name.text
            }\u0000${element.name.text}`,
          );
        }
      }
    }
  }

  const grouped = new Map<string, {
    defaultImport?: string;
    namedImports: Map<string, string>;
    namespaceImport?: string;
  }>();
  for (const request of requests) {
    const key = `${request.kind}\u0000${request.specifier}\u0000${
      request.exportName ?? ''
    }\u0000${request.localName}`;
    if (existingKeys.has(key)) {
      continue;
    }
    existingKeys.add(key);

    const group = grouped.get(request.specifier) ?? {
      namedImports: new Map<string, string>(),
    };
    if (request.kind === 'default') {
      group.defaultImport ??= request.localName;
    } else if (request.kind === 'namespace') {
      group.namespaceImport ??= request.localName;
    } else {
      group.namedImports.set(request.exportName!, request.localName);
    }
    grouped.set(request.specifier, group);
  }

  if (grouped.size === 0) {
    return sourceFile;
  }

  const newImports: ts.ImportDeclaration[] = [];
  for (const [specifier, group] of grouped.entries()) {
    if (group.namespaceImport) {
      newImports.push(
        ts.factory.createImportDeclaration(
          undefined,
          ts.factory.createImportClause(
            false,
            group.defaultImport ? ts.factory.createIdentifier(group.defaultImport) : undefined,
            ts.factory.createNamespaceImport(ts.factory.createIdentifier(group.namespaceImport)),
          ),
          ts.factory.createStringLiteral(specifier),
          undefined,
        ),
      );
      if (group.namedImports.size === 0) {
        continue;
      }
    }

    if (group.defaultImport || group.namedImports.size > 0) {
      newImports.push(
        ts.factory.createImportDeclaration(
          undefined,
          ts.factory.createImportClause(
            false,
            group.defaultImport ? ts.factory.createIdentifier(group.defaultImport) : undefined,
            group.namedImports.size > 0
              ? ts.factory.createNamedImports(
                [...group.namedImports.entries()]
                  .sort((left, right) => left[0].localeCompare(right[0]))
                  .map(([exportName, localName]) =>
                    exportName === localName
                      ? ts.factory.createImportSpecifier(
                        false,
                        undefined,
                        ts.factory.createIdentifier(localName),
                      )
                      : ts.factory.createImportSpecifier(
                        false,
                        ts.factory.createIdentifier(exportName),
                        ts.factory.createIdentifier(localName),
                      )
                  ),
              )
              : undefined,
          ),
          ts.factory.createStringLiteral(specifier),
          undefined,
        ),
      );
    }
  }

  const insertionIndex = sourceFile.statements.findIndex((statement) =>
    !ts.isImportDeclaration(statement)
  );
  const before = insertionIndex < 0
    ? [...sourceFile.statements]
    : sourceFile.statements.slice(0, insertionIndex);
  const after = insertionIndex < 0 ? [] : sourceFile.statements.slice(insertionIndex);
  return ts.factory.updateSourceFile(sourceFile, [
    ...before,
    ...newImports,
    ...after,
  ]);
}

function addExpansionStartMarker<T extends ts.Node>(node: T, id: number): T {
  ts.addSyntheticLeadingComment(
    node,
    ts.SyntaxKind.MultiLineCommentTrivia,
    `${MACRO_EXPANSION_START_MARKER_PREFIX}${id}__`,
    false,
  );
  return node;
}

function addExpansionEndMarker<T extends ts.Node>(node: T, id: number): T {
  ts.addSyntheticTrailingComment(
    node,
    ts.SyntaxKind.MultiLineCommentTrivia,
    `${MACRO_EXPANSION_END_MARKER_PREFIX}${id}__`,
    false,
  );
  return node;
}

function expandAdvancedMacroPlaceholdersInSourceFile(
  _preparedProgram: PreparedProgram,
  sourceFile: ts.SourceFile,
  collected: readonly CollectedResolvedMacroPlaceholder[],
  registry: AdvancedMacroExpanderRegistry,
  rewriteRegistry: MacroExpanderRegistry = new Map(),
  siteKindsBySpecifier: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>> = new Map(),
  annotateExpansions = false,
): ts.SourceFile {
  if (registry.size === 0) {
    return sourceFile;
  }

  const advancedSites = collected.filter((entry) =>
    entry.sourceFile.fileName === sourceFile.fileName &&
    registry.has(entry.resolved.placeholder.invocation.nameText)
  );
  if (advancedSites.length === 0) {
    return sourceFile;
  }

  const expansions = new Map<number, AdvancedMacroExpansionResult>();
  const runtimeImports: MacroRuntimeImportRequest[] = [];
  const nestedRegistries: NestedMacroRegistries = {
    advanced: registry,
    rewrite: rewriteRegistry,
    siteKindsBySpecifier,
  };
  for (const site of advancedSites) {
    const expander = registry.get(site.resolved.placeholder.invocation.nameText);
    if (!expander) {
      continue;
    }
    const expansion = expander(site.resolved, nestedRegistries);
    if (expansion) {
      expansions.set(site.resolved.placeholder.id, expansion);
      runtimeImports.push(...(expansion.runtimeImports ?? []));
    }
  }

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    let tempCounter = 0;

    const lookupExpansion = (
      callExpression: ts.CallExpression,
    ): { expansion: AdvancedMacroExpansionResult; id: number } | undefined => {
      if (
        !ts.isIdentifier(callExpression.expression) ||
        callExpression.expression.text !== '__sts_macro_expr' ||
        callExpression.arguments.length !== 1
      ) {
        return undefined;
      }

      const [firstArgument] = callExpression.arguments;
      if (!ts.isNumericLiteral(firstArgument)) {
        return undefined;
      }

      const id = Number(firstArgument.text);
      const expansion = expansions.get(id);
      return expansion ? { expansion, id } : undefined;
    };

    function freshTempName(prefix = '__sts_expr'): string {
      tempCounter += 1;
      return `${prefix}_${tempCounter}`;
    }

    function cloneStatement(statement: ts.Statement): ts.Statement {
      return (ts.factory as typeof ts.factory & { cloneNode(node: ts.Statement): ts.Statement })
        .cloneNode(statement);
    }

    function visitRequiredNode<T extends ts.Node>(node: T, description: string): T {
      const visited = ts.visitNode(node, visitTree);
      if (!visited) {
        throw new Error(`Expected transformer to preserve ${description}.`);
      }
      return visited as T;
    }

    function rewriteCurrentLoopContinues(
      statement: ts.Statement,
      continueLabel: string,
      currentLoopLabels: ReadonlySet<string>,
    ): ts.Statement {
      const continueTarget = ts.factory.createIdentifier(continueLabel);
      const visit: ts.Visitor = (node) => {
        if (ts.isFunctionLike(node)) {
          return node;
        }

        if (node !== statement && ts.isIterationStatement(node, false)) {
          return node;
        }

        if (
          ts.isContinueStatement(node) &&
          (!node.label || currentLoopLabels.has(node.label.text))
        ) {
          return ts.factory.createBreakStatement(continueTarget);
        }

        return ts.visitEachChild(node, visit, context);
      };

      return ts.visitNode(statement, visit) as ts.Statement;
    }

    function createVariableStatement(
      declarationKind: ts.NodeFlags,
      name: string,
      type: ts.TypeNode | undefined,
      initializer?: ts.Expression,
    ): ts.VariableStatement {
      return ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [ts.factory.createVariableDeclaration(name, undefined, type, initializer)],
          declarationKind,
        ),
      );
    }

    function createBlockStatement(statements: readonly ts.Statement[]): ts.Statement {
      return statements.length === 1
        ? statements[0]!
        : ts.factory.createBlock([...statements], true);
    }

    function createLabeledBodyStatement(labelName: string, statement: ts.Statement): ts.Statement {
      const bodyBlock = ts.isBlock(statement)
        ? statement
        : ts.factory.createBlock([statement], true);
      return ts.factory.createLabeledStatement(
        ts.factory.createIdentifier(labelName),
        bodyBlock,
      );
    }

    function createAssignmentStatement(name: string, expression: ts.Expression): ts.Statement {
      return ts.factory.createExpressionStatement(
        ts.factory.createBinaryExpression(
          ts.factory.createIdentifier(name),
          ts.factory.createToken(ts.SyntaxKind.EqualsToken),
          expression,
        ),
      );
    }

    function collectLeadingLabels(statement: ts.Statement): {
      labels: readonly string[];
      statement: ts.Statement;
    } {
      const labels: string[] = [];
      let current = statement;
      while (ts.isLabeledStatement(current)) {
        labels.push(current.label.text);
        current = current.statement;
      }
      return { labels, statement: current };
    }

    function reapplyLabels(
      labels: readonly string[],
      statements: readonly ts.Statement[],
    ): readonly ts.Statement[] {
      if (labels.length === 0 || statements.length === 0) {
        return statements;
      }

      const [last, ...restReversed] = [...statements].reverse();
      const labeledLast = labels.reduceRight<ts.Statement>(
        (current, label) =>
          ts.factory.createLabeledStatement(
            ts.factory.createIdentifier(label),
            current,
          ),
        last,
      );

      return [...restReversed.reverse(), labeledLast];
    }

    function createIsNullishExpression(expression: ts.Expression): ts.Expression {
      return ts.factory.createBinaryExpression(
        ts.factory.createBinaryExpression(
          expression,
          ts.factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
          ts.factory.createNull(),
        ),
        ts.factory.createToken(ts.SyntaxKind.BarBarToken),
        ts.factory.createBinaryExpression(
          expression,
          ts.factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
          ts.factory.createIdentifier('undefined'),
        ),
      );
    }

    function isOptionalCallExpression(node: ts.CallExpression): boolean {
      return !!node.questionDotToken ||
        (ts.isPropertyAccessExpression(node.expression) && !!node.expression.questionDotToken) ||
        (ts.isElementAccessExpression(node.expression) && !!node.expression.questionDotToken);
    }

    function rewriteOptionalElementAccessExpression(node: ts.ElementAccessExpression): {
      expression: ts.Expression;
      preludes: readonly ts.Statement[];
    } | null {
      if (!node.questionDotToken) {
        return null;
      }

      const rewrittenBase = rewriteExpression(node.expression);
      const rewrittenIndex = rewriteExpression(node.argumentExpression);
      if (rewrittenBase.preludes.length === 0 && rewrittenIndex.preludes.length === 0) {
        return null;
      }

      const baseTempName = freshTempName('__sts_chain');
      const resultTempName = freshTempName('__sts_expr');
      const baseIdentifier = () => ts.factory.createIdentifier(baseTempName);

      return {
        expression: ts.factory.createIdentifier(resultTempName),
        preludes: [
          ...rewrittenBase.preludes,
          createVariableStatement(
            ts.NodeFlags.Const,
            baseTempName,
            undefined,
            rewrittenBase.expression,
          ),
          createVariableStatement(ts.NodeFlags.Let, resultTempName, undefined),
          ts.factory.createIfStatement(
            createIsNullishExpression(baseIdentifier()),
            createBlockStatement([
              createAssignmentStatement(resultTempName, ts.factory.createIdentifier('undefined')),
            ]),
            createBlockStatement([
              ...rewrittenIndex.preludes.map(cloneStatement),
              createAssignmentStatement(
                resultTempName,
                ts.factory.createElementAccessExpression(
                  baseIdentifier(),
                  rewrittenIndex.expression,
                ),
              ),
            ]),
          ),
        ],
      };
    }

    function rewriteOptionalCallExpression(node: ts.CallExpression): {
      expression: ts.Expression;
      preludes: readonly ts.Statement[];
    } | null {
      if (!isOptionalCallExpression(node)) {
        return null;
      }

      let baseExpression: ts.Expression;
      let propertyName: ts.MemberName | undefined;
      let elementExpression: ts.Expression | undefined;

      if (node.questionDotToken) {
        baseExpression = node.expression;
      } else if (
        ts.isPropertyAccessExpression(node.expression) && node.expression.questionDotToken
      ) {
        baseExpression = node.expression.expression;
        propertyName = node.expression.name;
      } else if (
        ts.isElementAccessExpression(node.expression) && node.expression.questionDotToken
      ) {
        baseExpression = node.expression.expression;
        elementExpression = node.expression.argumentExpression;
      } else {
        return null;
      }

      const rewrittenBase = rewriteExpression(baseExpression);
      const rewrittenElement = elementExpression ? rewriteExpression(elementExpression) : null;
      const rewrittenArguments = node.arguments.map((argument) => rewriteExpression(argument));
      const needsGuardedRewrite = rewrittenBase.preludes.length > 0 ||
        (rewrittenElement?.preludes.length ?? 0) > 0 ||
        rewrittenArguments.some((argument) => argument.preludes.length > 0);
      if (!needsGuardedRewrite) {
        return null;
      }

      const baseTempName = freshTempName('__sts_chain');
      const resultTempName = freshTempName('__sts_expr');
      const baseIdentifier = () => ts.factory.createIdentifier(baseTempName);

      let callee: ts.Expression;
      if (propertyName) {
        callee = ts.factory.createPropertyAccessExpression(baseIdentifier(), propertyName);
      } else if (rewrittenElement) {
        callee = ts.factory.createElementAccessExpression(
          baseIdentifier(),
          rewrittenElement.expression,
        );
      } else {
        callee = baseIdentifier();
      }

      const guardedStatements: ts.Statement[] = [];
      if (rewrittenElement) {
        guardedStatements.push(...rewrittenElement.preludes.map(cloneStatement));
      }
      for (const rewrittenArgument of rewrittenArguments) {
        guardedStatements.push(...rewrittenArgument.preludes.map(cloneStatement));
      }
      guardedStatements.push(
        createAssignmentStatement(
          resultTempName,
          ts.factory.createCallExpression(
            callee,
            node.typeArguments,
            rewrittenArguments.map((argument) => argument.expression),
          ),
        ),
      );

      return {
        expression: ts.factory.createIdentifier(resultTempName),
        preludes: [
          ...rewrittenBase.preludes,
          createVariableStatement(
            ts.NodeFlags.Const,
            baseTempName,
            undefined,
            rewrittenBase.expression,
          ),
          createVariableStatement(ts.NodeFlags.Let, resultTempName, undefined),
          ts.factory.createIfStatement(
            createIsNullishExpression(baseIdentifier()),
            createBlockStatement([
              createAssignmentStatement(resultTempName, ts.factory.createIdentifier('undefined')),
            ]),
            createBlockStatement(guardedStatements),
          ),
        ],
      };
    }

    function isShortCircuitOperator(kind: ts.SyntaxKind): boolean {
      return kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken;
    }

    function rewriteShortCircuitBinaryExpression(node: ts.BinaryExpression): {
      expression: ts.Expression;
      preludes: readonly ts.Statement[];
    } | null {
      if (!isShortCircuitOperator(node.operatorToken.kind)) {
        return null;
      }

      const left = rewriteExpression(node.left);
      const right = rewriteExpression(node.right);
      if (left.preludes.length === 0 && right.preludes.length === 0) {
        return null;
      }

      const leftTempName = freshTempName('__sts_left');
      const resultTempName = freshTempName('__sts_expr');
      const leftIdentifier = () => ts.factory.createIdentifier(leftTempName);
      let thenStatements: ts.Statement[];
      let elseStatements: ts.Statement[];

      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken:
          thenStatements = [
            ...right.preludes.map(cloneStatement),
            createAssignmentStatement(resultTempName, right.expression),
          ];
          elseStatements = [
            createAssignmentStatement(resultTempName, leftIdentifier()),
          ];
          break;
        case ts.SyntaxKind.BarBarToken:
          thenStatements = [
            createAssignmentStatement(resultTempName, leftIdentifier()),
          ];
          elseStatements = [
            ...right.preludes.map(cloneStatement),
            createAssignmentStatement(resultTempName, right.expression),
          ];
          break;
        default:
          thenStatements = [
            createAssignmentStatement(resultTempName, leftIdentifier()),
          ];
          elseStatements = [
            ...right.preludes.map(cloneStatement),
            createAssignmentStatement(resultTempName, right.expression),
          ];
          break;
      }

      const condition = node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ? ts.factory.createBinaryExpression(
          ts.factory.createBinaryExpression(
            leftIdentifier(),
            ts.factory.createToken(ts.SyntaxKind.ExclamationEqualsEqualsToken),
            ts.factory.createNull(),
          ),
          ts.factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
          ts.factory.createBinaryExpression(
            leftIdentifier(),
            ts.factory.createToken(ts.SyntaxKind.ExclamationEqualsEqualsToken),
            ts.factory.createIdentifier('undefined'),
          ),
        )
        : leftIdentifier();

      return {
        expression: ts.factory.createIdentifier(resultTempName),
        preludes: [
          ...left.preludes,
          createVariableStatement(ts.NodeFlags.Const, leftTempName, undefined, left.expression),
          createVariableStatement(ts.NodeFlags.Let, resultTempName, undefined),
          ts.factory.createIfStatement(
            condition,
            createBlockStatement(thenStatements),
            createBlockStatement(elseStatements),
          ),
        ],
      };
    }

    function rewriteExpression(expression: ts.Expression): {
      expression: ts.Expression;
      preludes: readonly ts.Statement[];
    } {
      const preludes: ts.Statement[] = [];

      const visitExpression: ts.Visitor = (node) => {
        if (ts.isCallExpression(node)) {
          const match = lookupExpansion(node);
          if (match?.expansion.kind === 'statement_region_rewrite') {
            const preludeStatements = match.expansion.preludeStatements.map((statement) =>
              visitRequiredNode(statement, 'advanced prelude statement')
            );
            if (annotateExpansions && preludeStatements.length > 0) {
              addExpansionStartMarker(preludeStatements[0]!, match.id);
            }
            preludes.push(
              ...preludeStatements,
            );
            const replacementExpr = match.expansion.replacementExpr;
            const visitedReplacementExpr = visitRequiredNode(
              replacementExpr,
              'advanced replacement expression',
            ) as ts.Expression;
            if (annotateExpansions) {
              if (preludeStatements.length === 0) {
                addExpansionStartMarker(visitedReplacementExpr, match.id);
              }
              addExpansionEndMarker(visitedReplacementExpr, match.id);
            }
            return visitedReplacementExpr;
          }

          const rewrittenOptionalCall = rewriteOptionalCallExpression(node);
          if (rewrittenOptionalCall) {
            preludes.push(...rewrittenOptionalCall.preludes);
            return rewrittenOptionalCall.expression;
          }
        }

        if (ts.isElementAccessExpression(node)) {
          const rewrittenOptionalElementAccess = rewriteOptionalElementAccessExpression(node);
          if (rewrittenOptionalElementAccess) {
            preludes.push(...rewrittenOptionalElementAccess.preludes);
            return rewrittenOptionalElementAccess.expression;
          }
        }

        if (ts.isBinaryExpression(node)) {
          const rewrittenShortCircuit = rewriteShortCircuitBinaryExpression(node);
          if (rewrittenShortCircuit) {
            preludes.push(...rewrittenShortCircuit.preludes);
            return rewrittenShortCircuit.expression;
          }
        }

        if (ts.isConditionalExpression(node)) {
          const condition = rewriteExpression(node.condition);
          const whenTrue = rewriteExpression(node.whenTrue);
          const whenFalse = rewriteExpression(node.whenFalse);
          const tempName = freshTempName('__sts_expr');

          preludes.push(
            ...condition.preludes,
            createVariableStatement(ts.NodeFlags.Let, tempName, undefined),
            ts.factory.createIfStatement(
              condition.expression,
              createBlockStatement([
                ...whenTrue.preludes,
                createAssignmentStatement(tempName, whenTrue.expression),
              ]),
              createBlockStatement([
                ...whenFalse.preludes,
                createAssignmentStatement(tempName, whenFalse.expression),
              ]),
            ),
          );

          return ts.factory.createIdentifier(tempName);
        }

        if (ts.isFunctionExpression(node)) {
          return ts.factory.updateFunctionExpression(
            node,
            node.modifiers,
            node.asteriskToken,
            node.name,
            node.typeParameters,
            node.parameters,
            node.type,
            ts.visitNode(node.body, visitTree) as ts.Block,
          );
        }

        if (ts.isArrowFunction(node)) {
          if (!ts.isBlock(node.body)) {
            const rewrittenBody = rewriteExpression(node.body);
            if (rewrittenBody.preludes.length > 0) {
              return ts.factory.updateArrowFunction(
                node,
                node.modifiers,
                node.typeParameters,
                node.parameters,
                node.type,
                node.equalsGreaterThanToken,
                ts.factory.createBlock(
                  [
                    ...rewrittenBody.preludes,
                    ts.factory.createReturnStatement(rewrittenBody.expression),
                  ],
                  true,
                ),
              );
            }
          }

          return ts.factory.updateArrowFunction(
            node,
            node.modifiers,
            node.typeParameters,
            node.parameters,
            node.type,
            node.equalsGreaterThanToken,
            ts.isBlock(node.body) ? ts.visitNode(node.body, visitTree) as ts.Block : node.body,
          );
        }

        if (ts.isClassExpression(node)) {
          return ts.visitEachChild(node, visitTree, context);
        }

        return ts.visitEachChild(node, visitExpression, context);
      };

      return {
        expression: ts.visitNode(expression, visitExpression) as ts.Expression,
        preludes,
      };
    }

    function rewriteLogicalExpressionForStatement(expression: ts.Expression): {
      expression: ts.Expression;
      preludes: readonly ts.Statement[];
    } | null {
      if (!ts.isBinaryExpression(expression)) {
        return null;
      }
      return rewriteShortCircuitBinaryExpression(expression);
    }

    function rewriteForInitializer(initializer: ts.ForInitializer | undefined): {
      initializer: ts.ForInitializer | undefined;
      preludes: readonly ts.Statement[];
      leadingStatements: readonly ts.Statement[];
    } {
      if (!initializer) {
        return {
          initializer: undefined,
          preludes: [],
          leadingStatements: [],
        };
      }

      if (ts.isVariableDeclarationList(initializer)) {
        const declaration = initializer.declarations[0];
        if (!declaration?.initializer) {
          const visited = visitRequiredNode(initializer, 'for initializer');
          return {
            initializer: visited,
            preludes: [],
            leadingStatements: [ts.factory.createVariableStatement(undefined, visited)],
          };
        }

        const rewritten = rewriteLogicalExpressionForStatement(declaration.initializer) ??
          rewriteExpression(declaration.initializer);
        const updatedDeclaration = ts.factory.updateVariableDeclaration(
          declaration,
          declaration.name,
          declaration.exclamationToken,
          declaration.type,
          rewritten.expression,
        );
        const updatedInitializer = ts.factory.updateVariableDeclarationList(initializer, [
          updatedDeclaration,
        ]);
        return {
          initializer: updatedInitializer,
          preludes: rewritten.preludes,
          leadingStatements: [
            ...rewritten.preludes,
            ts.factory.createVariableStatement(undefined, updatedInitializer),
          ],
        };
      }

      const rewritten = rewriteLogicalExpressionForStatement(initializer) ??
        rewriteExpression(initializer);
      return {
        initializer: rewritten.expression,
        preludes: rewritten.preludes,
        leadingStatements: [
          ...rewritten.preludes,
          ts.factory.createExpressionStatement(rewritten.expression),
        ],
      };
    }

    function rewriteStatement(statement: ts.Statement): readonly ts.Statement[] {
      const labeled = collectLeadingLabels(statement);
      if (labeled.labels.length > 0) {
        return reapplyLabels(
          labeled.labels,
          rewriteStatementCore(labeled.statement, new Set(labeled.labels)),
        );
      }

      return rewriteStatementCore(statement, new Set());
    }

    function rewriteStatementCore(
      statement: ts.Statement,
      currentLoopLabels: ReadonlySet<string>,
    ): readonly ts.Statement[] {
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations[0];
        const initializer = declaration?.initializer;
        if (!initializer) {
          return [visitRequiredNode(statement, 'variable statement without initializer')];
        }

        const rewritten = rewriteLogicalExpressionForStatement(initializer) ??
          rewriteExpression(initializer);
        const updatedDeclaration = ts.factory.updateVariableDeclaration(
          declaration,
          declaration.name,
          declaration.exclamationToken,
          declaration.type,
          rewritten.expression,
        );
        return [
          ...rewritten.preludes,
          ts.factory.updateVariableStatement(
            statement,
            statement.modifiers,
            ts.factory.updateVariableDeclarationList(statement.declarationList, [
              updatedDeclaration,
            ]),
          ),
        ];
      }

      if (ts.isExpressionStatement(statement)) {
        const rewritten = rewriteLogicalExpressionForStatement(statement.expression) ??
          rewriteExpression(statement.expression);
        return [
          ...rewritten.preludes,
          ts.factory.updateExpressionStatement(statement, rewritten.expression),
        ];
      }

      if (ts.isReturnStatement(statement) && statement.expression) {
        const rewritten = rewriteLogicalExpressionForStatement(statement.expression) ??
          rewriteExpression(statement.expression);
        return [
          ...rewritten.preludes,
          ts.factory.updateReturnStatement(statement, rewritten.expression),
        ];
      }

      if (ts.isThrowStatement(statement) && statement.expression) {
        const rewritten = rewriteLogicalExpressionForStatement(statement.expression) ??
          rewriteExpression(statement.expression);
        return [
          ...rewritten.preludes,
          ts.factory.updateThrowStatement(statement, rewritten.expression),
        ];
      }

      if (ts.isIfStatement(statement)) {
        const rewritten = rewriteLogicalExpressionForStatement(statement.expression) ??
          rewriteExpression(statement.expression);
        return [
          ...rewritten.preludes,
          ts.factory.updateIfStatement(
            statement,
            rewritten.expression,
            visitRequiredNode(statement.thenStatement, 'if then statement'),
            statement.elseStatement
              ? visitRequiredNode(statement.elseStatement, 'if else statement')
              : undefined,
          ),
        ];
      }

      if (ts.isWhileStatement(statement)) {
        const rewritten = rewriteLogicalExpressionForStatement(statement.expression) ??
          rewriteExpression(statement.expression);
        const visitedBody = visitRequiredNode(statement.statement, 'while body');
        if (rewritten.preludes.length === 0) {
          return [
            ts.factory.updateWhileStatement(statement, rewritten.expression, visitedBody),
          ];
        }

        return [
          ts.factory.createWhileStatement(
            ts.factory.createTrue(),
            ts.factory.createBlock(
              [
                ...rewritten.preludes,
                ts.factory.createIfStatement(
                  ts.factory.createPrefixUnaryExpression(
                    ts.SyntaxKind.ExclamationToken,
                    rewritten.expression,
                  ),
                  ts.factory.createBlock([ts.factory.createBreakStatement()], true),
                ),
                visitedBody,
              ],
              true,
            ),
          ),
        ];
      }

      if (ts.isSwitchStatement(statement)) {
        const rewritten = rewriteLogicalExpressionForStatement(statement.expression) ??
          rewriteExpression(statement.expression);
        return [
          ...rewritten.preludes,
          ts.factory.updateSwitchStatement(
            statement,
            rewritten.expression,
            visitRequiredNode(statement.caseBlock, 'switch case block'),
          ),
        ];
      }

      if (ts.isForOfStatement(statement)) {
        const rewritten = rewriteLogicalExpressionForStatement(statement.expression) ??
          rewriteExpression(statement.expression);
        return [
          ...rewritten.preludes,
          ts.factory.updateForOfStatement(
            statement,
            statement.awaitModifier,
            visitRequiredNode(statement.initializer, 'for-of initializer'),
            rewritten.expression,
            visitRequiredNode(statement.statement, 'for-of body'),
          ),
        ];
      }

      if (ts.isForInStatement(statement)) {
        const rewritten = rewriteLogicalExpressionForStatement(statement.expression) ??
          rewriteExpression(statement.expression);
        return [
          ...rewritten.preludes,
          ts.factory.updateForInStatement(
            statement,
            visitRequiredNode(statement.initializer, 'for-in initializer'),
            rewritten.expression,
            visitRequiredNode(statement.statement, 'for-in body'),
          ),
        ];
      }

      if (ts.isDoStatement(statement)) {
        const rewritten = rewriteLogicalExpressionForStatement(statement.expression) ??
          rewriteExpression(statement.expression);
        const visitedBody = visitRequiredNode(statement.statement, 'do-while body');
        if (rewritten.preludes.length === 0) {
          return [
            ts.factory.updateDoStatement(statement, visitedBody, rewritten.expression),
          ];
        }

        const continueLabel = freshTempName('__sts_continue');
        return [
          ts.factory.createWhileStatement(
            ts.factory.createTrue(),
            ts.factory.createBlock(
              [
                createLabeledBodyStatement(
                  continueLabel,
                  rewriteCurrentLoopContinues(visitedBody, continueLabel, currentLoopLabels),
                ),
                ...rewritten.preludes,
                ts.factory.createIfStatement(
                  ts.factory.createPrefixUnaryExpression(
                    ts.SyntaxKind.ExclamationToken,
                    rewritten.expression,
                  ),
                  ts.factory.createBlock([ts.factory.createBreakStatement()], true),
                ),
              ],
              true,
            ),
          ),
        ];
      }

      if (ts.isForStatement(statement)) {
        const initializer = rewriteForInitializer(statement.initializer);
        const condition = statement.condition
          ? rewriteLogicalExpressionForStatement(statement.condition) ??
            rewriteExpression(statement.condition)
          : { expression: ts.factory.createTrue(), preludes: [] as readonly ts.Statement[] };
        const incrementor = statement.incrementor
          ? rewriteLogicalExpressionForStatement(statement.incrementor) ??
            rewriteExpression(statement.incrementor)
          : null;
        const visitedBody = visitRequiredNode(statement.statement, 'for body');
        if (
          initializer.preludes.length === 0 &&
          condition.preludes.length === 0 &&
          (incrementor?.preludes.length ?? 0) === 0
        ) {
          return [
            ts.factory.updateForStatement(
              statement,
              initializer.initializer,
              condition.expression,
              incrementor?.expression ??
                (statement.incrementor
                  ? visitRequiredNode(statement.incrementor, 'for incrementor')
                  : undefined),
              visitedBody,
            ),
          ];
        }

        const continueLabel = freshTempName('__sts_continue');
        const loopStatements: ts.Statement[] = [
          ...condition.preludes,
          ts.factory.createIfStatement(
            ts.factory.createPrefixUnaryExpression(
              ts.SyntaxKind.ExclamationToken,
              condition.expression,
            ),
            ts.factory.createBlock([ts.factory.createBreakStatement()], true),
          ),
          createLabeledBodyStatement(
            continueLabel,
            rewriteCurrentLoopContinues(visitedBody, continueLabel, currentLoopLabels),
          ),
        ];
        if (statement.incrementor) {
          if (incrementor) {
            loopStatements.push(...incrementor.preludes);
            loopStatements.push(
              ts.factory.createExpressionStatement(incrementor.expression),
            );
          } else {
            loopStatements.push(
              ts.factory.createExpressionStatement(
                visitRequiredNode(statement.incrementor, 'for incrementor'),
              ),
            );
          }
        }

        return [
          ...initializer.leadingStatements,
          ts.factory.createWhileStatement(
            ts.factory.createTrue(),
            ts.factory.createBlock(loopStatements, true),
          ),
        ];
      }

      return [visitRequiredNode(statement, `${ts.SyntaxKind[statement.kind]} statement`)];
    }

    function visitStatements(statements: readonly ts.Statement[]): ts.NodeArray<ts.Statement> {
      const nextStatements: ts.Statement[] = [];
      for (const statement of statements) {
        nextStatements.push(...rewriteStatement(statement));
      }
      return ts.factory.createNodeArray(nextStatements);
    }

    const visitTree: ts.Visitor = (node) => {
      if (ts.isSourceFile(node)) {
        return ts.factory.updateSourceFile(node, visitStatements(node.statements));
      }
      if (ts.isBlock(node)) {
        return ts.factory.updateBlock(node, visitStatements(node.statements));
      }
      if (ts.isCaseClause(node)) {
        return ts.factory.updateCaseClause(node, node.expression, visitStatements(node.statements));
      }
      if (ts.isDefaultClause(node)) {
        return ts.factory.updateDefaultClause(node, visitStatements(node.statements));
      }
      if (ts.isModuleBlock(node)) {
        return ts.factory.updateModuleBlock(node, visitStatements(node.statements));
      }
      return ts.visitEachChild(node, visitTree, context);
    };

    return (node) => ts.visitNode(node, visitTree) as ts.SourceFile;
  };

  const transformed = ts.transform(sourceFile, [transformer]);
  const [expanded] = transformed.transformed;
  transformed.dispose();
  return injectRuntimeImports(stripMacroHelperDeclarations(expanded), runtimeImports);
}

export function expandMacroPlaceholdersInSourceFile(
  sourceFile: ts.SourceFile,
  collected: readonly CollectedResolvedMacroPlaceholder[],
  expand: ExpandMacroPlaceholder,
  annotateExpansions = false,
): ts.SourceFile {
  if (collected.length === 0) {
    return stripMacroHelperDeclarations(sourceFile);
  }

  const expansions = asExpansionMap(
    collected.filter((entry) => entry.sourceFile.fileName === sourceFile.fileName),
  );
  if (expansions.size === 0) {
    return stripMacroHelperDeclarations(sourceFile);
  }

  const runtimeImports: MacroRuntimeImportRequest[] = [];

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    let tempCounter = 0;

    const lookupResolved = (
      callExpression: ts.CallExpression,
    ): CollectedResolvedMacroPlaceholder['resolved'] | undefined => {
      if (
        !ts.isIdentifier(callExpression.expression) ||
        !(
          callExpression.expression.text === '__sts_macro_expr' ||
          callExpression.expression.text === '__sts_macro_stmt'
        ) ||
        callExpression.arguments.length !== 1
      ) {
        return undefined;
      }

      const [firstArgument] = callExpression.arguments;
      return ts.isNumericLiteral(firstArgument)
        ? expansions.get(Number(firstArgument.text))
        : undefined;
    };

    function freshTempName(prefix = '__sts_defer'): string {
      tempCounter += 1;
      return `${prefix}_${tempCounter}`;
    }

    function createScopeExitPushStatement(
      stackName: string,
      cleanupStatements: readonly ts.Statement[],
    ): ts.Statement {
      return ts.factory.createExpressionStatement(
        ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(
            ts.factory.createIdentifier(stackName),
            'push',
          ),
          undefined,
          [
            ts.factory.createArrowFunction(
              undefined,
              undefined,
              [],
              undefined,
              ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              ts.factory.createBlock([...cleanupStatements], true),
            ),
          ],
        ),
      );
    }

    function createScopeExitDrainStatement(stackName: string, indexName: string): ts.Statement {
      const stackIdentifier = ts.factory.createIdentifier(stackName);
      const indexIdentifier = ts.factory.createIdentifier(indexName);
      return ts.factory.createForStatement(
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              indexIdentifier,
              undefined,
              undefined,
              ts.factory.createBinaryExpression(
                ts.factory.createPropertyAccessExpression(stackIdentifier, 'length'),
                ts.factory.createToken(ts.SyntaxKind.MinusToken),
                ts.factory.createNumericLiteral('1'),
              ),
            ),
          ],
          ts.NodeFlags.Let,
        ),
        ts.factory.createBinaryExpression(
          indexIdentifier,
          ts.factory.createToken(ts.SyntaxKind.GreaterThanEqualsToken),
          ts.factory.createNumericLiteral('0'),
        ),
        ts.factory.createPostfixUnaryExpression(
          indexIdentifier,
          ts.SyntaxKind.MinusMinusToken,
        ),
        ts.factory.createBlock([
          ts.factory.createExpressionStatement(
            ts.factory.createCallExpression(
              ts.factory.createElementAccessExpression(stackIdentifier, indexIdentifier),
              undefined,
              [],
            ),
          ),
        ], true),
      );
    }

    function expandStatementEntry(
      statement: ts.Statement,
    ):
      | { kind: 'scope_exit'; cleanupStatements: readonly ts.Statement[] }
      | { kind: 'stmt'; nodes: readonly ts.Statement[] } {
      if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        const resolved = lookupResolved(statement.expression);
        if (resolved && resolved.placeholder.invocation.rewriteKind === 'stmt') {
          const expansion = expand(resolved);
          if (!expansion) {
            return {
              kind: 'stmt',
              nodes: [statement],
            };
          }
          if (expansion.kind === 'scope_exit') {
            runtimeImports.push(...(expansion.runtimeImports ?? []));
            return {
              cleanupStatements: expansion.cleanupStatements.map((node) =>
                ts.visitNode(node, visitStatementOrExpression) as ts.Statement
              ),
              kind: 'scope_exit',
            };
          }
          if (expansion.kind !== 'stmt') {
            throw new Error('Statement macro placeholder must expand to statement nodes.');
          }

          runtimeImports.push(...(expansion.runtimeImports ?? []));
          const nodes = expansion.nodes.map((node) =>
            ts.visitNode(node, visitStatementOrExpression) as ts.Statement
          );
          if (annotateExpansions && nodes.length > 0) {
            addExpansionStartMarker(nodes[0]!, resolved.placeholder.id);
            addExpansionEndMarker(nodes[nodes.length - 1]!, resolved.placeholder.id);
          }

          return {
            kind: 'stmt',
            nodes,
          };
        }
      }

      return {
        kind: 'stmt',
        nodes: [ts.visitNode(statement, visitStatementOrExpression) as ts.Statement],
      };
    }

    function visitStatements(
      containerKind: 'block' | 'case' | 'default' | 'module' | 'source_file',
      statements: readonly ts.Statement[],
    ): ts.NodeArray<ts.Statement> {
      const transformedEntries = statements.map((statement) => expandStatementEntry(statement));
      if (!transformedEntries.some((entry) => entry.kind === 'scope_exit')) {
        const nextStatements: ts.Statement[] = [];
        for (const entry of transformedEntries) {
          if (entry.kind === 'stmt') {
            nextStatements.push(...entry.nodes);
          }
        }
        return ts.factory.createNodeArray(nextStatements);
      }

      if (containerKind === 'source_file') {
        throw new Error(
          'Defer can only be used inside block-scoped statement lists and cannot be used at module scope.',
        );
      }

      const stackName = freshTempName('__sts_defer_stack');
      const indexName = freshTempName('__sts_defer_index');
      const bodyStatements: ts.Statement[] = [];

      for (const entry of transformedEntries) {
        if (entry.kind === 'scope_exit') {
          bodyStatements.push(createScopeExitPushStatement(stackName, entry.cleanupStatements));
          continue;
        }
        bodyStatements.push(...entry.nodes);
      }

      const nextStatements: ts.Statement[] = [
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            [ts.factory.createVariableDeclaration(
              stackName,
              undefined,
              undefined,
              ts.factory.createArrayLiteralExpression([], false),
            )],
            ts.NodeFlags.Const,
          ),
        ),
        ts.factory.createTryStatement(
          ts.factory.createBlock(bodyStatements, true),
          undefined,
          ts.factory.createBlock([createScopeExitDrainStatement(stackName, indexName)], true),
        ),
      ];

      return ts.factory.createNodeArray(nextStatements);
    }

    const visitStatementOrExpression: ts.Visitor = (node) => {
      if (ts.isSourceFile(node)) {
        return ts.factory.updateSourceFile(
          node,
          visitStatements('source_file', node.statements),
        );
      }

      if (ts.isBlock(node)) {
        return ts.factory.updateBlock(node, visitStatements('block', node.statements));
      }

      if (ts.isCaseClause(node)) {
        return ts.factory.updateCaseClause(
          node,
          node.expression,
          visitStatements('case', node.statements),
        );
      }

      if (ts.isDefaultClause(node)) {
        return ts.factory.updateDefaultClause(node, visitStatements('default', node.statements));
      }

      if (ts.isModuleBlock(node)) {
        return ts.factory.updateModuleBlock(node, visitStatements('module', node.statements));
      }

      if (ts.isCallExpression(node)) {
        const resolved = lookupResolved(node);
        if (resolved && resolved.placeholder.invocation.rewriteKind === 'expr') {
          const expansion = expand(resolved);
          if (!expansion) {
            return node;
          }
          if (expansion.kind !== 'expr') {
            throw new Error('Expression macro placeholder must expand to an expression node.');
          }
          runtimeImports.push(...(expansion.runtimeImports ?? []));
          const visitedNode = ts.visitNode(
            expansion.node,
            visitStatementOrExpression,
          ) as ts.Expression;
          if (annotateExpansions) {
            addExpansionStartMarker(visitedNode, resolved.placeholder.id);
            addExpansionEndMarker(visitedNode, resolved.placeholder.id);
          }

          return visitedNode;
        }
      }

      return ts.visitEachChild(node, visitStatementOrExpression, context);
    };

    return (node) => ts.visitNode(node, visitStatementOrExpression) as ts.SourceFile;
  };

  const transformed = ts.transform(sourceFile, [transformer]);
  const [expanded] = transformed.transformed;
  const withoutHelpers = stripMacroHelperDeclarations(expanded);
  transformed.dispose();
  return injectRuntimeImports(withoutHelpers, runtimeImports);
}

export function expandMacroPlaceholdersWithRegistry(
  sourceFile: ts.SourceFile,
  collected: readonly CollectedResolvedMacroPlaceholder[],
  registry: MacroExpanderRegistry,
  preserveMissingExpanders = false,
  annotateExpansions = false,
): ts.SourceFile {
  return expandMacroPlaceholdersInSourceFile(sourceFile, collected, (resolved) => {
    const expander = registry.get(resolved.placeholder.invocation.nameText);
    if (!expander) {
      if (preserveMissingExpanders) {
        return undefined;
      }
      throw new Error(
        `No macro expander registered for "${resolved.placeholder.invocation.nameText}".`,
      );
    }

    return expander(resolved);
  }, annotateExpansions);
}

export function expandPreparedProgramWithRegistry(
  preparedProgram: PreparedProgram,
  registry: MacroExpanderRegistry,
  advancedRegistry: AdvancedMacroExpanderRegistry = new Map(),
): ReadonlyMap<string, ts.SourceFile> {
  const collected = collectResolvedMacroPlaceholders(preparedProgram);
  const expandedFiles = new Map<string, ts.SourceFile>();

  for (const sourceFile of preparedProgram.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }

    const withAdvancedExpanded = expandAdvancedMacroPlaceholdersInSourceFile(
      preparedProgram,
      sourceFile,
      collected,
      advancedRegistry,
      registry,
    );
    expandedFiles.set(
      sourceFile.fileName,
      expandMacroPlaceholdersWithRegistry(withAdvancedExpanded, collected, registry),
    );
  }

  return expandedFiles;
}

export function expandPreparedProgramWithModules(
  preparedProgram: PreparedProgram,
  modules: readonly MacroModule[],
): ReadonlyMap<string, ts.SourceFile> {
  return expandPreparedProgramWithRegistry(
    preparedProgram,
    buildMacroRegistryFromModules(modules),
    buildAdvancedMacroRegistryFromModules(modules),
  );
}

export function expandPreparedProgramWithFileRegistries(
  preparedProgram: PreparedProgram,
  registriesByFile: ReadonlyMap<
    string,
    {
      registry: MacroExpanderRegistry;
      advancedRegistry?: AdvancedMacroExpanderRegistry;
      siteKindsBySpecifier?: ReadonlyMap<string, ReadonlyMap<string, ImportedMacroSiteKind>>;
    }
  >,
  preserveMissingExpanders = false,
  annotateExpansions = false,
  sourceFiles = preparedProgram.program.getSourceFiles(),
): ReadonlyMap<string, ts.SourceFile> {
  const nonDeclarationSourceFiles = sourceFiles.filter((sourceFile) =>
    !sourceFile.isDeclarationFile
  );
  const collected = collectResolvedMacroPlaceholders(preparedProgram, nonDeclarationSourceFiles);
  const expandedFiles = new Map<string, ts.SourceFile>();

  for (const sourceFile of nonDeclarationSourceFiles) {
    const fileRegistries = registriesByFile.get(sourceFile.fileName);
    const advancedRegistry = fileRegistries?.advancedRegistry ?? new Map();
    const registry = fileRegistries?.registry ?? new Map();
    const siteKindsBySpecifier = fileRegistries?.siteKindsBySpecifier ?? new Map();

    const withAdvancedExpanded = expandAdvancedMacroPlaceholdersInSourceFile(
      preparedProgram,
      sourceFile,
      collected,
      advancedRegistry,
      registry,
      siteKindsBySpecifier,
      annotateExpansions,
    );
    expandedFiles.set(
      sourceFile.fileName,
      expandMacroPlaceholdersWithRegistry(
        withAdvancedExpanded,
        collected,
        registry,
        preserveMissingExpanders,
        annotateExpansions,
      ),
    );
  }

  return expandedFiles;
}
