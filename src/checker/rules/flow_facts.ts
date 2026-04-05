import ts from 'typescript';

import type {
  AnalysisContext,
  FlowBranchEntryStructureFact,
  FlowBranchStructureFact,
  FlowChildRegionStructureEntryFact,
  FlowChildRegionStructureFact,
  FlowConditionStructureFact,
  FlowConditionSyntaxFact,
  FlowConditionSyntaxFactKind,
  FlowExitKind,
  FlowRegionEntryStructureFact,
  FlowRegionStructureFact,
  FlowStatementStructureFact,
} from '../engine/types.ts';

export type FlowFactKind = FlowConditionSyntaxFactKind;

export interface FlowFact<Path> {
  kind: FlowFactKind;
  path: Path;
  polarity: 'negative' | 'positive';
  sourceNode: ts.Node;
}

export interface ConditionAnalysis<Path> {
  facts: readonly FlowFact<Path>[];
  invalidatingNode?: ts.Node;
  invalidatedFact?: FlowFact<Path>;
}

export interface StatementAnalysisOptions {
  treatContinueAsExit?: boolean;
  treatBreakAsExit?: boolean;
}

export interface FlowFactEnvironment<Path, State> {
  appendSegment(path: Path, segment: string): Path;
  escapingExpressionAffectsNarrow(
    context: AnalysisContext,
    expression: ts.Expression,
    path: Path,
    state: State,
  ): boolean;
  normalizeExpressionPath(
    context: AnalysisContext,
    expression: ts.Expression,
    state: State,
  ): Path | undefined;
  normalizeWholeValueFactPath(
    context: AnalysisContext,
    expression: ts.Expression,
    state: State,
  ): Path | undefined;
  shouldTrackFact(
    context: AnalysisContext,
    path: Path,
    state: State,
  ): boolean;
}

type SupportedTypeof = 'bigint' | 'boolean' | 'number' | 'object' | 'string' | 'symbol';

export function createFlowFact<Path>(
  kind: FlowFactKind,
  path: Path,
  sourceNode: ts.Node,
  polarity: 'negative' | 'positive' = 'positive',
): FlowFact<Path> {
  return {
    kind,
    path,
    polarity,
    sourceNode,
  };
}

export function analyzeConditionExpression<Path, State>(
  context: AnalysisContext,
  expression: ts.Expression,
  state: State,
  environment: FlowFactEnvironment<Path, State>,
): ConditionAnalysis<Path> {
  return analyzeConditionStructure(
    context,
    getFlowConditionStructure(context, expression),
    state,
    environment,
  );
}

export function getFlowConditionStructure(
  context: AnalysisContext,
  expression: ts.Expression,
): FlowConditionStructureFact {
  return context.facts.getFlowConditionStructure(
    expression,
    () => parseConditionStructure(context, expression),
  );
}

export function analyzeConditionStructure<Path, State>(
  context: AnalysisContext,
  structure: FlowConditionStructureFact,
  state: State,
  environment: FlowFactEnvironment<Path, State>,
): ConditionAnalysis<Path> {
  return resolveConditionStructure(context, structure, state, environment);
}

function resolveConditionStructure<Path, State>(
  context: AnalysisContext,
  structure: FlowConditionStructureFact,
  state: State,
  environment: FlowFactEnvironment<Path, State>,
): ConditionAnalysis<Path> {
  if (structure.kind === 'none') {
    return { facts: [] };
  }

  if (structure.kind === 'facts') {
    return {
      facts: materializeFlowFacts(context, structure.facts, state, environment),
    };
  }

  const left = resolveConditionStructure(context, structure.left, state, environment);
  const right = resolveConditionStructure(context, structure.right, state, environment);
  const leftFacts = left.facts.filter((fact) =>
    !environment.escapingExpressionAffectsNarrow(
      context,
      structure.rightExpression,
      fact.path,
      state,
    )
  );

  return {
    facts: [...leftFacts, ...right.facts],
    invalidatingNode: left.invalidatingNode ??
      (
        left.facts.some((fact) =>
            environment.escapingExpressionAffectsNarrow(
              context,
              structure.rightExpression,
              fact.path,
              state,
            )
          )
          ? structure.rightExpression
          : right.invalidatingNode
      ),
    invalidatedFact: left.invalidatedFact ??
      left.facts.find((fact) =>
        environment.escapingExpressionAffectsNarrow(
          context,
          structure.rightExpression,
          fact.path,
          state,
        )
      ) ??
      right.invalidatedFact,
  };
}

function materializeFlowFacts<Path, State>(
  context: AnalysisContext,
  facts: readonly FlowConditionSyntaxFact[],
  state: State,
  environment: FlowFactEnvironment<Path, State>,
): readonly FlowFact<Path>[] {
  const materialized: FlowFact<Path>[] = [];

  for (const fact of facts) {
    if (fact.kind === 'inProperty') {
      const basePath = environment.normalizeExpressionPath(context, fact.subjectExpression, state);
      if (!basePath) {
        continue;
      }

      const path = environment.appendSegment(basePath, fact.propertySegment);
      if (!environment.shouldTrackFact(context, path, state)) {
        continue;
      }

      materialized.push(
        createFlowFact(
          'inProperty',
          path,
          fact.sourceNode,
          fact.polarity,
        ),
      );
      continue;
    }

    const path = environment.normalizeWholeValueFactPath(
      context,
      fact.subjectExpression,
      state,
    );
    if (!path || !environment.shouldTrackFact(context, path, state)) {
      continue;
    }

    materialized.push(
      createFlowFact(fact.kind, path, fact.sourceNode, fact.polarity),
    );
  }

  return materialized;
}

export function extractSequentialFacts<Path, State>(
  context: AnalysisContext,
  statement: ts.Statement,
  state: State,
  environment: FlowFactEnvironment<Path, State>,
  options: StatementAnalysisOptions = {},
): readonly FlowFact<Path>[] {
  return materializeConditionStructures(
    context,
    getSequentialConditionStructures(context, statement, options),
    state,
    environment,
  ).facts;
}

export function materializeConditionStructures<Path, State>(
  context: AnalysisContext,
  structures: readonly FlowConditionStructureFact[],
  state: State,
  environment: FlowFactEnvironment<Path, State>,
): ConditionAnalysis<Path> {
  const facts: FlowFact<Path>[] = [];
  let invalidatingNode: ts.Node | undefined;
  let invalidatedFact: FlowFact<Path> | undefined;

  for (const structure of structures) {
    const analysis = analyzeConditionStructure(context, structure, state, environment);
    facts.push(...analysis.facts);
    invalidatingNode ??= analysis.invalidatingNode;
    invalidatedFact ??= analysis.invalidatedFact;
  }

  return { facts, invalidatingNode, invalidatedFact };
}

export function getSequentialConditionStructures(
  context: AnalysisContext,
  statement: ts.Statement,
  options: StatementAnalysisOptions = {},
): readonly FlowConditionStructureFact[] {
  const structure = getFlowStatementStructure(context, statement);

  if (
    ts.isIfStatement(statement) &&
    structure.kind === 'if' &&
    structure.elseExitKinds.length === 0 &&
    exitKindsSatisfyOptions(structure.thenExitKinds, options)
  ) {
    return [getFallthroughConditionStructure(context, statement.expression)];
  }

  if (
    ts.isIfStatement(statement) &&
    structure.kind === 'if' &&
    structure.elseExitKinds.length > 0 &&
    exitKindsSatisfyOptions(structure.elseExitKinds, options)
  ) {
    return [structure.condition];
  }

  if (structure.kind === 'expressionCall') {
    return [structure.condition];
  }

  if (
    structure.kind === 'try' &&
    structure.exitKinds.length === 0 &&
    (
      !structure.hasCatch ||
      (
        structure.catchExitKinds.length > 0 &&
        exitKindsSatisfyOptions(structure.catchExitKinds, options)
      )
    )
  ) {
    return structure.tryTerminalConditions;
  }

  return [];
}

export function getFlowStatementStructure(
  context: AnalysisContext,
  statement: ts.Statement,
): FlowStatementStructureFact {
  return context.facts.getFlowStatementStructure(
    statement,
    () => parseStatementStructure(context, statement),
  );
}

export function getFlowBranchStructure(
  context: AnalysisContext,
  statement: ts.Statement,
): FlowBranchStructureFact {
  return context.facts.getFlowBranchStructure(
    statement,
    () => createFlowBranchStructure(context, statement),
  );
}

export function getFlowChildRegionStructure(
  context: AnalysisContext,
  statement: ts.Statement,
): FlowChildRegionStructureFact {
  return context.facts.getFlowChildRegionStructure(
    statement,
    () => createFlowChildRegionStructure(context, statement),
  );
}

export function getFlowRegionStructure(
  context: AnalysisContext,
  regionNode: ts.Node,
  statements: readonly ts.Statement[],
  options: StatementAnalysisOptions = {},
): FlowRegionStructureFact {
  return context.facts.getFlowRegionStructure(
    regionNode,
    getStatementOptionsKey(options),
    () => createFlowRegionStructure(context, statements, options),
  );
}

function createFlowBranchStructure(
  context: AnalysisContext,
  statement: ts.Statement,
): FlowBranchStructureFact {
  if (ts.isIfStatement(statement)) {
    const structure = getFlowStatementStructure(context, statement);
    const entries: FlowBranchEntryStructureFact[] = [{
      entryConditions: structure.kind === 'if' ? [structure.condition] : [],
      regionNode: getStatementRegionNode(statement.thenStatement),
      statements: getStatementStatements(statement.thenStatement),
    }];

    if (statement.elseStatement) {
      entries.push({
        entryConditions: structure.kind === 'if' ? [structure.condition] : [],
        regionNode: getStatementRegionNode(statement.elseStatement),
        statements: getStatementStatements(statement.elseStatement),
      });
    }

    return { entries };
  }

  if (
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isForInStatement(statement)
  ) {
    const structure = getFlowStatementStructure(context, statement);
    return {
      entries: [{
        entryConditions: structure.kind === 'loop' && structure.condition
          ? [structure.condition]
          : [],
        regionNode: getStatementRegionNode(statement.statement),
        statements: getStatementStatements(statement.statement),
      }],
    };
  }

  if (ts.isSwitchStatement(statement)) {
    const switchStructure = getFlowStatementStructure(context, statement);
    let defaultEntryConditions: readonly FlowConditionStructureFact[] = [];

    return {
      entries: statement.caseBlock.clauses.map((clause, clauseIndex) => {
        const entryConditions = switchStructure.kind === 'switch' &&
            switchStructure.caseConditions[clauseIndex]
          ? [switchStructure.caseConditions[clauseIndex]]
          : defaultEntryConditions;

        if (switchStructure.kind === 'switch' && switchStructure.isSwitchTrue) {
          if (
            ts.isCaseClause(clause) &&
            exitKindsSatisfyOptions(getStatementsExitKinds(context, clause.statements), {
              treatBreakAsExit: true,
            })
          ) {
            defaultEntryConditions = [
              ...defaultEntryConditions,
              getFallthroughConditionStructure(context, clause.expression),
            ];
          } else {
            defaultEntryConditions = [];
          }
        }

        return {
          entryConditions,
          regionNode: clause,
          statements: clause.statements,
        };
      }),
    };
  }

  return { entries: [] };
}

function createFlowChildRegionStructure(
  context: AnalysisContext,
  statement: ts.Statement,
): FlowChildRegionStructureFact {
  if (ts.isBlock(statement)) {
    return {
      entries: [{
        entryConditions: [],
        regionNode: statement,
        statements: statement.statements,
        treatBreakAsExit: false,
        treatContinueAsExit: false,
      }],
    };
  }

  if (ts.isTryStatement(statement)) {
    const entries: FlowChildRegionStructureEntryFact[] = [{
      entryConditions: [],
      regionNode: statement.tryBlock,
      statements: statement.tryBlock.statements,
      treatBreakAsExit: false,
      treatContinueAsExit: false,
    }];

    if (statement.catchClause) {
      entries.push({
        entryConditions: [],
        regionNode: statement.catchClause.block,
        statements: statement.catchClause.block.statements,
        treatBreakAsExit: false,
        treatContinueAsExit: false,
      });
    }

    if (statement.finallyBlock) {
      entries.push({
        entryConditions: [],
        regionNode: statement.finallyBlock,
        statements: statement.finallyBlock.statements,
        treatBreakAsExit: false,
        treatContinueAsExit: false,
      });
    }

    return { entries };
  }

  if (
    ts.isIfStatement(statement) ||
    ts.isSwitchStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement) ||
    ts.isForStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isForInStatement(statement)
  ) {
    const branchStructure = getFlowBranchStructure(context, statement);
    return {
      entries: branchStructure.entries.map((entry) => ({
        entryConditions: entry.entryConditions,
        regionNode: entry.regionNode,
        statements: entry.statements,
        treatBreakAsExit: ts.isWhileStatement(statement) ||
          ts.isDoStatement(statement) ||
          ts.isForStatement(statement) ||
          ts.isForOfStatement(statement) ||
          ts.isForInStatement(statement),
        treatContinueAsExit: ts.isWhileStatement(statement) ||
          ts.isDoStatement(statement) ||
          ts.isForStatement(statement) ||
          ts.isForOfStatement(statement) ||
          ts.isForInStatement(statement),
      })),
    };
  }

  return { entries: [] };
}

function createFlowRegionStructure(
  context: AnalysisContext,
  statements: readonly ts.Statement[],
  options: StatementAnalysisOptions,
): FlowRegionStructureFact {
  const entries: FlowRegionEntryStructureFact[] = [];
  let sequentialConditions: readonly FlowConditionStructureFact[] = [];

  for (const statement of statements) {
    if (context.isGeneratedNode(statement)) {
      continue;
    }

    entries.push({
      statement,
      sequentialConditions,
    });

    sequentialConditions = [
      ...sequentialConditions,
      ...getSequentialConditionStructures(context, statement, options),
    ];
  }

  return {
    entries,
    terminalConditions: sequentialConditions,
  };
}

function getStatementStatements(statement: ts.Statement): readonly ts.Statement[] {
  return ts.isBlock(statement) ? statement.statements : [statement];
}

function getStatementRegionNode(statement: ts.Statement): ts.Node {
  return statement;
}

function parseStatementStructure(
  context: AnalysisContext,
  statement: ts.Statement,
): FlowStatementStructureFact {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    return { kind: 'other', exitKinds: ['returnThrow'] };
  }

  if (ts.isBreakStatement(statement)) {
    return { kind: 'other', exitKinds: ['break'] };
  }

  if (ts.isContinueStatement(statement)) {
    return { kind: 'other', exitKinds: ['continue'] };
  }

  if (ts.isBlock(statement)) {
    return { kind: 'other', exitKinds: getStatementsExitKinds(context, statement.statements) };
  }

  if (ts.isIfStatement(statement)) {
    const thenExitKinds = getFlowStatementStructure(context, statement.thenStatement).exitKinds;
    const elseExitKinds = statement.elseStatement
      ? getFlowStatementStructure(context, statement.elseStatement).exitKinds
      : [];
    const exitKinds = elseExitKinds.length > 0 ? mergeExitKinds(thenExitKinds, elseExitKinds) : [];

    return {
      kind: 'if',
      condition: getFlowConditionStructure(context, statement.expression),
      thenExitKinds,
      elseExitKinds,
      exitKinds,
    };
  }

  if (
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement) ||
    ts.isForStatement(statement)
  ) {
    const condition = ts.isForStatement(statement) ? statement.condition : statement.expression;
    return {
      kind: 'loop',
      condition: condition ? getFlowConditionStructure(context, condition) : undefined,
      exitKinds: [],
    };
  }

  if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
    return { kind: 'loop', exitKinds: [] };
  }

  if (ts.isSwitchStatement(statement)) {
    return {
      kind: 'switch',
      isSwitchTrue: statement.expression.kind === ts.SyntaxKind.TrueKeyword,
      caseConditions: statement.caseBlock.clauses.map((clause) =>
        getSwitchClauseConditionStructure(context, statement, clause)
      ),
      exitKinds: [],
    };
  }

  if (ts.isTryStatement(statement)) {
    const finallyExitKinds = statement.finallyBlock
      ? getStatementsExitKinds(context, statement.finallyBlock.statements)
      : [];

    return {
      kind: 'try',
      tryTerminalConditions: getFlowRegionStructure(
        context,
        statement.tryBlock,
        statement.tryBlock.statements,
      ).terminalConditions,
      catchExitKinds: statement.catchClause
        ? getStatementsExitKinds(context, statement.catchClause.block.statements)
        : [],
      exitKinds: finallyExitKinds,
      hasCatch: !!statement.catchClause,
    };
  }

  if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
    return {
      kind: 'expressionCall',
      condition: getFlowConditionStructure(context, statement.expression),
      exitKinds: [],
    };
  }

  return { kind: 'other', exitKinds: [] };
}

function mergeExitKinds(
  left: readonly FlowExitKind[],
  right: readonly FlowExitKind[],
): readonly FlowExitKind[] {
  if (left.length === 0 || right.length === 0) {
    return [];
  }

  return [...new Set<FlowExitKind>([...left, ...right])];
}

function exitKindsSatisfyOptions(
  exitKinds: readonly FlowExitKind[],
  options: StatementAnalysisOptions,
): boolean {
  return exitKinds.length > 0 &&
    exitKinds.every((kind) =>
      kind === 'returnThrow' ||
      (kind === 'break' && !!options.treatBreakAsExit) ||
      (kind === 'continue' && !!options.treatContinueAsExit)
    );
}

function getStatementOptionsKey(options: StatementAnalysisOptions): string {
  return `break:${options.treatBreakAsExit ? '1' : '0'}|continue:${
    options.treatContinueAsExit ? '1' : '0'
  }`;
}

function getSwitchClauseConditionStructure(
  context: AnalysisContext,
  statement: ts.SwitchStatement,
  clause: ts.CaseOrDefaultClause,
): FlowConditionStructureFact | undefined {
  if (statement.expression.kind === ts.SyntaxKind.TrueKeyword) {
    return ts.isCaseClause(clause)
      ? getFlowConditionStructure(context, clause.expression)
      : undefined;
  }

  const discriminant = statement.expression;
  const subjectExpression = ts.isTypeOfExpression(discriminant)
    ? discriminant.expression
    : discriminant;

  if (
    (ts.isIdentifier(subjectExpression) ||
      ts.isPropertyAccessExpression(subjectExpression) ||
      ts.isElementAccessExpression(subjectExpression)) &&
    (ts.isDefaultClause(clause) ||
      (ts.isCaseClause(clause) && isSwitchCaseLiteral(clause.expression)))
  ) {
    const kind = ts.isTypeOfExpression(discriminant) ? 'typeof' : 'truthy';
    return {
      kind: 'facts',
      facts: [{
        kind,
        polarity: 'positive',
        sourceNode: clause,
        subjectExpression,
      }],
    };
  }

  return undefined;
}

function parseConditionStructure(
  context: AnalysisContext,
  expression: ts.Expression,
): FlowConditionStructureFact {
  if (ts.isParenthesizedExpression(expression)) {
    return parseConditionStructure(context, expression.expression);
  }

  if (
    ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return invertConditionStructure(parseConditionStructure(context, expression.operand));
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return {
      kind: 'and',
      left: parseConditionStructure(context, expression.left),
      right: parseConditionStructure(context, expression.right),
      rightExpression: expression.right,
    };
  }

  const directFacts = parseDirectConditionFacts(context, expression);
  return directFacts.length > 0 ? { kind: 'facts', facts: directFacts } : { kind: 'none' };
}

function getFallthroughConditionStructure(
  context: AnalysisContext,
  expression: ts.Expression,
): FlowConditionStructureFact {
  if (ts.isParenthesizedExpression(expression)) {
    return getFallthroughConditionStructure(context, expression.expression);
  }

  if (
    ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return invertConditionStructure(getFallthroughConditionStructure(context, expression.operand));
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
  ) {
    return {
      kind: 'and',
      left: getFallthroughConditionStructure(context, expression.left),
      right: getFallthroughConditionStructure(context, expression.right),
      rightExpression: expression.right,
    };
  }

  return getFlowConditionStructure(context, expression);
}

function invertConditionStructure(
  structure: FlowConditionStructureFact,
): FlowConditionStructureFact {
  if (structure.kind === 'none') {
    return structure;
  }

  if (structure.kind === 'and') {
    return {
      kind: 'and',
      left: invertConditionStructure(structure.left),
      right: invertConditionStructure(structure.right),
      rightExpression: structure.rightExpression,
    };
  }

  return {
    kind: 'facts',
    facts: structure.facts.map((fact) => ({
      ...fact,
      polarity: fact.polarity === 'positive' ? 'negative' : 'positive',
    })),
  };
}

function parseDirectConditionFacts(
  context: AnalysisContext,
  expression: ts.Expression,
): readonly FlowConditionSyntaxFact[] {
  if (ts.isCallExpression(expression)) {
    const signature = context.checker.getResolvedSignature(expression);
    const predicate = signature
      ? context.checker.getTypePredicateOfSignature(signature)
      : undefined;
    if (!predicate) {
      return [];
    }

    if (predicate.parameterIndex !== undefined) {
      const argument = expression.arguments[predicate.parameterIndex];
      if (!argument) {
        return [];
      }

      const kind = predicate.kind === ts.TypePredicateKind.AssertsIdentifier
        ? 'assertionCall'
        : 'predicateCall';
      return [{
        kind,
        polarity: 'positive',
        sourceNode: expression,
        subjectExpression: argument,
      }];
    }

    if (
      predicate.kind === ts.TypePredicateKind.AssertsThis ||
      predicate.kind === ts.TypePredicateKind.This
    ) {
      const callee = expression.expression;
      const receiver = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
        ? callee.expression
        : undefined;
      return receiver
        ? [{
          kind: 'assertionCall',
          polarity: 'positive',
          sourceNode: expression,
          subjectExpression: receiver,
        }]
        : [];
    }
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
  ) {
    return [{
      kind: 'instanceof',
      polarity: 'positive',
      sourceNode: expression,
      subjectExpression: expression.left,
    }];
  }

  if (
    ts.isBinaryExpression(expression) &&
    (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken) &&
    (
      (ts.isTypeOfExpression(expression.left) && ts.isStringLiteral(expression.right)) ||
      (ts.isStringLiteral(expression.left) && ts.isTypeOfExpression(expression.right))
    )
  ) {
    return [{
      kind: 'typeof',
      polarity: 'positive',
      sourceNode: expression,
      subjectExpression: ts.isTypeOfExpression(expression.left)
        ? expression.left.expression
        : (expression.right as ts.TypeOfExpression).expression,
    }];
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    (
      (
        (ts.isPropertyAccessExpression(expression.left) ||
          ts.isElementAccessExpression(expression.left) ||
          ts.isIdentifier(expression.left)) &&
        isSwitchCaseLiteral(expression.right)
      ) ||
      (
        (ts.isPropertyAccessExpression(expression.right) ||
          ts.isElementAccessExpression(expression.right) ||
          ts.isIdentifier(expression.right)) &&
        isSwitchCaseLiteral(expression.left)
      )
    )
  ) {
    return [{
      kind: 'discriminantLiteral',
      polarity: 'positive',
      sourceNode: expression,
      subjectExpression: ts.isPropertyAccessExpression(expression.left) ||
          ts.isElementAccessExpression(expression.left) ||
          ts.isIdentifier(expression.left)
        ? expression.left
        : expression.right,
    }];
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    (ts.isStringLiteral(expression.left) || ts.isNumericLiteral(expression.left))
  ) {
    return [{
      kind: 'inProperty',
      polarity: 'positive',
      propertySegment: expression.left.text,
      sourceNode: expression,
      subjectExpression: expression.right,
    }];
  }

  if (
    ts.isBinaryExpression(expression) &&
    (
      expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    )
  ) {
    const leftIsUndefined = ts.isIdentifier(expression.left) &&
      expression.left.text === 'undefined';
    const rightIsUndefined = ts.isIdentifier(expression.right) &&
      expression.right.text === 'undefined';
    const leftIsNull = expression.left.kind === ts.SyntaxKind.NullKeyword;
    const rightIsNull = expression.right.kind === ts.SyntaxKind.NullKeyword;
    const subjectExpression = leftIsUndefined
      ? expression.right
      : rightIsUndefined
      ? expression.left
      : leftIsNull
      ? expression.right
      : rightIsNull
      ? expression.left
      : undefined;
    return subjectExpression
      ? [{
        kind: 'nonNull',
        polarity: 'positive',
        sourceNode: expression,
        subjectExpression,
      }]
      : [];
  }

  if (
    ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return [{
      kind: 'truthy',
      polarity: 'positive',
      sourceNode: expression,
      subjectExpression: expression,
    }];
  }

  return [];
}

function isSwitchCaseLiteral(expression: ts.Expression): boolean {
  return ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword;
}

function getStatementsExitKinds(
  context: AnalysisContext,
  statements: readonly ts.Statement[],
): readonly FlowExitKind[] {
  for (const child of statements) {
    const childStructure = getFlowStatementStructure(context, child);
    if (childStructure.exitKinds.length > 0) {
      return childStructure.exitKinds;
    }
  }

  return [];
}
