import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import {
  getNodeDiagnosticRange,
  type DiagnosticRelatedInformation,
  type SoundDiagnostic,
} from '../diagnostics.ts';
import {
  type FlowFact,
  getFlowChildRegionStructure,
  getFlowRegionStructure,
  materializeConditionStructures,
  type StatementAnalysisOptions,
} from './flow_facts.ts';
import {
  type AnalysisState,
  cloneState,
  FLOW_FACT_ENVIRONMENT,
  isFunctionLikeWithBody,
  type NormalizedPath,
  prepareChildRegionState,
  recordExecutedExpressionAliases,
  recordVariableAliases,
  statementAffectsNarrow,
} from './flow_invalidation.ts';
import { isConstLocalBindingPath } from './flow_shared.ts';
import { isInsideSyntheticErrorNormalizationHelper } from './generated_helpers.ts';

type InvalidationBoundaryKind =
  | 'alias_or_escape'
  | 'call'
  | 'callback'
  | 'mutation'
  | 'suspension';

interface InvalidationDiagnosticContext {
  boundaryKind: InvalidationBoundaryKind;
  fact?: FlowFact<NormalizedPath>;
  node: ts.Node;
}

function boundaryKindLabel(kind: InvalidationBoundaryKind): string {
  switch (kind) {
    case 'alias_or_escape':
      return 'alias or escape';
    case 'call':
      return 'call';
    case 'callback':
      return 'callback';
    case 'mutation':
      return 'mutation';
    case 'suspension':
      return 'suspension';
  }
}

function classifyBoundaryKind(node: ts.Node): InvalidationBoundaryKind {
  if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
    return 'suspension';
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    return 'call';
  }
  if (
    ts.isDeleteExpression(node) ||
    ts.isPrefixUnaryExpression(node) ||
    ts.isPostfixUnaryExpression(node) ||
    (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
  ) {
    return 'mutation';
  }
  return 'alias_or_escape';
}

function formatPathSegment(segment: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
    return `.${segment}`;
  }
  if (/^\d+$/.test(segment)) {
    return `[${segment}]`;
  }
  return `[${JSON.stringify(segment)}]`;
}

function formatNormalizedPath(
  context: AnalysisContext,
  path: NormalizedPath,
): string {
  return `${context.checker.symbolToString(path.baseSymbol)}${path.segments.map(formatPathSegment).join('')}`;
}

function formatNodeText(node: ts.Node): string {
  return node.getText(node.getSourceFile()).trim();
}

function createRelatedInformation(
  node: ts.Node,
  message: string,
): DiagnosticRelatedInformation {
  return {
    message,
    ...getNodeDiagnosticRange(node),
  };
}

function invalidationCapturedValueExpression(
  narrowedValue: string | undefined,
): string {
  return narrowedValue ?? 'box.value';
}

function invalidationRewriteExample(
  kind: InvalidationBoundaryKind,
  narrowedValue: string | undefined,
  invalidatingBoundary: string,
): string {
  const capturedValue = invalidationCapturedValueExpression(narrowedValue);
  switch (kind) {
    case 'alias_or_escape':
      return `Capture before the escape when stable: \`const capturedValue = ${capturedValue}; ${invalidatingBoundary}; use(capturedValue);\`, or re-check after the escape.`;
    case 'call':
      return `Capture before the call when stable: \`const capturedValue = ${capturedValue}; ${invalidatingBoundary}; use(capturedValue);\`, or re-check after the call.`;
    case 'callback':
      return `Capture before the callback boundary: \`const capturedValue = ${capturedValue}; ${invalidatingBoundary};\`, or re-check inside the callback before using the original path.`;
    case 'mutation':
      return `Capture before the write when stable: \`const capturedValue = ${capturedValue}; ${invalidatingBoundary}; use(capturedValue);\`, or re-check after the mutation.`;
    case 'suspension':
      return `Capture before await when stable: \`const capturedValue = ${capturedValue}; ${invalidatingBoundary}; use(capturedValue);\`, or re-check after await.`;
  }
}

function invalidationRewriteHint(
  kind: InvalidationBoundaryKind,
): string {
  switch (kind) {
    case 'alias_or_escape':
      return 'Capture a stable primitive or immutable snapshot into a fresh local before the alias or escape boundary, or re-check the value after the boundary.';
    case 'call':
      return 'Capture a stable primitive or immutable snapshot into a fresh local before the call boundary, or re-check the value after the call.';
    case 'callback':
      return 'Capture a stable primitive or immutable snapshot before the callback boundary, or re-check the value inside the callback before using the original path.';
    case 'mutation':
      return 'Capture a stable primitive or immutable snapshot before the mutation, or re-check the value after the write.';
    case 'suspension':
      return 'Capture a stable primitive or immutable snapshot into a fresh local before await, or re-check the value after await.';
  }
}

function createDiagnostic(
  context: AnalysisContext,
  invalidation: InvalidationDiagnosticContext,
): SoundDiagnostic {
  const boundaryKind = boundaryKindLabel(invalidation.boundaryKind);
  const narrowedValue = invalidation.fact
    ? formatNormalizedPath(context, invalidation.fact.path)
    : undefined;
  const invalidatingBoundary = formatNodeText(invalidation.node);
  const example = invalidationRewriteExample(
    invalidation.boundaryKind,
    narrowedValue,
    invalidatingBoundary,
  );
  const earlierProof = invalidation.fact
    ? formatNodeText(invalidation.fact.sourceNode)
    : undefined;
  const hint = invalidationRewriteHint(invalidation.boundaryKind);
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.unsoundFlowNarrowing,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.unsoundFlowNarrowing,
    metadata: {
      rule: 'flow_narrowing_invalidation',
      primarySymbol: narrowedValue,
      secondarySymbol: invalidation.boundaryKind,
      fixability: 'local_rewrite',
      invariant:
        'Narrowing facts cannot cross aliasing, mutation, callback escape, or suspension boundaries that may change the value before use.',
      replacementFamily: 'recheck_after_boundary',
      evidence: [
        ...(narrowedValue ? [{ label: 'narrowedValue', value: narrowedValue }] : []),
        { label: 'boundaryKind', value: invalidation.boundaryKind },
        { label: 'invalidatingBoundary', value: invalidatingBoundary },
        ...(earlierProof ? [{ label: 'earlierProof', value: earlierProof }] : []),
      ],
      counterexample:
        'A boundary between the check and later use could change the value before the narrowed use runs.',
      example,
    },
    notes: [
      narrowedValue
        ? `The earlier check for \`${narrowedValue}\` was invalidated by this ${boundaryKind} boundary.`
        : 'A call, mutation, callback, alias, or suspension point can change the value after the earlier check.',
      ...(earlierProof ? [`Earlier proof: \`${earlierProof}\`.`] : []),
      hint,
      `Example: ${example}`,
    ],
    hint,
    relatedInformation: invalidation.fact
      ? [createRelatedInformation(invalidation.fact.sourceNode, 'Earlier narrowing established here.')]
      : undefined,
    ...getNodeDiagnosticRange(invalidation.node),
  };
}

function findInvalidation(
  context: AnalysisContext,
  statement: ts.Statement,
  activeFacts: readonly FlowFact<NormalizedPath>[],
  state: AnalysisState,
): InvalidationDiagnosticContext | undefined {
  for (const fact of activeFacts) {
    const invalidatingNode = statementAffectsNarrow(context, statement, fact.path, state);
    if (invalidatingNode) {
      return {
        node: invalidatingNode,
        fact,
        boundaryKind: classifyBoundaryKind(invalidatingNode),
      };
    }
  }

  return undefined;
}

function factRequiresBoundaryInvalidation(
  fact: FlowFact<NormalizedPath>,
): boolean {
  if (fact.path.segments.length !== 0 || !isConstLocalBindingPath(fact.path)) {
    return true;
  }

  return fact.kind !== 'discriminantLiteral' &&
    fact.kind !== 'nonNull' &&
    fact.kind !== 'truthy' &&
    fact.kind !== 'typeof';
}

function analyzeStatements(
  context: AnalysisContext,
  regionNode: ts.Node | undefined,
  statements: readonly ts.Statement[],
  state: AnalysisState,
  diagnostics: SoundDiagnostic[],
  inheritedFacts: readonly FlowFact<NormalizedPath>[] = [],
  options: StatementAnalysisOptions = {},
): void {
  const region = regionNode ? getFlowRegionStructure(context, regionNode, statements, options) : {
    entries: statements.map((statement) => ({
      statement,
      sequentialConditions: [],
    })),
  };

  for (const entry of region.entries) {
    const statement = entry.statement;
    if (context.isGeneratedNode(statement)) {
      continue;
    }

    const sequentialAnalysis = materializeConditionStructures(
      context,
      entry.sequentialConditions,
      state,
      FLOW_FACT_ENVIRONMENT,
    );
    if (sequentialAnalysis.invalidatingNode) {
      diagnostics.push(
        createDiagnostic(context, {
          node: sequentialAnalysis.invalidatingNode,
          fact: sequentialAnalysis.invalidatedFact,
          boundaryKind: classifyBoundaryKind(sequentialAnalysis.invalidatingNode),
        }),
      );
    }
    const activeSequentialFacts = [...inheritedFacts, ...sequentialAnalysis.facts]
      .filter(factRequiresBoundaryInvalidation);
    const invalidatingNode = findInvalidation(context, statement, activeSequentialFacts, state);
    if (invalidatingNode) {
      diagnostics.push(createDiagnostic(context, invalidatingNode));
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        recordVariableAliases(context, declaration, state);
      }
    } else if (ts.isExpressionStatement(statement)) {
      recordExecutedExpressionAliases(context, statement.expression, state);
    }

    const branchState = prepareChildRegionState(context, statement, state);
    const childRegions = getFlowChildRegionStructure(context, statement).entries;
    for (const childRegion of childRegions) {
      const conditionAnalysis = materializeConditionStructures(
        context,
        childRegion.entryConditions,
        branchState,
        FLOW_FACT_ENVIRONMENT,
      );
      if (conditionAnalysis.invalidatingNode) {
        diagnostics.push(
          createDiagnostic(context, {
            node: conditionAnalysis.invalidatingNode,
            fact: conditionAnalysis.invalidatedFact,
            boundaryKind: classifyBoundaryKind(conditionAnalysis.invalidatingNode),
          }),
        );
      }

      analyzeStatements(
        context,
        childRegion.regionNode,
        childRegion.statements,
        cloneState(branchState),
        diagnostics,
        [...activeSequentialFacts, ...conditionAnalysis.facts],
        {
          treatBreakAsExit: childRegion.treatBreakAsExit || options.treatBreakAsExit,
          treatContinueAsExit: childRegion.treatContinueAsExit || options.treatContinueAsExit,
        },
      );
    }
  }
}

function getRootStatements(body: ts.FunctionBody | ts.ConciseBody): readonly ts.Statement[] {
  if (ts.isBlock(body)) {
    return body.statements;
  }

  return [ts.factory.createExpressionStatement(body)];
}

function createInitialState(): AnalysisState {
  return {
    aliases: new Map(),
    arrayRestAliases: new Map(),
    boundValues: new Map(),
    extractedBindings: new Map(),
    objectRestAliases: new Map(),
    spreadAliases: new Map(),
  };
}

function analyzeRootRegion(
  context: AnalysisContext,
  regionNode: ts.Node | undefined,
  statements: readonly ts.Statement[],
  diagnostics: SoundDiagnostic[],
): void {
  analyzeStatements(
    context,
    regionNode,
    statements,
    createInitialState(),
    diagnostics,
  );
}

export function runFlowRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    const rootStatements = sourceFile.statements.filter((statement) => !context.isGeneratedNode(statement));
    analyzeRootRegion(
      context,
      sourceFile,
      rootStatements,
      diagnostics,
    );

    context.traverse(sourceFile, (node) => {
      if (!isFunctionLikeWithBody(node)) {
        return;
      }
      if (isInsideSyntheticErrorNormalizationHelper(node)) {
        return;
      }

      const bodyStatements = getRootStatements(node.body).filter((statement) => !context.isGeneratedNode(statement));
      analyzeRootRegion(
        context,
        ts.isBlock(node.body) ? node.body : undefined,
        bodyStatements,
        diagnostics,
      );
    });
  });

  return diagnostics;
}
