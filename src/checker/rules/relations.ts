import ts from 'typescript';

import type { ParsedAnnotationArgument } from '../../annotation_syntax.ts';
import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext, ExportedNonOrdinaryFamily, ExportSummary } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';
import {
  collectExportedSymbolsBySourceFile,
  getKnownRecoveredNonOrdinaryFamily,
  populateDirectExportValueSummaries,
  populateFunctionLikeNonOrdinarySummaries,
} from './non_ordinary_recovery.ts';
import { isCheckerTimingEnabled, logCheckerTiming } from '../timing.ts';

interface PropertyVarianceInfo {
  readType: ts.Type;
  setterBacked: boolean;
  writeType?: ts.Type;
  writeTypeNode?: ts.TypeNode;
}

interface PropertySurface {
  declarations: readonly ts.Declaration[];
  location: ts.Node;
  methodOnly: boolean;
  property: ts.Symbol;
  readonly: boolean;
}

interface TupleShape {
  fixedLength: number;
  hasRestElement: boolean;
  prefixTypes: readonly ts.Type[];
  restType?: ts.Type;
  suffixTypes: readonly ts.Type[];
}

type RelationDiagnosticKind =
  | 'callableParameterVariance'
  | 'exoticObjectWidening'
  | 'genericClassExactMatchVariance'
  | 'genericTypeVariance'
  | 'invalidVarianceAnnotation'
  | 'mutableArrayVariance'
  | 'mutableMapVariance'
  | 'mutableSetVariance'
  | 'mutableTupleVariance'
  | 'nominalClassRelation'
  | 'nominalNewtypeRelation'
  | 'varianceAnnotationMismatch'
  | 'writableIndexSignatureVariance'
  | 'writablePropertyVariance';

interface RelationDiagnosticDetails {
  code: SoundDiagnostic['code'];
  metadata?: SoundDiagnostic['metadata'];
  message: string;
  notes?: string[];
  hint?: string;
}

interface VarianceAnnotationDiagnosticDetails {
  code:
    | typeof SOUND_DIAGNOSTIC_CODES.invalidVarianceAnnotation
    | typeof SOUND_DIAGNOSTIC_CODES.varianceAnnotationMismatch;
  metadata?: SoundDiagnostic['metadata'];
  message: string;
  notes?: readonly string[];
  hint?: string;
}

interface RelationMismatch {
  kind: RelationDiagnosticKind;
  metadata?: SoundDiagnostic['metadata'];
  message: string;
  notes?: string[];
  hint?: string;
}

interface GenericClassIdentity {
  symbol: ts.Symbol;
  typeArguments: readonly ts.Type[];
}

interface NewtypeIdentity {
  symbol: ts.Symbol;
  typeArguments: readonly ts.Type[];
}

const populatedNullPrototypeExportSummaries = new WeakSet<AnalysisContext>();

interface TargetClassIdentitySet {
  identities: readonly GenericClassIdentity[];
  mode: 'intersection' | 'single' | 'union';
}

interface TargetNewtypeIdentitySet {
  identities: readonly NewtypeIdentity[];
  mode: 'intersection' | 'single' | 'union';
}

type CanonicalResultClassFamily = 'option' | 'result';

type NominalIdentityLike = { symbol: ts.Symbol; typeArguments: readonly ts.Type[] };
type NominalIdentitySet<TIdentity extends NominalIdentityLike> = {
  identities: readonly TIdentity[];
  mode: 'intersection' | 'single' | 'union';
};

type GenericVariance = 'covariant' | 'contravariant' | 'independent' | 'invariant';

interface GenericRelationTypeInfo {
  kind: 'alias' | 'reference';
  name: string;
  symbol: ts.Symbol;
  typeArguments: readonly ts.Type[];
}

type VarianceAnnotationKeyword = 'in' | 'independent' | 'inout' | 'out';

interface RecursiveGenericRelationResult {
  handled: boolean;
  mismatch?: RelationMismatch;
}

interface ParsedVarianceAnnotationEntry {
  parameterName: string;
  variance: GenericVariance;
}

interface GenericVarianceMismatchDetails {
  parameterName: string;
  typeName: string;
  variance: Exclude<GenericVariance, 'independent'>;
  sourceTypeArgument: ts.Type;
  targetTypeArgument: ts.Type;
}

interface GenericVarianceInferenceContext {
  parameterIndicesBySymbolId: Map<number, number>;
  parameterNames: readonly string[];
  stack: Set<number>;
  variances: GenericVariance[];
}

interface GenericAliasVariancePolicy {
  hasVarianceAnnotation: boolean;
  isImportedDeclarationAlias: boolean;
  typeParameters: readonly ts.TypeParameterDeclaration[];
  variances: readonly GenericVariance[];
  varianceAnnotationDetails?: VarianceAnnotationDiagnosticDetails;
}

interface NormalizedRelationMemberSurface {
  numberIndexTypeNode?: ts.TypeNode;
  propertyMemberTypeNodes: ReadonlyMap<string, ts.TypeNode | ts.MethodSignature>;
  propertyTypeNodes: ReadonlyMap<string, ts.TypeNode>;
  stringIndexTypeNode?: ts.TypeNode;
}

type RelationCallableSignatureDeclaration =
  | ts.CallSignatureDeclaration
  | ts.ConstructSignatureDeclaration
  | ts.FunctionTypeNode
  | ts.ConstructorTypeNode;

interface ResolvedSignatureTypeNodes {
  declaration: RelationCallableSignatureDeclaration;
  parameterTypeNodes: readonly (ts.TypeNode | undefined)[];
  predicateTypeNode?: ts.TypeNode;
  returnTypeNode?: ts.TypeNode;
}

interface NormalizedRelationCallableSurface {
  callSignatures: readonly ResolvedSignatureTypeNodes[];
  constructSignatures: readonly ResolvedSignatureTypeNodes[];
}

type CallableSignatureKind = ts.SignatureKind.Call | ts.SignatureKind.Construct;
type InferUtilityWrapperName =
  | 'ReturnType'
  | 'Parameters'
  | 'ConstructorParameters'
  | 'ThisParameterType'
  | 'OmitThisParameter';
type TransparentRelationWrapperName = 'NoInfer';
const PROJECTED_NEWTYPE_BRAND_NAME_PATTERN = /^__soundscript_newtype_[0-9a-f]+_brand$/;

interface ResolvedInferUtilityWrapperRelation {
  utilityName: InferUtilityWrapperName;
  sourceWrappedType: ts.Type;
  targetWrappedType: ts.Type;
  sourceSignature: ts.Signature;
  targetSignature: ts.Signature;
}

const READONLY_CHECK_FLAG = (
  ts as typeof ts & { CheckFlags?: { Readonly?: number } }
).CheckFlags?.Readonly ?? 8;
const VARIANCE_POLARITY_COVARIANT = 1;
const VARIANCE_POLARITY_CONTRAVARIANT = 2;
const VARIANCE_POLARITY_INVARIANT = 3;
// Keep this list narrow. Regex match arrays intentionally do not belong here:
// only their nested `groups` objects ride the BareObject/null-prototype path.
const MODELED_EXOTIC_OBJECT_TYPE_NAMES = new Set([
  'BigInt64Array',
  'BigUint64Array',
  'DataView',
  'Float32Array',
  'Float64Array',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
]);

function createNullPrototypeObjectWideningMismatch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch {
  return {
    kind: 'exoticObjectWidening',
    message: "Null-prototype values are not assignable to 'object' in soundscript.",
    metadata: {
      rule: 'null_prototype_object_widening',
      fixability: 'local_rewrite',
      invariant:
        'Plain `object` assumes Object.prototype members that null-prototype values intentionally do not have.',
      replacementFamily: 'bare_object_or_exact_nonordinary_type',
      evidence: [
        createVarianceEvidence('sourceType', context.checker.typeToString(sourceType)),
        createVarianceEvidence('targetType', context.checker.typeToString(targetType)),
      ],
      counterexample:
        "Code typed as 'object' can rely on Object.prototype members, but a null-prototype value intentionally omits them.",
      example:
        'Keep the value as `BareObject` or the precise null-prototype helper result instead of widening it to `object`.',
    },
    notes: [
      "'object' assumes Object.prototype members, but this value is known to have a null prototype.",
    ],
    hint:
      "Keep the current null-prototype type, or use 'BareObject' when you intentionally want a null-prototype value.",
  };
}

function createModeledBuiltinExoticObjectWideningMismatch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch {
  return {
    kind: 'exoticObjectWidening',
    message: "Typed arrays and DataView are not assignable to 'object' in soundscript.",
    metadata: {
      rule: 'modeled_exotic_object_widening',
      fixability: 'local_rewrite',
      invariant:
        "Plain `object` erases the explicit typed-array or DataView family that soundscript tracks as non-ordinary.",
      replacementFamily: 'exact_nonordinary_type',
      evidence: [
        createVarianceEvidence('sourceType', context.checker.typeToString(sourceType)),
        createVarianceEvidence('targetType', context.checker.typeToString(targetType)),
      ],
      counterexample:
        "Code typed as 'object' cannot tell that the value still carries typed-array or DataView semantics.",
      example:
        'Keep the precise typed-array or `DataView` type instead of widening it to `object`.',
    },
    notes: [
      "'object' erases the explicit non-ordinary builtin family carried by this value.",
    ],
    hint: "Keep the specific builtin container type instead of widening it to 'object'.",
  };
}

function createVarianceEvidence(
  label: string,
  value: string,
): { label: string; value: string } {
  return { label, value };
}

function createCallableParameterVarianceMismatch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch {
  const sourceTypeText = context.checker.typeToString(sourceType);
  const targetTypeText = context.checker.typeToString(targetType);
  return {
    kind: 'callableParameterVariance',
    message: 'Callable parameter types are contravariant in soundscript.',
    metadata: {
      rule: 'callable_parameter_variance',
      fixability: 'local_rewrite',
      invariant: 'Callable parameter positions are contravariant.',
      replacementFamily: 'adapter_or_parameter_widening',
      evidence: [
        createVarianceEvidence('sourceType', sourceTypeText),
        createVarianceEvidence('targetType', targetTypeText),
        createVarianceEvidence('requiredRelation', `${targetTypeText} -> ${sourceTypeText}`),
      ],
      counterexample:
        `Calls through '${targetTypeText}' could supply arguments that '${sourceTypeText}' does not accept.`,
    },
    notes: [
      `'${sourceTypeText}' cannot be widened to '${targetTypeText}' because calls through the target could pass values the source callable does not accept.`,
      `Counterexample: code typed as '${targetTypeText}' could invoke the callable with parameters outside the accepted domain of '${sourceTypeText}'.`,
    ],
    hint:
      'Keep the exact callable type, widen parameter types, or wrap the callable with an adapter.',
  };
}

function createDiagnostic(node: ts.Node, details?: RelationDiagnosticDetails): SoundDiagnostic {
  return {
    source: 'sound',
    code: details?.code ?? SOUND_DIAGNOSTIC_CODES.unsoundRelation,
    category: 'error',
    message: details?.message ?? SOUND_DIAGNOSTIC_MESSAGES.unsoundRelation,
    metadata: details?.metadata,
    notes: details?.notes,
    hint: details?.hint,
    ...getNodeDiagnosticRange(node),
  };
}

function createVarianceAnnotationDiagnostic(
  node: ts.Node,
  code:
    | typeof SOUND_DIAGNOSTIC_CODES.invalidVarianceAnnotation
    | typeof SOUND_DIAGNOSTIC_CODES.varianceAnnotationMismatch,
  message: string,
  notes?: readonly string[],
  hint?: string,
  metadata?: SoundDiagnostic['metadata'],
): SoundDiagnostic {
  return {
    source: 'sound',
    code,
    category: 'error',
    message,
    metadata,
    notes: notes ? [...notes] : undefined,
    hint,
    ...getNodeDiagnosticRange(node),
  };
}

function getSymbolCheckFlags(symbol: ts.Symbol): number | undefined {
  return (symbol as ts.Symbol & { checkFlags?: number; links?: { checkFlags?: number } }).links
    ?.checkFlags ??
    (symbol as ts.Symbol & { checkFlags?: number }).checkFlags;
}

function hasReadonlyModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ??
      false);
}

function hasStaticModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ??
      false);
}

function isMappedPropertySymbol(symbol: ts.Symbol): boolean {
  return ((symbol as ts.Symbol & { links?: { mappedType?: ts.Type } }).links?.mappedType) !==
    undefined;
}

function isReadonlyPropertySymbol(symbol: ts.Symbol): boolean {
  const checkFlags = getSymbolCheckFlags(symbol);
  return typeof checkFlags === 'number' && (checkFlags & READONLY_CHECK_FLAG) !== 0;
}

function getSignatureParameterType(
  context: AnalysisContext,
  signature: ts.Signature,
  parameter: ts.Symbol,
): ts.Type {
  const declaration = parameter.valueDeclaration ??
    signature.getDeclaration() ??
    parameter.getDeclarations()?.[0];
  return context.checker.getTypeOfSymbolAtLocation(parameter, declaration);
}

function getSignatureThisParameter(signature: ts.Signature): ts.Symbol | undefined {
  return (signature as ts.Signature & { thisParameter?: ts.Symbol }).thisParameter;
}

function getSignatureThisParameterType(
  context: AnalysisContext,
  signature: ts.Signature,
): ts.Type | undefined {
  const thisParameter = getSignatureThisParameter(signature);
  if (!thisParameter) {
    return undefined;
  }

  const declaration = thisParameter.valueDeclaration ?? signature.getDeclaration();
  if (!declaration) {
    return undefined;
  }

  return context.checker.getTypeOfSymbolAtLocation(thisParameter, declaration);
}

function getRequiredParameterCount(signature: ts.Signature): number {
  return (signature as ts.Signature & { minArgumentCount?: number }).minArgumentCount ??
    signature.getParameters().length;
}

function getSignatureParameterTypeNode(
  signature: ts.Signature,
  parameter: ts.Symbol,
): ts.TypeNode | undefined {
  const declaration = (() => {
    if (parameter.valueDeclaration && ts.isParameter(parameter.valueDeclaration)) {
      return parameter.valueDeclaration;
    }

    const signatureDeclaration = signature.getDeclaration();
    if (!signatureDeclaration || !('parameters' in signatureDeclaration)) {
      return undefined;
    }

    const parameterIndex = signature.getParameters().findIndex((candidate) =>
      candidate === parameter
    );
    const candidate = parameterIndex >= 0
      ? signatureDeclaration.parameters[parameterIndex]
      : undefined;
    return candidate && ts.isParameter(candidate) ? candidate : undefined;
  })();
  return declaration && ts.isParameter(declaration) ? declaration.type : undefined;
}

function getSignatureThisParameterTypeNode(
  signature: ts.Signature,
): ts.TypeNode | undefined {
  const signatureDeclaration = signature.getDeclaration();
  if (!signatureDeclaration || !('parameters' in signatureDeclaration)) {
    return undefined;
  }

  const firstParameter = signatureDeclaration.parameters[0];
  if (!firstParameter || !ts.isParameter(firstParameter)) {
    return undefined;
  }

  return ts.isIdentifier(firstParameter.name) && firstParameter.name.text === 'this'
    ? firstParameter.type
    : undefined;
}

function getSignatureReturnTypeNode(signature: ts.Signature): ts.TypeNode | undefined {
  return signature.getDeclaration()?.type;
}

function getSignatureTypePredicateNode(
  signature: ts.Signature,
): ts.TypePredicateNode | undefined {
  const typeNode = signature.getDeclaration()?.type;
  return typeNode && ts.isTypePredicateNode(typeNode) ? typeNode : undefined;
}

function getSignatureParameterIndex(
  signature: ts.Signature,
  parameter: ts.Symbol,
): number {
  return signature.getParameters().findIndex((candidate) => candidate === parameter);
}

function getResolvedSignatureTypeNodesFromOwnerType(
  context: AnalysisContext,
  ownerType: ts.Type,
  signature: ts.Signature,
): ResolvedSignatureTypeNodes | undefined {
  const declaration = signature.getDeclaration();
  if (
    !declaration ||
    (
      !ts.isCallSignatureDeclaration(declaration) &&
      !ts.isConstructSignatureDeclaration(declaration) &&
      !ts.isFunctionTypeNode(declaration) &&
      !ts.isConstructorTypeNode(declaration)
    )
  ) {
    return undefined;
  }

  const callableSurface = getOrdinaryRelationTypeCallableSurface(context, ownerType);
  if (!callableSurface) {
    return undefined;
  }

  return callableSurface.callSignatures.find((entry) => entry.declaration === declaration) ??
    callableSurface.constructSignatures.find((entry) => entry.declaration === declaration);
}

function getSignatureGenericOwnerDeclaration(
  signature: ts.Signature,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined {
  let current: ts.Node | undefined = signature.getDeclaration()?.parent;
  while (current) {
    if (ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function getSignatureTypeParameterSubstitutions(
  context: AnalysisContext,
  ownerType: ts.Type,
  signature: ts.Signature,
): ReadonlyMap<number, ts.TypeNode> | undefined {
  const ownerDeclaration = getSignatureGenericOwnerDeclaration(signature);
  if (!ownerDeclaration || (ownerDeclaration.typeParameters?.length ?? 0) === 0) {
    return new Map();
  }

  const ownerSymbol = context.checker.getSymbolAtLocation(ownerDeclaration.name);
  if (!ownerSymbol) {
    return undefined;
  }

  const normalizedOwnerType = getSafeNonNullableRelationType(context, ownerType);
  const directInfo = getGenericRelationTypeInfo(context, normalizedOwnerType);
  const instantiatedOwnerType = directInfo?.symbol === ownerSymbol
    ? normalizedOwnerType
    : getMatchingBaseType(context, normalizedOwnerType, ownerSymbol);
  if (!instantiatedOwnerType) {
    return undefined;
  }

  const instantiatedOwnerInfo = getGenericRelationTypeInfo(context, instantiatedOwnerType);
  if (
    !instantiatedOwnerInfo ||
    instantiatedOwnerInfo.symbol !== ownerSymbol ||
    instantiatedOwnerInfo.typeArguments.length !== ownerDeclaration.typeParameters!.length
  ) {
    return undefined;
  }

  const substitutions = new Map<number, ts.TypeNode>();
  for (const [index, typeParameter] of ownerDeclaration.typeParameters!.entries()) {
    const parameterSymbol = context.checker.getSymbolAtLocation(typeParameter.name);
    const typeArgumentNode = getSynthesizedRelationTypeNode(
      context,
      instantiatedOwnerInfo.typeArguments[index],
    );
    if (!parameterSymbol || !typeArgumentNode) {
      return undefined;
    }
    substitutions.set(context.getSymbolId(parameterSymbol), typeArgumentNode);
  }

  return substitutions;
}

function getResolvedSignatureParameterTypeNode(
  context: AnalysisContext,
  ownerType: ts.Type,
  signature: ts.Signature,
  parameter: ts.Symbol,
  parameterType: ts.Type,
): ts.TypeNode | undefined {
  const resolvedSignatureTypeNodes = getResolvedSignatureTypeNodesFromOwnerType(
    context,
    ownerType,
    signature,
  );
  const parameterIndex = getSignatureParameterIndex(signature, parameter);
  const resolvedParameterTypeNode = parameterIndex >= 0
    ? resolvedSignatureTypeNodes?.parameterTypeNodes[parameterIndex]
    : undefined;
  if (resolvedParameterTypeNode) {
    return resolvedParameterTypeNode;
  }

  const typeNode = getSignatureParameterTypeNode(signature, parameter);
  if (typeNode && !typeNodeContainsTypeParameterReference(context, typeNode)) {
    return typeNode;
  }

  if (typeNode) {
    const substitutions = getSignatureTypeParameterSubstitutions(context, ownerType, signature);
    if (substitutions) {
      return substituteTypeParameterTypeNodes(context, typeNode, substitutions);
    }
  }

  return getSynthesizedRelationTypeNode(context, parameterType);
}

function getResolvedSignatureReturnTypeNode(
  context: AnalysisContext,
  ownerType: ts.Type,
  signature: ts.Signature,
  returnType: ts.Type,
): ts.TypeNode | undefined {
  const resolvedReturnTypeNode = getResolvedSignatureTypeNodesFromOwnerType(
    context,
    ownerType,
    signature,
  )?.returnTypeNode;
  if (resolvedReturnTypeNode) {
    return resolvedReturnTypeNode;
  }

  const typeNode = getSignatureReturnTypeNode(signature);
  if (typeNode && !typeNodeContainsTypeParameterReference(context, typeNode)) {
    return typeNode;
  }

  if (typeNode) {
    const substitutions = getSignatureTypeParameterSubstitutions(context, ownerType, signature);
    if (substitutions) {
      return substituteTypeParameterTypeNodes(context, typeNode, substitutions);
    }
  }

  return getSynthesizedRelationTypeNode(context, returnType);
}

function getResolvedSignatureThisParameterTypeNode(
  context: AnalysisContext,
  ownerType: ts.Type,
  signature: ts.Signature,
  thisParameterType: ts.Type,
): ts.TypeNode | undefined {
  const resolvedThisParameterTypeNode = getResolvedSignatureTypeNodesFromOwnerType(
    context,
    ownerType,
    signature,
  )?.parameterTypeNodes[0];
  if (resolvedThisParameterTypeNode && getSignatureThisParameter(signature)) {
    return resolvedThisParameterTypeNode;
  }

  const typeNode = getSignatureThisParameterTypeNode(signature);
  if (typeNode && !typeNodeContainsTypeParameterReference(context, typeNode)) {
    return typeNode;
  }

  if (typeNode) {
    const substitutions = getSignatureTypeParameterSubstitutions(context, ownerType, signature);
    if (substitutions) {
      return substituteTypeParameterTypeNodes(context, typeNode, substitutions);
    }
  }

  return getSynthesizedRelationTypeNode(context, thisParameterType);
}

function getResolvedSignaturePredicateTypeNode(
  context: AnalysisContext,
  ownerType: ts.Type,
  signature: ts.Signature,
  predicate: ts.TypePredicate,
): ts.TypeNode | undefined {
  const resolvedPredicateTypeNode = getResolvedSignatureTypeNodesFromOwnerType(
    context,
    ownerType,
    signature,
  )?.predicateTypeNode;
  if (resolvedPredicateTypeNode) {
    return resolvedPredicateTypeNode;
  }

  const typeNode = getSignatureTypePredicateNode(signature)?.type;
  if (typeNode && !typeNodeContainsTypeParameterReference(context, typeNode)) {
    return typeNode;
  }

  if (typeNode) {
    const substitutions = getSignatureTypeParameterSubstitutions(context, ownerType, signature);
    if (substitutions) {
      return substituteTypeParameterTypeNodes(context, typeNode, substitutions);
    }
  }

  return getSynthesizedRelationTypeNode(context, predicate.type);
}

function doSignaturePredicatesTargetSameSubject(
  sourcePredicate: ts.TypePredicate,
  targetPredicate: ts.TypePredicate,
): boolean {
  const sourceIsThisPredicate = sourcePredicate.kind === ts.TypePredicateKind.This ||
    sourcePredicate.kind === ts.TypePredicateKind.AssertsThis;
  const targetIsThisPredicate = targetPredicate.kind === ts.TypePredicateKind.This ||
    targetPredicate.kind === ts.TypePredicateKind.AssertsThis;
  if (sourceIsThisPredicate || targetIsThisPredicate) {
    return sourceIsThisPredicate && targetIsThisPredicate;
  }

  return sourcePredicate.parameterIndex !== undefined &&
    sourcePredicate.parameterIndex === targetPredicate.parameterIndex;
}

function classifyUnsoundSignaturePredicateRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  sourceSignature: ts.Signature,
  targetSignature: ts.Signature,
  visitedPairs: Set<string>,
): RelationMismatch | undefined {
  const sourcePredicate = context.checker.getTypePredicateOfSignature(sourceSignature);
  const targetPredicate = context.checker.getTypePredicateOfSignature(targetSignature);
  if (
    !sourcePredicate ||
    !targetPredicate ||
    !sourcePredicate.type ||
    !targetPredicate.type ||
    !doSignaturePredicatesTargetSameSubject(sourcePredicate, targetPredicate)
  ) {
    return undefined;
  }

  const predicateMismatch = classifyUnsoundRelation(
    context,
    sourcePredicate.type,
    targetPredicate.type,
    undefined,
    visitedPairs,
  );
  if (predicateMismatch) {
    return predicateMismatch;
  }

  return classifyUnsoundTypeNodeGenericAliasRelation(
    context,
    sourcePredicate.type,
    targetPredicate.type,
    getResolvedSignaturePredicateTypeNode(
      context,
      targetType,
      targetSignature,
      targetPredicate,
    ),
    undefined,
    getResolvedSignaturePredicateTypeNode(
      context,
      sourceType,
      sourceSignature,
      sourcePredicate,
    ),
  );
}

function getRelationTypePairKey(
  context: AnalysisContext,
  relationFamily: 'callable' | 'generic' | 'property' | 'relation',
  sourceType: ts.Type,
  targetType: ts.Type,
): string {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);
  const sourceTypeId = (normalizedSourceType as ts.Type & { id?: number }).id ??
    context.checker.typeToString(normalizedSourceType);
  const targetTypeId = (normalizedTargetType as ts.Type & { id?: number }).id ??
    context.checker.typeToString(normalizedTargetType);
  return `${relationFamily}:${sourceTypeId}->${targetTypeId}`;
}

const relationTypeNodeVisitIds = new WeakMap<ts.Node, number>();
let nextRelationTypeNodeVisitId = 1;

function getRelationTypeNodeVisitId(node: ts.Node | undefined): string {
  if (!node) {
    return 'none';
  }

  if (isSynthesizedRelationNode(node)) {
    return `synth:${node.kind}`;
  }

  let visitId = relationTypeNodeVisitIds.get(node);
  if (visitId === undefined) {
    visitId = nextRelationTypeNodeVisitId++;
    relationTypeNodeVisitIds.set(node, visitId);
  }

  return String(visitId);
}

function getTypeNodeGenericAliasVisitKey(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetTypeNode: ts.TypeNode | undefined,
  sourceTypeNode: ts.TypeNode | undefined,
): string {
  return `${getRelationTypePairKey(context, 'generic', sourceType, targetType)}:` +
    `${getRelationTypeNodeVisitId(targetTypeNode)}:${getRelationTypeNodeVisitId(sourceTypeNode)}`;
}

type AlphaEquivalentTypeParameterMapping = {
  sourceToTarget: Map<number, number>;
  targetToSource: Map<number, number>;
};

function cloneAlphaEquivalentTypeParameterMapping(
  mapping: AlphaEquivalentTypeParameterMapping,
): AlphaEquivalentTypeParameterMapping {
  return {
    sourceToTarget: new Map(mapping.sourceToTarget),
    targetToSource: new Map(mapping.targetToSource),
  };
}

function getSignatureTypeParameterDeclarations(
  signature: ts.Signature,
): readonly ts.TypeParameterDeclaration[] {
  return getCallSignatureTypeParameters(signature.getDeclaration())
    .filter(ts.isTypeParameterDeclaration);
}

function hasSignatureLocalTypeParameters(signature: ts.Signature): boolean {
  const declaration = signature.getDeclaration();
  return declaration !== undefined &&
    'typeParameters' in declaration &&
    (declaration.typeParameters?.length ?? 0) > 0;
}

function getTypeParameterDeclarationSymbol(
  context: AnalysisContext,
  declaration: ts.TypeParameterDeclaration,
): ts.Symbol | undefined {
  return context.checker.getSymbolAtLocation(declaration.name);
}

function getTypeParameterReferenceSymbol(
  context: AnalysisContext,
  node: ts.TypeNode | undefined,
): ts.Symbol | undefined {
  const unwrappedNode = unwrapRelationTypeNode(node);
  if (!unwrappedNode || !isRelationReferenceTypeNode(unwrappedNode)) {
    return undefined;
  }

  const symbol = getRelationReferenceTypeNodeSymbol(context, unwrappedNode);
  return symbol && (symbol.flags & ts.SymbolFlags.TypeParameter) !== 0 ? symbol : undefined;
}

function areTypeParameterReferenceNodesAlphaEquivalent(
  context: AnalysisContext,
  sourceNode: ts.TypeNode,
  targetNode: ts.TypeNode,
  mapping: AlphaEquivalentTypeParameterMapping,
): boolean {
  const sourceSymbol = getTypeParameterReferenceSymbol(context, sourceNode);
  const targetSymbol = getTypeParameterReferenceSymbol(context, targetNode);
  if (!sourceSymbol || !targetSymbol) {
    return false;
  }

  const sourceSymbolId = context.getSymbolId(sourceSymbol);
  const targetSymbolId = context.getSymbolId(targetSymbol);
  return mapping.sourceToTarget.get(sourceSymbolId) === targetSymbolId &&
    mapping.targetToSource.get(targetSymbolId) === sourceSymbolId;
}

function getAlphaEquivalentPropertyName(
  name: ts.PropertyName | ts.BindingName | ts.DeclarationName | undefined,
): string | undefined {
  if (!name) {
    return undefined;
  }

  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
    return name.expression.text;
  }

  return undefined;
}

function extendAlphaEquivalentTypeParameterMapping(
  context: AnalysisContext,
  sourceParameters: readonly ts.TypeParameterDeclaration[],
  targetParameters: readonly ts.TypeParameterDeclaration[],
  parentMapping: AlphaEquivalentTypeParameterMapping,
): AlphaEquivalentTypeParameterMapping | undefined {
  if (sourceParameters.length !== targetParameters.length) {
    return undefined;
  }

  const mapping = cloneAlphaEquivalentTypeParameterMapping(parentMapping);
  for (const [index, sourceParameter] of sourceParameters.entries()) {
    const targetParameter = targetParameters[index];
    if (!targetParameter) {
      return undefined;
    }

    const sourceSymbol = getTypeParameterDeclarationSymbol(context, sourceParameter);
    const targetSymbol = getTypeParameterDeclarationSymbol(context, targetParameter);
    if (!sourceSymbol || !targetSymbol) {
      return undefined;
    }

    mapping.sourceToTarget.set(
      context.getSymbolId(sourceSymbol),
      context.getSymbolId(targetSymbol),
    );
    mapping.targetToSource.set(
      context.getSymbolId(targetSymbol),
      context.getSymbolId(sourceSymbol),
    );
  }

  for (const [index, sourceParameter] of sourceParameters.entries()) {
    const targetParameter = targetParameters[index];
    if (!targetParameter) {
      return undefined;
    }

    if (
      !areAlphaEquivalentOptionalTypeNodes(
        context,
        sourceParameter.constraint,
        targetParameter.constraint,
        mapping,
      ) ||
      !areAlphaEquivalentOptionalTypeNodes(
        context,
        sourceParameter.default,
        targetParameter.default,
        mapping,
      )
    ) {
      return undefined;
    }
  }

  return mapping;
}

function areAlphaEquivalentOptionalTypeNodes(
  context: AnalysisContext,
  sourceNode: ts.TypeNode | undefined,
  targetNode: ts.TypeNode | undefined,
  mapping: AlphaEquivalentTypeParameterMapping,
): boolean {
  if (!sourceNode || !targetNode) {
    return sourceNode === targetNode;
  }

  return areAlphaEquivalentTypeNodes(context, sourceNode, targetNode, mapping);
}

function areAlphaEquivalentTypeNodeLists(
  context: AnalysisContext,
  sourceNodes: readonly ts.TypeNode[],
  targetNodes: readonly ts.TypeNode[],
  mapping: AlphaEquivalentTypeParameterMapping,
): boolean {
  if (sourceNodes.length !== targetNodes.length) {
    return false;
  }

  return sourceNodes.every((sourceNode, index) =>
    areAlphaEquivalentTypeNodes(context, sourceNode, targetNodes[index]!, mapping)
  );
}

function areAlphaEquivalentParameterDeclarations(
  context: AnalysisContext,
  sourceParameters: readonly ts.ParameterDeclaration[],
  targetParameters: readonly ts.ParameterDeclaration[],
  mapping: AlphaEquivalentTypeParameterMapping,
): boolean {
  if (sourceParameters.length !== targetParameters.length) {
    return false;
  }

  for (const [index, sourceParameter] of sourceParameters.entries()) {
    const targetParameter = targetParameters[index];
    if (!targetParameter) {
      return false;
    }

    if (
      !!sourceParameter.dotDotDotToken !== !!targetParameter.dotDotDotToken ||
      !!sourceParameter.questionToken !== !!targetParameter.questionToken
    ) {
      return false;
    }

    if (
      getAlphaEquivalentPropertyName(sourceParameter.name) !==
        getAlphaEquivalentPropertyName(targetParameter.name)
    ) {
      return false;
    }

    if (
      !areAlphaEquivalentOptionalTypeNodes(
        context,
        sourceParameter.type,
        targetParameter.type,
        mapping,
      )
    ) {
      return false;
    }
  }

  return true;
}

function areAlphaEquivalentSignatureLikeTypeNodes(
  context: AnalysisContext,
  sourceNode:
    | ts.CallSignatureDeclaration
    | ts.ConstructSignatureDeclaration
    | ts.FunctionTypeNode
    | ts.ConstructorTypeNode
    | ts.MethodSignature
    | ts.MethodDeclaration,
  targetNode:
    | ts.CallSignatureDeclaration
    | ts.ConstructSignatureDeclaration
    | ts.FunctionTypeNode
    | ts.ConstructorTypeNode
    | ts.MethodSignature
    | ts.MethodDeclaration,
  parentMapping: AlphaEquivalentTypeParameterMapping,
): boolean {
  const sourceTypeParameters = 'typeParameters' in sourceNode
    ? sourceNode.typeParameters ?? []
    : [];
  const targetTypeParameters = 'typeParameters' in targetNode
    ? targetNode.typeParameters ?? []
    : [];
  const mapping = extendAlphaEquivalentTypeParameterMapping(
    context,
    sourceTypeParameters,
    targetTypeParameters,
    parentMapping,
  );
  if (!mapping) {
    return false;
  }

  return areAlphaEquivalentParameterDeclarations(
    context,
    sourceNode.parameters,
    targetNode.parameters,
    mapping,
  ) &&
    areAlphaEquivalentOptionalTypeNodes(
      context,
      sourceNode.type,
      targetNode.type,
      mapping,
    );
}

function getAlphaEquivalentSignatureLikeTypeNode(
  typeNode: ts.Node | undefined,
):
  | ts.CallSignatureDeclaration
  | ts.ConstructSignatureDeclaration
  | ts.FunctionTypeNode
  | ts.ConstructorTypeNode
  | ts.MethodSignature
  | ts.MethodDeclaration
  | undefined {
  const unwrappedTypeNode =
    typeNode && !ts.isMethodSignature(typeNode) && !ts.isMethodDeclaration(typeNode)
      ? unwrapRelationTypeNode(typeNode as ts.TypeNode)
      : typeNode;
  if (
    unwrappedTypeNode &&
    (
      ts.isCallSignatureDeclaration(unwrappedTypeNode) ||
      ts.isConstructSignatureDeclaration(unwrappedTypeNode) ||
      ts.isFunctionTypeNode(unwrappedTypeNode) ||
      ts.isConstructorTypeNode(unwrappedTypeNode) ||
      ts.isMethodSignature(unwrappedTypeNode) ||
      ts.isMethodDeclaration(unwrappedTypeNode)
    )
  ) {
    return unwrappedTypeNode;
  }

  return undefined;
}

function areAlphaEquivalentTypeLiteralMembers(
  context: AnalysisContext,
  sourceMembers: readonly ts.TypeElement[],
  targetMembers: readonly ts.TypeElement[],
  mapping: AlphaEquivalentTypeParameterMapping,
): boolean {
  if (sourceMembers.length !== targetMembers.length) {
    return false;
  }

  for (const [index, sourceMember] of sourceMembers.entries()) {
    const targetMember = targetMembers[index];
    if (!targetMember || sourceMember.kind !== targetMember.kind) {
      return false;
    }

    if (
      ts.isPropertySignature(sourceMember) &&
      ts.isPropertySignature(targetMember)
    ) {
      if (
        getAlphaEquivalentPropertyName(sourceMember.name) !==
          getAlphaEquivalentPropertyName(targetMember.name) ||
        !!sourceMember.questionToken !== !!targetMember.questionToken ||
        hasReadonlyModifier(sourceMember) !== hasReadonlyModifier(targetMember) ||
        !areAlphaEquivalentOptionalTypeNodes(context, sourceMember.type, targetMember.type, mapping)
      ) {
        return false;
      }
      continue;
    }

    if (
      ts.isMethodSignature(sourceMember) &&
      ts.isMethodSignature(targetMember)
    ) {
      if (
        getAlphaEquivalentPropertyName(sourceMember.name) !==
          getAlphaEquivalentPropertyName(targetMember.name) ||
        !!sourceMember.questionToken !== !!targetMember.questionToken ||
        !areAlphaEquivalentSignatureLikeTypeNodes(context, sourceMember, targetMember, mapping)
      ) {
        return false;
      }
      continue;
    }

    if (
      ts.isCallSignatureDeclaration(sourceMember) &&
      ts.isCallSignatureDeclaration(targetMember)
    ) {
      if (!areAlphaEquivalentSignatureLikeTypeNodes(context, sourceMember, targetMember, mapping)) {
        return false;
      }
      continue;
    }

    if (
      ts.isConstructSignatureDeclaration(sourceMember) &&
      ts.isConstructSignatureDeclaration(targetMember)
    ) {
      if (!areAlphaEquivalentSignatureLikeTypeNodes(context, sourceMember, targetMember, mapping)) {
        return false;
      }
      continue;
    }

    if (
      ts.isIndexSignatureDeclaration(sourceMember) &&
      ts.isIndexSignatureDeclaration(targetMember)
    ) {
      if (
        hasReadonlyModifier(sourceMember) !== hasReadonlyModifier(targetMember) ||
        !areAlphaEquivalentParameterDeclarations(
          context,
          sourceMember.parameters,
          targetMember.parameters,
          mapping,
        ) ||
        !areAlphaEquivalentOptionalTypeNodes(context, sourceMember.type, targetMember.type, mapping)
      ) {
        return false;
      }
      continue;
    }

    return false;
  }

  return true;
}

function areAlphaEquivalentTypeNodes(
  context: AnalysisContext,
  sourceNode: ts.TypeNode,
  targetNode: ts.TypeNode,
  mapping: AlphaEquivalentTypeParameterMapping,
): boolean {
  const source = unwrapRelationTypeNode(sourceNode);
  const target = unwrapRelationTypeNode(targetNode);
  if (!source || !target) {
    return source === target;
  }

  if (areTypeParameterReferenceNodesAlphaEquivalent(context, source, target, mapping)) {
    return true;
  }

  if (source.kind !== target.kind) {
    return false;
  }

  if (ts.isTypeReferenceNode(source) && ts.isTypeReferenceNode(target)) {
    const sourceSymbol = getRelationReferenceTypeNodeSymbol(context, source);
    const targetSymbol = getRelationReferenceTypeNodeSymbol(context, target);
    if (sourceSymbol !== targetSymbol) {
      return false;
    }
    return areAlphaEquivalentTypeNodeLists(
      context,
      source.typeArguments ?? [],
      target.typeArguments ?? [],
      mapping,
    );
  }

  if (ts.isImportTypeNode(source) && ts.isImportTypeNode(target)) {
    if (source.isTypeOf !== target.isTypeOf) {
      return false;
    }
    const sourceSymbol = getRelationReferenceTypeNodeSymbol(context, source);
    const targetSymbol = getRelationReferenceTypeNodeSymbol(context, target);
    if (sourceSymbol !== targetSymbol) {
      return false;
    }
    return areAlphaEquivalentTypeNodeLists(
      context,
      source.typeArguments ?? [],
      target.typeArguments ?? [],
      mapping,
    );
  }

  if (ts.isArrayTypeNode(source) && ts.isArrayTypeNode(target)) {
    return areAlphaEquivalentTypeNodes(context, source.elementType, target.elementType, mapping);
  }

  if (ts.isTupleTypeNode(source) && ts.isTupleTypeNode(target)) {
    return areAlphaEquivalentTypeNodeLists(context, source.elements, target.elements, mapping);
  }

  if (ts.isUnionTypeNode(source) && ts.isUnionTypeNode(target)) {
    return areAlphaEquivalentTypeNodeLists(context, source.types, target.types, mapping);
  }

  if (ts.isIntersectionTypeNode(source) && ts.isIntersectionTypeNode(target)) {
    return areAlphaEquivalentTypeNodeLists(context, source.types, target.types, mapping);
  }

  if (ts.isTypeOperatorNode(source) && ts.isTypeOperatorNode(target)) {
    return source.operator === target.operator &&
      areAlphaEquivalentTypeNodes(context, source.type, target.type, mapping);
  }

  if (ts.isIndexedAccessTypeNode(source) && ts.isIndexedAccessTypeNode(target)) {
    return areAlphaEquivalentTypeNodes(context, source.objectType, target.objectType, mapping) &&
      areAlphaEquivalentTypeNodes(context, source.indexType, target.indexType, mapping);
  }

  if (ts.isConditionalTypeNode(source) && ts.isConditionalTypeNode(target)) {
    return areAlphaEquivalentTypeNodes(context, source.checkType, target.checkType, mapping) &&
      areAlphaEquivalentTypeNodes(context, source.extendsType, target.extendsType, mapping) &&
      areAlphaEquivalentTypeNodes(context, source.trueType, target.trueType, mapping) &&
      areAlphaEquivalentTypeNodes(context, source.falseType, target.falseType, mapping);
  }

  if (ts.isParenthesizedTypeNode(source) && ts.isParenthesizedTypeNode(target)) {
    return areAlphaEquivalentTypeNodes(context, source.type, target.type, mapping);
  }

  if (ts.isLiteralTypeNode(source) && ts.isLiteralTypeNode(target)) {
    if (source.literal.kind !== target.literal.kind) {
      return false;
    }
    if (
      (ts.isStringLiteral(source.literal) || ts.isNumericLiteral(source.literal)) &&
      (ts.isStringLiteral(target.literal) || ts.isNumericLiteral(target.literal))
    ) {
      return source.literal.text === target.literal.text;
    }
    return true;
  }

  if (ts.isFunctionTypeNode(source) && ts.isFunctionTypeNode(target)) {
    return areAlphaEquivalentSignatureLikeTypeNodes(context, source, target, mapping);
  }

  if (ts.isConstructorTypeNode(source) && ts.isConstructorTypeNode(target)) {
    return areAlphaEquivalentSignatureLikeTypeNodes(context, source, target, mapping);
  }

  if (ts.isTypeLiteralNode(source) && ts.isTypeLiteralNode(target)) {
    return areAlphaEquivalentTypeLiteralMembers(context, source.members, target.members, mapping);
  }

  if (ts.isTypePredicateNode(source) && ts.isTypePredicateNode(target)) {
    return source.kind === target.kind &&
      areAlphaEquivalentOptionalTypeNodes(context, source.type, target.type, mapping);
  }

  if (ts.isThisTypeNode(source) && ts.isThisTypeNode(target)) {
    return true;
  }

  switch (source.kind) {
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.BigIntKeyword:
    case ts.SyntaxKind.BooleanKeyword:
    case ts.SyntaxKind.NeverKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.ObjectKeyword:
    case ts.SyntaxKind.StringKeyword:
    case ts.SyntaxKind.SymbolKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.VoidKeyword:
      return true;
    default:
      return false;
  }
}

function areAlphaEquivalentSignatures(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  sourceSignature: ts.Signature,
  targetSignature: ts.Signature,
): boolean {
  if (
    getRequiredParameterCount(sourceSignature) !== getRequiredParameterCount(targetSignature) ||
    sourceSignature.getParameters().length !== targetSignature.getParameters().length
  ) {
    return false;
  }

  const sourceTypeParameters = getSignatureTypeParameterDeclarations(sourceSignature);
  const targetTypeParameters = getSignatureTypeParameterDeclarations(targetSignature);
  const mapping = extendAlphaEquivalentTypeParameterMapping(
    context,
    sourceTypeParameters,
    targetTypeParameters,
    { sourceToTarget: new Map(), targetToSource: new Map() },
  );
  if (!mapping) {
    return false;
  }

  const sourceThisType = getSignatureThisParameterType(context, sourceSignature);
  const targetThisType = getSignatureThisParameterType(context, targetSignature);
  if (!!sourceThisType !== !!targetThisType) {
    return false;
  }
  if (sourceThisType && targetThisType) {
    const sourceThisTypeNode = getResolvedSignatureThisParameterTypeNode(
      context,
      sourceType,
      sourceSignature,
      sourceThisType,
    );
    const targetThisTypeNode = getResolvedSignatureThisParameterTypeNode(
      context,
      targetType,
      targetSignature,
      targetThisType,
    );
    if (
      !sourceThisTypeNode ||
      !targetThisTypeNode ||
      !areAlphaEquivalentTypeNodes(context, sourceThisTypeNode, targetThisTypeNode, mapping)
    ) {
      return false;
    }
  }

  const sourceParameters = sourceSignature.getParameters();
  const targetParameters = targetSignature.getParameters();
  for (const [index, sourceParameter] of sourceParameters.entries()) {
    const targetParameter = targetParameters[index];
    if (!targetParameter) {
      return false;
    }

    const sourceParameterType = getSignatureParameterType(
      context,
      sourceSignature,
      sourceParameter,
    );
    const targetParameterType = getSignatureParameterType(
      context,
      targetSignature,
      targetParameter,
    );
    const sourceParameterTypeNode = getResolvedSignatureParameterTypeNode(
      context,
      sourceType,
      sourceSignature,
      sourceParameter,
      sourceParameterType,
    );
    const targetParameterTypeNode = getResolvedSignatureParameterTypeNode(
      context,
      targetType,
      targetSignature,
      targetParameter,
      targetParameterType,
    );
    if (
      !sourceParameterTypeNode ||
      !targetParameterTypeNode ||
      !areAlphaEquivalentTypeNodes(
        context,
        sourceParameterTypeNode,
        targetParameterTypeNode,
        mapping,
      )
    ) {
      return false;
    }
  }

  const sourceReturnType = context.checker.getReturnTypeOfSignature(sourceSignature);
  const targetReturnType = context.checker.getReturnTypeOfSignature(targetSignature);
  const sourceReturnTypeNode = getResolvedSignatureReturnTypeNode(
    context,
    sourceType,
    sourceSignature,
    sourceReturnType,
  );
  const targetReturnTypeNode = getResolvedSignatureReturnTypeNode(
    context,
    targetType,
    targetSignature,
    targetReturnType,
  );
  if (
    !sourceReturnTypeNode ||
    !targetReturnTypeNode ||
    !areAlphaEquivalentTypeNodes(context, sourceReturnTypeNode, targetReturnTypeNode, mapping)
  ) {
    return false;
  }

  return true;
}

function haveExactInstantiatedSignatureTypes(
  context: AnalysisContext,
  sourceSignature: ts.Signature,
  targetSignature: ts.Signature,
): boolean {
  const sourceThisType = getSignatureThisParameterType(context, sourceSignature);
  const targetThisType = getSignatureThisParameterType(context, targetSignature);
  if (!!sourceThisType !== !!targetThisType) {
    return false;
  }
  if (
    sourceThisType &&
    targetThisType &&
    !areExactTypeArguments(context, sourceThisType, targetThisType)
  ) {
    return false;
  }

  const sourceParameters = sourceSignature.getParameters();
  const targetParameters = targetSignature.getParameters();
  if (sourceParameters.length !== targetParameters.length) {
    return false;
  }

  for (const [index, sourceParameter] of sourceParameters.entries()) {
    const targetParameter = targetParameters[index];
    if (!targetParameter) {
      return false;
    }

    const sourceParameterType = getSignatureParameterType(
      context,
      sourceSignature,
      sourceParameter,
    );
    const targetParameterType = getSignatureParameterType(
      context,
      targetSignature,
      targetParameter,
    );
    if (!areExactTypeArguments(context, sourceParameterType, targetParameterType)) {
      return false;
    }
  }

  const sourceReturnType = context.checker.getReturnTypeOfSignature(sourceSignature);
  const targetReturnType = context.checker.getReturnTypeOfSignature(targetSignature);
  if (!areExactTypeArguments(context, sourceReturnType, targetReturnType)) {
    return false;
  }

  const sourcePredicate = context.checker.getTypePredicateOfSignature(sourceSignature);
  const targetPredicate = context.checker.getTypePredicateOfSignature(targetSignature);
  if (!!sourcePredicate !== !!targetPredicate) {
    return false;
  }
  if (
    sourcePredicate &&
    targetPredicate &&
    (
      sourcePredicate.kind !== targetPredicate.kind ||
      !doSignaturePredicatesTargetSameSubject(sourcePredicate, targetPredicate) ||
      (sourcePredicate.type !== undefined) !== (targetPredicate.type !== undefined) ||
      (
        sourcePredicate.type &&
        targetPredicate.type &&
        !areExactTypeArguments(context, sourcePredicate.type, targetPredicate.type)
      )
    )
  ) {
    return false;
  }

  return true;
}

function signatureTypeNodesContainDeclaredNewtypeIdentity(
  context: AnalysisContext,
  ownerType: ts.Type,
  signature: ts.Signature,
): boolean {
  const thisParameterType = getSignatureThisParameterType(context, signature);
  if (
    thisParameterType &&
    typeNodeContainsExpandedCarrierNewtypeIdentity(
      context,
      getResolvedSignatureThisParameterTypeNode(
        context,
        ownerType,
        signature,
        thisParameterType,
      ),
    )
  ) {
    return true;
  }

  for (const parameter of signature.getParameters()) {
    const parameterType = getSignatureParameterType(context, signature, parameter);
    if (
      typeNodeContainsExpandedCarrierNewtypeIdentity(
        context,
        getResolvedSignatureParameterTypeNode(
          context,
          ownerType,
          signature,
          parameter,
          parameterType,
        ),
      )
    ) {
      return true;
    }
  }

  const returnType = context.checker.getReturnTypeOfSignature(signature);
  if (
    typeNodeContainsExpandedCarrierNewtypeIdentity(
      context,
      getResolvedSignatureReturnTypeNode(context, ownerType, signature, returnType),
    )
  ) {
    return true;
  }

  return typeNodeContainsExpandedCarrierNewtypeIdentity(
    context,
    getSignatureTypePredicateNode(signature),
  );
}

function isHigherOrderType(context: AnalysisContext, type: ts.Type): boolean {
  return context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
}

function classifyUnsoundSignatureRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  sourceSignature: ts.Signature,
  targetSignature: ts.Signature,
  relationSite: ts.Node | undefined,
  visitedPairs: Set<string>,
): RelationMismatch | undefined {
  const timingEnabled = relationSite ? isCheckerTimingEnabled() : false;
  const signatureMetadata = timingEnabled
    ? {
      sourceType: context.checker.typeToString(sourceType),
      targetType: context.checker.typeToString(targetType),
    }
    : undefined;

  if (
    measureRelationExpressionPhase(
      timingEnabled,
      'signature.haveExactInstantiatedSignatureTypes',
      relationSite ?? sourceSignature.getDeclaration() ?? targetSignature.getDeclaration()!,
      signatureMetadata ?? {},
      () => haveExactInstantiatedSignatureTypes(context, sourceSignature, targetSignature),
    )
  ) {
    if (
      !signatureTypeNodesContainDeclaredNewtypeIdentity(context, sourceType, sourceSignature) &&
      !signatureTypeNodesContainDeclaredNewtypeIdentity(context, targetType, targetSignature)
    ) {
      return undefined;
    }
  }

  const alphaEquivalent = measureRelationExpressionPhase(
    timingEnabled,
    'signature.areAlphaEquivalentSignatures',
    relationSite ?? sourceSignature.getDeclaration() ?? targetSignature.getDeclaration()!,
    signatureMetadata ?? {},
    () =>
      areAlphaEquivalentSignatures(
        context,
        sourceType,
        targetType,
        sourceSignature,
        targetSignature,
      ),
  );
  if (
    alphaEquivalent &&
    (
      hasSignatureLocalTypeParameters(sourceSignature) ||
      hasSignatureLocalTypeParameters(targetSignature)
    )
  ) {
    return undefined;
  }

  const sourceParameters = sourceSignature.getParameters();
  const targetParameters = targetSignature.getParameters();
  const sourceRequiredParameterCount = getRequiredParameterCount(sourceSignature);
  const targetRequiredParameterCount = getRequiredParameterCount(targetSignature);

  if (sourceRequiredParameterCount > targetRequiredParameterCount) {
    return createCallableParameterVarianceMismatch(context, sourceType, targetType);
  }

  const sharedParameterCount = Math.min(sourceParameters.length, targetParameters.length);
  for (let index = 0; index < sharedParameterCount; index += 1) {
    const sourceParameter = sourceParameters[index];
    const targetParameter = targetParameters[index];
    if (!sourceParameter || !targetParameter) {
      return createCallableParameterVarianceMismatch(context, sourceType, targetType);
    }

    const sourceParameterType = getSignatureParameterType(
      context,
      sourceSignature,
      sourceParameter,
    );
    const targetParameterType = getSignatureParameterType(
      context,
      targetSignature,
      targetParameter,
    );
    const sourceParameterTypeNode = getResolvedSignatureParameterTypeNode(
      context,
      sourceType,
      sourceSignature,
      sourceParameter,
      sourceParameterType,
    );
    const targetParameterTypeNode = getResolvedSignatureParameterTypeNode(
      context,
      targetType,
      targetSignature,
      targetParameter,
      targetParameterType,
    );
    if (
      !measureRelationExpressionPhase(
        timingEnabled,
        'signature.parameterAssignable',
        relationSite ?? sourceSignature.getDeclaration() ?? targetSignature.getDeclaration()!,
        {
          ...(signatureMetadata ?? {}),
          parameterIndex: index,
        },
        () => context.checker.isTypeAssignableTo(targetParameterType, sourceParameterType),
      )
    ) {
      const preferParameterTypeNodeGenericRelation = shouldPreferTypeNodeGenericRelation(
        context,
        targetParameterType,
        sourceParameterTypeNode,
        undefined,
        targetParameterTypeNode,
      );
      if (preferParameterTypeNodeGenericRelation) {
        const parameterTypeNodeAliasMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
          context,
          targetParameterType,
          sourceParameterType,
          sourceParameterTypeNode,
          undefined,
          targetParameterTypeNode,
        );
        if (!parameterTypeNodeAliasMismatch) {
          continue;
        }
        return parameterTypeNodeAliasMismatch;
      }
      if (
        isHigherOrderType(context, sourceParameterType) &&
        isHigherOrderType(context, targetParameterType)
      ) {
        continue;
      }
      return createCallableParameterVarianceMismatch(context, sourceType, targetType);
    }

    const parameterMismatch = measureRelationExpressionPhase(
      timingEnabled,
      'signature.parameterMismatch',
      relationSite ?? sourceSignature.getDeclaration() ?? targetSignature.getDeclaration()!,
      {
        ...(signatureMetadata ?? {}),
        parameterIndex: index,
      },
      () =>
        classifyUnsoundRelation(
          context,
          targetParameterType,
          sourceParameterType,
          relationSite,
          visitedPairs,
        ),
    );
    if (parameterMismatch) {
      return parameterMismatch;
    }

    const skipParameterAliasMismatch = (
      isArrayType(context, targetParameterType) &&
      isArrayType(context, sourceParameterType) &&
      !isReadonlyArrayLikeType(context, targetParameterType) &&
      !isReadonlyArrayLikeType(context, sourceParameterType)
    ) ||
      (
        isTupleType(context, targetParameterType) &&
        isTupleType(context, sourceParameterType) &&
        !isReadonlyTupleType(context, targetParameterType) &&
        !isReadonlyTupleType(context, sourceParameterType)
      );

    if (!alphaEquivalent && !skipParameterAliasMismatch) {
      const parameterAliasMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        targetParameterType,
        sourceParameterType,
        sourceParameterTypeNode,
        undefined,
        targetParameterTypeNode,
      );
      if (parameterAliasMismatch) {
        return parameterAliasMismatch;
      }
    }
  }

  const sourceReturnType = context.checker.getReturnTypeOfSignature(sourceSignature);
  const targetReturnType = context.checker.getReturnTypeOfSignature(targetSignature);
  if (
    !measureRelationExpressionPhase(
      timingEnabled,
      'signature.returnAssignable',
      relationSite ?? sourceSignature.getDeclaration() ?? targetSignature.getDeclaration()!,
      signatureMetadata ?? {},
      () => context.checker.isTypeAssignableTo(sourceReturnType, targetReturnType),
    )
  ) {
    return createCallableParameterVarianceMismatch(context, sourceType, targetType);
  }

  const targetReturnTypeNode = getResolvedSignatureReturnTypeNode(
    context,
    targetType,
    targetSignature,
    targetReturnType,
  );
  const sourceReturnTypeNode = getResolvedSignatureReturnTypeNode(
    context,
    sourceType,
    sourceSignature,
    sourceReturnType,
  );
  const preferReturnTypeNodeGenericRelation = shouldPreferTypeNodeGenericRelation(
    context,
    sourceReturnType,
    targetReturnTypeNode,
    undefined,
    sourceReturnTypeNode,
  );
  const returnTypeNodeAliasMismatch = preferReturnTypeNodeGenericRelation ||
      (sourceReturnTypeNode !== undefined && !isSynthesizedRelationNode(sourceReturnTypeNode))
    ? measureRelationExpressionPhase(
      timingEnabled,
      'signature.returnTypeNodeAliasMismatch',
      relationSite ?? sourceSignature.getDeclaration() ?? targetSignature.getDeclaration()!,
      signatureMetadata ?? {},
      () =>
        classifyUnsoundTypeNodeGenericAliasRelation(
          context,
          sourceReturnType,
          targetReturnType,
          targetReturnTypeNode,
          undefined,
          sourceReturnTypeNode,
        ),
    )
    : undefined;
  if (!alphaEquivalent && preferReturnTypeNodeGenericRelation) {
    if (returnTypeNodeAliasMismatch) {
      return returnTypeNodeAliasMismatch;
    }
  } else {
    const returnGenericResult = measureRelationExpressionPhase(
      timingEnabled,
      'signature.returnGenericResult',
      relationSite ?? sourceSignature.getDeclaration() ?? targetSignature.getDeclaration()!,
      signatureMetadata ?? {},
      () =>
        analyzeRecursiveGenericRelation(
          context,
          sourceReturnType,
          targetReturnType,
          relationSite,
          visitedPairs,
        ),
    );
    if (returnGenericResult.handled) {
      if (returnGenericResult.mismatch) {
        return returnGenericResult.mismatch;
      }
    } else {
      const returnMismatch = measureRelationExpressionPhase(
        timingEnabled,
        'signature.returnMismatch',
        relationSite ?? sourceSignature.getDeclaration() ?? targetSignature.getDeclaration()!,
        signatureMetadata ?? {},
        () =>
          classifyUnsoundRelation(
            context,
            sourceReturnType,
            targetReturnType,
            relationSite,
            visitedPairs,
          ),
      );
      if (returnMismatch) {
        return returnMismatch;
      }
    }
  }

  const predicateMismatch = classifyUnsoundSignaturePredicateRelation(
    context,
    sourceType,
    targetType,
    sourceSignature,
    targetSignature,
    visitedPairs,
  );
  if (predicateMismatch) {
    return predicateMismatch;
  }

  return returnTypeNodeAliasMismatch;
}

function getRelevantSignatures(
  context: AnalysisContext,
  type: ts.Type,
  kind: CallableSignatureKind,
): readonly ts.Signature[] {
  return context.checker.getSignaturesOfType(type, kind);
}

function isUserAuthoredSignature(signature: ts.Signature): boolean {
  const declaration = signature.getDeclaration();
  return declaration !== undefined && !declaration.getSourceFile().isDeclarationFile;
}

function classifyUnsoundCallableSignatureRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  relationSite?: ts.Node,
  visitedPairs: Set<string> = new Set(),
): RelationMismatch | undefined {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);
  const pairKey = getRelationTypePairKey(
    context,
    'callable',
    normalizedSourceType,
    normalizedTargetType,
  );
  if (visitedPairs.has(pairKey)) {
    return undefined;
  }
  visitedPairs.add(pairKey);

  for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct] as const) {
    const sourceSignatures = getRelevantSignatures(context, normalizedSourceType, kind);
    const targetSignatures = getRelevantSignatures(context, normalizedTargetType, kind);
    if (sourceSignatures.length === 0 || targetSignatures.length === 0) {
      continue;
    }

    if (
      sourceSignatures.every((signature) => !isUserAuthoredSignature(signature)) &&
      targetSignatures.every((signature) => !isUserAuthoredSignature(signature))
    ) {
      continue;
    }

    for (const targetSignature of targetSignatures) {
      let firstMismatch: RelationMismatch | undefined;
      let foundSafeSource = false;
      for (const sourceSignature of sourceSignatures) {
        const mismatch = classifyUnsoundSignatureRelation(
          context,
          sourceType,
          targetType,
          sourceSignature,
          targetSignature,
          relationSite,
          visitedPairs,
        );
        if (!mismatch) {
          foundSafeSource = true;
          break;
        }
        firstMismatch ??= mismatch;
      }

      if (!foundSafeSource) {
        return firstMismatch ??
          createCallableParameterVarianceMismatch(context, sourceType, targetType);
      }
    }
  }

  return undefined;
}

function isTupleType(context: AnalysisContext, type: ts.Type): boolean {
  return context.checker.isTupleType(normalizeTransparentRelationType(context, type));
}

function isReadonlyTupleType(context: AnalysisContext, type: ts.Type): boolean {
  const normalizedType = normalizeTransparentRelationType(context, type) as ts.TypeReference & {
    target?: ts.TupleType & { readonly?: boolean };
  };
  return context.checker.isTupleType(normalizedType) && normalizedType.target?.readonly === true;
}

function getTupleElementTypes(
  context: AnalysisContext,
  type: ts.Type,
): readonly ts.Type[] {
  return context.checker.getTypeArguments(
    normalizeTransparentRelationType(context, type) as ts.TypeReference,
  );
}

function getTupleShape(context: AnalysisContext, type: ts.Type): TupleShape {
  const normalizedType = normalizeTransparentRelationType(context, type) as ts.TypeReference;
  const tupleTarget = normalizedType.target as ts.TupleType;
  const elementTypes = getTupleElementTypes(context, normalizedType);
  const fixedLength = tupleTarget.fixedLength;
  const suffixCount = tupleTarget.minLength - fixedLength;

  return {
    fixedLength,
    hasRestElement: tupleTarget.hasRestElement,
    prefixTypes: elementTypes.slice(
      0,
      tupleTarget.hasRestElement ? fixedLength : elementTypes.length,
    ),
    restType: tupleTarget.hasRestElement ? elementTypes[fixedLength] : undefined,
    suffixTypes: suffixCount > 0 ? elementTypes.slice(elementTypes.length - suffixCount) : [],
  };
}

function isReadonlyArrayLikeType(context: AnalysisContext, type: ts.Type): boolean {
  const normalizedType = normalizeTransparentRelationType(context, type);
  if (isReadonlyTupleType(context, normalizedType)) {
    return true;
  }

  return getTypeReferenceSymbol(normalizedType)?.getName() === 'ReadonlyArray';
}

function isArrayType(context: AnalysisContext, type: ts.Type): boolean {
  return context.checker.isArrayType(normalizeTransparentRelationType(context, type));
}

function getArrayElementType(context: AnalysisContext, type: ts.Type): ts.Type | undefined {
  const normalizedType = normalizeTransparentRelationType(context, type);
  if (!context.checker.isArrayType(normalizedType)) {
    return undefined;
  }

  return context.checker.getTypeArguments(normalizedType as ts.TypeReference)[0];
}

function getArrayLikeElementType(context: AnalysisContext, type: ts.Type): ts.Type | undefined {
  return getArrayElementType(context, type) ??
    (hasTypeReferenceName(context, type, 'ReadonlyArray')
      ? getReferenceTypeArguments(context, type)[0]
      : undefined) ??
    context.checker.getIndexInfoOfType(type, ts.IndexKind.Number)?.type;
}

function getTypeReferenceSymbol(type: ts.Type): ts.Symbol | undefined {
  if ((type.flags & ts.TypeFlags.Object) === 0) {
    return undefined;
  }

  const objectType = type as ts.ObjectType;
  if ((objectType.objectFlags & ts.ObjectFlags.Reference) === 0) {
    return type.getSymbol();
  }

  return (type as ts.TypeReference).target.symbol ?? type.getSymbol();
}

function getMatchingBaseType(
  context: AnalysisContext,
  type: ts.Type,
  targetSymbol: ts.Symbol,
  visitedTypeIds: Set<number> = new Set(),
): ts.Type | undefined {
  const normalizedType = normalizeTransparentRelationType(context, type);
  const typeId = (normalizedType as ts.Type & { id?: number }).id;
  if (typeof typeId === 'number') {
    if (visitedTypeIds.has(typeId)) {
      return undefined;
    }
    visitedTypeIds.add(typeId);
  }

  if (getTypeReferenceSymbol(normalizedType) === targetSymbol) {
    return normalizedType;
  }

  if ((normalizedType.flags & ts.TypeFlags.Object) === 0) {
    return undefined;
  }

  const objectType = normalizedType as ts.ObjectType;
  if (
    (objectType.objectFlags & (ts.ObjectFlags.ClassOrInterface | ts.ObjectFlags.Reference)) === 0
  ) {
    return undefined;
  }

  for (const baseType of context.checker.getBaseTypes(normalizedType as ts.InterfaceType) ?? []) {
    const match = getMatchingBaseType(context, baseType, targetSymbol, visitedTypeIds);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function hasTypeReferenceName(
  context: AnalysisContext,
  type: ts.Type,
  expectedName: string,
): boolean {
  return getTypeReferenceSymbol(normalizeTransparentRelationType(context, type))?.getName() ===
    expectedName;
}

function shouldPreferTypeNodeGenericRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetTypeNode: ts.TypeNode | undefined,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
): boolean {
  const unwrappedTargetTypeNode = unwrapRelationTypeNode(targetTypeNode);
  if (
    !unwrappedTargetTypeNode ||
    !isRelationReferenceTypeNode(unwrappedTargetTypeNode)
  ) {
    return false;
  }

  const targetSymbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, unwrappedTargetTypeNode),
  );
  if (!targetSymbol || isGenericClassSymbol(targetSymbol)) {
    return false;
  }

  const aliasPolicy = getGenericAliasVariancePolicy(context, targetSymbol);
  const targetWrapperPayloadTypeNode = getTransparentRelationWrapperPayloadTypeNode(
    context,
    unwrappedTargetTypeNode,
  );
  if (
    !aliasPolicy &&
    !targetWrapperPayloadTypeNode &&
    !isInferUtilityWrapperName(targetSymbol.getName())
  ) {
    return false;
  }

  if (getSymbolTypeParameterDeclarations(targetSymbol).length === 0) {
    return false;
  }

  if (getDeclaredGenericAliasTypeArgumentsFromTypeNode(context, sourceTypeNode, targetSymbol)) {
    return true;
  }

  if (getDeclaredGenericAliasTypeArgumentsFromExpression(context, sourceExpression, targetSymbol)) {
    return true;
  }

  if (
    getDeclaredGenericAliasTypeArgumentsFromTypeNode(
      context,
      getSynthesizedRelationTypeNode(context, sourceType),
      targetSymbol,
    )
  ) {
    return true;
  }

  if (
    sourceExpression &&
    (ts.isCallExpression(sourceExpression) || ts.isNewExpression(sourceExpression))
  ) {
    const signature = context.checker.getResolvedSignature(sourceExpression);
    const returnTypeNode = signature ? getSignatureReturnTypeNode(signature) : undefined;
    const unwrappedReturnTypeNode = unwrapRelationTypeNode(returnTypeNode);
    if (
      unwrappedReturnTypeNode &&
      isRelationReferenceTypeNode(unwrappedReturnTypeNode) &&
      getResolvedAliasSymbol(
          context,
          getRelationReferenceTypeNodeSymbol(context, unwrappedReturnTypeNode),
        ) === targetSymbol
    ) {
      return true;
    }
  }

  const sourceInfo = getGenericRelationTypeInfo(
    context,
    normalizeTransparentRelationType(context, sourceType),
  );
  if (sourceInfo?.symbol === targetSymbol) {
    return true;
  }

  const matchingBaseType = getMatchingBaseType(context, sourceType, targetSymbol);
  const matchingBaseInfo = matchingBaseType
    ? getGenericRelationTypeInfo(context, matchingBaseType)
    : undefined;
  return matchingBaseInfo?.symbol === targetSymbol;
}

function classifyWritablePayloadRelation(
  context: AnalysisContext,
  sourceAcceptedType: ts.Type,
  targetWriteType: ts.Type,
  relationSite?: ts.Node,
  visitedPairs: Set<string> = new Set(),
): RelationMismatch | undefined {
  return classifyUnsoundMutableContainerPayloadRelation(
    context,
    targetWriteType,
    sourceAcceptedType,
  ) ??
    classifyUnsoundRecursiveGenericRelation(
      context,
      targetWriteType,
      sourceAcceptedType,
      relationSite,
      visitedPairs,
    ) ??
    classifyUnsoundRelation(
      context,
      targetWriteType,
      sourceAcceptedType,
      relationSite,
      visitedPairs,
    );
}

function classifyUnsoundMutableTupleRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  if (!isTupleType(context, sourceType) || !isTupleType(context, targetType)) {
    return undefined;
  }

  if (isReadonlyTupleType(context, sourceType) || isReadonlyTupleType(context, targetType)) {
    return undefined;
  }

  const sourceElements = getTupleElementTypes(context, sourceType);
  const targetElements = getTupleElementTypes(context, targetType);
  if (sourceElements.length !== targetElements.length) {
    return {
      kind: 'mutableTupleVariance',
      message: 'Mutable tuples are invariant in soundscript.',
      notes: [
        `'${context.checker.typeToString(sourceType)}' cannot be widened to '${
          context.checker.typeToString(targetType)
        }' because writes through the target could store incompatible tuple elements.`,
      ],
      hint: 'Use a readonly tuple, copy into a new tuple, or keep the exact tuple type.',
    };
  }

  for (const [index, targetElement] of targetElements.entries()) {
    const sourceElement = sourceElements[index];
    if (!sourceElement) {
      return {
        kind: 'mutableTupleVariance',
        message: 'Mutable tuples are invariant in soundscript.',
        notes: [
          `'${context.checker.typeToString(sourceType)}' cannot be widened to '${
            context.checker.typeToString(targetType)
          }' because writes through the target could store incompatible tuple elements.`,
        ],
        hint: 'Use a readonly tuple, copy into a new tuple, or keep the exact tuple type.',
      };
    }

    const payloadMismatch = classifyWritablePayloadRelation(
      context,
      sourceElement,
      targetElement,
    );
    if (payloadMismatch) {
      return payloadMismatch;
    }

    if (!context.checker.isTypeAssignableTo(targetElement, sourceElement)) {
      return {
        kind: 'mutableTupleVariance',
        message: 'Mutable tuples are invariant in soundscript.',
        notes: [
          `'${context.checker.typeToString(sourceType)}' cannot be widened to '${
            context.checker.typeToString(targetType)
          }' because writes through the target could store incompatible tuple elements.`,
        ],
        hint: 'Use a readonly tuple, copy into a new tuple, or keep the exact tuple type.',
      };
    }
  }

  return undefined;
}

function classifyUnsoundMutableArrayRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  if (
    !isArrayType(context, sourceType) ||
    !isArrayType(context, targetType) ||
    isReadonlyArrayLikeType(context, sourceType) ||
    isReadonlyArrayLikeType(context, targetType)
  ) {
    return undefined;
  }

  const sourceElement = getArrayElementType(context, sourceType);
  const targetElement = getArrayElementType(context, targetType);
  if (!sourceElement || !targetElement) {
    return undefined;
  }

  const payloadMismatch = classifyWritablePayloadRelation(
    context,
    sourceElement,
    targetElement,
  );
  if (payloadMismatch) {
    return payloadMismatch;
  }

  return !context.checker.isTypeAssignableTo(targetElement, sourceElement)
    ? {
      kind: 'mutableArrayVariance',
      message: 'Mutable arrays are invariant in soundscript.',
      notes: [
        `'${context.checker.typeToString(sourceType)}' cannot be widened to '${
          context.checker.typeToString(targetType)
        }' because writes through the target could push values the source array does not allow.`,
        'Mutable edge: array writes such as `push`, indexed assignment, or `splice` would become unsound through the widened target surface.',
      ],
      hint:
        'Make the array readonly, copy into a fresh array before widening, or keep the exact element type.',
    }
    : undefined;
}

function getWritableIndexType(
  context: AnalysisContext,
  type: ts.Type,
  kind: ts.IndexKind,
): ts.Type | undefined {
  const indexInfo = context.checker.getIndexInfoOfType(type, kind);
  if (!indexInfo || indexInfo.isReadonly) {
    return undefined;
  }

  return indexInfo.type;
}

function getWritableSymbolIndexType(
  context: AnalysisContext,
  type: ts.Type,
): ts.Type | undefined {
  const indexInfo = context.checker.getIndexInfosOfType(type).find((info) =>
    context.checker.typeToString(info.keyType) === 'symbol'
  );
  if (!indexInfo || indexInfo.isReadonly) {
    return undefined;
  }

  return indexInfo.type;
}

function isNumericPropertyName(propertyName: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(propertyName);
}

function getReadableIndexTypeForPropertyName(
  context: AnalysisContext,
  type: ts.Type,
  propertyName: string,
): ts.Type | undefined {
  if (isNumericPropertyName(propertyName)) {
    const numericIndexType = context.checker.getIndexInfoOfType(type, ts.IndexKind.Number)?.type;
    if (numericIndexType) {
      return numericIndexType;
    }
  }

  return context.checker.getIndexInfoOfType(type, ts.IndexKind.String)?.type;
}

function isStackOverflowLikeError(error: unknown): boolean {
  return error instanceof RangeError ||
    (error instanceof Error &&
      (error.message.includes('Maximum call stack size exceeded') ||
        error.message.includes('Stack overflow')));
}

function getSynthesizedRelationTypeNode(
  context: AnalysisContext,
  type: ts.Type | undefined,
): ts.TypeNode | undefined {
  if (!type) {
    return undefined;
  }

  try {
    return context.checker.typeToTypeNode(
      type,
      undefined,
      ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope |
        ts.NodeBuilderFlags.NoTruncation,
    );
  } catch (error) {
    if (isStackOverflowLikeError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isSynthesizedRelationNode(node: ts.Node | undefined): boolean {
  return !!node && (node.pos < 0 || (node.flags & ts.NodeFlags.Synthesized) !== 0);
}

function classifyUnsoundWritableIndexSignatureRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  if (
    !isInspectableObjectType(sourceType) ||
    !isInspectableObjectType(targetType) ||
    isArrayType(context, sourceType) ||
    isArrayType(context, targetType) ||
    isTupleType(context, sourceType) ||
    isTupleType(context, targetType)
  ) {
    return undefined;
  }

  for (
    const { keyType, getWritableType } of [
      {
        keyType: 'string',
        getWritableType: (type: ts.Type) => getWritableIndexType(context, type, ts.IndexKind.String),
      },
      {
        keyType: 'number',
        getWritableType: (type: ts.Type) => getWritableIndexType(context, type, ts.IndexKind.Number),
      },
      {
        keyType: 'symbol',
        getWritableType: (type: ts.Type) => getWritableSymbolIndexType(context, type),
      },
    ] as const
  ) {
    const targetIndexType = getWritableType(targetType);
    if (!targetIndexType) {
      continue;
    }

    const sourceIndexType = getWritableType(sourceType);
    if (!sourceIndexType) {
      continue;
    }

    const payloadMismatch = classifyWritablePayloadRelation(
      context,
      sourceIndexType,
      targetIndexType,
    );
    if (payloadMismatch) {
      return payloadMismatch;
    }

    if (!context.checker.isTypeAssignableTo(targetIndexType, sourceIndexType)) {
      return {
        kind: 'writableIndexSignatureVariance',
        message: `Writable ${keyType} index signatures are invariant in soundscript.`,
        notes: [
          `The target can write '${
            context.checker.typeToString(targetIndexType)
          }' values, but the source only accepts '${
            context.checker.typeToString(sourceIndexType)
          }'.`,
          `Mutable edge: writes through the widened ${keyType} index signature could store values the source surface does not accept.`,
        ],
        hint:
          'Make the index signature readonly, copy into a fresh object before widening, or keep the exact value type.',
      };
    }
  }

  return undefined;
}

function getReferenceTypeArguments(context: AnalysisContext, type: ts.Type): readonly ts.Type[] {
  const normalizedType = normalizeTransparentRelationType(context, type);
  if ((normalizedType.flags & ts.TypeFlags.Object) === 0) {
    return [];
  }

  const objectType = normalizedType as ts.ObjectType;
  if ((objectType.objectFlags & ts.ObjectFlags.Reference) === 0) {
    return [];
  }

  return context.checker.getTypeArguments(normalizedType as ts.TypeReference);
}

function isBundledSoundLibSourceFile(sourceFile: ts.SourceFile): boolean {
  const normalizedFileName = sourceFile.fileName.replaceAll('\\', '/');
  const baseName = normalizedFileName.split('/').pop() ?? normalizedFileName;
  if (/^\/__soundscript_std(?:_[a-z]+)?__\.d\.ts$/u.test(normalizedFileName)) {
    return true;
  }
  return normalizedFileName.includes('/src/bundled/typescript/lib/') ||
    /^lib\.[^.].*\.d\.ts$/u.test(baseName);
}

function isInstalledSoundStdlibSourceFile(sourceFile: ts.SourceFile): boolean {
  const normalizedFileName = sourceFile.fileName.replaceAll('\\', '/');
  return normalizedFileName.includes('/node_modules/@soundscript/soundscript/') &&
    (
      normalizedFileName.endsWith('.d.ts') ||
      normalizedFileName.endsWith('.sts') ||
      normalizedFileName.endsWith('.sts.ts')
    );
}

function isLocalBuiltinSoundStdlibSourceFile(sourceFile: ts.SourceFile): boolean {
  const normalizedFileName = sourceFile.fileName.replaceAll('\\', '/');
  return normalizedFileName.includes('/src/stdlib/') &&
    (
      normalizedFileName.endsWith('.d.ts') ||
      normalizedFileName.endsWith('.ts')
    );
}

function isTrustedSoundLibSourceFile(sourceFile: ts.SourceFile): boolean {
  return isBundledSoundLibSourceFile(sourceFile) ||
    isInstalledSoundStdlibSourceFile(sourceFile) ||
    isLocalBuiltinSoundStdlibSourceFile(sourceFile);
}

function getTypeAliasName(type: ts.Type): string | undefined {
  return (type as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol?.getName();
}

function getAliasTypeArguments(type: ts.Type): readonly ts.Type[] {
  return (type as ts.Type & { aliasTypeArguments?: readonly ts.Type[] }).aliasTypeArguments ?? [];
}

function getTransparentRelationWrapperPayloadType(
  context: AnalysisContext,
  type: ts.Type,
): ts.Type | undefined {
  const normalizedType = getSafeNonNullableRelationType(context, type);
  if ((normalizedType.flags & ts.TypeFlags.Substitution) === 0) {
    return undefined;
  }

  const substitutionType = normalizedType as ts.Type & {
    baseType?: ts.Type;
    constraint?: ts.Type;
  };
  const normalizedConstraint = substitutionType.constraint
    ? getSafeBaseConstraintOfType(context, substitutionType.constraint) ??
      substitutionType.constraint
    : undefined;
  return substitutionType.baseType &&
      normalizedConstraint &&
      (normalizedConstraint.flags & ts.TypeFlags.Unknown) !== 0
    ? substitutionType.baseType
    : undefined;
}

function normalizeTransparentRelationType(
  context: AnalysisContext,
  type: ts.Type,
): ts.Type {
  let normalizedType = getSafeNonNullableRelationType(context, type);
  while (true) {
    const payloadType = getTransparentRelationWrapperPayloadType(context, normalizedType);
    if (!payloadType) {
      return normalizedType;
    }
    normalizedType = getSafeNonNullableRelationType(context, payloadType);
  }
}

function getSafeNonNullableRelationType(
  context: AnalysisContext,
  type: ts.Type,
): ts.Type {
  try {
    return context.checker.getNonNullableType(type);
  } catch {
    return type;
  }
}

function getSafeBaseConstraintOfType(
  context: AnalysisContext,
  type: ts.Type,
): ts.Type | undefined {
  try {
    return context.checker.getBaseConstraintOfType(type);
  } catch {
    return undefined;
  }
}

function getResolvedAliasSymbol(
  context: AnalysisContext,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (!symbol) {
    return undefined;
  }

  return (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? context.checker.getAliasedSymbol(symbol)
    : symbol;
}

function hasProjectedNewtypeBrandTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode) {
    return false;
  }

  const visit = (node: ts.TypeNode): boolean => {
    if (ts.isParenthesizedTypeNode(node)) {
      return visit(node.type);
    }

    if (ts.isIntersectionTypeNode(node)) {
      return node.types.some(visit);
    }

    if (!ts.isTypeLiteralNode(node)) {
      return false;
    }

    return node.members.some((member) => {
      if (!ts.isPropertySignature(member) || !member.type || !hasReadonlyModifier(member)) {
        return false;
      }

      if (member.type.kind !== ts.SyntaxKind.NeverKeyword) {
        return false;
      }

      if (!member.name || !ts.isComputedPropertyName(member.name)) {
        return false;
      }

      return ts.isIdentifier(member.name.expression) &&
        PROJECTED_NEWTYPE_BRAND_NAME_PATTERN.test(member.name.expression.text);
    });
  };

  return visit(typeNode);
}

function isNewtypeAliasSymbol(
  context: AnalysisContext,
  symbol: ts.Symbol | undefined,
): boolean {
  const resolvedSymbol = getResolvedAliasSymbol(context, symbol);
  if (!resolvedSymbol) {
    return false;
  }

  return (resolvedSymbol.getDeclarations() ?? []).some((declaration) =>
    ts.isTypeAliasDeclaration(declaration) &&
    (
      context.getAnnotationLookup(declaration.getSourceFile()).hasAttachedAnnotation(
        declaration,
        'newtype',
      ) ||
      hasProjectedNewtypeBrandTypeNode(declaration.type)
    )
  );
}

function getNewtypeAliasDeclaration(
  context: AnalysisContext,
  symbol: ts.Symbol | undefined,
): ts.TypeAliasDeclaration | undefined {
  const resolvedSymbol = getResolvedAliasSymbol(context, symbol);
  if (!resolvedSymbol) {
    return undefined;
  }

  return (resolvedSymbol.getDeclarations() ?? []).find((declaration) =>
    ts.isTypeAliasDeclaration(declaration) &&
    (
      context.getAnnotationLookup(declaration.getSourceFile()).hasAttachedAnnotation(
        declaration,
        'newtype',
      ) ||
      hasProjectedNewtypeBrandTypeNode(declaration.type)
    )
  ) as ts.TypeAliasDeclaration | undefined;
}

function getDirectNewtypeIdentity(
  context: AnalysisContext,
  type: ts.Type,
): NewtypeIdentity | undefined {
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    return undefined;
  }

  let normalizedType: ts.Type;
  try {
    normalizedType = normalizeTransparentRelationType(context, type);
  } catch {
    return undefined;
  }
  if ((normalizedType.flags & ts.TypeFlags.TypeParameter) !== 0) {
    return undefined;
  }

  const aliasSymbol = getResolvedAliasSymbol(
    context,
    (normalizedType as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol,
  );
  if (!aliasSymbol) {
    return undefined;
  }

  if (isNewtypeAliasSymbol(context, aliasSymbol)) {
    return {
      symbol: aliasSymbol,
      typeArguments: getAliasTypeArguments(normalizedType),
    };
  }

  const aliasDeclaration = (aliasSymbol.getDeclarations() ?? []).find(ts.isTypeAliasDeclaration);
  if (!aliasDeclaration || (aliasDeclaration.typeParameters?.length ?? 0) > 0) {
    return undefined;
  }

  return getDeclaredNewtypeIdentityFromTypeNode(context, aliasDeclaration.type);
}

function sourceTypeContainsAnyNewtypeIdentity(
  context: AnalysisContext,
  type: ts.Type,
): boolean {
  const normalizedType = getSafeNonNullableRelationType(context, type);

  if ((normalizedType.flags & ts.TypeFlags.Union) !== 0) {
    return (normalizedType as ts.UnionType).types.some((constituentType) =>
      sourceTypeContainsAnyNewtypeIdentity(context, constituentType)
    );
  }

  if ((normalizedType.flags & ts.TypeFlags.Intersection) !== 0) {
    return (normalizedType as ts.IntersectionType).types.some((constituentType) =>
      sourceTypeContainsAnyNewtypeIdentity(context, constituentType)
    );
  }

  return getDirectNewtypeIdentity(context, normalizedType) !== undefined;
}

function isSameModuleNewtypePrivilege(
  context: AnalysisContext,
  relationSite: ts.Node | undefined,
  identity: NewtypeIdentity,
): boolean {
  const relationSourceFile = relationSite?.getSourceFile();
  const declaration = getNewtypeAliasDeclaration(context, identity.symbol);
  return relationSourceFile !== undefined &&
    declaration !== undefined &&
    declaration.getSourceFile() === relationSourceFile;
}

const inferredGenericVarianceCache = new WeakMap<
  AnalysisContext,
  Map<number, readonly GenericVariance[]>
>();
const annotatedGenericVarianceCache = new WeakMap<
  AnalysisContext,
  Map<number, readonly GenericVariance[] | null>
>();

function getContextInferredGenericVarianceCache(
  context: AnalysisContext,
): Map<number, readonly GenericVariance[]> {
  let cache = inferredGenericVarianceCache.get(context);
  if (!cache) {
    cache = new Map<number, readonly GenericVariance[]>();
    inferredGenericVarianceCache.set(context, cache);
  }
  return cache;
}

function getContextAnnotatedGenericVarianceCache(
  context: AnalysisContext,
): Map<number, readonly GenericVariance[] | null> {
  let cache = annotatedGenericVarianceCache.get(context);
  if (!cache) {
    cache = new Map<number, readonly GenericVariance[] | null>();
    annotatedGenericVarianceCache.set(context, cache);
  }
  return cache;
}

function getRecursiveVarianceWrapperName(
  type: ts.Type,
  kind: 'alias' | 'reference',
): string | undefined {
  return kind === 'alias' ? getTypeAliasName(type) : getTypeReferenceSymbol(type)?.getName();
}

function getRecursiveVarianceWrapperTypeArguments(
  context: AnalysisContext,
  type: ts.Type,
  kind: 'alias' | 'reference',
): readonly ts.Type[] {
  return kind === 'alias' ? getAliasTypeArguments(type) : getReferenceTypeArguments(context, type);
}

function getGenericRelationTypeInfo(
  context: AnalysisContext,
  type: ts.Type,
): GenericRelationTypeInfo | undefined {
  const effectiveType = normalizeTransparentRelationType(context, type);
  const aliasName = getTypeAliasName(effectiveType);
  const aliasSymbol = (effectiveType as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol;
  const aliasTypeArguments = getAliasTypeArguments(effectiveType);
  if (aliasName && aliasSymbol && aliasTypeArguments.length > 0) {
    return {
      kind: 'alias',
      name: aliasName,
      symbol: aliasSymbol,
      typeArguments: aliasTypeArguments,
    };
  }

  const referenceName = getRecursiveVarianceWrapperName(effectiveType, 'reference');
  const referenceSymbol = getTypeReferenceSymbol(effectiveType);
  const referenceTypeArguments = getReferenceTypeArguments(context, effectiveType);
  if (referenceName && referenceSymbol && referenceTypeArguments.length > 0) {
    return {
      kind: 'reference',
      name: referenceName,
      symbol: referenceSymbol,
      typeArguments: referenceTypeArguments,
    };
  }

  return undefined;
}

function flipVariancePolarity(
  polarity: number,
): number {
  if (polarity === VARIANCE_POLARITY_INVARIANT) {
    return VARIANCE_POLARITY_INVARIANT;
  }

  return polarity === VARIANCE_POLARITY_COVARIANT
    ? VARIANCE_POLARITY_CONTRAVARIANT
    : VARIANCE_POLARITY_COVARIANT;
}

function combineGenericVariance(
  current: GenericVariance,
  polarity: number,
): GenericVariance {
  const next = polarity === VARIANCE_POLARITY_COVARIANT
    ? 'covariant'
    : polarity === VARIANCE_POLARITY_CONTRAVARIANT
    ? 'contravariant'
    : 'invariant';
  if (current === 'independent') {
    return next;
  }
  if (current === next) {
    return current;
  }
  return 'invariant';
}

function composeVariancePolarity(
  polarity: number,
  variance: GenericVariance,
): number | undefined {
  switch (variance) {
    case 'independent':
      return undefined;
    case 'invariant':
      return VARIANCE_POLARITY_INVARIANT;
    case 'covariant':
      return polarity;
    case 'contravariant':
      return flipVariancePolarity(polarity);
  }
}

function varianceAnnotationKeywordToVariance(keyword: VarianceAnnotationKeyword): GenericVariance {
  switch (keyword) {
    case 'out':
      return 'covariant';
    case 'in':
      return 'contravariant';
    case 'inout':
      return 'invariant';
    case 'independent':
      return 'independent';
  }
}

function genericVarianceToAnnotationKeyword(variance: GenericVariance): VarianceAnnotationKeyword {
  switch (variance) {
    case 'covariant':
      return 'out';
    case 'contravariant':
      return 'in';
    case 'invariant':
      return 'inout';
    case 'independent':
      return 'independent';
  }
}

function formatVarianceAnnotationContract(
  parameterNames: readonly string[],
  variances: readonly GenericVariance[],
): string | undefined {
  if (parameterNames.length !== variances.length || parameterNames.length === 0) {
    return undefined;
  }

  const entries = parameterNames.map((parameterName, index) =>
    `${parameterName}: ${genericVarianceToAnnotationKeyword(variances[index] ?? 'invariant')}`
  );
  return `// #[variance(${entries.join(', ')})]`;
}

function formatTotalInvariantVarianceContract(parameterNames: readonly string[]): string | undefined {
  if (parameterNames.length === 0) {
    return undefined;
  }

  return formatVarianceAnnotationContract(parameterNames, parameterNames.map(() => 'invariant' as const));
}

function describeVarianceRewriteGuidance(
  parameterName: string,
  variance: GenericVariance,
): string {
  switch (variance) {
    case 'covariant':
      return `rewrite the declaration so \`${parameterName}\` is only produced.`;
    case 'contravariant':
      return `rewrite the declaration so \`${parameterName}\` is only consumed.`;
    case 'invariant':
      return `rewrite the declaration so \`${parameterName}\` is used in a single direction.`;
    case 'independent':
      return `rewrite the declaration so \`${parameterName}\` does not affect the exposed surface.`;
  }
}

function parseVarianceAnnotationEntry(
  entry: ParsedAnnotationArgument,
): ParsedVarianceAnnotationEntry | string {
  if (entry.kind !== 'named') {
    return `Invalid variance entry \`${entry.text}\`. Use \`T: out\`, \`T: in\`, \`T: inout\`, or \`T: independent\`.`;
  }

  if (entry.value.kind !== 'identifier') {
    return `Invalid variance entry \`${entry.text}\`. Variance values must be identifiers such as \`out\` or \`inout\`.`;
  }

  const keyword = entry.value.name;
  if (keyword !== 'out' && keyword !== 'in' && keyword !== 'inout' && keyword !== 'independent') {
    return `Invalid variance entry \`${entry.text}\`. Use \`T: out\`, \`T: in\`, \`T: inout\`, or \`T: independent\`.`;
  }

  return {
    parameterName: entry.name,
    variance: varianceAnnotationKeywordToVariance(keyword as VarianceAnnotationKeyword),
  };
}

function getVarianceAnnotatedDeclarations(
  context: AnalysisContext,
  symbol: ts.Symbol,
): readonly (ts.InterfaceDeclaration | ts.TypeAliasDeclaration)[] {
  return (symbol.getDeclarations() ?? []).filter((
    declaration,
  ): declaration is ts.InterfaceDeclaration | ts.TypeAliasDeclaration => {
    if (!ts.isInterfaceDeclaration(declaration) && !ts.isTypeAliasDeclaration(declaration)) {
      return false;
    }

    return context.getAnnotationLookup(declaration.getSourceFile()).getAttachedAnnotations(
      declaration,
    )
      .some((annotation) => annotation.name === 'variance');
  });
}

function getVarianceAnnotation(
  context: AnalysisContext,
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
) {
  return context.getAnnotationLookup(declaration.getSourceFile()).getAttachedAnnotations(
    declaration,
  )
    .find((annotation) => annotation.name === 'variance');
}

function parseVarianceAnnotationContract(
  parameterNames: readonly string[],
  annotationArguments: readonly ParsedAnnotationArgument[] | undefined,
): { variances: readonly GenericVariance[] } | { message: string } {
  if (annotationArguments === undefined) {
    return {
      message: 'Variance annotations require a total contract such as `#[variance(T: out)]`.',
    };
  }

  if (annotationArguments.length === 0) {
    return {
      message: 'Add at least one variance entry such as `T: out` or `T: inout`.',
    };
  }

  const expectedNames = new Set(parameterNames);
  const seenNames = new Set<string>();
  const variancesByName = new Map<string, GenericVariance>();

  for (const entry of annotationArguments) {
    const parsedEntry = parseVarianceAnnotationEntry(entry);
    if (typeof parsedEntry === 'string') {
      return { message: parsedEntry };
    }

    if (!expectedNames.has(parsedEntry.parameterName)) {
      return {
        message: `Variance annotation names unknown parameter \`${parsedEntry.parameterName}\`.`,
      };
    }

    if (seenNames.has(parsedEntry.parameterName)) {
      return {
        message: `Variance annotation lists \`${parsedEntry.parameterName}\` more than once.`,
      };
    }

    seenNames.add(parsedEntry.parameterName);
    variancesByName.set(parsedEntry.parameterName, parsedEntry.variance);
  }

  const missingNames = parameterNames.filter((parameterName) => !seenNames.has(parameterName));
  if (missingNames.length > 0) {
    return {
      message: `Variance annotation must mention every type parameter exactly once. Missing: ${
        missingNames.map((name) => `\`${name}\``).join(', ')
      }.`,
    };
  }

  return {
    variances: parameterNames.map((parameterName) =>
      variancesByName.get(parameterName) ?? 'invariant'
    ),
  };
}

function getAnnotatedGenericVariances(
  context: AnalysisContext,
  symbol: ts.Symbol,
): readonly GenericVariance[] | undefined {
  const cache = getContextAnnotatedGenericVarianceCache(context);
  const symbolId = context.getSymbolId(symbol);
  if (cache.has(symbolId)) {
    return cache.get(symbolId) ?? undefined;
  }

  const annotatedDeclarations = getVarianceAnnotatedDeclarations(context, symbol);
  if (annotatedDeclarations.length !== 1) {
    cache.set(symbolId, null);
    return undefined;
  }

  const parameterNames = getGenericParameterNames(
    symbol,
    getSymbolTypeParameterDeclarations(symbol).length,
  );
  const annotation = getVarianceAnnotation(context, annotatedDeclarations[0]);
  const parsedContract = parseVarianceAnnotationContract(parameterNames, annotation?.arguments);
  if ('message' in parsedContract) {
    cache.set(symbolId, null);
    return undefined;
  }

  cache.set(symbolId, parsedContract.variances);
  return parsedContract.variances;
}

function getProvenGenericVariances(
  context: AnalysisContext,
  symbol: ts.Symbol,
  stack: Set<number> = new Set(),
): readonly GenericVariance[] {
  const declarations = symbol.getDeclarations() ?? [];
  const typeParameters = getSymbolTypeParameterDeclarations(symbol);
  if (typeParameters.length === 0) {
    return [];
  }

  const inferredVariances = getOrInferGenericVariances(context, symbol, stack);
  if (inferredVariances.length === typeParameters.length) {
    return inferredVariances;
  }

  const hasVarianceAnnotation = getVarianceAnnotatedDeclarations(context, symbol).length > 0;
  const allDeclarationsAreDts = declarations.length > 0 &&
    declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
  const allDeclarationsAreTrustedSoundLibs = declarations.length > 0 &&
    declarations.every((declaration) => isTrustedSoundLibSourceFile(declaration.getSourceFile()));
  if (
    declarations.some(ts.isTypeAliasDeclaration) &&
    !hasVarianceAnnotation &&
    (!allDeclarationsAreDts || allDeclarationsAreTrustedSoundLibs)
  ) {
    return [];
  }

  if (
    declarations.some(ts.isTypeAliasDeclaration) &&
    !hasVarianceAnnotation
  ) {
    return typeParameters.map(() => 'invariant' as const);
  }

  return typeParameters.map(() => 'invariant' as const);
}

function getResolvedGenericVariances(
  context: AnalysisContext,
  symbol: ts.Symbol,
  stack: Set<number> = new Set(),
): readonly GenericVariance[] {
  const annotatedVariances = getAnnotatedGenericVariances(context, symbol);
  if (annotatedVariances) {
    const provenVariances = getProvenGenericVariances(context, symbol, stack);
    if (
      annotatedVariances.length === provenVariances.length &&
      annotatedVariances.every((variance, index) => variance === provenVariances[index])
    ) {
      return annotatedVariances;
    }
  }

  return getProvenGenericVariances(context, symbol, stack);
}

function getGenericAliasVariancePolicy(
  context: AnalysisContext,
  symbol: ts.Symbol,
): GenericAliasVariancePolicy | undefined {
  const typeParameters = getSymbolTypeParameterDeclarations(symbol);
  if (typeParameters.length === 0) {
    return undefined;
  }

  const declarations = symbol.getDeclarations() ?? [];
  if (!declarations.some(ts.isTypeAliasDeclaration)) {
    return undefined;
  }

  const hasVarianceAnnotation = getVarianceAnnotatedDeclarations(context, symbol).length > 0;
  const allDeclarationsAreDts = declarations.length > 0 &&
    declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
  const allDeclarationsAreTrustedSoundLibs = declarations.length > 0 &&
    declarations.every((declaration) => isTrustedSoundLibSourceFile(declaration.getSourceFile()));

  return {
    hasVarianceAnnotation,
    isImportedDeclarationAlias: allDeclarationsAreDts && !allDeclarationsAreTrustedSoundLibs,
    typeParameters,
    variances: getResolvedGenericVariances(context, symbol),
    varianceAnnotationDetails: getVarianceAnnotationDiagnosticDetailsForSymbol(context, symbol),
  };
}

function isUnsupportedGenericAliasPolicy(
  policy: GenericAliasVariancePolicy | undefined,
): policy is GenericAliasVariancePolicy {
  return policy !== undefined &&
    (policy.isImportedDeclarationAlias || policy.hasVarianceAnnotation) &&
    policy.variances.length !== policy.typeParameters.length;
}

function classifyGenericAliasPolicyFallbackMismatch(
  context: AnalysisContext,
  policy: GenericAliasVariancePolicy | undefined,
  sourceType: ts.Type,
  targetType: ts.Type,
  typeName: string,
): RelationMismatch | undefined {
  if (!policy) {
    return undefined;
  }

  if (policy.varianceAnnotationDetails) {
    return createVarianceAnnotationRelationMismatch(policy.varianceAnnotationDetails);
  }

  if (!policy.isImportedDeclarationAlias) {
    return undefined;
  }

  if (areExactTypeArguments(context, sourceType, targetType)) {
    return undefined;
  }

  return createUnsupportedAliasInvariantMismatch(
    context,
    sourceType,
    targetType,
    typeName,
  );
}

function getVarianceAnnotationMismatchNotes(
  annotatedVariances: readonly GenericVariance[],
  provenVariances: readonly GenericVariance[],
  parameterNames: readonly string[],
): readonly string[] {
  if (annotatedVariances.length !== provenVariances.length) {
    return [
      `The checked variance contract lists ${annotatedVariances.length} parameter(s), but the declaration proves ${provenVariances.length}.`,
    ];
  }

  return annotatedVariances.flatMap((annotatedVariance, index) => {
    const provenVariance = provenVariances[index];
    const parameterName = parameterNames[index] ?? `T${index}`;
    if (!provenVariance || annotatedVariance === provenVariance) {
      return [];
    }

    return [
      `Parameter \`${parameterName}\` is annotated as \`${
        genericVarianceToAnnotationKeyword(annotatedVariance)
      }\`, but soundscript proves it is \`${
        genericVarianceToAnnotationKeyword(provenVariance)
      }\` from the declaration surface.`,
    ];
  });
}

function getVarianceAnnotationDiagnosticDetailsForSymbol(
  context: AnalysisContext,
  symbol: ts.Symbol,
  stack: Set<number> = new Set(),
): VarianceAnnotationDiagnosticDetails | undefined {
  const typeParameters = getSymbolTypeParameterDeclarations(symbol);
  if (typeParameters.length === 0) {
    return undefined;
  }

  const annotatedDeclarations = getVarianceAnnotatedDeclarations(context, symbol);
  if (annotatedDeclarations.length === 0) {
    return undefined;
  }

  const declarationName = symbol.getName();
  const parameterNames = typeParameters.map((parameter) => parameter.name.text);
  const safeExample = formatTotalInvariantVarianceContract(parameterNames) ??
    '// #[variance(T: inout)]';

  if (annotatedDeclarations.length > 1) {
    return {
      code: SOUND_DIAGNOSTIC_CODES.invalidVarianceAnnotation,
      message: SOUND_DIAGNOSTIC_MESSAGES.invalidVarianceAnnotation,
      metadata: {
        rule: 'invalid_variance_annotation',
        fixability: 'boundary_annotation',
        invariant:
          'A checked variance contract must appear on at most one merged declaration and must describe the entire generic surface.',
        replacementFamily: 'checked_variance_annotation',
        primarySymbol: declarationName,
        secondarySymbol: safeExample,
        evidence: [
          { label: 'declarationName', value: declarationName },
          { label: 'typeParameters', value: parameterNames.join(', ') },
          { label: 'annotationSites', value: String(annotatedDeclarations.length) },
        ],
        counterexample:
          'Multiple checked variance contracts on one merged symbol can disagree about the generic surface and make the declaration look more precisely proved than it is.',
        example:
          `Keep a single checked contract on the merged declaration, for example ${safeExample}.`,
      },
      notes: [
        `Merged generic declarations for \`${declarationName}\` may carry \`#[variance(...)]\` on only one declaration.`,
        `Example: Keep a single checked contract on the merged declaration, for example ${safeExample}.`,
      ],
      hint:
        'Keep a single checked variance contract on the merged symbol, or remove the duplicate annotations.',
    };
  }

  const [annotatedDeclaration] = annotatedDeclarations;
  if (!annotatedDeclaration) {
    return undefined;
  }

  const annotation = getVarianceAnnotation(context, annotatedDeclaration);
  const parsedContract = parseVarianceAnnotationContract(parameterNames, annotation?.arguments);
  if ('message' in parsedContract) {
    const contractText = annotation?.argumentsText ?? '(missing)';
    return {
      code: SOUND_DIAGNOSTIC_CODES.invalidVarianceAnnotation,
      message: `${SOUND_DIAGNOSTIC_MESSAGES.invalidVarianceAnnotation} ${parsedContract.message}`,
      metadata: {
        rule: 'invalid_variance_annotation',
        fixability: 'boundary_annotation',
        invariant:
          'Checked variance contracts must mention every type parameter exactly once using supported variance keywords and must describe the whole generic surface.',
        replacementFamily: 'checked_variance_annotation',
        primarySymbol: declarationName,
        secondarySymbol: safeExample,
        evidence: [
          { label: 'declarationName', value: declarationName },
          { label: 'typeParameters', value: parameterNames.join(', ') },
          { label: 'contractText', value: contractText },
          { label: 'parseError', value: parsedContract.message },
        ],
        counterexample:
          'A malformed checked variance contract can overclaim how generic arguments may vary even though the declaration surface has not proved that story.',
        example:
          `Start with a total contract such as \`${safeExample}\`, then tighten each direction only when the declaration surface proves it.`,
      },
      notes: [
        `\`#[variance(...)]\` on \`${declarationName}\` must mention every type parameter exactly once in a checked total contract.`,
        `Contract issue: ${parsedContract.message}`,
        `Example: Start with a total contract such as \`${safeExample}\`, then tighten each direction only when the declaration surface proves it.`,
      ],
      hint:
        'Rewrite the contract so every type parameter appears exactly once with `in`, `out`, `inout`, or `independent`.',
    };
  }

  const provenVariances = getProvenGenericVariances(context, symbol, stack);
  const mismatchNotes = getVarianceAnnotationMismatchNotes(
    parsedContract.variances,
    provenVariances,
    parameterNames,
  );
  if (mismatchNotes.length === 0) {
    return undefined;
  }

  const provenContract = formatVarianceAnnotationContract(parameterNames, provenVariances);
  const mismatchingParameters = parsedContract.variances.flatMap((annotatedVariance, index) => {
    const provenVariance = provenVariances[index];
    if (!provenVariance || annotatedVariance === provenVariance) {
      return [];
    }

    return [{
      parameterName: parameterNames[index] ?? `T${index}`,
      provenVariance,
    }];
  });

  const notes = [...mismatchNotes];
  if (provenContract) {
    if (mismatchingParameters.length === 1) {
      const mismatch = mismatchingParameters[0];
      if (mismatch) {
        notes.push(
          `Update the checked contract to \`${provenContract}\`, or ${
            describeVarianceRewriteGuidance(mismatch.parameterName, mismatch.provenVariance)
          }`,
        );
      }
    } else {
      notes.push(
        `Update the checked contract to \`${provenContract}\`, or rewrite the declaration so the intended variance becomes provable.`,
      );
    }
  }

  return {
    code: SOUND_DIAGNOSTIC_CODES.varianceAnnotationMismatch,
    message: SOUND_DIAGNOSTIC_MESSAGES.varianceAnnotationMismatch,
    metadata: {
      rule: 'variance_annotation_mismatch',
      fixability: 'boundary_annotation',
      invariant:
        'Checked variance annotations must match the variance that soundscript can prove from the declaration surface.',
      replacementFamily: 'checked_variance_annotation',
      primarySymbol: symbol.getName(),
      secondarySymbol: provenContract,
      evidence: mismatchingParameters.map((mismatch) =>
        createVarianceEvidence(
          `parameter ${mismatch.parameterName}`,
          `annotated ${
            genericVarianceToAnnotationKeyword(
              parsedContract.variances[parameterNames.indexOf(mismatch.parameterName)] ??
                'invariant',
            )
          }, proven ${genericVarianceToAnnotationKeyword(mismatch.provenVariance)}`,
        )
      ),
      example: provenContract,
    },
    notes,
    hint:
      'Make the checked contract match the proven variance, or change the declaration surface until the desired variance is actually provable.',
  };
}

function getVarianceDiagnosticNode(
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
): ts.Node {
  return declaration.name ?? declaration;
}

function collectVarianceAnnotationDiagnosticsForSymbol(
  context: AnalysisContext,
  symbol: ts.Symbol,
): readonly SoundDiagnostic[] {
  const typeParameters = getSymbolTypeParameterDeclarations(symbol);
  if (typeParameters.length === 0) {
    return [];
  }

  const annotationDetails = getVarianceAnnotationDiagnosticDetailsForSymbol(context, symbol);
  if (!annotationDetails) {
    return [];
  }

  const annotatedDeclarations = getVarianceAnnotatedDeclarations(context, symbol);
  const [annotatedDeclaration] = annotatedDeclarations;
  if (!annotatedDeclaration) {
    return [];
  }

  return [
    createVarianceAnnotationDiagnostic(
      getVarianceDiagnosticNode(annotatedDeclaration),
      annotationDetails.code,
      annotationDetails.message,
      annotationDetails.notes,
      annotationDetails.hint,
      annotationDetails.metadata,
    ),
  ];
}

function getTypeReferenceOrExpressionSymbol(
  context: AnalysisContext,
  node: ts.EntityName | ts.Expression,
): ts.Symbol | undefined {
  if (ts.isIdentifier(node)) {
    return resolveAliasedSymbol(context, context.checker.getSymbolAtLocation(node));
  }

  if (ts.isQualifiedName(node)) {
    return resolveAliasedSymbol(context, context.checker.getSymbolAtLocation(node.right));
  }

  if (ts.isPropertyAccessExpression(node)) {
    return resolveAliasedSymbol(context, context.checker.getSymbolAtLocation(node.name));
  }

  return resolveAliasedSymbol(context, context.checker.getSymbolAtLocation(node));
}

function resolveAliasedSymbol(
  context: AnalysisContext,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) {
    return symbol;
  }

  return context.checker.getAliasedSymbol(symbol) ?? symbol;
}

function isRelationReferenceTypeNode(
  node: ts.Node,
): node is ts.ImportTypeNode | ts.TypeReferenceNode {
  return ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node);
}

function getRelationReferenceTypeNodeSymbol(
  context: AnalysisContext,
  node: ts.ImportTypeNode | ts.TypeReferenceNode,
): ts.Symbol | undefined {
  if (ts.isTypeReferenceNode(node)) {
    return getTypeReferenceOrExpressionSymbol(context, node.typeName);
  }

  if (node.isTypeOf) {
    return undefined;
  }

  if (node.qualifier) {
    return getTypeReferenceOrExpressionSymbol(context, node.qualifier);
  }

  const importType = context.checker.getTypeFromTypeNode(node);
  return resolveAliasedSymbol(
    context,
    (importType as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol ??
      getTypeReferenceSymbol(importType) ??
      importType.getSymbol(),
  );
}

function addGenericVarianceOccurrence(
  context: AnalysisContext,
  inference: GenericVarianceInferenceContext,
  symbol: ts.Symbol | undefined,
  polarity: number,
): void {
  if (!symbol) {
    return;
  }

  const parameterIndex = inference.parameterIndicesBySymbolId.get(context.getSymbolId(symbol));
  if (parameterIndex === undefined) {
    return;
  }

  const current = inference.variances[parameterIndex] ?? 'independent';
  inference.variances[parameterIndex] = combineGenericVariance(current, polarity);
}

function getSymbolTypeParameterDeclarations(
  symbol: ts.Symbol,
): readonly ts.TypeParameterDeclaration[] {
  const declarations = symbol.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isClassDeclaration(declaration) ||
      ts.isClassExpression(declaration)
    ) {
      return declaration.typeParameters ?? [];
    }
  }

  return [];
}

function getSymbolTypeParameterSymbols(
  context: AnalysisContext,
  symbol: ts.Symbol,
): readonly ts.Symbol[] {
  return getSymbolTypeParameterDeclarations(symbol)
    .map((parameter) => context.checker.getSymbolAtLocation(parameter.name))
    .filter((parameter): parameter is ts.Symbol => parameter !== undefined);
}

function substituteBaseTypeArguments(
  context: AnalysisContext,
  sourceSymbol: ts.Symbol,
  sourceTypeArguments: readonly ts.Type[],
  baseTypeArguments: readonly ts.Type[],
): readonly ts.Type[] {
  const sourceTypeParameterSymbols = getSymbolTypeParameterSymbols(context, sourceSymbol);
  if (
    sourceTypeParameterSymbols.length === 0 ||
    sourceTypeParameterSymbols.length !== sourceTypeArguments.length
  ) {
    return baseTypeArguments;
  }

  const sourceTypeParameterIndexes = new Map<number, number>();
  for (const [index, parameterSymbol] of sourceTypeParameterSymbols.entries()) {
    sourceTypeParameterIndexes.set(context.getSymbolId(parameterSymbol), index);
  }

  return baseTypeArguments.map((typeArgument) => {
    const parameterSymbol = typeArgument.getSymbol();
    if (!parameterSymbol) {
      return typeArgument;
    }

    const parameterIndex = sourceTypeParameterIndexes.get(context.getSymbolId(parameterSymbol));
    return parameterIndex === undefined
      ? typeArgument
      : sourceTypeArguments[parameterIndex] ?? typeArgument;
  });
}

function isProvablyInferrableGenericAliasType(
  context: AnalysisContext,
  type: ts.TypeNode,
  visitedSymbols: Set<number> = new Set(),
): boolean {
  if (isRelationReferenceTypeNode(type)) {
    const symbol = getRelationReferenceTypeNodeSymbol(context, type);
    const declarations = symbol?.getDeclarations() ?? [];
    if (symbol && declarations.some(ts.isTypeAliasDeclaration)) {
      const symbolId = context.getSymbolId(symbol);
      if (!visitedSymbols.has(symbolId)) {
        visitedSymbols.add(symbolId);
        for (const declaration of declarations) {
          if (!ts.isTypeAliasDeclaration(declaration)) {
            continue;
          }
          if (!isProvablyInferrableGenericAliasType(context, declaration.type, visitedSymbols)) {
            return false;
          }
        }
      }
    }

    return (type.typeArguments ?? []).every((typeArgument) =>
      isProvablyInferrableGenericAliasType(context, typeArgument, visitedSymbols)
    );
  }

  if (ts.isParenthesizedTypeNode(type)) {
    return isProvablyInferrableGenericAliasType(context, type.type, visitedSymbols);
  }

  if (ts.isOptionalTypeNode(type)) {
    return isProvablyInferrableGenericAliasType(context, type.type, visitedSymbols);
  }

  if (ts.isRestTypeNode(type)) {
    return isProvablyInferrableGenericAliasType(context, type.type, visitedSymbols);
  }

  if (ts.isArrayTypeNode(type)) {
    return isProvablyInferrableGenericAliasType(context, type.elementType, visitedSymbols);
  }

  if (ts.isTupleTypeNode(type)) {
    return type.elements.every((element) => {
      const elementType = ts.isNamedTupleMember(element) ? element.type : element;
      return isProvablyInferrableGenericAliasType(context, elementType, visitedSymbols);
    });
  }

  if (ts.isTypeOperatorNode(type)) {
    return type.operator === ts.SyntaxKind.ReadonlyKeyword &&
      isProvablyInferrableGenericAliasType(context, type.type, visitedSymbols);
  }

  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.every((child) =>
      isProvablyInferrableGenericAliasType(context, child, visitedSymbols)
    );
  }

  if (ts.isTypeLiteralNode(type)) {
    return type.members.every((member) => {
      if (ts.isPropertySignature(member)) {
        return !member.type ||
          isProvablyInferrableGenericAliasType(context, member.type, visitedSymbols);
      }
      if (
        ts.isMethodSignature(member) || ts.isCallSignatureDeclaration(member) ||
        ts.isConstructSignatureDeclaration(member)
      ) {
        return member.parameters.every((parameter) =>
          !parameter.type ||
          isProvablyInferrableGenericAliasType(context, parameter.type, visitedSymbols)
        ) &&
          (!member.type ||
            isProvablyInferrableGenericAliasType(context, member.type, visitedSymbols));
      }
      if (ts.isIndexSignatureDeclaration(member)) {
        return member.parameters.every((parameter) =>
          !parameter.type ||
          isProvablyInferrableGenericAliasType(context, parameter.type, visitedSymbols)
        ) &&
          (!member.type ||
            isProvablyInferrableGenericAliasType(context, member.type, visitedSymbols));
      }
      return true;
    });
  }

  if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) {
    return type.parameters.every((parameter) =>
      !parameter.type ||
      isProvablyInferrableGenericAliasType(context, parameter.type, visitedSymbols)
    ) &&
      (!type.type || isProvablyInferrableGenericAliasType(context, type.type, visitedSymbols));
  }

  if (
    ts.isConditionalTypeNode(type) ||
    ts.isIndexedAccessTypeNode(type) ||
    ts.isMappedTypeNode(type)
  ) {
    return false;
  }

  if (ts.isTypePredicateNode(type)) {
    return !type.type || isProvablyInferrableGenericAliasType(context, type.type, visitedSymbols);
  }

  return true;
}

function getOrInferGenericVariances(
  context: AnalysisContext,
  symbol: ts.Symbol,
  stack: Set<number> = new Set(),
): readonly GenericVariance[] {
  const cache = getContextInferredGenericVarianceCache(context);
  const symbolId = context.getSymbolId(symbol);
  const cached = cache.get(symbolId);
  if (cached) {
    return cached;
  }

  const typeParameters = getSymbolTypeParameterDeclarations(symbol);
  if (typeParameters.length === 0) {
    cache.set(symbolId, []);
    return [];
  }

  if (stack.has(symbolId)) {
    const annotatedVariances = getAnnotatedGenericVariances(context, symbol);
    if (annotatedVariances && annotatedVariances.length === typeParameters.length) {
      return annotatedVariances;
    }

    const recursiveFallback = typeParameters.map(() => 'invariant' as const);
    return recursiveFallback;
  }
  stack.add(symbolId);

  const parameterIndicesBySymbolId = new Map<number, number>();
  const parameterNames = typeParameters.map((parameter) => parameter.name.text);
  for (const [index, parameter] of typeParameters.entries()) {
    const parameterSymbol = context.checker.getSymbolAtLocation(parameter.name);
    if (parameterSymbol) {
      parameterIndicesBySymbolId.set(context.getSymbolId(parameterSymbol), index);
    }
  }

  const inference: GenericVarianceInferenceContext = {
    parameterIndicesBySymbolId,
    parameterNames,
    stack,
    variances: typeParameters.map(() => 'independent' as const),
  };

  for (const declaration of symbol.getDeclarations() ?? []) {
    if (ts.isInterfaceDeclaration(declaration)) {
      for (const heritageClause of declaration.heritageClauses ?? []) {
        for (const type of heritageClause.types) {
          inferTypeNodeVariances(context, inference, type, VARIANCE_POLARITY_COVARIANT);
        }
      }
      for (const member of declaration.members) {
        inferMemberVariances(
          context,
          inference,
          member,
          VARIANCE_POLARITY_COVARIANT,
        );
      }
      continue;
    }

    if (ts.isClassDeclaration(declaration)) {
      for (const heritageClause of declaration.heritageClauses ?? []) {
        for (const type of heritageClause.types) {
          inferTypeNodeVariances(context, inference, type, VARIANCE_POLARITY_COVARIANT);
        }
      }
      for (const member of declaration.members) {
        inferClassMemberVariances(
          context,
          inference,
          member,
          VARIANCE_POLARITY_COVARIANT,
        );
      }
      continue;
    }

    if (ts.isTypeAliasDeclaration(declaration)) {
      if (!isProvablyInferrableGenericAliasType(context, declaration.type)) {
        stack.delete(symbolId);
        cache.set(symbolId, []);
        return [];
      }
      inferTypeNodeVariances(context, inference, declaration.type, VARIANCE_POLARITY_COVARIANT);
    }
  }

  stack.delete(symbolId);
  cache.set(symbolId, inference.variances);
  return inference.variances;
}

function inferMemberVariances(
  context: AnalysisContext,
  inference: GenericVarianceInferenceContext,
  member: ts.TypeElement,
  polarity: number,
): void {
  if (ts.isPropertySignature(member)) {
    if (member.type) {
      inferTypeNodeVariances(context, inference, member.type, polarity);
      if (!hasReadonlyModifier(member)) {
        inferTypeNodeVariances(
          context,
          inference,
          member.type,
          flipVariancePolarity(polarity),
        );
      }
    }
    return;
  }

  if (
    ts.isMethodSignature(member) || ts.isCallSignatureDeclaration(member) ||
    ts.isConstructSignatureDeclaration(member)
  ) {
    inferSignatureDeclarationVariances(context, inference, member, polarity);
    return;
  }

  if (ts.isIndexSignatureDeclaration(member)) {
    if (member.type) {
      inferTypeNodeVariances(context, inference, member.type, polarity);
      if (!hasReadonlyModifier(member)) {
        inferTypeNodeVariances(
          context,
          inference,
          member.type,
          flipVariancePolarity(polarity),
        );
      }
    }
  }
}

function inferClassMemberVariances(
  context: AnalysisContext,
  inference: GenericVarianceInferenceContext,
  member: ts.ClassElement,
  polarity: number,
): void {
  if (hasStaticModifier(member)) {
    return;
  }

  if (ts.isPropertyDeclaration(member)) {
    if (member.type) {
      inferTypeNodeVariances(context, inference, member.type, polarity);
      if (!hasReadonlyModifier(member)) {
        inferTypeNodeVariances(
          context,
          inference,
          member.type,
          flipVariancePolarity(polarity),
        );
      }
    }
    return;
  }

  if (ts.isMethodDeclaration(member)) {
    inferSignatureDeclarationVariances(context, inference, member, polarity);
    return;
  }

  if (ts.isGetAccessorDeclaration(member)) {
    inferSignatureDeclarationVariances(context, inference, member, polarity);
    return;
  }

  if (ts.isSetAccessorDeclaration(member)) {
    inferSignatureDeclarationVariances(context, inference, member, polarity);
  }
}

function inferSignatureDeclarationVariances(
  context: AnalysisContext,
  inference: GenericVarianceInferenceContext,
  declaration:
    | ts.MethodDeclaration
    | ts.MethodSignature
    | ts.CallSignatureDeclaration
    | ts.ConstructSignatureDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.FunctionTypeNode
    | ts.ConstructorTypeNode,
  polarity: number,
): void {
  for (const parameter of declaration.parameters) {
    if (parameter.type) {
      inferTypeNodeVariances(
        context,
        inference,
        parameter.type,
        flipVariancePolarity(polarity),
      );
    }
  }

  if (declaration.type) {
    inferTypeNodeVariances(context, inference, declaration.type, polarity);
  }
}

function inferTypeNodeVariances(
  context: AnalysisContext,
  inference: GenericVarianceInferenceContext,
  node: ts.Node | undefined,
  polarity: number,
): void {
  if (!node) {
    return;
  }

  if (
    ts.isTypeReferenceNode(node) ||
    ts.isImportTypeNode(node) ||
    ts.isExpressionWithTypeArguments(node)
  ) {
    const symbol = ts.isExpressionWithTypeArguments(node)
      ? getTypeReferenceOrExpressionSymbol(context, node.expression)
      : getRelationReferenceTypeNodeSymbol(context, node);
    addGenericVarianceOccurrence(context, inference, symbol, polarity);

    const typeArguments = node.typeArguments ?? [];
    if (typeArguments.length === 0) {
      return;
    }

    if (symbol && isGenericClassSymbol(symbol)) {
      const variances = getResolvedGenericVariances(context, symbol, new Set(inference.stack));
      if (variances.length === typeArguments.length) {
        for (const [index, typeArgument] of typeArguments.entries()) {
          const variance = variances[index];
          if (!variance) {
            inferTypeNodeVariances(
              context,
              inference,
              typeArgument,
              VARIANCE_POLARITY_INVARIANT,
            );
            continue;
          }

          const composedPolarity = composeVariancePolarity(polarity, variance);
          if (composedPolarity !== undefined) {
            inferTypeNodeVariances(context, inference, typeArgument, composedPolarity);
          }
        }
        return;
      }

      for (const typeArgument of typeArguments) {
        inferTypeNodeVariances(context, inference, typeArgument, VARIANCE_POLARITY_INVARIANT);
      }
      return;
    }

    const syntheticTypeInfo = symbol
      ? ({
        kind: ts.isExpressionWithTypeArguments(node) ? 'reference' : 'reference',
        name: symbol.getName(),
        symbol,
        typeArguments: [],
      } satisfies GenericRelationTypeInfo)
      : undefined;
    const referencedVariances = syntheticTypeInfo
      ? getResolvedGenericVariances(context, symbol!, inference.stack)
      : [];

    if (referencedVariances.length === typeArguments.length) {
      for (const [index, typeArgument] of typeArguments.entries()) {
        const childPolarity = composeVariancePolarity(
          polarity,
          referencedVariances[index] ?? 'invariant',
        );
        if (childPolarity !== undefined) {
          inferTypeNodeVariances(context, inference, typeArgument, childPolarity);
        }
      }
      return;
    }

    for (const typeArgument of typeArguments) {
      inferTypeNodeVariances(context, inference, typeArgument, VARIANCE_POLARITY_INVARIANT);
    }
    return;
  }

  if (ts.isParenthesizedTypeNode(node)) {
    inferTypeNodeVariances(context, inference, node.type, polarity);
    return;
  }

  if (ts.isArrayTypeNode(node)) {
    inferTypeNodeVariances(context, inference, node.elementType, VARIANCE_POLARITY_INVARIANT);
    return;
  }

  if (ts.isTupleTypeNode(node)) {
    const isReadonlyTuple = 'readonlyToken' in node && node.readonlyToken !== undefined ||
      (ts.isTypeOperatorNode(node.parent) &&
        node.parent.operator === ts.SyntaxKind.ReadonlyKeyword);
    const tuplePolarity = isReadonlyTuple ? polarity : VARIANCE_POLARITY_INVARIANT;
    for (const element of node.elements) {
      inferTypeNodeVariances(context, inference, element, tuplePolarity);
    }
    return;
  }

  if (ts.isTypeOperatorNode(node)) {
    if (node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      inferTypeNodeVariances(context, inference, node.type, polarity);
      return;
    }
    inferTypeNodeVariances(context, inference, node.type, VARIANCE_POLARITY_INVARIANT);
    return;
  }

  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const type of node.types) {
      inferTypeNodeVariances(context, inference, type, polarity);
    }
    return;
  }

  if (ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      inferMemberVariances(context, inference, member, polarity);
    }
    return;
  }

  if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node)) {
    inferSignatureDeclarationVariances(context, inference, node, polarity);
    return;
  }

  if (
    ts.isConditionalTypeNode(node) ||
    ts.isIndexedAccessTypeNode(node) ||
    ts.isMappedTypeNode(node)
  ) {
    for (const child of node.getChildren()) {
      inferTypeNodeVariances(context, inference, child, VARIANCE_POLARITY_INVARIANT);
    }
    return;
  }

  if (ts.isTypePredicateNode(node)) {
    if (node.type) {
      inferTypeNodeVariances(context, inference, node.type, polarity);
    }
    return;
  }

  node.forEachChild((child) => {
    inferTypeNodeVariances(context, inference, child, polarity);
  });
}

function isGenericClassSymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) {
    return false;
  }

  return isClassSymbol(symbol) &&
    (symbol.getDeclarations() ?? []).some((declaration) =>
      ts.isClassLike(declaration) && (declaration.typeParameters?.length ?? 0) > 0
    );
}

function isClassSymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) {
    return false;
  }

  return (symbol.getDeclarations() ?? []).some((declaration) => ts.isClassLike(declaration));
}

function areExactTypeArguments(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): boolean {
  const sourceTypeId = (sourceType as ts.Type & { id?: number }).id;
  const targetTypeId = (targetType as ts.Type & { id?: number }).id;
  if (typeof sourceTypeId === 'number' && typeof targetTypeId === 'number') {
    if (sourceTypeId === targetTypeId) {
      return true;
    }
  }

  return sourceType === targetType ||
    context.checker.typeToString(sourceType) === context.checker.typeToString(targetType);
}

function hasExactPureIndexSignatureSurface(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): boolean {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);
  if (
    !isInspectableObjectType(normalizedSourceType) ||
    !isInspectableObjectType(normalizedTargetType)
  ) {
    return false;
  }

  if (
    context.checker.getPropertiesOfType(normalizedSourceType).length > 0 ||
    context.checker.getPropertiesOfType(normalizedTargetType).length > 0 ||
    normalizedSourceType.getCallSignatures().length > 0 ||
    normalizedSourceType.getConstructSignatures().length > 0 ||
    normalizedTargetType.getCallSignatures().length > 0 ||
    normalizedTargetType.getConstructSignatures().length > 0
  ) {
    return false;
  }

  let sawIndexSignature = false;
  for (const kind of [ts.IndexKind.String, ts.IndexKind.Number]) {
    const sourceIndexInfo = context.checker.getIndexInfoOfType(normalizedSourceType, kind);
    const targetIndexInfo = context.checker.getIndexInfoOfType(normalizedTargetType, kind);
    if (!sourceIndexInfo && !targetIndexInfo) {
      continue;
    }
    if (!sourceIndexInfo || !targetIndexInfo) {
      return false;
    }
    if (
      sourceIndexInfo.isReadonly !== targetIndexInfo.isReadonly ||
      !areExactTypeArguments(context, sourceIndexInfo.type, targetIndexInfo.type)
    ) {
      return false;
    }
    sawIndexSignature = true;
  }

  return sawIndexSignature;
}

function areExactRelationBranchTypes(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): boolean {
  return areExactTypeArguments(context, sourceType, targetType) ||
    hasExactPureIndexSignatureSurface(context, sourceType, targetType);
}

function getRelationReferenceTypeArguments(
  context: AnalysisContext,
  node: ts.ImportTypeNode | ts.TypeReferenceNode,
): readonly ts.Type[] {
  return (node.typeArguments ?? []).map((typeArgument) =>
    context.checker.getTypeFromTypeNode(typeArgument)
  );
}

function getRelationReferenceTypeArgumentNodes(
  node: ts.ImportTypeNode | ts.TypeReferenceNode,
): readonly ts.TypeNode[] {
  return node.typeArguments ?? [];
}

function getMatchingGenericRelationTypeArguments(
  context: AnalysisContext,
  type: ts.Type,
  relationSymbol: ts.Symbol,
): readonly ts.Type[] | undefined {
  const relationInfo = getGenericRelationTypeInfo(
    context,
    getSafeNonNullableRelationType(context, type),
  );
  if (!relationInfo || relationInfo.symbol !== relationSymbol) {
    return undefined;
  }

  return relationInfo.typeArguments;
}

function getReferenceLikeTypeNodeFromTypedDeclaration(
  declaration: ts.Declaration,
): ts.ImportTypeNode | ts.TypeReferenceNode | undefined {
  const typeNode = getTypeNodeFromTypedDeclaration(declaration);
  return typeNode && (ts.isTypeReferenceNode(typeNode) || ts.isImportTypeNode(typeNode))
    ? typeNode
    : undefined;
}

function getTypeNodeFromTypedDeclaration(
  declaration: ts.Declaration,
): ts.TypeNode | undefined {
  return ts.isVariableDeclaration(declaration) ||
      ts.isParameter(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration)
    ? declaration.type
    : undefined;
}

function getDeclaredTypeNodeFromExpression(
  context: AnalysisContext,
  expression: ts.Expression | undefined,
): ts.TypeNode | undefined {
  if (!expression) {
    return undefined;
  }

  const unwrappedExpression = unwrapRelationExpression(expression);
  const getTypeNodeFromTypedSymbol = (symbol: ts.Symbol | undefined): ts.TypeNode | undefined => {
    const resolvedSymbol = getResolvedAliasSymbol(context, symbol);
    if (!resolvedSymbol) {
      return undefined;
    }

    for (const declaration of resolvedSymbol.getDeclarations() ?? []) {
      const typeNode = getTypeNodeFromTypedDeclaration(declaration);
      if (typeNode) {
        return typeNode;
      }
    }

    return undefined;
  };

  if (ts.isIdentifier(unwrappedExpression)) {
    return getTypeNodeFromTypedSymbol(context.checker.getSymbolAtLocation(unwrappedExpression));
  }

  if (ts.isPropertyAccessExpression(unwrappedExpression)) {
    return getTypeNodeFromTypedSymbol(
      context.checker.getSymbolAtLocation(unwrappedExpression.name),
    );
  }

  if (ts.isCallExpression(unwrappedExpression) || ts.isNewExpression(unwrappedExpression)) {
    const signature = context.checker.getResolvedSignature(unwrappedExpression);
    const returnTypeNode = signature ? getSignatureReturnTypeNode(signature) : undefined;
    return returnTypeNode && !typeNodeContainsTypeParameterReference(context, returnTypeNode)
      ? returnTypeNode
      : undefined;
  }

  return undefined;
}

function getDeclaredGenericAliasTypeArgumentsFromTypeNode(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
  relationSymbol: ts.Symbol,
): readonly ts.Type[] | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(typeNode);
  if (!unwrappedTypeNode || !isRelationReferenceTypeNode(unwrappedTypeNode)) {
    return undefined;
  }

  const typeReferenceSymbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, unwrappedTypeNode),
  );
  if (typeReferenceSymbol !== relationSymbol) {
    return undefined;
  }

  return getRelationReferenceTypeArguments(context, unwrappedTypeNode);
}

function getDeclaredGenericAliasTypeArgumentNodesFromTypeNode(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
  relationSymbol: ts.Symbol,
): readonly ts.TypeNode[] | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(typeNode);
  if (!unwrappedTypeNode || !isRelationReferenceTypeNode(unwrappedTypeNode)) {
    return undefined;
  }

  const typeReferenceSymbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, unwrappedTypeNode),
  );
  if (typeReferenceSymbol !== relationSymbol) {
    return undefined;
  }

  return unwrappedTypeNode.typeArguments;
}

function getDeclaredGenericAliasTypeArgumentsFromExpression(
  context: AnalysisContext,
  expression: ts.Expression | undefined,
  relationSymbol: ts.Symbol,
): readonly ts.Type[] | undefined {
  if (!expression) {
    return undefined;
  }

  const unwrappedExpression = unwrapRelationExpression(expression);
  const symbol = ts.isIdentifier(unwrappedExpression)
    ? context.checker.getSymbolAtLocation(unwrappedExpression)
    : ts.isPropertyAccessExpression(unwrappedExpression)
    ? context.checker.getSymbolAtLocation(unwrappedExpression.name)
    : undefined;
  if (!symbol) {
    return undefined;
  }

  for (const declaration of symbol.getDeclarations() ?? []) {
    const typeReferenceNode = getReferenceLikeTypeNodeFromTypedDeclaration(declaration);
    if (!typeReferenceNode) {
      continue;
    }

    const typeReferenceSymbol = getResolvedAliasSymbol(
      context,
      getRelationReferenceTypeNodeSymbol(context, typeReferenceNode),
    );
    if (typeReferenceSymbol !== relationSymbol) {
      continue;
    }

    return getRelationReferenceTypeArguments(context, typeReferenceNode);
  }

  const expressionType = normalizeTransparentRelationType(
    context,
    context.checker.getTypeAtLocation(unwrappedExpression),
  );
  const expressionAliasSymbol = getResolvedAliasSymbol(
    context,
    (expressionType as ts.Type & { aliasSymbol?: ts.Symbol }).aliasSymbol,
  );
  if (expressionAliasSymbol === relationSymbol) {
    const aliasTypeArguments = getAliasTypeArguments(expressionType);
    if (aliasTypeArguments.length > 0) {
      return aliasTypeArguments;
    }
  }

  const matchingRelationTypeArguments = getMatchingGenericRelationTypeArguments(
    context,
    expressionType,
    relationSymbol,
  );
  if (matchingRelationTypeArguments?.length) {
    return matchingRelationTypeArguments;
  }

  return undefined;
}

function getDeclaredGenericAliasTypeArgumentNodesFromExpression(
  context: AnalysisContext,
  expression: ts.Expression | undefined,
  relationSymbol: ts.Symbol,
): readonly ts.TypeNode[] | undefined {
  if (!expression) {
    return undefined;
  }

  const unwrappedExpression = unwrapRelationExpression(expression);
  const symbol = ts.isIdentifier(unwrappedExpression)
    ? context.checker.getSymbolAtLocation(unwrappedExpression)
    : ts.isPropertyAccessExpression(unwrappedExpression)
    ? context.checker.getSymbolAtLocation(unwrappedExpression.name)
    : undefined;
  if (!symbol) {
    return undefined;
  }

  for (const declaration of symbol.getDeclarations() ?? []) {
    const typeReferenceNode = getReferenceLikeTypeNodeFromTypedDeclaration(declaration);
    if (!typeReferenceNode) {
      continue;
    }

    const typeReferenceSymbol = getResolvedAliasSymbol(
      context,
      getRelationReferenceTypeNodeSymbol(context, typeReferenceNode),
    );
    if (typeReferenceSymbol !== relationSymbol) {
      continue;
    }

    return typeReferenceNode.typeArguments;
  }

  return undefined;
}

function isRelationCarrierTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  const unwrappedTypeNode = unwrapRelationTypeNode(typeNode);
  return !!unwrappedTypeNode && (
    ts.isUnionTypeNode(unwrappedTypeNode) ||
    ts.isIntersectionTypeNode(unwrappedTypeNode) ||
    ts.isTupleTypeNode(unwrappedTypeNode) ||
    ts.isArrayTypeNode(unwrappedTypeNode) ||
    (
      ts.isTypeReferenceNode(unwrappedTypeNode) &&
      ts.isIdentifier(unwrappedTypeNode.typeName) &&
      (
        unwrappedTypeNode.typeName.text === 'Array' ||
        unwrappedTypeNode.typeName.text === 'ReadonlyArray'
      )
    ) ||
    (
      ts.isTypeOperatorNode(unwrappedTypeNode) &&
      unwrappedTypeNode.operator === ts.SyntaxKind.ReadonlyKeyword &&
      isRelationCarrierTypeNode(unwrappedTypeNode.type)
    ) ||
    ts.isTypeLiteralNode(unwrappedTypeNode) ||
    ts.isFunctionTypeNode(unwrappedTypeNode) ||
    ts.isConstructorTypeNode(unwrappedTypeNode)
  );
}

function isExpandableOrdinaryRelationAliasSymbol(
  context: AnalysisContext,
  symbol: ts.Symbol,
): boolean {
  const declarations = symbol.getDeclarations() ?? [];
  if (!declarations.some(ts.isTypeAliasDeclaration)) {
    return false;
  }

  const allDeclarationsAreDts = declarations.length > 0 &&
    declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile);
  const allDeclarationsAreTrustedSoundLibs = declarations.length > 0 &&
    declarations.every((declaration) => isTrustedSoundLibSourceFile(declaration.getSourceFile()));
  if (allDeclarationsAreDts && !allDeclarationsAreTrustedSoundLibs) {
    return false;
  }

  if (allDeclarationsAreTrustedSoundLibs) {
    return false;
  }

  return getVarianceAnnotatedDeclarations(context, symbol).length === 0;
}

function expandOrdinaryRelationCarrierTypeNode(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
  seenSymbols: Set<number> = new Set(),
): ts.TypeNode | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(typeNode);
  if (!unwrappedTypeNode || !isRelationReferenceTypeNode(unwrappedTypeNode)) {
    return undefined;
  }

  const symbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, unwrappedTypeNode),
  );
  if (!symbol) {
    return undefined;
  }

  const symbolId = context.getSymbolId(symbol);
  if (seenSymbols.has(symbolId)) {
    return undefined;
  }

  if (!isExpandableOrdinaryRelationAliasSymbol(context, symbol)) {
    return undefined;
  }

  const declarations = symbol.getDeclarations() ?? [];
  const aliasDeclaration = declarations.find(ts.isTypeAliasDeclaration);
  if (!aliasDeclaration) {
    return undefined;
  }

  const substitutions = getTypeParameterSubstitutionMap(
    context,
    unwrappedTypeNode.typeArguments,
    symbol,
  );
  if (!substitutions) {
    return undefined;
  }

  seenSymbols.add(symbolId);
  const expandedTypeNode = substituteTypeParameterTypeNodes(
    context,
    aliasDeclaration.type,
    substitutions,
  );
  const expandedWrapperPayloadTypeNode = (
      ts.isTypeReferenceNode(expandedTypeNode) || ts.isImportTypeNode(expandedTypeNode)
    )
    ? getTransparentRelationWrapperPayloadTypeNode(context, expandedTypeNode)
    : undefined;
  const normalizedExpandedTypeNode = expandedWrapperPayloadTypeNode ?? expandedTypeNode;
  const recursivelyExpandedTypeNode = expandOrdinaryRelationCarrierTypeNode(
    context,
    normalizedExpandedTypeNode,
    seenSymbols,
  ) ?? normalizedExpandedTypeNode;
  return isRelationCarrierTypeNode(recursivelyExpandedTypeNode)
    ? recursivelyExpandedTypeNode
    : undefined;
}

function getNewtypeIdentityFromTypeReferenceNode(
  context: AnalysisContext,
  typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
  visitedSymbols: Set<number> = new Set(),
): NewtypeIdentity | undefined {
  return getDeclaredNominalIdentityFromTypeReferenceNode(
    context,
    typeReferenceNode,
    {
      getDeclaredIdentitySetFromTypeNode: getDeclaredNewtypeIdentitySetFromTypeNode,
      isDirectIdentitySymbol: isNewtypeAliasSymbol,
      selectIdentityFromAliasSet: (identitySet) =>
        identitySet?.identities.length === 1 ? identitySet.identities[0] : undefined,
    },
    visitedSymbols,
  );
}

function getNewtypeIdentitySetFromTypeReferenceNode(
  context: AnalysisContext,
  typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
  visitedSymbols: Set<number> = new Set(),
): TargetNewtypeIdentitySet | undefined {
  return getDeclaredNominalIdentitySetFromTypeReferenceNode(
    context,
    typeReferenceNode,
    {
      getDeclaredIdentitySetFromTypeNode: getDeclaredNewtypeIdentitySetFromTypeNode,
      isDirectIdentitySymbol: isNewtypeAliasSymbol,
      selectIdentityFromAliasSet: (identitySet) =>
        identitySet?.identities.length === 1 ? identitySet.identities[0] : undefined,
    },
    visitedSymbols,
  );
}

function getDeclaredNewtypeIdentityFromTypeNode(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
  visitedSymbols: Set<number> = new Set(),
): NewtypeIdentity | undefined {
  const identitySet = getDeclaredNewtypeIdentitySetFromTypeNode(
    context,
    typeNode,
    visitedSymbols,
  );
  return identitySet?.identities.length === 1 ? identitySet.identities[0] : undefined;
}

function isNeverRelationTypeNode(typeNode: ts.TypeNode | undefined): boolean {
  return unwrapRelationTypeNode(typeNode)?.kind === ts.SyntaxKind.NeverKeyword;
}

function isTransparentRelationWrapperName(
  name: string,
): name is TransparentRelationWrapperName {
  return name === 'NoInfer';
}

function getTransparentRelationWrapperPayloadTypeNode(
  context: AnalysisContext,
  typeNode: ts.ImportTypeNode | ts.TypeReferenceNode,
): ts.TypeNode | undefined {
  const wrapperName = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, typeNode),
  )?.getName() ??
    (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)
      ? typeNode.typeName.text
      : undefined);
  return wrapperName && isTransparentRelationWrapperName(wrapperName)
    ? typeNode.typeArguments?.[0]
    : undefined;
}

function appendUniqueNominalIdentity<TIdentity extends NominalIdentityLike>(
  context: AnalysisContext,
  identities: TIdentity[],
  candidate: TIdentity,
  identitiesMatch: (
    context: AnalysisContext,
    left: TIdentity,
    right: TIdentity,
  ) => boolean,
): void {
  if (
    identities.some((existingIdentity) => identitiesMatch(context, existingIdentity, candidate))
  ) {
    return;
  }

  identities.push(candidate);
}

function areEquivalentNominalIdentitySets<TIdentity extends NominalIdentityLike>(
  context: AnalysisContext,
  left: NominalIdentitySet<TIdentity>,
  right: NominalIdentitySet<TIdentity>,
  identitiesMatch: (
    context: AnalysisContext,
    left: TIdentity,
    right: TIdentity,
  ) => boolean,
): boolean {
  return left.mode === right.mode &&
    left.identities.length === right.identities.length &&
    left.identities.every((leftIdentity) =>
      right.identities.some((rightIdentity) =>
        identitiesMatch(context, leftIdentity, rightIdentity)
      )
    );
}

function getDeclaredNominalIdentityFromTypeReferenceNode<TIdentity extends NominalIdentityLike>(
  context: AnalysisContext,
  typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
  options: {
    getDeclaredIdentitySetFromTypeNode: (
      context: AnalysisContext,
      typeNode: ts.TypeNode | undefined,
      visitedSymbols?: Set<number>,
    ) => NominalIdentitySet<TIdentity> | undefined;
    isDirectIdentitySymbol: (context: AnalysisContext, symbol: ts.Symbol) => boolean;
    selectIdentityFromAliasSet: (
      identitySet: NominalIdentitySet<TIdentity> | undefined,
    ) => TIdentity | undefined;
  },
  visitedSymbols: Set<number> = new Set(),
): TIdentity | undefined {
  const identitySet = getDeclaredNominalIdentitySetFromTypeReferenceNode(
    context,
    typeReferenceNode,
    options,
    visitedSymbols,
  );
  return options.selectIdentityFromAliasSet(identitySet);
}

function getDeclaredNominalIdentitySetFromTypeReferenceNode<TIdentity extends NominalIdentityLike>(
  context: AnalysisContext,
  typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
  options: {
    getDeclaredIdentitySetFromTypeNode: (
      context: AnalysisContext,
      typeNode: ts.TypeNode | undefined,
      visitedSymbols?: Set<number>,
    ) => NominalIdentitySet<TIdentity> | undefined;
    isDirectIdentitySymbol: (context: AnalysisContext, symbol: ts.Symbol) => boolean;
    selectIdentityFromAliasSet: (
      identitySet: NominalIdentitySet<TIdentity> | undefined,
    ) => TIdentity | undefined;
  },
  visitedSymbols: Set<number> = new Set(),
): NominalIdentitySet<TIdentity> | undefined {
  const symbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, typeReferenceNode),
  );
  if (!symbol) {
    return undefined;
  }

  const symbolId = context.getSymbolId(symbol);
  if (visitedSymbols.has(symbolId)) {
    return undefined;
  }
  visitedSymbols.add(symbolId);

  if (options.isDirectIdentitySymbol(context, symbol)) {
    return {
      identities: [{
        symbol,
        typeArguments: getRelationReferenceTypeArguments(context, typeReferenceNode),
      } as TIdentity],
      mode: 'single',
    };
  }

  const aliasDeclaration = (symbol.getDeclarations() ?? []).find(ts.isTypeAliasDeclaration);
  if (!aliasDeclaration) {
    return undefined;
  }

  const substitutions = getTypeParameterSubstitutionMap(
    context,
    typeReferenceNode.typeArguments,
    symbol,
  );
  if (!substitutions) {
    return undefined;
  }

  return options.getDeclaredIdentitySetFromTypeNode(
    context,
    substituteTypeParameterTypeNodes(context, aliasDeclaration.type, substitutions),
    visitedSymbols,
  );
}

function getDeclaredNominalIdentitySetFromTypeNode<TIdentity extends NominalIdentityLike>(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
  options: {
    getFallbackIdentitySet: (
      context: AnalysisContext,
      typeNode: ts.TypeNode,
    ) => NominalIdentitySet<TIdentity> | undefined;
    getIdentityFromReferenceNode: (
      context: AnalysisContext,
      typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
      visitedSymbols?: Set<number>,
    ) => TIdentity | undefined;
    getIdentitySetFromReferenceNode: (
      context: AnalysisContext,
      typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
      visitedSymbols?: Set<number>,
    ) => NominalIdentitySet<TIdentity> | undefined;
    identitiesMatch: (
      context: AnalysisContext,
      left: TIdentity,
      right: TIdentity,
    ) => boolean;
  },
  visitedSymbols: Set<number> = new Set(),
): NominalIdentitySet<TIdentity> | undefined {
  try {
    const unwrappedTypeNode = unwrapRelationTypeNode(typeNode);
    if (!unwrappedTypeNode) {
      return undefined;
    }

    const transparentWrapperPayloadTypeNode = (
        ts.isTypeReferenceNode(unwrappedTypeNode) || ts.isImportTypeNode(unwrappedTypeNode)
      )
      ? getTransparentRelationWrapperPayloadTypeNode(context, unwrappedTypeNode)
      : undefined;
    if (transparentWrapperPayloadTypeNode) {
      return getDeclaredNominalIdentitySetFromTypeNode(
        context,
        transparentWrapperPayloadTypeNode,
        options,
        new Set(visitedSymbols),
      );
    }

    if (ts.isUnionTypeNode(unwrappedTypeNode) || ts.isIntersectionTypeNode(unwrappedTypeNode)) {
      const identities: TIdentity[] = [];
      for (const branch of unwrappedTypeNode.types) {
        const identitySet = getDeclaredNominalIdentitySetFromTypeNode(
          context,
          branch,
          options,
          new Set(visitedSymbols),
        );
        if (!identitySet) {
          continue;
        }

        for (const identity of identitySet.identities) {
          appendUniqueNominalIdentity(
            context,
            identities,
            identity,
            options.identitiesMatch,
          );
        }
      }
      return identities.length === 0 ? undefined : {
        identities,
        mode: ts.isUnionTypeNode(unwrappedTypeNode) ? 'union' : 'intersection',
      };
    }

    if (ts.isConditionalTypeNode(unwrappedTypeNode)) {
      if (
        !typeNodeContainsTypeParameterReference(context, unwrappedTypeNode.checkType) &&
        !typeNodeContainsTypeParameterReference(context, unwrappedTypeNode.extendsType)
      ) {
        const selectedBranch = context.checker.isTypeAssignableTo(
            context.checker.getTypeFromTypeNode(unwrappedTypeNode.checkType),
            context.checker.getTypeFromTypeNode(unwrappedTypeNode.extendsType),
          )
          ? unwrappedTypeNode.trueType
          : unwrappedTypeNode.falseType;
        const selectedIdentitySet = getDeclaredNominalIdentitySetFromTypeNode(
          context,
          selectedBranch,
          options,
          new Set(visitedSymbols),
        );
        if (selectedIdentitySet) {
          return selectedIdentitySet;
        }
      }

      const trueIdentitySet = getDeclaredNominalIdentitySetFromTypeNode(
        context,
        unwrappedTypeNode.trueType,
        options,
        new Set(visitedSymbols),
      );
      const falseIdentitySet = getDeclaredNominalIdentitySetFromTypeNode(
        context,
        unwrappedTypeNode.falseType,
        options,
        new Set(visitedSymbols),
      );
      if (trueIdentitySet && isNeverRelationTypeNode(unwrappedTypeNode.falseType)) {
        return trueIdentitySet;
      }
      if (falseIdentitySet && isNeverRelationTypeNode(unwrappedTypeNode.trueType)) {
        return falseIdentitySet;
      }
      if (
        trueIdentitySet &&
        falseIdentitySet &&
        areEquivalentNominalIdentitySets(
          context,
          trueIdentitySet,
          falseIdentitySet,
          options.identitiesMatch,
        )
      ) {
        return trueIdentitySet;
      }
    }

    if (!ts.isTypeReferenceNode(unwrappedTypeNode) && !ts.isImportTypeNode(unwrappedTypeNode)) {
      return options.getFallbackIdentitySet(context, unwrappedTypeNode);
    }

    const identitySet = options.getIdentitySetFromReferenceNode(
      context,
      unwrappedTypeNode,
      visitedSymbols,
    );
    if (identitySet) {
      return identitySet;
    }

    const identity = options.getIdentityFromReferenceNode(
      context,
      unwrappedTypeNode,
      visitedSymbols,
    );
    return identity ? { identities: [identity], mode: 'single' } : undefined;
  } catch (error) {
    if (isStackOverflowLikeError(error)) {
      return undefined;
    }
    throw error;
  }
}

function getDeclaredNominalIdentitySetFromExpression<TIdentity extends NominalIdentityLike>(
  context: AnalysisContext,
  expression: ts.Expression | undefined,
  options: {
    getDeclaredIdentitySetFromTypeNode: (
      context: AnalysisContext,
      typeNode: ts.TypeNode | undefined,
      visitedSymbols?: Set<number>,
    ) => NominalIdentitySet<TIdentity> | undefined;
    getIdentityFromReferenceNode: (
      context: AnalysisContext,
      typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
      visitedSymbols?: Set<number>,
    ) => TIdentity | undefined;
  },
  visitedSymbols: Set<number> = new Set(),
): NominalIdentitySet<TIdentity> | undefined {
  if (!expression) {
    return undefined;
  }

  const unwrappedExpression = unwrapRelationExpression(expression);
  const safeGetSymbolAtLocation = (node: ts.Node): ts.Symbol | undefined => {
    try {
      return context.checker.getSymbolAtLocation(node);
    } catch (error) {
      if (isStackOverflowLikeError(error)) {
        return undefined;
      }
      throw error;
    }
  };
  const safeGetResolvedSignature = (
    node: ts.CallExpression | ts.NewExpression,
  ): ts.Signature | undefined => {
    try {
      return context.checker.getResolvedSignature(node);
    } catch (error) {
      if (isStackOverflowLikeError(error)) {
        return undefined;
      }
      throw error;
    }
  };
  const getIdentitySetFromTypedSymbol = (
    symbol: ts.Symbol | undefined,
  ): NominalIdentitySet<TIdentity> | undefined => {
    try {
      const resolvedSymbol = getResolvedAliasSymbol(context, symbol);
      if (!resolvedSymbol) {
        return undefined;
      }
      const symbolId = context.getSymbolId(resolvedSymbol);
      if (visitedSymbols.has(symbolId)) {
        return undefined;
      }
      const nextVisitedSymbols = new Set(visitedSymbols);
      nextVisitedSymbols.add(symbolId);

      for (const declaration of resolvedSymbol.getDeclarations() ?? []) {
        const declaredIdentitySet = options.getDeclaredIdentitySetFromTypeNode(
          context,
          (declaration as ts.Declaration & { type?: ts.TypeNode }).type,
          nextVisitedSymbols,
        );
        if (declaredIdentitySet) {
          return declaredIdentitySet;
        }

        const typeReferenceNode = getReferenceLikeTypeNodeFromTypedDeclaration(declaration);
        if (!typeReferenceNode) {
          continue;
        }

        const identity = options.getIdentityFromReferenceNode(
          context,
          typeReferenceNode,
          nextVisitedSymbols,
        );
        if (identity) {
          return { identities: [identity], mode: 'single' };
        }
      }

      return undefined;
    } catch (error) {
      if (isStackOverflowLikeError(error)) {
        return undefined;
      }
      throw error;
    }
  };

  if (ts.isIdentifier(unwrappedExpression)) {
    return getIdentitySetFromTypedSymbol(safeGetSymbolAtLocation(unwrappedExpression));
  }

  if (ts.isPropertyAccessExpression(unwrappedExpression)) {
    return getIdentitySetFromTypedSymbol(
      safeGetSymbolAtLocation(unwrappedExpression.name),
    );
  }

  if (ts.isCallExpression(unwrappedExpression) || ts.isNewExpression(unwrappedExpression)) {
    const signature = safeGetResolvedSignature(unwrappedExpression);
    return signature
      ? options.getDeclaredIdentitySetFromTypeNode(context, getSignatureReturnTypeNode(signature))
      : undefined;
  }

  return undefined;
}

function getDeclaredNewtypeIdentitySetFromTypeNode(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
  visitedSymbols: Set<number> = new Set(),
): TargetNewtypeIdentitySet | undefined {
  return getDeclaredNominalIdentitySetFromTypeNode(
    context,
    typeNode,
    {
      getFallbackIdentitySet: (context, typeNode) =>
        ts.isConditionalTypeNode(typeNode)
          ? getTargetNewtypeIdentitySet(context, context.checker.getTypeFromTypeNode(typeNode))
          : undefined,
      getIdentityFromReferenceNode: getNewtypeIdentityFromTypeReferenceNode,
      getIdentitySetFromReferenceNode: getNewtypeIdentitySetFromTypeReferenceNode,
      identitiesMatch: newtypeIdentitiesMatch,
    },
    visitedSymbols,
  );
}

function getClassIdentityFromTypeReferenceNode(
  context: AnalysisContext,
  typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
  visitedSymbols: Set<number> = new Set(),
): GenericClassIdentity | undefined {
  return getDeclaredNominalIdentityFromTypeReferenceNode(
    context,
    typeReferenceNode,
    {
      getDeclaredIdentitySetFromTypeNode: getDeclaredClassIdentitySetFromTypeNode,
      isDirectIdentitySymbol: (_, symbol) => isClassSymbol(symbol),
      selectIdentityFromAliasSet: (identitySet) => identitySet?.identities[0],
    },
    visitedSymbols,
  );
}

function getClassIdentitySetFromTypeReferenceNode(
  context: AnalysisContext,
  typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
  visitedSymbols: Set<number> = new Set(),
): TargetClassIdentitySet | undefined {
  return getDeclaredNominalIdentitySetFromTypeReferenceNode(
    context,
    typeReferenceNode,
    {
      getDeclaredIdentitySetFromTypeNode: getDeclaredClassIdentitySetFromTypeNode,
      isDirectIdentitySymbol: (_, symbol) => isClassSymbol(symbol),
      selectIdentityFromAliasSet: (identitySet) => identitySet?.identities[0],
    },
    visitedSymbols,
  );
}

function getDeclaredClassIdentitySetFromTypeNode(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
  visitedSymbols: Set<number> = new Set(),
): TargetClassIdentitySet | undefined {
  return getDeclaredNominalIdentitySetFromTypeNode(
    context,
    typeNode,
    {
      getFallbackIdentitySet: (context, typeNode) =>
        ts.isConditionalTypeNode(typeNode)
          ? getTargetClassIdentitySet(context, context.checker.getTypeFromTypeNode(typeNode))
          : ts.isThisTypeNode(typeNode)
          ? undefined
          : undefined,
      getIdentityFromReferenceNode: getClassIdentityFromTypeReferenceNode,
      getIdentitySetFromReferenceNode: getClassIdentitySetFromTypeReferenceNode,
      identitiesMatch: classIdentitiesMatch,
    },
    visitedSymbols,
  );
}

function getDeclaredClassIdentitySetFromExpression(
  context: AnalysisContext,
  expression: ts.Expression | undefined,
  visitedSymbols: Set<number> = new Set(),
): TargetClassIdentitySet | undefined {
  return getDeclaredNominalIdentitySetFromExpression(
    context,
    expression,
    {
      getDeclaredIdentitySetFromTypeNode: getDeclaredClassIdentitySetFromTypeNode,
      getIdentityFromReferenceNode: getClassIdentityFromTypeReferenceNode,
    },
    visitedSymbols,
  );
}

function getDeclaredNewtypeIdentityFromExpression(
  context: AnalysisContext,
  expression: ts.Expression | undefined,
  visitedSymbols: Set<number> = new Set(),
): NewtypeIdentity | undefined {
  const identitySet = getDeclaredNominalIdentitySetFromExpression(
    context,
    expression,
    {
      getDeclaredIdentitySetFromTypeNode: getDeclaredNewtypeIdentitySetFromTypeNode,
      getIdentityFromReferenceNode: getNewtypeIdentityFromTypeReferenceNode,
    },
    visitedSymbols,
  );
  return identitySet?.identities.length === 1 ? identitySet.identities[0] : undefined;
}

function typeNodeContainsDeclaredNewtypeIdentity(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
): boolean {
  if (!typeNode) {
    return false;
  }

  let found = false;
  const visitedReferenceSymbols = new Set<number>();
  const visitCallableSurface = (surface: NormalizedRelationCallableSurface): void => {
    for (const signature of [...surface.callSignatures, ...surface.constructSignatures]) {
      for (const parameterTypeNode of signature.parameterTypeNodes) {
        if (parameterTypeNode) {
          visit(parameterTypeNode);
          if (found) {
            return;
          }
        }
      }

      if (signature.returnTypeNode) {
        visit(signature.returnTypeNode);
        if (found) {
          return;
        }
      }

      if (signature.predicateTypeNode) {
        visit(signature.predicateTypeNode);
        if (found) {
          return;
        }
      }
    }
  };
  const visitMemberSurface = (surface: NormalizedRelationMemberSurface): void => {
    for (const propertyTypeNode of surface.propertyTypeNodes.values()) {
      visit(propertyTypeNode);
      if (found) {
        return;
      }
    }

    for (const propertyMemberTypeNode of surface.propertyMemberTypeNodes.values()) {
      visit(propertyMemberTypeNode);
      if (found) {
        return;
      }
    }

    if (surface.stringIndexTypeNode) {
      visit(surface.stringIndexTypeNode);
      if (found) {
        return;
      }
    }

    if (surface.numberIndexTypeNode) {
      visit(surface.numberIndexTypeNode);
    }
  };
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }

    if (
      ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node) ||
      ts.isParenthesizedTypeNode(node)
    ) {
      if (getDeclaredNewtypeIdentitySetFromTypeNode(context, node as ts.TypeNode)) {
        found = true;
        return;
      }

      if (ts.isParenthesizedTypeNode(node)) {
        visit(node.type);
        return;
      }

      const relationSymbol = getResolvedAliasSymbol(
        context,
        getRelationReferenceTypeNodeSymbol(context, node),
      );
      if (relationSymbol) {
        const symbolId = context.getSymbolId(relationSymbol);
        if (!visitedReferenceSymbols.has(symbolId)) {
          visitedReferenceSymbols.add(symbolId);

          const transparentPayloadTypeNode = getTransparentRelationWrapperPayloadTypeNode(
            context,
            node,
          );
          if (transparentPayloadTypeNode) {
            visit(transparentPayloadTypeNode);
            if (found) {
              return;
            }
          }

          const expandedTypeNode = expandOrdinaryRelationCarrierTypeNode(context, node);
          if (expandedTypeNode) {
            visit(expandedTypeNode);
            if (found) {
              return;
            }
          }

          const memberSurface = getNormalizedRelationMemberSurface(context, node);
          if (memberSurface) {
            visitMemberSurface(memberSurface);
            if (found) {
              return;
            }
          }

          const callableSurface = getNormalizedRelationCallableSurface(context, node);
          if (callableSurface) {
            visitCallableSurface(callableSurface);
            if (found) {
              return;
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(typeNode);
  return found;
}

function getExpandedCarrierAwareRelationTypeNode(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(typeNode);
  if (!unwrappedTypeNode) {
    return undefined;
  }

  if (isRelationReferenceTypeNode(unwrappedTypeNode)) {
    const transparentPayloadTypeNode = getTransparentRelationWrapperPayloadTypeNode(
      context,
      unwrappedTypeNode,
    );
    if (transparentPayloadTypeNode) {
      return expandOrdinaryRelationCarrierTypeNode(context, transparentPayloadTypeNode) ??
        transparentPayloadTypeNode;
    }
  }

  return expandOrdinaryRelationCarrierTypeNode(context, unwrappedTypeNode) ?? unwrappedTypeNode;
}

function typeNodeContainsExpandedCarrierNewtypeIdentity(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
): boolean {
  return typeNodeContainsDeclaredNewtypeIdentity(
    context,
    getExpandedCarrierAwareRelationTypeNode(context, typeNode),
  );
}

function symbolContainsDeclaredNewtypeIdentity(
  context: AnalysisContext,
  symbol: ts.Symbol | undefined,
): boolean {
  const resolvedSymbol = getResolvedAliasSymbol(context, symbol);
  if (!resolvedSymbol) {
    return false;
  }

  return (resolvedSymbol.getDeclarations() ?? []).some((declaration) =>
    ts.isVariableDeclaration(declaration) ||
      ts.isParameter(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration)
      ? typeNodeContainsDeclaredNewtypeIdentity(context, declaration.type)
      : false
  );
}

function sourceMentionsDeclaredNewtypeIdentity(
  context: AnalysisContext,
  sourceExpression: ts.Expression | undefined,
  sourceTypeNode: ts.TypeNode | undefined,
): boolean {
  if (typeNodeContainsDeclaredNewtypeIdentity(context, sourceTypeNode)) {
    return true;
  }

  if (!sourceExpression) {
    return false;
  }

  const unwrappedExpression = unwrapRelationExpression(sourceExpression);
  if (ts.isIdentifier(unwrappedExpression)) {
    return symbolContainsDeclaredNewtypeIdentity(
      context,
      context.checker.getSymbolAtLocation(unwrappedExpression),
    );
  }

  if (ts.isPropertyAccessExpression(unwrappedExpression)) {
    return symbolContainsDeclaredNewtypeIdentity(
      context,
      context.checker.getSymbolAtLocation(unwrappedExpression.name),
    );
  }

  if (ts.isCallExpression(unwrappedExpression) || ts.isNewExpression(unwrappedExpression)) {
    const signature = context.checker.getResolvedSignature(unwrappedExpression);
    return signature
      ? typeNodeContainsDeclaredNewtypeIdentity(context, getSignatureReturnTypeNode(signature))
      : false;
  }

  return false;
}

function newtypeIdentitiesMatch(
  context: AnalysisContext,
  sourceIdentity: NewtypeIdentity,
  targetIdentity: NewtypeIdentity,
): boolean {
  if (sourceIdentity.symbol !== targetIdentity.symbol) {
    return false;
  }

  if (sourceIdentity.typeArguments.length !== targetIdentity.typeArguments.length) {
    return false;
  }

  return sourceIdentity.typeArguments.every((sourceTypeArgument, index) => {
    const targetTypeArgument = targetIdentity.typeArguments[index];
    return targetTypeArgument !== undefined &&
      areExactTypeArguments(context, sourceTypeArgument, targetTypeArgument);
  });
}

function classIdentitiesMatch(
  context: AnalysisContext,
  sourceIdentity: GenericClassIdentity,
  targetIdentity: GenericClassIdentity,
): boolean {
  if (sourceIdentity.symbol !== targetIdentity.symbol) {
    return false;
  }

  if (sourceIdentity.typeArguments.length !== targetIdentity.typeArguments.length) {
    return false;
  }

  return sourceIdentity.typeArguments.every((sourceTypeArgument, index) => {
    const targetTypeArgument = targetIdentity.typeArguments[index];
    return targetTypeArgument !== undefined &&
      areExactTypeArguments(context, sourceTypeArgument, targetTypeArgument);
  });
}

function sourceClassIdentitySetMatchesTargetIdentity(
  context: AnalysisContext,
  sourceIdentitySet: TargetClassIdentitySet,
  targetIdentity: GenericClassIdentity,
): boolean {
  if (sourceIdentitySet.mode === 'union') {
    return sourceIdentitySet.identities.every((sourceIdentity) =>
      classIdentitiesMatch(context, sourceIdentity, targetIdentity)
    );
  }

  return sourceIdentitySet.identities.some((sourceIdentity) =>
    classIdentitiesMatch(context, sourceIdentity, targetIdentity)
  );
}

function sourceClassIdentitySetSatisfiesTarget(
  context: AnalysisContext,
  sourceIdentitySet: TargetClassIdentitySet,
  targetIdentitySet: TargetClassIdentitySet,
): boolean {
  if (targetIdentitySet.mode === 'union') {
    if (sourceIdentitySet.mode === 'intersection') {
      return sourceIdentitySet.identities.some((sourceIdentity) =>
        targetIdentitySet.identities.some((targetIdentity) =>
          classIdentitiesMatch(context, sourceIdentity, targetIdentity)
        )
      );
    }

    return sourceIdentitySet.identities.every((sourceIdentity) =>
      targetIdentitySet.identities.some((targetIdentity) =>
        classIdentitiesMatch(context, sourceIdentity, targetIdentity)
      )
    );
  }

  return targetIdentitySet.identities.every((targetIdentity) =>
    sourceClassIdentitySetMatchesTargetIdentity(context, sourceIdentitySet, targetIdentity)
  );
}

function resolveSourceNewtypeIdentity(
  context: AnalysisContext,
  sourceType: ts.Type,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
): NewtypeIdentity | undefined {
  return getDeclaredNewtypeIdentityFromTypeNode(context, sourceTypeNode) ??
    getDeclaredNewtypeIdentityFromExpression(context, sourceExpression) ??
    getDirectNewtypeIdentity(context, sourceType);
}

function targetAllowsNewtypeIdentity(
  context: AnalysisContext,
  targetType: ts.Type,
  targetTypeNode: ts.TypeNode | undefined,
  sourceIdentity: NewtypeIdentity,
): boolean {
  const targetIdentitySetFromTypeNode = getDeclaredNewtypeIdentitySetFromTypeNode(
    context,
    targetTypeNode,
  );
  if (targetIdentitySetFromTypeNode) {
    return targetIdentitySetFromTypeNode.mode === 'intersection'
      ? targetIdentitySetFromTypeNode.identities.every((targetIdentity) =>
        newtypeIdentitiesMatch(context, sourceIdentity, targetIdentity)
      )
      : targetIdentitySetFromTypeNode.identities.some((targetIdentity) =>
        newtypeIdentitiesMatch(context, sourceIdentity, targetIdentity)
      );
  }

  const targetIdentitySet = getTargetNewtypeIdentitySet(context, targetType);
  if (!targetIdentitySet) {
    return false;
  }

  if (targetIdentitySet.mode === 'union') {
    return targetIdentitySet.identities.some((targetIdentity) =>
      newtypeIdentitiesMatch(context, sourceIdentity, targetIdentity)
    );
  }

  return targetIdentitySet.identities.every((targetIdentity) =>
    newtypeIdentitiesMatch(context, sourceIdentity, targetIdentity)
  );
}

function canConstructTargetNewtypeInDefiningModule(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  relationSite: ts.Node | undefined,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
): boolean {
  const targetIdentitySet = getTargetNewtypeIdentitySet(context, targetType);
  if (!targetIdentitySet) {
    return false;
  }

  if (
    sourceTypeContainsAnyNewtypeIdentity(context, sourceType) ||
    sourceMentionsDeclaredNewtypeIdentity(context, sourceExpression, sourceTypeNode)
  ) {
    return false;
  }

  return targetIdentitySet.identities.every((targetIdentity) =>
    isSameModuleNewtypePrivilege(context, relationSite, targetIdentity)
  );
}

function canProjectSourceNewtypeInDefiningModule(
  context: AnalysisContext,
  sourceIdentity: NewtypeIdentity,
  targetType: ts.Type,
  targetTypeNode: ts.TypeNode | undefined,
  relationSite: ts.Node | undefined,
): boolean {
  if (!isSameModuleNewtypePrivilege(context, relationSite, sourceIdentity)) {
    return false;
  }

  return getDeclaredNewtypeIdentitySetFromTypeNode(context, targetTypeNode) === undefined &&
    getTargetNewtypeIdentitySet(context, targetType) === undefined;
}

function createNominalNewtypeEscapeMismatch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch {
  const sourceTypeText = context.checker.typeToString(sourceType);
  const targetTypeText = context.checker.typeToString(targetType);
  return {
    kind: 'nominalNewtypeRelation',
    message: 'Newtype aliases are nominal in soundscript.',
    metadata: {
      rule: 'nominal_newtype_escape',
      fixability: 'local_rewrite',
      invariant:
        '#[newtype] aliases carry nominal identity in addition to their underlying representation.',
      primarySymbol: targetTypeText,
      replacementFamily: 'explicit_newtype_boundary',
      evidence: [
        createVarianceEvidence('sourceType', sourceTypeText),
        createVarianceEvidence('targetType', targetTypeText),
      ],
      counterexample:
        `Outside the declaring module, '${sourceTypeText}' does not automatically prove the nominal identity expected by '${targetTypeText}'.`,
    },
    notes: [
      `'${sourceTypeText}' cannot be widened to '${targetTypeText}' because #[newtype] aliases only implicitly unwrap inside their defining module.`,
    ],
    hint:
      'Keep the exact newtype, unwrap it inside the declaring module, or change the target to accept the newtype directly.',
  };
}

function classifySourceNewtypeEscapeRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetTypeNode: ts.TypeNode | undefined,
  relationSite?: ts.Node,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
): RelationMismatch | undefined {
  const sourceIdentity = resolveSourceNewtypeIdentity(
    context,
    sourceType,
    sourceExpression,
    sourceTypeNode,
  );
  if (!sourceIdentity) {
    return undefined;
  }

  if (!context.checker.isTypeAssignableTo(targetType, sourceType)) {
    return undefined;
  }

  return targetAllowsNewtypeIdentity(context, targetType, targetTypeNode, sourceIdentity) ||
      canProjectSourceNewtypeInDefiningModule(
        context,
        sourceIdentity,
        targetType,
        targetTypeNode,
        relationSite,
      )
    ? undefined
    : createNominalNewtypeEscapeMismatch(context, sourceType, targetType);
}

function classifyCurrentTypeNodeNewtypeRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetTypeNode: ts.TypeNode | undefined,
  relationSite?: ts.Node,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
): RelationMismatch | undefined {
  const targetIdentitySet = getDeclaredNewtypeIdentitySetFromTypeNode(context, targetTypeNode);
  if (!targetIdentitySet) {
    return undefined;
  }

  const sourceIdentity = resolveSourceNewtypeIdentity(
    context,
    sourceType,
    sourceExpression,
    sourceTypeNode,
  );
  if (
    sourceIdentity &&
    (targetIdentitySet.mode === 'intersection'
      ? targetIdentitySet.identities.every((targetIdentity) =>
        newtypeIdentitiesMatch(context, sourceIdentity, targetIdentity)
      )
      : targetIdentitySet.identities.some((targetIdentity) =>
        newtypeIdentitiesMatch(context, sourceIdentity, targetIdentity)
      ))
  ) {
    return undefined;
  }

  if (
    sourceIdentity === undefined &&
    targetIdentitySet.identities.every((targetIdentity) =>
      isSameModuleNewtypePrivilege(context, relationSite, targetIdentity)
    ) &&
    !sourceMentionsDeclaredNewtypeIdentity(context, sourceExpression, sourceTypeNode)
  ) {
    return undefined;
  }

  return createNominalNewtypeRelationMismatch(context, sourceType, targetType, targetIdentitySet);
}

function classifyCurrentTypeNodeNominalClassRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetTypeNode: ts.TypeNode | undefined,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
): RelationMismatch | undefined {
  if (
    sharesCanonicalResultClassFamily(context, sourceType, targetType) ||
    sharesGenericAliasRelationFamily(context, sourceType, targetType) ||
    sharesExactGenericClassIdentityFamilies(context, sourceType, targetType) ||
    sharesEquivalentTargetClassIdentitySets(context, sourceType, targetType)
  ) {
    return undefined;
  }

  const targetIdentitySet = getDeclaredClassIdentitySetFromTypeNode(context, targetTypeNode);
  if (!targetIdentitySet) {
    return undefined;
  }
  const sourceFamily = getCanonicalResultClassFamilyForType(context, sourceType);
  const targetFamily = getCanonicalResultClassFamilyForTargetIdentitySet(targetIdentitySet);
  if (sourceFamily !== undefined && sourceFamily === targetFamily) {
    return undefined;
  }

  const sourceIdentitySet = getDeclaredClassIdentitySetFromTypeNode(context, sourceTypeNode) ??
    getDeclaredClassIdentitySetFromExpression(context, sourceExpression);
  if (
    sourceIdentitySet &&
    sourceClassIdentitySetSatisfiesTarget(context, sourceIdentitySet, targetIdentitySet)
  ) {
    return undefined;
  }

  return classifySourceTypeAgainstTargetClassIdentitySet(
    context,
    sourceType,
    targetType,
    targetIdentitySet,
  );
}

function collectGenericClassIdentities(
  context: AnalysisContext,
  type: ts.Type,
  visitedTypeIds: Set<number> = new Set(),
): readonly GenericClassIdentity[] {
  const normalizedType = normalizeTransparentRelationType(context, type);
  const typeId = (normalizedType as ts.Type & { id?: number }).id;
  if (typeof typeId === 'number') {
    if (visitedTypeIds.has(typeId)) {
      return [];
    }
    visitedTypeIds.add(typeId);
  }

  const identities: GenericClassIdentity[] = [];
  if ((normalizedType.flags & ts.TypeFlags.Union) !== 0) {
    for (const constituentType of (normalizedType as ts.UnionType).types) {
      identities.push(...collectGenericClassIdentities(context, constituentType, visitedTypeIds));
    }
    return identities;
  }

  if ((normalizedType.flags & ts.TypeFlags.Intersection) !== 0) {
    for (const constituentType of (normalizedType as ts.IntersectionType).types) {
      identities.push(...collectGenericClassIdentities(context, constituentType, visitedTypeIds));
    }
    return identities;
  }

  const symbol = getTypeReferenceSymbol(normalizedType);
  const typeArguments = getReferenceTypeArguments(context, normalizedType);
  if (symbol && typeArguments.length > 0 && isGenericClassSymbol(symbol)) {
    identities.push({
      symbol,
      typeArguments,
    });
  }

  if ((normalizedType.flags & ts.TypeFlags.Object) === 0) {
    return identities;
  }

  const objectType = normalizedType as ts.ObjectType;
  if ((objectType.objectFlags & ts.ObjectFlags.ClassOrInterface) === 0) {
    return identities;
  }

  const baseTypes = context.checker.getBaseTypes(normalizedType as ts.InterfaceType) ?? [];
  for (const baseType of baseTypes) {
    identities.push(...collectGenericClassIdentities(context, baseType, visitedTypeIds));
  }

  return identities;
}

function getDirectClassIdentity(
  context: AnalysisContext,
  type: ts.Type,
): GenericClassIdentity | undefined {
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    return undefined;
  }

  let normalizedType: ts.Type;
  try {
    normalizedType = normalizeTransparentRelationType(context, type);
  } catch {
    return undefined;
  }
  if ((normalizedType.flags & ts.TypeFlags.TypeParameter) !== 0) {
    return undefined;
  }

  if (getTypeAliasName(normalizedType) === 'OmitThisParameter') {
    const [wrappedType] = getAliasTypeArguments(normalizedType);
    if (wrappedType) {
      let wrappedIdentity: GenericClassIdentity | undefined;
      for (
        const signature of context.checker.getSignaturesOfType(wrappedType, ts.SignatureKind.Call)
      ) {
        const thisParameterType = getSignatureThisParameterType(context, signature);
        const signatureIdentity = thisParameterType
          ? getDirectClassIdentity(context, thisParameterType)
          : undefined;
        if (!signatureIdentity) {
          return undefined;
        }
        if (!wrappedIdentity) {
          wrappedIdentity = signatureIdentity;
          continue;
        }
        if (!classIdentitiesMatch(context, wrappedIdentity, signatureIdentity)) {
          return undefined;
        }
      }
      if (wrappedIdentity) {
        return wrappedIdentity;
      }
    }
  }

  const symbol = getTypeReferenceSymbol(normalizedType);
  if (!symbol || !isClassSymbol(symbol)) {
    return undefined;
  }

  return {
    symbol,
    typeArguments: getReferenceTypeArguments(context, normalizedType),
  };
}

function getTargetClassIdentitySet(
  context: AnalysisContext,
  targetType: ts.Type,
): TargetClassIdentitySet | undefined {
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);

  if ((normalizedTargetType.flags & ts.TypeFlags.Union) !== 0) {
    const identities: GenericClassIdentity[] = [];
    for (const constituentType of (normalizedTargetType as ts.UnionType).types) {
      const identity = getDirectClassIdentity(context, constituentType);
      if (!identity) {
        return undefined;
      }
      identities.push(identity);
    }
    return identities.length === 0 ? undefined : { identities, mode: 'union' };
  }

  if ((normalizedTargetType.flags & ts.TypeFlags.Intersection) !== 0) {
    const identities: GenericClassIdentity[] = [];
    for (const constituentType of (normalizedTargetType as ts.IntersectionType).types) {
      const identity = getDirectClassIdentity(context, constituentType);
      if (identity) {
        identities.push(identity);
      }
    }
    return identities.length === 0 ? undefined : { identities, mode: 'intersection' };
  }

  const identity = getDirectClassIdentity(context, normalizedTargetType);
  return identity ? { identities: [identity], mode: 'single' } : undefined;
}

function getTargetNewtypeIdentitySet(
  context: AnalysisContext,
  targetType: ts.Type,
): TargetNewtypeIdentitySet | undefined {
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);

  if ((normalizedTargetType.flags & ts.TypeFlags.Union) !== 0) {
    const identities: NewtypeIdentity[] = [];
    for (const constituentType of (normalizedTargetType as ts.UnionType).types) {
      const identity = getDirectNewtypeIdentity(context, constituentType);
      if (!identity) {
        return undefined;
      }
      identities.push(identity);
    }
    return identities.length === 0 ? undefined : { identities, mode: 'union' };
  }

  if ((normalizedTargetType.flags & ts.TypeFlags.Intersection) !== 0) {
    const identities: NewtypeIdentity[] = [];
    for (const constituentType of (normalizedTargetType as ts.IntersectionType).types) {
      const identity = getDirectNewtypeIdentity(context, constituentType);
      if (identity) {
        identities.push(identity);
      }
    }
    return identities.length === 0 ? undefined : { identities, mode: 'intersection' };
  }

  const identity = getDirectNewtypeIdentity(context, normalizedTargetType);
  return identity ? { identities: [identity], mode: 'single' } : undefined;
}

function createNominalClassRelationMismatch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetIdentitySet: TargetClassIdentitySet,
): RelationMismatch {
  const sourceTypeText = context.checker.typeToString(sourceType);
  const targetTypeText = context.checker.typeToString(targetType);
  const targetNames = targetIdentitySet.identities.map((identity) => identity.symbol.getName());
  const classRequirement = targetIdentitySet.mode === 'union'
    ? `one of the declared class branches (${targetNames.join(', ')})`
    : `the declared class '${
      targetNames[0] ?? targetTypeText
    }' or an explicit subclass relation`;
  return {
    kind: 'nominalClassRelation',
    message: 'Class instance types are nominal in soundscript.',
    metadata: {
      rule: 'nominal_class_relation',
      fixability: 'local_rewrite',
      invariant:
        'Class instance targets require the declared class identity or subclass relation, not just matching public fields.',
      primarySymbol: targetNames[0] ?? targetTypeText,
      replacementFamily: 'structural_interface_projection',
      evidence: [
        createVarianceEvidence('sourceType', sourceTypeText),
        createVarianceEvidence('targetType', targetTypeText),
        createVarianceEvidence(
          'requiredIdentity',
          targetIdentitySet.mode === 'union'
            ? targetNames.join(' | ')
            : targetNames[0] ?? targetTypeText,
        ),
      ],
      counterexample:
        `A value with the public shape of '${targetNames[0] ?? targetTypeText}' is still not a real '${targetNames[0] ?? targetTypeText}' instance unless it carries the target class identity or subclass relation.`,
      example:
        'Project to a structural interface or type alias when you only need the public shape.',
    },
    notes: [
      `'${sourceTypeText}' cannot be widened to '${targetTypeText}' because class targets require ${classRequirement}, not just a matching public shape.`,
    ],
    hint:
      'Keep the class type exact, project to a structural interface or type alias, or construct a real instance of the target class.',
  };
}

function createNominalNewtypeRelationMismatch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetIdentitySet: TargetNewtypeIdentitySet,
): RelationMismatch {
  const sourceTypeText = context.checker.typeToString(sourceType);
  const targetTypeText = context.checker.typeToString(targetType);
  const targetNames = targetIdentitySet.identities.map((identity) => identity.symbol.getName());
  const newtypeRequirement = targetIdentitySet.mode === 'union'
    ? `one of the declared newtype branches (${targetNames.join(', ')})`
    : `the declared newtype '${targetNames[0] ?? targetTypeText}'`;
  return {
    kind: 'nominalNewtypeRelation',
    message: 'Newtype aliases are nominal in soundscript.',
    metadata: {
      rule: 'nominal_newtype_relation',
      fixability: 'local_rewrite',
      invariant:
        '#[newtype] aliases carry nominal identity in addition to their underlying representation.',
      primarySymbol: targetNames[0] ?? targetTypeText,
      replacementFamily: 'explicit_newtype_boundary',
      evidence: [
        createVarianceEvidence('sourceType', sourceTypeText),
        createVarianceEvidence('targetType', targetTypeText),
        createVarianceEvidence(
          'requiredIdentity',
          targetIdentitySet.mode === 'union'
            ? targetNames.join(' | ')
            : targetNames[0] ?? targetTypeText,
        ),
      ],
      counterexample:
        `A value with the underlying representation of '${targetNames[0] ?? targetTypeText}' still does not prove the nominal newtype identity outside the declaring module.`,
      example:
        'Construct or unwrap the newtype inside its declaring module, or intentionally project to the underlying representation.',
    },
    notes: [
      `'${sourceTypeText}' cannot be widened to '${targetTypeText}' because #[newtype] aliases require ${newtypeRequirement} and exact type arguments outside the defining module, not just a matching underlying representation.`,
    ],
    hint:
      'Keep the exact newtype, construct or unwrap it in the declaring module, or project to the underlying representation intentionally.',
  };
}

function getSourceClassMatchForTargetIdentity(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetIdentity: GenericClassIdentity,
): { exactMismatch: boolean; matches: boolean } {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);

  if ((normalizedSourceType.flags & ts.TypeFlags.Union) !== 0) {
    let sawExactMismatch = false;
    for (const constituentType of (normalizedSourceType as ts.UnionType).types) {
      const branchMatch = getSourceClassMatchForTargetIdentity(
        context,
        constituentType,
        targetIdentity,
      );
      if (!branchMatch.matches) {
        return {
          matches: false,
          exactMismatch: sawExactMismatch || branchMatch.exactMismatch,
        };
      }
      sawExactMismatch = sawExactMismatch || branchMatch.exactMismatch;
    }
    return { matches: true, exactMismatch: sawExactMismatch };
  }

  if ((normalizedSourceType.flags & ts.TypeFlags.Intersection) !== 0) {
    let sawExactMismatch = false;
    for (const constituentType of (normalizedSourceType as ts.IntersectionType).types) {
      const branchMatch = getSourceClassMatchForTargetIdentity(
        context,
        constituentType,
        targetIdentity,
      );
      if (branchMatch.matches) {
        return branchMatch;
      }
      sawExactMismatch = sawExactMismatch || branchMatch.exactMismatch;
    }
    return { matches: false, exactMismatch: sawExactMismatch };
  }

  const directIdentity = getDirectClassIdentity(context, normalizedSourceType);
  if (directIdentity && directIdentity.symbol === targetIdentity.symbol) {
    return classIdentitiesMatch(context, directIdentity, targetIdentity)
      ? { matches: true, exactMismatch: false }
      : { matches: false, exactMismatch: true };
  }

  const matchingBaseType = getMatchingBaseType(
    context,
    normalizedSourceType,
    targetIdentity.symbol,
  );
  if (!matchingBaseType) {
    return { matches: false, exactMismatch: false };
  }

  if (targetIdentity.typeArguments.length === 0) {
    return { matches: true, exactMismatch: false };
  }

  const sourceTypeArguments = getReferenceTypeArguments(context, matchingBaseType);
  if (
    sourceTypeArguments.length !== targetIdentity.typeArguments.length ||
    !sourceTypeArguments.every((sourceTypeArgument, index) => {
      const targetTypeArgument = targetIdentity.typeArguments[index];
      return targetTypeArgument !== undefined &&
        areExactTypeArguments(context, sourceTypeArgument, targetTypeArgument);
    })
  ) {
    return { matches: false, exactMismatch: true };
  }

  return { matches: true, exactMismatch: false };
}

function sourceNewtypeMatchesTargetIdentity(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetIdentity: NewtypeIdentity,
): boolean {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);

  if ((normalizedSourceType.flags & ts.TypeFlags.Union) !== 0) {
    return (normalizedSourceType as ts.UnionType).types.every((constituentType) =>
      sourceNewtypeMatchesTargetIdentity(context, constituentType, targetIdentity)
    );
  }

  if ((normalizedSourceType.flags & ts.TypeFlags.Intersection) !== 0) {
    return (normalizedSourceType as ts.IntersectionType).types.some((constituentType) =>
      sourceNewtypeMatchesTargetIdentity(context, constituentType, targetIdentity)
    );
  }

  const sourceIdentity = getDirectNewtypeIdentity(context, normalizedSourceType);
  if (!sourceIdentity || sourceIdentity.symbol !== targetIdentity.symbol) {
    return false;
  }

  if (sourceIdentity.typeArguments.length !== targetIdentity.typeArguments.length) {
    return false;
  }

  return sourceIdentity.typeArguments.every((sourceTypeArgument, index) => {
    const targetTypeArgument = targetIdentity.typeArguments[index];
    return targetTypeArgument !== undefined &&
      areExactTypeArguments(context, sourceTypeArgument, targetTypeArgument);
  });
}

function classifySourceTypeAgainstTargetClassIdentitySet(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetIdentitySet: TargetClassIdentitySet,
): RelationMismatch | undefined {
  const sourceFamily = getCanonicalResultClassFamilyForType(context, sourceType);
  const targetFamily = getCanonicalResultClassFamilyForTargetIdentitySet(targetIdentitySet);
  if (sourceFamily !== undefined && sourceFamily === targetFamily) {
    return undefined;
  }

  if (targetIdentitySet.mode === 'union') {
    const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
    if ((normalizedSourceType.flags & ts.TypeFlags.Never) !== 0) {
      return undefined;
    }
    const sourceBranches = (normalizedSourceType.flags & ts.TypeFlags.Union) !== 0
      ? (normalizedSourceType as ts.UnionType).types
      : [normalizedSourceType];

    let sawExactMismatch = false;
    for (const sourceBranch of sourceBranches) {
      const normalizedSourceBranch = getSafeNonNullableRelationType(context, sourceBranch);
      if ((normalizedSourceBranch.flags & ts.TypeFlags.Never) !== 0) {
        continue;
      }
      const primitiveSourceBranch = context.checker.getBaseTypeOfLiteralType(
        normalizedSourceBranch,
      );
      if (
        (primitiveSourceBranch.flags & ts.TypeFlags.StringLike) !== 0 ||
        (primitiveSourceBranch.flags & ts.TypeFlags.NumberLike) !== 0 ||
        (primitiveSourceBranch.flags & ts.TypeFlags.BooleanLike) !== 0 ||
        (primitiveSourceBranch.flags & ts.TypeFlags.BigIntLike) !== 0 ||
        (primitiveSourceBranch.flags & ts.TypeFlags.ESSymbolLike) !== 0
      ) {
        continue;
      }
      let branchMatched = false;
      for (const targetIdentity of targetIdentitySet.identities) {
        const branchMatch = getSourceClassMatchForTargetIdentity(
          context,
          normalizedSourceBranch,
          targetIdentity,
        );
        if (branchMatch.matches) {
          branchMatched = true;
          break;
        }
        sawExactMismatch = sawExactMismatch || branchMatch.exactMismatch;
      }
      if (!branchMatched) {
        return sawExactMismatch
          ? classifyUnsoundGenericClassInstanceRelation(context, sourceType, targetType)
          : createNominalClassRelationMismatch(context, sourceType, targetType, targetIdentitySet);
      }
    }

    return undefined;
  }

  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  if ((normalizedSourceType.flags & ts.TypeFlags.Never) !== 0) {
    return undefined;
  }

  let sawExactMismatch = false;
  for (const targetIdentity of targetIdentitySet.identities) {
    const sourceMatch = getSourceClassMatchForTargetIdentity(
      context,
      normalizedSourceType,
      targetIdentity,
    );
    if (!sourceMatch.matches) {
      sawExactMismatch = sawExactMismatch || sourceMatch.exactMismatch;
      return sawExactMismatch
        ? classifyUnsoundGenericClassInstanceRelation(context, sourceType, targetType)
        : createNominalClassRelationMismatch(context, sourceType, targetType, targetIdentitySet);
    }
  }

  return undefined;
}

function classifyUnsoundNominalClassRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  if (
    sharesCanonicalResultClassFamily(context, sourceType, targetType) ||
    sharesGenericAliasRelationFamily(context, sourceType, targetType) ||
    sharesExactGenericClassIdentityFamilies(context, sourceType, targetType) ||
    sharesEquivalentTargetClassIdentitySets(context, sourceType, targetType)
  ) {
    return undefined;
  }

  const targetIdentitySet = getTargetClassIdentitySet(context, targetType);
  if (!targetIdentitySet) {
    return undefined;
  }

  if (
    targetIdentitySet.mode === 'union' &&
    context.checker.typeToString(sourceType) === context.checker.typeToString(targetType)
  ) {
    return undefined;
  }

  return classifySourceTypeAgainstTargetClassIdentitySet(
    context,
    sourceType,
    targetType,
    targetIdentitySet,
  );
}

function classifyUnsoundNominalNewtypeRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  relationSite?: ts.Node,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
): RelationMismatch | undefined {
  const targetIdentitySet = getTargetNewtypeIdentitySet(context, targetType);
  if (!targetIdentitySet) {
    return undefined;
  }

  if (
    canConstructTargetNewtypeInDefiningModule(
      context,
      sourceType,
      targetType,
      relationSite,
      sourceExpression,
      sourceTypeNode,
    )
  ) {
    return undefined;
  }

  if (targetIdentitySet.mode === 'union') {
    const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
    const sourceBranches = (normalizedSourceType.flags & ts.TypeFlags.Union) !== 0
      ? (normalizedSourceType as ts.UnionType).types
      : [normalizedSourceType];

    for (const sourceBranch of sourceBranches) {
      const branchMatched = targetIdentitySet.identities.some((targetIdentity) =>
        sourceNewtypeMatchesTargetIdentity(context, sourceBranch, targetIdentity)
      );
      if (!branchMatched) {
        return createNominalNewtypeRelationMismatch(
          context,
          sourceType,
          targetType,
          targetIdentitySet,
        );
      }
    }

    return undefined;
  }

  for (const targetIdentity of targetIdentitySet.identities) {
    if (!sourceNewtypeMatchesTargetIdentity(context, sourceType, targetIdentity)) {
      return createNominalNewtypeRelationMismatch(
        context,
        sourceType,
        targetType,
        targetIdentitySet,
      );
    }
  }

  return undefined;
}

function classifyUnsoundGenericClassInstanceRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  if (
    sharesCanonicalResultClassFamily(context, sourceType, targetType) ||
    sharesGenericAliasRelationFamily(context, sourceType, targetType) ||
    sharesExactGenericClassIdentityFamilies(context, sourceType, targetType) ||
    sharesEquivalentTargetClassIdentitySets(context, sourceType, targetType)
  ) {
    return undefined;
  }

  const sourceIdentities = collectGenericClassIdentities(context, sourceType);
  const targetIdentities = collectGenericClassIdentities(context, targetType);
  if (sourceIdentities.length === 0 || targetIdentities.length === 0) {
    return undefined;
  }

  for (const sourceIdentity of sourceIdentities) {
    for (const targetIdentity of targetIdentities) {
      if (sourceIdentity.symbol !== targetIdentity.symbol) {
        continue;
      }

      if (sourceIdentity.typeArguments.length !== targetIdentity.typeArguments.length) {
        continue;
      }

      const hasExactMatch = sourceIdentity.typeArguments.every((sourceTypeArgument, index) => {
        const targetTypeArgument = targetIdentity.typeArguments[index];
        return targetTypeArgument !== undefined &&
          areExactTypeArguments(context, sourceTypeArgument, targetTypeArgument);
      });
      if (hasExactMatch) {
        continue;
      }

      return {
        kind: 'genericClassExactMatchVariance',
        message: 'Generic class instances are exact-match only in soundscript.',
        notes: [
          `'${context.checker.typeToString(sourceType)}' cannot be widened to '${
            context.checker.typeToString(targetType)
          }' because generic class instances may hide mutable or type-sensitive state behind their public API.`,
        ],
        hint:
          'Keep the exact class instantiation, project to a narrower structural interface, or copy into a fresh value.',
      };
    }
  }

  return undefined;
}

function sharesGenericAliasRelationFamily(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): boolean {
  const sourceInfo = getGenericRelationTypeInfo(
    context,
    getSafeNonNullableRelationType(context, sourceType),
  );
  const targetInfo = getGenericRelationTypeInfo(
    context,
    getSafeNonNullableRelationType(context, targetType),
  );
  return sourceInfo?.kind === 'alias' &&
    targetInfo?.kind === 'alias' &&
    sourceInfo.symbol === targetInfo.symbol;
}

function sharesExactGenericClassIdentityFamilies(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): boolean {
  const sourceIdentities = collectGenericClassIdentities(context, sourceType);
  const targetIdentities = collectGenericClassIdentities(context, targetType);
  if (sourceIdentities.length === 0 || sourceIdentities.length !== targetIdentities.length) {
    return false;
  }

  const unmatchedTargetIndices = new Set(targetIdentities.map((_identity, index) => index));
  for (const sourceIdentity of sourceIdentities) {
    let matchedTargetIndex: number | undefined;
    for (const targetIndex of unmatchedTargetIndices) {
      const targetIdentity = targetIdentities[targetIndex];
      if (targetIdentity && classIdentitiesMatch(context, sourceIdentity, targetIdentity)) {
        matchedTargetIndex = targetIndex;
        break;
      }
    }
    if (matchedTargetIndex === undefined) {
      return false;
    }
    unmatchedTargetIndices.delete(matchedTargetIndex);
  }

  return unmatchedTargetIndices.size === 0;
}

function sharesEquivalentTargetClassIdentitySets(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): boolean {
  const sourceIdentitySet = getTargetClassIdentitySet(context, sourceType);
  const targetIdentitySet = getTargetClassIdentitySet(context, targetType);
  if (
    !sourceIdentitySet || !targetIdentitySet || sourceIdentitySet.mode !== targetIdentitySet.mode
  ) {
    return false;
  }

  return sourceIdentitySet.identities.length === targetIdentitySet.identities.length &&
    sourceIdentitySet.identities.every((sourceIdentity) =>
      targetIdentitySet.identities.some((targetIdentity) =>
        classIdentitiesMatch(context, sourceIdentity, targetIdentity)
      )
    );
}

function isTrustedResultStdlibSourceFileName(fileName: string): boolean {
  return /(?:^|[\\/])(?:index|result)(?:\.sts)?(?:\.d)?\.ts$/.test(fileName);
}

function getCanonicalResultClassFamilyForName(
  name: string,
): CanonicalResultClassFamily | undefined {
  switch (name) {
    case 'Err':
    case 'Ok':
    case 'Result':
      return 'result';
    case 'None':
    case 'Option':
    case 'Some':
      return 'option';
    default:
      return undefined;
  }
}

function getCanonicalResultClassFamilyForGenericRelationInfo(
  info: GenericRelationTypeInfo,
): CanonicalResultClassFamily | undefined {
  const declarations = info.symbol.getDeclarations() ?? [];
  if (!declarations.some((declaration) =>
    isTrustedSoundLibSourceFile(declaration.getSourceFile()) &&
    isTrustedResultStdlibSourceFileName(declaration.getSourceFile().fileName)
  )) {
    return undefined;
  }

  return getCanonicalResultClassFamilyForName(info.name);
}

function getCanonicalResultClassFamilyForIdentity(
  identity: GenericClassIdentity,
): CanonicalResultClassFamily | undefined {
  const declarations = identity.symbol.getDeclarations() ?? [];
  if (!declarations.some((declaration) =>
    isTrustedSoundLibSourceFile(declaration.getSourceFile()) &&
    isTrustedResultStdlibSourceFileName(declaration.getSourceFile().fileName)
  )) {
    return undefined;
  }

  return getCanonicalResultClassFamilyForName(identity.symbol.getName());
}

function getCanonicalResultClassFamilyForTargetIdentitySet(
  identitySet: TargetClassIdentitySet,
): CanonicalResultClassFamily | undefined {
  let family: CanonicalResultClassFamily | undefined;
  for (const identity of identitySet.identities) {
    const identityFamily = getCanonicalResultClassFamilyForIdentity(identity);
    if (!identityFamily) {
      return undefined;
    }
    if (family && family !== identityFamily) {
      return undefined;
    }
    family = identityFamily;
  }

  return family;
}

function getCanonicalResultClassFamilyForType(
  context: AnalysisContext,
  type: ts.Type,
  visitedTypeIds: Set<number> = new Set(),
): CanonicalResultClassFamily | undefined {
  const normalizedType = getSafeNonNullableRelationType(context, type);
  const rawTypeId = (normalizedType as ts.Type & { id?: number }).id;
  let visitedTypeId: number | undefined;
  if (typeof rawTypeId === 'number') {
    if (visitedTypeIds.has(rawTypeId)) {
      return undefined;
    }
    visitedTypeIds.add(rawTypeId);
    visitedTypeId = rawTypeId;
  }

  try {
    if ((normalizedType.flags & ts.TypeFlags.Union) !== 0) {
      let family: CanonicalResultClassFamily | undefined;
      let sawConstituent = false;
      for (const constituentType of (normalizedType as ts.UnionType).types) {
        const normalizedConstituentType = getSafeNonNullableRelationType(context, constituentType);
        if ((normalizedConstituentType.flags & ts.TypeFlags.Never) !== 0) {
          continue;
        }
        const constituentFamily = getCanonicalResultClassFamilyForType(
          context,
          normalizedConstituentType,
          visitedTypeIds,
        );
        if (!constituentFamily) {
          return undefined;
        }
        if (family && family !== constituentFamily) {
          return undefined;
        }
        sawConstituent = true;
        family = constituentFamily;
      }

      return sawConstituent ? family : undefined;
    }

    if ((normalizedType.flags & ts.TypeFlags.Intersection) !== 0) {
      let family: CanonicalResultClassFamily | undefined;
      for (const constituentType of (normalizedType as ts.IntersectionType).types) {
        const constituentFamily = getCanonicalResultClassFamilyForType(
          context,
          constituentType,
          visitedTypeIds,
        );
        if (!constituentFamily) {
          continue;
        }
        if (family && family !== constituentFamily) {
          return undefined;
        }
        family = constituentFamily;
      }

      return family;
    }

    const relationInfo = getGenericRelationTypeInfo(context, normalizedType);
    const relationFamily = relationInfo
      ? getCanonicalResultClassFamilyForGenericRelationInfo(relationInfo)
      : undefined;
    if (relationFamily) {
      return relationFamily;
    }

    const directIdentity = getDirectClassIdentity(context, normalizedType);
    const directFamily = directIdentity
      ? getCanonicalResultClassFamilyForIdentity(directIdentity)
      : undefined;
    if (directFamily) {
      return directFamily;
    }

    const identities = collectGenericClassIdentities(context, normalizedType);
    if (identities.length === 0) {
      return undefined;
    }

    let family: CanonicalResultClassFamily | undefined;
    for (const identity of identities) {
      const identityFamily = getCanonicalResultClassFamilyForIdentity(identity);
      if (!identityFamily) {
        return undefined;
      }
      if (family && family !== identityFamily) {
        return undefined;
      }
      family = identityFamily;
    }

    return family;
  } finally {
    if (visitedTypeId !== undefined) {
      visitedTypeIds.delete(visitedTypeId);
    }
  }
}

function sharesCanonicalResultClassFamily(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): boolean {
  const sourceFamily = getCanonicalResultClassFamilyForType(context, sourceType);
  return sourceFamily !== undefined &&
    sourceFamily === getCanonicalResultClassFamilyForType(context, targetType);
}

function getGenericParameterNames(
  symbol: ts.Symbol,
  arity: number,
): readonly string[] {
  const typeParameters = getSymbolTypeParameterDeclarations(symbol);
  return typeParameters.length === arity
    ? typeParameters.map((parameter) => parameter.name.text)
    : Array.from({ length: arity }, (_, index) => `T${index}`);
}

function createGenericVarianceMismatch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  details: GenericVarianceMismatchDetails,
): RelationMismatch {
  const varianceText = details.variance === 'contravariant'
    ? 'contravariant'
    : details.variance === 'invariant'
    ? 'invariant'
    : 'covariant';
  const sourceTypeText = context.checker.typeToString(sourceType);
  const targetTypeText = context.checker.typeToString(targetType);
  const sourceTypeArgumentText = context.checker.typeToString(details.sourceTypeArgument);
  const targetTypeArgumentText = context.checker.typeToString(details.targetTypeArgument);

  let roleExplanation: string;
  let assignabilityExplanation: string;
  let counterexample: string;
  let hint: string;
  switch (details.variance) {
    case 'covariant':
      roleExplanation =
        `covariant parameter '${details.parameterName}' flows out of '${details.typeName}'.`;
      assignabilityExplanation =
        `For a covariant parameter, the source argument must be assignable to the target argument: '${sourceTypeArgumentText}' -> '${targetTypeArgumentText}' fails here.`;
      counterexample =
        `Code typed as '${targetTypeText}' could read '${targetTypeArgumentText}' values, but '${sourceTypeText}' only proves '${sourceTypeArgumentText}'.`;
      hint =
        `Keep the exact instantiation, project to a read-only structural type, or introduce a wrapper with the direction you need. If this surface is intentionally output-only, document it with \`// #[variance(${details.parameterName}: out)]\`.`;
      break;
    case 'contravariant':
      roleExplanation =
        `contravariant parameter '${details.parameterName}' flows into '${details.typeName}'.`;
      assignabilityExplanation =
        `For a contravariant parameter, the target argument must be assignable to the source argument: '${targetTypeArgumentText}' -> '${sourceTypeArgumentText}' fails here.`;
      counterexample =
        `Code typed as '${targetTypeText}' could pass '${targetTypeArgumentText}' into the surface, but '${sourceTypeText}' only accepts '${sourceTypeArgumentText}'.`;
      hint =
        `Keep the exact instantiation, widen the source parameter type, or introduce an adapter with the direction you need. If this surface is intentionally input-only, document it with \`// #[variance(${details.parameterName}: in)]\`.`;
      break;
    case 'invariant':
      roleExplanation =
        `invariant parameter '${details.parameterName}' flows both into and out of '${details.typeName}'.`;
      assignabilityExplanation =
        `For an invariant parameter, the source and target arguments must match exactly: '${sourceTypeArgumentText}' versus '${targetTypeArgumentText}' fails here.`;
      counterexample =
        `The two instantiations expose '${details.parameterName}' in opposite directions, so either reads or writes would become unsound after widening.`;
      hint =
        `Keep the exact instantiation, split reads from writes into separate surfaces, or introduce wrappers with one-way variance. If this surface is intentionally invariant, document it with \`// #[variance(${details.parameterName}: inout)]\`.`;
      break;
  }

  return {
    kind: 'genericTypeVariance',
    message:
      `Generic parameter '${details.parameterName}' of '${details.typeName}' is ${varianceText} in soundscript.`,
    metadata: {
      rule: 'generic_variance_mismatch',
      fixability: 'local_rewrite',
      invariant:
        `Parameter '${details.parameterName}' of '${details.typeName}' is ${varianceText}, so only the corresponding direction is sound.`,
      replacementFamily: 'adapter_or_checked_variance_annotation',
      primarySymbol: details.typeName,
      secondarySymbol: details.parameterName,
      evidence: [
        createVarianceEvidence('typeParameter', details.parameterName),
        createVarianceEvidence('variance', varianceText),
        createVarianceEvidence('sourceType', sourceTypeText),
        createVarianceEvidence('targetType', targetTypeText),
        createVarianceEvidence('sourceArgument', sourceTypeArgumentText),
        createVarianceEvidence('targetArgument', targetTypeArgumentText),
        createVarianceEvidence(
          'requiredRelation',
          details.variance === 'covariant'
            ? `${sourceTypeArgumentText} -> ${targetTypeArgumentText}`
            : details.variance === 'contravariant'
            ? `${targetTypeArgumentText} -> ${sourceTypeArgumentText}`
            : `${sourceTypeArgumentText} == ${targetTypeArgumentText}`,
        ),
      ],
      counterexample,
    },
    notes: [
      `'${sourceTypeText}' cannot be assigned to '${targetTypeText}' because ${roleExplanation}`,
      assignabilityExplanation,
      `Counterexample: ${counterexample}`,
    ],
    hint,
  };
}

function createUnsupportedAliasInvariantMismatch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  typeName: string,
): RelationMismatch {
  const sourceTypeText = context.checker.typeToString(sourceType);
  const targetTypeText = context.checker.typeToString(targetType);
  return {
    kind: 'genericTypeVariance',
    message: `Generic alias '${typeName}' is invariant in soundscript.`,
    metadata: {
      rule: 'generic_alias_invariance',
      fixability: 'api_redesign',
      invariant:
        'Imported generic aliases default to invariant unless soundscript can prove a checked variance contract for the declaration surface.',
      replacementFamily: 'provable_generic_surface',
      primarySymbol: typeName,
      evidence: [
        createVarianceEvidence('sourceType', sourceTypeText),
        createVarianceEvidence('targetType', targetTypeText),
      ],
    },
    notes: [
      `'${sourceTypeText}' cannot be widened to '${targetTypeText}' because unsupported imported generic aliases default to invariant in soundscript.`,
    ],
    hint:
      'Keep the exact instantiation, rewrite the alias to a provable interface or alias surface, or add a checked variance contract only after the declaration becomes provable.',
  };
}

function createVarianceAnnotationRelationMismatch(
  details: VarianceAnnotationDiagnosticDetails,
): RelationMismatch {
  return {
    kind: details.code === SOUND_DIAGNOSTIC_CODES.invalidVarianceAnnotation
      ? 'invalidVarianceAnnotation'
      : 'varianceAnnotationMismatch',
    metadata: details.metadata,
    message: details.message,
    notes: details.notes ? [...details.notes] : undefined,
    hint: details.hint,
  };
}

function analyzeGenericTypeArgumentsRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  relationSite: ts.Node | undefined,
  symbol: ts.Symbol,
  typeName: string,
  variances: readonly GenericVariance[],
  sourceTypeArguments: readonly ts.Type[],
  targetTypeArguments: readonly ts.Type[],
  visitedPairs: Set<string>,
): RecursiveGenericRelationResult {
  if (
    variances.length === 0 ||
    sourceTypeArguments.length !== targetTypeArguments.length ||
    variances.length !== sourceTypeArguments.length
  ) {
    return { handled: false };
  }

  const parameterNames = getGenericParameterNames(symbol, variances.length);
  for (const [index, variance] of variances.entries()) {
    const sourceTypeArgument = sourceTypeArguments[index];
    const targetTypeArgument = targetTypeArguments[index];
    if (!sourceTypeArgument || !targetTypeArgument || variance === 'independent') {
      continue;
    }

    if (variance === 'covariant') {
      if (!context.checker.isTypeAssignableTo(sourceTypeArgument, targetTypeArgument)) {
        return {
          handled: true,
          mismatch: createGenericVarianceMismatch(context, sourceType, targetType, {
            parameterName: parameterNames[index] ?? `T${index}`,
            typeName,
            variance,
            sourceTypeArgument,
            targetTypeArgument,
          }),
        };
      }
      const mismatch = classifyUnsoundRelation(
        context,
        sourceTypeArgument,
        targetTypeArgument,
        relationSite,
        visitedPairs,
      );
      if (mismatch) {
        return { handled: true, mismatch };
      }
      continue;
    }

    if (variance === 'contravariant') {
      const mismatch = classifyUnsoundRelation(
        context,
        targetTypeArgument,
        sourceTypeArgument,
        relationSite,
        visitedPairs,
      );
      if (mismatch) {
        return { handled: true, mismatch };
      }
      if (!context.checker.isTypeAssignableTo(targetTypeArgument, sourceTypeArgument)) {
        return {
          handled: true,
          mismatch: createGenericVarianceMismatch(context, sourceType, targetType, {
            parameterName: parameterNames[index] ?? `T${index}`,
            typeName,
            variance,
            sourceTypeArgument,
            targetTypeArgument,
          }),
        };
      }
      continue;
    }

    if (!areExactTypeArguments(context, sourceTypeArgument, targetTypeArgument)) {
      return {
        handled: true,
        mismatch: createGenericVarianceMismatch(context, sourceType, targetType, {
          parameterName: parameterNames[index] ?? `T${index}`,
          typeName,
          variance: 'invariant',
          sourceTypeArgument,
          targetTypeArgument,
        }),
      };
    }
  }

  return { handled: true };
}

function classifyInferUtilityWrapperRelation(
  context: AnalysisContext,
  sourceExpression: ts.Expression | undefined,
  sourceTypeNode: ts.TypeNode | undefined,
  targetTypeNode: ts.TypeNode | undefined,
): RelationMismatch | undefined {
  const resolvedWrapperRelation = resolveInferUtilityWrapperRelation(
    context,
    sourceExpression,
    sourceTypeNode,
    targetTypeNode,
  );
  if (!resolvedWrapperRelation) {
    return undefined;
  }

  return classifyResolvedInferUtilityWrapperRelation(context, resolvedWrapperRelation);
}

function isInferUtilityWrapperName(name: string): name is InferUtilityWrapperName {
  return name === 'ReturnType' ||
    name === 'Parameters' ||
    name === 'ConstructorParameters' ||
    name === 'ThisParameterType' ||
    name === 'OmitThisParameter';
}

function resolveInferUtilitySourceWrappedTypeNode(
  context: AnalysisContext,
  sourceExpression: ts.Expression | undefined,
  sourceTypeNode: ts.TypeNode | undefined,
  relationSymbol: ts.Symbol,
  utilityName: InferUtilityWrapperName,
): ts.TypeNode | undefined {
  const declaredWrappedTypeNode = getDeclaredGenericAliasTypeArgumentNodesFromTypeNode(
    context,
    sourceTypeNode,
    relationSymbol,
  )?.[0] ?? getDeclaredGenericAliasTypeArgumentNodesFromExpression(
    context,
    sourceExpression,
    relationSymbol,
  )?.[0];
  if (declaredWrappedTypeNode) {
    return declaredWrappedTypeNode;
  }

  const unwrappedSourceTypeNode = unwrapRelationTypeNode(sourceTypeNode);
  if (!unwrappedSourceTypeNode || !isRelationReferenceTypeNode(unwrappedSourceTypeNode)) {
    return undefined;
  }

  const sourceUtilitySymbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, unwrappedSourceTypeNode),
  );
  return sourceUtilitySymbol?.getName() === utilityName
    ? unwrappedSourceTypeNode.typeArguments?.[0]
    : undefined;
}

function resolveInferUtilityWrapperRelation(
  context: AnalysisContext,
  sourceExpression: ts.Expression | undefined,
  sourceTypeNode: ts.TypeNode | undefined,
  targetTypeNode: ts.TypeNode | undefined,
): ResolvedInferUtilityWrapperRelation | undefined {
  const unwrappedTargetTypeNode = unwrapRelationTypeNode(targetTypeNode);
  if (!unwrappedTargetTypeNode || !isRelationReferenceTypeNode(unwrappedTargetTypeNode)) {
    return undefined;
  }

  const targetSymbol = getRelationReferenceTypeNodeSymbol(context, unwrappedTargetTypeNode);
  const resolvedTargetSymbol = getResolvedAliasSymbol(context, targetSymbol);
  if (!resolvedTargetSymbol) {
    return undefined;
  }

  const utilityName = resolvedTargetSymbol.getName();
  if (!isInferUtilityWrapperName(utilityName)) {
    return undefined;
  }

  const targetWrappedTypeNode = unwrappedTargetTypeNode.typeArguments?.[0];
  const sourceWrappedTypeNode = resolveInferUtilitySourceWrappedTypeNode(
    context,
    sourceExpression,
    sourceTypeNode,
    targetSymbol!,
    utilityName,
  );
  if (!targetWrappedTypeNode || !sourceWrappedTypeNode) {
    return undefined;
  }

  const targetWrappedType = context.checker.getTypeFromTypeNode(targetWrappedTypeNode);
  const sourceWrappedType = context.checker.getTypeFromTypeNode(sourceWrappedTypeNode);
  const signatureKind = utilityName === 'ConstructorParameters'
    ? ts.SignatureKind.Construct
    : ts.SignatureKind.Call;
  const targetSignature = context.checker.getSignaturesOfType(targetWrappedType, signatureKind).at(
    -1,
  );
  const sourceSignature = context.checker.getSignaturesOfType(sourceWrappedType, signatureKind).at(
    -1,
  );
  if (!targetSignature || !sourceSignature) {
    return undefined;
  }

  return {
    utilityName,
    sourceWrappedType,
    targetWrappedType,
    sourceSignature,
    targetSignature,
  };
}

function classifyResolvedInferUtilityWrapperRelation(
  context: AnalysisContext,
  resolvedWrapperRelation: ResolvedInferUtilityWrapperRelation,
): RelationMismatch | undefined {
  const {
    utilityName,
    sourceWrappedType,
    targetWrappedType,
    sourceSignature,
    targetSignature,
  } = resolvedWrapperRelation;

  if (utilityName === 'ThisParameterType') {
    const targetThisParameterType = getSignatureThisParameterType(context, targetSignature);
    const sourceThisParameterType = getSignatureThisParameterType(context, sourceSignature);
    if (!targetThisParameterType || !sourceThisParameterType) {
      return undefined;
    }

    return classifyUnsoundTypeNodeGenericAliasRelation(
      context,
      sourceThisParameterType,
      targetThisParameterType,
      getResolvedSignatureThisParameterTypeNode(
        context,
        targetWrappedType,
        targetSignature,
        targetThisParameterType,
      ),
      undefined,
      getResolvedSignatureThisParameterTypeNode(
        context,
        sourceWrappedType,
        sourceSignature,
        sourceThisParameterType,
      ),
    );
  }

  if (utilityName === 'OmitThisParameter') {
    const thisParameterMismatch = (() => {
      const targetThisParameterType = getSignatureThisParameterType(context, targetSignature);
      const sourceThisParameterType = getSignatureThisParameterType(context, sourceSignature);
      if (!targetThisParameterType || !sourceThisParameterType) {
        return undefined;
      }

      return classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourceThisParameterType,
        targetThisParameterType,
        getResolvedSignatureThisParameterTypeNode(
          context,
          targetWrappedType,
          targetSignature,
          targetThisParameterType,
        ),
        undefined,
        getResolvedSignatureThisParameterTypeNode(
          context,
          sourceWrappedType,
          sourceSignature,
          sourceThisParameterType,
        ),
      );
    })();
    if (thisParameterMismatch) {
      return thisParameterMismatch;
    }

    return classifyUnsoundSignatureRelation(
      context,
      sourceWrappedType,
      targetWrappedType,
      sourceSignature,
      targetSignature,
      undefined,
      new Set(),
    );
  }

  if (utilityName === 'ReturnType') {
    const targetReturnType = context.checker.getReturnTypeOfSignature(targetSignature);
    const sourceReturnType = context.checker.getReturnTypeOfSignature(sourceSignature);
    return classifyUnsoundTypeNodeGenericAliasRelation(
      context,
      sourceReturnType,
      targetReturnType,
      getResolvedSignatureReturnTypeNode(
        context,
        targetWrappedType,
        targetSignature,
        targetReturnType,
      ),
      undefined,
      getResolvedSignatureReturnTypeNode(
        context,
        sourceWrappedType,
        sourceSignature,
        sourceReturnType,
      ),
    );
  }

  const targetParameters = targetSignature.getParameters();
  const sourceParameters = sourceSignature.getParameters();
  if (targetParameters.length !== sourceParameters.length) {
    return undefined;
  }

  for (const [index, targetParameter] of targetParameters.entries()) {
    const sourceParameter = sourceParameters[index];
    if (!sourceParameter) {
      continue;
    }

    const targetParameterType = getSignatureParameterType(
      context,
      targetSignature,
      targetParameter,
    );
    const sourceParameterType = getSignatureParameterType(
      context,
      sourceSignature,
      sourceParameter,
    );
    const parameterMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
      context,
      sourceParameterType,
      targetParameterType,
      getResolvedSignatureParameterTypeNode(
        context,
        targetWrappedType,
        targetSignature,
        targetParameter,
        targetParameterType,
      ),
      undefined,
      getResolvedSignatureParameterTypeNode(
        context,
        sourceWrappedType,
        sourceSignature,
        sourceParameter,
        sourceParameterType,
      ),
    );
    if (parameterMismatch) {
      return parameterMismatch;
    }
  }

  return undefined;
}

function analyzeRecursiveGenericRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  relationSite?: ts.Node,
  visitedPairs: Set<string> = new Set(),
): RecursiveGenericRelationResult {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);
  const pairKey = getRelationTypePairKey(
    context,
    'generic',
    normalizedSourceType,
    normalizedTargetType,
  );
  if (visitedPairs.has(pairKey)) {
    return { handled: false };
  }
  visitedPairs.add(pairKey);

  if (
    isArrayType(context, normalizedSourceType) &&
    isArrayType(context, normalizedTargetType) &&
    (isReadonlyArrayLikeType(context, normalizedSourceType) ||
      isReadonlyArrayLikeType(context, normalizedTargetType))
  ) {
    const sourceElementType = getArrayElementType(context, normalizedSourceType);
    const targetElementType = getArrayElementType(context, normalizedTargetType);
    if (sourceElementType && targetElementType) {
      return {
        handled: true,
        mismatch: classifyUnsoundRelation(
          context,
          sourceElementType,
          targetElementType,
          relationSite,
          visitedPairs,
        ),
      };
    }
  }

  if (
    isTupleType(context, normalizedSourceType) &&
    isTupleType(context, normalizedTargetType) &&
    (isReadonlyTupleType(context, normalizedSourceType) ||
      isReadonlyTupleType(context, normalizedTargetType))
  ) {
    const sourceElements = getTupleElementTypes(context, normalizedSourceType);
    const targetElements = getTupleElementTypes(context, normalizedTargetType);
    for (const [index, sourceElementType] of sourceElements.entries()) {
      const targetElementType = targetElements[index];
      if (!targetElementType) {
        continue;
      }
      const mismatch = classifyUnsoundRelation(
        context,
        sourceElementType,
        targetElementType,
        relationSite,
        visitedPairs,
      );
      if (mismatch) {
        return { handled: true, mismatch };
      }
    }
    return { handled: true };
  }

  const targetInfo = getGenericRelationTypeInfo(context, normalizedTargetType);
  if (!targetInfo) {
    return { handled: false };
  }
  const sourceInfo = getGenericRelationTypeInfo(context, normalizedSourceType);

  const targetAliasPolicy = targetInfo.kind === 'alias'
    ? getGenericAliasVariancePolicy(context, targetInfo.symbol)
    : undefined;
  const targetAliasPolicyMismatch = targetInfo.kind === 'alias'
    ? sourceInfo
    ? classifyGenericAliasPolicyFallbackMismatch(
      context,
      targetAliasPolicy,
      sourceType,
      targetType,
      targetInfo.name,
    )
    : undefined
    : undefined;
  if (targetAliasPolicyMismatch) {
    return {
      handled: true,
      mismatch: targetAliasPolicyMismatch,
    };
  }

  if (targetInfo.kind === 'alias' && isUnsupportedGenericAliasPolicy(targetAliasPolicy)) {
    return areExactTypeArguments(context, sourceType, targetType) ? { handled: true } : {
      handled: true,
      mismatch: createUnsupportedAliasInvariantMismatch(
        context,
        sourceType,
        targetType,
        targetInfo.name,
      ),
    };
  }

  if (!sourceInfo) {
    return { handled: false };
  }

  if (
    sourceInfo.kind === 'reference' &&
    targetInfo.kind === 'reference' &&
    (
      (sourceInfo.name === 'Map' && targetInfo.name === 'Map') ||
      (sourceInfo.name === 'Set' && targetInfo.name === 'Set')
    )
  ) {
    return { handled: false };
  }

  let relationSymbol = targetInfo.symbol;
  let relationName = targetInfo.name;
  let sourceTypeArguments = sourceInfo.typeArguments;
  let variances: readonly GenericVariance[] | undefined;
  if (sourceInfo.symbol !== targetInfo.symbol) {
    if (isGenericClassSymbol(sourceInfo.symbol)) {
      return { handled: false };
    }

    const matchingBaseType = getMatchingBaseType(
      context,
      normalizedSourceType,
      targetInfo.symbol,
    );
    if (!matchingBaseType) {
      return { handled: false };
    }

    const matchingBaseInfo = getGenericRelationTypeInfo(context, matchingBaseType);
    if (!matchingBaseInfo || matchingBaseInfo.symbol !== targetInfo.symbol) {
      return { handled: false };
    }

    sourceTypeArguments = substituteBaseTypeArguments(
      context,
      sourceInfo.symbol,
      sourceInfo.typeArguments,
      matchingBaseInfo.typeArguments,
    );
    relationSymbol = matchingBaseInfo.symbol;
    relationName = matchingBaseInfo.name;
  }

  if (isGenericClassSymbol(sourceInfo.symbol)) {
    return { handled: false };
  }
  variances = getResolvedGenericVariances(context, relationSymbol);

  return analyzeGenericTypeArgumentsRelation(
    context,
    sourceType,
    targetType,
    relationSite,
    relationSymbol,
    relationName,
    variances,
    sourceTypeArguments,
    targetInfo.typeArguments,
    visitedPairs,
  );
}

function classifyCurrentTypeNodeGenericAliasRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetTypeNode: ts.TypeNode | undefined,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
): RecursiveGenericRelationResult {
  try {
    const unwrappedTargetTypeNode = unwrapRelationTypeNode(targetTypeNode);
    const unwrappedSourceTypeNode = unwrapRelationTypeNode(sourceTypeNode);
    if (
      (unwrappedTargetTypeNode !== undefined && ts.isThisTypeNode(unwrappedTargetTypeNode)) ||
      (unwrappedSourceTypeNode !== undefined && ts.isThisTypeNode(unwrappedSourceTypeNode))
    ) {
      return { handled: false };
    }

    const newtypeEscapeMismatch = classifySourceNewtypeEscapeRelation(
      context,
      sourceType,
      targetType,
      targetTypeNode,
      sourceExpression ?? sourceTypeNode ?? targetTypeNode,
      sourceExpression,
      sourceTypeNode,
    );
    if (newtypeEscapeMismatch) {
      return { handled: true, mismatch: newtypeEscapeMismatch };
    }

    const newtypeMismatch = classifyCurrentTypeNodeNewtypeRelation(
      context,
      sourceType,
      targetType,
      targetTypeNode,
      sourceExpression ?? sourceTypeNode ?? targetTypeNode,
      sourceExpression,
      sourceTypeNode,
    );
    if (newtypeMismatch) {
      return { handled: true, mismatch: newtypeMismatch };
    }

    const inferUtilityMismatch = classifyInferUtilityWrapperRelation(
      context,
      sourceExpression,
      sourceTypeNode,
      targetTypeNode,
    );
    if (inferUtilityMismatch) {
      return { handled: true, mismatch: inferUtilityMismatch };
    }

    const relationTargetTypeNode = unwrapRelationTypeNode(targetTypeNode);
    if (
      relationTargetTypeNode &&
      isRelationReferenceTypeNode(relationTargetTypeNode) &&
      !typeNodeContainsTypeParameterReference(context, relationTargetTypeNode)
    ) {
      if (getTransparentRelationWrapperPayloadTypeNode(context, relationTargetTypeNode)) {
        return { handled: false };
      }

      const targetSymbol = getRelationReferenceTypeNodeSymbol(context, relationTargetTypeNode);
      if (targetSymbol) {
        const aliasPolicy = getGenericAliasVariancePolicy(context, targetSymbol);
        if (aliasPolicy) {
          const targetTypeArguments = getRelationReferenceTypeArguments(
            context,
            relationTargetTypeNode,
          );
          let sourceTypeArguments:
            | readonly ts.Type[]
            | undefined;

          if (
            (aliasPolicy.isImportedDeclarationAlias || aliasPolicy.hasVarianceAnnotation) &&
            targetTypeArguments.length === aliasPolicy.typeParameters.length
          ) {
            sourceTypeArguments = getDeclaredGenericAliasTypeArgumentsFromTypeNode(
              context,
              sourceTypeNode,
              targetSymbol,
            ) ?? getDeclaredGenericAliasTypeArgumentsFromExpression(
              context,
              sourceExpression,
              targetSymbol,
            ) ?? getMatchingGenericRelationTypeArguments(
              context,
              sourceType,
              targetSymbol,
            );
            if (
              sourceTypeArguments &&
              sourceTypeArguments.length === aliasPolicy.typeParameters.length
            ) {
              if (aliasPolicy.varianceAnnotationDetails) {
                return {
                  handled: true,
                  mismatch: createVarianceAnnotationRelationMismatch(
                    aliasPolicy.varianceAnnotationDetails,
                  ),
                };
              }

              if (aliasPolicy.variances.length === aliasPolicy.typeParameters.length) {
                return {
                  handled: true,
                  mismatch: analyzeGenericTypeArgumentsRelation(
                    context,
                    sourceType,
                    targetType,
                    sourceExpression ?? sourceTypeNode ?? targetTypeNode,
                    targetSymbol,
                    targetSymbol.getName(),
                    aliasPolicy.variances,
                    sourceTypeArguments,
                    targetTypeArguments,
                    new Set(),
                  ).mismatch,
                };
              }
            }
          }

          if (
            sourceTypeArguments === undefined &&
            aliasPolicy.isImportedDeclarationAlias &&
            !aliasPolicy.hasVarianceAnnotation
          ) {
            return { handled: false };
          }

          const aliasPolicyMismatch = classifyGenericAliasPolicyFallbackMismatch(
            context,
            aliasPolicy,
            sourceType,
            targetType,
            targetSymbol.getName(),
          );
          if (aliasPolicyMismatch) {
            return { handled: true, mismatch: aliasPolicyMismatch };
          }

          if (aliasPolicy.variances.length === aliasPolicy.typeParameters.length) {
            return { handled: true };
          }

          if (aliasPolicy.hasVarianceAnnotation || aliasPolicy.isImportedDeclarationAlias) {
            if (!areExactTypeArguments(context, sourceType, targetType)) {
              return {
                handled: true,
                mismatch: createUnsupportedAliasInvariantMismatch(
                  context,
                  sourceType,
                  targetType,
                  targetSymbol.getName(),
                ),
              };
            }

            return { handled: true };
          }
        }
      }
    }

    const nominalClassTypeNodeMismatch = classifyCurrentTypeNodeNominalClassRelation(
      context,
      sourceType,
      targetType,
      targetTypeNode,
      sourceExpression,
      sourceTypeNode,
    );
    if (nominalClassTypeNodeMismatch) {
      return { handled: true, mismatch: nominalClassTypeNodeMismatch };
    }

    return { handled: false };
  } catch (error) {
    if (isStackOverflowLikeError(error)) {
      return { handled: false };
    }
    throw error;
  }
}

function getNestedGenericRelationTypeArguments(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): readonly {
  sourceType: ts.Type;
  targetType: ts.Type;
}[] {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);
  const sourceInfo = getGenericRelationTypeInfo(context, normalizedSourceType);
  const targetInfo = getGenericRelationTypeInfo(context, normalizedTargetType);
  if (!sourceInfo || !targetInfo) {
    return [];
  }

  let sourceTypeArguments = sourceInfo.typeArguments;
  if (sourceInfo.symbol !== targetInfo.symbol) {
    if (isGenericClassSymbol(sourceInfo.symbol)) {
      return [];
    }

    const matchingBaseType = getMatchingBaseType(
      context,
      normalizedSourceType,
      targetInfo.symbol,
    );
    if (!matchingBaseType) {
      return [];
    }

    const matchingBaseInfo = getGenericRelationTypeInfo(context, matchingBaseType);
    if (!matchingBaseInfo || matchingBaseInfo.symbol !== targetInfo.symbol) {
      return [];
    }

    sourceTypeArguments = substituteBaseTypeArguments(
      context,
      sourceInfo.symbol,
      sourceInfo.typeArguments,
      matchingBaseInfo.typeArguments,
    );
  }

  if (sourceTypeArguments.length !== targetInfo.typeArguments.length) {
    return [];
  }

  return sourceTypeArguments.map((sourceTypeArgument, index) => ({
    sourceType: sourceTypeArgument,
    targetType: targetInfo.typeArguments[index]!,
  }));
}

function classifyUnsoundTypeNodeGenericAliasRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetTypeNode: ts.TypeNode | undefined,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
  visitedPairs: Set<string> = new Set(),
): RelationMismatch | undefined {
  const effectiveSourceTypeNode = sourceTypeNode ??
    getDeclaredTypeNodeFromExpression(context, sourceExpression) ??
    getSynthesizedRelationTypeNode(context, sourceType);
  const pairKey = getTypeNodeGenericAliasVisitKey(
    context,
    sourceType,
    targetType,
    targetTypeNode,
    effectiveSourceTypeNode,
  );
  if (visitedPairs.has(pairKey)) {
    return undefined;
  }
  visitedPairs.add(pairKey);
  const directResult = classifyCurrentTypeNodeGenericAliasRelation(
    context,
    sourceType,
    targetType,
    targetTypeNode,
    sourceExpression,
    effectiveSourceTypeNode,
  );
  if (directResult.handled) {
    return directResult.mismatch;
  }

  const unwrappedTargetTypeNode = unwrapRelationTypeNode(targetTypeNode);
  if (!unwrappedTargetTypeNode) {
    return undefined;
  }

  if (isRelationReferenceTypeNode(unwrappedTargetTypeNode)) {
    const targetWrapperSymbol = getResolvedAliasSymbol(
      context,
      getRelationReferenceTypeNodeSymbol(context, unwrappedTargetTypeNode),
    );
    const targetTransparentPayloadTypeNode = getTransparentRelationWrapperPayloadTypeNode(
      context,
      unwrappedTargetTypeNode,
    );
    if (targetWrapperSymbol && targetTransparentPayloadTypeNode) {
      const sourceTransparentPayloadTypeNode = getDeclaredGenericAliasTypeArgumentNodesFromTypeNode(
        context,
        effectiveSourceTypeNode,
        targetWrapperSymbol,
      )?.[0] ?? getDeclaredGenericAliasTypeArgumentNodesFromExpression(
        context,
        sourceExpression,
        targetWrapperSymbol,
      )?.[0];
      const expandedSourcePayloadTypeNode = expandOrdinaryRelationCarrierTypeNode(
        context,
        effectiveSourceTypeNode,
      );
      return classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourceType,
        targetType,
        targetTransparentPayloadTypeNode,
        sourceExpression,
        sourceTransparentPayloadTypeNode ?? expandedSourcePayloadTypeNode ??
          effectiveSourceTypeNode,
        visitedPairs,
      );
    }
  }

  const expandedTargetTypeNode = expandOrdinaryRelationCarrierTypeNode(context, targetTypeNode);
  if (expandedTargetTypeNode) {
    return classifyUnsoundTypeNodeGenericAliasRelation(
      context,
      sourceType,
      targetType,
      expandedTargetTypeNode,
      sourceExpression,
      expandOrdinaryRelationCarrierTypeNode(context, effectiveSourceTypeNode) ??
        effectiveSourceTypeNode,
      visitedPairs,
    );
  }

  if (ts.isTypeOperatorNode(unwrappedTargetTypeNode)) {
    const unwrappedSourceTypeNode = unwrapRelationTypeNode(sourceTypeNode);
    return classifyUnsoundTypeNodeGenericAliasRelation(
      context,
      sourceType,
      targetType,
      unwrappedTargetTypeNode.type,
      sourceExpression,
      unwrappedSourceTypeNode && ts.isTypeOperatorNode(unwrappedSourceTypeNode)
        ? unwrappedSourceTypeNode.type
        : effectiveSourceTypeNode,
      visitedPairs,
    );
  }

  if (ts.isUnionTypeNode(unwrappedTargetTypeNode)) {
    const targetConstituents = getCompositeRelationConstituents(targetType);
    const remainingTargetConstituents = [...targetConstituents];
    const sourceUnionTypeNode = unwrapRelationTypeNode(effectiveSourceTypeNode);
    const sourceIsUnion = (sourceType.flags & ts.TypeFlags.Union) !== 0 ||
      !!(sourceUnionTypeNode && ts.isUnionTypeNode(sourceUnionTypeNode));
    if (!sourceIsUnion) {
      let firstMismatch: RelationMismatch | undefined;
      for (const [index, constituentNode] of unwrappedTargetTypeNode.types.entries()) {
        const constituentNodeType = context.checker.getTypeFromTypeNode(constituentNode);
        const constituentTargetType = targetConstituents.find((candidate) =>
          areExactTypeArguments(context, candidate, constituentNodeType)
        ) ?? targetConstituents[index] ?? constituentNodeType;
        if (
          !areExactTypeArguments(context, sourceType, constituentNodeType) &&
          !context.checker.isTypeAssignableTo(sourceType, constituentTargetType)
        ) {
          continue;
        }

        const constituentMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
          context,
          sourceType,
          constituentTargetType,
          constituentNode,
          sourceExpression,
          effectiveSourceTypeNode,
          visitedPairs,
        );
        if (!constituentMismatch) {
          return undefined;
        }

        firstMismatch ??= constituentMismatch;
      }

      return firstMismatch;
    }

    const remainingSourceConstituents = sourceUnionTypeNode &&
        ts.isUnionTypeNode(sourceUnionTypeNode) &&
        !isSynthesizedRelationNode(sourceUnionTypeNode) &&
        sourceUnionTypeNode.types.every((typeNode) => !isSynthesizedRelationNode(typeNode))
      ? sourceUnionTypeNode.types.map((typeNode) => ({
        type: context.checker.getTypeFromTypeNode(typeNode),
        typeNode,
      }))
      : getCompositeRelationConstituents(sourceType).map((type) => ({
        type,
        typeNode: undefined,
      }));
    for (const [index, constituentNode] of unwrappedTargetTypeNode.types.entries()) {
      const constituentNodeType = context.checker.getTypeFromTypeNode(constituentNode);
      let constituentTargetType = targetConstituents[index];
      const matchingConstituentIndex = remainingTargetConstituents.findIndex((candidate) =>
        areExactTypeArguments(context, candidate, constituentNodeType)
      );
      if (matchingConstituentIndex >= 0) {
        constituentTargetType = remainingTargetConstituents[matchingConstituentIndex];
        remainingTargetConstituents.splice(matchingConstituentIndex, 1);
      }
      if (!constituentTargetType) {
        continue;
      }

      const matchingSourceIndex = remainingSourceConstituents.findIndex((candidate) =>
        areExactTypeArguments(context, candidate.type, constituentNodeType) ||
        context.checker.isTypeAssignableTo(candidate.type, constituentTargetType)
      );
      const sourceConstituent = matchingSourceIndex >= 0
        ? remainingSourceConstituents.splice(matchingSourceIndex, 1)[0]
        : context.checker.isTypeAssignableTo(sourceType, constituentTargetType)
        ? { type: sourceType, typeNode: effectiveSourceTypeNode }
        : undefined;
      if (!sourceConstituent) {
        continue;
      }

      const constituentMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourceConstituent.type,
        constituentTargetType,
        constituentNode,
        sourceExpression,
        sourceConstituent.typeNode ?? effectiveSourceTypeNode,
        visitedPairs,
      );
      if (constituentMismatch) {
        return constituentMismatch;
      }
    }
    return undefined;
  }

  if (ts.isIntersectionTypeNode(unwrappedTargetTypeNode)) {
    for (const constituentNode of unwrappedTargetTypeNode.types) {
      const constituentTargetType = context.checker.getTypeFromTypeNode(constituentNode);
      if (!context.checker.isTypeAssignableTo(sourceType, constituentTargetType)) {
        continue;
      }

      const constituentMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourceType,
        constituentTargetType,
        constituentNode,
        sourceExpression,
        effectiveSourceTypeNode,
        visitedPairs,
      );
      if (constituentMismatch) {
        return constituentMismatch;
      }
    }
    return undefined;
  }

  if (ts.isConditionalTypeNode(unwrappedTargetTypeNode)) {
    for (
      const branchNode of [unwrappedTargetTypeNode.trueType, unwrappedTargetTypeNode.falseType]
    ) {
      const branchTargetType = context.checker.getTypeFromTypeNode(branchNode);
      if (
        !areExactTypeArguments(context, branchTargetType, targetType) &&
        !context.checker.isTypeAssignableTo(sourceType, branchTargetType)
      ) {
        continue;
      }

      const branchMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourceType,
        branchTargetType,
        branchNode,
        sourceExpression,
        effectiveSourceTypeNode,
        visitedPairs,
      );
      if (branchMismatch) {
        return branchMismatch;
      }
    }
    return undefined;
  }

  if (ts.isTupleTypeNode(unwrappedTargetTypeNode)) {
    if (!isTupleType(context, sourceType) || !isTupleType(context, targetType)) {
      const pureRestElementNode = unwrappedTargetTypeNode.elements.length === 1
        ? getTupleElementRelationTypeNode(unwrappedTargetTypeNode.elements[0])
        : undefined;
      const sourceArrayLikeElementType = getArrayLikeElementType(context, sourceType);
      const targetArrayLikeElementType = getArrayLikeElementType(context, targetType);
      if (
        pureRestElementNode &&
        sourceArrayLikeElementType &&
        targetArrayLikeElementType
      ) {
        return classifyUnsoundTypeNodeGenericAliasRelation(
          context,
          sourceArrayLikeElementType,
          targetArrayLikeElementType,
          pureRestElementNode,
          sourceExpression,
          getArrayLiteralElementTypeNode(context, effectiveSourceTypeNode, 0),
          visitedPairs,
        );
      }
      return undefined;
    }

    const sourceElements = getTupleElementTypes(context, sourceType);
    const targetElements = getTupleElementTypes(context, targetType);
    for (const [index, elementNode] of unwrappedTargetTypeNode.elements.entries()) {
      const sourceElementType = sourceElements[index];
      const targetElementType = targetElements[index];
      if (!sourceElementType || !targetElementType) {
        continue;
      }

      const elementMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourceElementType,
        targetElementType,
        getTupleElementRelationTypeNode(elementNode),
        sourceExpression,
        getArrayLiteralElementTypeNode(context, effectiveSourceTypeNode, index),
        visitedPairs,
      );
      if (elementMismatch) {
        return elementMismatch;
      }
    }
    return undefined;
  }

  if (ts.isArrayTypeNode(unwrappedTargetTypeNode)) {
    const sourceElementTypeNode = getArrayLikeRelationElementTypeNode(
      context,
      effectiveSourceTypeNode,
    );
    const sourceElementType = sourceElementTypeNode
      ? context.checker.getTypeFromTypeNode(sourceElementTypeNode)
      : getArrayLikeElementType(context, sourceType);
    const targetElementType = context.checker.getTypeFromTypeNode(
      unwrappedTargetTypeNode.elementType,
    );
    if (!sourceElementType || !targetElementType) {
      return undefined;
    }

    return classifyUnsoundTypeNodeGenericAliasRelation(
      context,
      sourceElementType,
      targetElementType,
      unwrappedTargetTypeNode.elementType,
      sourceExpression,
      sourceElementTypeNode,
      visitedPairs,
    );
  }

  if (ts.isIndexedAccessTypeNode(unwrappedTargetTypeNode)) {
    const propertyNames = getIndexedAccessPropertyNames(unwrappedTargetTypeNode.indexType);
    if (!propertyNames || propertyNames.length === 0) {
      return undefined;
    }

    const objectTargetType = context.checker.getTypeFromTypeNode(
      unwrappedTargetTypeNode.objectType,
    );
    for (const propertyName of propertyNames) {
      const propertyTypeNode = getPropertyTypeNodeFromTypeNode(
        context,
        unwrappedTargetTypeNode.objectType,
        propertyName,
      );
      const propertyTargetType = getPropertyVarianceInfo(context, objectTargetType, propertyName)
        ?.readType;
      const effectivePropertyTypeNode = propertyTypeNode ??
        getSynthesizedRelationTypeNode(context, propertyTargetType);
      if (!effectivePropertyTypeNode || !propertyTargetType) {
        continue;
      }

      const propertyMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourceType,
        propertyTargetType,
        effectivePropertyTypeNode,
        sourceExpression,
        getPropertyTypeNodeFromTypeNode(context, effectiveSourceTypeNode, propertyName) ??
          effectiveSourceTypeNode,
        visitedPairs,
      );
      if (propertyMismatch) {
        return propertyMismatch;
      }
    }
    return undefined;
  }

  if (
    ts.isTypeLiteralNode(unwrappedTargetTypeNode) || ts.isMappedTypeNode(unwrappedTargetTypeNode)
  ) {
    return classifyUnsoundCompositePayloadGenericAliasRelation(
      context,
      sourceType,
      targetType,
      unwrappedTargetTypeNode,
      sourceExpression,
      effectiveSourceTypeNode,
      visitedPairs,
    );
  }

  if (!isRelationReferenceTypeNode(unwrappedTargetTypeNode)) {
    return undefined;
  }

  const targetArrayElementTypeNode = getArrayLikeRelationElementTypeNode(
    context,
    unwrappedTargetTypeNode,
  );
  if (targetArrayElementTypeNode) {
    const sourceArrayElementTypeNode = getArrayLikeRelationElementTypeNode(
      context,
      effectiveSourceTypeNode,
    );
    const sourceArrayElementType = sourceArrayElementTypeNode
      ? context.checker.getTypeFromTypeNode(sourceArrayElementTypeNode)
      : getArrayLikeElementType(context, sourceType);
    const targetArrayElementType = getArrayLikeElementType(context, targetType) ??
      context.checker.getTypeFromTypeNode(targetArrayElementTypeNode);
    if (sourceArrayElementType && targetArrayElementType) {
      return classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourceArrayElementType,
        targetArrayElementType,
        targetArrayElementTypeNode,
        sourceExpression,
        sourceArrayElementTypeNode,
        visitedPairs,
      );
    }
  }

  const propertyMismatch = classifyUnsoundCompositePayloadGenericAliasRelation(
    context,
    sourceType,
    targetType,
    unwrappedTargetTypeNode,
    sourceExpression,
    effectiveSourceTypeNode,
    visitedPairs,
  );
  if (propertyMismatch) {
    return propertyMismatch;
  }

  const nestedTypeArguments = getNestedGenericRelationTypeArguments(
    context,
    sourceType,
    targetType,
  );
  if (nestedTypeArguments.length !== unwrappedTargetTypeNode.typeArguments?.length) {
    return undefined;
  }

  const unwrappedSourceTypeNode = unwrapRelationTypeNode(effectiveSourceTypeNode);
  const sourceTypeArgumentNodes = unwrappedSourceTypeNode &&
      isRelationReferenceTypeNode(unwrappedSourceTypeNode)
    ? getRelationReferenceTypeArgumentNodes(unwrappedSourceTypeNode)
    : [];

  for (const [index, typeArgumentNode] of unwrappedTargetTypeNode.typeArguments.entries()) {
    const nestedTypeArgument = nestedTypeArguments[index];
    if (!nestedTypeArgument) {
      continue;
    }

    const nestedMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
      context,
      nestedTypeArgument.sourceType,
      nestedTypeArgument.targetType,
      typeArgumentNode,
      sourceExpression,
      sourceTypeArgumentNodes[index],
      visitedPairs,
    );
    if (nestedMismatch) {
      return nestedMismatch;
    }
  }

  return undefined;
}

function classifyUnsoundRecursiveGenericRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  relationSite?: ts.Node,
  visitedPairs: Set<string> = new Set(),
): RelationMismatch | undefined {
  return analyzeRecursiveGenericRelation(
    context,
    sourceType,
    targetType,
    relationSite,
    visitedPairs,
  ).mismatch;
}

function classifySynthesizedTypeNodeGenericAliasRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  const targetTypeNode = getSynthesizedRelationTypeNode(context, targetType);
  if (!targetTypeNode) {
    return undefined;
  }

  return classifyUnsoundTypeNodeGenericAliasRelation(
    context,
    sourceType,
    targetType,
    targetTypeNode,
    undefined,
    getSynthesizedRelationTypeNode(context, sourceType),
  );
}

function classifyUnsoundIntersectionCallablePropertyRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);
  if (
    (normalizedSourceType.flags & ts.TypeFlags.Intersection) === 0 &&
    (normalizedTargetType.flags & ts.TypeFlags.Intersection) === 0
  ) {
    return undefined;
  }

  const sourceProperties = context.checker.getPropertiesOfType(normalizedSourceType);
  const sourcePropertiesByName = new Map(
    sourceProperties.map((property) => [property.name, property]),
  );

  for (const targetProperty of context.checker.getPropertiesOfType(normalizedTargetType)) {
    const sourceProperty = sourcePropertiesByName.get(targetProperty.name);
    if (!sourceProperty) {
      continue;
    }

    const sourceInfo = getPropertyVarianceInfo(context, normalizedSourceType, targetProperty.name);
    const targetInfo = getPropertyVarianceInfo(context, normalizedTargetType, targetProperty.name);
    if (!sourceInfo?.readType || !targetInfo?.readType) {
      continue;
    }

    if (
      context.checker.getSignaturesOfType(sourceInfo.readType, ts.SignatureKind.Call).length ===
        0 &&
      context.checker.getSignaturesOfType(sourceInfo.readType, ts.SignatureKind.Construct)
          .length === 0 &&
      context.checker.getSignaturesOfType(targetInfo.readType, ts.SignatureKind.Call).length ===
        0 &&
      context.checker.getSignaturesOfType(targetInfo.readType, ts.SignatureKind.Construct)
          .length === 0
    ) {
      continue;
    }

    const callableMismatch = classifyUnsoundCallableSignatureRelation(
      context,
      sourceInfo.readType,
      targetInfo.readType,
    );
    if (callableMismatch) {
      return callableMismatch;
    }
  }

  return undefined;
}

function classifyUnsoundMutableMapOrSetRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  if (
    hasTypeReferenceName(context, sourceType, 'Map') &&
    hasTypeReferenceName(context, targetType, 'Map')
  ) {
    const [sourceKeyType, sourceValueType] = getReferenceTypeArguments(context, sourceType);
    const [targetKeyType, targetValueType] = getReferenceTypeArguments(context, targetType);
    if (!sourceKeyType || !sourceValueType || !targetKeyType || !targetValueType) {
      return undefined;
    }

    const keyMismatch = classifyWritablePayloadRelation(
      context,
      sourceKeyType,
      targetKeyType,
    );
    if (keyMismatch) {
      return keyMismatch;
    }

    const valueMismatch = classifyWritablePayloadRelation(
      context,
      sourceValueType,
      targetValueType,
    );
    if (valueMismatch) {
      return valueMismatch;
    }

    if (
      !context.checker.isTypeAssignableTo(targetKeyType, sourceKeyType) ||
      !context.checker.isTypeAssignableTo(targetValueType, sourceValueType)
    ) {
      return {
        kind: 'mutableMapVariance',
        message: 'Mutable Map values are invariant in soundscript.',
        notes: [
          `'${context.checker.typeToString(sourceType)}' cannot be widened to '${
            context.checker.typeToString(targetType)
          }' because writes through the target map could use incompatible keys or values.`,
          'Mutable edge: `set(...)` on the widened map could introduce keys or values the source map would reject.',
        ],
        hint:
          'Make the map surface ReadonlyMap, copy into a fresh Map before widening, or keep the exact key and value types.',
      };
    }
  }

  if (
    hasTypeReferenceName(context, sourceType, 'Set') &&
    hasTypeReferenceName(context, targetType, 'Set')
  ) {
    const [sourceValueType] = getReferenceTypeArguments(context, sourceType);
    const [targetValueType] = getReferenceTypeArguments(context, targetType);
    if (!sourceValueType || !targetValueType) {
      return undefined;
    }

    const valueMismatch = classifyWritablePayloadRelation(
      context,
      sourceValueType,
      targetValueType,
    );
    if (valueMismatch) {
      return valueMismatch;
    }

    if (!context.checker.isTypeAssignableTo(targetValueType, sourceValueType)) {
      return {
        kind: 'mutableSetVariance',
        message: 'Mutable Set values are invariant in soundscript.',
        notes: [
          `'${context.checker.typeToString(sourceType)}' cannot be widened to '${
            context.checker.typeToString(targetType)
          }' because writes through the target set could add incompatible values.`,
          'Mutable edge: `add(...)` on the widened set could introduce values the source set would reject.',
        ],
        hint:
          'Make the set surface ReadonlySet, copy into a fresh Set before widening, or keep the exact element type.',
      };
    }
  }

  return undefined;
}

function classifyUnsoundMutableContainerPayloadRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);

  return classifyUnsoundMutableTupleRelation(
    context,
    normalizedSourceType,
    normalizedTargetType,
  ) ??
    classifyUnsoundMutableArrayRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    ) ??
    classifyUnsoundMutableMapOrSetRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    ) ??
    classifyUnsoundGenericClassInstanceRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    );
}

function getPropertySurface(
  context: AnalysisContext,
  ownerType: ts.Type,
  property: ts.Symbol,
): PropertySurface | undefined {
  const declarations = getPropertySurfaceDeclarations(context, ownerType, property);
  const methodOnly = declarations.length > 0 &&
    declarations.every((declaration) =>
      ts.isMethodDeclaration(declaration) ||
      ts.isMethodSignature(declaration)
    );
  const ownerDeclarations = ownerType.getSymbol()?.getDeclarations() ?? [];
  const ownerLocation = ownerType.getSymbol()?.valueDeclaration ?? ownerDeclarations[0];
  const location = property.valueDeclaration ?? declarations[0] ?? ownerLocation;
  if (!location) {
    return undefined;
  }

  const isMappedProperty = isMappedPropertySymbol(property);
  let readonly = isReadonlyPropertySymbol(property) ||
    isReadonlyConstituentProperty(context, ownerType, property.getName()) ||
    methodOnly;
  for (const declaration of declarations) {
    if (
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration) ||
      ts.isParameter(declaration)
    ) {
      // Mapped-property declarations point at the source declaration, so their
      // modifiers can lie about whether the mapped surface is still readonly.
      readonly = readonly || (!isMappedProperty && hasReadonlyModifier(declaration));
    }
  }

  return {
    declarations,
    location,
    methodOnly,
    property,
    readonly,
  };
}

function getPropertySurfaceDeclarations(
  context: AnalysisContext,
  ownerType: ts.Type,
  property: ts.Symbol,
): readonly ts.Declaration[] {
  const directDeclarations = property.getDeclarations() ?? [];
  if (directDeclarations.length > 0) {
    return directDeclarations;
  }

  const normalizedOwnerType = getSafeNonNullableRelationType(context, ownerType);
  if (
    (normalizedOwnerType.flags & ts.TypeFlags.Union) === 0 &&
    (normalizedOwnerType.flags & ts.TypeFlags.Intersection) === 0
  ) {
    return directDeclarations;
  }

  const declarations: ts.Declaration[] = [];
  for (const constituentType of (normalizedOwnerType as ts.UnionOrIntersectionType).types) {
    const constituentProperty = context.checker.getPropertyOfType(
      constituentType,
      property.getName(),
    );
    if (!constituentProperty) {
      continue;
    }

    declarations.push(...(constituentProperty.getDeclarations() ?? []));
  }

  return declarations;
}

function isReadonlyConstituentProperty(
  context: AnalysisContext,
  ownerType: ts.Type,
  propertyName: string,
): boolean {
  const normalizedOwnerType = getSafeNonNullableRelationType(context, ownerType);
  if (
    (normalizedOwnerType.flags & ts.TypeFlags.Union) === 0 &&
    (normalizedOwnerType.flags & ts.TypeFlags.Intersection) === 0
  ) {
    return false;
  }

  return (normalizedOwnerType as ts.UnionOrIntersectionType).types.some((constituentType) => {
    const constituentProperty = context.checker.getPropertyOfType(constituentType, propertyName);
    return constituentProperty ? isReadonlyPropertySymbol(constituentProperty) : false;
  });
}

function getPropertyVarianceInfo(
  context: AnalysisContext,
  ownerType: ts.Type,
  propertyName: string,
): PropertyVarianceInfo | undefined {
  const property = context.checker.getPropertyOfType(ownerType, propertyName);
  const surface = property ? getPropertySurface(context, ownerType, property) : undefined;
  if (!property || !surface) {
    return undefined;
  }

  const readType = context.checker.getTypeOfSymbolAtLocation(property, surface.location);
  let setterBacked = false;
  let writeType: ts.Type | undefined;
  let writeTypeNode: ts.TypeNode | undefined;
  const readonly = surface.readonly || surface.methodOnly;

  for (const declaration of surface.declarations) {
    if (ts.isSetAccessorDeclaration(declaration)) {
      setterBacked = true;
      const parameter = declaration.parameters[0];
      if (parameter) {
        writeType = context.checker.getTypeAtLocation(parameter);
        writeTypeNode = parameter.type;
      }
      continue;
    }
  }

  if (writeType === undefined && !readonly) {
    writeType = readType;
    for (const declaration of surface.declarations) {
      if (
        ts.isPropertyDeclaration(declaration) ||
        ts.isPropertySignature(declaration) ||
        ts.isParameter(declaration)
      ) {
        writeTypeNode = declaration.type ?? writeTypeNode;
      }
    }
  }

  return {
    readType,
    setterBacked,
    writeType,
    writeTypeNode,
  };
}

function createWritablePropertyVarianceMismatch(
  context: AnalysisContext,
  propertyName: string,
  targetWriteType: ts.Type,
  sourceAcceptedType: ts.Type,
): RelationMismatch {
  return {
    kind: 'writablePropertyVariance',
    message: `Writable property '${propertyName}' is invariant in soundscript.`,
    notes: [
      `The target can write '${
        context.checker.typeToString(targetWriteType)
      }' to '${propertyName}', but the source only accepts '${
        context.checker.typeToString(sourceAcceptedType)
      }'.`,
      `Mutable edge: writes through '${propertyName}' on the widened target would become unsound.`,
    ],
    hint:
      `Make '${propertyName}' readonly, copy into a fresh object before widening, or keep '${propertyName}' at the exact accepted type.`,
  };
}

function classifyUnsoundWritablePropertyWriteRelation(
  context: AnalysisContext,
  propertyName: string,
  sourceAcceptedType: ts.Type | undefined,
  sourceAcceptedTypeNode: ts.TypeNode | undefined,
  targetWriteType: ts.Type,
  targetWriteTypeNode: ts.TypeNode | undefined,
  fallbackAcceptedType: ts.Type,
  setterBacked: boolean,
  relationSite: ts.Node | undefined,
  visitedPairs: Set<string>,
): RelationMismatch | undefined {
  const effectiveSourceAcceptedType = sourceAcceptedType ?? fallbackAcceptedType;
  if (!sourceAcceptedType) {
    return createWritablePropertyVarianceMismatch(
      context,
      propertyName,
      targetWriteType,
      effectiveSourceAcceptedType,
    );
  }

  if (!setterBacked) {
    if (!context.checker.isTypeAssignableTo(targetWriteType, sourceAcceptedType)) {
      return createWritablePropertyVarianceMismatch(
        context,
        propertyName,
        targetWriteType,
        effectiveSourceAcceptedType,
      );
    }

    return undefined;
  }

  const typeNodeAliasMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
    context,
    sourceAcceptedType,
    targetWriteType,
    targetWriteTypeNode,
    undefined,
    sourceAcceptedTypeNode,
  );
  if (typeNodeAliasMismatch) {
    return typeNodeAliasMismatch;
  }

  const mismatch = classifyUnsoundMutableContainerPayloadRelation(
    context,
    targetWriteType,
    sourceAcceptedType,
  ) ??
    classifyUnsoundRecursiveGenericRelation(
      context,
      targetWriteType,
      sourceAcceptedType,
      relationSite,
      visitedPairs,
    );
  if (mismatch) {
    return mismatch;
  }

  if (!context.checker.isTypeAssignableTo(targetWriteType, sourceAcceptedType)) {
    return createWritablePropertyVarianceMismatch(
      context,
      propertyName,
      targetWriteType,
      effectiveSourceAcceptedType,
    );
  }

  return undefined;
}

function getCompositeRelationConstituents(type: ts.Type): readonly ts.Type[] {
  const normalizedType = type;
  if ((normalizedType.flags & ts.TypeFlags.Union) !== 0) {
    return (normalizedType as ts.UnionType).types;
  }

  if ((normalizedType.flags & ts.TypeFlags.Intersection) !== 0) {
    return (normalizedType as ts.IntersectionType).types;
  }

  return [normalizedType];
}

function collectCompositePropertyNames(context: AnalysisContext, type: ts.Type): readonly string[] {
  const names = new Set<string>();
  for (
    const constituentType of getCompositeRelationConstituents(
      getSafeNonNullableRelationType(context, type),
    )
  ) {
    for (const property of context.checker.getPropertiesOfType(constituentType)) {
      names.add(property.name);
    }
  }

  return [...names];
}

function isCallableSurfaceType(context: AnalysisContext, type: ts.Type): boolean {
  return context.checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;
}

function classifyUnsoundMethodSurfaceRelation(
  context: AnalysisContext,
  sourceOwnerType: ts.Type,
  targetOwnerType: ts.Type,
  sourceSurface: PropertySurface,
  targetSurface: PropertySurface,
  visitedPairs: Set<string>,
): RelationMismatch | undefined {
  if (!sourceSurface.methodOnly || !targetSurface.methodOnly) {
    return undefined;
  }

  if (
    sourceSurface.declarations.every((declaration) =>
      declaration.getSourceFile().isDeclarationFile
    ) ||
    targetSurface.declarations.every((declaration) => declaration.getSourceFile().isDeclarationFile)
  ) {
    return undefined;
  }

  const sourceType = context.checker.getTypeOfSymbolAtLocation(
    sourceSurface.property,
    sourceSurface.location,
  );
  const targetType = context.checker.getTypeOfSymbolAtLocation(
    targetSurface.property,
    targetSurface.location,
  );

  for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct] as const) {
    const sourceSignatures = context.checker.getSignaturesOfType(sourceType, kind);
    const targetSignatures = context.checker.getSignaturesOfType(targetType, kind);
    if (sourceSignatures.length === 0 || targetSignatures.length === 0) {
      continue;
    }

    for (const targetSignature of targetSignatures) {
      let foundSafeSource = false;
      for (const sourceSignature of sourceSignatures) {
        if (
          !classifyUnsoundSignatureRelation(
            context,
            sourceOwnerType,
            targetOwnerType,
            sourceSignature,
            targetSignature,
            undefined,
            visitedPairs,
          )
        ) {
          foundSafeSource = true;
          break;
        }
      }

      if (!foundSafeSource) {
        return createCallableParameterVarianceMismatch(context, sourceType, targetType);
      }
    }
  }

  return undefined;
}

function classifyUnsoundCompositeCallablePropertyRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  relationSite: ts.Node | undefined,
  visitedPairs: Set<string>,
): RelationMismatch | undefined {
  const sourceConstituents = getCompositeRelationConstituents(
    getSafeNonNullableRelationType(context, sourceType),
  );
  const targetConstituents = getCompositeRelationConstituents(
    getSafeNonNullableRelationType(context, targetType),
  );
  if (sourceConstituents.length === 1 && targetConstituents.length === 1) {
    return undefined;
  }

  const sourcePropertyNames = collectCompositePropertyNames(context, sourceType);
  if (sourcePropertyNames.length === 0) {
    return undefined;
  }

  for (const sourceConstituent of sourceConstituents) {
    for (const propertyName of sourcePropertyNames) {
      const sourceProperty = context.checker.getPropertyOfType(sourceConstituent, propertyName);
      if (!sourceProperty) {
        continue;
      }

      const sourceSurface = getPropertySurface(context, sourceConstituent, sourceProperty);
      const sourceInfo = getPropertyVarianceInfo(context, sourceConstituent, propertyName);
      if (!sourceSurface || !sourceInfo?.readType) {
        continue;
      }

      if (
        sourceSurface.declarations.length > 0 &&
        sourceSurface.declarations.every((declaration) =>
          declaration.getSourceFile().isDeclarationFile
        )
      ) {
        continue;
      }

      if (!sourceSurface.methodOnly && !isCallableSurfaceType(context, sourceInfo.readType)) {
        continue;
      }

      let foundSafeTarget = false;
      let firstMismatch: RelationMismatch | undefined;
      for (const targetConstituent of targetConstituents) {
        const targetProperty = context.checker.getPropertyOfType(targetConstituent, propertyName);
        if (!targetProperty) {
          continue;
        }

        const targetSurface = getPropertySurface(context, targetConstituent, targetProperty);
        const targetInfo = getPropertyVarianceInfo(context, targetConstituent, propertyName);
        if (!targetSurface || !targetInfo?.readType) {
          continue;
        }

        if (
          targetSurface.declarations.length > 0 &&
          targetSurface.declarations.every((declaration) =>
            declaration.getSourceFile().isDeclarationFile
          )
        ) {
          continue;
        }

        if (!targetSurface.methodOnly && !isCallableSurfaceType(context, targetInfo.readType)) {
          continue;
        }

        const mismatch = sourceSurface.methodOnly && targetSurface.methodOnly
          ? classifyUnsoundMethodSurfaceRelation(
            context,
            sourceConstituent,
            targetConstituent,
            sourceSurface,
            targetSurface,
            visitedPairs,
          )
          : classifyUnsoundCallableSignatureRelation(
            context,
            sourceInfo.readType,
            targetInfo.readType,
            relationSite,
            visitedPairs,
          );

        if (!mismatch) {
          if (
            !sourceSurface.readonly &&
            !targetSurface.readonly &&
            targetInfo.writeType !== undefined
          ) {
            const writeMismatch = classifyUnsoundWritablePropertyWriteRelation(
              context,
              propertyName,
              sourceInfo.writeType,
              sourceInfo.writeTypeNode,
              targetInfo.writeType,
              targetInfo.writeTypeNode,
              sourceInfo.readType,
              sourceInfo.setterBacked || targetInfo.setterBacked,
              relationSite,
              visitedPairs,
            );
            if (writeMismatch) {
              firstMismatch ??= writeMismatch;
            } else {
              foundSafeTarget = true;
              break;
            }
          } else {
            foundSafeTarget = true;
            break;
          }
        }

        firstMismatch ??= mismatch;
      }

      if (!foundSafeTarget) {
        return firstMismatch ??
          createCallableParameterVarianceMismatch(context, sourceType, targetType);
      }
    }
  }

  return undefined;
}

function isInspectableObjectType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Object) !== 0;
}

function hasFunctionLikeTypeName(symbol: ts.Symbol | undefined): boolean {
  const name = symbol?.getName();
  return name === 'Function' || name === 'CallableFunction' || name === 'NewableFunction';
}

function relationTypeHasFunctionObjectBrand(
  context: AnalysisContext,
  type: ts.Type,
  visited: Set<ts.Type> = new Set(),
): boolean {
  if (visited.has(type)) {
    return false;
  }
  visited.add(type);

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((member) =>
      relationTypeHasFunctionObjectBrand(context, member, visited)
    );
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((member) =>
      relationTypeHasFunctionObjectBrand(context, member, visited)
    );
  }

  const normalized = context.checker.getBaseTypeOfLiteralType(type);
  if (
    hasFunctionLikeTypeName(normalized.aliasSymbol) ||
    hasFunctionLikeTypeName(normalized.getSymbol())
  ) {
    return true;
  }

  const symbol = normalized.getSymbol();
  if (!symbol || (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) === 0) {
    return false;
  }

  const baseTypes = context.checker.getBaseTypes?.(normalized as ts.InterfaceType) ?? [];
  return baseTypes.some((baseType) =>
    relationTypeHasFunctionObjectBrand(context, baseType, visited)
  );
}

function relationTypeHasFunctionLikeBrand(
  context: AnalysisContext,
  type: ts.Type,
  visited: Set<ts.Type> = new Set(),
): boolean {
  if (visited.has(type)) {
    return false;
  }
  visited.add(type);

  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    return true;
  }

  return relationTypeHasFunctionObjectBrand(context, type, visited);
}

function isCallableMutationAssignmentTarget(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  const unwrappedExpression = unwrapRelationExpression(expression);
  if (
    !ts.isPropertyAccessExpression(unwrappedExpression) &&
    !ts.isElementAccessExpression(unwrappedExpression)
  ) {
    return false;
  }

  return relationTypeHasFunctionLikeBrand(
    context,
    context.checker.getTypeAtLocation(unwrappedExpression.expression),
  );
}

function isPlainObjectType(context: AnalysisContext, type: ts.Type): boolean {
  return context.checker.typeToString(type) === 'object';
}

function typeHasBareObjectBrand(
  context: AnalysisContext,
  type: ts.Type,
): boolean {
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((member) => typeHasBareObjectBrand(context, member));
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((member) =>
      typeHasBareObjectBrand(context, member)
    );
  }

  return type.aliasSymbol?.getName() === 'BareObject' ||
    type.getSymbol()?.getName() === 'BareObject';
}

function isBareObjectType(context: AnalysisContext, type: ts.Type): boolean {
  return typeHasBareObjectBrand(context, type);
}

function isExtendsNullClassDeclaration(
  context: AnalysisContext,
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  visitedSymbols: Set<number>,
): boolean {
  const extendsClause = declaration.heritageClauses?.find((clause) =>
    clause.token === ts.SyntaxKind.ExtendsKeyword
  );
  const heritageType = extendsClause?.types[0];
  if (!heritageType) {
    return false;
  }

  if (
    context.checker.typeToString(context.checker.getTypeAtLocation(heritageType.expression)) ===
      'null'
  ) {
    return true;
  }

  const baseType = context.checker.getTypeAtLocation(heritageType.expression);
  return isNullPrototypeClassType(context, baseType, visitedSymbols);
}

function isNullPrototypeClassType(
  context: AnalysisContext,
  type: ts.Type,
  visitedSymbols: Set<number> = new Set(),
): boolean {
  const symbol = type.getSymbol();
  if (!symbol) {
    return false;
  }

  const symbolId = context.getSymbolId(symbol);
  if (visitedSymbols.has(symbolId)) {
    return false;
  }
  visitedSymbols.add(symbolId);

  return (symbol.getDeclarations() ?? []).some((declaration) =>
    (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) &&
    isExtendsNullClassDeclaration(context, declaration, visitedSymbols)
  );
}

function isNullPrototypeValue(
  context: AnalysisContext,
  type: ts.Type,
): boolean {
  return isBareObjectType(context, type) ||
    isNullPrototypeClassType(context, type);
}

const NULL_PROTOTYPE_RECOVERY_SPEC = {
  getDirectFamily(
    context: AnalysisContext,
    expression: ts.Expression,
  ): 'nullPrototype' | undefined {
    return isNullPrototypeValue(context, context.checker.getTypeAtLocation(expression))
      ? 'nullPrototype'
      : undefined;
  },
  isSupportedFamily(
    family: ExportedNonOrdinaryFamily,
  ): family is 'nullPrototype' {
    return family === 'nullPrototype';
  },
} as const;

function ensureNullPrototypeExportSummaries(context: AnalysisContext): void {
  if (populatedNullPrototypeExportSummaries.has(context)) {
    return;
  }

  const exportedSymbolsBySourceFile = collectExportedSymbolsBySourceFile(context);
  populateDirectExportValueSummaries(
    context,
    exportedSymbolsBySourceFile,
    NULL_PROTOTYPE_RECOVERY_SPEC,
  );
  populateFunctionLikeNonOrdinarySummaries(
    context,
    exportedSymbolsBySourceFile,
    NULL_PROTOTYPE_RECOVERY_SPEC,
  );
  populatedNullPrototypeExportSummaries.add(context);
}

function typeHasModeledBuiltinExoticObjectBrand(
  context: AnalysisContext,
  type: ts.Type,
  visited: Set<ts.Type> = new Set(),
): boolean {
  if (visited.has(type)) {
    return false;
  }
  visited.add(type);

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((member) =>
      typeHasModeledBuiltinExoticObjectBrand(context, member, visited)
    );
  }

  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.some((member) =>
      typeHasModeledBuiltinExoticObjectBrand(context, member, visited)
    );
  }

  const normalized = context.checker.getBaseTypeOfLiteralType(type);
  const symbolName = normalized.aliasSymbol?.getName() ?? normalized.getSymbol()?.getName();
  if (symbolName && MODELED_EXOTIC_OBJECT_TYPE_NAMES.has(symbolName)) {
    return true;
  }

  const symbol = normalized.getSymbol();
  if (!symbol || (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) === 0) {
    return false;
  }

  const baseTypes = context.checker.getBaseTypes?.(normalized as ts.InterfaceType) ?? [];
  return baseTypes.some((baseType) =>
    typeHasModeledBuiltinExoticObjectBrand(context, baseType, visited)
  );
}

function getCallExpressionCalleeSymbol(
  context: AnalysisContext,
  node: ts.CallExpression,
): ts.Symbol | undefined {
  if (ts.isIdentifier(node.expression)) {
    return context.checker.getSymbolAtLocation(node.expression);
  }

  if (ts.isPropertyAccessExpression(node.expression)) {
    return context.checker.getSymbolAtLocation(node.expression.name);
  }

  return undefined;
}

function classifyExoticObjectWidening(
  context: AnalysisContext,
  expression: ts.Expression,
  sourceType: ts.Type,
  targetType: ts.Type,
): RelationMismatch | undefined {
  ensureNullPrototypeExportSummaries(context);

  const sourceIsNullPrototype = isNullPrototypeValue(context, sourceType) ||
    getKnownRecoveredNonOrdinaryFamily(context, expression, NULL_PROTOTYPE_RECOVERY_SPEC) ===
      'nullPrototype';
  const sourceIsModeledBuiltinExotic = typeHasModeledBuiltinExoticObjectBrand(
    context,
    sourceType,
  );
  const targetIsPlainObject = isPlainObjectType(context, targetType);
  const targetIsBareObject = isBareObjectType(context, targetType);

  if (
    sourceIsNullPrototype &&
    targetIsPlainObject &&
    !targetIsBareObject
  ) {
    return createNullPrototypeObjectWideningMismatch(context, sourceType, targetType);
  }

  if (sourceIsModeledBuiltinExotic && targetIsPlainObject) {
    return createModeledBuiltinExoticObjectWideningMismatch(context, sourceType, targetType);
  }

  return undefined;
}

function classifyUnsoundWritablePropertyRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  relationSite?: ts.Node,
  visitedPairs: Set<string> = new Set(),
): RelationMismatch | undefined {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);

  if (
    !isInspectableObjectType(normalizedSourceType) ||
    !isInspectableObjectType(normalizedTargetType) ||
    isArrayType(context, normalizedSourceType) ||
    isArrayType(context, normalizedTargetType)
  ) {
    return undefined;
  }

  const pairKey = getRelationTypePairKey(
    context,
    'property',
    normalizedSourceType,
    normalizedTargetType,
  );
  if (visitedPairs.has(pairKey)) {
    return undefined;
  }
  visitedPairs.add(pairKey);

  for (const targetProperty of context.checker.getPropertiesOfType(normalizedTargetType)) {
    const targetSurface = getPropertySurface(context, normalizedTargetType, targetProperty);
    const sourceProperty = context.checker.getPropertyOfType(
      normalizedSourceType,
      targetProperty.name,
    );
    const sourceSurface = sourceProperty
      ? getPropertySurface(context, normalizedSourceType, sourceProperty)
      : undefined;
    const targetInfo = getPropertyVarianceInfo(
      context,
      normalizedTargetType,
      targetProperty.name,
    );
    const sourceInfo = getPropertyVarianceInfo(
      context,
      normalizedSourceType,
      targetProperty.name,
    );
    if (!sourceInfo?.readType) {
      continue;
    }

    if (!targetInfo?.readType) {
      continue;
    }

    const methodMismatch = sourceSurface && targetSurface
      ? classifyUnsoundMethodSurfaceRelation(
        context,
        normalizedSourceType,
        normalizedTargetType,
        sourceSurface,
        targetSurface,
        visitedPairs,
      )
      : undefined;
    if (methodMismatch) {
      return methodMismatch;
    }

    const callableMismatch = classifyUnsoundCallableSignatureRelation(
      context,
      sourceInfo.readType,
      targetInfo.readType,
      relationSite,
    );
    if (callableMismatch) {
      return callableMismatch;
    }

    if (!context.checker.isTypeAssignableTo(sourceInfo.readType, targetInfo.readType)) {
      continue;
    }

    if (!targetInfo.writeType) {
      const payloadMismatch = classifyUnsoundMutableContainerPayloadRelation(
        context,
        sourceInfo.readType,
        targetInfo.readType,
      ) ?? classifyUnsoundRecursiveGenericRelation(
        context,
        sourceInfo.readType,
        targetInfo.readType,
        relationSite,
        visitedPairs,
      );
      if (payloadMismatch) {
        return payloadMismatch;
      }
      const nestedMismatch = classifyUnsoundWritablePropertyRelation(
        context,
        sourceInfo.readType,
        targetInfo.readType,
        relationSite,
        visitedPairs,
      );
      if (nestedMismatch) {
        return nestedMismatch;
      }
      continue;
    }

    const writeMismatch = classifyUnsoundWritablePropertyWriteRelation(
      context,
      targetProperty.name,
      sourceInfo.writeType,
      sourceInfo.writeTypeNode,
      targetInfo.writeType,
      targetInfo.writeTypeNode,
      sourceInfo.readType,
      sourceInfo.setterBacked || targetInfo.setterBacked,
      relationSite,
      visitedPairs,
    );
    if (writeMismatch) {
      return writeMismatch;
    }
  }

  return undefined;
}

function classifyUnsoundRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  relationSite?: ts.Node,
  visitedPairs: Set<string> = new Set(),
): RelationMismatch | undefined {
  const normalizedSourceType = getSafeNonNullableRelationType(context, sourceType);
  const normalizedTargetType = getSafeNonNullableRelationType(context, targetType);
  const pairKey = getRelationTypePairKey(
    context,
    'relation',
    normalizedSourceType,
    normalizedTargetType,
  );
  const normalizedSourceTypeId = (normalizedSourceType as ts.Type & { id?: number }).id;
  const normalizedTargetTypeId = (normalizedTargetType as ts.Type & { id?: number }).id;
  if (
    normalizedSourceType === normalizedTargetType ||
    (
      typeof normalizedSourceTypeId === 'number' &&
      normalizedSourceTypeId === normalizedTargetTypeId
    )
  ) {
    return undefined;
  }
  if (visitedPairs.has(pairKey)) {
    return undefined;
  }
  visitedPairs.add(pairKey);

  const sourceHasCallableSignatures =
    context.checker.getSignaturesOfType(normalizedSourceType, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(normalizedSourceType, ts.SignatureKind.Construct).length >
      0;
  const targetHasCallableSignatures =
    context.checker.getSignaturesOfType(normalizedTargetType, ts.SignatureKind.Call).length > 0 ||
    context.checker.getSignaturesOfType(normalizedTargetType, ts.SignatureKind.Construct).length >
      0;

  if (!sourceHasCallableSignatures && !targetHasCallableSignatures) {
    const mutableTupleMismatch = classifyUnsoundMutableTupleRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    );
    if (mutableTupleMismatch) {
      return mutableTupleMismatch;
    }
    if (
      isTupleType(context, normalizedSourceType) &&
      isTupleType(context, normalizedTargetType) &&
      !isReadonlyTupleType(context, normalizedSourceType) &&
      !isReadonlyTupleType(context, normalizedTargetType)
    ) {
      return undefined;
    }

    const mutableArrayMismatch = classifyUnsoundMutableArrayRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    );
    if (mutableArrayMismatch) {
      return mutableArrayMismatch;
    }
    if (
      isArrayType(context, normalizedSourceType) &&
      isArrayType(context, normalizedTargetType) &&
      !isReadonlyArrayLikeType(context, normalizedSourceType) &&
      !isReadonlyArrayLikeType(context, normalizedTargetType)
    ) {
      return undefined;
    }

    const nominalNewtypeMismatch = classifyUnsoundNominalNewtypeRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
      relationSite,
    );
    if (nominalNewtypeMismatch) {
      return nominalNewtypeMismatch;
    }

    const synthesizedTypeNodeAliasMismatch = classifySynthesizedTypeNodeGenericAliasRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    );
    if (synthesizedTypeNodeAliasMismatch) {
      return synthesizedTypeNodeAliasMismatch;
    }

    const recursiveGenericResult = analyzeRecursiveGenericRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
      undefined,
      visitedPairs,
    );
    if (recursiveGenericResult.handled) {
      return recursiveGenericResult.mismatch;
    }

    const nominalClassMismatch = classifyUnsoundNominalClassRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    );
    if (nominalClassMismatch) {
      return nominalClassMismatch;
    }

    return classifyUnsoundCompositeCallablePropertyRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
      undefined,
      visitedPairs,
    ) ??
      classifyUnsoundWritablePropertyRelation(
        context,
        normalizedSourceType,
        normalizedTargetType,
        undefined,
        visitedPairs,
      ) ??
      classifyUnsoundCallableSignatureRelation(
        context,
        normalizedSourceType,
        normalizedTargetType,
        undefined,
        visitedPairs,
      ) ??
      classifyUnsoundWritableIndexSignatureRelation(
        context,
        normalizedSourceType,
        normalizedTargetType,
      ) ??
      classifyUnsoundMutableMapOrSetRelation(
        context,
        normalizedSourceType,
        normalizedTargetType,
      ) ??
      classifyUnsoundGenericClassInstanceRelation(
        context,
        normalizedSourceType,
        normalizedTargetType,
      );
  }

  const callableMismatch = classifyUnsoundCallableSignatureRelation(
    context,
    normalizedSourceType,
    normalizedTargetType,
    undefined,
    visitedPairs,
  );
  if (callableMismatch) {
    return callableMismatch;
  }

  const mutableTupleMismatch = classifyUnsoundMutableTupleRelation(
    context,
    normalizedSourceType,
    normalizedTargetType,
  );
  if (mutableTupleMismatch) {
    return mutableTupleMismatch;
  }
  if (
    isTupleType(context, normalizedSourceType) &&
    isTupleType(context, normalizedTargetType) &&
    !isReadonlyTupleType(context, normalizedSourceType) &&
    !isReadonlyTupleType(context, normalizedTargetType)
  ) {
    return undefined;
  }

  const mutableArrayMismatch = classifyUnsoundMutableArrayRelation(
    context,
    normalizedSourceType,
    normalizedTargetType,
  );
  if (mutableArrayMismatch) {
    return mutableArrayMismatch;
  }
  if (
    isArrayType(context, normalizedSourceType) &&
    isArrayType(context, normalizedTargetType) &&
    !isReadonlyArrayLikeType(context, normalizedSourceType) &&
    !isReadonlyArrayLikeType(context, normalizedTargetType)
  ) {
    return undefined;
  }

  const nominalNewtypeMismatch = classifyUnsoundNominalNewtypeRelation(
    context,
    normalizedSourceType,
    normalizedTargetType,
    relationSite,
  );
  if (nominalNewtypeMismatch) {
    return nominalNewtypeMismatch;
  }

  const synthesizedTypeNodeAliasMismatch = classifySynthesizedTypeNodeGenericAliasRelation(
    context,
    normalizedSourceType,
    normalizedTargetType,
  );
  if (synthesizedTypeNodeAliasMismatch) {
    return synthesizedTypeNodeAliasMismatch;
  }

  const recursiveGenericResult = analyzeRecursiveGenericRelation(
    context,
    normalizedSourceType,
    normalizedTargetType,
    undefined,
    visitedPairs,
  );
  if (recursiveGenericResult.handled) {
    return recursiveGenericResult.mismatch;
  }

  const nominalClassMismatch = classifyUnsoundNominalClassRelation(
    context,
    normalizedSourceType,
    normalizedTargetType,
  );
  if (nominalClassMismatch) {
    return nominalClassMismatch;
  }

  return classifyUnsoundCompositeCallablePropertyRelation(
    context,
    normalizedSourceType,
    normalizedTargetType,
    relationSite,
    visitedPairs,
  ) ??
    classifyUnsoundWritablePropertyRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
      relationSite,
      visitedPairs,
    ) ??
    classifyUnsoundWritableIndexSignatureRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    ) ??
    classifyUnsoundMutableMapOrSetRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    ) ??
    classifyUnsoundGenericClassInstanceRelation(
      context,
      normalizedSourceType,
      normalizedTargetType,
    );
}

function toRelationDiagnosticDetails(mismatch: RelationMismatch): RelationDiagnosticDetails {
  switch (mismatch.kind) {
    case 'callableParameterVariance':
    case 'exoticObjectWidening':
      return {
        code: mismatch.kind === 'callableParameterVariance'
          ? SOUND_DIAGNOSTIC_CODES.unsoundRelation
          : SOUND_DIAGNOSTIC_CODES.exoticObjectWidening,
        metadata: mismatch.metadata,
        message: mismatch.message,
        notes: mismatch.notes,
        hint: mismatch.hint,
      };
    case 'mutableArrayVariance':
    case 'genericTypeVariance':
    case 'invalidVarianceAnnotation':
    case 'mutableMapVariance':
    case 'mutableSetVariance':
    case 'mutableTupleVariance':
    case 'nominalClassRelation':
    case 'nominalNewtypeRelation':
    case 'genericClassExactMatchVariance':
    case 'varianceAnnotationMismatch':
    case 'writableIndexSignatureVariance':
    case 'writablePropertyVariance':
      return {
        code: mismatch.kind === 'invalidVarianceAnnotation'
          ? SOUND_DIAGNOSTIC_CODES.invalidVarianceAnnotation
          : mismatch.kind === 'varianceAnnotationMismatch'
          ? SOUND_DIAGNOSTIC_CODES.varianceAnnotationMismatch
          : SOUND_DIAGNOSTIC_CODES.unsoundRelation,
        metadata: mismatch.metadata,
        message: mismatch.message,
        notes: mismatch.notes,
        hint: mismatch.hint,
      };
    default: {
      const exhaustiveCheck: never = mismatch.kind;
      return exhaustiveCheck;
    }
  }
}

function unwrapRelationExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }

    if (ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }

    return current;
  }
}

function isSafeFreshLiteralValue(
  expression: ts.Expression,
): boolean {
  expression = unwrapRelationExpression(expression);

  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword ||
    expression.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return true;
  }

  if (
    ts.isPrefixUnaryExpression(expression) &&
    ts.isNumericLiteral(expression.operand) &&
    (
      expression.operator === ts.SyntaxKind.MinusToken ||
      expression.operator === ts.SyntaxKind.PlusToken
    )
  ) {
    return true;
  }

  if (ts.isArrayLiteralExpression(expression)) {
    if (expression.elements.some(ts.isSpreadElement)) {
      return false;
    }

    return expression.elements.every((element) =>
      ts.isExpression(element) &&
      isSafeFreshLiteralValue(element)
    );
  }

  if (!ts.isObjectLiteralExpression(expression)) {
    return false;
  }

  return expression.properties.every((property) => {
    return ts.isPropertyAssignment(property) &&
      isSafeFreshLiteralValue(property.initializer);
  });
}

function isSafePrimitiveRelationElement(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  const normalized = context.checker.getBaseTypeOfLiteralType(
    context.checker.getTypeAtLocation(expression),
  );
  return (normalized.flags & ts.TypeFlags.StringLike) !== 0 ||
    (normalized.flags & ts.TypeFlags.NumberLike) !== 0 ||
    (normalized.flags & ts.TypeFlags.BigIntLike) !== 0 ||
    (normalized.flags & ts.TypeFlags.BooleanLike) !== 0 ||
    (normalized.flags & ts.TypeFlags.ESSymbolLike) !== 0 ||
    (normalized.flags & ts.TypeFlags.Null) !== 0 ||
    (normalized.flags & ts.TypeFlags.Undefined) !== 0;
}

function isSafeFreshArrayRelationElement(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  expression = unwrapRelationExpression(expression);
  return isSafeFreshLiteralValue(expression) ||
    isSafePrimitiveRelationElement(context, expression) ||
    ts.isNewExpression(expression);
}

function matchesExactTargetRelationBranch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): boolean {
  const targetBranches = (targetType.flags & ts.TypeFlags.Union) !== 0
    ? (targetType as ts.UnionType).types
    : [targetType];
  return targetBranches.some((branch) => areExactRelationBranchTypes(context, sourceType, branch));
}

function canSkipTypeNodeAliasMismatch(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
): boolean {
  const sourceBranches = (sourceType.flags & ts.TypeFlags.Union) !== 0
    ? (sourceType as ts.UnionType).types
    : [sourceType];
  const targetBranches = (targetType.flags & ts.TypeFlags.Union) !== 0
    ? (targetType as ts.UnionType).types
    : [targetType];
  return sourceBranches.every((sourceBranch) =>
    targetBranches.some((targetBranch) =>
      areExactRelationBranchTypes(context, sourceBranch, targetBranch)
    )
  );
}

function getWholeLiteralRelationBranches(
  expression: ts.Expression,
): readonly ts.Expression[] | undefined {
  expression = unwrapRelationExpression(expression);

  if (ts.isConditionalExpression(expression)) {
    return [expression.whenTrue, expression.whenFalse];
  }

  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return [expression.left, expression.right];
  }

  return undefined;
}

function canSkipNullishCoalescingRelation(
  context: AnalysisContext,
  expression: ts.BinaryExpression,
  targetType: ts.Type,
): boolean {
  if (expression.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken) {
    return false;
  }

  const leftType = getSafeNonNullableRelationType(
    context,
    context.checker.getTypeAtLocation(expression.left),
  );
  return (
    matchesExactTargetRelationBranch(context, leftType, targetType) ||
    canSkipWholeLiteralRelationExpression(context, expression.left, targetType)
  ) &&
    canSkipWholeLiteralRelationExpression(context, expression.right, targetType);
}

function canSkipWholeLiteralRelationExpression(
  context: AnalysisContext,
  expression: ts.Expression,
  targetType: ts.Type,
): boolean {
  expression = unwrapRelationExpression(expression);

  if (
    ts.isArrayLiteralExpression(expression) &&
    !expression.elements.some((element) =>
      ts.isSpreadElement(element) || ts.isOmittedExpression(element)
    )
  ) {
    return canSkipWholeArrayLiteralRelation(context, expression, targetType);
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return canSkipWholeObjectLiteralRelation(context, expression, targetType);
  }

  if (ts.isBinaryExpression(expression) && canSkipNullishCoalescingRelation(context, expression, targetType)) {
    return true;
  }

  const branches = getWholeLiteralRelationBranches(expression);
  if (branches) {
    return branches.every((branch) =>
      canSkipWholeLiteralRelationExpression(context, branch, targetType)
    );
  }

  return isSafeFreshArrayRelationElement(context, expression) ||
    matchesExactTargetRelationBranch(
      context,
      context.checker.getTypeAtLocation(expression),
      targetType,
    );
}

function canSkipWholeArrayLiteralRelation(
  context: AnalysisContext,
  expression: ts.ArrayLiteralExpression,
  targetType: ts.Type,
): boolean {
  const targetTupleType = isTupleType(context, targetType) ? targetType : undefined;
  const targetElementTypes = targetTupleType ? getTupleElementTypes(context, targetTupleType) : [];
  const fallbackElementType = getArrayElementType(context, targetType) ??
    (hasTypeReferenceName(context, targetType, 'ReadonlyArray')
      ? getReferenceTypeArguments(context, targetType)[0]
      : undefined);

  return expression.elements.every((element, index) => {
    if (!ts.isExpression(element)) {
      return false;
    }

    if (isSafeFreshArrayRelationElement(context, element)) {
      return true;
    }

    const targetElementType = targetElementTypes[index] ?? fallbackElementType;
    if (!targetElementType) {
      return false;
    }

    return canSkipWholeLiteralRelationExpression(context, element, targetElementType);
  });
}

function getObjectLiteralRelationPropertyInfo(
  context: AnalysisContext,
  property: ts.ObjectLiteralElementLike,
): {
  propertyExpression?: ts.Expression;
  propertyName: string;
  propertyTypeSource?: ts.Type;
} | undefined {
  if (ts.isPropertyAssignment(property)) {
    const propertyName = getPropertyNameText(property.name);
    return propertyName
      ? { propertyExpression: property.initializer, propertyName }
      : undefined;
  }

  if (ts.isShorthandPropertyAssignment(property)) {
    return {
      propertyExpression: property.name,
      propertyName: property.name.text,
    };
  }

  if (ts.isMethodDeclaration(property)) {
    const propertyName = getPropertyNameText(property.name);
    return propertyName
      ? {
        propertyName,
        propertyTypeSource: context.checker.getTypeAtLocation(property),
      }
      : undefined;
  }

  return undefined;
}

function getEffectiveObjectLiteralTargetType(
  context: AnalysisContext,
  expression: ts.ObjectLiteralExpression,
  targetType: ts.Type,
): ts.Type {
  if ((targetType.flags & ts.TypeFlags.Union) === 0) {
    return targetType;
  }

  const propertyInfos = expression.properties
    .map((property) => getObjectLiteralRelationPropertyInfo(context, property))
    .filter((property): property is NonNullable<typeof property> => property !== undefined);
  if (propertyInfos.length === 0) {
    return targetType;
  }

  const matchingBranches = (targetType as ts.UnionType).types.filter((branch) =>
    propertyInfos.every(({ propertyName }) =>
      context.checker.getPropertyOfType(branch, propertyName) ||
      getReadableIndexTypeForPropertyName(context, branch, propertyName)
    )
  );

  return matchingBranches.length === 1 ? matchingBranches[0] : targetType;
}

function canSkipWholeObjectLiteralRelation(
  context: AnalysisContext,
  expression: ts.ObjectLiteralExpression,
  targetType: ts.Type,
): boolean {
  const effectiveTargetType = getEffectiveObjectLiteralTargetType(context, expression, targetType);
  if (getTargetClassIdentitySet(context, effectiveTargetType)) {
    return false;
  }

  return expression.properties.every((property) => {
    const propertyInfo = getObjectLiteralRelationPropertyInfo(context, property);
    if (!propertyInfo) {
      return false;
    }

    const { propertyExpression, propertyName, propertyTypeSource } = propertyInfo;

    const targetProperty = context.checker.getPropertyOfType(effectiveTargetType, propertyName);
    const targetPropertyType = targetProperty
      ? context.checker.getTypeOfSymbolAtLocation(targetProperty, propertyExpression ?? property)
      : getReadableIndexTypeForPropertyName(context, effectiveTargetType, propertyName);
    if (!targetPropertyType) {
      return false;
    }

    if (propertyTypeSource) {
      return context.checker.isTypeAssignableTo(propertyTypeSource, targetPropertyType);
    }

    if (!propertyExpression) {
      return false;
    }

    const propertyExpressionType = context.checker.getTypeAtLocation(propertyExpression);
    if (canSkipTypeNodeAliasMismatch(context, propertyExpressionType, targetPropertyType)) {
      return true;
    }

    return canSkipWholeLiteralRelationExpression(context, propertyExpression, targetPropertyType);
  });
}

function getRelationTimingExpressionLabel(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${line + 1}:${character + 1}`;
}

function measureRelationExpressionPhase<T>(
  enabled: boolean,
  phase: string,
  node: ts.Node,
  metadata: Record<string, boolean | number | string | undefined>,
  fn: () => T,
): T {
  if (!enabled) {
    return fn();
  }

  const start = performance.now();
  try {
    return fn();
  } finally {
    logCheckerTiming(
      `project.analyze.sound.rule.relations.${phase}`,
      performance.now() - start,
      {
        file: getRelationTimingExpressionLabel(node),
        ...metadata,
      },
      { thresholdMs: 5 },
    );
  }
}

function checkUnsoundRelationAtExpression(
  context: AnalysisContext,
  diagnostics: SoundDiagnostic[],
  diagnosticNode: ts.Node,
  expression: ts.Expression,
  targetType: ts.Type,
  targetTypeNode?: ts.TypeNode,
): void {
  const timingEnabled = isCheckerTimingEnabled();
  const unwrappedExpression = unwrapRelationExpression(expression);
  const sourceType = context.checker.getTypeAtLocation(expression);
  if (
    relationTypeHasFunctionObjectBrand(context, sourceType) ||
    relationTypeHasFunctionObjectBrand(context, targetType)
  ) {
    return;
  }
  const declaredSourceTypeNode = measureRelationExpressionPhase(
    timingEnabled,
    'declaredSourceTypeNode',
    diagnosticNode,
    {
      expressionKind: ts.SyntaxKind[unwrappedExpression.kind],
    },
    () => getDeclaredTypeNodeFromExpression(context, expression),
  );
  const relationSourceType = declaredSourceTypeNode
    ? context.checker.getTypeFromTypeNode(declaredSourceTypeNode)
    : sourceType;
  const targetIsCallable = context.checker.getSignaturesOfType(
    targetType,
    ts.SignatureKind.Call,
  ).length > 0;
  const skipTypeNodeGenericRelation = !declaredSourceTypeNode &&
    (
      (
        (ts.isCallExpression(unwrappedExpression) || ts.isNewExpression(unwrappedExpression)) &&
        (
          (
            isArrayType(context, relationSourceType) &&
            isArrayType(context, targetType)
          ) ||
          (
            isTupleType(context, relationSourceType) &&
            isTupleType(context, targetType)
          )
        )
      ) ||
      (
        targetIsCallable &&
        (ts.isArrowFunction(unwrappedExpression) || ts.isFunctionExpression(unwrappedExpression))
      )
    );
  const expressionMetadata = {
    expressionKind: ts.SyntaxKind[unwrappedExpression.kind],
    targetKind: ts.TypeFlags[targetType.flags] ?? String(targetType.flags),
  };
  let typeNodeAliasMismatch: RelationMismatch | undefined;
  const isAssignable = measureRelationExpressionPhase(
    timingEnabled,
    'isAssignable',
    diagnosticNode,
    expressionMetadata,
    () => context.checker.isTypeAssignableTo(relationSourceType, targetType),
  );
  const exoticObjectMismatch = measureRelationExpressionPhase(
    timingEnabled,
    'exoticObjectMismatch',
    diagnosticNode,
    expressionMetadata,
    () =>
      classifyExoticObjectWidening(
        context,
        expression,
        relationSourceType,
        targetType,
      ),
  );
  if (exoticObjectMismatch) {
    diagnostics.push(
      createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(exoticObjectMismatch)),
    );
    return;
  }

  if (isAssignable) {
    const preservesExpandedNewtypeCarrierAliasCheck =
      typeNodeContainsExpandedCarrierNewtypeIdentity(context, declaredSourceTypeNode) ||
      typeNodeContainsExpandedCarrierNewtypeIdentity(context, targetTypeNode);
    const typeNodeNewtypeMismatch = classifyCurrentTypeNodeNewtypeRelation(
      context,
      relationSourceType,
      targetType,
      targetTypeNode,
      expression,
      expression,
    );
    if (typeNodeNewtypeMismatch) {
      diagnostics.push(
        createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(typeNodeNewtypeMismatch)),
      );
      return;
    }

    const nominalNewtypeMismatch = classifyUnsoundNominalNewtypeRelation(
      context,
      relationSourceType,
      targetType,
      expression,
      expression,
    );
    if (nominalNewtypeMismatch) {
      diagnostics.push(
        createDiagnostic(expression, toRelationDiagnosticDetails(nominalNewtypeMismatch)),
      );
      return;
    }

    const canSkipWholeArrayLiteral = ts.isArrayLiteralExpression(unwrappedExpression) &&
      !unwrappedExpression.elements.some((element) =>
        ts.isSpreadElement(element) || ts.isOmittedExpression(element)
      ) &&
      measureRelationExpressionPhase(
        timingEnabled,
        'canSkipWholeArrayLiteralRelation',
        diagnosticNode,
        expressionMetadata,
        () => canSkipWholeArrayLiteralRelation(context, unwrappedExpression, targetType),
      ) &&
      (
        isTupleType(context, targetType) ||
        getArrayElementType(context, targetType) !== undefined ||
        (hasTypeReferenceName(context, targetType, 'ReadonlyArray') &&
          getReferenceTypeArguments(context, targetType)[0] !== undefined)
      );
    if (canSkipWholeArrayLiteral) {
      const startCount = diagnostics.length;
      checkNestedLiteralRelationSites(
        context,
        diagnostics,
        expression,
        targetType,
        targetTypeNode,
      );
      if (diagnostics.length > startCount) {
        return;
      }
      return;
    }

    const canSkipWholeObjectLiteral = ts.isObjectLiteralExpression(unwrappedExpression) &&
      measureRelationExpressionPhase(
        timingEnabled,
        'canSkipWholeObjectLiteralRelation',
        diagnosticNode,
        expressionMetadata,
        () => canSkipWholeObjectLiteralRelation(context, unwrappedExpression, targetType),
      );
    if (canSkipWholeObjectLiteral) {
      measureRelationExpressionPhase(
        timingEnabled,
        'checkNestedLiteralRelationSites.objectLiteral',
        diagnosticNode,
        expressionMetadata,
        () =>
          checkNestedLiteralRelationSites(
            context,
            diagnostics,
            expression,
            targetType,
            targetTypeNode,
          ),
      );
      return;
    }

    const preferTypeNodeGenericRelation = measureRelationExpressionPhase(
      timingEnabled,
      'preferTypeNodeGenericRelation',
      diagnosticNode,
      expressionMetadata,
      () =>
        !skipTypeNodeGenericRelation && shouldPreferTypeNodeGenericRelation(
          context,
          relationSourceType,
          targetTypeNode,
          expression,
        ),
    );
    typeNodeAliasMismatch = !skipTypeNodeGenericRelation &&
        (
          preservesExpandedNewtypeCarrierAliasCheck ||
          !canSkipTypeNodeAliasMismatch(context, relationSourceType, targetType)
        )
      ? measureRelationExpressionPhase(
        timingEnabled,
        'typeNodeAliasMismatch',
        diagnosticNode,
        {
          ...expressionMetadata,
          skipped: skipTypeNodeGenericRelation,
        },
        () =>
          classifyUnsoundTypeNodeGenericAliasRelation(
            context,
            relationSourceType,
            targetType,
            targetTypeNode,
            expression,
          ) ?? classifySynthesizedTypeNodeGenericAliasRelation(
            context,
            relationSourceType,
            targetType,
          ),
      )
      : undefined;

    if (preferTypeNodeGenericRelation) {
      if (
        measureRelationExpressionPhase(
          timingEnabled,
          'checkNestedLiteralRelationSites.preferredTypeNode',
          diagnosticNode,
          expressionMetadata,
          () =>
            checkNestedLiteralRelationSites(
              context,
              diagnostics,
              expression,
              targetType,
              targetTypeNode,
            ),
        )
      ) {
        return;
      }

      if (typeNodeAliasMismatch) {
        diagnostics.push(
          createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(typeNodeAliasMismatch)),
        );
        return;
      }
    }

    const nominalClassMismatch = classifyUnsoundNominalClassRelation(
      context,
      relationSourceType,
      targetType,
    );
    if (nominalClassMismatch) {
      diagnostics.push(
        createDiagnostic(expression, toRelationDiagnosticDetails(nominalClassMismatch)),
      );
      return;
    }
  }

  if (
    !isSafeFreshLiteralValue(expression) &&
    isAssignable
  ) {
    const intersectionCallableMismatch = measureRelationExpressionPhase(
      timingEnabled,
      'intersectionCallableMismatch',
      diagnosticNode,
      expressionMetadata,
      () =>
        classifyUnsoundIntersectionCallablePropertyRelation(
          context,
          sourceType,
          targetType,
        ),
    );
    if (intersectionCallableMismatch) {
      diagnostics.push(
        createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(intersectionCallableMismatch)),
      );
      return;
    }

    const relationMismatch = measureRelationExpressionPhase(
      timingEnabled,
      'relationMismatch',
      diagnosticNode,
      expressionMetadata,
      () =>
        classifyUnsoundRelation(
          context,
          relationSourceType,
          targetType,
          expression,
        ),
    );
    if (relationMismatch) {
      diagnostics.push(
        createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(relationMismatch)),
      );
      return;
    }

    if (
      measureRelationExpressionPhase(
        timingEnabled,
        'checkNestedLiteralRelationSites.assignableExpression',
        diagnosticNode,
        expressionMetadata,
        () =>
          checkNestedLiteralRelationSites(
            context,
            diagnostics,
            expression,
            targetType,
            targetTypeNode,
          ),
      )
    ) {
      return;
    }

    if (typeNodeAliasMismatch) {
      diagnostics.push(
        createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(typeNodeAliasMismatch)),
      );
      return;
    }
  }
}

function checkUnsoundRelationAtType(
  context: AnalysisContext,
  diagnostics: SoundDiagnostic[],
  diagnosticNode: ts.Node,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetTypeNode?: ts.TypeNode,
): void {
  const timingEnabled = isCheckerTimingEnabled();
  if (
    relationTypeHasFunctionObjectBrand(context, sourceType) ||
    relationTypeHasFunctionObjectBrand(context, targetType)
  ) {
    return;
  }
  const sourceExpression = ts.isExpression(diagnosticNode) ? diagnosticNode : undefined;
  const declaredSourceTypeNode = getDeclaredTypeNodeFromExpression(context, sourceExpression);
  const relationSourceType = declaredSourceTypeNode
    ? context.checker.getTypeFromTypeNode(declaredSourceTypeNode)
    : sourceType;
  const relationMetadata = {
    sourceKind: ts.SyntaxKind[diagnosticNode.kind],
    targetKind: ts.TypeFlags[targetType.flags] ?? String(targetType.flags),
  };
  if (
    measureRelationExpressionPhase(
      timingEnabled,
      'type.isAssignable',
      diagnosticNode,
      relationMetadata,
      () => context.checker.isTypeAssignableTo(relationSourceType, targetType),
    )
  ) {
    const preservesExpandedNewtypeCarrierAliasCheck =
      typeNodeContainsExpandedCarrierNewtypeIdentity(context, declaredSourceTypeNode) ||
      typeNodeContainsExpandedCarrierNewtypeIdentity(context, targetTypeNode);
    const typeNodeNewtypeMismatch = classifyCurrentTypeNodeNewtypeRelation(
      context,
      relationSourceType,
      targetType,
      targetTypeNode,
      diagnosticNode,
    );
    if (typeNodeNewtypeMismatch) {
      diagnostics.push(
        createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(typeNodeNewtypeMismatch)),
      );
      return;
    }

    const preferTypeNodeGenericRelation = shouldPreferTypeNodeGenericRelation(
      context,
      relationSourceType,
      targetTypeNode,
      sourceExpression,
    );
    const typeNodeAliasMismatch = !preservesExpandedNewtypeCarrierAliasCheck &&
        canSkipTypeNodeAliasMismatch(
          context,
          relationSourceType,
          targetType,
        )
      ? undefined
      : measureRelationExpressionPhase(
        timingEnabled,
        'type.typeNodeAliasMismatch',
        diagnosticNode,
        relationMetadata,
        () =>
          classifyUnsoundTypeNodeGenericAliasRelation(
            context,
            relationSourceType,
            targetType,
            targetTypeNode,
            sourceExpression,
          ) ?? classifySynthesizedTypeNodeGenericAliasRelation(
            context,
            relationSourceType,
            targetType,
          ),
      );
    if (preferTypeNodeGenericRelation) {
      if (typeNodeAliasMismatch) {
        diagnostics.push(
          createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(typeNodeAliasMismatch)),
        );
        return;
      }
    }

    const intersectionCallableMismatch = measureRelationExpressionPhase(
      timingEnabled,
      'type.intersectionCallableMismatch',
      diagnosticNode,
      relationMetadata,
      () =>
        classifyUnsoundIntersectionCallablePropertyRelation(
          context,
          relationSourceType,
          targetType,
        ),
    );
    if (intersectionCallableMismatch) {
      diagnostics.push(
        createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(intersectionCallableMismatch)),
      );
      return;
    }

    const relationMismatch = measureRelationExpressionPhase(
      timingEnabled,
      'type.relationMismatch',
      diagnosticNode,
      relationMetadata,
      () =>
        classifyUnsoundRelation(
          context,
          relationSourceType,
          targetType,
          diagnosticNode,
        ),
    );
    if (relationMismatch) {
      diagnostics.push(
        createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(relationMismatch)),
      );
      return;
    }

    if (typeNodeAliasMismatch) {
      diagnostics.push(
        createDiagnostic(diagnosticNode, toRelationDiagnosticDetails(typeNodeAliasMismatch)),
      );
      return;
    }
  }
}

function unwrapRelationTypeNode(typeNode: ts.TypeNode | undefined): ts.TypeNode | undefined {
  let current = typeNode;
  while (current) {
    if (ts.isParenthesizedTypeNode(current)) {
      current = current.type;
      continue;
    }
    if (ts.isOptionalTypeNode(current)) {
      current = current.type;
      continue;
    }
    if (ts.isNamedTupleMember(current)) {
      current = current.type;
      continue;
    }
    break;
  }
  return current;
}

function typeNodeContainsTypeParameterReference(
  context: AnalysisContext,
  typeNode: ts.TypeNode | undefined,
): boolean {
  let found = false;

  const visit = (node: ts.Node | undefined): void => {
    if (!node || found) {
      return;
    }

    if (isRelationReferenceTypeNode(node)) {
      const symbol = getRelationReferenceTypeNodeSymbol(context, node);
      if (symbol && (symbol.flags & ts.SymbolFlags.TypeParameter) !== 0) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(typeNode);
  return found;
}

function getPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function getLiteralTypePropertyName(node: ts.TypeNode): string | undefined {
  const unwrappedNode = unwrapRelationTypeNode(node);
  if (!unwrappedNode || !ts.isLiteralTypeNode(unwrappedNode)) {
    return undefined;
  }

  const literal = unwrappedNode.literal;
  if (ts.isStringLiteral(literal) || ts.isNumericLiteral(literal)) {
    return literal.text;
  }

  return undefined;
}

function getPropertyNamesFromKeyTypeNode(
  typeNode: ts.TypeNode | undefined,
): readonly string[] | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(typeNode);
  if (!unwrappedTypeNode) {
    return undefined;
  }

  if (ts.isUnionTypeNode(unwrappedTypeNode)) {
    const names: string[] = [];
    for (const member of unwrappedTypeNode.types) {
      const memberName = getLiteralTypePropertyName(member);
      if (memberName === undefined) {
        return undefined;
      }
      names.push(memberName);
    }
    return names;
  }

  const propertyName = getLiteralTypePropertyName(unwrappedTypeNode);
  return propertyName === undefined ? undefined : [propertyName];
}

function doesKeyTypeNodeMatchPropertyName(
  keyTypeNode: ts.TypeNode | undefined,
  propertyName: string,
): boolean {
  const unwrappedKeyTypeNode = unwrapRelationTypeNode(keyTypeNode);
  if (!unwrappedKeyTypeNode) {
    return false;
  }

  if (ts.isUnionTypeNode(unwrappedKeyTypeNode)) {
    return unwrappedKeyTypeNode.types.some((member) =>
      doesKeyTypeNodeMatchPropertyName(member, propertyName)
    );
  }

  if (ts.isLiteralTypeNode(unwrappedKeyTypeNode)) {
    return getLiteralTypePropertyName(unwrappedKeyTypeNode) === propertyName;
  }

  return unwrappedKeyTypeNode.kind === ts.SyntaxKind.StringKeyword ||
    (unwrappedKeyTypeNode.kind === ts.SyntaxKind.NumberKeyword &&
      isNumericPropertyName(propertyName));
}

function isTrustedUtilityAliasSymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) {
    return false;
  }

  const declarations = symbol.getDeclarations() ?? [];
  return declarations.length > 0 &&
    declarations.every((declaration) =>
      ts.isTypeAliasDeclaration(declaration) &&
      isTrustedSoundLibSourceFile(declaration.getSourceFile())
    );
}

function createNormalizedRelationMemberSurface(
  propertyTypeNodes: ReadonlyMap<string, ts.TypeNode>,
  propertyMemberTypeNodes: ReadonlyMap<string, ts.TypeNode | ts.MethodSignature> =
    propertyTypeNodes,
  stringIndexTypeNode?: ts.TypeNode,
  numberIndexTypeNode?: ts.TypeNode,
): NormalizedRelationMemberSurface | undefined {
  if (propertyTypeNodes.size === 0 && !stringIndexTypeNode && !numberIndexTypeNode) {
    return undefined;
  }

  return {
    propertyMemberTypeNodes,
    propertyTypeNodes,
    stringIndexTypeNode,
    numberIndexTypeNode,
  };
}

function mergeNormalizedRelationMemberSurface(
  base: NormalizedRelationMemberSurface | undefined,
  override: NormalizedRelationMemberSurface | undefined,
): NormalizedRelationMemberSurface | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }

  const propertyMemberTypeNodes = new Map(base.propertyMemberTypeNodes);
  for (const [propertyName, propertyMemberTypeNode] of override.propertyMemberTypeNodes) {
    propertyMemberTypeNodes.set(propertyName, propertyMemberTypeNode);
  }
  const propertyTypeNodes = new Map(base.propertyTypeNodes);
  for (const [propertyName, propertyTypeNode] of override.propertyTypeNodes) {
    propertyTypeNodes.set(propertyName, propertyTypeNode);
  }

  return createNormalizedRelationMemberSurface(
    propertyTypeNodes,
    propertyMemberTypeNodes,
    override.stringIndexTypeNode ?? base.stringIndexTypeNode,
    override.numberIndexTypeNode ?? base.numberIndexTypeNode,
  );
}

function getTypeElementMemberSurface(
  members: readonly ts.TypeElement[],
): NormalizedRelationMemberSurface | undefined {
  const propertyMemberTypeNodes = new Map<string, ts.TypeNode | ts.MethodSignature>();
  const propertyTypeNodes = new Map<string, ts.TypeNode>();
  let stringIndexTypeNode: ts.TypeNode | undefined;
  let numberIndexTypeNode: ts.TypeNode | undefined;

  for (const member of members) {
    if (ts.isPropertySignature(member)) {
      const propertyName = member.name ? getPropertyNameText(member.name) : undefined;
      if (!propertyName || !member.type) {
        continue;
      }
      propertyTypeNodes.set(propertyName, member.type);
      propertyMemberTypeNodes.set(propertyName, member.type);
      continue;
    }

    if (ts.isMethodSignature(member)) {
      const propertyName = member.name ? getPropertyNameText(member.name) : undefined;
      if (!propertyName || !member.type) {
        continue;
      }
      propertyTypeNodes.set(propertyName, member.type);
      propertyMemberTypeNodes.set(propertyName, member);
      continue;
    }

    if (!ts.isIndexSignatureDeclaration(member) || !member.type) {
      continue;
    }

    const keyTypeNode = unwrapRelationTypeNode(member.parameters[0]?.type);
    if (!keyTypeNode) {
      continue;
    }

    if (keyTypeNode.kind === ts.SyntaxKind.StringKeyword) {
      stringIndexTypeNode = member.type;
    } else if (keyTypeNode.kind === ts.SyntaxKind.NumberKeyword) {
      numberIndexTypeNode = member.type;
    }
  }

  return createNormalizedRelationMemberSurface(
    propertyTypeNodes,
    propertyMemberTypeNodes,
    stringIndexTypeNode,
    numberIndexTypeNode,
  );
}

function getTypeLiteralMemberSurface(
  typeLiteralNode: ts.TypeLiteralNode,
): NormalizedRelationMemberSurface | undefined {
  return getTypeElementMemberSurface(typeLiteralNode.members);
}

function getMappedTypeMemberSurface(
  mappedTypeNode: ts.MappedTypeNode,
): NormalizedRelationMemberSurface | undefined {
  if (!mappedTypeNode.type || !mappedTypeNode.typeParameter.constraint) {
    return undefined;
  }

  const unwrappedConstraint = unwrapRelationTypeNode(mappedTypeNode.typeParameter.constraint);
  if (!unwrappedConstraint) {
    return undefined;
  }

  const propertyTypeNodes = new Map<string, ts.TypeNode>();
  let stringIndexTypeNode: ts.TypeNode | undefined;
  let numberIndexTypeNode: ts.TypeNode | undefined;

  if (ts.isUnionTypeNode(unwrappedConstraint)) {
    for (const member of unwrappedConstraint.types) {
      const propertyName = getLiteralTypePropertyName(member);
      if (propertyName === undefined) {
        return undefined;
      }
      propertyTypeNodes.set(propertyName, mappedTypeNode.type);
    }
  } else {
    const propertyName = getLiteralTypePropertyName(unwrappedConstraint);
    if (propertyName !== undefined) {
      propertyTypeNodes.set(propertyName, mappedTypeNode.type);
    } else if (unwrappedConstraint.kind === ts.SyntaxKind.StringKeyword) {
      stringIndexTypeNode = mappedTypeNode.type;
    } else if (unwrappedConstraint.kind === ts.SyntaxKind.NumberKeyword) {
      numberIndexTypeNode = mappedTypeNode.type;
    } else {
      return undefined;
    }
  }

  return createNormalizedRelationMemberSurface(
    propertyTypeNodes,
    undefined,
    stringIndexTypeNode,
    numberIndexTypeNode,
  );
}

function getTrustedUtilityAliasMemberSurface(
  context: AnalysisContext,
  typeReferenceNode: ts.TypeReferenceNode,
): NormalizedRelationMemberSurface | undefined {
  const symbol = getTypeReferenceOrExpressionSymbol(context, typeReferenceNode.typeName);
  if (!symbol || !isTrustedUtilityAliasSymbol(symbol)) {
    return undefined;
  }

  const [firstTypeArgument, secondTypeArgument] = typeReferenceNode.typeArguments ?? [];
  switch (symbol.getName()) {
    case 'Record': {
      const propertyTypeNodes = new Map<string, ts.TypeNode>();
      let stringIndexTypeNode: ts.TypeNode | undefined;
      let numberIndexTypeNode: ts.TypeNode | undefined;
      const keyTypeNode = unwrapRelationTypeNode(firstTypeArgument);
      if (!keyTypeNode || !secondTypeArgument) {
        return undefined;
      }

      if (ts.isUnionTypeNode(keyTypeNode)) {
        for (const member of keyTypeNode.types) {
          const propertyName = getLiteralTypePropertyName(member);
          if (propertyName === undefined) {
            return undefined;
          }
          propertyTypeNodes.set(propertyName, secondTypeArgument);
        }
      } else {
        const propertyName = getLiteralTypePropertyName(keyTypeNode);
        if (propertyName !== undefined) {
          propertyTypeNodes.set(propertyName, secondTypeArgument);
        } else if (keyTypeNode.kind === ts.SyntaxKind.StringKeyword) {
          stringIndexTypeNode = secondTypeArgument;
        } else if (keyTypeNode.kind === ts.SyntaxKind.NumberKeyword) {
          numberIndexTypeNode = secondTypeArgument;
        } else {
          return undefined;
        }
      }

      return createNormalizedRelationMemberSurface(
        propertyTypeNodes,
        undefined,
        stringIndexTypeNode,
        numberIndexTypeNode,
      );
    }
    case 'Readonly':
    case 'Partial':
    case 'Required':
      return getNormalizedRelationMemberSurface(context, firstTypeArgument);
    case 'Pick': {
      const baseSurface = getNormalizedRelationMemberSurface(context, firstTypeArgument);
      const keyNames = getPropertyNamesFromKeyTypeNode(secondTypeArgument);
      if (!baseSurface || !keyNames || keyNames.length === 0) {
        return undefined;
      }

      const propertyTypeNodes = new Map<string, ts.TypeNode>();
      for (const keyName of keyNames) {
        const propertyTypeNode = baseSurface.propertyTypeNodes.get(keyName);
        if (propertyTypeNode) {
          propertyTypeNodes.set(keyName, propertyTypeNode);
        }
      }

      return createNormalizedRelationMemberSurface(propertyTypeNodes);
    }
    case 'Omit': {
      const baseSurface = getNormalizedRelationMemberSurface(context, firstTypeArgument);
      if (!baseSurface) {
        return undefined;
      }

      const omittedKeys = new Set(getPropertyNamesFromKeyTypeNode(secondTypeArgument) ?? []);
      const propertyTypeNodes = new Map<string, ts.TypeNode>();
      for (const [propertyName, propertyTypeNode] of baseSurface.propertyTypeNodes) {
        if (!omittedKeys.has(propertyName)) {
          propertyTypeNodes.set(propertyName, propertyTypeNode);
        }
      }

      return createNormalizedRelationMemberSurface(
        propertyTypeNodes,
        undefined,
        baseSurface.stringIndexTypeNode,
        baseSurface.numberIndexTypeNode,
      );
    }
    default:
      return undefined;
  }
}

function getTypeParameterSubstitutionMap(
  context: AnalysisContext,
  typeArgumentNodes: readonly ts.TypeNode[] | undefined,
  symbol: ts.Symbol,
): ReadonlyMap<number, ts.TypeNode> | undefined {
  const typeParameters = getSymbolTypeParameterDeclarations(symbol);
  if (typeParameters.length === 0) {
    return new Map();
  }

  const resolvedTypeArgumentNodes = typeArgumentNodes ?? [];
  if (resolvedTypeArgumentNodes.length !== typeParameters.length) {
    return undefined;
  }

  const substitutions = new Map<number, ts.TypeNode>();
  for (const [index, typeParameter] of typeParameters.entries()) {
    const parameterSymbol = context.checker.getSymbolAtLocation(typeParameter.name);
    const typeArgumentNode = resolvedTypeArgumentNodes[index];
    if (!parameterSymbol || !typeArgumentNode) {
      return undefined;
    }
    substitutions.set(context.getSymbolId(parameterSymbol), typeArgumentNode);
  }

  return substitutions;
}

function substituteTypeParameterTypeNodes(
  context: AnalysisContext,
  typeNode: ts.TypeNode,
  substitutions: ReadonlyMap<number, ts.TypeNode>,
): ts.TypeNode {
  if (substitutions.size === 0) {
    return typeNode;
  }

  const visitor = (node: ts.Node): ts.Node => {
    if (ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node)) {
      const symbol = getRelationReferenceTypeNodeSymbol(context, node);
      if (symbol && (symbol.flags & ts.SymbolFlags.TypeParameter) !== 0) {
        const substitution = substitutions.get(context.getSymbolId(symbol));
        if (substitution) {
          return substitution;
        }
      }
    }

    return ts.visitEachChild(
      node,
      visitor,
      (ts as typeof ts & { nullTransformationContext: ts.TransformationContext })
        .nullTransformationContext,
    );
  };

  return ts.visitNode(typeNode, visitor) as ts.TypeNode;
}

function substituteRelationMemberTypeNode(
  context: AnalysisContext,
  memberTypeNode: ts.TypeNode | ts.MethodSignature,
  substitutions: ReadonlyMap<number, ts.TypeNode>,
): ts.TypeNode | ts.MethodSignature {
  if (ts.isMethodSignature(memberTypeNode)) {
    const parameters = memberTypeNode.parameters.map((parameter) =>
      ts.factory.updateParameterDeclaration(
        parameter,
        parameter.modifiers,
        parameter.dotDotDotToken,
        parameter.name,
        parameter.questionToken,
        parameter.type
          ? substituteTypeParameterTypeNodes(context, parameter.type, substitutions)
          : undefined,
        parameter.initializer,
      )
    );
    return ts.factory.createFunctionTypeNode(
      memberTypeNode.typeParameters,
      parameters,
      memberTypeNode.type
        ? substituteTypeParameterTypeNodes(context, memberTypeNode.type, substitutions)
        : ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
    );
  }

  return substituteTypeParameterTypeNodes(context, memberTypeNode, substitutions);
}

function substituteNormalizedRelationMemberSurface(
  context: AnalysisContext,
  memberSurface: NormalizedRelationMemberSurface | undefined,
  substitutions: ReadonlyMap<number, ts.TypeNode>,
): NormalizedRelationMemberSurface | undefined {
  if (!memberSurface) {
    return undefined;
  }

  if (substitutions.size === 0) {
    return memberSurface;
  }

  const propertyTypeNodes = new Map<string, ts.TypeNode>();
  for (const [propertyName, propertyTypeNode] of memberSurface.propertyTypeNodes) {
    propertyTypeNodes.set(
      propertyName,
      substituteTypeParameterTypeNodes(context, propertyTypeNode, substitutions),
    );
  }
  const propertyMemberTypeNodes = new Map<string, ts.TypeNode | ts.MethodSignature>();
  for (const [propertyName, propertyMemberTypeNode] of memberSurface.propertyMemberTypeNodes) {
    propertyMemberTypeNodes.set(
      propertyName,
      substituteRelationMemberTypeNode(context, propertyMemberTypeNode, substitutions),
    );
  }

  return createNormalizedRelationMemberSurface(
    propertyTypeNodes,
    propertyMemberTypeNodes,
    memberSurface.stringIndexTypeNode
      ? substituteTypeParameterTypeNodes(
        context,
        memberSurface.stringIndexTypeNode,
        substitutions,
      )
      : undefined,
    memberSurface.numberIndexTypeNode
      ? substituteTypeParameterTypeNodes(
        context,
        memberSurface.numberIndexTypeNode,
        substitutions,
      )
      : undefined,
  );
}

function createNormalizedRelationCallableSurface(
  callSignatures: readonly ResolvedSignatureTypeNodes[],
  constructSignatures: readonly ResolvedSignatureTypeNodes[],
): NormalizedRelationCallableSurface | undefined {
  if (callSignatures.length === 0 && constructSignatures.length === 0) {
    return undefined;
  }

  return {
    callSignatures,
    constructSignatures,
  };
}

function appendNormalizedRelationCallableSurface(
  base: NormalizedRelationCallableSurface | undefined,
  extra: NormalizedRelationCallableSurface | undefined,
): NormalizedRelationCallableSurface | undefined {
  if (!base) {
    return extra;
  }
  if (!extra) {
    return base;
  }

  return createNormalizedRelationCallableSurface(
    [...base.callSignatures, ...extra.callSignatures],
    [...base.constructSignatures, ...extra.constructSignatures],
  );
}

function createResolvedSignatureTypeNodes(
  context: AnalysisContext,
  declaration: RelationCallableSignatureDeclaration,
  substitutions: ReadonlyMap<number, ts.TypeNode>,
): ResolvedSignatureTypeNodes {
  const parameterTypeNodes = declaration.parameters.map((parameter) =>
    parameter.type
      ? substituteTypeParameterTypeNodes(context, parameter.type, substitutions)
      : undefined
  );
  const returnTypeNode = declaration.type
    ? substituteTypeParameterTypeNodes(context, declaration.type, substitutions)
    : undefined;

  return {
    declaration,
    parameterTypeNodes,
    predicateTypeNode: returnTypeNode && ts.isTypePredicateNode(returnTypeNode)
      ? returnTypeNode.type
      : undefined,
    returnTypeNode,
  };
}

function getTypeElementCallableSurface(
  context: AnalysisContext,
  members: readonly ts.TypeElement[],
  substitutions: ReadonlyMap<number, ts.TypeNode>,
): NormalizedRelationCallableSurface | undefined {
  const callSignatures: ResolvedSignatureTypeNodes[] = [];
  const constructSignatures: ResolvedSignatureTypeNodes[] = [];

  for (const member of members) {
    if (ts.isCallSignatureDeclaration(member)) {
      callSignatures.push(createResolvedSignatureTypeNodes(context, member, substitutions));
      continue;
    }

    if (ts.isConstructSignatureDeclaration(member)) {
      constructSignatures.push(createResolvedSignatureTypeNodes(context, member, substitutions));
    }
  }

  return createNormalizedRelationCallableSurface(callSignatures, constructSignatures);
}

function getSingleDeclarationCallableSurface(
  context: AnalysisContext,
  declaration: RelationCallableSignatureDeclaration,
  substitutions: ReadonlyMap<number, ts.TypeNode>,
): NormalizedRelationCallableSurface {
  const resolvedSignatureTypeNodes = createResolvedSignatureTypeNodes(
    context,
    declaration,
    substitutions,
  );
  return ts.isConstructSignatureDeclaration(declaration) || ts.isConstructorTypeNode(declaration)
    ? {
      callSignatures: [],
      constructSignatures: [resolvedSignatureTypeNodes],
    }
    : {
      callSignatures: [resolvedSignatureTypeNodes],
      constructSignatures: [],
    };
}

function getOrdinaryRelationSymbolCallableSurface(
  context: AnalysisContext,
  symbol: ts.Symbol,
  substitutions: ReadonlyMap<number, ts.TypeNode>,
): NormalizedRelationCallableSurface | undefined {
  let callableSurface: NormalizedRelationCallableSurface | undefined;
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (ts.isInterfaceDeclaration(declaration)) {
      let declarationCallableSurface = getTypeElementCallableSurface(
        context,
        declaration.members,
        substitutions,
      );
      for (const heritageClause of declaration.heritageClauses ?? []) {
        for (const heritageType of heritageClause.types) {
          declarationCallableSurface = appendNormalizedRelationCallableSurface(
            declarationCallableSurface,
            getOrdinaryExpressionReferenceCallableSurface(
              context,
              heritageType.expression,
              heritageType.typeArguments?.map((typeArgumentNode) =>
                substituteTypeParameterTypeNodes(context, typeArgumentNode, substitutions)
              ),
            ),
          );
        }
      }
      callableSurface = appendNormalizedRelationCallableSurface(
        callableSurface,
        declarationCallableSurface,
      );
    }
  }

  if (callableSurface) {
    return callableSurface;
  }

  const aliasDeclaration = (symbol.getDeclarations() ?? []).find(ts.isTypeAliasDeclaration);
  return aliasDeclaration
    ? getNormalizedRelationCallableSurface(context, aliasDeclaration.type, substitutions)
    : undefined;
}

function getOrdinaryExpressionReferenceCallableSurface(
  context: AnalysisContext,
  expression: ts.Expression,
  typeArguments: readonly ts.TypeNode[] | undefined,
): NormalizedRelationCallableSurface | undefined {
  const symbol = getResolvedAliasSymbol(
    context,
    getTypeReferenceOrExpressionSymbol(context, expression),
  );
  if (!symbol) {
    return undefined;
  }

  const substitutions = getTypeParameterSubstitutionMap(context, typeArguments, symbol);
  if (!substitutions) {
    return undefined;
  }

  return getOrdinaryRelationSymbolCallableSurface(context, symbol, substitutions);
}

function getOrdinaryRelationReferenceCallableSurface(
  context: AnalysisContext,
  typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
): NormalizedRelationCallableSurface | undefined {
  const symbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, typeReferenceNode),
  );
  if (!symbol) {
    return undefined;
  }

  const substitutions = getTypeParameterSubstitutionMap(
    context,
    typeReferenceNode.typeArguments,
    symbol,
  );
  if (!substitutions) {
    return undefined;
  }

  return getOrdinaryRelationSymbolCallableSurface(context, symbol, substitutions);
}

function getNormalizedRelationCallableSurface(
  context: AnalysisContext,
  targetTypeNode: ts.TypeNode | undefined,
  substitutions: ReadonlyMap<number, ts.TypeNode> = new Map(),
): NormalizedRelationCallableSurface | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(targetTypeNode);
  if (!unwrappedTypeNode) {
    return undefined;
  }

  if (
    ts.isTypeOperatorNode(unwrappedTypeNode) &&
    unwrappedTypeNode.operator === ts.SyntaxKind.ReadonlyKeyword
  ) {
    return getNormalizedRelationCallableSurface(context, unwrappedTypeNode.type, substitutions);
  }

  if (ts.isTypeLiteralNode(unwrappedTypeNode)) {
    return getTypeElementCallableSurface(context, unwrappedTypeNode.members, substitutions);
  }

  if (ts.isFunctionTypeNode(unwrappedTypeNode) || ts.isConstructorTypeNode(unwrappedTypeNode)) {
    return getSingleDeclarationCallableSurface(context, unwrappedTypeNode, substitutions);
  }

  const effectiveTypeNode = substitutions.size > 0
    ? substituteTypeParameterTypeNodes(context, unwrappedTypeNode, substitutions)
    : unwrappedTypeNode;
  if (isRelationReferenceTypeNode(effectiveTypeNode)) {
    return getOrdinaryRelationReferenceCallableSurface(context, effectiveTypeNode);
  }

  return undefined;
}

function getOrdinaryRelationTypeCallableSurface(
  context: AnalysisContext,
  type: ts.Type,
): NormalizedRelationCallableSurface | undefined {
  const normalizedType = normalizeTransparentRelationType(context, type);
  const relationInfo = getGenericRelationTypeInfo(context, normalizedType);
  if (relationInfo) {
    const substitutions = new Map<number, ts.TypeNode>();
    const typeParameters = getSymbolTypeParameterDeclarations(relationInfo.symbol);
    if (typeParameters.length !== relationInfo.typeArguments.length) {
      return undefined;
    }
    for (const [index, typeParameter] of typeParameters.entries()) {
      const parameterSymbol = context.checker.getSymbolAtLocation(typeParameter.name);
      const typeArgumentNode = getSynthesizedRelationTypeNode(
        context,
        relationInfo.typeArguments[index],
      );
      if (!parameterSymbol || !typeArgumentNode) {
        return undefined;
      }
      substitutions.set(context.getSymbolId(parameterSymbol), typeArgumentNode);
    }
    return getOrdinaryRelationSymbolCallableSurface(context, relationInfo.symbol, substitutions);
  }

  const symbol = getResolvedAliasSymbol(
    context,
    getTypeReferenceSymbol(normalizedType) ?? normalizedType.getSymbol(),
  );
  return symbol ? getOrdinaryRelationSymbolCallableSurface(context, symbol, new Map()) : undefined;
}

function getOrdinaryRelationSymbolMemberSurface(
  context: AnalysisContext,
  symbol: ts.Symbol,
  substitutions: ReadonlyMap<number, ts.TypeNode>,
): NormalizedRelationMemberSurface | undefined {
  let inheritedSurface: NormalizedRelationMemberSurface | undefined;
  const mergedInterfaceMembers: ts.TypeElement[] = [];
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (ts.isInterfaceDeclaration(declaration)) {
      for (const heritageClause of declaration.heritageClauses ?? []) {
        for (const heritageType of heritageClause.types) {
          inheritedSurface = mergeNormalizedRelationMemberSurface(
            inheritedSurface,
            getOrdinaryExpressionReferenceMemberSurface(
              context,
              heritageType.expression,
              heritageType.typeArguments?.map((typeArgumentNode) =>
                substituteTypeParameterTypeNodes(context, typeArgumentNode, substitutions)
              ),
            ),
          );
        }
      }
      mergedInterfaceMembers.push(...declaration.members);
    }
  }
  const directSurface = mergedInterfaceMembers.length > 0
    ? substituteNormalizedRelationMemberSurface(
      context,
      getTypeElementMemberSurface(mergedInterfaceMembers),
      substitutions,
    )
    : undefined;
  const interfaceSurface = mergeNormalizedRelationMemberSurface(inheritedSurface, directSurface);
  if (interfaceSurface) {
    return interfaceSurface;
  }

  const aliasDeclaration = (symbol.getDeclarations() ?? []).find(ts.isTypeAliasDeclaration);
  return aliasDeclaration
    ? getNormalizedRelationMemberSurface(
      context,
      substituteTypeParameterTypeNodes(context, aliasDeclaration.type, substitutions),
    )
    : undefined;
}

function getOrdinaryExpressionReferenceMemberSurface(
  context: AnalysisContext,
  expression: ts.Expression,
  typeArguments: readonly ts.TypeNode[] | undefined,
): NormalizedRelationMemberSurface | undefined {
  const symbol = getResolvedAliasSymbol(
    context,
    getTypeReferenceOrExpressionSymbol(context, expression),
  );
  if (!symbol) {
    return undefined;
  }

  const substitutions = getTypeParameterSubstitutionMap(context, typeArguments, symbol);
  if (!substitutions) {
    return undefined;
  }

  return getOrdinaryRelationSymbolMemberSurface(context, symbol, substitutions);
}

function getOrdinaryRelationReferenceMemberSurface(
  context: AnalysisContext,
  typeReferenceNode: ts.ImportTypeNode | ts.TypeReferenceNode,
): NormalizedRelationMemberSurface | undefined {
  const symbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, typeReferenceNode),
  );
  if (!symbol) {
    return undefined;
  }

  const substitutions = getTypeParameterSubstitutionMap(
    context,
    typeReferenceNode.typeArguments,
    symbol,
  );
  if (!substitutions) {
    return undefined;
  }

  return getOrdinaryRelationSymbolMemberSurface(context, symbol, substitutions);
}

function getNormalizedRelationMemberSurface(
  context: AnalysisContext,
  targetTypeNode: ts.TypeNode | undefined,
): NormalizedRelationMemberSurface | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(targetTypeNode);
  if (!unwrappedTypeNode) {
    return undefined;
  }

  if (
    ts.isTypeOperatorNode(unwrappedTypeNode) &&
    unwrappedTypeNode.operator === ts.SyntaxKind.ReadonlyKeyword
  ) {
    return getNormalizedRelationMemberSurface(context, unwrappedTypeNode.type);
  }

  if (ts.isTypeLiteralNode(unwrappedTypeNode)) {
    return getTypeLiteralMemberSurface(unwrappedTypeNode);
  }

  if (ts.isMappedTypeNode(unwrappedTypeNode)) {
    return getMappedTypeMemberSurface(unwrappedTypeNode);
  }

  if (isRelationReferenceTypeNode(unwrappedTypeNode)) {
    return ts.isTypeReferenceNode(unwrappedTypeNode)
      ? getTrustedUtilityAliasMemberSurface(context, unwrappedTypeNode) ??
        getOrdinaryRelationReferenceMemberSurface(context, unwrappedTypeNode)
      : getOrdinaryRelationReferenceMemberSurface(context, unwrappedTypeNode);
  }

  return undefined;
}

function getPropertyTypeNodeFromTypeNode(
  context: AnalysisContext,
  targetTypeNode: ts.TypeNode | undefined,
  propertyName: string,
): ts.TypeNode | undefined {
  const memberSurface = getNormalizedRelationMemberSurface(context, targetTypeNode);
  if (!memberSurface) {
    return undefined;
  }

  const explicitPropertyTypeNode = memberSurface.propertyTypeNodes.get(propertyName);
  if (explicitPropertyTypeNode) {
    return explicitPropertyTypeNode;
  }

  if (isNumericPropertyName(propertyName) && memberSurface.numberIndexTypeNode) {
    return memberSurface.numberIndexTypeNode;
  }

  return memberSurface.stringIndexTypeNode;
}

function getPropertyMemberTypeNodeFromTypeNode(
  context: AnalysisContext,
  targetTypeNode: ts.TypeNode | undefined,
  propertyName: string,
): ts.TypeNode | ts.MethodSignature | undefined {
  const memberSurface = getNormalizedRelationMemberSurface(context, targetTypeNode);
  return memberSurface?.propertyMemberTypeNodes.get(propertyName);
}

function getObjectLiteralPropertyTypeNode(
  context: AnalysisContext,
  targetTypeNode: ts.TypeNode | undefined,
  propertyName: string,
): ts.TypeNode | undefined {
  return getPropertyTypeNodeFromTypeNode(context, targetTypeNode, propertyName);
}

function getTupleElementTypeNodeFromRelationTypeNode(
  context: AnalysisContext,
  targetTypeNode: ts.TypeNode | undefined,
  index: number,
  seenSymbols: Set<number> = new Set(),
): ts.TypeNode | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(targetTypeNode);
  if (!unwrappedTypeNode) {
    return undefined;
  }

  if (
    ts.isTypeOperatorNode(unwrappedTypeNode) &&
    unwrappedTypeNode.operator === ts.SyntaxKind.ReadonlyKeyword
  ) {
    return getTupleElementTypeNodeFromRelationTypeNode(
      context,
      unwrappedTypeNode.type,
      index,
      seenSymbols,
    );
  }

  if (ts.isTupleTypeNode(unwrappedTypeNode)) {
    return getTupleElementRelationTypeNode(unwrappedTypeNode.elements[index]);
  }

  if (!isRelationReferenceTypeNode(unwrappedTypeNode)) {
    return undefined;
  }

  const symbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, unwrappedTypeNode),
  );
  if (!symbol) {
    return undefined;
  }

  const symbolId = context.getSymbolId(symbol);
  if (seenSymbols.has(symbolId)) {
    return undefined;
  }

  const substitutions = getTypeParameterSubstitutionMap(
    context,
    unwrappedTypeNode.typeArguments,
    symbol,
  );
  if (!substitutions) {
    return undefined;
  }

  const aliasDeclaration = (symbol.getDeclarations() ?? []).find(ts.isTypeAliasDeclaration);
  if (!aliasDeclaration) {
    return undefined;
  }

  seenSymbols.add(symbolId);
  return getTupleElementTypeNodeFromRelationTypeNode(
    context,
    substituteTypeParameterTypeNodes(context, aliasDeclaration.type, substitutions),
    index,
    seenSymbols,
  );
}

function getArrayLiteralElementTypeNode(
  context: AnalysisContext,
  targetTypeNode: ts.TypeNode | undefined,
  index: number,
): ts.TypeNode | undefined {
  const tupleElementTypeNode = getTupleElementTypeNodeFromRelationTypeNode(
    context,
    targetTypeNode,
    index,
  );
  if (tupleElementTypeNode) {
    return tupleElementTypeNode;
  }

  const unwrappedTypeNode = unwrapRelationTypeNode(targetTypeNode);
  if (!unwrappedTypeNode) {
    return undefined;
  }

  if (ts.isArrayTypeNode(unwrappedTypeNode)) {
    return unwrappedTypeNode.elementType;
  }

  return undefined;
}

function getArrayLikeRelationElementTypeNode(
  context: AnalysisContext,
  targetTypeNode: ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(targetTypeNode);
  if (!unwrappedTypeNode) {
    return undefined;
  }

  if (
    ts.isTypeOperatorNode(unwrappedTypeNode) &&
    unwrappedTypeNode.operator === ts.SyntaxKind.ReadonlyKeyword
  ) {
    return getArrayLikeRelationElementTypeNode(context, unwrappedTypeNode.type);
  }

  if (ts.isArrayTypeNode(unwrappedTypeNode)) {
    return unwrappedTypeNode.elementType;
  }

  if (!ts.isTypeReferenceNode(unwrappedTypeNode)) {
    return undefined;
  }

  const relationSymbol = getResolvedAliasSymbol(
    context,
    getRelationReferenceTypeNodeSymbol(context, unwrappedTypeNode),
  );
  if (
    relationSymbol?.getName() !== 'Array' &&
    relationSymbol?.getName() !== 'ReadonlyArray'
  ) {
    return undefined;
  }

  return unwrappedTypeNode.typeArguments?.[0];
}

function getTupleElementRelationTypeNode(
  elementNode: ts.NamedTupleMember | ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  if (!elementNode) {
    return undefined;
  }

  if (ts.isNamedTupleMember(elementNode)) {
    if (elementNode.dotDotDotToken) {
      return getRestTupleElementTypeNode(elementNode.type);
    }
    return elementNode.type;
  }

  if (ts.isRestTypeNode(elementNode)) {
    return getRestTupleElementTypeNode(elementNode.type);
  }

  return elementNode;
}

function getRestTupleElementTypeNode(typeNode: ts.TypeNode): ts.TypeNode {
  const unwrappedTypeNode = unwrapRelationTypeNode(typeNode);
  if (unwrappedTypeNode && ts.isArrayTypeNode(unwrappedTypeNode)) {
    return unwrappedTypeNode.elementType;
  }

  return typeNode;
}

function getIndexedAccessPropertyNames(indexTypeNode: ts.TypeNode): readonly string[] | undefined {
  return getPropertyNamesFromKeyTypeNode(indexTypeNode);
}

function getNormalizedRelationMemberProbeNames(
  memberSurface: NormalizedRelationMemberSurface | undefined,
): readonly string[] {
  const probeNames: string[] = [];
  if (memberSurface?.stringIndexTypeNode) {
    probeNames.push('__soundscript_probe__');
  }
  if (memberSurface?.numberIndexTypeNode) {
    probeNames.push('0');
  }
  return probeNames;
}

function classifyUnsoundCompositePayloadGenericAliasRelation(
  context: AnalysisContext,
  sourceType: ts.Type,
  targetType: ts.Type,
  targetTypeNode: ts.TypeNode,
  sourceExpression?: ts.Expression,
  sourceTypeNode?: ts.TypeNode,
  visitedPairs: Set<string> = new Set(),
): RelationMismatch | undefined {
  try {
    const targetMemberSurface = getNormalizedRelationMemberSurface(context, targetTypeNode);
    const propertyNames = new Set<string>(collectCompositePropertyNames(context, targetType));
    for (const propertyName of targetMemberSurface?.propertyTypeNodes.keys() ?? []) {
      propertyNames.add(propertyName);
    }
    for (const propertyName of collectCompositePropertyNames(context, sourceType)) {
      if (getPropertyTypeNodeFromTypeNode(context, targetTypeNode, propertyName)) {
        propertyNames.add(propertyName);
      }
    }

    for (const propertyName of propertyNames) {
      const sourcePropertyType =
        getPropertyVarianceInfo(context, sourceType, propertyName)?.readType ??
          getReadableIndexTypeForPropertyName(context, sourceType, propertyName);
      const targetPropertyType =
        getPropertyVarianceInfo(context, targetType, propertyName)?.readType ??
          getReadableIndexTypeForPropertyName(context, targetType, propertyName);
      const targetPropertyTypeNode = getPropertyTypeNodeFromTypeNode(
        context,
        targetTypeNode,
        propertyName,
      );
      const effectiveTargetPropertyTypeNode = targetPropertyTypeNode ??
        getSynthesizedRelationTypeNode(context, targetPropertyType);
      if (!sourcePropertyType || !targetPropertyType || !effectiveTargetPropertyTypeNode) {
        continue;
      }

      const propertyMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourcePropertyType,
        targetPropertyType,
        effectiveTargetPropertyTypeNode,
        sourceExpression,
        getPropertyTypeNodeFromTypeNode(context, sourceTypeNode, propertyName) ??
          getSynthesizedRelationTypeNode(context, sourcePropertyType),
      );
      if (propertyMismatch) {
        return propertyMismatch;
      }
    }

    for (const propertyName of getNormalizedRelationMemberProbeNames(targetMemberSurface)) {
      const sourceIndexType = getReadableIndexTypeForPropertyName(
        context,
        sourceType,
        propertyName,
      );
      const targetIndexType = getReadableIndexTypeForPropertyName(
        context,
        targetType,
        propertyName,
      );
      const targetIndexTypeNode = getPropertyTypeNodeFromTypeNode(
        context,
        targetTypeNode,
        propertyName,
      );
      const effectiveTargetIndexTypeNode = targetIndexTypeNode ??
        getSynthesizedRelationTypeNode(context, targetIndexType);
      if (!sourceIndexType || !targetIndexType || !effectiveTargetIndexTypeNode) {
        continue;
      }

      const indexMismatch = classifyUnsoundTypeNodeGenericAliasRelation(
        context,
        sourceIndexType,
        targetIndexType,
        effectiveTargetIndexTypeNode,
        sourceExpression,
        getPropertyTypeNodeFromTypeNode(context, sourceTypeNode, propertyName) ??
          getSynthesizedRelationTypeNode(context, sourceIndexType),
      );
      if (indexMismatch) {
        return indexMismatch;
      }
    }

    return undefined;
  } catch (error) {
    if (isStackOverflowLikeError(error)) {
      return undefined;
    }
    throw error;
  }
}

function checkNestedLiteralRelationSites(
  context: AnalysisContext,
  diagnostics: SoundDiagnostic[],
  expression: ts.Expression,
  targetType: ts.Type,
  targetTypeNode?: ts.TypeNode,
): boolean {
  const startCount = diagnostics.length;
  const unwrappedExpression = unwrapRelationExpression(expression);

  if (ts.isArrayLiteralExpression(unwrappedExpression)) {
    const targetTupleType = isTupleType(context, targetType) ? targetType : undefined;
    const targetElementTypes = targetTupleType
      ? getTupleElementTypes(context, targetTupleType)
      : [];
    const fallbackElementType = getArrayElementType(context, targetType) ??
      (hasTypeReferenceName(context, targetType, 'ReadonlyArray')
        ? getReferenceTypeArguments(context, targetType)[0]
        : undefined);

    for (const [index, element] of unwrappedExpression.elements.entries()) {
      if (!ts.isExpression(element)) {
        continue;
      }

      const elementTargetType = targetElementTypes[index] ?? fallbackElementType;
      if (!elementTargetType) {
        continue;
      }

      checkUnsoundRelationAtExpression(
        context,
        diagnostics,
        element,
        element,
        elementTargetType,
        getArrayLiteralElementTypeNode(context, targetTypeNode, index),
      );
    }
    return diagnostics.length > startCount;
  }

  if (!ts.isObjectLiteralExpression(unwrappedExpression)) {
    return false;
  }

  const effectiveTargetType = getEffectiveObjectLiteralTargetType(
    context,
    unwrappedExpression,
    targetType,
  );

  for (const property of unwrappedExpression.properties) {
    const propertyInfo = getObjectLiteralRelationPropertyInfo(context, property);
    if (!propertyInfo) {
      continue;
    }

    const { propertyExpression, propertyName } = propertyInfo;

    const targetProperty = context.checker.getPropertyOfType(effectiveTargetType, propertyName);
    const targetPropertyType = targetProperty
      ? context.checker.getTypeOfSymbolAtLocation(targetProperty, propertyExpression ?? property)
      : getReadableIndexTypeForPropertyName(context, effectiveTargetType, propertyName);
    if (!targetPropertyType) {
      continue;
    }

    if (ts.isMethodDeclaration(property)) {
      const targetPropertyTypeNode = getObjectLiteralPropertyTypeNode(
        context,
        targetTypeNode,
        propertyName,
      );
      const alphaEquivalentTargetPropertyTypeNode = getAlphaEquivalentSignatureLikeTypeNode(
        getPropertyMemberTypeNodeFromTypeNode(context, targetTypeNode, propertyName),
      );
      if (
        alphaEquivalentTargetPropertyTypeNode &&
        areAlphaEquivalentSignatureLikeTypeNodes(
          context,
          property,
          alphaEquivalentTargetPropertyTypeNode,
          { sourceToTarget: new Map(), targetToSource: new Map() },
        )
      ) {
        continue;
      }
      const sourceMethodType = context.checker.getTypeAtLocation(property);
      const targetHasCallableSignatures =
        context.checker.getSignaturesOfType(targetPropertyType, ts.SignatureKind.Call).length > 0 ||
        context.checker.getSignaturesOfType(targetPropertyType, ts.SignatureKind.Construct)
            .length > 0;
      if (targetHasCallableSignatures) {
        const callableMismatch = measureRelationExpressionPhase(
          isCheckerTimingEnabled(),
          'type.methodCallableMismatch',
          property,
          {
            sourceKind: ts.SyntaxKind[property.kind],
            targetKind: ts.TypeFlags[targetPropertyType.flags] ?? String(targetPropertyType.flags),
          },
          () =>
            classifyUnsoundCallableSignatureRelation(
              context,
              sourceMethodType,
              targetPropertyType,
              property,
            ),
        );
        if (callableMismatch) {
          diagnostics.push(
            createDiagnostic(property, toRelationDiagnosticDetails(callableMismatch)),
          );
        }
        continue;
      }
      checkUnsoundRelationAtType(
        context,
        diagnostics,
        property,
        sourceMethodType,
        targetPropertyType,
        targetPropertyTypeNode,
      );
      continue;
    }

    if (!propertyExpression) {
      continue;
    }

    checkUnsoundRelationAtExpression(
      context,
      diagnostics,
      property,
      propertyExpression,
      targetPropertyType,
      getObjectLiteralPropertyTypeNode(context, targetTypeNode, propertyName),
    );
  }

  return diagnostics.length > startCount;
}

function getResolvedSignatureParameter(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  argumentIndex: number,
): { fixedParameterCount: number; parameter: ts.Symbol; restOffset?: number } | undefined {
  const signature = context.checker.getResolvedSignature(callLike);
  if (!signature) {
    return undefined;
  }

  const parameters = signature.getParameters();
  if (parameters.length === 0) {
    return undefined;
  }

  const lastParameter = parameters[parameters.length - 1];
  const declaration = lastParameter?.valueDeclaration;
  const hasRestParameter = declaration !== undefined &&
    ts.isParameter(declaration) &&
    declaration.dotDotDotToken !== undefined;
  const fixedParameterCount = hasRestParameter ? parameters.length - 1 : parameters.length;

  if (argumentIndex < fixedParameterCount) {
    const parameter = parameters[argumentIndex];
    return parameter ? { fixedParameterCount, parameter } : undefined;
  }

  if (!hasRestParameter || !lastParameter) {
    return undefined;
  }

  return {
    fixedParameterCount,
    parameter: lastParameter,
    restOffset: argumentIndex - fixedParameterCount,
  };
}

function getRestParameterElementType(
  context: AnalysisContext,
  restParameterType: ts.Type,
  restOffset: number,
  totalRestArgumentCount?: number,
): ts.Type | undefined {
  if (isTupleType(context, restParameterType)) {
    const tupleShape = getTupleShape(context, restParameterType);
    if (!tupleShape.hasRestElement || restOffset < tupleShape.fixedLength) {
      return tupleShape.prefixTypes[restOffset];
    }

    if (totalRestArgumentCount !== undefined) {
      const suffixStart = totalRestArgumentCount - tupleShape.suffixTypes.length;
      if (restOffset >= suffixStart) {
        return tupleShape.suffixTypes[restOffset - suffixStart];
      }
    }

    return tupleShape.restType;
  }

  return getArrayElementType(context, restParameterType);
}

function getResolvedParameterType(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  argumentIndex: number,
  totalExpandedArgumentCount?: number,
): ts.Type | undefined {
  const resolvedParameter = getResolvedSignatureParameter(context, callLike, argumentIndex);
  if (!resolvedParameter) {
    return undefined;
  }

  if (resolvedParameter.restOffset !== undefined) {
    const restParameterType = context.checker.getTypeOfSymbolAtLocation(
      resolvedParameter.parameter,
      callLike,
    );
    const totalRestArgumentCount = totalExpandedArgumentCount === undefined
      ? undefined
      : totalExpandedArgumentCount - resolvedParameter.fixedParameterCount;
    return getRestParameterElementType(
      context,
      restParameterType,
      resolvedParameter.restOffset,
      totalRestArgumentCount,
    );
  }

  return context.checker.getTypeOfSymbolAtLocation(resolvedParameter.parameter, callLike);
}

function getRestParameterElementTypeNode(
  restParameterTypeNode: ts.TypeNode,
  restOffset: number,
  totalRestArgumentCount?: number,
): ts.TypeNode | undefined {
  const unwrappedTypeNode = unwrapRelationTypeNode(restParameterTypeNode);
  if (!unwrappedTypeNode) {
    return undefined;
  }

  if (ts.isTupleTypeNode(unwrappedTypeNode)) {
    const fixedLength = unwrappedTypeNode.elements.findIndex((element) =>
      ts.isNamedTupleMember(element)
        ? element.dotDotDotToken !== undefined
        : ts.isRestTypeNode(element)
    );
    if (fixedLength === -1 || restOffset < fixedLength) {
      return unwrappedTypeNode.elements[restOffset];
    }

    const restIndex = fixedLength;
    const suffixTypes = unwrappedTypeNode.elements.slice(restIndex + 1);
    if (
      totalRestArgumentCount !== undefined &&
      restOffset >= totalRestArgumentCount - suffixTypes.length
    ) {
      return suffixTypes[restOffset - (totalRestArgumentCount - suffixTypes.length)];
    }

    const restElement = unwrappedTypeNode.elements[restIndex];
    if (restElement && ts.isNamedTupleMember(restElement)) {
      return restElement.type;
    }
    return restElement && ts.isRestTypeNode(restElement) ? restElement.type : undefined;
  }

  if (ts.isArrayTypeNode(unwrappedTypeNode)) {
    return unwrappedTypeNode.elementType;
  }

  return undefined;
}

function getResolvedParameterTypeNode(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  argumentIndex: number,
  totalExpandedArgumentCount?: number,
): ts.TypeNode | undefined {
  const resolvedParameter = getResolvedSignatureParameter(context, callLike, argumentIndex);
  const declaration = resolvedParameter?.parameter.valueDeclaration;
  if (!resolvedParameter || !declaration || !ts.isParameter(declaration) || !declaration.type) {
    return undefined;
  }

  if (resolvedParameter.restOffset !== undefined) {
    const totalRestArgumentCount = totalExpandedArgumentCount === undefined
      ? undefined
      : totalExpandedArgumentCount - resolvedParameter.fixedParameterCount;
    return getRestParameterElementTypeNode(
      declaration.type,
      resolvedParameter.restOffset,
      totalRestArgumentCount,
    );
  }

  return declaration.type;
}

function getResolvedParameterTypeNodeFromEnd(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  indexFromEnd: number,
): ts.TypeNode | undefined {
  const signature = context.checker.getResolvedSignature(callLike);
  if (!signature) {
    return undefined;
  }

  const parameters = signature.getParameters();
  if (parameters.length === 0) {
    return undefined;
  }

  const lastParameter = parameters[parameters.length - 1];
  const declaration = lastParameter?.valueDeclaration;
  const hasRestParameter = declaration !== undefined &&
    ts.isParameter(declaration) &&
    declaration.dotDotDotToken !== undefined;

  if (!hasRestParameter) {
    const parameter = parameters[parameters.length - 1 - indexFromEnd];
    const parameterDeclaration = parameter?.valueDeclaration;
    return parameterDeclaration && ts.isParameter(parameterDeclaration)
      ? parameterDeclaration.type
      : undefined;
  }

  return declaration && ts.isParameter(declaration) && declaration.type
    ? getRestParameterElementTypeNode(declaration.type, indexFromEnd)
    : undefined;
}

function getTailResolvedParameterTypeNode(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  expandedArgumentIndex: number,
  totalExpandedArgumentCount: number | undefined,
  hasIndeterminatePrefix: boolean,
  laterExpandedArgumentCount: number | undefined,
  currentExpandedWidth: number,
  currentOffset: number,
): ts.TypeNode | undefined {
  if (hasIndeterminatePrefix && laterExpandedArgumentCount !== undefined) {
    return getResolvedParameterTypeNodeFromEnd(
      context,
      callLike,
      laterExpandedArgumentCount + (currentExpandedWidth - 1 - currentOffset),
    );
  }

  return getResolvedParameterTypeNode(
    context,
    callLike,
    expandedArgumentIndex + currentOffset,
    totalExpandedArgumentCount,
  );
}

function getSpreadLiteralElements(expression: ts.Expression): readonly ts.Expression[] | undefined {
  const unwrappedExpression = unwrapRelationExpression(expression);
  if (!ts.isArrayLiteralExpression(unwrappedExpression)) {
    return undefined;
  }

  if (unwrappedExpression.elements.some(ts.isSpreadElement)) {
    return undefined;
  }

  return unwrappedExpression.elements.filter(ts.isExpression);
}

function getSpreadTupleType(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Type | undefined {
  const sourceType = context.checker.getTypeAtLocation(expression);
  if (!isTupleType(context, sourceType)) {
    return undefined;
  }

  return sourceType;
}

function getSpreadArrayElementType(
  context: AnalysisContext,
  expression: ts.Expression,
): ts.Type | undefined {
  const sourceType = context.checker.getTypeAtLocation(expression);
  if (isTupleType(context, sourceType)) {
    return undefined;
  }

  return getArrayElementType(context, sourceType) ??
    (hasTypeReferenceName(context, sourceType, 'ReadonlyArray')
      ? getReferenceTypeArguments(context, sourceType)[0]
      : undefined);
}

function getExactExpandedArgumentCountForArguments(
  context: AnalysisContext,
  argumentsList: readonly ts.Expression[],
): number | undefined {
  let total = 0;

  for (const argument of argumentsList) {
    if (!ts.isSpreadElement(argument)) {
      total += 1;
      continue;
    }

    const literalElements = getSpreadLiteralElements(argument.expression);
    if (literalElements) {
      total += literalElements.length;
      continue;
    }

    const tupleType = getSpreadTupleType(context, argument.expression);
    if (tupleType) {
      const tupleShape = getTupleShape(context, tupleType);
      if (tupleShape.hasRestElement) {
        return undefined;
      }

      total += tupleShape.prefixTypes.length;
      continue;
    }

    return undefined;
  }

  return total;
}

function getExactExpandedArgumentCount(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
): number | undefined {
  return getExactExpandedArgumentCountForArguments(context, nodeArguments(callLike));
}

function nodeArguments(callLike: ts.CallExpression | ts.NewExpression): readonly ts.Expression[] {
  return callLike.arguments ?? [];
}

function getResolvedParameterTypeFromEnd(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  indexFromEnd: number,
): ts.Type | undefined {
  const signature = context.checker.getResolvedSignature(callLike);
  if (!signature) {
    return undefined;
  }

  const parameters = signature.getParameters();
  if (parameters.length === 0) {
    return undefined;
  }

  const lastParameter = parameters[parameters.length - 1];
  const declaration = lastParameter?.valueDeclaration;
  const hasRestParameter = declaration !== undefined &&
    ts.isParameter(declaration) &&
    declaration.dotDotDotToken !== undefined;

  if (!hasRestParameter) {
    const parameter = parameters[parameters.length - 1 - indexFromEnd];
    return parameter ? context.checker.getTypeOfSymbolAtLocation(parameter, callLike) : undefined;
  }

  const restParameterType = context.checker.getTypeOfSymbolAtLocation(lastParameter, callLike);
  if (isTupleType(context, restParameterType)) {
    const tupleShape = getTupleShape(context, restParameterType);
    if (indexFromEnd < tupleShape.suffixTypes.length) {
      return tupleShape.suffixTypes[tupleShape.suffixTypes.length - 1 - indexFromEnd];
    }

    if (tupleShape.restType) {
      return tupleShape.restType;
    }
  }

  return getArrayElementType(context, restParameterType);
}

function getContextualArgumentType(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  argumentIndex: number,
): ts.Type | undefined {
  const checker = context.checker as ts.TypeChecker & {
    getContextualTypeForArgumentAtIndex?: (
      node: ts.CallLikeExpression,
      argumentIndex: number,
    ) => ts.Type | undefined;
  };
  return checker.getContextualTypeForArgumentAtIndex?.(callLike, argumentIndex);
}

function getCallSignatureTypeParameters(
  signatureDeclaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined,
): readonly (ts.TypeParameterDeclaration | ts.JSDocTemplateTag)[] {
  if (!signatureDeclaration) {
    return [];
  }

  if (
    'typeParameters' in signatureDeclaration &&
    (signatureDeclaration.typeParameters?.length ?? 0) > 0
  ) {
    return signatureDeclaration.typeParameters ?? [];
  }

  if (
    ts.isConstructorDeclaration(signatureDeclaration) ||
    ts.isMethodDeclaration(signatureDeclaration) ||
    ts.isMethodSignature(signatureDeclaration)
  ) {
    const parent = signatureDeclaration.parent;
    if (
      (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent)) &&
      (parent.typeParameters?.length ?? 0) > 0
    ) {
      return parent.typeParameters ?? [];
    }
  }

  return [];
}

function getExplicitTypeArgumentNodeForParameterTypeNode(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  parameterTypeNode: ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  if (!parameterTypeNode || !callLike.typeArguments?.length) {
    return undefined;
  }

  const unwrappedTypeNode = unwrapRelationTypeNode(parameterTypeNode);
  if (
    !unwrappedTypeNode ||
    !ts.isTypeReferenceNode(unwrappedTypeNode) ||
    unwrappedTypeNode.typeArguments?.length
  ) {
    return undefined;
  }

  const parameterTypeSymbol = getTypeReferenceOrExpressionSymbol(
    context,
    unwrappedTypeNode.typeName,
  );
  if (!parameterTypeSymbol || (parameterTypeSymbol.flags & ts.SymbolFlags.TypeParameter) === 0) {
    return undefined;
  }

  const signature = context.checker.getResolvedSignature(callLike);
  const typeParameters = getCallSignatureTypeParameters(signature?.declaration);
  if (typeParameters.length !== callLike.typeArguments.length) {
    return undefined;
  }

  for (const [index, typeParameter] of typeParameters.entries()) {
    if (!ts.isTypeParameterDeclaration(typeParameter)) {
      continue;
    }

    const typeParameterSymbol = context.checker.getSymbolAtLocation(typeParameter.name);
    if (typeParameterSymbol !== parameterTypeSymbol) {
      continue;
    }

    return callLike.typeArguments[index];
  }

  return undefined;
}

function getEffectiveArgumentRelationTarget(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  argument: ts.Expression,
  argumentListIndex: number,
  expandedArgumentIndex: number,
  totalExpandedArgumentCount: number | undefined,
  hasIndeterminatePrefix: boolean,
  laterExpandedArgumentCount: number | undefined,
): { type: ts.Type; typeNode?: ts.TypeNode } | undefined {
  const targetType = getTailResolvedParameterType(
    context,
    callLike,
    expandedArgumentIndex,
    totalExpandedArgumentCount,
    hasIndeterminatePrefix,
    laterExpandedArgumentCount,
    1,
    0,
  );
  if (!targetType) {
    return undefined;
  }

  const targetTypeNode = getTailResolvedParameterTypeNode(
    context,
    callLike,
    expandedArgumentIndex,
    totalExpandedArgumentCount,
    hasIndeterminatePrefix,
    laterExpandedArgumentCount,
    1,
    0,
  );
  const explicitTypeArgumentNode = getExplicitTypeArgumentNodeForParameterTypeNode(
    context,
    callLike,
    targetTypeNode,
  );
  const contextualTargetType = targetTypeNode &&
      typeNodeContainsTypeParameterReference(context, targetTypeNode)
    ? getContextualArgumentType(context, callLike, argumentListIndex) ??
      context.checker.getContextualType(argument)
    : undefined;
  const effectiveTargetType = explicitTypeArgumentNode
    ? context.checker.getTypeFromTypeNode(explicitTypeArgumentNode)
    : contextualTargetType ?? targetType;
  const effectiveTargetTypeNode = explicitTypeArgumentNode ??
    (
      targetTypeNode &&
        typeNodeContainsTypeParameterReference(context, targetTypeNode)
        ? getSynthesizedRelationTypeNode(context, effectiveTargetType) ?? targetTypeNode
        : targetTypeNode
    );

  return {
    type: effectiveTargetType,
    typeNode: effectiveTargetTypeNode,
  };
}

function getTailResolvedParameterType(
  context: AnalysisContext,
  callLike: ts.CallExpression | ts.NewExpression,
  expandedArgumentIndex: number,
  totalExpandedArgumentCount: number | undefined,
  hasIndeterminatePrefix: boolean,
  laterExpandedArgumentCount: number | undefined,
  currentExpandedWidth: number,
  currentOffset: number,
): ts.Type | undefined {
  if (hasIndeterminatePrefix && laterExpandedArgumentCount !== undefined) {
    return getResolvedParameterTypeFromEnd(
      context,
      callLike,
      laterExpandedArgumentCount + (currentExpandedWidth - 1 - currentOffset),
    );
  }

  return getResolvedParameterType(
    context,
    callLike,
    expandedArgumentIndex + currentOffset,
    totalExpandedArgumentCount,
  );
}

function getContainingFunctionLike(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current)
    ) {
      return current;
    }
    current = current.parent;
  }

  return undefined;
}

function getFunctionReturnType(
  context: AnalysisContext,
  functionLike: ts.FunctionLikeDeclaration,
): ts.Type | undefined {
  const signature = context.checker.getSignatureFromDeclaration(functionLike);
  return signature ? context.checker.getReturnTypeOfSignature(signature) : undefined;
}

export function runRelationRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];
  const checkedVarianceSymbols = new Set<number>();

  context.forEachSourceFile((sourceFile) => {
    context.traverse(sourceFile, (node) => {
      try {
        if (
          (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
          (node.typeParameters?.length ?? 0) > 0 &&
          context.getAnnotationLookup(sourceFile).hasAttachedAnnotation(node, 'variance')
        ) {
          const symbol = context.checker.getSymbolAtLocation(node.name);
          if (symbol) {
            const symbolId = context.getSymbolId(symbol);
            if (!checkedVarianceSymbols.has(symbolId)) {
              checkedVarianceSymbols.add(symbolId);
              diagnostics.push(...collectVarianceAnnotationDiagnosticsForSymbol(context, symbol));
            }
          }
        }

        if (ts.isVariableDeclaration(node) && node.type && node.initializer) {
          const targetType = context.checker.getTypeFromTypeNode(node.type);
          checkUnsoundRelationAtExpression(
            context,
            diagnostics,
            node.name,
            node.initializer,
            targetType,
            node.type,
          );
          return;
        }

        if (ts.isVariableDeclaration(node) && node.initializer) {
          // fall through to regular relation checks below
        }

        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          if (isCallableMutationAssignmentTarget(context, node.left)) {
            return;
          }

          const targetType = context.checker.getTypeAtLocation(node.left);
          checkUnsoundRelationAtExpression(context, diagnostics, node.left, node.right, targetType);
          return;
        }

        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const exactExpandedArgumentCount = getExactExpandedArgumentCount(context, node);
          let expandedArgumentIndex = 0;
          const callArguments = nodeArguments(node);
          let hasIndeterminatePrefix = false;
          for (const [argumentListIndex, argument] of callArguments.entries()) {
            const laterExpandedArgumentCount = getExactExpandedArgumentCountForArguments(
              context,
              callArguments.slice(argumentListIndex + 1),
            );

            if (ts.isSpreadElement(argument)) {
              const literalElements = getSpreadLiteralElements(argument.expression);
              if (literalElements) {
                for (const [offset, element] of literalElements.entries()) {
                  const targetType = getTailResolvedParameterType(
                    context,
                    node,
                    expandedArgumentIndex,
                    exactExpandedArgumentCount,
                    hasIndeterminatePrefix,
                    laterExpandedArgumentCount,
                    literalElements.length,
                    offset,
                  );
                  if (!targetType) {
                    continue;
                  }

                  checkUnsoundRelationAtExpression(
                    context,
                    diagnostics,
                    argument,
                    element,
                    targetType,
                    getTailResolvedParameterTypeNode(
                      context,
                      node,
                      expandedArgumentIndex,
                      exactExpandedArgumentCount,
                      hasIndeterminatePrefix,
                      laterExpandedArgumentCount,
                      literalElements.length,
                      offset,
                    ),
                  );
                }
                expandedArgumentIndex += literalElements.length;
                continue;
              }

              const tupleType = getSpreadTupleType(context, argument.expression);
              if (tupleType) {
                const tupleShape = getTupleShape(context, tupleType);

                for (const [offset, sourceType] of tupleShape.prefixTypes.entries()) {
                  const targetType = tupleShape.restType === undefined
                    ? getTailResolvedParameterType(
                      context,
                      node,
                      expandedArgumentIndex,
                      exactExpandedArgumentCount,
                      hasIndeterminatePrefix,
                      laterExpandedArgumentCount,
                      tupleShape.prefixTypes.length,
                      offset,
                    )
                    : getResolvedParameterType(
                      context,
                      node,
                      expandedArgumentIndex + offset,
                      exactExpandedArgumentCount,
                    );
                  if (!targetType) {
                    continue;
                  }

                  checkUnsoundRelationAtType(
                    context,
                    diagnostics,
                    argument,
                    sourceType,
                    targetType,
                  );
                }

                if (tupleShape.restType) {
                  hasIndeterminatePrefix = true;
                  const targetType = getResolvedParameterType(
                    context,
                    node,
                    expandedArgumentIndex + tupleShape.fixedLength,
                    exactExpandedArgumentCount,
                  );
                  if (!targetType) {
                    continue;
                  }

                  checkUnsoundRelationAtType(
                    context,
                    diagnostics,
                    argument,
                    tupleShape.restType,
                    targetType,
                  );
                }

                if (laterExpandedArgumentCount !== undefined) {
                  for (
                    let suffixIndex = 0;
                    suffixIndex < tupleShape.suffixTypes.length;
                    suffixIndex += 1
                  ) {
                    const sourceType =
                      tupleShape.suffixTypes[tupleShape.suffixTypes.length - 1 - suffixIndex];
                    const targetType = getResolvedParameterTypeFromEnd(
                      context,
                      node,
                      laterExpandedArgumentCount + suffixIndex,
                    );
                    if (!targetType) {
                      continue;
                    }

                    checkUnsoundRelationAtType(
                      context,
                      diagnostics,
                      argument,
                      sourceType,
                      targetType,
                    );
                  }
                }

                expandedArgumentIndex += tupleShape.prefixTypes.length +
                  tupleShape.suffixTypes.length +
                  (tupleShape.restType ? 1 : 0);
                continue;
              }

              const targetType = getResolvedParameterType(
                context,
                node,
                expandedArgumentIndex,
                exactExpandedArgumentCount,
              );
              const resolvedParameter = getResolvedSignatureParameter(
                context,
                node,
                expandedArgumentIndex,
              );
              if (!targetType || resolvedParameter?.restOffset === undefined) {
                continue;
              }

              const arrayElementType = getSpreadArrayElementType(context, argument.expression);
              if (!arrayElementType) {
                hasIndeterminatePrefix = true;
                continue;
              }

              hasIndeterminatePrefix = true;
              checkUnsoundRelationAtType(
                context,
                diagnostics,
                argument,
                arrayElementType,
                targetType,
              );
              continue;
            }

            const effectiveTarget = getEffectiveArgumentRelationTarget(
              context,
              node,
              argument,
              argumentListIndex,
              expandedArgumentIndex,
              exactExpandedArgumentCount,
              hasIndeterminatePrefix,
              laterExpandedArgumentCount,
            );
            if (!effectiveTarget) {
              expandedArgumentIndex += 1;
              continue;
            }

            checkUnsoundRelationAtExpression(
              context,
              diagnostics,
              argument,
              argument,
              effectiveTarget.type,
              effectiveTarget.typeNode,
            );
            expandedArgumentIndex += 1;
          }
          return;
        }

        if (ts.isReturnStatement(node) && node.expression) {
          const functionLike = getContainingFunctionLike(node);
          if (!functionLike) {
            return;
          }

          const targetType = getFunctionReturnType(context, functionLike);
          if (!targetType) {
            return;
          }

          checkUnsoundRelationAtExpression(
            context,
            diagnostics,
            node.expression,
            node.expression,
            targetType,
            functionLike.type,
          );
          return;
        }

        if (
          (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
          node.body &&
          !ts.isBlock(node.body)
        ) {
          const targetType = getFunctionReturnType(context, node);
          if (!targetType) {
            return;
          }

          checkUnsoundRelationAtExpression(
            context,
            diagnostics,
            node.body,
            node.body,
            targetType,
            node.type,
          );
        }
      } catch (error) {
        if (isStackOverflowLikeError(error)) {
          return;
        }
        throw error;
      }
    });
  });

  return diagnostics;
}
