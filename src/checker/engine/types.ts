import ts from 'typescript';
import type { AnnotationLookup, ParsedAnnotationArgument } from '../../annotation_syntax.ts';
import type { RuntimeContext } from '../../config.ts';
export type {
  AnnotationLookup,
  ParsedAnnotation,
  ParsedAnnotationBlock,
  ParsedAnnotationComment,
  ParsedAnnotationEntry,
  ParsedAnnotationParseError,
  ParsedTypeScriptPragma,
} from '../../annotation_syntax.ts';

export type AnalysisFactKind =
  | 'symbolProvenance'
  | 'foreignProjection'
  | 'mutability'
  | 'alias'
  | 'effectSummary'
  | 'flowBranchStructure'
  | 'flowChildRegionStructure'
  | 'flowConditionStructure'
  | 'flowInvalidationStructure'
  | 'flowRegionStructure'
  | 'flowStatementStructure'
  | 'namespaceResolver'
  | 'namespaceShape'
  | 'narrowing'
  | 'nonOrdinaryRecovery'
  | 'predicateVerificationTarget'
  | 'unsafeValueOrigin';

export type ProvenanceReason =
  | 'annotated'
  | 'declaration'
  | 'directive'
  | 'imported'
  | 'inferred';

export interface SymbolProvenanceFact {
  symbolId: number;
  trusted: boolean;
  importedFrom?: string;
  reason: ProvenanceReason;
}

export type ForeignProjectionKind = 'namespaceImport' | 'none' | 'projectedUnknown';

export interface ForeignProjectionFact {
  projection: ForeignProjectionKind;
  symbolId: number;
}

export type MutabilityClassification = 'mutable' | 'readonly' | 'unknown';

export interface MutabilityFact {
  nodeId?: number;
  symbolId?: number;
  classification: MutabilityClassification;
  reason: string;
}

export type AliasRelationshipKind = 'destructure' | 'direct' | 'parameter' | 'return' | 'spread';

export interface AliasRelationshipFact {
  sourceId: number;
  targetId: number;
  kind: AliasRelationshipKind;
}

export type EffectKind =
  | 'await'
  | 'callback'
  | 'exception'
  | 'mutation'
  | 'none'
  | 'unknown'
  | 'yield';

export interface EffectSummaryFact {
  nodeId: number;
  kind: EffectKind;
  invalidatesNarrowing: boolean;
  reason: string;
}

export type NarrowingInvalidationReason =
  | 'assignment'
  | 'await'
  | 'call'
  | 'callback'
  | 'exception'
  | 'unknown'
  | 'yield';

export interface NarrowingFact {
  nodeId: number;
  symbolId: number;
  active: boolean;
  reason: NarrowingInvalidationReason;
}

export type UnsafeValueOriginKind = 'moduleNamespace' | 'unsoundImport';

export interface UnsafeValueOriginFact {
  kind: UnsafeValueOriginKind;
  sourceNode: ts.Node;
  stickyAliasable: boolean;
}

export interface NonOrdinaryRecoveryFact {
  family?: ExportedNonOrdinaryFamily;
}

export interface NamespacePropertyPathSegment {
  kind: 'property';
  name: string;
}

export interface NamespaceIndexPathSegment {
  index: number;
  kind: 'index';
}

export type NamespacePathSegment = NamespaceIndexPathSegment | NamespacePropertyPathSegment;

export interface NamespacePathFact {
  guard?: 'fulfilled';
  path: readonly NamespacePathSegment[];
}

export interface NamespaceShapeFact {
  origin: 'dynamicImport' | 'require' | 'resolver' | 'staticImport';
  paths: readonly NamespacePathFact[];
}

export interface NamespaceResolverFact {
  ambiguous: boolean;
  origin: 'dynamicImport' | 'resolver';
  paths: readonly NamespacePathFact[];
}

export type FlowConditionSyntaxFactKind =
  | 'assertionCall'
  | 'discriminantLiteral'
  | 'inProperty'
  | 'instanceof'
  | 'nonNull'
  | 'predicateCall'
  | 'truthy'
  | 'typeof';

export type FlowConditionSyntaxFact =
  | {
    kind:
      | 'assertionCall'
      | 'discriminantLiteral'
      | 'instanceof'
      | 'nonNull'
      | 'predicateCall'
      | 'truthy'
      | 'typeof';
    polarity: 'negative' | 'positive';
    sourceNode: ts.Node;
    subjectExpression: ts.Expression;
  }
  | {
    kind: 'inProperty';
    polarity: 'negative' | 'positive';
    propertySegment: string;
    sourceNode: ts.Node;
    subjectExpression: ts.Expression;
  };

export type FlowConditionStructureFact =
  | {
    kind: 'and';
    left: FlowConditionStructureFact;
    right: FlowConditionStructureFact;
    rightExpression: ts.Expression;
  }
  | {
    kind: 'facts';
    facts: readonly FlowConditionSyntaxFact[];
  }
  | {
    kind: 'none';
  };

export type FlowExitKind = 'break' | 'continue' | 'returnThrow';

export type FlowStatementStructureFact =
  | {
    caseConditions: readonly (FlowConditionStructureFact | undefined)[];
    exitKinds: readonly FlowExitKind[];
    isSwitchTrue: boolean;
    kind: 'switch';
  }
  | {
    condition: FlowConditionStructureFact;
    exitKinds: readonly FlowExitKind[];
    kind: 'expressionCall';
  }
  | {
    condition: FlowConditionStructureFact;
    elseExitKinds: readonly FlowExitKind[];
    exitKinds: readonly FlowExitKind[];
    kind: 'if';
    thenExitKinds: readonly FlowExitKind[];
  }
  | {
    condition?: FlowConditionStructureFact;
    exitKinds: readonly FlowExitKind[];
    kind: 'loop';
  }
  | {
    catchExitKinds: readonly FlowExitKind[];
    exitKinds: readonly FlowExitKind[];
    hasCatch: boolean;
    kind: 'try';
    tryTerminalConditions: readonly FlowConditionStructureFact[];
  }
  | {
    exitKinds: readonly FlowExitKind[];
    kind: 'other';
  };

export interface FlowRegionEntryStructureFact {
  sequentialConditions: readonly FlowConditionStructureFact[];
  statement: ts.Statement;
}

export interface FlowRegionStructureFact {
  entries: readonly FlowRegionEntryStructureFact[];
  terminalConditions: readonly FlowConditionStructureFact[];
}

export interface FlowBranchEntryStructureFact {
  entryConditions: readonly FlowConditionStructureFact[];
  regionNode: ts.Node;
  statements: readonly ts.Statement[];
}

export interface FlowBranchStructureFact {
  entries: readonly FlowBranchEntryStructureFact[];
}

export interface FlowChildRegionStructureEntryFact {
  entryConditions: readonly FlowConditionStructureFact[];
  regionNode: ts.Node;
  statements: readonly ts.Statement[];
  treatBreakAsExit: boolean;
  treatContinueAsExit: boolean;
}

export interface FlowChildRegionStructureFact {
  entries: readonly FlowChildRegionStructureEntryFact[];
}

export type FlowInvalidationCandidateFact =
  | {
    kind: 'access';
    node: ts.ElementAccessExpression | ts.Identifier | ts.PropertyAccessExpression;
  }
  | {
    kind: 'assignment';
    left: ts.Expression;
    node: ts.BinaryExpression;
    right: ts.Expression;
  }
  | {
    kind: 'awaitYield';
    node: ts.AwaitExpression | ts.YieldExpression;
  }
  | {
    kind: 'call';
    node: ts.CallExpression;
  }
  | {
    kind: 'delete';
    expression: ts.Expression;
    node: ts.DeleteExpression;
  }
  | {
    kind: 'functionLike';
    node: ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
  }
  | {
    kind: 'new';
    node: ts.NewExpression;
  }
  | {
    kind: 'shorthandProperty';
    node: ts.ShorthandPropertyAssignment;
  }
  | {
    kind: 'update';
    node: ts.PostfixUnaryExpression | ts.PrefixUnaryExpression;
    operand: ts.Expression;
  };

export interface FlowInvalidationStructureFact {
  candidates: readonly FlowInvalidationCandidateFact[];
}

export type PredicateSupportedTarget =
  | { kind: 'instanceof'; constructorSymbol?: ts.Symbol }
  | { kind: 'nonNullObject' }
  | { kind: 'primitive'; primitive: 'bigint' | 'boolean' | 'number' | 'string' | 'symbol' }
  | { kind: 'unionOfSupported'; options: readonly PredicateSupportedTarget[] };

export type PredicateVerificationTargetFact =
  | {
    kind: 'supported';
    subject: 'parameter';
    target: PredicateSupportedTarget;
  }
  | {
    kind: 'unsupported';
    reason:
      | 'assertsCondition'
      | 'receiverPredicate'
      | 'unsupportedTarget'
      | 'unsupportedParameterName';
    subject: 'parameter' | 'receiver';
  };

export type ExportedNonOrdinaryFamily =
  | 'moduleNamespace'
  | 'nullPrototype';

export interface ExportedNonOrdinaryFact {
  family: ExportedNonOrdinaryFamily;
}

export type ExportSummaryRecoveryPathSegment =
  | { kind: 'index'; index: number }
  | { kind: 'property'; name: string };

export interface ExportValueSummary {
  kind: 'value';
  fact: ExportedNonOrdinaryFact;
}

export interface ExportCallableDirectReturnSummary {
  fact: ExportedNonOrdinaryFact;
  kind: 'callableDirectReturn';
}

export interface ExportCallableReturnedParameterSummary {
  kind: 'callableReturnedParameter';
  parameterIndex: number;
}

export interface ExportCallableHelperWrapperEntry {
  parameterIndex: number;
  recoveryPath: readonly ExportSummaryRecoveryPathSegment[];
}

export interface ExportCallableHelperWrapperSummary {
  entries: readonly ExportCallableHelperWrapperEntry[];
  kind: 'callableHelperWrapper';
}

export type ExportSummary =
  | ExportCallableDirectReturnSummary
  | ExportCallableHelperWrapperSummary
  | ExportCallableReturnedParameterSummary
  | ExportValueSummary;

export type AnalysisFactValue =
  | AliasRelationshipFact
  | EffectSummaryFact
  | ForeignProjectionFact
  | FlowBranchStructureFact
  | FlowChildRegionStructureFact
  | FlowConditionStructureFact
  | FlowInvalidationStructureFact
  | FlowRegionStructureFact
  | FlowStatementStructureFact
  | MutabilityFact
  | NamespaceResolverFact
  | NamespaceShapeFact
  | NonOrdinaryRecoveryFact
  | NarrowingFact
  | PredicateVerificationTargetFact
  | SymbolProvenanceFact
  | UnsafeValueOriginFact;

export interface AnalysisFactQueries {
  getAliasRelationship(
    source: ts.Node | ts.Symbol,
    target: ts.Node | ts.Symbol,
    compute: () => AliasRelationshipFact,
  ): AliasRelationshipFact;
  getEffectSummary(node: ts.Node, compute: () => EffectSummaryFact): EffectSummaryFact;
  getFlowBranchStructure(
    node: ts.Statement,
    compute: () => FlowBranchStructureFact,
  ): FlowBranchStructureFact;
  getFlowChildRegionStructure(
    node: ts.Statement,
    compute: () => FlowChildRegionStructureFact,
  ): FlowChildRegionStructureFact;
  getFlowConditionStructure(
    node: ts.Expression,
    compute: () => FlowConditionStructureFact,
  ): FlowConditionStructureFact;
  getFlowInvalidationStructure(
    node: ts.Node,
    optionsKey: string,
    compute: () => FlowInvalidationStructureFact,
  ): FlowInvalidationStructureFact;
  getFlowStatementStructure(
    node: ts.Statement,
    compute: () => FlowStatementStructureFact,
  ): FlowStatementStructureFact;
  getFlowRegionStructure(
    node: ts.Node,
    optionsKey: string,
    compute: () => FlowRegionStructureFact,
  ): FlowRegionStructureFact;
  getForeignProjection(
    symbol: ts.Symbol,
    compute: () => ForeignProjectionFact,
  ): ForeignProjectionFact;
  getMutability(subject: ts.Node | ts.Symbol, compute: () => MutabilityFact): MutabilityFact;
  getNamespaceResolver(
    node: ts.Node,
    compute: () => NamespaceResolverFact | undefined,
  ): NamespaceResolverFact | undefined;
  getNamespaceShape(
    node: ts.Node,
    compute: () => NamespaceShapeFact | undefined,
  ): NamespaceShapeFact | undefined;
  getNamespaceResolverSymbol(symbol: ts.Symbol): NamespaceResolverFact | undefined;
  getNamespaceShapeSymbol(symbol: ts.Symbol): NamespaceShapeFact | undefined;
  getNarrowing(node: ts.Node, symbol: ts.Symbol, compute: () => NarrowingFact): NarrowingFact;
  getNonOrdinaryRecovery(
    node: ts.Node,
    family: ExportedNonOrdinaryFamily,
    compute: () => NonOrdinaryRecoveryFact,
  ): NonOrdinaryRecoveryFact;
  getPredicateVerificationTarget(
    node: ts.Node,
    compute: () => PredicateVerificationTargetFact | undefined,
  ): PredicateVerificationTargetFact | undefined;
  getUnsafeValueOrigin(symbol: ts.Symbol): UnsafeValueOriginFact | undefined;
  setForeignProjection(symbol: ts.Symbol, fact: ForeignProjectionFact): ForeignProjectionFact;
  setNamespaceResolverSymbol(symbol: ts.Symbol, fact: NamespaceResolverFact): NamespaceResolverFact;
  setNamespaceShapeSymbol(symbol: ts.Symbol, fact: NamespaceShapeFact): NamespaceShapeFact;
  setSymbolProvenance(symbol: ts.Symbol, fact: SymbolProvenanceFact): SymbolProvenanceFact;
  setUnsafeValueOrigin(symbol: ts.Symbol, fact: UnsafeValueOriginFact): UnsafeValueOriginFact;
  getSymbolProvenance(symbol: ts.Symbol, compute: () => SymbolProvenanceFact): SymbolProvenanceFact;
}

export interface ExportSummaryQueries {
  canonicalizeSymbol(symbol: ts.Symbol): ts.Symbol;
  get(symbol: ts.Symbol): ExportSummary | undefined;
  set(symbol: ts.Symbol, summary: ExportSummary): ExportSummary;
}

export interface AnalysisContext {
  readonly checker: ts.TypeChecker;
  readonly exportSummaries: ExportSummaryQueries;
  readonly facts: AnalysisFactQueries;
  isGeneratedNode(node: ts.Node): boolean;
  readonly program: ts.Program;
  readonly runtime: RuntimeContext;
  readonly workingDirectory: string;
  forEachSourceFile(visitor: (sourceFile: ts.SourceFile) => void): void;
  getAnnotationLookup(sourceFile: ts.SourceFile): AnnotationLookup;
  getNodeId(node: ts.Node): number;
  getSourceFiles(): readonly ts.SourceFile[];
  getSymbolId(symbol: ts.Symbol): number;
  traverse(node: ts.Node, visitor: (node: ts.Node) => void): void;
}

export interface CreateAnalysisContextOptions {
  isGeneratedNode?: (node: ts.Node) => boolean;
  includeSourceFile?: (sourceFile: ts.SourceFile) => boolean;
  program: ts.Program;
  runtime?: RuntimeContext;
  workingDirectory: string;
}
