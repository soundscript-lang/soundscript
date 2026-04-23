import ts from 'typescript';

import { normalize, relative } from '../platform/path.ts';

export type SharedSemanticScalarKind =
  | 'undefined'
  | 'null'
  | 'boolean'
  | 'number'
  | 'string'
  | 'bigint'
  | 'symbol';

export type SharedSemanticTypeIR = SharedSemanticUnionBoundaryIR | SharedSemanticUnionArmIR;

export interface SharedSemanticObjectFieldIR {
  name: string;
  type: SharedSemanticTypeIR;
}

export interface SharedSemanticCallableSignatureIR {
  id: number;
  params: readonly SharedSemanticTypeIR[];
  result: SharedSemanticTypeIR;
}

export type SharedSemanticUnionArmIR =
  | { kind: 'union'; arms: readonly SharedSemanticUnionArmIR[] }
  | { kind: SharedSemanticScalarKind; owned?: boolean; deferred?: boolean }
  | {
    kind: 'object';
    layoutName?: string;
    dynamic?: boolean;
    fallback?: boolean;
    fields?: readonly SharedSemanticObjectFieldIR[];
  }
  | { kind: 'array'; element: SharedSemanticTypeIR; carrierType?: string }
  | { kind: 'map'; key: SharedSemanticTypeIR; value: SharedSemanticTypeIR }
  | { kind: 'set'; value: SharedSemanticTypeIR }
  | { kind: 'promise'; value?: SharedSemanticTypeIR }
  | {
    kind: 'generator';
    async: boolean;
    yield?: SharedSemanticTypeIR;
    return?: SharedSemanticTypeIR;
    next?: SharedSemanticTypeIR;
  }
  | {
    kind: 'closure';
    signatureIds?: readonly number[];
    signatures?: readonly SharedSemanticCallableSignatureIR[];
  }
  | { kind: 'class_constructor'; classTagId?: number; className?: string }
  | { kind: 'machine_numeric'; numericKind: string; deferred: true }
  | { kind: 'value_class'; name: string; deferred: true }
  | { kind: 'host_handle' };

export type NormalizedSharedSemanticUnionArmIR = Exclude<
  SharedSemanticUnionArmIR,
  { kind: 'union' }
>;

export interface SharedSemanticUnionBoundaryIR {
  kind: 'finite_union';
  arms: readonly NormalizedSharedSemanticUnionArmIR[];
}

export interface SharedSemanticFunctionTypeSnapshotIR {
  kind: 'function_type';
  fileName: string;
  name: string;
  exported: boolean;
  async: boolean;
  generator: boolean;
  params: readonly {
    name: string;
    type: SharedSemanticTypeIR;
  }[];
  result: SharedSemanticTypeIR;
}

export interface SharedSemanticTypeAliasSnapshotIR {
  kind: 'type_alias';
  fileName: string;
  name: string;
  type: SharedSemanticTypeIR;
}

export type SharedSemanticTypeSnapshotIR =
  | SharedSemanticFunctionTypeSnapshotIR
  | SharedSemanticTypeAliasSnapshotIR;

export interface SharedSemanticBoundarySurfaceIR {
  kind: 'function_boundary';
  direction: 'import' | 'export';
  fileName: string;
  path: string;
  name: string;
  params: readonly {
    name: string;
    type: SharedSemanticTypeIR;
  }[];
  result: SharedSemanticTypeIR;
}

export interface SharedSemanticObjectLayoutIR {
  name: string;
  family: 'specialized_object' | 'dynamic_object' | 'fallback_object';
  fields: readonly string[];
}

export interface SharedSemanticFactsIR {
  kind: 'shared_semantic_facts';
  typeSnapshots: readonly SharedSemanticTypeSnapshotIR[];
  boundarySurfaces: readonly SharedSemanticBoundarySurfaceIR[];
  objectLayouts: readonly SharedSemanticObjectLayoutIR[];
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const objectValue = value as Record<string, unknown>;
  return `{${
    Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
      .join(',')
  }}`;
}

function sharedTypeKey(type: SharedSemanticTypeIR): string {
  return stableStringify(type);
}

function isUndefinedType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Undefined) !== 0;
}

function isNullType(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Null) !== 0;
}

function isStringLikeType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) {
    return true;
  }
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.length > 0 &&
      (type as ts.UnionType).types.every((member) => isStringLikeType(member));
  }
  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.length > 0 &&
      (type as ts.IntersectionType).types.every((member) => isStringLikeType(member));
  }
  return false;
}

function isSymbolLikeType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
    return true;
  }
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.length > 0 &&
      (type as ts.UnionType).types.every((member) => isSymbolLikeType(member));
  }
  if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    return (type as ts.IntersectionType).types.length > 0 &&
      (type as ts.IntersectionType).types.every((member) => isSymbolLikeType(member));
  }
  return false;
}

function normalizeType(type: SharedSemanticTypeIR): SharedSemanticTypeIR {
  if (type.kind === 'finite_union') {
    return normalizeSharedSemanticUnionBoundary(type.arms);
  }
  if (type.kind === 'union') {
    return normalizeSharedSemanticUnionBoundary(type.arms);
  }
  if (type.kind === 'array') {
    return { ...type, element: normalizeType(type.element) };
  }
  if (type.kind === 'map') {
    return { ...type, key: normalizeType(type.key), value: normalizeType(type.value) };
  }
  if (type.kind === 'set') {
    return { ...type, value: normalizeType(type.value) };
  }
  if (type.kind === 'promise' && type.value) {
    return { ...type, value: normalizeType(type.value) };
  }
  if (type.kind === 'generator') {
    return {
      ...type,
      yield: type.yield ? normalizeType(type.yield) : undefined,
      return: type.return ? normalizeType(type.return) : undefined,
      next: type.next ? normalizeType(type.next) : undefined,
    };
  }
  if (type.kind === 'object' && type.fields) {
    return {
      ...type,
      fields: type.fields.map((field) => ({ ...field, type: normalizeType(field.type) })),
    };
  }
  if (type.kind === 'closure' && type.signatures) {
    return {
      ...type,
      signatures: type.signatures.map((signature) => ({
        ...signature,
        params: signature.params.map(normalizeType),
        result: normalizeType(signature.result),
      })),
    };
  }
  return type;
}

function pushNormalizedArm(
  armsByKey: Map<string, NormalizedSharedSemanticUnionArmIR>,
  arm: SharedSemanticUnionArmIR,
): void {
  if (arm.kind === 'union') {
    for (const nested of arm.arms) {
      pushNormalizedArm(armsByKey, nested);
    }
    return;
  }
  const normalized = normalizeType(arm) as NormalizedSharedSemanticUnionArmIR;
  armsByKey.set(sharedTypeKey(normalized), normalized);
}

export function normalizeSharedSemanticUnionBoundary(
  arms: readonly SharedSemanticUnionArmIR[],
): SharedSemanticUnionBoundaryIR {
  const armsByKey = new Map<string, NormalizedSharedSemanticUnionArmIR>();
  for (const arm of arms) {
    pushNormalizedArm(armsByKey, arm);
  }
  return {
    kind: 'finite_union',
    arms: [...armsByKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, arm]) => arm),
  };
}

interface SharedSemanticTypeClassifierState {
  checker: ts.TypeChecker;
  node: ts.Node;
  visiting: Set<string>;
  depth: number;
}

function typeReferenceArguments(
  checker: ts.TypeChecker,
  type: ts.Type,
): readonly ts.Type[] {
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    if (args.length > 0) {
      return args;
    }
  }
  const apparentType = checker.getApparentType(type);
  if ((apparentType.flags & ts.TypeFlags.Object) !== 0) {
    return checker.getTypeArguments(apparentType as ts.TypeReference);
  }
  return [];
}

function runtimeFamilySymbolName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const apparentType = checker.getApparentType(type);
  return apparentType.getSymbol()?.getName() ??
    type.getSymbol()?.getName() ??
    apparentType.aliasSymbol?.getName() ??
    type.aliasSymbol?.getName();
}

function declaredTypeName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const apparentType = checker.getApparentType(type);
  return type.getSymbol()?.getName() ??
    type.aliasSymbol?.getName() ??
    apparentType.getSymbol()?.getName() ??
    apparentType.aliasSymbol?.getName();
}

function objectLayoutName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName() ??
    checker.getApparentType(type).getSymbol()?.getName();
  return name === '__type' ? undefined : name;
}

function classifyArrayElementType(
  state: SharedSemanticTypeClassifierState,
  elementTypes: readonly ts.Type[],
): SharedSemanticTypeIR {
  if (elementTypes.length === 0) {
    return { kind: 'host_handle' };
  }
  if (elementTypes.length === 1) {
    return classifySharedSemanticTypeInner(state, elementTypes[0]);
  }
  return normalizeSharedSemanticUnionBoundary(
    elementTypes.map((elementType) =>
      classifySharedSemanticTypeInner(state, elementType) as SharedSemanticUnionArmIR
    ),
  );
}

function classifyCallableSignature(
  state: SharedSemanticTypeClassifierState,
  signature: ts.Signature,
  id: number,
): SharedSemanticCallableSignatureIR {
  const signatureNode = signature.getDeclaration() ?? state.node;
  return {
    id,
    params: signature.getParameters().map((param) =>
      classifySharedSemanticTypeInner(
        state,
        state.checker.getTypeOfSymbolAtLocation(param, signatureNode),
      )
    ),
    result: classifySharedSemanticTypeInner(
      state,
      state.checker.getReturnTypeOfSignature(signature),
    ),
  };
}

function classifyObjectFields(
  state: SharedSemanticTypeClassifierState,
  type: ts.Type,
): readonly SharedSemanticObjectFieldIR[] | undefined {
  const properties = state.checker.getPropertiesOfType(type)
    .filter((property) => property.getName() !== 'constructor')
    .sort((left, right) => left.getName().localeCompare(right.getName()));
  if (properties.length === 0) {
    return undefined;
  }
  return properties.map((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? state.node;
    return {
      name: property.getName(),
      type: classifySharedSemanticTypeInner(
        state,
        state.checker.getTypeOfSymbolAtLocation(property, declaration),
      ),
    };
  });
}

function classifySharedSemanticTypeInner(
  state: SharedSemanticTypeClassifierState,
  type: ts.Type,
): SharedSemanticTypeIR {
  const checker = state.checker;
  const constraint = checker.getBaseConstraintOfType(type);
  if (constraint && constraint !== type) {
    return classifySharedSemanticTypeInner(state, constraint);
  }

  if (isUndefinedType(type) || (type.flags & ts.TypeFlags.Void) !== 0) {
    return { kind: 'undefined' };
  }
  if (isNullType(type)) {
    return { kind: 'null' };
  }
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) {
    return { kind: 'boolean' };
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) {
    return { kind: 'number' };
  }
  if (isStringLikeType(type)) {
    return { kind: 'string' };
  }
  if ((type.flags & ts.TypeFlags.BigIntLike) !== 0) {
    return { kind: 'bigint' };
  }
  if (isSymbolLikeType(type)) {
    return { kind: 'symbol' };
  }

  if (type.isUnion()) {
    return normalizeSharedSemanticUnionBoundary(
      type.types.map((member) =>
        classifySharedSemanticTypeInner(state, member) as SharedSemanticUnionArmIR
      ),
    );
  }
  if (type.isIntersection()) {
    const members = type.types.map((member) => classifySharedSemanticTypeInner(state, member));
    const objectMembers = members.filter((
      member,
    ): member is Extract<SharedSemanticUnionArmIR, { kind: 'object' }> => member.kind === 'object');
    if (objectMembers.length === members.length) {
      return {
        kind: 'object',
        layoutName: objectMembers.map((member) => member.layoutName).filter(Boolean).join('&') ||
          undefined,
        fields: objectMembers.flatMap((member) => member.fields ?? []),
      };
    }
    return normalizeSharedSemanticUnionBoundary(members as readonly SharedSemanticUnionArmIR[]);
  }

  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return {
      kind: 'array',
      element: classifyArrayElementType(state, typeReferenceArguments(checker, type)),
    };
  }

  const symbolName = runtimeFamilySymbolName(checker, type);
  const typeArguments = typeReferenceArguments(checker, type);
  if (symbolName === 'Map' || symbolName === 'ReadonlyMap') {
    return {
      kind: 'map',
      key: typeArguments[0]
        ? classifySharedSemanticTypeInner(state, typeArguments[0])
        : { kind: 'host_handle' },
      value: typeArguments[1]
        ? classifySharedSemanticTypeInner(state, typeArguments[1])
        : { kind: 'host_handle' },
    };
  }
  if (symbolName === 'Set' || symbolName === 'ReadonlySet') {
    return {
      kind: 'set',
      value: typeArguments[0]
        ? classifySharedSemanticTypeInner(state, typeArguments[0])
        : { kind: 'host_handle' },
    };
  }
  if (symbolName === 'Promise' || symbolName === 'PromiseLike') {
    return {
      kind: 'promise',
      value: typeArguments[0]
        ? classifySharedSemanticTypeInner(state, typeArguments[0])
        : undefined,
    };
  }
  if (symbolName === 'Generator') {
    return {
      kind: 'generator',
      async: false,
      yield: typeArguments[0]
        ? classifySharedSemanticTypeInner(state, typeArguments[0])
        : undefined,
      return: typeArguments[1]
        ? classifySharedSemanticTypeInner(state, typeArguments[1])
        : undefined,
      next: typeArguments[2] ? classifySharedSemanticTypeInner(state, typeArguments[2]) : undefined,
    };
  }
  if (symbolName === 'AsyncGenerator') {
    return {
      kind: 'generator',
      async: true,
      yield: typeArguments[0]
        ? classifySharedSemanticTypeInner(state, typeArguments[0])
        : undefined,
      return: typeArguments[1]
        ? classifySharedSemanticTypeInner(state, typeArguments[1])
        : undefined,
      next: typeArguments[2] ? classifySharedSemanticTypeInner(state, typeArguments[2]) : undefined,
    };
  }

  const constructSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
  if (constructSignatures.length > 0) {
    return { kind: 'class_constructor', className: declaredTypeName(checker, type) };
  }

  const callSignatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  if (callSignatures.length > 0) {
    return {
      kind: 'closure',
      signatures: callSignatures.map((signature, id) =>
        classifyCallableSignature(state, signature, id)
      ),
    };
  }

  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return { kind: 'host_handle' };
  }

  const layoutName = objectLayoutName(checker, type);
  const visitKey = `${layoutName ?? checker.typeToString(type, state.node)}:${type.flags}`;
  if (state.depth >= 8 || state.visiting.has(visitKey)) {
    return { kind: 'object', layoutName };
  }
  state.visiting.add(visitKey);
  state.depth += 1;
  const fields = classifyObjectFields(state, type);
  state.depth -= 1;
  state.visiting.delete(visitKey);
  return { kind: 'object', layoutName, fields };
}

export function classifySharedSemanticType(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
): SharedSemanticTypeIR {
  return normalizeType(
    classifySharedSemanticTypeInner({
      checker,
      node,
      visiting: new Set(),
      depth: 0,
    }, type),
  );
}

function sourceFileBelongsToProject(sourceFile: ts.SourceFile, projectDirectory: string): boolean {
  const normalizedFileName = normalize(ts.sys.resolvePath(sourceFile.fileName));
  const normalizedProjectDirectory = normalize(ts.sys.resolvePath(projectDirectory));
  return normalizedFileName === normalizedProjectDirectory ||
    normalizedFileName.startsWith(`${normalizedProjectDirectory}/`);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function isExportedDeclaration(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function functionTypeSnapshot(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.FunctionDeclaration,
): SharedSemanticFunctionTypeSnapshotIR | undefined {
  const signature = checker.getSignatureFromDeclaration(node);
  if (!signature) {
    return undefined;
  }
  return {
    kind: 'function_type',
    fileName: sourceFile.fileName,
    name: node.name?.text ?? '<anonymous>',
    exported: isExportedDeclaration(node),
    async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    generator: node.asteriskToken !== undefined,
    params: node.parameters.map((param) => ({
      name: param.name.getText(sourceFile),
      type: classifySharedSemanticType(checker, checker.getTypeAtLocation(param), param),
    })),
    result: classifySharedSemanticType(checker, checker.getReturnTypeOfSignature(signature), node),
  };
}

function typeAliasSnapshot(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.TypeAliasDeclaration,
): SharedSemanticTypeAliasSnapshotIR {
  return {
    kind: 'type_alias',
    fileName: sourceFile.fileName,
    name: node.name.text,
    type: classifySharedSemanticType(checker, checker.getTypeAtLocation(node.type), node),
  };
}

function projectSourceFiles(
  program: ts.Program,
  projectDirectory: string,
  options?: { includeDeclarationFiles?: boolean },
): readonly ts.SourceFile[] {
  return program.getSourceFiles()
    .filter((sourceFile) =>
      (options?.includeDeclarationFiles || !sourceFile.isDeclarationFile) &&
      sourceFileBelongsToProject(sourceFile, projectDirectory)
    );
}

export function createSharedSemanticTypeSnapshotsFromProgram(
  program: ts.Program,
  projectDirectory: string,
): readonly SharedSemanticTypeSnapshotIR[] {
  const checker = program.getTypeChecker();
  return projectSourceFiles(program, projectDirectory)
    .flatMap((sourceFile) =>
      sourceFile.statements.flatMap((statement): SharedSemanticTypeSnapshotIR[] => {
        if (ts.isFunctionDeclaration(statement)) {
          const snapshot = functionTypeSnapshot(checker, sourceFile, statement);
          return snapshot ? [snapshot] : [];
        }
        if (ts.isTypeAliasDeclaration(statement)) {
          return [typeAliasSnapshot(checker, sourceFile, statement)];
        }
        return [];
      })
    );
}

function boundarySurfaceDirection(
  sourceFile: ts.SourceFile,
  node: ts.FunctionDeclaration,
): SharedSemanticBoundarySurfaceIR['direction'] | undefined {
  if (
    sourceFile.isDeclarationFile || hasModifier(node, ts.SyntaxKind.DeclareKeyword) || !node.body
  ) {
    return 'import';
  }
  return isExportedDeclaration(node) ? 'export' : undefined;
}

function createFunctionBoundarySurface(
  checker: ts.TypeChecker,
  projectDirectory: string,
  sourceFile: ts.SourceFile,
  node: ts.FunctionDeclaration,
): SharedSemanticBoundarySurfaceIR | undefined {
  const direction = boundarySurfaceDirection(sourceFile, node);
  const signature = checker.getSignatureFromDeclaration(node);
  if (!direction || !signature) {
    return undefined;
  }
  const params = node.parameters.map((param) => ({
    name: param.name.getText(sourceFile),
    type: classifySharedSemanticType(checker, checker.getTypeAtLocation(param), param),
  }));
  const result = classifySharedSemanticType(
    checker,
    checker.getReturnTypeOfSignature(signature),
    node,
  );
  return {
    kind: 'function_boundary',
    direction,
    fileName: sourceFile.fileName,
    path: relative(projectDirectory, sourceFile.fileName).replaceAll('\\', '/'),
    name: node.name?.text ?? '<anonymous>',
    params,
    result,
  };
}

export function createSharedSemanticBoundarySurfacesFromProgram(
  program: ts.Program,
  projectDirectory: string,
): readonly SharedSemanticBoundarySurfaceIR[] {
  const checker = program.getTypeChecker();
  return projectSourceFiles(program, projectDirectory, { includeDeclarationFiles: true })
    .flatMap((sourceFile) =>
      sourceFile.statements.flatMap((statement): SharedSemanticBoundarySurfaceIR[] => {
        if (!ts.isFunctionDeclaration(statement)) {
          return [];
        }
        const surface = createFunctionBoundarySurface(
          checker,
          projectDirectory,
          sourceFile,
          statement,
        );
        return surface ? [surface] : [];
      })
    )
    .sort((left, right) =>
      left.direction === right.direction
        ? left.fileName === right.fileName
          ? left.name.localeCompare(right.name)
          : left.fileName.localeCompare(right.fileName)
        : left.direction === 'import'
        ? -1
        : 1
    );
}

function objectLayoutNameForBoundary(
  boundary: Extract<SharedSemanticUnionArmIR, { kind: 'object' }>,
): string {
  if (boundary.layoutName) {
    return boundary.layoutName;
  }
  return `object:${(boundary.fields ?? []).map((field) => field.name).join(',')}`;
}

function collectSharedSemanticObjectLayoutsFromType(
  layoutsByKey: Map<string, SharedSemanticObjectLayoutIR>,
  boundary: SharedSemanticTypeIR,
): void {
  if (boundary.kind === 'finite_union') {
    boundary.arms.forEach((arm) => collectSharedSemanticObjectLayoutsFromType(layoutsByKey, arm));
    return;
  }
  switch (boundary.kind) {
    case 'union':
      boundary.arms.forEach((arm) => collectSharedSemanticObjectLayoutsFromType(layoutsByKey, arm));
      break;
    case 'array':
      collectSharedSemanticObjectLayoutsFromType(layoutsByKey, boundary.element);
      break;
    case 'map':
      collectSharedSemanticObjectLayoutsFromType(layoutsByKey, boundary.key);
      collectSharedSemanticObjectLayoutsFromType(layoutsByKey, boundary.value);
      break;
    case 'set':
      collectSharedSemanticObjectLayoutsFromType(layoutsByKey, boundary.value);
      break;
    case 'promise':
      if (boundary.value) {
        collectSharedSemanticObjectLayoutsFromType(layoutsByKey, boundary.value);
      }
      break;
    case 'generator':
      if (boundary.yield) {
        collectSharedSemanticObjectLayoutsFromType(layoutsByKey, boundary.yield);
      }
      if (boundary.return) {
        collectSharedSemanticObjectLayoutsFromType(layoutsByKey, boundary.return);
      }
      if (boundary.next) {
        collectSharedSemanticObjectLayoutsFromType(layoutsByKey, boundary.next);
      }
      break;
    case 'closure':
      boundary.signatures?.forEach((signature) => {
        signature.params.forEach((param) =>
          collectSharedSemanticObjectLayoutsFromType(layoutsByKey, param)
        );
        collectSharedSemanticObjectLayoutsFromType(layoutsByKey, signature.result);
      });
      break;
    case 'object': {
      const name = objectLayoutNameForBoundary(boundary);
      const layout: SharedSemanticObjectLayoutIR = {
        name,
        family: boundary.dynamic
          ? 'dynamic_object'
          : boundary.fallback
          ? 'fallback_object'
          : 'specialized_object',
        fields: (boundary.fields ?? []).map((field) => field.name),
      };
      layoutsByKey.set(`${layout.family}:${layout.name}:${layout.fields.join(',')}`, layout);
      boundary.fields?.forEach((field) =>
        collectSharedSemanticObjectLayoutsFromType(layoutsByKey, field.type)
      );
      break;
    }
    case 'undefined':
    case 'null':
    case 'boolean':
    case 'number':
    case 'string':
    case 'bigint':
    case 'symbol':
    case 'class_constructor':
    case 'machine_numeric':
    case 'value_class':
    case 'host_handle':
      break;
    default: {
      const exhaustiveCheck: never = boundary;
      return exhaustiveCheck;
    }
  }
}

export function collectSharedSemanticObjectLayoutsFromTypes(
  types: readonly SharedSemanticTypeIR[],
): readonly SharedSemanticObjectLayoutIR[] {
  const layoutsByKey = new Map<string, SharedSemanticObjectLayoutIR>();
  types.forEach((type) => collectSharedSemanticObjectLayoutsFromType(layoutsByKey, type));
  return [...layoutsByKey.values()].sort((left, right) =>
    left.family === right.family
      ? left.name.localeCompare(right.name)
      : left.family.localeCompare(right.family)
  );
}

export function createSharedSemanticFactsFromProgram(
  program: ts.Program,
  projectDirectory: string,
): SharedSemanticFactsIR {
  const typeSnapshots = createSharedSemanticTypeSnapshotsFromProgram(program, projectDirectory);
  const boundarySurfaces = createSharedSemanticBoundarySurfacesFromProgram(
    program,
    projectDirectory,
  );
  const typeSnapshotTypes = typeSnapshots.flatMap((snapshot) =>
    snapshot.kind === 'type_alias' ? [snapshot.type] : [
      ...snapshot.params.map((param) => param.type),
      snapshot.result,
    ]
  );
  const objectLayouts = collectSharedSemanticObjectLayoutsFromTypes([
    ...typeSnapshotTypes,
    ...boundarySurfaces.flatMap((surface) => [
      ...surface.params.map((param) => param.type),
      surface.result,
    ]),
  ]);
  return {
    kind: 'shared_semantic_facts',
    typeSnapshots,
    boundarySurfaces,
    objectLayouts,
  };
}
