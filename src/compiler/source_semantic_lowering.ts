import type { CompilerValueType } from './ir.ts';
import type {
  SourceBindingIR,
  SourceClassIR,
  SourceClassMemberIR,
  SourceExpressionIR,
  SourceFunctionIR,
  SourceModuleIR,
  SourceStatementIR,
  SourceVariableDeclarationStatementIR,
} from './source_hir.ts';
import {
  collectSemanticRuntimeFamiliesFromTypes,
  type SemanticBoundarySurfaceIR,
  type SemanticClosureSignatureIR,
  type SemanticExpressionIR,
  type SemanticFunctionIR,
  type SemanticModuleIR,
  type SemanticObjectLayoutIR,
  type SemanticRuntimeFamilyId,
  type SemanticStatementIR,
  type SemanticTypeIR,
} from './semantic_ir.ts';
import type {
  SharedSemanticFactsIR,
  SharedSemanticFunctionTypeSnapshotIR,
  SharedSemanticLocalTypeSnapshotIR,
} from '../semantic/shared_semantic_facts.ts';
import {
  compilerValueTypeForStorage,
  selectWasmGcStorage,
  valueBoundaryFromSemanticType,
} from './value_boundary_ir.ts';

const SOUNDSCRIPT_BUILTIN_ERROR_INTERNAL_BRAND_KEY = '__ss_error_brand';
const BUILTIN_ERROR_CONSTRUCTOR_NAMES = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

interface SourceSemanticFunctionSignature {
  boundary?: SemanticBoundarySurfaceIR;
  params: readonly {
    name: string;
    type: SemanticTypeIR;
  }[];
  result: SemanticTypeIR;
}

interface SourceSemanticObjectLocal {
  family: 'specialized_object' | 'fallback_object' | 'dynamic_object';
  representationName: string;
  className?: string;
  dynamicValueRepresentation?: CompilerValueType;
  fields: readonly {
    name: string;
    representation: CompilerValueType;
  }[];
}

const SOUNDSCRIPT_PROMISE_RESOLVE_HELPER_NAME = '__soundscript_promise_resolve';
const SOUNDSCRIPT_PROMISE_REJECT_HELPER_NAME = '__soundscript_promise_reject';
const SOUNDSCRIPT_PROMISE_THEN_HELPER_NAME = '__soundscript_promise_then';
const SOUNDSCRIPT_PROMISE_NEW_PENDING_HELPER_NAME = '__soundscript_promise_new_pending';
const SOUNDSCRIPT_PROMISE_RESOLVE_INTO_HELPER_NAME = '__soundscript_promise_resolve_into';
const SOUNDSCRIPT_PROMISE_REJECT_INTO_HELPER_NAME = '__soundscript_promise_reject_into';

interface SourceSemanticArrayLocal {
  elementRepresentation: CompilerValueType;
}

interface SourceSemanticMapLocal {
  valueType: SemanticTypeIR;
  valueRepresentation: CompilerValueType;
}

type SourceSemanticSetValuesArrayType = Extract<
  SemanticStatementIR,
  { kind: 'set_new' }
>['valuesArrayType'];

type SourceSemanticSetValuesElementType = Extract<
  SemanticStatementIR,
  { kind: 'set_new' }
>['valuesElementType'];

interface SourceSemanticSetLocal {
  valueType: SemanticTypeIR;
  valueRepresentation: CompilerValueType;
  valuesArrayType: SourceSemanticSetValuesArrayType;
  valuesElementType: SourceSemanticSetValuesElementType;
}

interface SourceSemanticClosureLocal {
  resultRepresentation: CompilerValueType;
  signatureId: number;
}

interface SourceSemanticConstructorLocal {
  className: string;
}

interface SourceSemanticThrowTarget {
  thrownFlagName: string;
  thrownHeapName: string;
  thrownValueName: string;
}

interface SourceSemanticCompletionTarget {
  returnFlagName?: string;
  returnValueName?: string;
  returnRepresentation?: CompilerValueType;
  breakFlagName?: string;
  continueFlagName?: string;
}

type SourceSemanticLocalDeclarationKind = 'const' | 'let' | 'var' | 'param' | 'capture';

interface SourceSemanticModuleLoweringState {
  closureSignatures: SemanticClosureSignatureIR[];
  closureSignaturesByKey: Map<string, SemanticClosureSignatureIR>;
  generatedFunctions: SemanticFunctionIR[];
  nextClosureFunctionId: number;
  nextClosureSignatureId: number;
}

interface FunctionLoweringContext {
  functionName: string;
  asyncFunction: boolean;
  currentResultType?: SemanticTypeIR;
  functionResultArrayLocals: Map<string, SourceSemanticArrayLocal>;
  functionParamTypes: Map<string, readonly SemanticTypeIR[]>;
  functionResultRepresentations: Map<string, CompilerValueType>;
  functionResultTypes: Map<string, SemanticTypeIR>;
  localRepresentations: Map<string, CompilerValueType>;
  locals: { name: string; representation: CompilerValueType }[];
  arrayLocals: Map<string, SourceSemanticArrayLocal>;
  boxedLocals: Map<string, CompilerValueType>;
  closureLocals: Map<string, SourceSemanticClosureLocal>;
  constructorLocals: Map<string, SourceSemanticConstructorLocal>;
  localDeclarationKinds: Map<string, SourceSemanticLocalDeclarationKind>;
  localTypesByKey: Map<string, SemanticTypeIR>;
  mapLocals: Map<string, SourceSemanticMapLocal>;
  moduleState: SourceSemanticModuleLoweringState;
  objectLayoutsByKey: Map<string, SemanticObjectLayoutIR>;
  objectLocals: Map<string, SourceSemanticObjectLocal>;
  setLocals: Map<string, SourceSemanticSetLocal>;
  unionLocals: Map<string, SemanticTypeIR>;
  classesByName: ReadonlyMap<string, SourceClassIR>;
  pendingStatements: SemanticStatementIR[];
  runtimeFamilies: Set<SemanticRuntimeFamilyId>;
  stringLiteralIds: Map<string, number>;
  stringLiterals: string[];
  switchBreakLocalStack: string[];
  throwTargets: SourceSemanticThrowTarget[];
  completionTargets: SourceSemanticCompletionTarget[];
  tempIndex: number;
  unsupportedKinds: Set<string>;
}

function arrayElementRepresentationForSemanticType(type: SemanticTypeIR): CompilerValueType {
  return representationForSemanticType(type);
}

function arrayRepresentationForSemanticType(
  type: Extract<SemanticTypeIR, { kind: 'array' }>,
): CompilerValueType {
  switch (type.element.kind) {
    case 'number':
      return 'owned_number_array_ref';
    case 'boolean':
      return 'owned_boolean_array_ref';
    case 'string':
      return 'owned_array_ref';
    case 'undefined':
    case 'null':
    case 'finite_union':
    case 'union':
      return 'owned_tagged_array_ref';
    default:
      return 'owned_heap_array_ref';
  }
}

type PromiseAllSupportedArrayValueType =
  | 'owned_heap_array_ref'
  | 'owned_array_ref'
  | 'owned_number_array_ref'
  | 'owned_boolean_array_ref'
  | 'owned_tagged_array_ref';

function arrayLocalInfoForSemanticType(type: SemanticTypeIR): SourceSemanticArrayLocal | undefined {
  if (type.kind !== 'array') {
    return undefined;
  }
  return {
    elementRepresentation: arrayElementRepresentationForSemanticType(type.element),
  };
}

function mapLocalInfoForSemanticType(
  type: SemanticTypeIR | undefined,
): SourceSemanticMapLocal | undefined {
  if (!type || type.kind !== 'map' || type.key.kind !== 'string') {
    return undefined;
  }
  return {
    valueType: type.value,
    valueRepresentation: compilerValueTypeForStorage(
      selectWasmGcStorage(valueBoundaryFromSemanticType(type.value)),
    ),
  };
}

function setLocalInfoForSemanticType(
  type: SemanticTypeIR | undefined,
): SourceSemanticSetLocal | undefined {
  if (!type || type.kind !== 'set') {
    return undefined;
  }
  const valueStorage = selectWasmGcStorage(valueBoundaryFromSemanticType(type.value));
  const valueRepresentation = compilerValueTypeForStorage(valueStorage);
  const valuesArrayType: SourceSemanticSetValuesArrayType = valueRepresentation === 'f64'
    ? 'owned_number_array_ref'
    : valueRepresentation === 'i32'
    ? 'owned_boolean_array_ref'
    : valueRepresentation === 'owned_string_ref'
    ? 'owned_array_ref'
    : 'owned_tagged_array_ref';
  const valuesElementType: SourceSemanticSetValuesElementType = valueRepresentation === 'f64' ||
      valueRepresentation === 'i32' ||
      valueRepresentation === 'owned_string_ref'
    ? valueRepresentation
    : 'tagged_ref';
  return {
    valueType: type.value,
    valueRepresentation,
    valuesArrayType,
    valuesElementType,
  };
}

function representationForSemanticType(type: SemanticTypeIR): CompilerValueType {
  switch (type.kind) {
    case 'boolean':
      return 'i32';
    case 'number':
      return 'f64';
    case 'string':
      return 'owned_string_ref';
    case 'symbol':
      return 'symbol_ref';
    case 'bigint':
      return 'bigint_ref';
    case 'undefined':
    case 'null':
    case 'finite_union':
      return 'tagged_ref';
    case 'array':
      return arrayRepresentationForSemanticType(type);
    case 'object':
    case 'map':
    case 'set':
    case 'promise':
    case 'generator':
    case 'host_handle':
      return 'heap_ref';
    case 'closure':
      return 'closure_ref';
    case 'class_constructor':
      return 'class_constructor_ref';
    case 'machine_numeric':
    case 'value_class':
      return 'tagged_ref';
    case 'union':
      return 'tagged_ref';
    default: {
      const exhaustiveCheck: never = type;
      return exhaustiveCheck;
    }
  }
}

function isFiniteUnionSemanticType(type: SemanticTypeIR | undefined): boolean {
  return type?.kind === 'finite_union' || type?.kind === 'union';
}

function taggedUnionExpressionForValue(
  value: SemanticExpressionIR,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (value.representation === 'tagged_ref') {
    context.runtimeFamilies.add('finite_union');
    return value;
  }
  context.runtimeFamilies.add('finite_union');
  switch (value.representation) {
    case 'f64':
      return { kind: 'tag_number', value, representation: 'tagged_ref' };
    case 'i32':
      return { kind: 'tag_boolean', value, representation: 'tagged_ref' };
    case 'owned_string_ref':
      context.runtimeFamilies.add('string');
      return { kind: 'tag_string', value, representation: 'tagged_ref' };
    case 'symbol_ref':
      context.runtimeFamilies.add('symbol');
      return { kind: 'tag_symbol', value, representation: 'tagged_ref' };
    case 'bigint_ref':
      context.runtimeFamilies.add('bigint');
      return { kind: 'tag_bigint', value, representation: 'tagged_ref' };
    case 'heap_ref':
    case 'owned_number_array_ref':
    case 'owned_boolean_array_ref':
    case 'owned_array_ref':
    case 'owned_heap_array_ref':
    case 'owned_tagged_array_ref':
    case 'closure_ref':
    case 'class_constructor_ref':
      return { kind: 'tag_heap_object', value, representation: 'tagged_ref' };
    default:
      return undefined;
  }
}

function untagUnionExpressionForRepresentation(
  value: SemanticExpressionIR,
  representation: CompilerValueType,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (value.representation !== 'tagged_ref') {
    return value.representation === representation ? value : undefined;
  }
  context.runtimeFamilies.add('finite_union');
  switch (representation) {
    case 'f64':
      return { kind: 'untag_number', value, representation: 'f64' };
    case 'i32':
      return { kind: 'untag_boolean', value, representation: 'i32' };
    case 'owned_string_ref':
      context.runtimeFamilies.add('string');
      return { kind: 'untag_owned_string', value, representation: 'owned_string_ref' };
    case 'symbol_ref':
      context.runtimeFamilies.add('symbol');
      return { kind: 'untag_symbol', value, representation: 'symbol_ref' };
    case 'bigint_ref':
      context.runtimeFamilies.add('bigint');
      return { kind: 'untag_bigint', value, representation: 'bigint_ref' };
    case 'heap_ref':
    case 'owned_number_array_ref':
    case 'owned_boolean_array_ref':
    case 'owned_array_ref':
    case 'owned_heap_array_ref':
    case 'owned_tagged_array_ref':
    case 'closure_ref':
    case 'class_constructor_ref':
      return { kind: 'untag_heap_object', value, representation };
    default:
      return undefined;
  }
}

function adaptExpressionToSemanticType(
  value: SemanticExpressionIR,
  targetType: SemanticTypeIR | undefined,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (!targetType) {
    return value;
  }
  if (isFiniteUnionSemanticType(targetType)) {
    return taggedUnionExpressionForValue(value, context);
  }
  const targetRepresentation = representationForSemanticType(targetType);
  if (value.representation === targetRepresentation) {
    return value;
  }
  return untagUnionExpressionForRepresentation(value, targetRepresentation, context);
}

function promiseValueTypeForSemanticType(
  type: SemanticTypeIR | undefined,
): SemanticTypeIR | undefined {
  return type?.kind === 'promise' ? type.value : undefined;
}

function promiseReactionTaggedValueType(): SemanticTypeIR {
  return { kind: 'finite_union', arms: [] };
}

function promiseReactionClosureType(paramCount: number): SemanticTypeIR {
  const taggedValue = promiseReactionTaggedValueType();
  return {
    kind: 'closure',
    signatures: [{
      id: 0,
      params: Array.from({ length: paramCount }, () => taggedValue),
      result: taggedValue,
    }],
  };
}

function promiseResolveExpressionForValue(
  rawValue: SemanticExpressionIR,
  promiseValueType: SemanticTypeIR | undefined,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  const value = adaptExpressionToSemanticType(rawValue, promiseValueType, context) ?? rawValue;
  const taggedValue = taggedUnionExpressionForValue(value, context);
  if (!taggedValue) {
    return undefined;
  }
  context.runtimeFamilies.add('promise');
  return {
    kind: 'call',
    callee: SOUNDSCRIPT_PROMISE_RESOLVE_HELPER_NAME,
    args: [taggedValue],
    representation: 'heap_ref',
  };
}

function projectObjectExpressionToSemanticType(
  source: SourceExpressionIR,
  value: SemanticExpressionIR,
  targetType: SemanticTypeIR | undefined,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (!targetType || targetType.kind !== 'object' || value.representation !== 'heap_ref') {
    return undefined;
  }
  const sourceLayout = objectLocalInfoForRead(source, value, context);
  const targetLayout = objectLocalForParameterType(targetType, context);
  if (!sourceLayout || !targetLayout || targetLayout.className) {
    return undefined;
  }
  if (
    sourceLayout.family === targetLayout.family &&
    sourceLayout.representationName === targetLayout.representationName
  ) {
    return value;
  }
  if (targetLayout.family !== 'specialized_object' && targetLayout.family !== 'fallback_object') {
    context.unsupportedKinds.add('object_projection_dynamic_target');
    return undefined;
  }
  for (const field of targetLayout.fields) {
    const sourceField = sourceLayout.fields.find((candidate) => candidate.name === field.name);
    if (!sourceField || sourceField.representation !== field.representation) {
      context.unsupportedKinds.add(`object_projection:${field.name}`);
      return undefined;
    }
  }

  const sourceObject = materializeObjectExpressionForRead(
    value,
    sourceLayout,
    context,
    'object_projection_source',
  );
  const statements: SemanticStatementIR[] = [...sourceObject.statements];
  const fieldValueNames: string[] = [];
  for (const field of targetLayout.fields) {
    const fieldRead = objectPropertyReadValueFromLocal(
      sourceObject.objectName,
      field.name,
      sourceLayout,
      context,
    );
    if (!fieldRead || fieldRead.value.representation !== field.representation) {
      context.unsupportedKinds.add(`object_projection:${field.name}`);
      return undefined;
    }
    statements.push(...fieldRead.statements);
    fieldValueNames.push(fieldRead.value.name);
  }

  const targetName = nextTempLocalName(context, 'object_projection');
  addLocal(context, targetName, 'heap_ref');
  context.objectLocals.set(targetName, targetLayout);
  if (targetLayout.family === 'specialized_object') {
    statements.push({
      kind: 'specialized_object_new',
      targetName,
      representationName: targetLayout.representationName,
      fieldValueNames,
    });
  } else {
    statements.push({
      kind: 'fallback_object_new',
      targetName,
      representationName: targetLayout.representationName,
      entries: targetLayout.fields.map((field, index) => ({
        key: field.name,
        valueName: fieldValueNames[index]!,
        valueType: field.representation,
      })),
    });
  }
  context.pendingStatements.push(...statements);
  return { kind: 'local_get', name: targetName, representation: 'heap_ref' };
}

function lowerPromiseReactionHandlerExpression(
  expression: SourceExpressionIR | undefined,
  context: FunctionLoweringContext,
): SemanticExpressionIR {
  if (!expression) {
    return { kind: 'closure_null', representation: 'closure_ref' };
  }
  if (expression.kind === 'arrow_function') {
    const closure = lowerArrowFunctionExpression(
      expression,
      promiseReactionClosureType(expression.params.length),
      context,
    );
    if (closure) {
      return closure;
    }
    return { kind: 'closure_null', representation: 'closure_ref' };
  }
  const value = lowerExpression(expression, context);
  if (value.representation === 'closure_ref') {
    return value;
  }
  context.unsupportedKinds.add('Promise.then:handler');
  return { kind: 'closure_null', representation: 'closure_ref' };
}

function promiseFinallyHandlerFromCapture(): SemanticExpressionIR {
  return {
    kind: 'box_get',
    box: localGetExpression('capture_handler_0', 'box_ref'),
    valueType: 'closure_ref',
    representation: 'closure_ref',
  };
}

function promiseFinallyHandlerCapture(
  handler: Extract<SemanticExpressionIR, { kind: 'closure_literal' }>,
): Extract<SemanticExpressionIR, { kind: 'box_new' }> {
  return {
    kind: 'box_new',
    value: handler,
    valueType: 'closure_ref',
    representation: 'box_ref',
  };
}

function pushPromiseFinallyFulfilledClosure(
  context: FunctionLoweringContext,
  signatureId: number,
  handler: Extract<SemanticExpressionIR, { kind: 'closure_literal' }>,
): number {
  const closureFunctionId = context.moduleState.nextClosureFunctionId;
  context.moduleState.nextClosureFunctionId += 1;
  context.moduleState.generatedFunctions.push({
    name: `closure_source_promise_finally_fulfilled_${closureFunctionId}`,
    exportName: '',
    params: [
      { name: 'capture_handler_0', representation: 'box_ref' },
      { name: 'promise_value', representation: 'tagged_ref' },
    ],
    locals: [],
    result: 'tagged_ref',
    body: [
      {
        kind: 'expression',
        value: {
          kind: 'closure_call',
          callee: promiseFinallyHandlerFromCapture(),
          args: [],
          signatureId: handler.signatureId,
          representation: 'tagged_ref',
        },
      },
      { kind: 'return', value: localGetExpression('promise_value', 'tagged_ref') },
    ],
    bodyStatus: 'emittable',
    unsupportedBodyKinds: [],
    runtimeFamilies: ['closure', 'finite_union'],
    hostImported: false,
    hostExported: false,
    unionBoundaries: [],
    closureFunctionId,
    closureSignatureId: signatureId,
    closureCaptureCount: 1,
    closureCaptureValueTypes: ['closure_ref'],
  });
  return closureFunctionId;
}

function pushPromiseFinallyRejectedClosure(
  context: FunctionLoweringContext,
  signatureId: number,
  handler: Extract<SemanticExpressionIR, { kind: 'closure_literal' }>,
): number {
  const closureFunctionId = context.moduleState.nextClosureFunctionId;
  context.moduleState.nextClosureFunctionId += 1;
  context.moduleState.generatedFunctions.push({
    name: `closure_source_promise_finally_rejected_${closureFunctionId}`,
    exportName: '',
    params: [
      { name: 'capture_handler_0', representation: 'box_ref' },
      { name: 'promise_reason', representation: 'tagged_ref' },
    ],
    locals: [],
    result: 'tagged_ref',
    body: [
      {
        kind: 'expression',
        value: {
          kind: 'closure_call',
          callee: promiseFinallyHandlerFromCapture(),
          args: [],
          signatureId: handler.signatureId,
          representation: 'tagged_ref',
        },
      },
      {
        kind: 'return',
        value: {
          kind: 'tag_heap_object',
          value: {
            kind: 'call',
            callee: SOUNDSCRIPT_PROMISE_REJECT_HELPER_NAME,
            args: [localGetExpression('promise_reason', 'tagged_ref')],
            representation: 'heap_ref',
          },
          representation: 'tagged_ref',
        },
      },
    ],
    bodyStatus: 'emittable',
    unsupportedBodyKinds: [],
    runtimeFamilies: ['closure', 'finite_union', 'promise'],
    hostImported: false,
    hostExported: false,
    unionBoundaries: [],
    closureFunctionId,
    closureSignatureId: signatureId,
    closureCaptureCount: 1,
    closureCaptureValueTypes: ['closure_ref'],
  });
  return closureFunctionId;
}

function lowerPromiseThenCallExpression(
  expression: Extract<SourceExpressionIR, { kind: 'call_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (
    expression.callee.kind !== 'property_access' ||
    (
      expression.callee.property !== 'then' &&
      expression.callee.property !== 'catch' &&
      expression.callee.property !== 'finally'
    )
  ) {
    return undefined;
  }
  const methodName = expression.callee.property;
  const aritySupported = methodName === 'then'
    ? expression.args.length >= 1 && expression.args.length <= 2
    : expression.args.length === 1;
  if (!aritySupported) {
    context.unsupportedKinds.add(`Promise.${methodName}:arity`);
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }
  const receiver = lowerExpression(expression.callee.object, context);
  if (receiver.representation !== 'heap_ref') {
    context.unsupportedKinds.add(`Promise.${methodName}:receiver`);
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }
  let onFulfilled: SemanticExpressionIR;
  let onRejected: SemanticExpressionIR;
  if (methodName === 'then') {
    onFulfilled = lowerPromiseReactionHandlerExpression(expression.args[0], context);
    onRejected = lowerPromiseReactionHandlerExpression(expression.args[1], context);
  } else if (methodName === 'catch') {
    onFulfilled = lowerPromiseReactionHandlerExpression(undefined, context);
    onRejected = lowerPromiseReactionHandlerExpression(expression.args[0], context);
  } else {
    const onFinally = lowerPromiseReactionHandlerExpression(expression.args[0], context);
    if (onFinally.kind !== 'closure_literal') {
      context.unsupportedKinds.add('Promise.finally:handler');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    const taggedValue = promiseReactionTaggedValueType();
    const closureSignature = createClosureSignature(
      context.moduleState,
      [taggedValue],
      taggedValue,
    );
    const fulfilledFunctionId = pushPromiseFinallyFulfilledClosure(
      context,
      closureSignature.id,
      onFinally,
    );
    const rejectedFunctionId = pushPromiseFinallyRejectedClosure(
      context,
      closureSignature.id,
      onFinally,
    );
    const handlerCapture = promiseFinallyHandlerCapture(onFinally);
    onFulfilled = {
      kind: 'closure_literal',
      functionId: fulfilledFunctionId,
      signatureId: closureSignature.id,
      captures: [handlerCapture],
      captureValueTypes: ['closure_ref'],
      representation: 'closure_ref',
    };
    onRejected = {
      kind: 'closure_literal',
      functionId: rejectedFunctionId,
      signatureId: closureSignature.id,
      captures: [handlerCapture],
      captureValueTypes: ['closure_ref'],
      representation: 'closure_ref',
    };
  }
  context.runtimeFamilies.add('promise');
  context.runtimeFamilies.add('closure');
  context.runtimeFamilies.add('finite_union');
  return {
    kind: 'call',
    callee: SOUNDSCRIPT_PROMISE_THEN_HELPER_NAME,
    args: [receiver, onFulfilled, onRejected],
    representation: 'heap_ref',
  };
}

function lowerPromiseRaceCallExpression(
  expression: Extract<SourceExpressionIR, { kind: 'call_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (
    expression.callee.kind !== 'property_access' ||
    expression.callee.object.kind !== 'identifier' ||
    expression.callee.object.name !== 'Promise' ||
    expression.callee.property !== 'race'
  ) {
    return undefined;
  }
  if (expression.args.length !== 1) {
    context.unsupportedKinds.add('Promise.race:arity');
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }
  const [raceSource] = expression.args;
  if (raceSource?.kind !== 'array_literal') {
    context.unsupportedKinds.add('Promise.race:source');
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }

  const taggedValue = promiseReactionTaggedValueType();
  const closureSignature = raceSource.elements.length > 0
    ? createClosureSignature(context.moduleState, [taggedValue], taggedValue)
    : undefined;
  const fulfilledFunctionId = closureSignature
    ? pushPromiseResolveIntoClosure(context, closureSignature.id)
    : undefined;
  const rejectedFunctionId = closureSignature
    ? pushPromiseRejectIntoClosure(context, closureSignature.id)
    : undefined;
  const targetPromiseName = nextTempLocalName(context, 'promise_race_target');
  addLocal(context, targetPromiseName, 'heap_ref');
  const statements: SemanticStatementIR[] = [{
    kind: 'local_set',
    name: targetPromiseName,
    value: {
      kind: 'call',
      callee: SOUNDSCRIPT_PROMISE_NEW_PENDING_HELPER_NAME,
      args: [],
      representation: 'heap_ref',
    },
  }];

  for (const element of raceSource.elements) {
    const source = lowerExpression(element, context);
    const sourceStatements = takePendingStatements(context);
    if (
      source.representation !== 'heap_ref' ||
      !closureSignature ||
      fulfilledFunctionId === undefined ||
      rejectedFunctionId === undefined
    ) {
      context.unsupportedKinds.add('Promise.race:element');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    const sourceName = nextTempLocalName(context, 'promise_race_source');
    addLocal(context, sourceName, 'heap_ref');
    const targetCapture = promiseTargetCapture(targetPromiseName);
    statements.push(
      ...sourceStatements,
      { kind: 'local_set', name: sourceName, value: source },
      {
        kind: 'expression',
        value: {
          kind: 'call',
          callee: SOUNDSCRIPT_PROMISE_THEN_HELPER_NAME,
          args: [
            localGetExpression(sourceName, 'heap_ref'),
            {
              kind: 'closure_literal',
              functionId: fulfilledFunctionId,
              signatureId: closureSignature.id,
              captures: [targetCapture],
              captureValueTypes: ['tagged_ref'],
              representation: 'closure_ref',
            },
            {
              kind: 'closure_literal',
              functionId: rejectedFunctionId,
              signatureId: closureSignature.id,
              captures: [targetCapture],
              captureValueTypes: ['tagged_ref'],
              representation: 'closure_ref',
            },
          ],
          representation: 'heap_ref',
        },
      },
    );
  }

  context.pendingStatements.push(...statements);
  context.runtimeFamilies.add('promise');
  if (raceSource.elements.length > 0) {
    context.runtimeFamilies.add('closure');
    context.runtimeFamilies.add('finite_union');
  }
  return localGetExpression(targetPromiseName, 'heap_ref');
}

function lowerPromiseAllCallExpression(
  expression: Extract<SourceExpressionIR, { kind: 'call_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (
    expression.callee.kind !== 'property_access' ||
    expression.callee.object.kind !== 'identifier' ||
    expression.callee.object.name !== 'Promise' ||
    expression.callee.property !== 'all'
  ) {
    return undefined;
  }
  if (expression.args.length !== 1) {
    context.unsupportedKinds.add('Promise.all:arity');
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }
  const [allSource] = expression.args;
  if (allSource?.kind !== 'array_literal') {
    context.unsupportedKinds.add('Promise.all:source');
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }
  const resultArrayType = promiseAllResultArrayType(context);
  if (!resultArrayType) {
    context.unsupportedKinds.add('Promise.all:result');
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }

  const resultsName = nextTempLocalName(context, 'promise_all_results');
  addLocal(context, resultsName, resultArrayType);
  const resultArraySet: SemanticStatementIR = {
    kind: 'local_set',
    name: resultsName,
    value: promiseAllResultArrayLiteral(resultArrayType, allSource.elements.length, context),
  };
  context.runtimeFamilies.add('array');
  context.runtimeFamilies.add('finite_union');
  context.runtimeFamilies.add('promise');

  if (allSource.elements.length === 0) {
    context.pendingStatements.push(resultArraySet);
    return {
      kind: 'call',
      callee: SOUNDSCRIPT_PROMISE_RESOLVE_HELPER_NAME,
      args: [{
        kind: 'tag_heap_object',
        value: localGetExpression(resultsName, resultArrayType),
        representation: 'tagged_ref',
      }],
      representation: 'heap_ref',
    };
  }

  const taggedValue = promiseReactionTaggedValueType();
  const closureSignature = createClosureSignature(context.moduleState, [taggedValue], taggedValue);
  const fulfilledFunctionId = pushPromiseAllFulfilledClosure(
    context,
    closureSignature.id,
    resultArrayType,
  );
  const rejectedFunctionId = pushPromiseRejectIntoClosure(context, closureSignature.id);
  const targetPromiseName = nextTempLocalName(context, 'promise_all_target');
  const remainingBoxName = nextTempLocalName(context, 'promise_all_remaining');
  addLocal(context, targetPromiseName, 'heap_ref');
  addLocal(context, remainingBoxName, 'box_ref');
  const statements: SemanticStatementIR[] = [
    resultArraySet,
    {
      kind: 'local_set',
      name: targetPromiseName,
      value: {
        kind: 'call',
        callee: SOUNDSCRIPT_PROMISE_NEW_PENDING_HELPER_NAME,
        args: [],
        representation: 'heap_ref',
      },
    },
    {
      kind: 'local_set',
      name: remainingBoxName,
      value: {
        kind: 'box_new',
        value: {
          kind: 'number_literal',
          value: allSource.elements.length,
          representation: 'f64',
        },
        valueType: 'f64',
        representation: 'box_ref',
      },
    },
  ];

  for (const [index, element] of allSource.elements.entries()) {
    const source = lowerExpression(element, context);
    const sourceStatements = takePendingStatements(context);
    if (source.representation !== 'heap_ref') {
      context.unsupportedKinds.add('Promise.all:element');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    const sourceName = nextTempLocalName(context, 'promise_all_source');
    addLocal(context, sourceName, 'heap_ref');
    const targetCapture = promiseTargetCapture(targetPromiseName);
    statements.push(
      ...sourceStatements,
      { kind: 'local_set', name: sourceName, value: source },
      {
        kind: 'expression',
        value: {
          kind: 'call',
          callee: SOUNDSCRIPT_PROMISE_THEN_HELPER_NAME,
          args: [
            localGetExpression(sourceName, 'heap_ref'),
            {
              kind: 'closure_literal',
              functionId: fulfilledFunctionId,
              signatureId: closureSignature.id,
              captures: [
                targetCapture,
                {
                  kind: 'box_new',
                  value: localGetExpression(resultsName, resultArrayType),
                  valueType: resultArrayType,
                  representation: 'box_ref',
                },
                localGetExpression(remainingBoxName, 'box_ref'),
                {
                  kind: 'box_new',
                  value: { kind: 'number_literal', value: index, representation: 'f64' },
                  valueType: 'f64',
                  representation: 'box_ref',
                },
              ],
              captureValueTypes: [
                'tagged_ref',
                resultArrayType,
                'box_ref',
                'f64',
              ],
              representation: 'closure_ref',
            },
            {
              kind: 'closure_literal',
              functionId: rejectedFunctionId,
              signatureId: closureSignature.id,
              captures: [targetCapture],
              captureValueTypes: ['tagged_ref'],
              representation: 'closure_ref',
            },
          ],
          representation: 'heap_ref',
        },
      },
    );
  }

  context.pendingStatements.push(...statements);
  context.runtimeFamilies.add('closure');
  return localGetExpression(targetPromiseName, 'heap_ref');
}

function lowerPromiseStaticCallExpression(
  expression: Extract<SourceExpressionIR, { kind: 'call_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (
    expression.callee.kind !== 'property_access' ||
    expression.callee.object.kind !== 'identifier' ||
    expression.callee.object.name !== 'Promise'
  ) {
    return undefined;
  }
  const promiseRaceCall = lowerPromiseRaceCallExpression(expression, context);
  if (promiseRaceCall) {
    return promiseRaceCall;
  }
  const promiseAllCall = lowerPromiseAllCallExpression(expression, context);
  if (promiseAllCall) {
    return promiseAllCall;
  }
  const helperName = expression.callee.property === 'resolve'
    ? SOUNDSCRIPT_PROMISE_RESOLVE_HELPER_NAME
    : expression.callee.property === 'reject'
    ? SOUNDSCRIPT_PROMISE_REJECT_HELPER_NAME
    : undefined;
  if (!helperName) {
    return undefined;
  }
  if (expression.args.length > 1) {
    context.unsupportedKinds.add(`Promise.${expression.callee.property}:arity`);
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }
  const rawValue = expression.args[0]
    ? lowerExpression(expression.args[0], context)
    : { kind: 'undefined_literal', representation: 'tagged_ref' } as SemanticExpressionIR;
  const promiseValueType = promiseValueTypeForSemanticType(context.currentResultType);
  if (helperName === SOUNDSCRIPT_PROMISE_RESOLVE_HELPER_NAME) {
    const resolved = promiseResolveExpressionForValue(rawValue, promiseValueType, context);
    if (!resolved) {
      context.unsupportedKinds.add(`Promise.${expression.callee.property}:value`);
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    return resolved;
  }
  const value = adaptExpressionToSemanticType(rawValue, promiseValueType, context) ?? rawValue;
  const taggedValue = taggedUnionExpressionForValue(value, context);
  if (!taggedValue) {
    context.unsupportedKinds.add(`Promise.${expression.callee.property}:value`);
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }
  context.runtimeFamilies.add('promise');
  return {
    kind: 'call',
    callee: helperName,
    args: [taggedValue],
    representation: 'heap_ref',
  };
}

function promiseTargetCapture(
  targetName: string,
): Extract<SemanticExpressionIR, { kind: 'box_new' }> {
  return {
    kind: 'box_new',
    value: {
      kind: 'tag_heap_object',
      value: localGetExpression(targetName, 'heap_ref'),
      representation: 'tagged_ref',
    },
    valueType: 'tagged_ref',
    representation: 'box_ref',
  };
}

function promiseTargetFromCapture(): SemanticExpressionIR {
  return {
    kind: 'box_get',
    box: localGetExpression('capture_target_0', 'box_ref'),
    valueType: 'tagged_ref',
    representation: 'tagged_ref',
  };
}

function pushPromiseRejectIntoClosure(
  context: FunctionLoweringContext,
  signatureId: number,
): number {
  const closureFunctionId = context.moduleState.nextClosureFunctionId;
  context.moduleState.nextClosureFunctionId += 1;
  context.moduleState.generatedFunctions.push({
    name: `closure_source_async_await_rejected_${closureFunctionId}`,
    exportName: '',
    params: [
      { name: 'capture_target_0', representation: 'box_ref' },
      { name: 'promise_reason', representation: 'tagged_ref' },
    ],
    locals: [],
    result: 'tagged_ref',
    body: [
      {
        kind: 'expression',
        value: {
          kind: 'call',
          callee: SOUNDSCRIPT_PROMISE_REJECT_INTO_HELPER_NAME,
          args: [
            promiseTargetFromCapture(),
            localGetExpression('promise_reason', 'tagged_ref'),
          ],
          representation: 'tagged_ref',
        },
      },
      { kind: 'return', value: { kind: 'undefined_literal', representation: 'tagged_ref' } },
    ],
    bodyStatus: 'emittable',
    unsupportedBodyKinds: [],
    runtimeFamilies: ['finite_union', 'promise'],
    hostImported: false,
    hostExported: false,
    unionBoundaries: [],
    closureFunctionId,
    closureSignatureId: signatureId,
    closureCaptureCount: 1,
    closureCaptureValueTypes: ['tagged_ref'],
  });
  return closureFunctionId;
}

function pushPromiseResolveIntoClosure(
  context: FunctionLoweringContext,
  signatureId: number,
): number {
  const closureFunctionId = context.moduleState.nextClosureFunctionId;
  context.moduleState.nextClosureFunctionId += 1;
  context.moduleState.generatedFunctions.push({
    name: `closure_source_promise_fulfilled_${closureFunctionId}`,
    exportName: '',
    params: [
      { name: 'capture_target_0', representation: 'box_ref' },
      { name: 'promise_value', representation: 'tagged_ref' },
    ],
    locals: [],
    result: 'tagged_ref',
    body: [
      {
        kind: 'expression',
        value: {
          kind: 'call',
          callee: SOUNDSCRIPT_PROMISE_RESOLVE_INTO_HELPER_NAME,
          args: [
            promiseTargetFromCapture(),
            localGetExpression('promise_value', 'tagged_ref'),
          ],
          representation: 'tagged_ref',
        },
      },
      { kind: 'return', value: { kind: 'undefined_literal', representation: 'tagged_ref' } },
    ],
    bodyStatus: 'emittable',
    unsupportedBodyKinds: [],
    runtimeFamilies: ['finite_union', 'promise'],
    hostImported: false,
    hostExported: false,
    unionBoundaries: [],
    closureFunctionId,
    closureSignatureId: signatureId,
    closureCaptureCount: 1,
    closureCaptureValueTypes: ['tagged_ref'],
  });
  return closureFunctionId;
}

function promiseAllResultArrayType(
  context: FunctionLoweringContext,
): PromiseAllSupportedArrayValueType | undefined {
  const promiseValueType = promiseValueTypeForSemanticType(context.currentResultType);
  if (promiseValueType?.kind !== 'array') {
    return undefined;
  }
  const arrayType = arrayRepresentationForSemanticType(promiseValueType);
  switch (arrayType) {
    case 'owned_heap_array_ref':
    case 'owned_array_ref':
    case 'owned_number_array_ref':
    case 'owned_boolean_array_ref':
    case 'owned_tagged_array_ref':
      return arrayType;
    default:
      return undefined;
  }
}

function promiseAllCaptureGet(
  name: string,
  valueType: CompilerValueType,
): SemanticExpressionIR {
  return {
    kind: 'box_get',
    box: localGetExpression(name, 'box_ref'),
    valueType,
    representation: valueType,
  };
}

function promiseAllResultArrayLiteral(
  arrayType: PromiseAllSupportedArrayValueType,
  length: number,
  context: FunctionLoweringContext,
): SemanticExpressionIR {
  switch (arrayType) {
    case 'owned_heap_array_ref':
      return {
        kind: 'owned_heap_array_literal',
        elements: Array.from(
          { length },
          () => ({ kind: 'heap_null', representation: 'heap_ref' } as const),
        ),
        representation: 'owned_heap_array_ref',
      };
    case 'owned_array_ref':
      context.runtimeFamilies.add('string');
      return {
        kind: 'owned_string_array_literal',
        elements: Array.from(
          { length },
          () => ({
            kind: 'owned_string_literal',
            literalId: getStringLiteralId(context, JSON.stringify('')),
            representation: 'owned_string_ref',
          } as const),
        ),
        representation: 'owned_array_ref',
      };
    case 'owned_number_array_ref':
      return {
        kind: 'owned_number_array_literal',
        elements: Array.from(
          { length },
          () => ({ kind: 'number_literal', value: 0, representation: 'f64' } as const),
        ),
        representation: 'owned_number_array_ref',
      };
    case 'owned_boolean_array_ref':
      return {
        kind: 'owned_boolean_array_literal',
        elements: Array.from(
          { length },
          () => ({ kind: 'boolean_literal', value: false, representation: 'i32' } as const),
        ),
        representation: 'owned_boolean_array_ref',
      };
    case 'owned_tagged_array_ref':
      return {
        kind: 'owned_tagged_array_literal',
        elements: Array.from(
          { length },
          () => ({ kind: 'undefined_literal', representation: 'tagged_ref' } as const),
        ),
        representation: 'owned_tagged_array_ref',
      };
  }
}

function promiseAllValueFromTagged(
  taggedValue: SemanticExpressionIR,
  arrayType: PromiseAllSupportedArrayValueType,
  context: FunctionLoweringContext,
): SemanticExpressionIR {
  switch (arrayType) {
    case 'owned_heap_array_ref':
      return untagUnionExpressionForRepresentation(taggedValue, 'heap_ref', context)!;
    case 'owned_array_ref':
      return untagUnionExpressionForRepresentation(taggedValue, 'owned_string_ref', context)!;
    case 'owned_number_array_ref':
      return untagUnionExpressionForRepresentation(taggedValue, 'f64', context)!;
    case 'owned_boolean_array_ref':
      return untagUnionExpressionForRepresentation(taggedValue, 'i32', context)!;
    case 'owned_tagged_array_ref':
      return taggedValue;
  }
}

function promiseAllResultArraySetStatement(
  arrayType: PromiseAllSupportedArrayValueType,
  array: SemanticExpressionIR,
  index: SemanticExpressionIR,
  taggedValue: SemanticExpressionIR,
  context: FunctionLoweringContext,
): SemanticStatementIR {
  const value = promiseAllValueFromTagged(taggedValue, arrayType, context);
  switch (arrayType) {
    case 'owned_heap_array_ref':
      return { kind: 'owned_heap_array_set', array, index, value };
    case 'owned_array_ref':
      return { kind: 'owned_string_array_set', array, index, value };
    case 'owned_number_array_ref':
      return { kind: 'owned_number_array_set', array, index, value };
    case 'owned_boolean_array_ref':
      return { kind: 'owned_boolean_array_set', array, index, value };
    case 'owned_tagged_array_ref':
      return { kind: 'owned_tagged_array_set', array, index, value };
  }
}

function pushPromiseAllFulfilledClosure(
  context: FunctionLoweringContext,
  signatureId: number,
  resultArrayType: PromiseAllSupportedArrayValueType,
): number {
  const closureFunctionId = context.moduleState.nextClosureFunctionId;
  context.moduleState.nextClosureFunctionId += 1;
  const remainingLocalName = 'remaining_after_settle';
  const resultsArray = promiseAllCaptureGet('capture_results_1', resultArrayType);
  const remainingValue = promiseAllCaptureGet('capture_remaining_2', 'f64');
  const indexValue = promiseAllCaptureGet('capture_index_3', 'f64');
  const resultSetStatement = promiseAllResultArraySetStatement(
    resultArrayType,
    resultsArray,
    indexValue,
    localGetExpression('promise_value', 'tagged_ref'),
    context,
  );
  context.moduleState.generatedFunctions.push({
    name: `closure_source_promise_all_fulfilled_${closureFunctionId}`,
    exportName: '',
    params: [
      { name: 'capture_target_0', representation: 'box_ref' },
      { name: 'capture_results_1', representation: 'box_ref' },
      { name: 'capture_remaining_2', representation: 'box_ref' },
      { name: 'capture_index_3', representation: 'box_ref' },
      { name: 'promise_value', representation: 'tagged_ref' },
    ],
    locals: [{ name: remainingLocalName, representation: 'f64' }],
    result: 'tagged_ref',
    body: [
      resultSetStatement,
      {
        kind: 'local_set',
        name: remainingLocalName,
        value: {
          kind: 'binary',
          op: 'f64.sub',
          left: remainingValue,
          right: { kind: 'number_literal', value: 1, representation: 'f64' },
          representation: 'f64',
        },
      },
      {
        kind: 'box_set',
        box: localGetExpression('capture_remaining_2', 'box_ref'),
        value: localGetExpression(remainingLocalName, 'f64'),
        valueType: 'f64',
      },
      {
        kind: 'if',
        condition: {
          kind: 'binary',
          op: 'f64.eq',
          left: localGetExpression(remainingLocalName, 'f64'),
          right: { kind: 'number_literal', value: 0, representation: 'f64' },
          representation: 'i32',
        },
        thenBody: [{
          kind: 'expression',
          value: {
            kind: 'call',
            callee: SOUNDSCRIPT_PROMISE_RESOLVE_INTO_HELPER_NAME,
            args: [
              promiseTargetFromCapture(),
              {
                kind: 'tag_heap_object',
                value: resultsArray,
                representation: 'tagged_ref',
              },
            ],
            representation: 'tagged_ref',
          },
        }],
        elseBody: [],
      },
      { kind: 'return', value: { kind: 'undefined_literal', representation: 'tagged_ref' } },
    ],
    bodyStatus: 'emittable',
    unsupportedBodyKinds: [],
    runtimeFamilies: ['array', 'finite_union', 'promise'],
    hostImported: false,
    hostExported: false,
    unionBoundaries: [],
    closureFunctionId,
    closureSignatureId: signatureId,
    closureCaptureCount: 4,
    closureCaptureValueTypes: [
      'tagged_ref',
      resultArrayType,
      'box_ref',
      'f64',
    ],
  });
  return closureFunctionId;
}

function unionTagForTypeofLiteral(text: string): number | undefined {
  const unquoted = text.length >= 2 ? text.slice(1, -1) : text;
  switch (unquoted) {
    case 'number':
      return 2;
    case 'boolean':
      return 1;
    case 'string':
      return 3;
    case 'symbol':
      return 5;
    case 'bigint':
      return 7;
    case 'object':
      return 4;
    default:
      return undefined;
  }
}

function singleSignatureClosureType(
  type: SemanticTypeIR | undefined,
): {
  params: readonly SemanticTypeIR[];
  result: SemanticTypeIR;
} | undefined {
  if (type?.kind !== 'closure' || !type.signatures || type.signatures.length !== 1) {
    return undefined;
  }
  const [signature] = type.signatures;
  if (!signature) {
    return undefined;
  }
  return {
    params: signature.params as readonly SemanticTypeIR[],
    result: signature.result as SemanticTypeIR,
  };
}

function createClosureSignature(
  moduleState: SourceSemanticModuleLoweringState,
  params: readonly SemanticTypeIR[],
  result: SemanticTypeIR,
): SemanticClosureSignatureIR {
  const paramRepresentations = params.map(representationForSemanticType);
  const resultType = representationForSemanticType(result);
  const key = `${paramRepresentations.join(',')}=>${resultType}`;
  const existing = moduleState.closureSignaturesByKey.get(key);
  if (existing) {
    return existing;
  }
  const signature: SemanticClosureSignatureIR = {
    id: moduleState.nextClosureSignatureId,
    params: paramRepresentations,
    resultType,
  };
  moduleState.nextClosureSignatureId += 1;
  moduleState.closureSignaturesByKey.set(key, signature);
  moduleState.closureSignatures.push(signature);
  return signature;
}

function closureLocalForSemanticType(
  type: SemanticTypeIR | undefined,
  context: FunctionLoweringContext,
): SourceSemanticClosureLocal | undefined {
  const signature = singleSignatureClosureType(type);
  if (!signature) {
    return undefined;
  }
  const closureSignature = createClosureSignature(
    context.moduleState,
    signature.params,
    signature.result,
  );
  return {
    signatureId: closureSignature.id,
    resultRepresentation: representationForSemanticType(signature.result),
  };
}

function binaryOperatorForSource(
  operator: string,
  left: SemanticExpressionIR,
  right: SemanticExpressionIR,
): { op: string; representation: CompilerValueType } | undefined {
  if (left.representation === 'i32' && right.representation === 'i32') {
    switch (operator) {
      case '===':
        return { op: 'i32.eq', representation: 'i32' };
      case '!==':
        return { op: 'i32.ne', representation: 'i32' };
      default:
        return undefined;
    }
  }
  if (left.representation !== 'f64' || right.representation !== 'f64') {
    return undefined;
  }
  switch (operator) {
    case '+':
      return { op: 'f64.add', representation: 'f64' };
    case '-':
      return { op: 'f64.sub', representation: 'f64' };
    case '*':
      return { op: 'f64.mul', representation: 'f64' };
    case '/':
      return { op: 'f64.div', representation: 'f64' };
    case '>':
      return { op: 'f64.gt', representation: 'i32' };
    case '>=':
      return { op: 'f64.ge', representation: 'i32' };
    case '<':
      return { op: 'f64.lt', representation: 'i32' };
    case '<=':
      return { op: 'f64.le', representation: 'i32' };
    case '===':
      return { op: 'f64.eq', representation: 'i32' };
    case '!==':
      return { op: 'f64.ne', representation: 'i32' };
    default:
      return undefined;
  }
}

function unaryOperatorForSource(
  operator: string,
  value: SemanticExpressionIR,
):
  | { op: 'number.negate' | 'number.identity' | 'boolean.not'; representation: CompilerValueType }
  | undefined {
  if (operator === '-' && value.representation === 'f64') {
    return { op: 'number.negate', representation: 'f64' };
  }
  if (operator === '+' && value.representation === 'f64') {
    return { op: 'number.identity', representation: 'f64' };
  }
  if (operator === '!' && value.representation === 'i32') {
    return { op: 'boolean.not', representation: 'i32' };
  }
  return undefined;
}

function staticTypeofStringForRepresentation(
  representation: CompilerValueType,
): string | undefined {
  switch (representation) {
    case 'f64':
      return 'number';
    case 'i32':
      return 'boolean';
    case 'owned_string_ref':
      return 'string';
    case 'symbol_ref':
      return 'symbol';
    case 'bigint_ref':
      return 'bigint';
    case 'closure_ref':
    case 'class_constructor_ref':
      return 'function';
    case 'heap_ref':
    case 'owned_number_array_ref':
    case 'owned_boolean_array_ref':
    case 'owned_array_ref':
    case 'owned_heap_array_ref':
    case 'owned_tagged_array_ref':
      return 'object';
    default:
      return undefined;
  }
}

function lowerTypeofExpression(
  expression: Extract<SourceExpressionIR, { kind: 'unary_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  const value = lowerExpression(expression.operand, context);
  const statements = takePendingStatements(context);
  const typeName = staticTypeofStringForRepresentation(value.representation);
  if (!typeName) {
    return undefined;
  }
  context.runtimeFamilies.add('string');
  context.pendingStatements.push(...statements);
  return {
    kind: 'owned_string_literal',
    literalId: getStringLiteralId(context, JSON.stringify(typeName)),
    representation: 'owned_string_ref',
  };
}

function sourceExpressionHasTaggedUnionRepresentation(
  expression: SourceExpressionIR,
  context: FunctionLoweringContext,
): boolean {
  switch (expression.kind) {
    case 'identifier':
      return context.localRepresentations.get(expression.name) === 'tagged_ref' ||
        context.unionLocals.has(expression.name);
    case 'call_expression':
      return expression.callee.kind === 'identifier' &&
        context.functionResultRepresentations.get(expression.callee.name) === 'tagged_ref';
    case 'conditional_expression':
      return sourceExpressionHasTaggedUnionRepresentation(expression.consequent, context) &&
        sourceExpressionHasTaggedUnionRepresentation(expression.alternate, context);
    default:
      return false;
  }
}

function lowerUnionBinaryExpression(
  expression: Extract<SourceExpressionIR, { kind: 'binary_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (expression.operator !== '===' && expression.operator !== '!==') {
    return undefined;
  }
  const negated = expression.operator === '!==';
  if (
    expression.left.kind === 'unary_expression' &&
    expression.left.operator === 'typeof' &&
    expression.right.kind === 'literal' &&
    expression.right.literalKind === 'string'
  ) {
    const tag = unionTagForTypeofLiteral(expression.right.text);
    if (tag === undefined) {
      return undefined;
    }
    if (!sourceExpressionHasTaggedUnionRepresentation(expression.left.operand, context)) {
      return undefined;
    }
    const value = lowerExpression(expression.left.operand, context);
    if (value.representation !== 'tagged_ref') {
      return undefined;
    }
    context.runtimeFamilies.add('finite_union');
    return { kind: 'tagged_has_tag', value, tag, negated, representation: 'i32' };
  }
  if (
    expression.right.kind === 'unary_expression' &&
    expression.right.operator === 'typeof' &&
    expression.left.kind === 'literal' &&
    expression.left.literalKind === 'string'
  ) {
    const tag = unionTagForTypeofLiteral(expression.left.text);
    if (tag === undefined) {
      return undefined;
    }
    if (!sourceExpressionHasTaggedUnionRepresentation(expression.right.operand, context)) {
      return undefined;
    }
    const value = lowerExpression(expression.right.operand, context);
    if (value.representation !== 'tagged_ref') {
      return undefined;
    }
    context.runtimeFamilies.add('finite_union');
    return { kind: 'tagged_has_tag', value, tag, negated, representation: 'i32' };
  }
  if (
    expression.right.kind === 'literal' &&
    expression.right.literalKind === 'null' &&
    sourceExpressionHasTaggedUnionRepresentation(expression.left, context)
  ) {
    const value = lowerExpression(expression.left, context);
    if (value.representation !== 'tagged_ref') {
      return undefined;
    }
    context.runtimeFamilies.add('finite_union');
    return {
      kind: 'tagged_is_null',
      value,
      negated,
      representation: 'i32',
    };
  }
  if (
    expression.left.kind === 'literal' &&
    expression.left.literalKind === 'null' &&
    sourceExpressionHasTaggedUnionRepresentation(expression.right, context)
  ) {
    const value = lowerExpression(expression.right, context);
    if (value.representation !== 'tagged_ref') {
      return undefined;
    }
    context.runtimeFamilies.add('finite_union');
    return {
      kind: 'tagged_is_null',
      value,
      negated,
      representation: 'i32',
    };
  }
  if (
    expression.right.kind === 'literal' &&
    expression.right.literalKind === 'undefined' &&
    sourceExpressionHasTaggedUnionRepresentation(expression.left, context)
  ) {
    const value = lowerExpression(expression.left, context);
    if (value.representation !== 'tagged_ref') {
      return undefined;
    }
    context.runtimeFamilies.add('finite_union');
    return {
      kind: 'tagged_is_undefined',
      value,
      negated,
      representation: 'i32',
    };
  }
  if (
    expression.left.kind === 'literal' &&
    expression.left.literalKind === 'undefined' &&
    sourceExpressionHasTaggedUnionRepresentation(expression.right, context)
  ) {
    const value = lowerExpression(expression.right, context);
    if (value.representation !== 'tagged_ref') {
      return undefined;
    }
    context.runtimeFamilies.add('finite_union');
    return {
      kind: 'tagged_is_undefined',
      value,
      negated,
      representation: 'i32',
    };
  }
  return undefined;
}

function lowerCallArguments(
  args: readonly SourceExpressionIR[],
  paramTypes: readonly SemanticTypeIR[] | undefined,
  context: FunctionLoweringContext,
): SemanticExpressionIR[] {
  return args.map((arg, index) => {
    const value = lowerExpression(arg, context);
    return projectObjectExpressionToSemanticType(arg, value, paramTypes?.[index], context) ??
      adaptExpressionToSemanticType(value, paramTypes?.[index], context) ?? value;
  });
}

function getStringLiteralId(context: FunctionLoweringContext, text: string): number {
  const unquoted = text.length >= 2 ? text.slice(1, -1) : text;
  const existing = context.stringLiteralIds.get(unquoted);
  if (existing !== undefined) {
    return existing;
  }
  const id = context.stringLiterals.length;
  context.stringLiteralIds.set(unquoted, id);
  context.stringLiterals.push(unquoted);
  return id;
}

function nextTempLocalName(context: FunctionLoweringContext, prefix: string): string {
  const name = `__source_${prefix}_${context.tempIndex}`;
  context.tempIndex += 1;
  return name;
}

function addLocal(
  context: FunctionLoweringContext,
  name: string,
  representation: CompilerValueType,
): void {
  context.localRepresentations.set(name, representation);
  if (!context.locals.some((local) => local.name === name)) {
    context.locals.push({ name, representation });
  }
}

function contextHasSourceBinding(context: FunctionLoweringContext, name: string): boolean {
  return context.localRepresentations.has(name) ||
    context.objectLocals.has(name) ||
    context.arrayLocals.has(name) ||
    context.closureLocals.has(name) ||
    context.constructorLocals.has(name) ||
    context.mapLocals.has(name) ||
    context.setLocals.has(name) ||
    context.boxedLocals.has(name);
}

function classNameForConstructorExpression(
  expression: SourceExpressionIR,
  context: FunctionLoweringContext,
): string | undefined {
  if (expression.kind !== 'identifier') {
    return undefined;
  }
  if (context.classesByName.has(expression.name)) {
    return expression.name;
  }
  return context.constructorLocals.get(expression.name)?.className;
}

function takePendingStatements(context: FunctionLoweringContext): SemanticStatementIR[] {
  const statements = [...context.pendingStatements];
  context.pendingStatements.length = 0;
  return statements;
}

function sourceObjectLayoutName(
  fields: readonly { name: string; representation: CompilerValueType }[],
): string {
  return `source_object:${
    fields.map((field) => `${field.name}:${field.representation}`).join(',')
  }`;
}

function registerSpecializedObjectLayout(
  context: FunctionLoweringContext,
  fields: readonly { name: string; representation: CompilerValueType }[],
): string {
  const name = sourceObjectLayoutName(fields);
  const layout: SemanticObjectLayoutIR = {
    name,
    family: 'specialized_object',
    fields: fields.map((field) => field.name),
    fieldValueTypes: fields.map((field) => ({
      name: field.name,
      representation: field.representation,
    })),
  };
  context.objectLayoutsByKey.set(`specialized_object:${name}`, layout);
  context.runtimeFamilies.add('specialized_object');
  return name;
}

function registerFallbackObjectLayout(
  context: FunctionLoweringContext,
  representationName: string,
  fields: readonly { name: string; representation: CompilerValueType }[],
): string {
  const layout: SemanticObjectLayoutIR = {
    name: representationName,
    family: 'fallback_object',
    fields: fields.map((field) => field.name),
    fieldValueTypes: fields.map((field) => ({
      name: field.name,
      representation: field.representation,
    })),
  };
  context.objectLayoutsByKey.set(`fallback_object:${representationName}`, layout);
  context.runtimeFamilies.add('fallback_object');
  return representationName;
}

function registerDynamicObjectLayout(
  context: FunctionLoweringContext,
  representationName: string,
): string {
  const layout: SemanticObjectLayoutIR = {
    name: representationName,
    family: 'dynamic_object',
    fields: [],
  };
  context.objectLayoutsByKey.set(`dynamic_object:${representationName}`, layout);
  context.runtimeFamilies.add('dynamic_object');
  return representationName;
}

function localTypeKey(
  fileName: string,
  functionName: string,
  name: string,
  start: number,
  end: number,
): string {
  return `${fileName}:${functionName}:${name}:${start}:${end}`;
}

function localTypeSnapshotKey(snapshot: SharedSemanticLocalTypeSnapshotIR): string {
  return localTypeKey(
    snapshot.fileName,
    snapshot.functionName,
    snapshot.name,
    snapshot.span.start,
    snapshot.span.end,
  );
}

function localTypeForBinding(
  binding: SourceBindingIR,
  context: FunctionLoweringContext,
): SemanticTypeIR | undefined {
  if (binding.kind !== 'identifier_binding') {
    return undefined;
  }
  return context.localTypesByKey.get(
    localTypeKey(
      binding.span.fileName,
      context.functionName,
      binding.name,
      binding.span.start,
      binding.span.end,
    ),
  );
}

function arrayLocalInfoForExpression(
  expression: SemanticExpressionIR,
): SourceSemanticArrayLocal | undefined {
  switch (expression.kind) {
    case 'owned_number_array_literal':
      return {
        elementRepresentation: 'f64',
      };
    case 'owned_string_array_literal':
      return {
        elementRepresentation: 'owned_string_ref',
      };
    case 'owned_boolean_array_literal':
      return {
        elementRepresentation: 'i32',
      };
    default:
      return undefined;
  }
}

function arrayLocalInfoForInitializer(
  source: SourceExpressionIR,
  expression: SemanticExpressionIR,
  context: FunctionLoweringContext,
): SourceSemanticArrayLocal | undefined {
  if (source.kind === 'call_expression' && source.callee.kind === 'identifier') {
    return context.functionResultArrayLocals.get(source.callee.name) ??
      arrayLocalInfoForExpression(expression);
  }
  return arrayLocalInfoForExpression(expression);
}

function arrayLocalInfoForRead(
  source: SourceExpressionIR,
  expression: SemanticExpressionIR,
  context: FunctionLoweringContext,
): SourceSemanticArrayLocal | undefined {
  if (expression.representation === 'owned_number_array_ref') {
    return { elementRepresentation: 'f64' };
  }
  if (expression.representation === 'owned_boolean_array_ref') {
    return { elementRepresentation: 'i32' };
  }
  if (source.kind === 'identifier') {
    return context.arrayLocals.get(source.name);
  }
  return arrayLocalInfoForExpression(expression);
}

function arrayElementExpressionForInfo(
  array: SemanticExpressionIR,
  index: SemanticExpressionIR,
  info: SourceSemanticArrayLocal,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (index.representation !== 'f64') {
    return undefined;
  }
  if (array.representation === 'owned_number_array_ref' && info.elementRepresentation === 'f64') {
    context.runtimeFamilies.add('array');
    return {
      kind: 'owned_number_array_element',
      value: array,
      index,
      representation: 'f64',
    };
  }
  if (
    array.representation === 'owned_array_ref' &&
    info.elementRepresentation === 'owned_string_ref'
  ) {
    context.runtimeFamilies.add('array');
    context.runtimeFamilies.add('string');
    return {
      kind: 'owned_string_array_element',
      value: array,
      index,
      representation: 'owned_string_ref',
    };
  }
  if (array.representation === 'owned_boolean_array_ref' && info.elementRepresentation === 'i32') {
    context.runtimeFamilies.add('array');
    return {
      kind: 'owned_boolean_array_element',
      value: array,
      index,
      representation: 'i32',
    };
  }
  return undefined;
}

function arrayElementSetStatementForLocal(
  context: FunctionLoweringContext,
  objectName: string,
  index: SemanticExpressionIR,
  value: SemanticExpressionIR,
): SemanticStatementIR | undefined {
  if (index.representation !== 'f64') {
    return undefined;
  }
  const arrayRepresentation = context.localRepresentations.get(objectName);
  if (!arrayRepresentation) {
    return undefined;
  }
  const array: SemanticExpressionIR = {
    kind: 'local_get',
    name: objectName,
    representation: arrayRepresentation,
  };
  if (arrayRepresentation === 'owned_number_array_ref' && value.representation === 'f64') {
    context.runtimeFamilies.add('array');
    return {
      kind: 'owned_number_array_set',
      array,
      index,
      value,
    };
  }
  const arrayLocal = context.arrayLocals.get(objectName);
  if (
    arrayRepresentation === 'owned_array_ref' &&
    arrayLocal?.elementRepresentation === 'owned_string_ref' &&
    value.representation === 'owned_string_ref'
  ) {
    context.runtimeFamilies.add('array');
    context.runtimeFamilies.add('string');
    return {
      kind: 'owned_string_array_set',
      array,
      index,
      value,
    };
  }
  if (arrayRepresentation === 'owned_boolean_array_ref' && value.representation === 'i32') {
    context.runtimeFamilies.add('array');
    return {
      kind: 'owned_boolean_array_set',
      array,
      index,
      value,
    };
  }
  return undefined;
}

function lowerBooleanLogicalExpression(
  expression: Extract<SourceExpressionIR, { kind: 'logical_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (expression.operator !== '&&' && expression.operator !== '||') {
    return undefined;
  }
  const left = lowerExpression(expression.left, context);
  const leftStatements = takePendingStatements(context);
  const right = lowerExpression(expression.right, context);
  const rightStatements = takePendingStatements(context);
  if (left.representation !== 'i32' || right.representation !== 'i32') {
    return undefined;
  }
  const resultName = nextTempLocalName(context, 'logical');
  addLocal(context, resultName, 'i32');
  const result: SemanticExpressionIR = {
    kind: 'local_get',
    name: resultName,
    representation: 'i32',
  };
  context.pendingStatements.push(
    ...leftStatements,
    { kind: 'local_set', name: resultName, value: left },
    {
      kind: 'if',
      condition: result,
      thenBody: expression.operator === '&&'
        ? [...rightStatements, { kind: 'local_set', name: resultName, value: right }]
        : [],
      elseBody: expression.operator === '||'
        ? [...rightStatements, { kind: 'local_set', name: resultName, value: right }]
        : [],
    },
  );
  return result;
}

function lowerConditionalExpression(
  expression: Extract<SourceExpressionIR, { kind: 'conditional_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  const condition = lowerExpression(expression.test, context);
  const conditionStatements = takePendingStatements(context);
  let consequent = lowerExpression(expression.consequent, context);
  const consequentStatements = takePendingStatements(context);
  let alternate = lowerExpression(expression.alternate, context);
  const alternateStatements = takePendingStatements(context);
  if (condition.representation !== 'i32') {
    return undefined;
  }
  if (consequent.representation !== alternate.representation) {
    const taggedConsequent = taggedUnionExpressionForValue(consequent, context);
    const taggedAlternate = taggedUnionExpressionForValue(alternate, context);
    if (!taggedConsequent || !taggedAlternate) {
      return undefined;
    }
    consequent = taggedConsequent;
    alternate = taggedAlternate;
  }
  const resultName = nextTempLocalName(context, 'conditional');
  addLocal(context, resultName, consequent.representation);
  const result: SemanticExpressionIR = {
    kind: 'local_get',
    name: resultName,
    representation: consequent.representation,
  };
  context.pendingStatements.push(
    ...conditionStatements,
    {
      kind: 'if',
      condition,
      thenBody: [...consequentStatements, {
        kind: 'local_set',
        name: resultName,
        value: consequent,
      }],
      elseBody: [...alternateStatements, { kind: 'local_set', name: resultName, value: alternate }],
    },
  );
  return result;
}

function lowerUpdateExpression(
  expression: Extract<SourceExpressionIR, { kind: 'update_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  const updatedExpression = (current: SemanticExpressionIR): SemanticExpressionIR => ({
    kind: 'binary',
    op: expression.operator === '++' ? 'f64.add' : 'f64.sub',
    left: current,
    right: { kind: 'number_literal', value: 1, representation: 'f64' },
    representation: 'f64',
  });
  if (expression.operand.kind === 'identifier') {
    const representation = context.localRepresentations.get(expression.operand.name);
    if (representation !== 'f64') {
      return undefined;
    }
    const current: SemanticExpressionIR = {
      kind: 'local_get',
      name: expression.operand.name,
      representation: 'f64',
    };
    const updated = updatedExpression(current);
    if (expression.prefix) {
      context.pendingStatements.push({
        kind: 'local_set',
        name: expression.operand.name,
        value: updated,
      });
      return {
        kind: 'local_get',
        name: expression.operand.name,
        representation: 'f64',
      };
    }
    const previousName = nextTempLocalName(context, 'update_previous');
    addLocal(context, previousName, 'f64');
    context.pendingStatements.push(
      { kind: 'local_set', name: previousName, value: current },
      {
        kind: 'local_set',
        name: expression.operand.name,
        value: updated,
      },
    );
    return {
      kind: 'local_get',
      name: previousName,
      representation: 'f64',
    };
  }

  if (
    expression.operand.kind === 'element_access' &&
    expression.operand.object.kind === 'identifier' &&
    expression.operand.index
  ) {
    const objectName = expression.operand.object.name;
    const arrayRepresentation = context.localRepresentations.get(objectName);
    if (!arrayRepresentation) {
      return undefined;
    }
    const index = lowerExpression(expression.operand.index, context);
    const array = localGetExpression(objectName, arrayRepresentation);
    const arrayLocal = arrayLocalInfoForRead(expression.operand.object, array, context);
    const current = arrayLocal
      ? arrayElementExpressionForInfo(array, index, arrayLocal, context)
      : undefined;
    if (!current || current.representation !== 'f64') {
      return undefined;
    }
    const previousName = nextTempLocalName(context, `element_${objectName}`);
    const updatedName = nextTempLocalName(context, `element_${objectName}_updated`);
    addLocal(context, previousName, 'f64');
    addLocal(context, updatedName, 'f64');
    const updated = updatedExpression(localGetExpression(previousName, 'f64'));
    const arraySet = arrayElementSetStatementForLocal(
      context,
      objectName,
      index,
      localGetExpression(updatedName, 'f64'),
    );
    if (!arraySet) {
      return undefined;
    }
    context.pendingStatements.push(
      ...takePendingStatements(context),
      { kind: 'local_set', name: previousName, value: current },
      { kind: 'local_set', name: updatedName, value: updated },
      arraySet,
    );
    return localGetExpression(expression.prefix ? updatedName : previousName, 'f64');
  }

  if (
    expression.operand.kind === 'property_access' &&
    expression.operand.object.kind === 'identifier'
  ) {
    const objectName = expression.operand.object.name;
    const propertyName = expression.operand.property;
    const objectLayout = context.objectLocals.get(objectName);
    const fieldIndex = objectLayout?.fields.findIndex((field) => field.name === propertyName) ??
      -1;
    if (!objectLayout || objectLayout.family !== 'specialized_object' || fieldIndex < 0) {
      return undefined;
    }
    const field = objectLayout.fields[fieldIndex]!;
    if (field.representation !== 'f64') {
      return undefined;
    }
    const previousName = nextTempLocalName(context, `field_${objectName}`);
    const updatedName = nextTempLocalName(context, `field_${objectName}_updated`);
    addLocal(context, previousName, 'f64');
    addLocal(context, updatedName, 'f64');
    context.runtimeFamilies.add('specialized_object');
    context.pendingStatements.push(
      {
        kind: 'specialized_object_field_get',
        targetName: previousName,
        objectName,
        representationName: objectLayout.representationName,
        fieldIndex,
        fieldName: field.name,
      },
      {
        kind: 'local_set',
        name: updatedName,
        value: updatedExpression(localGetExpression(previousName, 'f64')),
      },
      {
        kind: 'specialized_object_field_set',
        objectName,
        representationName: objectLayout.representationName,
        fieldIndex,
        fieldName: field.name,
        value: localGetExpression(updatedName, 'f64'),
      },
    );
    return localGetExpression(expression.prefix ? updatedName : previousName, 'f64');
  }

  return undefined;
}

function compoundAssignmentBinaryOperator(operator: string): string | undefined {
  switch (operator) {
    case '+=':
      return '+';
    case '-=':
      return '-';
    case '*=':
      return '*';
    case '/=':
      return '/';
    default:
      return undefined;
  }
}

function lowerObjectLiteralExpression(
  expression: Extract<SourceExpressionIR, { kind: 'object_literal' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR {
  const fieldValueNames: string[] = [];
  const fields: { name: string; representation: CompilerValueType }[] = [];
  const statements: SemanticStatementIR[] = [];
  for (const property of expression.properties) {
    if (property.computedName) {
      context.unsupportedKinds.add('object_literal_computed');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    const value = lowerExpression(property.value, context);
    statements.push(...takePendingStatements(context));
    const valueName = nextTempLocalName(context, `object_literal_${property.name}`);
    addLocal(context, valueName, value.representation);
    statements.push({ kind: 'local_set', name: valueName, value });
    fieldValueNames.push(valueName);
    fields.push({ name: property.name, representation: value.representation });
  }

  const objectName = nextTempLocalName(context, 'object_literal');
  const objectLocal: SourceSemanticObjectLocal = {
    family: 'specialized_object',
    representationName: registerSpecializedObjectLayout(context, fields),
    fields,
  };
  addLocal(context, objectName, 'heap_ref');
  context.objectLocals.set(objectName, objectLocal);
  context.pendingStatements.push(...statements, {
    kind: 'specialized_object_new',
    targetName: objectName,
    representationName: objectLocal.representationName,
    fieldValueNames,
  });
  context.runtimeFamilies.add('specialized_object');
  return localGetExpression(objectName, 'heap_ref');
}

function lowerExpression(
  expression: SourceExpressionIR,
  context: FunctionLoweringContext,
): SemanticExpressionIR {
  switch (expression.kind) {
    case 'literal': {
      switch (expression.literalKind) {
        case 'number':
          return {
            kind: 'number_literal',
            value: Number(expression.text),
            representation: 'f64',
          };
        case 'boolean':
          return {
            kind: 'boolean_literal',
            value: expression.text === 'true',
            representation: 'i32',
          };
        case 'string':
          context.runtimeFamilies.add('string');
          return {
            kind: 'owned_string_literal',
            literalId: getStringLiteralId(context, expression.text),
            representation: 'owned_string_ref',
          };
        case 'undefined':
          return { kind: 'undefined_literal', representation: 'tagged_ref' };
        case 'null':
          return { kind: 'null_literal', representation: 'tagged_ref' };
        default: {
          const exhaustiveCheck: never = expression.literalKind;
          return exhaustiveCheck;
        }
      }
    }
    case 'identifier': {
      const representation = context.localRepresentations.get(expression.name);
      if (!representation) {
        context.unsupportedKinds.add(`unbound_identifier:${expression.name}`);
        return { kind: 'undefined_literal', representation: 'tagged_ref' };
      }
      const boxedValueType = context.boxedLocals.get(expression.name);
      if (representation === 'box_ref' && boxedValueType) {
        return {
          kind: 'box_get',
          box: { kind: 'local_get', name: expression.name, representation: 'box_ref' },
          valueType: boxedValueType,
          representation: boxedValueType,
        };
      }
      return { kind: 'local_get', name: expression.name, representation };
    }
    case 'property_access': {
      const staticProperty = lowerClassStaticPropertyAccessExpression(expression, context);
      if (staticProperty) {
        return staticProperty;
      }
      const collectionProperty = lowerCollectionPropertyAccessExpression(expression, context);
      if (collectionProperty) {
        return collectionProperty;
      }
      if (expression.object.kind === 'identifier') {
        const field = lowerObjectPropertyReadFromLocal(
          expression.object.name,
          expression.property,
          context,
        );
        if (field) {
          return field;
        }
      }
      const object = lowerExpression(expression.object, context);
      const objectLayout = objectLocalInfoForRead(expression.object, object, context);
      if (objectLayout) {
        const materialized = materializeObjectExpressionForRead(
          object,
          objectLayout,
          context,
          `object_${expression.property}`,
        );
        context.pendingStatements.push(...materialized.statements);
        const field = lowerObjectPropertyReadFromLocal(
          materialized.objectName,
          expression.property,
          context,
        );
        if (field) {
          return field;
        }
      }
      if (expression.property === 'length' && object.representation === 'owned_string_ref') {
        context.runtimeFamilies.add('string');
        return {
          kind: 'owned_string_length',
          value: object,
          representation: 'f64',
        };
      }
      if (
        expression.property === 'length' &&
        (
          object.representation === 'owned_number_array_ref' ||
          object.representation === 'owned_boolean_array_ref' ||
          object.representation === 'owned_array_ref' ||
          object.representation === 'owned_heap_array_ref' ||
          object.representation === 'owned_tagged_array_ref'
        )
      ) {
        context.runtimeFamilies.add('array');
        return {
          kind: 'owned_array_length',
          value: object,
          representation: 'f64',
        };
      }
      context.unsupportedKinds.add(`property_access:${expression.property}`);
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    case 'element_access': {
      if (expression.object.kind === 'identifier') {
        const objectLayout = context.objectLocals.get(expression.object.name);
        const propertyKey = sourceStaticPropertyKey(expression.index);
        const field = propertyKey
          ? objectLayout?.fields.find((candidate) => candidate.name === propertyKey)
          : undefined;
        if (objectLayout && propertyKey && field) {
          const tempName = nextTempLocalName(context, `field_${expression.object.name}`);
          addLocal(context, tempName, field.representation);
          const getStatement = objectFieldGetStatementForLocal(
            tempName,
            expression.object.name,
            objectLayout,
            propertyKey,
          );
          if (!getStatement) {
            context.unsupportedKinds.add('element_access');
            return { kind: 'undefined_literal', representation: 'tagged_ref' };
          }
          context.pendingStatements.push(getStatement);
          context.runtimeFamilies.add(objectLayout.family);
          return {
            kind: 'local_get',
            name: tempName,
            representation: field.representation,
          };
        }
        if (objectLayout?.family === 'dynamic_object' && expression.index) {
          const materializedKey = materializeOwnedStringKeyExpression(
            expression.index,
            context,
            `dynamic_key_${expression.object.name}`,
          );
          const valueType = objectLayout.dynamicValueRepresentation;
          if (!materializedKey || !valueType) {
            context.unsupportedKinds.add('dynamic_object_element_access');
            return { kind: 'undefined_literal', representation: 'tagged_ref' };
          }
          const tempName = nextTempLocalName(context, `dynamic_value_${expression.object.name}`);
          addLocal(context, tempName, valueType);
          context.pendingStatements.push(...materializedKey.statements, {
            kind: 'dynamic_object_property_get',
            targetName: tempName,
            objectName: expression.object.name,
            representationName: objectLayout.representationName,
            propertyKeyName: materializedKey.keyName,
            valueType,
          });
          context.runtimeFamilies.add('dynamic_object');
          return {
            kind: 'local_get',
            name: tempName,
            representation: valueType,
          };
        }
      }
      const object = lowerExpression(expression.object, context);
      const index = expression.index
        ? lowerExpression(expression.index, context)
        : { kind: 'undefined_literal', representation: 'tagged_ref' } as SemanticExpressionIR;
      const arrayLocal = arrayLocalInfoForRead(expression.object, object, context);
      if (arrayLocal) {
        const element = arrayElementExpressionForInfo(object, index, arrayLocal, context);
        if (element) {
          return element;
        }
      }
      context.unsupportedKinds.add('element_access');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    case 'array_literal': {
      const elements = expression.elements.map((element) => lowerExpression(element, context));
      if (elements.every((element) => element.representation === 'f64')) {
        context.runtimeFamilies.add('array');
        return {
          kind: 'owned_number_array_literal',
          elements,
          representation: 'owned_number_array_ref',
        };
      }
      if (elements.every((element) => element.representation === 'owned_string_ref')) {
        context.runtimeFamilies.add('array');
        context.runtimeFamilies.add('string');
        return {
          kind: 'owned_string_array_literal',
          elements,
          representation: 'owned_array_ref',
        };
      }
      if (elements.every((element) => element.representation === 'i32')) {
        context.runtimeFamilies.add('array');
        return {
          kind: 'owned_boolean_array_literal',
          elements,
          representation: 'owned_boolean_array_ref',
        };
      }
      context.unsupportedKinds.add('array_literal');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    case 'object_literal':
      return lowerObjectLiteralExpression(expression, context);
    case 'call_expression': {
      const promiseThenCall = lowerPromiseThenCallExpression(expression, context);
      if (promiseThenCall) {
        return promiseThenCall;
      }
      const promiseStaticCall = lowerPromiseStaticCallExpression(expression, context);
      if (promiseStaticCall) {
        return promiseStaticCall;
      }
      const collectionMethodCall = lowerCollectionMethodCallExpression(expression, context);
      if (collectionMethodCall) {
        return collectionMethodCall;
      }
      const staticMethodCall = lowerClassStaticMethodCallExpression(expression, context);
      if (staticMethodCall) {
        return staticMethodCall;
      }
      const methodCall = lowerClassMethodCallExpression(expression, context);
      if (methodCall) {
        return methodCall;
      }
      if (expression.callee.kind === 'identifier') {
        const closureLocal = context.closureLocals.get(expression.callee.name);
        if (closureLocal) {
          return {
            kind: 'closure_call',
            callee: {
              kind: 'local_get',
              name: expression.callee.name,
              representation: 'closure_ref',
            },
            args: lowerCallArguments(expression.args, undefined, context),
            signatureId: closureLocal.signatureId,
            representation: closureLocal.resultRepresentation,
          };
        }
        const representation = context.functionResultRepresentations.get(expression.callee.name);
        if (!representation) {
          context.unsupportedKinds.add(`unknown_call:${expression.callee.name}`);
          return { kind: 'undefined_literal', representation: 'tagged_ref' };
        }
        return {
          kind: 'call',
          callee: expression.callee.name,
          args: lowerCallArguments(
            expression.args,
            context.functionParamTypes.get(expression.callee.name),
            context,
          ),
          representation,
        };
      }
      const callee = lowerExpression(expression.callee, context);
      const closureLocal = closureLocalInfoForRead(expression.callee, callee, context);
      if (!closureLocal) {
        context.unsupportedKinds.add('call_expression');
        return { kind: 'undefined_literal', representation: 'tagged_ref' };
      }
      const materialized = materializeClosureExpressionForCall(
        callee,
        closureLocal,
        context,
        'closure_callee',
      );
      context.pendingStatements.push(...materialized.statements);
      return {
        kind: 'closure_call',
        callee: materialized.callee,
        args: lowerCallArguments(expression.args, undefined, context),
        signatureId: closureLocal.signatureId,
        representation: closureLocal.resultRepresentation,
      };
    }
    case 'new_expression': {
      const builtinError = lowerBuiltinErrorNewExpression(expression, context);
      if (builtinError) {
        return builtinError;
      }
      const targetName = nextTempLocalName(context, 'class_instance');
      const statements = lowerClassConstructionDeclaration(
        targetName,
        expression,
        'const',
        context,
      );
      if (!statements) {
        return { kind: 'undefined_literal', representation: 'tagged_ref' };
      }
      context.pendingStatements.push(...statements);
      return { kind: 'local_get', name: targetName, representation: 'heap_ref' };
    }
    case 'binary_expression': {
      const unionBinary = lowerUnionBinaryExpression(expression, context);
      if (unionBinary) {
        return unionBinary;
      }
      let left = lowerExpression(expression.left, context);
      let right = lowerExpression(expression.right, context);
      if (
        expression.operator === '+' &&
        left.representation === 'owned_string_ref' &&
        right.representation === 'owned_string_ref'
      ) {
        context.runtimeFamilies.add('string');
        return {
          kind: 'binary',
          op: 'string.concat',
          left,
          right,
          representation: 'owned_string_ref',
        };
      }
      if (
        ['+', '-', '*', '/', '>', '>=', '<', '<='].includes(expression.operator) &&
        left.representation === 'tagged_ref' &&
        right.representation === 'f64'
      ) {
        const untaggedLeft = untagUnionExpressionForRepresentation(left, 'f64', context);
        if (untaggedLeft) {
          left = untaggedLeft;
        }
      }
      if (
        ['+', '-', '*', '/', '>', '>=', '<', '<='].includes(expression.operator) &&
        right.representation === 'tagged_ref' &&
        left.representation === 'f64'
      ) {
        const untaggedRight = untagUnionExpressionForRepresentation(right, 'f64', context);
        if (untaggedRight) {
          right = untaggedRight;
        }
      }
      const binary = binaryOperatorForSource(expression.operator, left, right);
      if (!binary) {
        context.unsupportedKinds.add(`binary_expression:${expression.operator}`);
        return { kind: 'undefined_literal', representation: 'tagged_ref' };
      }
      return {
        kind: 'binary',
        op: binary.op,
        left,
        right,
        representation: binary.representation,
      };
    }
    case 'logical_expression': {
      const logical = lowerBooleanLogicalExpression(expression, context);
      if (logical) {
        return logical;
      }
      context.unsupportedKinds.add(`logical_expression:${expression.operator}`);
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    case 'unary_expression': {
      if (expression.operator === 'typeof') {
        const typeOf = lowerTypeofExpression(expression, context);
        if (typeOf) {
          return typeOf;
        }
        context.unsupportedKinds.add('typeof_expression');
        return { kind: 'undefined_literal', representation: 'tagged_ref' };
      }
      const value = lowerExpression(expression.operand, context);
      const unary = unaryOperatorForSource(expression.operator, value);
      if (!unary) {
        context.unsupportedKinds.add(`unary_expression:${expression.operator}`);
        return { kind: 'undefined_literal', representation: 'tagged_ref' };
      }
      return {
        kind: 'unary',
        op: unary.op,
        value,
        representation: unary.representation,
      };
    }
    case 'update_expression': {
      const updated = lowerUpdateExpression(expression, context);
      if (updated) {
        return updated;
      }
      context.unsupportedKinds.add(`update_expression:${expression.operator}`);
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    case 'conditional_expression': {
      const conditional = lowerConditionalExpression(expression, context);
      if (conditional) {
        return conditional;
      }
      context.unsupportedKinds.add('conditional_expression');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    default:
      context.unsupportedKinds.add(expression.kind);
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }
}

function lowerArrayForOfStatement(
  statement: Extract<SourceStatementIR, { kind: 'for_of' }>,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] | undefined {
  if (statement.await || statement.left.kind !== 'identifier_binding') {
    return undefined;
  }
  const iterable = lowerExpression(statement.right, context);
  const leadingStatements = takePendingStatements(context);
  const arrayLocal = arrayLocalInfoForRead(statement.right, iterable, context);
  if (!arrayLocal) {
    return undefined;
  }
  const arrayName = nextTempLocalName(context, 'for_of_array');
  const lengthName = nextTempLocalName(context, 'for_of_length');
  const indexName = nextTempLocalName(context, 'for_of_index');
  addLocal(context, arrayName, iterable.representation);
  addLocal(context, lengthName, 'f64');
  addLocal(context, indexName, 'f64');
  addLocal(context, statement.left.name, arrayLocal.elementRepresentation);
  context.arrayLocals.set(arrayName, arrayLocal);
  const array: SemanticExpressionIR = {
    kind: 'local_get',
    name: arrayName,
    representation: iterable.representation,
  };
  const index: SemanticExpressionIR = {
    kind: 'local_get',
    name: indexName,
    representation: 'f64',
  };
  const value = arrayElementExpressionForInfo(array, index, arrayLocal, context);
  if (!value) {
    return undefined;
  }
  return [
    ...leadingStatements,
    { kind: 'local_set', name: arrayName, value: iterable },
    {
      kind: 'local_set',
      name: lengthName,
      value: {
        kind: 'owned_array_length',
        value: array,
        representation: 'f64',
      },
    },
    {
      kind: 'local_set',
      name: indexName,
      value: { kind: 'number_literal', value: 0, representation: 'f64' },
    },
    {
      kind: 'while',
      condition: {
        kind: 'binary',
        op: 'f64.lt',
        left: index,
        right: {
          kind: 'local_get',
          name: lengthName,
          representation: 'f64',
        },
        representation: 'i32',
      },
      body: [
        { kind: 'local_set', name: statement.left.name, value },
        ...statement.body.flatMap((child) => [...lowerStatement(child, context)]),
        {
          kind: 'local_set',
          name: indexName,
          value: {
            kind: 'binary',
            op: 'f64.add',
            left: index,
            right: { kind: 'number_literal', value: 1, representation: 'f64' },
            representation: 'f64',
          },
        },
      ],
    },
  ];
}

function localGetExpression(
  name: string,
  representation: CompilerValueType,
): SemanticExpressionIR {
  return { kind: 'local_get', name, representation };
}

function booleanLiteralExpression(value: boolean): SemanticExpressionIR {
  return { kind: 'boolean_literal', value, representation: 'i32' };
}

function lowerSwitchClauseStatements(
  statements: readonly SourceStatementIR[],
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  return statements.flatMap((child) => [...lowerStatement(child, context)]);
}

function lowerSwitchStatement(
  statement: Extract<SourceStatementIR, { kind: 'switch' }>,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  const defaultIndex = statement.clauses.findIndex((clause) => clause.kind === 'default');
  if (defaultIndex >= 0 && defaultIndex !== statement.clauses.length - 1) {
    context.unsupportedKinds.add('switch_default_position');
    return [{ kind: 'unsupported_statement', sourceKind: 'switch' }];
  }

  const discriminant = lowerExpression(statement.expression, context);
  const discriminantStatements = takePendingStatements(context);
  const discriminantName = nextTempLocalName(context, 'switch_value');
  const matchedName = nextTempLocalName(context, 'switch_matched');
  const activeName = nextTempLocalName(context, 'switch_active');
  addLocal(context, discriminantName, discriminant.representation);
  addLocal(context, matchedName, 'i32');
  addLocal(context, activeName, 'i32');

  const switchStatements: SemanticStatementIR[] = [
    ...discriminantStatements,
    { kind: 'local_set', name: discriminantName, value: discriminant },
    { kind: 'local_set', name: matchedName, value: booleanLiteralExpression(false) },
    { kind: 'local_set', name: activeName, value: booleanLiteralExpression(true) },
  ];

  context.switchBreakLocalStack.push(activeName);
  try {
    for (const clause of statement.clauses) {
      const body = lowerSwitchClauseStatements(clause.statements, context);
      const executeBodyWhenMatched: SemanticStatementIR = {
        kind: 'if',
        condition: localGetExpression(activeName, 'i32'),
        thenBody: [
          {
            kind: 'if',
            condition: localGetExpression(matchedName, 'i32'),
            thenBody: body,
            elseBody: clause.kind === 'default'
              ? [
                {
                  kind: 'local_set',
                  name: matchedName,
                  value: booleanLiteralExpression(true),
                },
                ...body,
              ]
              : (() => {
                if (!clause.expression) {
                  context.unsupportedKinds.add('switch_case');
                  return [{ kind: 'unsupported_statement', sourceKind: 'switch' }];
                }
                const caseValue = lowerExpression(clause.expression, context);
                const caseStatements = takePendingStatements(context);
                const comparison = binaryOperatorForSource(
                  '===',
                  localGetExpression(discriminantName, discriminant.representation),
                  caseValue,
                );
                if (!comparison || comparison.representation !== 'i32') {
                  context.unsupportedKinds.add('switch_case_comparison');
                  return [{ kind: 'unsupported_statement', sourceKind: 'switch' }];
                }
                return [
                  ...caseStatements,
                  {
                    kind: 'if',
                    condition: {
                      kind: 'binary',
                      op: comparison.op,
                      left: localGetExpression(discriminantName, discriminant.representation),
                      right: caseValue,
                      representation: 'i32',
                    },
                    thenBody: [
                      {
                        kind: 'local_set',
                        name: matchedName,
                        value: booleanLiteralExpression(true),
                      },
                      ...body,
                    ],
                    elseBody: [],
                  },
                ];
              })(),
          },
        ],
        elseBody: [],
      };
      switchStatements.push(executeBodyWhenMatched);
    }
  } finally {
    context.switchBreakLocalStack.pop();
  }

  return switchStatements;
}

function objectLocalForSemanticType(
  type: SemanticTypeIR,
  fields: readonly { name: string; representation: CompilerValueType }[],
  context: FunctionLoweringContext,
  options?: { preferDynamic?: boolean },
): SourceSemanticObjectLocal | undefined {
  if (type.kind !== 'object') {
    return undefined;
  }
  if (type.dynamic || options?.preferDynamic) {
    const dynamicValueRepresentation = homogeneousFieldRepresentation(fields);
    if (!dynamicValueRepresentation) {
      context.unsupportedKinds.add('dynamic_object_heterogeneous_values');
      return undefined;
    }
    return {
      family: 'dynamic_object',
      representationName: registerDynamicObjectLayout(
        context,
        type.layoutName ? `dynamic:${type.layoutName}` : sourceObjectLayoutName(fields),
      ),
      dynamicValueRepresentation,
      fields,
    };
  }
  if (type.fallback) {
    return {
      family: 'fallback_object',
      representationName: registerFallbackObjectLayout(
        context,
        type.layoutName ?? sourceObjectLayoutName(fields),
        fields,
      ),
      fields,
    };
  }
  return {
    family: 'specialized_object',
    representationName: registerSpecializedObjectLayout(context, fields),
    fields,
  };
}

function objectLocalForParameterType(
  type: SemanticTypeIR,
  context: FunctionLoweringContext,
): SourceSemanticObjectLocal | undefined {
  if (type.kind !== 'object' || type.dynamic || !type.fields) {
    return undefined;
  }
  const fields = type.fields
    .filter((field) => !field.method)
    .map((field) => ({
      name: field.name,
      representation: representationForSemanticType(field.type as SemanticTypeIR),
    }));
  const objectLocal = objectLocalForSemanticType(type, fields, context);
  if (!objectLocal) {
    return undefined;
  }
  const className = type.layoutName && context.classesByName.has(type.layoutName)
    ? type.layoutName
    : undefined;
  return className ? { ...objectLocal, className } : objectLocal;
}

function quotedSourceStringValue(text: string): string | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function sourceStaticPropertyKey(expression: SourceExpressionIR | undefined): string | undefined {
  if (!expression || expression.kind !== 'literal' || expression.literalKind !== 'string') {
    return undefined;
  }
  return quotedSourceStringValue(expression.text);
}

function materializeOwnedStringKeyExpression(
  expression: SourceExpressionIR,
  context: FunctionLoweringContext,
  prefix: string,
): { keyName: string; statements: SemanticStatementIR[] } | undefined {
  const key = lowerExpression(expression, context);
  const statements = takePendingStatements(context);
  if (key.representation !== 'owned_string_ref') {
    return undefined;
  }
  if (key.kind === 'local_get') {
    return { keyName: key.name, statements };
  }
  const keyName = nextTempLocalName(context, prefix);
  addLocal(context, keyName, 'owned_string_ref');
  return {
    keyName,
    statements: [...statements, { kind: 'local_set', name: keyName, value: key }],
  };
}

function materializeExpressionValue(
  expression: SourceExpressionIR,
  context: FunctionLoweringContext,
  prefix: string,
  targetType?: SemanticTypeIR,
  targetRepresentation?: CompilerValueType,
):
  | { valueName: string; valueType: CompilerValueType; statements: SemanticStatementIR[] }
  | undefined {
  const rawValue = lowerExpression(expression, context);
  const statements = takePendingStatements(context);
  const typedValue = adaptExpressionToSemanticType(rawValue, targetType, context) ?? rawValue;
  const value = targetRepresentation === 'tagged_ref' && typedValue.representation !== 'tagged_ref'
    ? taggedUnionExpressionForValue(typedValue, context)
    : typedValue;
  if (!value) {
    return undefined;
  }
  if (targetRepresentation && value.representation !== targetRepresentation) {
    return undefined;
  }
  if (value.kind === 'local_get') {
    return { valueName: value.name, valueType: value.representation, statements };
  }
  const valueName = nextTempLocalName(context, prefix);
  addLocal(context, valueName, value.representation);
  return {
    valueName,
    valueType: value.representation,
    statements: [...statements, { kind: 'local_set', name: valueName, value }],
  };
}

function materializeStaticOwnedStringKey(
  key: string,
  context: FunctionLoweringContext,
  prefix: string,
): { keyName: string; statements: SemanticStatementIR[] } {
  context.runtimeFamilies.add('string');
  const keyName = nextTempLocalName(context, prefix);
  addLocal(context, keyName, 'owned_string_ref');
  return {
    keyName,
    statements: [{
      kind: 'local_set',
      name: keyName,
      value: {
        kind: 'owned_string_literal',
        literalId: getStringLiteralId(context, JSON.stringify(key)),
        representation: 'owned_string_ref',
      },
    }],
  };
}

function materializeOwnedStringLiteralValue(
  value: string,
  context: FunctionLoweringContext,
  prefix: string,
): { valueName: string; valueType: 'owned_string_ref'; statements: SemanticStatementIR[] } {
  context.runtimeFamilies.add('string');
  const valueName = nextTempLocalName(context, prefix);
  addLocal(context, valueName, 'owned_string_ref');
  return {
    valueName,
    valueType: 'owned_string_ref',
    statements: [{
      kind: 'local_set',
      name: valueName,
      value: {
        kind: 'owned_string_literal',
        literalId: getStringLiteralId(context, JSON.stringify(value)),
        representation: 'owned_string_ref',
      },
    }],
  };
}

function builtinErrorConstructorNameFromExpression(
  expression: SourceExpressionIR,
): string | undefined {
  if (expression.kind === 'identifier' && BUILTIN_ERROR_CONSTRUCTOR_NAMES.has(expression.name)) {
    return expression.name;
  }
  if (
    expression.kind === 'property_access' &&
    expression.object.kind === 'identifier' &&
    expression.object.name === 'globalThis' &&
    BUILTIN_ERROR_CONSTRUCTOR_NAMES.has(expression.property)
  ) {
    return expression.property;
  }
  return undefined;
}

function builtinErrorCauseExpression(
  expression: SourceExpressionIR,
  context: FunctionLoweringContext,
): SourceExpressionIR | undefined {
  if (expression.kind === 'literal' && expression.literalKind === 'undefined') {
    return undefined;
  }
  if (expression.kind !== 'object_literal') {
    context.unsupportedKinds.add('builtin_error_options');
    return undefined;
  }
  const cause = expression.properties.find((property) =>
    !property.computedName && property.name === 'cause'
  );
  return cause?.value;
}

function builtinErrorFields(): SourceSemanticObjectLocal['fields'] {
  return [
    { name: SOUNDSCRIPT_BUILTIN_ERROR_INTERNAL_BRAND_KEY, representation: 'owned_string_ref' },
    { name: 'name', representation: 'owned_string_ref' },
    { name: 'message', representation: 'owned_string_ref' },
    { name: 'cause', representation: 'tagged_ref' },
  ];
}

function builtinErrorObjectLocal(
  context: FunctionLoweringContext,
  representationName = registerDynamicObjectLayout(context, 'builtin_error'),
): SourceSemanticObjectLocal {
  return {
    family: 'dynamic_object',
    representationName,
    fields: builtinErrorFields(),
  };
}

function lowerBuiltinErrorNewExpression(
  expression: Extract<SourceExpressionIR, { kind: 'new_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  const constructorName = builtinErrorConstructorNameFromExpression(expression.callee);
  if (!constructorName) {
    return undefined;
  }
  if (expression.args.length > 2) {
    context.unsupportedKinds.add('builtin_error_constructor_arity');
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }

  context.runtimeFamilies.add('error');
  context.runtimeFamilies.add('finite_union');
  const representationName = registerDynamicObjectLayout(context, 'builtin_error');
  const targetName = nextTempLocalName(context, 'error');
  addLocal(context, targetName, 'heap_ref');
  context.objectLocals.set(targetName, builtinErrorObjectLocal(context, representationName));

  const statements: SemanticStatementIR[] = [];
  const brandKey = materializeStaticOwnedStringKey(
    SOUNDSCRIPT_BUILTIN_ERROR_INTERNAL_BRAND_KEY,
    context,
    'error_brand_key',
  );
  const nameKey = materializeStaticOwnedStringKey('name', context, 'error_name_key');
  const messageKey = materializeStaticOwnedStringKey('message', context, 'error_message_key');
  const causeKey = materializeStaticOwnedStringKey('cause', context, 'error_cause_key');
  const nameValue = materializeOwnedStringLiteralValue(
    constructorName,
    context,
    'error_name_value',
  );
  const messageValue = expression.args[0]
    ? materializeExpressionValue(
      expression.args[0],
      context,
      'error_message_value',
      undefined,
      'owned_string_ref',
    )
    : materializeOwnedStringLiteralValue('', context, 'error_message_value');
  if (!messageValue) {
    context.unsupportedKinds.add('builtin_error_message');
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }
  const causeExpression = expression.args[1]
    ? builtinErrorCauseExpression(expression.args[1], context)
    : undefined;
  const causeValue = causeExpression
    ? materializeExpressionValue(
      causeExpression,
      context,
      'error_cause_value',
      undefined,
      'tagged_ref',
    )
    : (() => {
      const valueName = nextTempLocalName(context, 'error_cause_value');
      addLocal(context, valueName, 'tagged_ref');
      return {
        valueName,
        valueType: 'tagged_ref' as const,
        statements: [{
          kind: 'local_set' as const,
          name: valueName,
          value: { kind: 'undefined_literal', representation: 'tagged_ref' } as const,
        }],
      };
    })();
  if (!causeValue) {
    context.unsupportedKinds.add('builtin_error_cause');
    return { kind: 'undefined_literal', representation: 'tagged_ref' };
  }

  statements.push(
    ...brandKey.statements,
    ...nameKey.statements,
    ...messageKey.statements,
    ...causeKey.statements,
    ...nameValue.statements,
    ...messageValue.statements,
    ...causeValue.statements,
    {
      kind: 'dynamic_object_new',
      targetName,
      representationName,
      entries: [
        {
          keyName: brandKey.keyName,
          valueName: nameValue.valueName,
          valueType: nameValue.valueType,
        },
        {
          keyName: nameKey.keyName,
          valueName: nameValue.valueName,
          valueType: nameValue.valueType,
        },
        {
          keyName: messageKey.keyName,
          valueName: messageValue.valueName,
          valueType: messageValue.valueType,
        },
        {
          keyName: causeKey.keyName,
          valueName: causeValue.valueName,
          valueType: causeValue.valueType,
        },
      ],
    },
  );
  context.pendingStatements.push(...statements);
  return { kind: 'local_get', name: targetName, representation: 'heap_ref' };
}

function homogeneousFieldRepresentation(
  fields: readonly { name: string; representation: CompilerValueType }[],
): CompilerValueType | undefined {
  const [first] = fields;
  if (!first) {
    return undefined;
  }
  return fields.every((field) => field.representation === first.representation)
    ? first.representation
    : undefined;
}

function objectFieldGetStatementForLocal(
  targetName: string,
  objectName: string,
  objectLayout: SourceSemanticObjectLocal,
  propertyName: string,
): SemanticStatementIR | undefined {
  const fieldIndex = objectLayout.fields.findIndex((field) => field.name === propertyName);
  if (fieldIndex < 0) {
    return undefined;
  }
  const field = objectLayout.fields[fieldIndex]!;
  if (objectLayout.family === 'specialized_object') {
    return {
      kind: 'specialized_object_field_get',
      targetName,
      objectName,
      representationName: objectLayout.representationName,
      fieldIndex,
      fieldName: field.name,
    };
  }
  if (objectLayout.family === 'fallback_object') {
    return {
      kind: 'fallback_object_property_get',
      targetName,
      objectName,
      representationName: objectLayout.representationName,
      propertyKey: field.name,
      valueType: field.representation,
    };
  }
  return undefined;
}

function objectPropertyReadValueFromLocal(
  objectName: string,
  propertyName: string,
  objectLayout: SourceSemanticObjectLocal,
  context: FunctionLoweringContext,
): {
  statements: SemanticStatementIR[];
  value: Extract<SemanticExpressionIR, { kind: 'local_get' }>;
} | undefined {
  const field = objectLayout.fields.find((candidate) => candidate.name === propertyName);
  if (!field) {
    return undefined;
  }
  const targetName = nextTempLocalName(context, `field_${objectName}`);
  addLocal(context, targetName, field.representation);
  if (objectLayout.family === 'dynamic_object') {
    const key = materializeStaticOwnedStringKey(
      propertyName,
      context,
      `dynamic_field_${objectName}`,
    );
    context.runtimeFamilies.add('dynamic_object');
    return {
      statements: [...key.statements, {
        kind: 'dynamic_object_property_get',
        targetName,
        objectName,
        representationName: objectLayout.representationName,
        propertyKeyName: key.keyName,
        valueType: field.representation,
      }],
      value: { kind: 'local_get', name: targetName, representation: field.representation },
    };
  }
  const getStatement = objectFieldGetStatementForLocal(
    targetName,
    objectName,
    objectLayout,
    propertyName,
  );
  if (!getStatement) {
    context.unsupportedKinds.add(`property_access:${propertyName}`);
    return undefined;
  }
  context.runtimeFamilies.add(objectLayout.family);
  return {
    statements: [getStatement],
    value: { kind: 'local_get', name: targetName, representation: field.representation },
  };
}

function lowerObjectPropertyReadFromLocal(
  objectName: string,
  propertyName: string,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  const objectLayout = context.objectLocals.get(objectName);
  if (!objectLayout) {
    return undefined;
  }
  const read = objectPropertyReadValueFromLocal(
    objectName,
    propertyName,
    objectLayout,
    context,
  );
  if (!read) {
    return undefined;
  }
  context.pendingStatements.push(...read.statements);
  return read.value;
}

function lowerCollectionPropertyAccessExpression(
  expression: Extract<SourceExpressionIR, { kind: 'property_access' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (expression.object.kind !== 'identifier' || expression.property !== 'size') {
    return undefined;
  }
  const mapLocal = context.mapLocals.get(expression.object.name);
  if (mapLocal) {
    const targetName = nextTempLocalName(context, `map_size_${expression.object.name}`);
    addLocal(context, targetName, 'f64');
    context.pendingStatements.push({
      kind: 'map_size',
      targetName,
      objectName: expression.object.name,
      storage: true,
    });
    context.runtimeFamilies.add('map');
    return localGetExpression(targetName, 'f64');
  }
  const setLocal = context.setLocals.get(expression.object.name);
  if (setLocal) {
    const targetName = nextTempLocalName(context, `set_size_${expression.object.name}`);
    addLocal(context, targetName, 'f64');
    context.pendingStatements.push({
      kind: 'set_size',
      targetName,
      objectName: expression.object.name,
      valuesArrayType: setLocal.valuesArrayType,
    });
    context.runtimeFamilies.add('set');
    context.runtimeFamilies.add('array');
    return localGetExpression(targetName, 'f64');
  }
  return undefined;
}

function lowerMapMethodCallExpression(
  objectName: string,
  methodName: string,
  args: readonly SourceExpressionIR[],
  mapLocal: SourceSemanticMapLocal,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (methodName === 'set' && args.length >= 2) {
    const key = materializeOwnedStringKeyExpression(args[0]!, context, `map_key_${objectName}`);
    const value = materializeExpressionValue(
      args[1]!,
      context,
      `map_value_${objectName}`,
      mapLocal.valueType,
    );
    if (!key || !value) {
      context.unsupportedKinds.add('map_set');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    context.pendingStatements.push(...key.statements, ...value.statements, {
      kind: 'map_set',
      objectName,
      keyName: key.keyName,
      valueName: value.valueName,
      valueType: value.valueType,
    });
    context.runtimeFamilies.add('map');
    context.runtimeFamilies.add('finite_union');
    return localGetExpression(objectName, 'heap_ref');
  }
  if (methodName === 'get' && args.length >= 1) {
    const key = materializeOwnedStringKeyExpression(args[0]!, context, `map_key_${objectName}`);
    if (!key) {
      context.unsupportedKinds.add('map_get');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    const targetName = nextTempLocalName(context, `map_value_${objectName}`);
    addLocal(context, targetName, 'tagged_ref');
    context.pendingStatements.push(...key.statements, {
      kind: 'map_get',
      targetName,
      objectName,
      keyName: key.keyName,
    });
    context.runtimeFamilies.add('map');
    context.runtimeFamilies.add('finite_union');
    return localGetExpression(targetName, 'tagged_ref');
  }
  if ((methodName === 'has' || methodName === 'delete') && args.length >= 1) {
    const key = materializeOwnedStringKeyExpression(args[0]!, context, `map_key_${objectName}`);
    if (!key) {
      context.unsupportedKinds.add(`map_${methodName}`);
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    const targetName = nextTempLocalName(context, `map_${methodName}_${objectName}`);
    addLocal(context, targetName, 'i32');
    context.pendingStatements.push(...key.statements, {
      kind: methodName === 'has' ? 'map_has' : 'map_delete',
      targetName,
      objectName,
      keyName: key.keyName,
    });
    context.runtimeFamilies.add('map');
    context.runtimeFamilies.add('finite_union');
    return localGetExpression(targetName, 'i32');
  }
  if (methodName === 'clear' && args.length === 0) {
    const targetName = nextTempLocalName(context, `map_clear_${objectName}`);
    addLocal(context, targetName, 'tagged_ref');
    context.pendingStatements.push({
      kind: 'map_clear',
      targetName,
      objectName,
    });
    context.runtimeFamilies.add('map');
    context.runtimeFamilies.add('finite_union');
    return localGetExpression(targetName, 'tagged_ref');
  }
  return undefined;
}

function lowerSetMethodCallExpression(
  objectName: string,
  methodName: string,
  args: readonly SourceExpressionIR[],
  setLocal: SourceSemanticSetLocal,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (methodName === 'add' && args.length >= 1) {
    const value = materializeExpressionValue(
      args[0]!,
      context,
      `set_value_${objectName}`,
      setLocal.valueType,
      setLocal.valuesElementType,
    );
    if (!value) {
      context.unsupportedKinds.add('set_add');
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    context.pendingStatements.push(...value.statements, {
      kind: 'set_add',
      objectName,
      valueName: value.valueName,
      valuesArrayType: setLocal.valuesArrayType,
      valuesElementType: setLocal.valuesElementType,
    });
    context.runtimeFamilies.add('set');
    context.runtimeFamilies.add('array');
    return localGetExpression(objectName, 'heap_ref');
  }
  if ((methodName === 'has' || methodName === 'delete') && args.length >= 1) {
    const value = materializeExpressionValue(
      args[0]!,
      context,
      `set_value_${objectName}`,
      setLocal.valueType,
      setLocal.valuesElementType,
    );
    if (!value) {
      context.unsupportedKinds.add(`set_${methodName}`);
      return { kind: 'undefined_literal', representation: 'tagged_ref' };
    }
    const targetName = nextTempLocalName(context, `set_${methodName}_${objectName}`);
    addLocal(context, targetName, 'i32');
    context.pendingStatements.push(...value.statements, {
      kind: methodName === 'has' ? 'set_has' : 'set_delete',
      targetName,
      objectName,
      valueName: value.valueName,
      valuesArrayType: setLocal.valuesArrayType,
      valuesElementType: setLocal.valuesElementType,
    });
    context.runtimeFamilies.add('set');
    context.runtimeFamilies.add('array');
    return localGetExpression(targetName, 'i32');
  }
  if (methodName === 'clear' && args.length === 0) {
    const targetName = nextTempLocalName(context, `set_clear_${objectName}`);
    addLocal(context, targetName, 'tagged_ref');
    context.pendingStatements.push({
      kind: 'set_clear',
      targetName,
      objectName,
      valuesArrayType: setLocal.valuesArrayType,
    });
    context.runtimeFamilies.add('set');
    context.runtimeFamilies.add('array');
    return localGetExpression(targetName, 'tagged_ref');
  }
  return undefined;
}

function lowerCollectionMethodCallExpression(
  expression: Extract<SourceExpressionIR, { kind: 'call_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (
    expression.callee.kind !== 'property_access' ||
    expression.callee.object.kind !== 'identifier'
  ) {
    return undefined;
  }
  const objectName = expression.callee.object.name;
  const mapLocal = context.mapLocals.get(objectName);
  if (mapLocal) {
    return lowerMapMethodCallExpression(
      objectName,
      expression.callee.property,
      expression.args,
      mapLocal,
      context,
    );
  }
  const setLocal = context.setLocals.get(objectName);
  if (setLocal) {
    return lowerSetMethodCallExpression(
      objectName,
      expression.callee.property,
      expression.args,
      setLocal,
      context,
    );
  }
  return undefined;
}

function objectLocalInfoForRead(
  source: SourceExpressionIR,
  expression: SemanticExpressionIR,
  context: FunctionLoweringContext,
): SourceSemanticObjectLocal | undefined {
  if (expression.kind === 'local_get') {
    return context.objectLocals.get(expression.name);
  }
  if (source.kind === 'identifier') {
    return context.objectLocals.get(source.name);
  }
  if (source.kind === 'call_expression' && source.callee.kind === 'identifier') {
    const resultType = context.functionResultTypes.get(source.callee.name);
    return resultType ? objectLocalForParameterType(resultType, context) : undefined;
  }
  return undefined;
}

function mapLocalInfoForRead(
  source: SourceExpressionIR,
  expression: SemanticExpressionIR,
  context: FunctionLoweringContext,
): SourceSemanticMapLocal | undefined {
  if (expression.kind === 'local_get') {
    return context.mapLocals.get(expression.name);
  }
  if (source.kind === 'identifier') {
    return context.mapLocals.get(source.name);
  }
  if (source.kind === 'call_expression' && source.callee.kind === 'identifier') {
    return mapLocalInfoForSemanticType(context.functionResultTypes.get(source.callee.name));
  }
  return undefined;
}

function setLocalInfoForRead(
  source: SourceExpressionIR,
  expression: SemanticExpressionIR,
  context: FunctionLoweringContext,
): SourceSemanticSetLocal | undefined {
  if (expression.kind === 'local_get') {
    return context.setLocals.get(expression.name);
  }
  if (source.kind === 'identifier') {
    return context.setLocals.get(source.name);
  }
  if (source.kind === 'call_expression' && source.callee.kind === 'identifier') {
    return setLocalInfoForSemanticType(context.functionResultTypes.get(source.callee.name));
  }
  return undefined;
}

function closureLocalInfoForRead(
  source: SourceExpressionIR,
  expression: SemanticExpressionIR,
  context: FunctionLoweringContext,
): SourceSemanticClosureLocal | undefined {
  if (expression.kind === 'local_get') {
    return context.closureLocals.get(expression.name);
  }
  if (source.kind === 'identifier') {
    return context.closureLocals.get(source.name);
  }
  if (source.kind === 'call_expression' && source.callee.kind === 'identifier') {
    return closureLocalForSemanticType(
      context.functionResultTypes.get(source.callee.name),
      context,
    );
  }
  return undefined;
}

function materializeObjectExpressionForRead(
  expression: SemanticExpressionIR,
  objectLayout: SourceSemanticObjectLocal,
  context: FunctionLoweringContext,
  prefix: string,
): { objectName: string; statements: SemanticStatementIR[] } {
  const leadingStatements = takePendingStatements(context);
  if (expression.kind === 'local_get') {
    context.objectLocals.set(expression.name, objectLayout);
    return { objectName: expression.name, statements: leadingStatements };
  }
  const objectName = nextTempLocalName(context, prefix);
  addLocal(context, objectName, expression.representation);
  context.objectLocals.set(objectName, objectLayout);
  return {
    objectName,
    statements: [...leadingStatements, { kind: 'local_set', name: objectName, value: expression }],
  };
}

function materializeClosureExpressionForCall(
  expression: SemanticExpressionIR,
  closureLocal: SourceSemanticClosureLocal,
  context: FunctionLoweringContext,
  prefix: string,
): { callee: SemanticExpressionIR; statements: SemanticStatementIR[] } {
  const leadingStatements = takePendingStatements(context);
  if (expression.kind === 'local_get') {
    context.closureLocals.set(expression.name, closureLocal);
    return { callee: expression, statements: leadingStatements };
  }
  const closureName = nextTempLocalName(context, prefix);
  addLocal(context, closureName, 'closure_ref');
  context.closureLocals.set(closureName, closureLocal);
  return {
    callee: { kind: 'local_get', name: closureName, representation: 'closure_ref' },
    statements: [...leadingStatements, { kind: 'local_set', name: closureName, value: expression }],
  };
}

function lowerObjectBindingFromLocal(
  binding: SourceBindingIR,
  objectName: string,
  objectLayout: SourceSemanticObjectLocal,
  context: FunctionLoweringContext,
  sourceKind: string,
): SemanticStatementIR[] | undefined {
  if (binding.kind !== 'object_binding') {
    return undefined;
  }
  const statements: SemanticStatementIR[] = [];
  for (const element of binding.elements) {
    if (element.kind !== 'identifier_binding') {
      context.unsupportedKinds.add('object_binding');
      return undefined;
    }
    const fieldIndex = objectLayout.fields.findIndex((field) => field.name === element.name);
    if (fieldIndex < 0) {
      context.unsupportedKinds.add(`object_binding:${element.name}`);
      return undefined;
    }
    const field = objectLayout.fields[fieldIndex]!;
    addLocal(context, element.name, field.representation);
    const getStatement = objectFieldGetStatementForLocal(
      element.name,
      objectName,
      objectLayout,
      field.name,
    );
    if (!getStatement) {
      context.unsupportedKinds.add(`object_binding:${element.name}`);
      return undefined;
    }
    statements.push(getStatement);
  }
  context.runtimeFamilies.add(objectLayout.family);
  if (statements.length === 0) {
    context.unsupportedKinds.add(sourceKind);
    return undefined;
  }
  return statements;
}

function lowerArrayBindingFromLocal(
  binding: SourceBindingIR,
  arrayName: string,
  arrayRepresentation: CompilerValueType,
  arrayLocal: SourceSemanticArrayLocal,
  context: FunctionLoweringContext,
  sourceKind: string,
): SemanticStatementIR[] | undefined {
  if (binding.kind !== 'array_binding') {
    return undefined;
  }
  const statements: SemanticStatementIR[] = [];
  const array = localGetExpression(arrayName, arrayRepresentation);
  for (const [index, element] of binding.elements.entries()) {
    if (element.kind !== 'identifier_binding') {
      context.unsupportedKinds.add('array_binding');
      return undefined;
    }
    const value = arrayElementExpressionForInfo(
      array,
      { kind: 'number_literal', value: index, representation: 'f64' },
      arrayLocal,
      context,
    );
    if (!value) {
      context.unsupportedKinds.add(`array_binding:${element.name}`);
      return undefined;
    }
    addLocal(context, element.name, arrayLocal.elementRepresentation);
    statements.push({ kind: 'local_set', name: element.name, value });
  }
  if (statements.length === 0) {
    context.unsupportedKinds.add(sourceKind);
    return undefined;
  }
  return statements;
}

function sourceStatementsContainControlTransfer(
  statements: readonly SourceStatementIR[],
): boolean {
  return statements.some((statement): boolean => {
    switch (statement.kind) {
      case 'return':
      case 'break':
      case 'continue':
      case 'throw':
        return true;
      case 'block':
        return sourceStatementsContainControlTransfer(statement.statements);
      case 'if':
        return sourceStatementsContainControlTransfer(statement.consequent) ||
          sourceStatementsContainControlTransfer(statement.alternate);
      case 'while':
      case 'do_while':
      case 'for':
      case 'for_of':
        return true;
      case 'switch':
        return statement.clauses.some((clause) =>
          sourceStatementsContainControlTransfer(clause.statements)
        );
      case 'try':
        return sourceStatementsContainControlTransfer(statement.tryBlock) ||
          sourceStatementsContainControlTransfer(statement.catchBlock ?? []) ||
          sourceStatementsContainControlTransfer(statement.finallyBlock ?? []);
      default:
        return false;
    }
  });
}

function sourceStatementsContainUnsupportedCatchableTryFlow(
  statements: readonly SourceStatementIR[],
): boolean {
  return statements.some((statement): boolean => {
    switch (statement.kind) {
      case 'break':
      case 'continue':
      case 'while':
      case 'do_while':
      case 'for':
      case 'for_of':
      case 'switch':
      case 'try':
        return true;
      case 'block':
        return sourceStatementsContainUnsupportedCatchableTryFlow(statement.statements);
      case 'if':
        return sourceStatementsContainUnsupportedCatchableTryFlow(statement.consequent) ||
          sourceStatementsContainUnsupportedCatchableTryFlow(statement.alternate);
      default:
        return false;
    }
  });
}

function sourceStatementsContainReturn(
  statements: readonly SourceStatementIR[],
): boolean {
  return statements.some((statement): boolean => {
    switch (statement.kind) {
      case 'return':
        return true;
      case 'block':
        return sourceStatementsContainReturn(statement.statements);
      case 'if':
        return sourceStatementsContainReturn(statement.consequent) ||
          sourceStatementsContainReturn(statement.alternate);
      case 'switch':
        return statement.clauses.some((clause) => sourceStatementsContainReturn(clause.statements));
      case 'try':
        return sourceStatementsContainReturn(statement.tryBlock) ||
          sourceStatementsContainReturn(statement.catchBlock ?? []) ||
          sourceStatementsContainReturn(statement.finallyBlock ?? []);
      default:
        return false;
    }
  });
}

function sourceStatementsContainLoopControl(
  statements: readonly SourceStatementIR[],
  kind: 'break' | 'continue',
): boolean {
  return statements.some((statement): boolean => {
    switch (statement.kind) {
      case 'break':
      case 'continue':
        return statement.kind === kind;
      case 'block':
        return sourceStatementsContainLoopControl(statement.statements, kind);
      case 'if':
        return sourceStatementsContainLoopControl(statement.consequent, kind) ||
          sourceStatementsContainLoopControl(statement.alternate, kind);
      case 'try':
        return sourceStatementsContainLoopControl(statement.tryBlock, kind) ||
          sourceStatementsContainLoopControl(statement.catchBlock ?? [], kind) ||
          sourceStatementsContainLoopControl(statement.finallyBlock ?? [], kind);
      case 'while':
      case 'do_while':
      case 'for':
      case 'for_of':
      case 'switch':
        return false;
      default:
        return false;
    }
  });
}

function catchableTryActiveCondition(target: SourceSemanticThrowTarget): SemanticExpressionIR {
  return {
    kind: 'binary',
    op: 'i32.eq',
    left: localGetExpression(target.thrownFlagName, 'i32'),
    right: booleanLiteralExpression(false),
    representation: 'i32',
  };
}

function createReturnCompletionTarget(
  context: FunctionLoweringContext,
  prefix: string,
): SourceSemanticCompletionTarget {
  const returnFlagName = nextTempLocalName(context, `${prefix}_return`);
  const returnValueName = nextTempLocalName(context, `${prefix}_return_value`);
  const returnRepresentation = context.currentResultType
    ? representationForSemanticType(context.currentResultType)
    : 'tagged_ref';
  addLocal(context, returnFlagName, 'i32');
  addLocal(context, returnValueName, returnRepresentation);
  return { returnFlagName, returnValueName, returnRepresentation };
}

function createLoopControlCompletionTarget(
  context: FunctionLoweringContext,
  prefix: string,
  needsBreak: boolean,
  needsContinue: boolean,
): SourceSemanticCompletionTarget {
  const breakFlagName = needsBreak ? nextTempLocalName(context, `${prefix}_break`) : undefined;
  const continueFlagName = needsContinue
    ? nextTempLocalName(context, `${prefix}_continue`)
    : undefined;
  if (breakFlagName) {
    addLocal(context, breakFlagName, 'i32');
  }
  if (continueFlagName) {
    addLocal(context, continueFlagName, 'i32');
  }
  return { breakFlagName, continueFlagName };
}

function initializeReturnCompletionTarget(
  target: SourceSemanticCompletionTarget,
): SemanticStatementIR {
  if (!target.returnFlagName) {
    return { kind: 'unsupported_statement', sourceKind: 'return' };
  }
  return {
    kind: 'local_set',
    name: target.returnFlagName,
    value: booleanLiteralExpression(false),
  };
}

function initializeLoopControlCompletionTarget(
  target: SourceSemanticCompletionTarget,
): readonly SemanticStatementIR[] {
  const statements: SemanticStatementIR[] = [];
  if (target.breakFlagName) {
    statements.push({
      kind: 'local_set',
      name: target.breakFlagName,
      value: booleanLiteralExpression(false),
    });
  }
  if (target.continueFlagName) {
    statements.push({
      kind: 'local_set',
      name: target.continueFlagName,
      value: booleanLiteralExpression(false),
    });
  }
  return statements;
}

function captureReturnCompletion(
  returnStatement: Extract<SourceStatementIR, { kind: 'return' }>,
  target: SourceSemanticCompletionTarget,
  context: FunctionLoweringContext,
  sourceKind: string,
): readonly SemanticStatementIR[] {
  if (!target.returnFlagName || !target.returnValueName || !target.returnRepresentation) {
    context.unsupportedKinds.add(`${sourceKind}_return_value`);
    return [{ kind: 'unsupported_statement', sourceKind }];
  }
  const rawValue = returnStatement.expression
    ? lowerExpression(returnStatement.expression, context)
    : { kind: 'undefined_literal', representation: 'tagged_ref' } as SemanticExpressionIR;
  const value = adaptExpressionToSemanticType(
    rawValue,
    context.currentResultType,
    context,
  ) ?? rawValue;
  if (value.representation !== target.returnRepresentation) {
    context.unsupportedKinds.add(`${sourceKind}_return_value`);
    return [{ kind: 'unsupported_statement', sourceKind }];
  }
  return [
    ...takePendingStatements(context),
    { kind: 'local_set', name: target.returnValueName, value },
    {
      kind: 'local_set',
      name: target.returnFlagName,
      value: booleanLiteralExpression(true),
    },
  ];
}

function captureLoopControlCompletion(
  kind: 'break' | 'continue',
  target: SourceSemanticCompletionTarget,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  const flagName = kind === 'break' ? target.breakFlagName : target.continueFlagName;
  if (!flagName) {
    context.unsupportedKinds.add(`try_finally_${kind}`);
    return [{ kind: 'unsupported_statement', sourceKind: kind }];
  }
  return [{
    kind: 'local_set',
    name: flagName,
    value: booleanLiteralExpression(true),
  }];
}

function dispatchReturnCompletionTarget(
  target: SourceSemanticCompletionTarget,
): SemanticStatementIR {
  if (!target.returnFlagName || !target.returnValueName || !target.returnRepresentation) {
    return { kind: 'unsupported_statement', sourceKind: 'return' };
  }
  return {
    kind: 'if',
    condition: localGetExpression(target.returnFlagName, 'i32'),
    thenBody: [{
      kind: 'return',
      value: localGetExpression(target.returnValueName, target.returnRepresentation),
    }],
    elseBody: [],
  };
}

function dispatchLoopControlCompletionTarget(
  target: SourceSemanticCompletionTarget,
): readonly SemanticStatementIR[] {
  const statements: SemanticStatementIR[] = [];
  if (target.breakFlagName) {
    statements.push({
      kind: 'if',
      condition: localGetExpression(target.breakFlagName, 'i32'),
      thenBody: [{ kind: 'break' }],
      elseBody: [],
    });
  }
  if (target.continueFlagName) {
    statements.push({
      kind: 'if',
      condition: localGetExpression(target.continueFlagName, 'i32'),
      thenBody: [{ kind: 'continue' }],
      elseBody: [],
    });
  }
  return statements;
}

function lowerTryCatchStatement(
  statement: Extract<SourceStatementIR, { kind: 'try' }>,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  const catchBlock = statement.catchBlock;
  const finallyBlock = statement.finallyBlock ?? [];
  if (!catchBlock) {
    context.unsupportedKinds.add('try_catch');
    return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
  }
  const catchReturnIndex = catchBlock.findIndex((child) => child.kind === 'return');
  const catchReturnStatement = catchReturnIndex >= 0
    ? catchBlock[catchReturnIndex] as Extract<SourceStatementIR, { kind: 'return' }>
    : undefined;
  const catchLeadingStatements = catchReturnIndex >= 0
    ? catchBlock.slice(0, catchReturnIndex)
    : catchBlock;
  const catchLoopControlIndex = catchBlock.findIndex((child) =>
    child.kind === 'break' || child.kind === 'continue'
  );
  const catchLoopControlStatement = catchLoopControlIndex >= 0
    ? catchBlock[catchLoopControlIndex] as Extract<
      SourceStatementIR,
      { kind: 'break' | 'continue' }
    >
    : undefined;
  const catchLoopControlLeadingStatements = catchLoopControlIndex >= 0
    ? catchBlock.slice(0, catchLoopControlIndex)
    : catchBlock;
  const catchThrowIndex = catchBlock.findIndex((child) => child.kind === 'throw');
  const catchThrowStatement = catchThrowIndex >= 0
    ? catchBlock[catchThrowIndex] as Extract<SourceStatementIR, { kind: 'throw' }>
    : undefined;
  const catchThrowLeadingStatements = catchThrowIndex >= 0
    ? catchBlock.slice(0, catchThrowIndex)
    : catchBlock;
  const tryReturnIndex = statement.tryBlock.findIndex((child) => child.kind === 'return');
  const tryReturnStatement = tryReturnIndex >= 0
    ? statement.tryBlock[tryReturnIndex] as Extract<SourceStatementIR, { kind: 'return' }>
    : undefined;
  const tryLeadingStatements = tryReturnIndex >= 0
    ? statement.tryBlock.slice(0, tryReturnIndex)
    : statement.tryBlock;
  const tryLoopControlIndex = statement.tryBlock.findIndex((child) =>
    child.kind === 'break' || child.kind === 'continue'
  );
  const tryLoopControlStatement = tryLoopControlIndex >= 0
    ? statement.tryBlock[tryLoopControlIndex] as Extract<
      SourceStatementIR,
      { kind: 'break' | 'continue' }
    >
    : undefined;
  const tryLoopControlLeadingStatements = tryLoopControlIndex >= 0
    ? statement.tryBlock.slice(0, tryLoopControlIndex)
    : statement.tryBlock;
  const supportsTryTerminalReturn = tryReturnStatement !== undefined &&
    statement.tryBlock.length === tryReturnIndex + 1 &&
    !sourceStatementsContainControlTransfer(tryLeadingStatements);
  const supportsCatchTerminalReturn = catchReturnStatement !== undefined &&
    catchBlock.length === catchReturnIndex + 1 &&
    !sourceStatementsContainControlTransfer(catchLeadingStatements);
  if (
    (tryReturnStatement && !supportsTryTerminalReturn) ||
    (catchReturnStatement && !supportsCatchTerminalReturn)
  ) {
    context.unsupportedKinds.add('try_catch_control_flow');
    return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
  }
  const supportsTryReturnThroughFinally = finallyBlock.length > 0 && supportsTryTerminalReturn;
  const supportsCatchReturnThroughFinally = finallyBlock.length > 0 &&
    supportsCatchTerminalReturn;
  const supportsTryTerminalLoopControl = tryLoopControlStatement !== undefined &&
    statement.tryBlock.length === tryLoopControlIndex + 1 &&
    !sourceStatementsContainControlTransfer(tryLoopControlLeadingStatements);
  const supportsTryLoopControlThroughFinally = finallyBlock.length > 0 &&
    supportsTryTerminalLoopControl;
  const supportsCatchLoopControlThroughFinally = finallyBlock.length > 0 &&
    catchLoopControlStatement !== undefined &&
    catchBlock.length === catchLoopControlIndex + 1 &&
    !sourceStatementsContainControlTransfer(catchLoopControlLeadingStatements);
  const supportsCatchThrowThroughFinally = finallyBlock.length > 0 &&
    catchThrowStatement !== undefined &&
    catchBlock.length === catchThrowIndex + 1 &&
    !sourceStatementsContainControlTransfer(catchThrowLeadingStatements) &&
    context.throwTargets.length > 0;
  const supportsReturnThroughFinally = supportsTryReturnThroughFinally ||
    supportsCatchReturnThroughFinally;
  const supportsCatchCompletionThroughFinally = supportsCatchReturnThroughFinally ||
    supportsCatchLoopControlThroughFinally ||
    supportsCatchThrowThroughFinally;
  if (
    finallyBlock.length > 0 &&
    (
      sourceStatementsContainControlTransfer(finallyBlock) ||
      (
        supportsTryReturnThroughFinally ? false : sourceStatementsContainReturn(statement.tryBlock)
      ) ||
      (
        supportsCatchCompletionThroughFinally
          ? false
          : sourceStatementsContainControlTransfer(catchBlock)
      )
    )
  ) {
    context.unsupportedKinds.add('try_catch_finally_control_flow');
    return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
  }
  const catchableTryFlowStatements = supportsTryTerminalLoopControl
    ? tryLoopControlLeadingStatements
    : statement.tryBlock;
  const supportsNestedCatchableTry = catchableTryFlowStatements.length === 1 &&
    catchableTryFlowStatements[0]?.kind === 'try';
  if (
    !supportsNestedCatchableTry &&
    sourceStatementsContainUnsupportedCatchableTryFlow(catchableTryFlowStatements)
  ) {
    context.unsupportedKinds.add('try_catch_control_flow');
    return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
  }
  if (statement.catchBinding && statement.catchBinding.kind !== 'identifier_binding') {
    context.unsupportedKinds.add('try_catch_binding');
    return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
  }

  const thrownFlagName = nextTempLocalName(context, 'try_catch_thrown');
  const thrownHeapName = nextTempLocalName(context, 'try_catch_heap');
  const thrownValueName = nextTempLocalName(context, 'try_catch_value');
  const target: SourceSemanticThrowTarget = { thrownFlagName, thrownHeapName, thrownValueName };
  addLocal(context, thrownFlagName, 'i32');
  addLocal(context, thrownHeapName, 'heap_ref');
  addLocal(context, thrownValueName, 'tagged_ref');
  context.runtimeFamilies.add('finite_union');
  const completionReturnFlagName = supportsReturnThroughFinally
    ? nextTempLocalName(context, 'try_catch_return')
    : undefined;
  const completionReturnValueName = supportsReturnThroughFinally
    ? nextTempLocalName(context, 'try_catch_return_value')
    : undefined;
  const completionReturnRepresentation = supportsReturnThroughFinally
    ? context.currentResultType
      ? representationForSemanticType(context.currentResultType)
      : 'tagged_ref'
    : undefined;
  const completionBreakFlagName =
    (supportsTryLoopControlThroughFinally && tryLoopControlStatement?.kind === 'break') ||
      (supportsCatchLoopControlThroughFinally && catchLoopControlStatement?.kind === 'break')
      ? nextTempLocalName(context, 'try_catch_break')
      : undefined;
  const completionContinueFlagName =
    (supportsTryLoopControlThroughFinally && tryLoopControlStatement?.kind === 'continue') ||
      (supportsCatchLoopControlThroughFinally && catchLoopControlStatement?.kind === 'continue')
      ? nextTempLocalName(context, 'try_catch_continue')
      : undefined;
  if (completionReturnFlagName) {
    addLocal(context, completionReturnFlagName, 'i32');
  }
  if (completionReturnValueName && completionReturnRepresentation) {
    addLocal(context, completionReturnValueName, completionReturnRepresentation);
  }
  if (completionBreakFlagName) {
    addLocal(context, completionBreakFlagName, 'i32');
  }
  if (completionContinueFlagName) {
    addLocal(context, completionContinueFlagName, 'i32');
  }

  const statements: SemanticStatementIR[] = [
    {
      kind: 'local_set',
      name: thrownFlagName,
      value: booleanLiteralExpression(false),
    },
    {
      kind: 'local_set',
      name: thrownHeapName,
      value: { kind: 'heap_null', representation: 'heap_ref' },
    },
    {
      kind: 'local_set',
      name: thrownValueName,
      value: { kind: 'undefined_literal', representation: 'tagged_ref' },
    },
    ...(completionReturnFlagName
      ? [{
        kind: 'local_set' as const,
        name: completionReturnFlagName,
        value: booleanLiteralExpression(false),
      }]
      : []),
    ...(completionBreakFlagName
      ? [{
        kind: 'local_set' as const,
        name: completionBreakFlagName,
        value: booleanLiteralExpression(false),
      }]
      : []),
    ...(completionContinueFlagName
      ? [{
        kind: 'local_set' as const,
        name: completionContinueFlagName,
        value: booleanLiteralExpression(false),
      }]
      : []),
  ];

  const captureReturnStatements = (
    returnStatement: Extract<SourceStatementIR, { kind: 'return' }>,
  ): readonly SemanticStatementIR[] => {
    if (
      !completionReturnFlagName || !completionReturnValueName ||
      !completionReturnRepresentation
    ) {
      context.unsupportedKinds.add('try_catch_return_value');
      return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
    }
    const rawValue = returnStatement.expression
      ? lowerExpression(returnStatement.expression, context)
      : { kind: 'undefined_literal', representation: 'tagged_ref' } as SemanticExpressionIR;
    const value = adaptExpressionToSemanticType(
      rawValue,
      context.currentResultType,
      context,
    ) ?? rawValue;
    if (value.representation !== completionReturnRepresentation) {
      context.unsupportedKinds.add('try_catch_return_value');
      return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
    }
    return [
      ...takePendingStatements(context),
      { kind: 'local_set', name: completionReturnValueName, value },
      {
        kind: 'local_set',
        name: completionReturnFlagName,
        value: booleanLiteralExpression(true),
      },
    ];
  };
  const captureLoopControlStatements = (
    controlStatement: Extract<SourceStatementIR, { kind: 'break' | 'continue' }>,
  ): readonly SemanticStatementIR[] => {
    const flagName = controlStatement.kind === 'break'
      ? completionBreakFlagName
      : completionContinueFlagName;
    if (!flagName) {
      context.unsupportedKinds.add('try_catch_loop_control');
      return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
    }
    return [{
      kind: 'local_set',
      name: flagName,
      value: booleanLiteralExpression(true),
    }];
  };

  context.throwTargets.push(target);
  try {
    const guardedTryStatements = supportsTryTerminalLoopControl
      ? tryLoopControlLeadingStatements
      : tryLeadingStatements;
    for (const child of guardedTryStatements) {
      statements.push({
        kind: 'if',
        condition: catchableTryActiveCondition(target),
        thenBody: [...lowerStatement(child, context)],
        elseBody: [],
      });
    }
    if (supportsTryReturnThroughFinally && tryReturnStatement) {
      statements.push({
        kind: 'if',
        condition: catchableTryActiveCondition(target),
        thenBody: [...captureReturnStatements(tryReturnStatement)],
        elseBody: [],
      });
    } else if (supportsTryTerminalReturn && tryReturnStatement) {
      statements.push({
        kind: 'if',
        condition: catchableTryActiveCondition(target),
        thenBody: [...lowerStatement(tryReturnStatement, context)],
        elseBody: [],
      });
    }
    if (supportsTryLoopControlThroughFinally && tryLoopControlStatement) {
      statements.push({
        kind: 'if',
        condition: catchableTryActiveCondition(target),
        thenBody: [...captureLoopControlStatements(tryLoopControlStatement)],
        elseBody: [],
      });
    } else if (supportsTryTerminalLoopControl && tryLoopControlStatement) {
      statements.push({
        kind: 'if',
        condition: catchableTryActiveCondition(target),
        thenBody: [...lowerStatement(tryLoopControlStatement, context)],
        elseBody: [],
      });
    }
  } finally {
    context.throwTargets.pop();
  }

  const catchStatements: SemanticStatementIR[] = [];
  const catchBindingName = statement.catchBinding?.kind === 'identifier_binding'
    ? statement.catchBinding.name
    : undefined;
  const catchBindingReads = catchBindingName
    ? (() => {
      const reads: string[] = [];
      catchBlock.forEach((child) => collectSourceStatementIdentifierReads(child, reads));
      return reads.includes(catchBindingName);
    })()
    : false;
  if (catchBindingName && catchBindingReads) {
    addLocal(context, catchBindingName, 'heap_ref');
    context.localDeclarationKinds.set(catchBindingName, 'let');
    context.objectLocals.set(catchBindingName, builtinErrorObjectLocal(context));
    catchStatements.push({
      kind: 'local_set',
      name: catchBindingName,
      value: localGetExpression(thrownHeapName, 'heap_ref'),
    });
  }
  const guardedCatchStatements = supportsCatchLoopControlThroughFinally
    ? catchLoopControlLeadingStatements
    : supportsCatchThrowThroughFinally
    ? catchThrowLeadingStatements
    : catchLeadingStatements;
  catchStatements.push(
    ...guardedCatchStatements.flatMap((child) => [...lowerStatement(child, context)]),
  );
  if (
    supportsCatchReturnThroughFinally && catchReturnStatement &&
    completionReturnFlagName && completionReturnValueName && completionReturnRepresentation
  ) {
    catchStatements.push(...captureReturnStatements(catchReturnStatement));
  } else if (supportsCatchTerminalReturn && catchReturnStatement) {
    catchStatements.push(...lowerStatement(catchReturnStatement, context));
  }
  if (supportsCatchLoopControlThroughFinally && catchLoopControlStatement) {
    catchStatements.push(...captureLoopControlStatements(catchLoopControlStatement));
  }
  if (supportsCatchThrowThroughFinally && catchThrowStatement) {
    catchStatements.push(...lowerStatement(catchThrowStatement, context));
  }
  statements.push({
    kind: 'if',
    condition: localGetExpression(thrownFlagName, 'i32'),
    thenBody: catchStatements,
    elseBody: [],
  });
  statements.push(...finallyBlock.flatMap((child) => [...lowerStatement(child, context)]));
  if (completionReturnFlagName && completionReturnValueName && completionReturnRepresentation) {
    const activeCompletionTarget = context.completionTargets.at(-1);
    if (activeCompletionTarget) {
      if (
        !activeCompletionTarget.returnFlagName ||
        !activeCompletionTarget.returnValueName ||
        activeCompletionTarget.returnRepresentation !== completionReturnRepresentation
      ) {
        context.unsupportedKinds.add('try_catch_return_value');
        statements.push({ kind: 'unsupported_statement', sourceKind: 'try' });
      } else {
        statements.push({
          kind: 'if',
          condition: localGetExpression(completionReturnFlagName, 'i32'),
          thenBody: [
            {
              kind: 'local_set',
              name: activeCompletionTarget.returnValueName,
              value: localGetExpression(completionReturnValueName, completionReturnRepresentation),
            },
            {
              kind: 'local_set',
              name: activeCompletionTarget.returnFlagName,
              value: booleanLiteralExpression(true),
            },
          ],
          elseBody: [],
        });
      }
    } else {
      statements.push({
        kind: 'if',
        condition: localGetExpression(completionReturnFlagName, 'i32'),
        thenBody: [{
          kind: 'return',
          value: localGetExpression(completionReturnValueName, completionReturnRepresentation),
        }],
        elseBody: [],
      });
    }
  }
  if (completionBreakFlagName) {
    const activeCompletionTarget = context.completionTargets.at(-1);
    if (activeCompletionTarget) {
      if (!activeCompletionTarget.breakFlagName) {
        context.unsupportedKinds.add('try_catch_loop_control');
        statements.push({ kind: 'unsupported_statement', sourceKind: 'try' });
      } else {
        statements.push({
          kind: 'if',
          condition: localGetExpression(completionBreakFlagName, 'i32'),
          thenBody: [{
            kind: 'local_set',
            name: activeCompletionTarget.breakFlagName,
            value: booleanLiteralExpression(true),
          }],
          elseBody: [],
        });
      }
    } else {
      statements.push({
        kind: 'if',
        condition: localGetExpression(completionBreakFlagName, 'i32'),
        thenBody: [{ kind: 'break' }],
        elseBody: [],
      });
    }
  }
  if (completionContinueFlagName) {
    const activeCompletionTarget = context.completionTargets.at(-1);
    if (activeCompletionTarget) {
      if (!activeCompletionTarget.continueFlagName) {
        context.unsupportedKinds.add('try_catch_loop_control');
        statements.push({ kind: 'unsupported_statement', sourceKind: 'try' });
      } else {
        statements.push({
          kind: 'if',
          condition: localGetExpression(completionContinueFlagName, 'i32'),
          thenBody: [{
            kind: 'local_set',
            name: activeCompletionTarget.continueFlagName,
            value: booleanLiteralExpression(true),
          }],
          elseBody: [],
        });
      }
    } else {
      statements.push({
        kind: 'if',
        condition: localGetExpression(completionContinueFlagName, 'i32'),
        thenBody: [{ kind: 'continue' }],
        elseBody: [],
      });
    }
  }
  return statements;
}

function lowerTryStatement(
  statement: Extract<SourceStatementIR, { kind: 'try' }>,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  if (statement.catchBlock || statement.catchBinding) {
    return lowerTryCatchStatement(statement, context);
  }
  const finallyBlock = statement.finallyBlock ?? [];
  if (sourceStatementsContainControlTransfer(finallyBlock)) {
    context.unsupportedKinds.add('try_finally_control_flow');
    return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
  }
  const loopControlIndex = statement.tryBlock.findIndex((child) =>
    child.kind === 'break' || child.kind === 'continue'
  );
  if (loopControlIndex >= 0) {
    const leadingTryStatements = statement.tryBlock.slice(0, loopControlIndex);
    const controlStatement = statement.tryBlock[loopControlIndex] as Extract<
      SourceStatementIR,
      { kind: 'break' | 'continue' }
    >;
    if (
      statement.tryBlock.length !== loopControlIndex + 1 ||
      sourceStatementsContainControlTransfer(leadingTryStatements)
    ) {
      context.unsupportedKinds.add('try_finally_control_flow');
      return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
    }
    return [
      ...leadingTryStatements.flatMap((child) => [...lowerStatement(child, context)]),
      ...finallyBlock.flatMap((child) => [...lowerStatement(child, context)]),
      ...lowerStatement(controlStatement, context),
    ];
  }
  const returnIndex = statement.tryBlock.findIndex((child) => child.kind === 'return');
  if (returnIndex >= 0) {
    const leadingTryStatements = statement.tryBlock.slice(0, returnIndex);
    const returnStatement = statement.tryBlock[returnIndex] as Extract<
      SourceStatementIR,
      { kind: 'return' }
    >;
    if (
      statement.tryBlock.length !== returnIndex + 1 ||
      sourceStatementsContainControlTransfer(leadingTryStatements)
    ) {
      context.unsupportedKinds.add('try_finally_control_flow');
      return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
    }
    const leadingLoweredStatements = leadingTryStatements.flatMap((child) => [
      ...lowerStatement(child, context),
    ]);
    const activeCompletionTarget = context.completionTargets.at(-1);
    if (activeCompletionTarget) {
      return [
        ...leadingLoweredStatements,
        ...captureReturnCompletion(returnStatement, activeCompletionTarget, context, 'try'),
        ...finallyBlock.flatMap((child) => [...lowerStatement(child, context)]),
      ];
    }
    const rawValue = returnStatement.expression
      ? lowerExpression(returnStatement.expression, context)
      : { kind: 'undefined_literal', representation: 'tagged_ref' } as SemanticExpressionIR;
    const value = adaptExpressionToSemanticType(
      rawValue,
      context.currentResultType,
      context,
    ) ?? rawValue;
    const resultName = nextTempLocalName(context, 'try_finally_return');
    addLocal(context, resultName, value.representation);
    return [
      ...leadingLoweredStatements,
      ...takePendingStatements(context),
      { kind: 'local_set', name: resultName, value },
      ...finallyBlock.flatMap((child) => [...lowerStatement(child, context)]),
      { kind: 'return', value: localGetExpression(resultName, value.representation) },
    ];
  }
  const throwIndex = statement.tryBlock.findIndex((child) => child.kind === 'throw');
  if (throwIndex >= 0) {
    const leadingTryStatements = statement.tryBlock.slice(0, throwIndex);
    const throwStatement = statement.tryBlock[throwIndex] as Extract<
      SourceStatementIR,
      { kind: 'throw' }
    >;
    if (
      statement.tryBlock.length !== throwIndex + 1 ||
      sourceStatementsContainControlTransfer(leadingTryStatements) ||
      !context.throwTargets.at(-1)
    ) {
      context.unsupportedKinds.add('try_finally_control_flow');
      return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
    }
    return [
      ...leadingTryStatements.flatMap((child) => [...lowerStatement(child, context)]),
      ...lowerStatement(throwStatement, context),
      ...finallyBlock.flatMap((child) => [...lowerStatement(child, context)]),
    ];
  }
  if (statement.tryBlock.length === 1 && statement.tryBlock[0]?.kind === 'try') {
    const needsNestedReturn = sourceStatementsContainReturn(statement.tryBlock);
    const needsNestedBreak = sourceStatementsContainLoopControl(statement.tryBlock, 'break');
    const needsNestedContinue = sourceStatementsContainLoopControl(statement.tryBlock, 'continue');
    const completionTarget: SourceSemanticCompletionTarget = {
      ...(needsNestedReturn ? createReturnCompletionTarget(context, 'try_finally_nested') : {}),
      ...(needsNestedBreak || needsNestedContinue
        ? createLoopControlCompletionTarget(
          context,
          'try_finally_nested',
          needsNestedBreak,
          needsNestedContinue,
        )
        : {}),
    };
    if (!needsNestedReturn && !needsNestedBreak && !needsNestedContinue) {
      context.unsupportedKinds.add('try_finally_control_flow');
      return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
    }
    context.completionTargets.push(completionTarget);
    let tryStatements: readonly SemanticStatementIR[];
    try {
      tryStatements = statement.tryBlock.flatMap((child) => [...lowerStatement(child, context)]);
    } finally {
      context.completionTargets.pop();
    }
    return [
      ...(needsNestedReturn ? [initializeReturnCompletionTarget(completionTarget)] : []),
      ...initializeLoopControlCompletionTarget(completionTarget),
      ...tryStatements,
      ...finallyBlock.flatMap((child) => [...lowerStatement(child, context)]),
      ...(needsNestedReturn ? [dispatchReturnCompletionTarget(completionTarget)] : []),
      ...dispatchLoopControlCompletionTarget(completionTarget),
    ];
  }
  if (sourceStatementsContainControlTransfer(statement.tryBlock)) {
    context.unsupportedKinds.add('try_finally_control_flow');
    return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
  }
  return [
    ...statement.tryBlock.flatMap((child) => [...lowerStatement(child, context)]),
    ...finallyBlock.flatMap((child) => [...lowerStatement(child, context)]),
  ];
}

function collectSourceBindingNames(binding: SourceBindingIR, names: Set<string>): void {
  switch (binding.kind) {
    case 'identifier_binding':
      names.add(binding.name);
      break;
    case 'object_binding':
    case 'array_binding':
      binding.elements.forEach((element) => collectSourceBindingNames(element, names));
      break;
    case 'unknown_binding':
      break;
    default: {
      const exhaustiveCheck: never = binding;
      return exhaustiveCheck;
    }
  }
}

function collectSourceStatementDeclaredNames(
  statement: SourceStatementIR,
  names: Set<string>,
): void {
  switch (statement.kind) {
    case 'variable_declaration':
      statement.declarations.forEach((declaration) =>
        collectSourceBindingNames(declaration.binding, names)
      );
      break;
    case 'if':
      statement.consequent.forEach((child) => collectSourceStatementDeclaredNames(child, names));
      statement.alternate.forEach((child) => collectSourceStatementDeclaredNames(child, names));
      break;
    case 'while':
    case 'do_while':
      statement.body.forEach((child) => collectSourceStatementDeclaredNames(child, names));
      break;
    case 'block':
      statement.statements.forEach((child) => collectSourceStatementDeclaredNames(child, names));
      break;
    case 'for':
      if (statement.initializer?.kind === 'variable_declaration') {
        collectSourceStatementDeclaredNames(statement.initializer, names);
      }
      statement.body.forEach((child) => collectSourceStatementDeclaredNames(child, names));
      break;
    case 'for_of':
      if ('kind' in statement.left && statement.left.kind.endsWith('_binding')) {
        collectSourceBindingNames(statement.left as SourceBindingIR, names);
      }
      statement.body.forEach((child) => collectSourceStatementDeclaredNames(child, names));
      break;
    case 'switch':
      statement.clauses.forEach((clause) =>
        clause.statements.forEach((child) => collectSourceStatementDeclaredNames(child, names))
      );
      break;
    case 'try':
      statement.tryBlock.forEach((child) => collectSourceStatementDeclaredNames(child, names));
      if (statement.catchBinding) {
        collectSourceBindingNames(statement.catchBinding, names);
      }
      statement.catchBlock?.forEach((child) => collectSourceStatementDeclaredNames(child, names));
      statement.finallyBlock?.forEach((child) => collectSourceStatementDeclaredNames(child, names));
      break;
    case 'expression_statement':
    case 'return':
    case 'break':
    case 'continue':
    case 'throw':
    case 'unknown_statement':
      break;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function sourceRenamesWithoutBindings(
  renames: ReadonlyMap<string, string>,
  bindings: readonly SourceBindingIR[],
): Map<string, string> {
  const scoped = new Map(renames);
  const names = new Set<string>();
  bindings.forEach((binding) => collectSourceBindingNames(binding, names));
  names.forEach((name) => scoped.delete(name));
  return scoped;
}

function renameSourceBindingNames(
  binding: SourceBindingIR,
  renames: ReadonlyMap<string, string>,
): SourceBindingIR {
  switch (binding.kind) {
    case 'identifier_binding':
      return { ...binding, name: renames.get(binding.name) ?? binding.name };
    case 'object_binding':
      return {
        ...binding,
        elements: binding.elements.map((element) => renameSourceBindingNames(element, renames)),
      };
    case 'array_binding':
      return {
        ...binding,
        elements: binding.elements.map((element) => renameSourceBindingNames(element, renames)),
      };
    case 'unknown_binding':
      return binding;
    default: {
      const exhaustiveCheck: never = binding;
      return exhaustiveCheck;
    }
  }
}

function renameSourceExpressionNames(
  expression: SourceExpressionIR,
  renames: ReadonlyMap<string, string>,
): SourceExpressionIR {
  switch (expression.kind) {
    case 'identifier':
      return { ...expression, name: renames.get(expression.name) ?? expression.name };
    case 'property_access':
      return {
        ...expression,
        object: renameSourceExpressionNames(expression.object, renames),
      };
    case 'element_access':
      return {
        ...expression,
        object: renameSourceExpressionNames(expression.object, renames),
        index: expression.index
          ? renameSourceExpressionNames(expression.index, renames)
          : undefined,
      };
    case 'binary_expression':
    case 'logical_expression':
      return {
        ...expression,
        left: renameSourceExpressionNames(expression.left, renames),
        right: renameSourceExpressionNames(expression.right, renames),
      };
    case 'unary_expression':
    case 'update_expression':
      return {
        ...expression,
        operand: renameSourceExpressionNames(expression.operand, renames),
      };
    case 'conditional_expression':
      return {
        ...expression,
        test: renameSourceExpressionNames(expression.test, renames),
        consequent: renameSourceExpressionNames(expression.consequent, renames),
        alternate: renameSourceExpressionNames(expression.alternate, renames),
      };
    case 'assignment_expression':
      return {
        ...expression,
        left: renameSourceExpressionNames(expression.left, renames),
        right: renameSourceExpressionNames(expression.right, renames),
      };
    case 'call_expression':
    case 'new_expression':
      return {
        ...expression,
        callee: renameSourceExpressionNames(expression.callee, renames),
        args: expression.args.map((arg) => renameSourceExpressionNames(arg, renames)),
      };
    case 'arrow_function': {
      const scopedRenames = sourceRenamesWithoutBindings(renames, expression.params);
      return {
        ...expression,
        body: expression.body.map((statement) =>
          renameSourceStatementNames(statement, scopedRenames)
        ),
      };
    }
    case 'await_expression':
      return {
        ...expression,
        expression: renameSourceExpressionNames(expression.expression, renames),
      };
    case 'array_literal':
      return {
        ...expression,
        elements: expression.elements.map((element) =>
          renameSourceExpressionNames(element, renames)
        ),
      };
    case 'object_literal':
      return {
        ...expression,
        properties: expression.properties.map((property) => ({
          ...property,
          computedName: property.computedName
            ? renameSourceExpressionNames(property.computedName, renames)
            : undefined,
          value: renameSourceExpressionNames(property.value, renames),
        })),
      };
    case 'literal':
    case 'unknown_expression':
      return expression;
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function renameSourceStatementNames(
  statement: SourceStatementIR,
  renames: ReadonlyMap<string, string>,
): SourceStatementIR {
  switch (statement.kind) {
    case 'variable_declaration':
      return {
        ...statement,
        declarations: statement.declarations.map((declaration) => ({
          binding: renameSourceBindingNames(declaration.binding, renames),
          initializer: declaration.initializer
            ? renameSourceExpressionNames(declaration.initializer, renames)
            : undefined,
        })),
      };
    case 'expression_statement':
      return {
        ...statement,
        expression: renameSourceExpressionNames(statement.expression, renames),
      };
    case 'return':
      return {
        ...statement,
        expression: statement.expression
          ? renameSourceExpressionNames(statement.expression, renames)
          : undefined,
      };
    case 'if':
      return {
        ...statement,
        test: renameSourceExpressionNames(statement.test, renames),
        consequent: statement.consequent.map((child) => renameSourceStatementNames(child, renames)),
        alternate: statement.alternate.map((child) => renameSourceStatementNames(child, renames)),
      };
    case 'while':
      return {
        ...statement,
        test: renameSourceExpressionNames(statement.test, renames),
        body: statement.body.map((child) => renameSourceStatementNames(child, renames)),
      };
    case 'do_while':
      return {
        ...statement,
        body: statement.body.map((child) => renameSourceStatementNames(child, renames)),
        test: renameSourceExpressionNames(statement.test, renames),
      };
    case 'for':
      return {
        ...statement,
        initializer: statement.initializer
          ? statement.initializer.kind === 'variable_declaration'
            ? renameSourceStatementNames(
              statement.initializer,
              renames,
            ) as SourceVariableDeclarationStatementIR
            : renameSourceExpressionNames(statement.initializer, renames)
          : undefined,
        test: statement.test ? renameSourceExpressionNames(statement.test, renames) : undefined,
        incrementor: statement.incrementor
          ? renameSourceExpressionNames(statement.incrementor, renames)
          : undefined,
        body: statement.body.map((child) => renameSourceStatementNames(child, renames)),
      };
    case 'for_of':
      return {
        ...statement,
        left: 'kind' in statement.left && statement.left.kind.endsWith('_binding')
          ? renameSourceBindingNames(statement.left as SourceBindingIR, renames)
          : renameSourceExpressionNames(statement.left as SourceExpressionIR, renames),
        right: renameSourceExpressionNames(statement.right, renames),
        body: statement.body.map((child) => renameSourceStatementNames(child, renames)),
      };
    case 'switch':
      return {
        ...statement,
        expression: renameSourceExpressionNames(statement.expression, renames),
        clauses: statement.clauses.map((clause) => ({
          ...clause,
          expression: clause.expression
            ? renameSourceExpressionNames(clause.expression, renames)
            : undefined,
          statements: clause.statements.map((child) => renameSourceStatementNames(child, renames)),
        })),
      };
    case 'throw':
      return {
        ...statement,
        expression: renameSourceExpressionNames(statement.expression, renames),
      };
    case 'try':
      return {
        ...statement,
        tryBlock: statement.tryBlock.map((child) => renameSourceStatementNames(child, renames)),
        catchBinding: statement.catchBinding
          ? renameSourceBindingNames(statement.catchBinding, renames)
          : undefined,
        catchBlock: statement.catchBlock?.map((child) =>
          renameSourceStatementNames(child, renames)
        ),
        finallyBlock: statement.finallyBlock?.map((child) =>
          renameSourceStatementNames(child, renames)
        ),
      };
    case 'block':
      return {
        ...statement,
        statements: statement.statements.map((child) => renameSourceStatementNames(child, renames)),
      };
    case 'break':
    case 'continue':
    case 'unknown_statement':
      return statement;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function collectSourceExpressionIdentifierReads(
  expression: SourceExpressionIR,
  names: string[],
): void {
  switch (expression.kind) {
    case 'identifier':
      if (expression.role === 'read') {
        names.push(expression.name);
      }
      break;
    case 'property_access':
      collectSourceExpressionIdentifierReads(expression.object, names);
      break;
    case 'element_access':
      collectSourceExpressionIdentifierReads(expression.object, names);
      if (expression.index) {
        collectSourceExpressionIdentifierReads(expression.index, names);
      }
      break;
    case 'binary_expression':
    case 'logical_expression':
      collectSourceExpressionIdentifierReads(expression.left, names);
      collectSourceExpressionIdentifierReads(expression.right, names);
      break;
    case 'unary_expression':
    case 'update_expression':
      collectSourceExpressionIdentifierReads(expression.operand, names);
      break;
    case 'await_expression':
      collectSourceExpressionIdentifierReads(expression.expression, names);
      break;
    case 'conditional_expression':
      collectSourceExpressionIdentifierReads(expression.test, names);
      collectSourceExpressionIdentifierReads(expression.consequent, names);
      collectSourceExpressionIdentifierReads(expression.alternate, names);
      break;
    case 'assignment_expression':
      collectSourceExpressionIdentifierReads(expression.left, names);
      collectSourceExpressionIdentifierReads(expression.right, names);
      break;
    case 'call_expression':
    case 'new_expression':
      collectSourceExpressionIdentifierReads(expression.callee, names);
      expression.args.forEach((arg) => collectSourceExpressionIdentifierReads(arg, names));
      break;
    case 'array_literal':
      expression.elements.forEach((element) =>
        collectSourceExpressionIdentifierReads(element, names)
      );
      break;
    case 'object_literal':
      expression.properties.forEach((property) => {
        if (property.computedName) {
          collectSourceExpressionIdentifierReads(property.computedName, names);
        }
        collectSourceExpressionIdentifierReads(property.value, names);
      });
      break;
    case 'arrow_function':
      break;
    case 'literal':
    case 'unknown_expression':
      break;
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function collectSourceStatementIdentifierReads(
  statement: SourceStatementIR,
  names: string[],
): void {
  switch (statement.kind) {
    case 'variable_declaration':
      statement.declarations.forEach((declaration) => {
        if (declaration.initializer) {
          collectSourceExpressionIdentifierReads(declaration.initializer, names);
        }
      });
      break;
    case 'expression_statement':
      collectSourceExpressionIdentifierReads(statement.expression, names);
      break;
    case 'return':
      if (statement.expression) {
        collectSourceExpressionIdentifierReads(statement.expression, names);
      }
      break;
    case 'if':
      collectSourceExpressionIdentifierReads(statement.test, names);
      statement.consequent.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      statement.alternate.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      break;
    case 'while':
      collectSourceExpressionIdentifierReads(statement.test, names);
      statement.body.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      break;
    case 'do_while':
      statement.body.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      collectSourceExpressionIdentifierReads(statement.test, names);
      break;
    case 'for':
      if (statement.initializer?.kind === 'variable_declaration') {
        collectSourceStatementIdentifierReads(statement.initializer, names);
      } else if (statement.initializer) {
        collectSourceExpressionIdentifierReads(statement.initializer, names);
      }
      if (statement.test) {
        collectSourceExpressionIdentifierReads(statement.test, names);
      }
      if (statement.incrementor) {
        collectSourceExpressionIdentifierReads(statement.incrementor, names);
      }
      statement.body.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      break;
    case 'for_of':
      if (!('kind' in statement.left && statement.left.kind.endsWith('_binding'))) {
        collectSourceExpressionIdentifierReads(statement.left as SourceExpressionIR, names);
      }
      collectSourceExpressionIdentifierReads(statement.right, names);
      statement.body.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      break;
    case 'switch':
      collectSourceExpressionIdentifierReads(statement.expression, names);
      statement.clauses.forEach((clause) => {
        if (clause.expression) {
          collectSourceExpressionIdentifierReads(clause.expression, names);
        }
        clause.statements.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      });
      break;
    case 'throw':
      collectSourceExpressionIdentifierReads(statement.expression, names);
      break;
    case 'try':
      statement.tryBlock.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      statement.catchBlock?.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      statement.finallyBlock?.forEach((child) =>
        collectSourceStatementIdentifierReads(child, names)
      );
      break;
    case 'block':
      statement.statements.forEach((child) => collectSourceStatementIdentifierReads(child, names));
      break;
    case 'break':
    case 'continue':
    case 'unknown_statement':
      break;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function sourceClosureCaptures(
  expression: Extract<SourceExpressionIR, { kind: 'arrow_function' }>,
  parentContext: FunctionLoweringContext,
):
  | readonly {
    name: string;
    value: SemanticExpressionIR;
    valueType: CompilerValueType;
  }[]
  | undefined {
  const paramNames = new Set<string>();
  expression.params.forEach((param) => collectSourceBindingNames(param, paramNames));
  const localNames = new Set<string>();
  expression.body.forEach((statement) =>
    collectSourceStatementDeclaredNames(statement, localNames)
  );
  const reads: string[] = [];
  expression.body.forEach((statement) => collectSourceStatementIdentifierReads(statement, reads));
  const seen = new Set<string>();
  const captures: {
    name: string;
    value: SemanticExpressionIR;
    valueType: CompilerValueType;
  }[] = [];
  let supported = true;
  for (const name of reads) {
    if (seen.has(name) || paramNames.has(name) || localNames.has(name)) {
      continue;
    }
    seen.add(name);
    const representation = parentContext.localRepresentations.get(name);
    if (!representation) {
      continue;
    }
    const existingBoxedValueType = parentContext.boxedLocals.get(name);
    if (!existingBoxedValueType && parentContext.localDeclarationKinds.get(name) !== 'const') {
      parentContext.unsupportedKinds.add(`mutable_closure_capture:${name}`);
      supported = false;
      continue;
    }
    const valueType = existingBoxedValueType ?? representation;
    let value: SemanticExpressionIR;
    if (existingBoxedValueType) {
      value = {
        kind: 'local_get',
        name,
        representation: 'box_ref',
      };
    } else {
      value = {
        kind: 'box_new',
        value: { kind: 'local_get', name, representation },
        valueType,
        representation: 'box_ref',
      };
    }
    captures.push({ name, value, valueType });
  }
  return supported ? captures : undefined;
}

function lowerArrowFunctionExpression(
  expression: Extract<SourceExpressionIR, { kind: 'arrow_function' }>,
  closureType: SemanticTypeIR | undefined,
  parentContext: FunctionLoweringContext,
): Extract<SemanticExpressionIR, { kind: 'closure_literal' }> | undefined {
  const signatureType = singleSignatureClosureType(closureType);
  if (!signatureType || signatureType.params.length !== expression.params.length) {
    parentContext.unsupportedKinds.add('arrow_function_signature');
    return undefined;
  }
  const closureSignature = createClosureSignature(
    parentContext.moduleState,
    signatureType.params,
    signatureType.result,
  );
  const closureFunctionId = parentContext.moduleState.nextClosureFunctionId;
  parentContext.moduleState.nextClosureFunctionId += 1;

  const localRepresentations = new Map<string, CompilerValueType>();
  const arrayLocals = new Map<string, SourceSemanticArrayLocal>();
  const boxedLocals = new Map<string, CompilerValueType>();
  const localDeclarationKinds = new Map<string, SourceSemanticLocalDeclarationKind>();
  const params = expression.params.map((binding, index) => {
    const type = signatureType.params[index]!;
    const representation = representationForSemanticType(type);
    const name = binding.kind === 'identifier_binding'
      ? binding.name
      : `__source_closure_param_${index}`;
    localRepresentations.set(name, representation);
    localDeclarationKinds.set(name, 'param');
    const arrayLocal = arrayLocalInfoForSemanticType(type);
    if (arrayLocal) {
      arrayLocals.set(name, arrayLocal);
    }
    if (binding.kind !== 'identifier_binding') {
      parentContext.unsupportedKinds.add('arrow_function_parameter');
    }
    return { name, representation };
  });
  const captures = sourceClosureCaptures(expression, parentContext);
  if (!captures) {
    return undefined;
  }
  const captureParams = captures.map((capture) => {
    localRepresentations.set(capture.name, 'box_ref');
    boxedLocals.set(capture.name, capture.valueType);
    localDeclarationKinds.set(capture.name, 'capture');
    return { name: capture.name, representation: 'box_ref' as const };
  });

  const unsupportedKinds = new Set<string>();
  const closureContext: FunctionLoweringContext = {
    functionName: `closure_source_${parentContext.functionName}_${closureFunctionId}`,
    asyncFunction: false,
    currentResultType: signatureType.result,
    functionResultArrayLocals: parentContext.functionResultArrayLocals,
    functionParamTypes: parentContext.functionParamTypes,
    functionResultRepresentations: parentContext.functionResultRepresentations,
    functionResultTypes: parentContext.functionResultTypes,
    localRepresentations,
    locals: [],
    arrayLocals,
    boxedLocals,
    closureLocals: new Map(),
    constructorLocals: new Map(),
    localDeclarationKinds,
    localTypesByKey: new Map(),
    mapLocals: new Map(),
    moduleState: parentContext.moduleState,
    objectLayoutsByKey: parentContext.objectLayoutsByKey,
    objectLocals: new Map(),
    setLocals: new Map(),
    unionLocals: new Map(),
    classesByName: parentContext.classesByName,
    pendingStatements: [],
    runtimeFamilies: new Set(),
    stringLiteralIds: parentContext.stringLiteralIds,
    stringLiterals: parentContext.stringLiterals,
    switchBreakLocalStack: [],
    throwTargets: [],
    completionTargets: [],
    tempIndex: 0,
    unsupportedKinds,
  };
  for (const [index, paramType] of signatureType.params.entries()) {
    const param = params[index];
    if (!param) {
      continue;
    }
    const objectLocal = objectLocalForParameterType(paramType, closureContext);
    if (objectLocal) {
      closureContext.objectLocals.set(param.name, objectLocal);
    }
    const mapLocal = mapLocalInfoForSemanticType(paramType);
    if (mapLocal) {
      closureContext.mapLocals.set(param.name, mapLocal);
    }
    const setLocal = setLocalInfoForSemanticType(paramType);
    if (setLocal) {
      closureContext.setLocals.set(param.name, setLocal);
    }
    const closureLocal = closureLocalForSemanticType(paramType, closureContext);
    if (closureLocal) {
      closureContext.closureLocals.set(param.name, closureLocal);
    }
  }
  const body = [
    ...expression.body.flatMap((statement) => [...lowerStatement(statement, closureContext)]),
    { kind: 'trap' } as SemanticStatementIR,
  ];
  const unsupportedBodyKinds = [...unsupportedKinds].sort();
  const runtimeFamilies = collectSemanticRuntimeFamiliesFromTypes([
    ...signatureType.params,
    signatureType.result,
  ]);
  const functionRuntimeFamilies = [
    ...new Set([...runtimeFamilies, ...closureContext.runtimeFamilies]),
  ]
    .sort();
  parentContext.moduleState.generatedFunctions.push({
    name: closureContext.functionName,
    exportName: '',
    params: [...captureParams, ...params],
    locals: closureContext.locals,
    result: representationForSemanticType(signatureType.result),
    body,
    bodyStatus: unsupportedBodyKinds.length === 0 ? 'emittable' : 'stub',
    unsupportedBodyKinds,
    runtimeFamilies: functionRuntimeFamilies,
    hostImported: false,
    hostExported: false,
    unionBoundaries: [],
    closureFunctionId,
    closureSignatureId: closureSignature.id,
    closureCaptureCount: captures.length,
    closureCaptureValueTypes: captures.map((capture) => capture.valueType),
  });

  parentContext.runtimeFamilies.add('closure');
  return {
    kind: 'closure_literal',
    functionId: closureFunctionId,
    signatureId: closureSignature.id,
    captures: captures.map((capture) => capture.value),
    captureValueTypes: captures.map((capture) => capture.valueType),
    representation: 'closure_ref',
  };
}

function addInlineSourceName(
  context: FunctionLoweringContext,
  renames: Map<string, string>,
  transientNames: string[],
  sourceName: string,
  prefix: string,
): string {
  const existing = renames.get(sourceName);
  if (existing) {
    return existing;
  }
  const internalName = nextTempLocalName(context, prefix);
  renames.set(sourceName, internalName);
  transientNames.push(internalName);
  return internalName;
}

function rejectUnsupportedClassRuntimeHeritage(
  classInfo: SourceClassIR,
  context: FunctionLoweringContext,
): boolean {
  const runtimeHeritage = classInfo.heritage.find((heritage) => heritage.kind === 'extends');
  if (!runtimeHeritage) {
    return false;
  }
  context.unsupportedKinds.add(`class_heritage:${classInfo.name}`);
  return true;
}

function rejectUnsupportedClassMembers(
  classInfo: SourceClassIR,
  context: FunctionLoweringContext,
): boolean {
  const privateMember = classInfo.members.find((member) => member.privacy === 'private');
  if (privateMember) {
    context.unsupportedKinds.add(`class_member:private:${classInfo.name}.${privateMember.name}`);
    return true;
  }
  const computedMember = classInfo.members.find((member) =>
    'computedName' in member && member.computedName !== undefined
  );
  if (computedMember) {
    context.unsupportedKinds.add(`class_member:computed:${classInfo.name}`);
    return true;
  }
  const staticBlock = classInfo.members.find((member) => member.kind === 'static_block');
  if (staticBlock) {
    context.unsupportedKinds.add(`class_member:static_block:${classInfo.name}`);
    return true;
  }
  const autoAccessor = classInfo.members.find((member) => member.kind === 'auto_accessor');
  if (autoAccessor) {
    context.unsupportedKinds.add(
      `class_member:auto_accessor:${classInfo.name}.${autoAccessor.name}`,
    );
    return true;
  }
  const accessor = classInfo.members.find((member) =>
    member.kind === 'getter' || member.kind === 'setter'
  );
  if (accessor) {
    context.unsupportedKinds.add(`class_member:${accessor.kind}`);
    return true;
  }
  return false;
}

function lowerClassConstructionDeclaration(
  targetName: string,
  initializer: Extract<SourceExpressionIR, { kind: 'new_expression' }>,
  declarationKind: SourceSemanticLocalDeclarationKind,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] | undefined {
  const className = classNameForConstructorExpression(initializer.callee, context);
  if (!className) {
    context.unsupportedKinds.add('class_constructor_callee');
    return undefined;
  }
  const classInfo = context.classesByName.get(className);
  if (!classInfo) {
    return undefined;
  }
  if (rejectUnsupportedClassRuntimeHeritage(classInfo, context)) {
    return undefined;
  }
  if (rejectUnsupportedClassMembers(classInfo, context)) {
    return undefined;
  }
  const properties = classInfo.members.filter((
    member,
  ): member is Extract<SourceClassMemberIR, { kind: 'property' }> =>
    member.kind === 'property' && !member.static
  );
  if (properties.some((property) => !property.initializer)) {
    context.unsupportedKinds.add('class_property_initializer');
    return undefined;
  }
  const constructor = classInfo.members.find((member) => member.kind === 'constructor');
  if (constructor && constructor.params.length !== initializer.args.length) {
    context.unsupportedKinds.add('class_constructor_arity');
    return undefined;
  }

  const statements: SemanticStatementIR[] = [];
  const fieldValueNames: string[] = [];
  const fields: { name: string; representation: CompilerValueType }[] = [];
  for (const property of properties) {
    if (!property.initializer) {
      continue;
    }
    const value = lowerExpression(property.initializer, context);
    statements.push(...takePendingStatements(context));
    const valueName = nextTempLocalName(context, `class_${classInfo.name}_${property.name}`);
    addLocal(context, valueName, value.representation);
    statements.push({ kind: 'local_set', name: valueName, value });
    fieldValueNames.push(valueName);
    fields.push({ name: property.name, representation: value.representation });
  }
  const objectLocal: SourceSemanticObjectLocal = {
    family: 'specialized_object',
    representationName: registerSpecializedObjectLayout(context, fields),
    className: classInfo.name,
    fields,
  };
  addLocal(context, targetName, 'heap_ref');
  context.localDeclarationKinds.set(targetName, declarationKind);
  context.objectLocals.set(targetName, objectLocal);
  statements.push({
    kind: 'specialized_object_new',
    targetName,
    representationName: objectLocal.representationName,
    fieldValueNames,
  });

  if (!constructor) {
    return statements;
  }

  const renames = new Map<string, string>();
  const transientNames: string[] = [];
  const receiverName = addInlineSourceName(
    context,
    renames,
    transientNames,
    'this',
    `constructor_${classInfo.name}_this`,
  );
  const constructorLocalNames = new Set<string>();
  constructor.body.forEach((statement) =>
    collectSourceStatementDeclaredNames(statement, constructorLocalNames)
  );
  const params: { internalName: string; value: SemanticExpressionIR }[] = [];
  for (const [index, param] of constructor.params.entries()) {
    if (param.kind !== 'identifier_binding') {
      context.unsupportedKinds.add('class_constructor_parameter');
      return undefined;
    }
    const arg = initializer.args[index];
    if (!arg) {
      context.unsupportedKinds.add('class_constructor_argument');
      return undefined;
    }
    const value = lowerExpression(arg, context);
    statements.push(...takePendingStatements(context));
    params.push({
      internalName: addInlineSourceName(
        context,
        renames,
        transientNames,
        param.name,
        `constructor_${classInfo.name}_${param.name}`,
      ),
      value,
    });
  }
  constructorLocalNames.forEach((name) =>
    addInlineSourceName(
      context,
      renames,
      transientNames,
      name,
      `constructor_${classInfo.name}_${name}`,
    )
  );
  if (
    transientNames.includes(targetName) ||
    transientNames.some((name) => contextHasSourceBinding(context, name))
  ) {
    context.unsupportedKinds.add('class_constructor_binding_collision');
    return undefined;
  }
  for (const param of params) {
    addLocal(context, param.internalName, param.value.representation);
    context.localDeclarationKinds.set(param.internalName, 'param');
    statements.push({ kind: 'local_set', name: param.internalName, value: param.value });
  }
  addLocal(context, receiverName, 'heap_ref');
  context.localDeclarationKinds.set(receiverName, 'param');
  context.objectLocals.set(receiverName, objectLocal);
  statements.push({
    kind: 'local_set',
    name: receiverName,
    value: { kind: 'local_get', name: targetName, representation: 'heap_ref' },
  });
  statements.push(
    ...constructor.body.flatMap((statement) => [
      ...lowerStatement(renameSourceStatementNames(statement, renames), context),
    ]),
  );
  for (const name of transientNames) {
    context.localRepresentations.delete(name);
    context.arrayLocals.delete(name);
    context.boxedLocals.delete(name);
    context.closureLocals.delete(name);
    context.constructorLocals.delete(name);
    context.localDeclarationKinds.delete(name);
    context.objectLocals.delete(name);
  }
  return statements;
}

function clearTransientSourceBindings(
  context: FunctionLoweringContext,
  names: readonly string[],
): void {
  for (const name of names) {
    context.localRepresentations.delete(name);
    context.arrayLocals.delete(name);
    context.boxedLocals.delete(name);
    context.closureLocals.delete(name);
    context.constructorLocals.delete(name);
    context.localDeclarationKinds.delete(name);
    context.objectLocals.delete(name);
  }
}

function lowerClassStaticPropertyAccessExpression(
  expression: Extract<SourceExpressionIR, { kind: 'property_access' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (expression.object.kind !== 'identifier') {
    return undefined;
  }
  const classInfo = context.classesByName.get(expression.object.name);
  if (!classInfo) {
    return undefined;
  }
  if (rejectUnsupportedClassRuntimeHeritage(classInfo, context)) {
    return undefined;
  }
  if (rejectUnsupportedClassMembers(classInfo, context)) {
    return undefined;
  }
  const property = classInfo.members.find((
    member,
  ): member is Extract<SourceClassMemberIR, { kind: 'property' }> =>
    member.kind === 'property' && member.static && member.name === expression.property
  );
  if (!property) {
    return undefined;
  }
  if (!property.initializer) {
    context.unsupportedKinds.add(`static_class_property:${classInfo.name}.${property.name}`);
    return undefined;
  }
  return lowerExpression(property.initializer, context);
}

function lowerClassStaticMethodCallExpression(
  expression: Extract<SourceExpressionIR, { kind: 'call_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (expression.callee.kind !== 'property_access') {
    return undefined;
  }
  const callee = expression.callee;
  if (callee.object.kind !== 'identifier') {
    return undefined;
  }
  const classInfo = context.classesByName.get(callee.object.name);
  if (classInfo && rejectUnsupportedClassRuntimeHeritage(classInfo, context)) {
    return undefined;
  }
  if (classInfo && rejectUnsupportedClassMembers(classInfo, context)) {
    return undefined;
  }
  const method = classInfo?.members.find((
    member,
  ): member is Extract<SourceClassMemberIR, { kind: 'method' }> =>
    member.kind === 'method' && member.static && member.name === callee.property
  );
  if (!classInfo || !method) {
    return undefined;
  }
  if (method.params.length !== expression.args.length) {
    context.unsupportedKinds.add(`static_class_method_arity:${classInfo.name}.${method.name}`);
    return undefined;
  }
  const returnStatement = method.body[method.body.length - 1];
  if (
    !returnStatement || returnStatement.kind !== 'return' ||
    !returnStatement.expression
  ) {
    context.unsupportedKinds.add(`static_class_method_body:${classInfo.name}.${method.name}`);
    return undefined;
  }
  const preludeStatements = method.body.slice(0, -1);
  if (sourceStatementsContainControlTransfer(preludeStatements)) {
    context.unsupportedKinds.add(
      `static_class_method_control_flow:${classInfo.name}.${method.name}`,
    );
    return undefined;
  }
  const paramBindings: { internalName: string }[] = [];
  const renames = new Map<string, string>();
  const transientNames: string[] = [];
  for (const param of method.params) {
    if (param.kind !== 'identifier_binding') {
      context.unsupportedKinds.add(`static_class_method_parameter:${method.name}`);
      return undefined;
    }
    paramBindings.push({
      internalName: addInlineSourceName(
        context,
        renames,
        transientNames,
        param.name,
        `static_method_${method.name}_${param.name}`,
      ),
    });
  }
  const methodLocalNames = new Set<string>();
  preludeStatements.forEach((statement) =>
    collectSourceStatementDeclaredNames(statement, methodLocalNames)
  );
  methodLocalNames.forEach((name) =>
    addInlineSourceName(
      context,
      renames,
      transientNames,
      name,
      `static_method_${method.name}_${name}`,
    )
  );
  if (
    transientNames.includes(classInfo.name) ||
    transientNames.some((name) => contextHasSourceBinding(context, name))
  ) {
    context.unsupportedKinds.add(`static_class_method_binding_collision:${method.name}`);
    return undefined;
  }

  const statements: SemanticStatementIR[] = [];
  for (const [index, param] of paramBindings.entries()) {
    const arg = expression.args[index];
    if (!arg) {
      context.unsupportedKinds.add(`static_class_method_argument:${method.name}`);
      return undefined;
    }
    const value = lowerExpression(arg, context);
    statements.push(...takePendingStatements(context));
    addLocal(context, param.internalName, value.representation);
    context.localDeclarationKinds.set(param.internalName, 'param');
    statements.push({ kind: 'local_set', name: param.internalName, value });
  }
  statements.push(
    ...preludeStatements.flatMap((statement) => [
      ...lowerStatement(renameSourceStatementNames(statement, renames), context),
    ]),
  );
  const result = lowerExpression(
    renameSourceExpressionNames(returnStatement.expression, renames),
    context,
  );
  statements.push(...takePendingStatements(context));
  const resultName = nextTempLocalName(context, `static_method_${method.name}_result`);
  addLocal(context, resultName, result.representation);
  statements.push({ kind: 'local_set', name: resultName, value: result });
  clearTransientSourceBindings(context, transientNames);
  context.pendingStatements.push(...statements);
  return { kind: 'local_get', name: resultName, representation: result.representation };
}

function lowerClassMethodCallExpression(
  expression: Extract<SourceExpressionIR, { kind: 'call_expression' }>,
  context: FunctionLoweringContext,
): SemanticExpressionIR | undefined {
  if (expression.callee.kind !== 'property_access') {
    return undefined;
  }
  const callee = expression.callee;
  const receiver = materializeClassMethodReceiver(callee.object, context);
  if (!receiver) {
    return undefined;
  }
  const objectName = receiver.objectName;
  const objectLocal = context.objectLocals.get(objectName);
  const className = objectLocal?.className;
  const classInfo = className ? context.classesByName.get(className) : undefined;
  if (classInfo && rejectUnsupportedClassRuntimeHeritage(classInfo, context)) {
    return undefined;
  }
  if (classInfo && rejectUnsupportedClassMembers(classInfo, context)) {
    return undefined;
  }
  const method = classInfo?.members.find((
    member,
  ): member is Extract<SourceClassMemberIR, { kind: 'method' }> =>
    member.kind === 'method' && !member.static && member.name === callee.property
  );
  if (!objectLocal || !classInfo || !method) {
    return undefined;
  }
  if (method.params.length !== expression.args.length) {
    context.unsupportedKinds.add(`class_method_arity:${method.name}`);
    return undefined;
  }
  const returnStatement = method.body[method.body.length - 1];
  if (
    !returnStatement || returnStatement.kind !== 'return' ||
    !returnStatement.expression
  ) {
    context.unsupportedKinds.add(`class_method_body:${method.name}`);
    return undefined;
  }
  const preludeStatements = method.body.slice(0, -1);
  if (sourceStatementsContainControlTransfer(preludeStatements)) {
    context.unsupportedKinds.add(`class_method_control_flow:${method.name}`);
    return undefined;
  }
  const renames = new Map<string, string>();
  const transientNames: string[] = [];
  const receiverName = addInlineSourceName(
    context,
    renames,
    transientNames,
    'this',
    `method_${method.name}_this`,
  );
  const paramBindings: { internalName: string }[] = [];
  for (const param of method.params) {
    if (param.kind !== 'identifier_binding') {
      context.unsupportedKinds.add(`class_method_parameter:${method.name}`);
      return undefined;
    }
    paramBindings.push({
      internalName: addInlineSourceName(
        context,
        renames,
        transientNames,
        param.name,
        `method_${method.name}_${param.name}`,
      ),
    });
  }
  const methodLocalNames = new Set<string>();
  preludeStatements.forEach((statement) =>
    collectSourceStatementDeclaredNames(statement, methodLocalNames)
  );
  methodLocalNames.forEach((name) =>
    addInlineSourceName(context, renames, transientNames, name, `method_${method.name}_${name}`)
  );
  if (
    transientNames.includes(objectName) ||
    transientNames.some((name) => contextHasSourceBinding(context, name))
  ) {
    context.unsupportedKinds.add(`class_method_binding_collision:${method.name}`);
    return undefined;
  }
  const statements: SemanticStatementIR[] = [...receiver.statements];
  for (const [index, param] of paramBindings.entries()) {
    const arg = expression.args[index];
    if (!arg) {
      context.unsupportedKinds.add(`class_method_argument:${method.name}`);
      return undefined;
    }
    const value = lowerExpression(arg, context);
    statements.push(...takePendingStatements(context));
    addLocal(context, param.internalName, value.representation);
    context.localDeclarationKinds.set(param.internalName, 'param');
    statements.push({ kind: 'local_set', name: param.internalName, value });
  }
  addLocal(context, receiverName, 'heap_ref');
  context.localDeclarationKinds.set(receiverName, 'param');
  context.objectLocals.set(receiverName, objectLocal);
  statements.push({
    kind: 'local_set',
    name: receiverName,
    value: { kind: 'local_get', name: objectName, representation: 'heap_ref' },
  });
  statements.push(
    ...preludeStatements.flatMap((statement) => [
      ...lowerStatement(renameSourceStatementNames(statement, renames), context),
    ]),
  );
  const result = lowerExpression(
    renameSourceExpressionNames(returnStatement.expression, renames),
    context,
  );
  statements.push(...takePendingStatements(context));
  const resultName = nextTempLocalName(context, `method_${method.name}_result`);
  addLocal(context, resultName, result.representation);
  statements.push({ kind: 'local_set', name: resultName, value: result });
  clearTransientSourceBindings(context, transientNames);
  context.pendingStatements.push(...statements);
  return { kind: 'local_get', name: resultName, representation: result.representation };
}

function materializeClassMethodReceiver(
  expression: SourceExpressionIR,
  context: FunctionLoweringContext,
): { objectName: string; statements: SemanticStatementIR[] } | undefined {
  if (expression.kind === 'identifier') {
    return { objectName: expression.name, statements: [] };
  }
  if (expression.kind !== 'new_expression') {
    const receiver = lowerExpression(expression, context);
    const objectLayout = objectLocalInfoForRead(expression, receiver, context);
    return objectLayout
      ? materializeObjectExpressionForRead(
        receiver,
        objectLayout,
        context,
        'method_receiver',
      )
      : undefined;
  }
  const receiver = lowerExpression(expression, context);
  const objectLayout = objectLocalInfoForRead(expression, receiver, context);
  if (!objectLayout) {
    return undefined;
  }
  return materializeObjectExpressionForRead(
    receiver,
    objectLayout,
    context,
    'method_receiver',
  );
}

function lowerStatement(
  statement: SourceStatementIR,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  switch (statement.kind) {
    case 'variable_declaration': {
      return statement.declarations.flatMap((declaration): SemanticStatementIR[] => {
        if (declaration.binding.kind === 'object_binding' && declaration.initializer) {
          const initializer = lowerExpression(declaration.initializer, context);
          const objectLayout = objectLocalInfoForRead(
            declaration.initializer,
            initializer,
            context,
          );
          if (!objectLayout || initializer.representation !== 'heap_ref') {
            context.unsupportedKinds.add('object_binding');
            return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
          }
          const materialized = materializeObjectExpressionForRead(
            initializer,
            objectLayout,
            context,
            'object_binding',
          );
          const bindingStatements = lowerObjectBindingFromLocal(
            declaration.binding,
            materialized.objectName,
            objectLayout,
            context,
            'variable_declaration',
          );
          if (!bindingStatements) {
            return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
          }
          return [...materialized.statements, ...bindingStatements];
        }
        if (declaration.binding.kind === 'array_binding' && declaration.initializer) {
          const initializer = lowerExpression(declaration.initializer, context);
          const statements = takePendingStatements(context);
          const arrayLocal = arrayLocalInfoForRead(declaration.initializer, initializer, context);
          if (!arrayLocal) {
            context.unsupportedKinds.add('array_binding');
            return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
          }
          const arrayName = nextTempLocalName(context, 'array_binding');
          addLocal(context, arrayName, initializer.representation);
          context.arrayLocals.set(arrayName, arrayLocal);
          statements.push({ kind: 'local_set', name: arrayName, value: initializer });
          const bindingStatements = lowerArrayBindingFromLocal(
            declaration.binding,
            arrayName,
            initializer.representation,
            arrayLocal,
            context,
            'variable_declaration',
          );
          if (!bindingStatements) {
            return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
          }
          return [...statements, ...bindingStatements];
        }
        if (declaration.binding.kind !== 'identifier_binding' || !declaration.initializer) {
          context.unsupportedKinds.add('variable_declaration');
          return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
        }
        if (
          statement.declarationKind === 'const' &&
          declaration.initializer.kind === 'identifier'
        ) {
          const className = classNameForConstructorExpression(declaration.initializer, context);
          if (className) {
            context.constructorLocals.set(declaration.binding.name, { className });
            context.localDeclarationKinds.set(
              declaration.binding.name,
              statement.declarationKind,
            );
            return [];
          }
        }
        if (declaration.initializer.kind === 'new_expression') {
          const localType = localTypeForBinding(declaration.binding, context);
          if (
            declaration.initializer.callee.kind === 'identifier' &&
            declaration.initializer.callee.name === 'Map'
          ) {
            const mapLocal = mapLocalInfoForSemanticType(localType);
            if (!mapLocal) {
              context.unsupportedKinds.add('map_new');
              return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
            }
            addLocal(context, declaration.binding.name, 'heap_ref');
            context.localDeclarationKinds.set(
              declaration.binding.name,
              statement.declarationKind,
            );
            context.mapLocals.set(declaration.binding.name, mapLocal);
            context.runtimeFamilies.add('map');
            return [{
              kind: 'map_new',
              targetName: declaration.binding.name,
              storage: true,
            }];
          }
          if (
            declaration.initializer.callee.kind === 'identifier' &&
            declaration.initializer.callee.name === 'Set'
          ) {
            const setLocal = setLocalInfoForSemanticType(localType);
            if (!setLocal) {
              context.unsupportedKinds.add('set_new');
              return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
            }
            addLocal(context, declaration.binding.name, 'heap_ref');
            context.localDeclarationKinds.set(
              declaration.binding.name,
              statement.declarationKind,
            );
            context.setLocals.set(declaration.binding.name, setLocal);
            context.runtimeFamilies.add('set');
            context.runtimeFamilies.add('array');
            return [{
              kind: 'set_new',
              targetName: declaration.binding.name,
              valuesArrayType: setLocal.valuesArrayType,
              valuesElementType: setLocal.valuesElementType,
            }];
          }
          const classConstruction = lowerClassConstructionDeclaration(
            declaration.binding.name,
            declaration.initializer,
            statement.declarationKind,
            context,
          );
          if (!classConstruction) {
            return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
          }
          return [...classConstruction];
        }
        if (declaration.initializer.kind === 'arrow_function') {
          const localType = localTypeForBinding(declaration.binding, context);
          const closure = lowerArrowFunctionExpression(
            declaration.initializer,
            localType,
            context,
          );
          if (!closure) {
            return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
          }
          addLocal(context, declaration.binding.name, 'closure_ref');
          context.localDeclarationKinds.set(
            declaration.binding.name,
            statement.declarationKind,
          );
          context.closureLocals.set(declaration.binding.name, {
            signatureId: closure.signatureId,
            resultRepresentation: representationForSemanticType(
              singleSignatureClosureType(localType)?.result ?? { kind: 'undefined' },
            ),
          });
          return [{
            kind: 'local_set',
            name: declaration.binding.name,
            value: closure,
          }];
        }
        if (declaration.initializer.kind === 'object_literal') {
          const fieldValueNames: string[] = [];
          const fieldTypes: { name: string; representation: CompilerValueType }[] = [];
          const loweredProperties: {
            property: (typeof declaration.initializer.properties)[number];
            valueName: string;
            valueType: CompilerValueType;
          }[] = [];
          const statements: SemanticStatementIR[] = [];
          for (const property of declaration.initializer.properties) {
            const value = lowerExpression(property.value, context);
            statements.push(...takePendingStatements(context));
            const valueName = nextTempLocalName(context, `object_${declaration.binding.name}`);
            addLocal(context, valueName, value.representation);
            statements.push({ kind: 'local_set', name: valueName, value });
            fieldValueNames.push(valueName);
            fieldTypes.push({ name: property.name, representation: value.representation });
            loweredProperties.push({
              property,
              valueName,
              valueType: value.representation,
            });
          }
          const localType = localTypeForBinding(declaration.binding, context);
          const hasComputedProperty = declaration.initializer.properties.some((property) =>
            property.computedName !== undefined
          );
          const objectLocal = localType
            ? objectLocalForSemanticType(localType, fieldTypes, context, {
              preferDynamic: hasComputedProperty,
            })
            : undefined;
          const resolvedObjectLocal = objectLocal ?? {
            family: 'specialized_object' as const,
            representationName: registerSpecializedObjectLayout(context, fieldTypes),
            fields: fieldTypes,
          };
          addLocal(context, declaration.binding.name, 'heap_ref');
          context.localDeclarationKinds.set(
            declaration.binding.name,
            statement.declarationKind,
          );
          context.objectLocals.set(declaration.binding.name, resolvedObjectLocal);
          if (resolvedObjectLocal.family === 'fallback_object') {
            statements.push({
              kind: 'fallback_object_new',
              targetName: declaration.binding.name,
              representationName: resolvedObjectLocal.representationName,
              entries: fieldValueNames.map((valueName, index) => ({
                key: fieldTypes[index]!.name,
                valueName,
                valueType: fieldTypes[index]!.representation,
              })),
            });
          } else if (resolvedObjectLocal.family === 'specialized_object') {
            statements.push({
              kind: 'specialized_object_new',
              targetName: declaration.binding.name,
              representationName: resolvedObjectLocal.representationName,
              fieldValueNames,
            });
          } else if (resolvedObjectLocal.family === 'dynamic_object') {
            const entries: {
              keyName: string;
              valueName: string;
              valueType: CompilerValueType;
            }[] = [];
            for (const lowered of loweredProperties) {
              const materializedKey = lowered.property.computedName
                ? materializeOwnedStringKeyExpression(
                  lowered.property.computedName,
                  context,
                  `object_${declaration.binding.name}_key`,
                )
                : materializeStaticOwnedStringKey(
                  lowered.property.name,
                  context,
                  `object_${declaration.binding.name}_key`,
                );
              if (!materializedKey) {
                context.unsupportedKinds.add('dynamic_object_key');
                statements.push({
                  kind: 'unsupported_statement',
                  sourceKind: 'variable_declaration',
                });
                continue;
              }
              statements.push(...materializedKey.statements);
              entries.push({
                keyName: materializedKey.keyName,
                valueName: lowered.valueName,
                valueType: lowered.valueType,
              });
            }
            statements.push({
              kind: 'dynamic_object_new',
              targetName: declaration.binding.name,
              representationName: resolvedObjectLocal.representationName,
              entries,
            });
          } else {
            context.unsupportedKinds.add('dynamic_object_local');
            statements.push({ kind: 'unsupported_statement', sourceKind: 'variable_declaration' });
          }
          return statements;
        }
        const value = lowerExpression(declaration.initializer, context);
        const statements = takePendingStatements(context);
        const localType = localTypeForBinding(declaration.binding, context);
        addLocal(
          context,
          declaration.binding.name,
          isFiniteUnionSemanticType(localType) ? 'tagged_ref' : value.representation,
        );
        context.localDeclarationKinds.set(
          declaration.binding.name,
          statement.declarationKind,
        );
        const arrayLocal = arrayLocalInfoForInitializer(
          declaration.initializer,
          value,
          context,
        );
        if (arrayLocal) {
          context.arrayLocals.set(declaration.binding.name, arrayLocal);
        }
        if (isFiniteUnionSemanticType(localType)) {
          const unionValue = adaptExpressionToSemanticType(value, localType, context);
          if (!unionValue) {
            context.unsupportedKinds.add('finite_union_assignment');
            return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
          }
          context.unionLocals.set(declaration.binding.name, localType!);
          return [...statements, {
            kind: 'local_set',
            name: declaration.binding.name,
            value: unionValue,
          }];
        }
        const objectLocal = value.representation === 'heap_ref'
          ? objectLocalInfoForRead(declaration.initializer, value, context)
          : undefined;
        if (objectLocal) {
          context.objectLocals.set(declaration.binding.name, objectLocal);
        }
        const mapLocal = value.representation === 'heap_ref'
          ? mapLocalInfoForRead(declaration.initializer, value, context)
          : undefined;
        if (mapLocal) {
          context.mapLocals.set(declaration.binding.name, mapLocal);
        }
        const setLocal = value.representation === 'heap_ref'
          ? setLocalInfoForRead(declaration.initializer, value, context)
          : undefined;
        if (setLocal) {
          context.setLocals.set(declaration.binding.name, setLocal);
        }
        const closureLocal = value.representation === 'closure_ref'
          ? closureLocalInfoForRead(declaration.initializer, value, context)
          : undefined;
        if (closureLocal) {
          context.closureLocals.set(declaration.binding.name, closureLocal);
        }
        return [...statements, { kind: 'local_set', name: declaration.binding.name, value }];
      });
    }
    case 'expression_statement': {
      if (
        statement.expression.kind === 'assignment_expression' &&
        (statement.expression.operator === '=' ||
          compoundAssignmentBinaryOperator(statement.expression.operator) !== undefined)
      ) {
        const assignment = statement.expression;
        if (assignment.left.kind === 'identifier') {
          const target = assignment.left.name;
          const targetRepresentation = context.localRepresentations.get(target);
          if (!targetRepresentation) {
            context.unsupportedKinds.add(`unbound_assignment:${target}`);
            return [{ kind: 'unsupported_statement', sourceKind: 'assignment_expression' }];
          }
          const right = lowerExpression(assignment.right, context);
          const compoundOperator = compoundAssignmentBinaryOperator(assignment.operator);
          let value = right;
          if (compoundOperator) {
            const left: SemanticExpressionIR = {
              kind: 'local_get',
              name: target,
              representation: targetRepresentation,
            };
            const binary = binaryOperatorForSource(compoundOperator, left, right);
            if (!binary || binary.representation !== targetRepresentation) {
              context.unsupportedKinds.add(`compound_assignment:${assignment.operator}`);
              return [{ kind: 'unsupported_statement', sourceKind: 'assignment_expression' }];
            }
            value = {
              kind: 'binary',
              op: binary.op,
              left,
              right,
              representation: binary.representation,
            };
          }
          const statements = takePendingStatements(context);
          const arrayLocal = compoundOperator ? undefined : arrayLocalInfoForInitializer(
            assignment.right,
            value,
            context,
          );
          if (arrayLocal) {
            context.arrayLocals.set(target, arrayLocal);
          } else {
            context.arrayLocals.delete(target);
          }
          const objectLocal = !compoundOperator && value.representation === 'heap_ref'
            ? objectLocalInfoForRead(assignment.right, value, context)
            : undefined;
          if (objectLocal) {
            context.objectLocals.set(target, objectLocal);
          } else {
            context.objectLocals.delete(target);
          }
          const mapLocal = !compoundOperator && value.representation === 'heap_ref'
            ? mapLocalInfoForRead(assignment.right, value, context)
            : undefined;
          if (mapLocal) {
            context.mapLocals.set(target, mapLocal);
          } else {
            context.mapLocals.delete(target);
          }
          const setLocal = !compoundOperator && value.representation === 'heap_ref'
            ? setLocalInfoForRead(assignment.right, value, context)
            : undefined;
          if (setLocal) {
            context.setLocals.set(target, setLocal);
          } else {
            context.setLocals.delete(target);
          }
          const closureLocal = !compoundOperator && value.representation === 'closure_ref'
            ? closureLocalInfoForRead(assignment.right, value, context)
            : undefined;
          if (closureLocal) {
            context.closureLocals.set(target, closureLocal);
          } else {
            context.closureLocals.delete(target);
          }
          return [...statements, { kind: 'local_set', name: target, value }];
        }
        if (
          assignment.left.kind === 'element_access' &&
          assignment.left.object.kind === 'identifier' &&
          assignment.left.index
        ) {
          const objectName = assignment.left.object.name;
          const index = lowerExpression(assignment.left.index, context);
          const right = lowerExpression(assignment.right, context);
          const compoundOperator = compoundAssignmentBinaryOperator(assignment.operator);
          let value = right;
          if (compoundOperator) {
            const arrayRepresentation = context.localRepresentations.get(objectName);
            if (!arrayRepresentation) {
              context.unsupportedKinds.add(`element_assignment:${objectName}`);
              return [{ kind: 'unsupported_statement', sourceKind: 'assignment_expression' }];
            }
            const array = localGetExpression(objectName, arrayRepresentation);
            const arrayLocal = arrayLocalInfoForRead(assignment.left.object, array, context);
            const current = arrayLocal
              ? arrayElementExpressionForInfo(array, index, arrayLocal, context)
              : undefined;
            const binary = current
              ? binaryOperatorForSource(compoundOperator, current, right)
              : undefined;
            if (!binary || !current) {
              context.unsupportedKinds.add(`element_compound_assignment:${objectName}`);
              return [{ kind: 'unsupported_statement', sourceKind: 'assignment_expression' }];
            }
            value = {
              kind: 'binary',
              op: binary.op,
              left: current,
              right,
              representation: binary.representation,
            };
          }
          const arraySet = arrayElementSetStatementForLocal(
            context,
            objectName,
            index,
            value,
          );
          if (!arraySet) {
            context.unsupportedKinds.add(`element_assignment:${objectName}`);
            return [{ kind: 'unsupported_statement', sourceKind: 'assignment_expression' }];
          }
          return [...takePendingStatements(context), arraySet];
        }
        if (
          assignment.left.kind === 'property_access' &&
          assignment.left.object.kind === 'identifier'
        ) {
          const objectName = assignment.left.object.name;
          const propertyName = assignment.left.property;
          const objectLayout = context.objectLocals.get(objectName);
          const fieldIndex = objectLayout?.fields.findIndex((field) =>
            field.name === propertyName
          ) ?? -1;
          if (objectLayout?.family === 'specialized_object' && fieldIndex >= 0) {
            const field = objectLayout.fields[fieldIndex]!;
            const right = lowerExpression(assignment.right, context);
            const compoundOperator = compoundAssignmentBinaryOperator(assignment.operator);
            let value = right;
            const fieldGetStatements: SemanticStatementIR[] = [];
            if (compoundOperator) {
              const currentName = nextTempLocalName(context, `field_${objectName}`);
              addLocal(context, currentName, field.representation);
              const current = localGetExpression(currentName, field.representation);
              const binary = binaryOperatorForSource(compoundOperator, current, right);
              if (!binary || binary.representation !== field.representation) {
                context.unsupportedKinds.add(`property_compound_assignment:${field.name}`);
                return [{ kind: 'unsupported_statement', sourceKind: 'assignment_expression' }];
              }
              fieldGetStatements.push({
                kind: 'specialized_object_field_get',
                targetName: currentName,
                objectName,
                representationName: objectLayout.representationName,
                fieldIndex,
                fieldName: field.name,
              });
              value = {
                kind: 'binary',
                op: binary.op,
                left: current,
                right,
                representation: binary.representation,
              };
            }
            if (value.representation !== field.representation) {
              context.unsupportedKinds.add(`property_assignment:${field.name}`);
              return [{ kind: 'unsupported_statement', sourceKind: 'assignment_expression' }];
            }
            context.runtimeFamilies.add('specialized_object');
            return [
              ...takePendingStatements(context),
              ...fieldGetStatements,
              {
                kind: 'specialized_object_field_set',
                objectName,
                representationName: objectLayout.representationName,
                fieldIndex,
                fieldName: field.name,
                value,
              },
            ];
          }
        }
      }
      const value = lowerExpression(statement.expression, context);
      return [...takePendingStatements(context), { kind: 'expression', value }];
    }
    case 'return': {
      const activeCompletionTarget = context.completionTargets.at(-1);
      if (activeCompletionTarget) {
        return captureReturnCompletion(
          statement,
          activeCompletionTarget,
          context,
          'return',
        );
      }
      const rawValue = statement.expression
        ? lowerExpression(statement.expression, context)
        : { kind: 'undefined_literal', representation: 'tagged_ref' } as SemanticExpressionIR;
      if (context.asyncFunction && context.currentResultType?.kind === 'promise') {
        const promiseValue = promiseResolveExpressionForValue(
          rawValue,
          context.currentResultType.value,
          context,
        );
        if (!promiseValue) {
          context.unsupportedKinds.add('async_return_value');
          return [{ kind: 'unsupported_statement', sourceKind: 'return' }];
        }
        return [...takePendingStatements(context), {
          kind: 'return',
          value: promiseValue,
        }];
      }
      const value = adaptExpressionToSemanticType(
        rawValue,
        context.currentResultType,
        context,
      ) ?? rawValue;
      return [...takePendingStatements(context), {
        kind: 'return',
        value,
      }];
    }
    case 'if': {
      const condition = lowerExpression(statement.test, context);
      const conditionStatements = takePendingStatements(context);
      if (condition.representation !== 'i32') {
        context.unsupportedKinds.add('if_condition');
      }
      return [...conditionStatements, {
        kind: 'if',
        condition,
        thenBody: statement.consequent.flatMap((child) => [...lowerStatement(child, context)]),
        elseBody: statement.alternate.flatMap((child) => [...lowerStatement(child, context)]),
      }];
    }
    case 'while': {
      const condition = lowerExpression(statement.test, context);
      const conditionStatements = takePendingStatements(context);
      if (condition.representation !== 'i32') {
        context.unsupportedKinds.add('while_condition');
      }
      return [...conditionStatements, {
        kind: 'while',
        condition,
        body: statement.body.flatMap((child) => [...lowerStatement(child, context)]),
        continueBody: conditionStatements,
      }];
    }
    case 'do_while': {
      const body = statement.body.flatMap((child) => [...lowerStatement(child, context)]);
      const condition = lowerExpression(statement.test, context);
      const conditionStatements = takePendingStatements(context);
      if (condition.representation !== 'i32') {
        context.unsupportedKinds.add('do_while_condition');
      }
      return [{
        kind: 'do_while',
        condition,
        body,
        continueBody: conditionStatements,
      }];
    }
    case 'for': {
      const initializerStatements = statement.initializer
        ? statement.initializer.kind === 'variable_declaration'
          ? lowerStatement(statement.initializer, context)
          : lowerStatement(
            {
              kind: 'expression_statement',
              expression: statement.initializer,
              span: statement.span,
            },
            context,
          )
        : [];
      const condition = statement.test
        ? lowerExpression(statement.test, context)
        : { kind: 'boolean_literal', value: true, representation: 'i32' } as SemanticExpressionIR;
      const conditionStatements = takePendingStatements(context);
      if (condition.representation !== 'i32') {
        context.unsupportedKinds.add('for_condition');
      }
      const incrementStatements = statement.incrementor
        ? lowerStatement(
          { kind: 'expression_statement', expression: statement.incrementor, span: statement.span },
          context,
        )
        : [];
      return [...initializerStatements, ...conditionStatements, {
        kind: 'while',
        condition,
        body: statement.body.flatMap((child) => [...lowerStatement(child, context)]),
        continueBody: [...incrementStatements, ...conditionStatements],
      }];
    }
    case 'switch':
      return lowerSwitchStatement(statement, context);
    case 'break': {
      const switchBreakLocal = context.switchBreakLocalStack.at(-1);
      if (switchBreakLocal) {
        return [{
          kind: 'local_set',
          name: switchBreakLocal,
          value: booleanLiteralExpression(false),
        }];
      }
      const activeCompletionTarget = context.completionTargets.at(-1);
      if (activeCompletionTarget?.breakFlagName) {
        return captureLoopControlCompletion('break', activeCompletionTarget, context);
      }
      return [{ kind: 'break' }];
    }
    case 'continue': {
      const activeCompletionTarget = context.completionTargets.at(-1);
      if (activeCompletionTarget?.continueFlagName) {
        return captureLoopControlCompletion('continue', activeCompletionTarget, context);
      }
      return [{ kind: 'continue' }];
    }
    case 'throw': {
      const value = lowerExpression(statement.expression, context);
      const pendingStatements = takePendingStatements(context);
      const throwTarget = context.throwTargets.at(-1);
      if (throwTarget) {
        const taggedValue = taggedUnionExpressionForValue(value, context);
        if (!taggedValue) {
          context.unsupportedKinds.add('try_catch_throw_value');
          return [{ kind: 'unsupported_statement', sourceKind: 'throw' }];
        }
        return [
          ...pendingStatements,
          {
            kind: 'local_set',
            name: throwTarget.thrownHeapName,
            value: value.representation === 'heap_ref'
              ? value
              : { kind: 'heap_null', representation: 'heap_ref' },
          },
          { kind: 'local_set', name: throwTarget.thrownValueName, value: taggedValue },
          {
            kind: 'local_set',
            name: throwTarget.thrownFlagName,
            value: booleanLiteralExpression(true),
          },
        ];
      }
      return [...pendingStatements, { kind: 'throw_tagged', value }];
    }
    case 'block':
      return statement.statements.flatMap((child) => [...lowerStatement(child, context)]);
    case 'try':
      return lowerTryStatement(statement, context);
    case 'for_of': {
      const lowered = lowerArrayForOfStatement(statement, context);
      if (lowered) {
        return lowered;
      }
      context.unsupportedKinds.add('for_of');
      return [{ kind: 'unsupported_statement', sourceKind: 'for_of' }];
    }
    default:
      context.unsupportedKinds.add(statement.kind);
      return [{ kind: 'unsupported_statement', sourceKind: statement.kind }];
  }
}

function lowerFunctionBody(
  func: SourceFunctionIR,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  const body = func.body.flatMap((statement) => [...lowerStatement(statement, context)]);
  return body.length > 0 ? [...body, { kind: 'trap' }] : [{ kind: 'trap' }];
}

interface SourceAwaitStep {
  binding: Extract<SourceBindingIR, { kind: 'identifier_binding' }>;
  leadingStatements: readonly SourceStatementIR[];
  source: SourceExpressionIR;
  type: SemanticTypeIR;
  representation: CompilerValueType;
}

interface SourceAsyncCapture {
  name: string;
  valueType: CompilerValueType;
  arrayLocal?: SourceSemanticArrayLocal;
  closureLocal?: SourceSemanticClosureLocal;
  constructorLocal?: SourceSemanticConstructorLocal;
  mapLocal?: SourceSemanticMapLocal;
  objectLocal?: SourceSemanticObjectLocal;
  setLocal?: SourceSemanticSetLocal;
  unionLocal?: SemanticTypeIR;
}

function registerSemanticLocalMetadata(
  context: FunctionLoweringContext,
  name: string,
  type: SemanticTypeIR,
): void {
  const arrayLocal = arrayLocalInfoForSemanticType(type);
  if (arrayLocal) {
    context.arrayLocals.set(name, arrayLocal);
  }
  const objectLocal = objectLocalForParameterType(type, context);
  if (objectLocal) {
    context.objectLocals.set(name, objectLocal);
  }
  const mapLocal = mapLocalInfoForSemanticType(type);
  if (mapLocal) {
    context.mapLocals.set(name, mapLocal);
  }
  const setLocal = setLocalInfoForSemanticType(type);
  if (setLocal) {
    context.setLocals.set(name, setLocal);
  }
  const closureLocal = closureLocalForSemanticType(type, context);
  if (closureLocal) {
    context.closureLocals.set(name, closureLocal);
  }
}

function sourceAsyncCaptureForName(
  context: FunctionLoweringContext,
  name: string,
): SourceAsyncCapture | undefined {
  const representation = context.localRepresentations.get(name);
  if (!representation) {
    return undefined;
  }
  const valueType = representation === 'box_ref' ? context.boxedLocals.get(name) : representation;
  if (!valueType) {
    return undefined;
  }
  return {
    name,
    valueType,
    arrayLocal: context.arrayLocals.get(name),
    closureLocal: context.closureLocals.get(name),
    constructorLocal: context.constructorLocals.get(name),
    mapLocal: context.mapLocals.get(name),
    objectLocal: context.objectLocals.get(name),
    setLocal: context.setLocals.get(name),
    unionLocal: context.unionLocals.get(name),
  };
}

function sourceAsyncCapturesForLiveNames(
  context: FunctionLoweringContext,
  liveNames: readonly string[],
): readonly SourceAsyncCapture[] {
  const captures: SourceAsyncCapture[] = [];
  const seen = new Set<string>();
  for (const name of liveNames) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const capture = sourceAsyncCaptureForName(context, name);
    if (capture) {
      captures.push(capture);
    }
  }
  return captures;
}

function registerSourceAsyncCapture(
  context: FunctionLoweringContext,
  capture: SourceAsyncCapture,
): void {
  context.localRepresentations.set(capture.name, 'box_ref');
  context.boxedLocals.set(capture.name, capture.valueType);
  context.localDeclarationKinds.set(capture.name, 'capture');
  if (capture.arrayLocal) {
    context.arrayLocals.set(capture.name, capture.arrayLocal);
  }
  if (capture.closureLocal) {
    context.closureLocals.set(capture.name, capture.closureLocal);
  }
  if (capture.constructorLocal) {
    context.constructorLocals.set(capture.name, capture.constructorLocal);
  }
  if (capture.mapLocal) {
    context.mapLocals.set(capture.name, capture.mapLocal);
  }
  if (capture.objectLocal) {
    context.objectLocals.set(capture.name, capture.objectLocal);
  }
  if (capture.setLocal) {
    context.setLocals.set(capture.name, capture.setLocal);
  }
  if (capture.unionLocal) {
    context.unionLocals.set(capture.name, capture.unionLocal);
  }
}

function createAsyncAwaitContinuationContext(
  parentContext: FunctionLoweringContext,
  functionName: string,
  captures: readonly SourceAsyncCapture[],
): FunctionLoweringContext {
  const localRepresentations = new Map<string, CompilerValueType>([
    ['capture_target_0', 'box_ref'],
    ['promise_value', 'tagged_ref'],
  ]);
  const boxedLocals = new Map<string, CompilerValueType>();
  const localDeclarationKinds = new Map<string, SourceSemanticLocalDeclarationKind>([
    ['capture_target_0', 'capture'],
    ['promise_value', 'param'],
  ]);
  const context: FunctionLoweringContext = {
    functionName,
    asyncFunction: false,
    currentResultType: promiseReactionTaggedValueType(),
    functionResultArrayLocals: parentContext.functionResultArrayLocals,
    functionParamTypes: parentContext.functionParamTypes,
    functionResultRepresentations: parentContext.functionResultRepresentations,
    functionResultTypes: parentContext.functionResultTypes,
    localRepresentations,
    locals: [],
    arrayLocals: new Map(),
    boxedLocals,
    closureLocals: new Map(),
    constructorLocals: new Map(),
    localDeclarationKinds,
    localTypesByKey: new Map(),
    mapLocals: new Map(),
    moduleState: parentContext.moduleState,
    objectLayoutsByKey: parentContext.objectLayoutsByKey,
    objectLocals: new Map(),
    setLocals: new Map(),
    unionLocals: new Map(),
    classesByName: parentContext.classesByName,
    pendingStatements: [],
    runtimeFamilies: new Set(['finite_union', 'promise']),
    stringLiteralIds: parentContext.stringLiteralIds,
    stringLiterals: parentContext.stringLiterals,
    switchBreakLocalStack: [],
    throwTargets: [],
    completionTargets: [],
    tempIndex: 0,
    unsupportedKinds: new Set(),
  };
  captures.forEach((capture) => registerSourceAsyncCapture(context, capture));
  return context;
}

function sourceAsyncCaptureExpression(
  capture: SourceAsyncCapture,
  context: FunctionLoweringContext,
): SemanticExpressionIR {
  const representation = context.localRepresentations.get(capture.name);
  if (representation === 'box_ref' && context.boxedLocals.get(capture.name) === capture.valueType) {
    return localGetExpression(capture.name, 'box_ref');
  }
  if (representation) {
    return {
      kind: 'box_new',
      value: localGetExpression(capture.name, representation),
      valueType: capture.valueType,
      representation: 'box_ref',
    };
  }
  context.unsupportedKinds.add(`async_await_capture:${capture.name}`);
  return { kind: 'undefined_literal', representation: 'tagged_ref' };
}

function asyncAwaitContinuationCaptureValues(
  captures: readonly SourceAsyncCapture[],
  targetCapture: SemanticExpressionIR,
  context: FunctionLoweringContext,
): readonly {
  value: SemanticExpressionIR;
  valueType: CompilerValueType;
}[] {
  const captureValues: {
    value: SemanticExpressionIR;
    valueType: CompilerValueType;
  }[] = [
    { value: targetCapture, valueType: 'tagged_ref' },
  ];
  for (const capture of captures) {
    captureValues.push({
      value: sourceAsyncCaptureExpression(capture, context),
      valueType: capture.valueType,
    });
  }
  return captureValues;
}

function sourceAsyncLiveNamesAfterAwait(
  steps: readonly SourceAwaitStep[],
  index: number,
  trailingStatements: readonly SourceStatementIR[],
  returnStatement: Extract<SourceStatementIR, { kind: 'return' }>,
): readonly string[] {
  const names: string[] = [];
  for (let nextIndex = index + 1; nextIndex < steps.length; nextIndex += 1) {
    steps[nextIndex]!.leadingStatements.forEach((statement) =>
      collectSourceStatementIdentifierReads(statement, names)
    );
    collectSourceExpressionIdentifierReads(steps[nextIndex]!.source, names);
  }
  trailingStatements.forEach((statement) =>
    collectSourceStatementIdentifierReads(statement, names)
  );
  if (returnStatement.expression) {
    collectSourceExpressionIdentifierReads(returnStatement.expression, names);
  }
  return names;
}

function sourceExpressionContainsAwaitExpression(expression: SourceExpressionIR): boolean {
  switch (expression.kind) {
    case 'await_expression':
      return true;
    case 'property_access':
      return sourceExpressionContainsAwaitExpression(expression.object);
    case 'element_access':
      return sourceExpressionContainsAwaitExpression(expression.object) ||
        (expression.index ? sourceExpressionContainsAwaitExpression(expression.index) : false);
    case 'binary_expression':
    case 'logical_expression':
      return sourceExpressionContainsAwaitExpression(expression.left) ||
        sourceExpressionContainsAwaitExpression(expression.right);
    case 'unary_expression':
    case 'update_expression':
      return sourceExpressionContainsAwaitExpression(expression.operand);
    case 'conditional_expression':
      return sourceExpressionContainsAwaitExpression(expression.test) ||
        sourceExpressionContainsAwaitExpression(expression.consequent) ||
        sourceExpressionContainsAwaitExpression(expression.alternate);
    case 'assignment_expression':
      return sourceExpressionContainsAwaitExpression(expression.left) ||
        sourceExpressionContainsAwaitExpression(expression.right);
    case 'call_expression':
    case 'new_expression':
      return sourceExpressionContainsAwaitExpression(expression.callee) ||
        expression.args.some((arg) => sourceExpressionContainsAwaitExpression(arg));
    case 'array_literal':
      return expression.elements.some((element) =>
        sourceExpressionContainsAwaitExpression(element)
      );
    case 'object_literal':
      return expression.properties.some((property) =>
        (property.computedName
          ? sourceExpressionContainsAwaitExpression(property.computedName)
          : false) || sourceExpressionContainsAwaitExpression(property.value)
      );
    case 'arrow_function':
      return false;
    case 'identifier':
    case 'literal':
    case 'unknown_expression':
      return false;
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function sourceStatementContainsAwaitExpression(statement: SourceStatementIR): boolean {
  switch (statement.kind) {
    case 'variable_declaration':
      return statement.declarations.some((declaration) =>
        declaration.initializer
          ? sourceExpressionContainsAwaitExpression(declaration.initializer)
          : false
      );
    case 'expression_statement':
      return sourceExpressionContainsAwaitExpression(statement.expression);
    case 'return':
      return statement.expression
        ? sourceExpressionContainsAwaitExpression(statement.expression)
        : false;
    case 'if':
      return sourceExpressionContainsAwaitExpression(statement.test) ||
        statement.consequent.some((child) => sourceStatementContainsAwaitExpression(child)) ||
        statement.alternate.some((child) => sourceStatementContainsAwaitExpression(child));
    case 'while':
      return sourceExpressionContainsAwaitExpression(statement.test) ||
        statement.body.some((child) => sourceStatementContainsAwaitExpression(child));
    case 'do_while':
      return statement.body.some((child) => sourceStatementContainsAwaitExpression(child)) ||
        sourceExpressionContainsAwaitExpression(statement.test);
    case 'for':
      return (statement.initializer
        ? statement.initializer.kind === 'variable_declaration'
          ? sourceStatementContainsAwaitExpression(statement.initializer)
          : sourceExpressionContainsAwaitExpression(statement.initializer)
        : false) ||
        (statement.test ? sourceExpressionContainsAwaitExpression(statement.test) : false) ||
        (statement.incrementor
          ? sourceExpressionContainsAwaitExpression(statement.incrementor)
          : false) ||
        statement.body.some((child) => sourceStatementContainsAwaitExpression(child));
    case 'for_of':
      return ('kind' in statement.left && !statement.left.kind.endsWith('_binding')
        ? sourceExpressionContainsAwaitExpression(statement.left as SourceExpressionIR)
        : false) ||
        sourceExpressionContainsAwaitExpression(statement.right) ||
        statement.body.some((child) => sourceStatementContainsAwaitExpression(child));
    case 'switch':
      return sourceExpressionContainsAwaitExpression(statement.expression) ||
        statement.clauses.some((clause) =>
          (clause.expression
            ? sourceExpressionContainsAwaitExpression(clause.expression)
            : false) ||
          clause.statements.some((child) => sourceStatementContainsAwaitExpression(child))
        );
    case 'throw':
      return sourceExpressionContainsAwaitExpression(statement.expression);
    case 'try':
      return statement.tryBlock.some((child) => sourceStatementContainsAwaitExpression(child)) ||
        (statement.catchBlock?.some((child) => sourceStatementContainsAwaitExpression(child)) ??
          false) ||
        (statement.finallyBlock?.some((child) => sourceStatementContainsAwaitExpression(child)) ??
          false);
    case 'block':
      return statement.statements.some((child) => sourceStatementContainsAwaitExpression(child));
    case 'break':
    case 'continue':
    case 'unknown_statement':
      return false;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function pushAsyncAwaitFulfilledClosure(
  context: FunctionLoweringContext,
  signatureId: number,
  steps: readonly SourceAwaitStep[],
  index: number,
  captures: readonly SourceAsyncCapture[],
  trailingStatements: readonly SourceStatementIR[],
  returnStatement: Extract<SourceStatementIR, { kind: 'return' }>,
): number | undefined {
  const step = steps[index];
  if (!step) {
    context.unsupportedKinds.add('async_await_step');
    return undefined;
  }
  const closureFunctionId = context.moduleState.nextClosureFunctionId;
  context.moduleState.nextClosureFunctionId += 1;
  const closureContext = createAsyncAwaitContinuationContext(
    context,
    `closure_source_async_await_fulfilled_${closureFunctionId}`,
    captures,
  );
  addLocal(closureContext, step.binding.name, step.representation);
  closureContext.localDeclarationKinds.set(step.binding.name, 'const');
  registerSemanticLocalMetadata(closureContext, step.binding.name, step.type);
  const awaitedValue = untagUnionExpressionForRepresentation(
    localGetExpression('promise_value', 'tagged_ref'),
    step.representation,
    closureContext,
  );
  if (!awaitedValue) {
    context.unsupportedKinds.add('async_await_value');
    return undefined;
  }

  const body: SemanticStatementIR[] = [
    { kind: 'local_set', name: step.binding.name, value: awaitedValue },
  ];
  const statementsBeforeNextAwait = index === steps.length - 1
    ? trailingStatements
    : steps[index + 1]!.leadingStatements;
  body.push(
    ...statementsBeforeNextAwait.flatMap((
      statement,
    ) => [...lowerStatement(statement, closureContext)]),
  );
  if (index === steps.length - 1) {
    const returnValue = returnStatement.expression
      ? lowerExpression(returnStatement.expression, closureContext)
      : { kind: 'undefined_literal', representation: 'tagged_ref' } as SemanticExpressionIR;
    const taggedReturnValue = taggedUnionExpressionForValue(returnValue, closureContext);
    if (!taggedReturnValue) {
      context.unsupportedKinds.add('async_await_return_value');
      return undefined;
    }
    body.push(...takePendingStatements(closureContext), {
      kind: 'expression',
      value: {
        kind: 'call',
        callee: SOUNDSCRIPT_PROMISE_RESOLVE_INTO_HELPER_NAME,
        args: [promiseTargetFromCapture(), taggedReturnValue],
        representation: 'tagged_ref',
      },
    }, { kind: 'return', value: { kind: 'undefined_literal', representation: 'tagged_ref' } });
  } else {
    const nextStep = steps[index + 1]!;
    const awaitedSource = lowerExpression(nextStep.source, closureContext);
    const awaitedSourceStatements = takePendingStatements(closureContext);
    if (awaitedSource.representation !== 'heap_ref') {
      context.unsupportedKinds.add('async_await_source');
      return undefined;
    }
    const nextCaptures = sourceAsyncCapturesForLiveNames(
      closureContext,
      sourceAsyncLiveNamesAfterAwait(steps, index + 1, trailingStatements, returnStatement),
    );
    const nextFulfilledFunctionId = pushAsyncAwaitFulfilledClosure(
      closureContext,
      signatureId,
      steps,
      index + 1,
      nextCaptures,
      trailingStatements,
      returnStatement,
    );
    const nextRejectedFunctionId = pushPromiseRejectIntoClosure(closureContext, signatureId);
    if (nextFulfilledFunctionId === undefined) {
      context.unsupportedKinds.add('async_await_continuation');
      return undefined;
    }
    const awaitedSourceName = nextTempLocalName(closureContext, 'async_await_source');
    addLocal(closureContext, awaitedSourceName, 'heap_ref');
    const captureValues = asyncAwaitContinuationCaptureValues(
      nextCaptures,
      localGetExpression('capture_target_0', 'box_ref'),
      closureContext,
    );
    body.push(
      ...awaitedSourceStatements,
      { kind: 'local_set', name: awaitedSourceName, value: awaitedSource },
      {
        kind: 'expression',
        value: {
          kind: 'call',
          callee: SOUNDSCRIPT_PROMISE_THEN_HELPER_NAME,
          args: [
            localGetExpression(awaitedSourceName, 'heap_ref'),
            {
              kind: 'closure_literal',
              functionId: nextFulfilledFunctionId,
              signatureId,
              captures: captureValues.map((capture) => capture.value),
              captureValueTypes: captureValues.map((capture) => capture.valueType),
              representation: 'closure_ref',
            },
            {
              kind: 'closure_literal',
              functionId: nextRejectedFunctionId,
              signatureId,
              captures: [localGetExpression('capture_target_0', 'box_ref')],
              captureValueTypes: ['tagged_ref'],
              representation: 'closure_ref',
            },
          ],
          representation: 'heap_ref',
        },
      },
      { kind: 'return', value: { kind: 'undefined_literal', representation: 'tagged_ref' } },
    );
    closureContext.runtimeFamilies.add('closure');
  }

  const unsupportedBodyKinds = [...closureContext.unsupportedKinds].sort();
  context.moduleState.generatedFunctions.push({
    name: closureContext.functionName,
    exportName: '',
    params: [
      { name: 'capture_target_0', representation: 'box_ref' },
      ...captures.map((capture) => ({
        name: capture.name,
        representation: 'box_ref' as const,
      })),
      { name: 'promise_value', representation: 'tagged_ref' },
    ],
    locals: closureContext.locals,
    result: 'tagged_ref',
    body,
    bodyStatus: unsupportedBodyKinds.length === 0 ? 'emittable' : 'stub',
    unsupportedBodyKinds,
    runtimeFamilies: [...new Set([...closureContext.runtimeFamilies])].sort(),
    hostImported: false,
    hostExported: false,
    unionBoundaries: [],
    closureFunctionId,
    closureSignatureId: signatureId,
    closureCaptureCount: 1 + captures.length,
    closureCaptureValueTypes: [
      'tagged_ref',
      ...captures.map((capture) => capture.valueType),
    ],
  });
  return closureFunctionId;
}

function lowerAwaitAsyncFunctionBody(
  func: SourceFunctionIR,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] | undefined {
  if (!func.async || context.currentResultType?.kind !== 'promise' || func.body.length < 2) {
    return undefined;
  }
  const returnStatement = func.body.at(-1);
  if (returnStatement?.kind !== 'return') {
    return undefined;
  }
  const steps: SourceAwaitStep[] = [];
  let pendingLeadingStatements: SourceStatementIR[] = [];
  let continuationReturnStatement = returnStatement;
  for (const statement of func.body.slice(0, -1)) {
    if (statement.kind === 'variable_declaration' && statement.declarations.length === 1) {
      const [declaration] = statement.declarations;
      if (
        declaration &&
        declaration.binding.kind === 'identifier_binding' &&
        declaration.initializer?.kind === 'await_expression'
      ) {
        const awaitedType = localTypeForBinding(declaration.binding, context);
        if (!awaitedType) {
          context.unsupportedKinds.add('async_await_value_type');
          return [
            { kind: 'unsupported_statement', sourceKind: 'await_expression' },
            { kind: 'trap' },
          ];
        }
        steps.push({
          binding: declaration.binding,
          leadingStatements: pendingLeadingStatements,
          source: declaration.initializer.expression,
          type: awaitedType,
          representation: representationForSemanticType(awaitedType),
        });
        pendingLeadingStatements = [];
        continue;
      }
    }
    if (sourceStatementContainsAwaitExpression(statement)) {
      return undefined;
    }
    pendingLeadingStatements.push(statement);
  }
  if (returnStatement.expression?.kind === 'await_expression') {
    const awaitedType = context.currentResultType.value;
    if (!awaitedType) {
      context.unsupportedKinds.add('async_return_await_value_type');
      return [{ kind: 'unsupported_statement', sourceKind: 'await_expression' }, { kind: 'trap' }];
    }
    const syntheticName = nextTempLocalName(context, 'async_return_await');
    const syntheticBinding: Extract<SourceBindingIR, { kind: 'identifier_binding' }> = {
      kind: 'identifier_binding',
      name: syntheticName,
      span: returnStatement.expression.span,
    };
    steps.push({
      binding: syntheticBinding,
      leadingStatements: pendingLeadingStatements,
      source: returnStatement.expression.expression,
      type: awaitedType,
      representation: representationForSemanticType(awaitedType),
    });
    pendingLeadingStatements = [];
    continuationReturnStatement = {
      ...returnStatement,
      expression: {
        kind: 'identifier',
        name: syntheticName,
        role: 'read',
        span: returnStatement.expression.span,
      },
    };
  }
  if (steps.length === 0) {
    return undefined;
  }

  const firstStep = steps[0]!;
  const leadingStatements = firstStep.leadingStatements.flatMap((statement) => [
    ...lowerStatement(statement, context),
  ]);
  const awaitedSource = lowerExpression(firstStep.source, context);
  const awaitedSourceStatements = takePendingStatements(context);
  if (awaitedSource.representation !== 'heap_ref') {
    context.unsupportedKinds.add('async_await_source');
    return [{ kind: 'unsupported_statement', sourceKind: 'await_expression' }, { kind: 'trap' }];
  }

  const taggedValue = promiseReactionTaggedValueType();
  const closureSignature = createClosureSignature(context.moduleState, [taggedValue], taggedValue);
  const firstCaptures = sourceAsyncCapturesForLiveNames(
    context,
    sourceAsyncLiveNamesAfterAwait(
      steps,
      0,
      pendingLeadingStatements,
      continuationReturnStatement,
    ),
  );
  const fulfilledFunctionId = pushAsyncAwaitFulfilledClosure(
    context,
    closureSignature.id,
    steps,
    0,
    firstCaptures,
    pendingLeadingStatements,
    continuationReturnStatement,
  );
  const rejectedFunctionId = pushPromiseRejectIntoClosure(context, closureSignature.id);
  if (fulfilledFunctionId === undefined) {
    return [{ kind: 'unsupported_statement', sourceKind: 'await_expression' }, { kind: 'trap' }];
  }

  const targetPromiseName = nextTempLocalName(context, 'async_await_target');
  const awaitedSourceName = nextTempLocalName(context, 'async_await_source');
  addLocal(context, targetPromiseName, 'heap_ref');
  addLocal(context, awaitedSourceName, 'heap_ref');
  context.runtimeFamilies.add('closure');
  context.runtimeFamilies.add('finite_union');
  context.runtimeFamilies.add('promise');
  const targetCapture = promiseTargetCapture(targetPromiseName);
  const captureValues = asyncAwaitContinuationCaptureValues(
    firstCaptures,
    targetCapture,
    context,
  );
  return [
    {
      kind: 'local_set',
      name: targetPromiseName,
      value: {
        kind: 'call',
        callee: SOUNDSCRIPT_PROMISE_NEW_PENDING_HELPER_NAME,
        args: [],
        representation: 'heap_ref',
      },
    },
    ...leadingStatements,
    ...awaitedSourceStatements,
    { kind: 'local_set', name: awaitedSourceName, value: awaitedSource },
    {
      kind: 'expression',
      value: {
        kind: 'call',
        callee: SOUNDSCRIPT_PROMISE_THEN_HELPER_NAME,
        args: [
          localGetExpression(awaitedSourceName, 'heap_ref'),
          {
            kind: 'closure_literal',
            functionId: fulfilledFunctionId,
            signatureId: closureSignature.id,
            captures: captureValues.map((capture) => capture.value),
            captureValueTypes: captureValues.map((capture) => capture.valueType),
            representation: 'closure_ref',
          },
          {
            kind: 'closure_literal',
            functionId: rejectedFunctionId,
            signatureId: closureSignature.id,
            captures: [targetCapture],
            captureValueTypes: ['tagged_ref'],
            representation: 'closure_ref',
          },
        ],
        representation: 'heap_ref',
      },
    },
    { kind: 'return', value: localGetExpression(targetPromiseName, 'heap_ref') },
    { kind: 'trap' },
  ];
}

function findBoundarySurface(
  sharedFacts: SharedSemanticFactsIR,
  module: SourceModuleIR,
  func: SourceFunctionIR,
): SemanticBoundarySurfaceIR | undefined {
  return sharedFacts.boundarySurfaces.find((surface) =>
    surface.direction === 'export' &&
    surface.fileName === module.fileName &&
    surface.name === func.name
  ) as SemanticBoundarySurfaceIR | undefined;
}

function findFunctionTypeSnapshot(
  sharedFacts: SharedSemanticFactsIR,
  module: SourceModuleIR,
  func: SourceFunctionIR,
): SharedSemanticFunctionTypeSnapshotIR | undefined {
  return sharedFacts.typeSnapshots.find((
    snapshot,
  ): snapshot is SharedSemanticFunctionTypeSnapshotIR =>
    snapshot.kind === 'function_type' &&
    snapshot.fileName === module.fileName &&
    snapshot.name === func.name
  );
}

function findFunctionSignature(
  sharedFacts: SharedSemanticFactsIR,
  module: SourceModuleIR,
  func: SourceFunctionIR,
): SourceSemanticFunctionSignature | undefined {
  const boundary = findBoundarySurface(sharedFacts, module, func);
  if (boundary) {
    return {
      boundary,
      params: boundary.params.map((param) => ({
        name: param.name,
        type: param.type as SemanticTypeIR,
      })),
      result: boundary.result as SemanticTypeIR,
    };
  }
  const snapshot = findFunctionTypeSnapshot(sharedFacts, module, func);
  if (!snapshot) {
    return undefined;
  }
  return {
    params: snapshot.params.map((param) => ({
      name: param.name,
      type: param.type as SemanticTypeIR,
    })),
    result: snapshot.result as SemanticTypeIR,
  };
}

function lowerFunction(
  module: SourceModuleIR,
  func: SourceFunctionIR,
  sharedFacts: SharedSemanticFactsIR,
  functionResultArrayLocals: Map<string, SourceSemanticArrayLocal>,
  functionParamTypes: Map<string, readonly SemanticTypeIR[]>,
  functionResultRepresentations: Map<string, CompilerValueType>,
  functionResultTypes: Map<string, SemanticTypeIR>,
  objectLayoutsByKey: Map<string, SemanticObjectLayoutIR>,
  classesByName: ReadonlyMap<string, SourceClassIR>,
  moduleState: SourceSemanticModuleLoweringState,
  stringLiteralIds: Map<string, number>,
  stringLiterals: string[],
): SemanticFunctionIR {
  const signature = findFunctionSignature(sharedFacts, module, func);
  const boundary = signature?.boundary;
  const localRepresentations = new Map<string, CompilerValueType>();
  const arrayLocals = new Map<string, SourceSemanticArrayLocal>();
  const parameterBindings: {
    binding: SourceBindingIR;
    name: string;
    type: SemanticTypeIR;
  }[] = [];
  const params = (signature?.params ?? []).map((param, index) => {
    const binding = func.params[index];
    const name = binding?.kind === 'identifier_binding' ? binding.name : `__source_param_${index}`;
    const representation = representationForSemanticType(param.type);
    localRepresentations.set(name, representation);
    const arrayLocal = arrayLocalInfoForSemanticType(param.type);
    if (arrayLocal) {
      arrayLocals.set(name, arrayLocal);
    }
    if (binding && binding.kind !== 'identifier_binding') {
      parameterBindings.push({ binding, name, type: param.type });
    }
    return {
      name,
      representation,
      ...(boundary ? { hostBoundary: param.type } : {}),
    };
  });
  const unsupportedKinds = new Set<string>();
  const localTypesByKey = new Map(
    sharedFacts.localTypeSnapshots
      .filter((snapshot) =>
        snapshot.fileName === module.fileName && snapshot.functionName === func.name
      )
      .map((snapshot) =>
        [localTypeSnapshotKey(snapshot), snapshot.type as SemanticTypeIR] as const
      ),
  );
  const context: FunctionLoweringContext = {
    functionName: func.name,
    asyncFunction: func.async,
    currentResultType: signature?.result,
    functionResultArrayLocals,
    functionParamTypes,
    functionResultRepresentations,
    functionResultTypes,
    localRepresentations,
    locals: [],
    arrayLocals,
    boxedLocals: new Map(),
    closureLocals: new Map(),
    constructorLocals: new Map(),
    localDeclarationKinds: new Map(
      params.map((param) => [param.name, 'param' as const]),
    ),
    localTypesByKey,
    mapLocals: new Map(),
    moduleState,
    objectLayoutsByKey,
    objectLocals: new Map(),
    setLocals: new Map(),
    unionLocals: new Map(),
    classesByName,
    pendingStatements: [],
    runtimeFamilies: new Set(),
    stringLiteralIds,
    stringLiterals,
    switchBreakLocalStack: [],
    throwTargets: [],
    completionTargets: [],
    tempIndex: 0,
    unsupportedKinds,
  };
  if (!signature) {
    unsupportedKinds.add('missing_function_signature');
  }
  if (signature) {
    for (const [index, param] of signature.params.entries()) {
      const loweredParam = params[index];
      if (!loweredParam) {
        continue;
      }
      const objectLocal = objectLocalForParameterType(param.type, context);
      if (objectLocal) {
        context.objectLocals.set(loweredParam.name, objectLocal);
      }
      if (isFiniteUnionSemanticType(param.type)) {
        context.unionLocals.set(loweredParam.name, param.type);
      }
      const mapLocal = mapLocalInfoForSemanticType(param.type);
      if (mapLocal) {
        context.mapLocals.set(loweredParam.name, mapLocal);
      }
      const setLocal = setLocalInfoForSemanticType(param.type);
      if (setLocal) {
        context.setLocals.set(loweredParam.name, setLocal);
      }
      const closureLocal = closureLocalForSemanticType(param.type, context);
      if (closureLocal) {
        context.closureLocals.set(loweredParam.name, closureLocal);
      }
    }
  }
  const parameterBindingStatements = parameterBindings.flatMap((param): SemanticStatementIR[] => {
    if (param.binding.kind === 'object_binding') {
      const objectLayout = objectLocalForParameterType(param.type, context);
      if (!objectLayout) {
        context.unsupportedKinds.add('parameter_object_binding');
        return [{ kind: 'unsupported_statement', sourceKind: 'parameter_binding' }];
      }
      context.objectLocals.set(param.name, objectLayout);
      const statements = lowerObjectBindingFromLocal(
        param.binding,
        param.name,
        objectLayout,
        context,
        'parameter_binding',
      );
      return statements ?? [{ kind: 'unsupported_statement', sourceKind: 'parameter_binding' }];
    }
    if (param.binding.kind === 'array_binding') {
      const arrayLocal = arrayLocalInfoForSemanticType(param.type);
      const representation = context.localRepresentations.get(param.name);
      if (!arrayLocal || !representation) {
        context.unsupportedKinds.add('parameter_array_binding');
        return [{ kind: 'unsupported_statement', sourceKind: 'parameter_binding' }];
      }
      context.arrayLocals.set(param.name, arrayLocal);
      const statements = lowerArrayBindingFromLocal(
        param.binding,
        param.name,
        representation,
        arrayLocal,
        context,
        'parameter_binding',
      );
      return statements ?? [{ kind: 'unsupported_statement', sourceKind: 'parameter_binding' }];
    }
    context.unsupportedKinds.add('parameter_binding');
    return [{ kind: 'unsupported_statement', sourceKind: 'parameter_binding' }];
  });
  const loweredBody = lowerAwaitAsyncFunctionBody(func, context) ?? lowerFunctionBody(
    func,
    context,
  );
  const body = [
    ...parameterBindingStatements,
    ...loweredBody,
  ];
  const unsupportedBodyKinds = [...unsupportedKinds].sort();
  const result = signature ? representationForSemanticType(signature.result) : 'tagged_ref';
  const runtimeFamilies = signature
    ? collectSemanticRuntimeFamiliesFromTypes([
      ...signature.params.map((param) => param.type),
      signature.result,
    ])
    : [];
  const functionRuntimeFamilies = [...new Set([...runtimeFamilies, ...context.runtimeFamilies])]
    .sort();

  return {
    name: func.name,
    exportName: boundary ? `${boundary.path}:${boundary.name}` : '',
    params,
    locals: context.locals,
    result,
    body,
    bodyStatus: unsupportedBodyKinds.length === 0 ? 'emittable' : 'stub',
    unsupportedBodyKinds,
    runtimeFamilies: functionRuntimeFamilies,
    hostImported: false,
    hostExported: func.exported,
    unionBoundaries: [],
  };
}

function codeUnitsForString(value: string): readonly number[] {
  const codeUnits: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    codeUnits.push(value.charCodeAt(index));
  }
  return codeUnits;
}

export function createSemanticModuleFromSourceHIR(
  source: { kind: 'source_hir'; modules: readonly SourceModuleIR[] },
  sharedFacts: SharedSemanticFactsIR,
): SemanticModuleIR {
  const stringLiteralIds = new Map<string, number>();
  const stringLiterals: string[] = [];
  const objectLayoutsByKey = new Map(
    (sharedFacts.objectLayouts as readonly SemanticObjectLayoutIR[]).map((layout) =>
      [
        `${layout.family}:${layout.name}`,
        layout,
      ] as const
    ),
  );
  const moduleState: SourceSemanticModuleLoweringState = {
    closureSignatures: [],
    closureSignaturesByKey: new Map(),
    generatedFunctions: [],
    nextClosureFunctionId: 0,
    nextClosureSignatureId: 0,
  };
  const classesByName = new Map(
    source.modules.flatMap((module) =>
      module.classes.map((classInfo) => [classInfo.name, classInfo] as const)
    ),
  );
  const functionResultRepresentations = new Map<string, CompilerValueType>();
  const functionResultArrayLocals = new Map<string, SourceSemanticArrayLocal>();
  const functionResultTypes = new Map<string, SemanticTypeIR>();
  const functionParamTypes = new Map<string, readonly SemanticTypeIR[]>();
  for (const module of source.modules) {
    for (const func of module.functions) {
      const signature = findFunctionSignature(sharedFacts, module, func);
      if (signature) {
        functionParamTypes.set(func.name, signature.params.map((param) => param.type));
        functionResultTypes.set(func.name, signature.result);
        functionResultRepresentations.set(
          func.name,
          representationForSemanticType(signature.result),
        );
        const arrayLocal = arrayLocalInfoForSemanticType(signature.result);
        if (arrayLocal) {
          functionResultArrayLocals.set(func.name, arrayLocal);
        }
      }
    }
  }
  const functions = source.modules.flatMap((module) =>
    module.functions.map((func) =>
      lowerFunction(
        module,
        func,
        sharedFacts,
        functionResultArrayLocals,
        functionParamTypes,
        functionResultRepresentations,
        functionResultTypes,
        objectLayoutsByKey,
        classesByName,
        moduleState,
        stringLiteralIds,
        stringLiterals,
      )
    )
  );
  const allFunctions = [...functions, ...moduleState.generatedFunctions];
  const boundarySurfaces = sharedFacts.boundarySurfaces.map((surface) => ({
    ...(surface as SemanticBoundarySurfaceIR),
    runtimeFamilies: collectSemanticRuntimeFamiliesFromTypes([
      ...surface.params.map((param) => param.type as SemanticTypeIR),
      surface.result as SemanticTypeIR,
    ]),
  }));
  const runtimeFamilies = new Set<SemanticRuntimeFamilyId>();
  boundarySurfaces.forEach((surface) =>
    surface.runtimeFamilies.forEach((family) => runtimeFamilies.add(family))
  );
  allFunctions.forEach((func) =>
    func.runtimeFamilies.forEach((family) => runtimeFamilies.add(family))
  );
  if (moduleState.closureSignatures.length > 0) {
    runtimeFamilies.add('closure');
  }

  return {
    kind: 'semantic_module',
    functions: allFunctions,
    moduleGlobals: [],
    closureSignatures: moduleState.closureSignatures,
    stringLiterals,
    stringLiteralCodeUnits: stringLiterals.map(codeUnitsForString),
    typeSnapshots: sharedFacts.typeSnapshots as SemanticModuleIR['typeSnapshots'],
    boundarySurfaces,
    objectLayouts: [...objectLayoutsByKey.values()].sort((left, right) =>
      left.family === right.family
        ? left.name.localeCompare(right.name)
        : left.family.localeCompare(right.family)
    ),
    unionBoundaries: [],
    runtimeFamilies: [...runtimeFamilies].sort(),
    diagnostics: [],
  };
}
