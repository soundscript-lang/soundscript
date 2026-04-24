import type { CompilerValueType } from './ir.ts';
import type {
  SourceBindingIR,
  SourceClassIR,
  SourceExpressionIR,
  SourceFunctionIR,
  SourceModuleIR,
  SourceStatementIR,
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
  dynamicValueRepresentation?: CompilerValueType;
  fields: readonly {
    name: string;
    representation: CompilerValueType;
  }[];
}

interface SourceSemanticArrayLocal {
  elementRepresentation: CompilerValueType;
}

interface SourceSemanticClosureLocal {
  resultRepresentation: CompilerValueType;
  signatureId: number;
}

type SourceSemanticLocalDeclarationKind = 'const' | 'let' | 'var' | 'param' | 'capture';

interface SourceSemanticModuleLoweringState {
  closureSignatures: SemanticClosureSignatureIR[];
  generatedFunctions: SemanticFunctionIR[];
  nextClosureFunctionId: number;
  nextClosureSignatureId: number;
}

interface FunctionLoweringContext {
  functionName: string;
  functionResultArrayLocals: Map<string, SourceSemanticArrayLocal>;
  functionResultRepresentations: Map<string, CompilerValueType>;
  localRepresentations: Map<string, CompilerValueType>;
  locals: { name: string; representation: CompilerValueType }[];
  arrayLocals: Map<string, SourceSemanticArrayLocal>;
  boxedLocals: Map<string, CompilerValueType>;
  closureLocals: Map<string, SourceSemanticClosureLocal>;
  localDeclarationKinds: Map<string, SourceSemanticLocalDeclarationKind>;
  localTypesByKey: Map<string, SemanticTypeIR>;
  moduleState: SourceSemanticModuleLoweringState;
  objectLayoutsByKey: Map<string, SemanticObjectLayoutIR>;
  objectLocals: Map<string, SourceSemanticObjectLocal>;
  classesByName: ReadonlyMap<string, SourceClassIR>;
  pendingStatements: SemanticStatementIR[];
  runtimeFamilies: Set<SemanticRuntimeFamilyId>;
  stringLiteralIds: Map<string, number>;
  stringLiterals: string[];
  switchBreakLocalStack: string[];
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

function arrayLocalInfoForSemanticType(type: SemanticTypeIR): SourceSemanticArrayLocal | undefined {
  if (type.kind !== 'array') {
    return undefined;
  }
  return {
    elementRepresentation: arrayElementRepresentationForSemanticType(type.element),
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
  const signature: SemanticClosureSignatureIR = {
    id: moduleState.nextClosureSignatureId,
    params: params.map(representationForSemanticType),
    resultType: representationForSemanticType(result),
  };
  moduleState.nextClosureSignatureId += 1;
  moduleState.closureSignatures.push(signature);
  return signature;
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
  const consequent = lowerExpression(expression.consequent, context);
  const consequentStatements = takePendingStatements(context);
  const alternate = lowerExpression(expression.alternate, context);
  const alternateStatements = takePendingStatements(context);
  if (
    condition.representation !== 'i32' || consequent.representation !== alternate.representation
  ) {
    return undefined;
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
      if (expression.object.kind === 'identifier') {
        const objectLayout = context.objectLocals.get(expression.object.name);
        const field = objectLayout?.fields.find((candidate) =>
          candidate.name === expression.property
        );
        if (objectLayout && field) {
          const tempName = nextTempLocalName(context, `field_${expression.object.name}`);
          addLocal(context, tempName, field.representation);
          const getStatement = objectFieldGetStatementForLocal(
            tempName,
            expression.object.name,
            objectLayout,
            expression.property,
          );
          if (!getStatement) {
            context.unsupportedKinds.add(`property_access:${expression.property}`);
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
      }
      const object = lowerExpression(expression.object, context);
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
    case 'call_expression': {
      if (expression.callee.kind !== 'identifier') {
        context.unsupportedKinds.add('call_expression');
        return { kind: 'undefined_literal', representation: 'tagged_ref' };
      }
      const closureLocal = context.closureLocals.get(expression.callee.name);
      if (closureLocal) {
        return {
          kind: 'closure_call',
          callee: {
            kind: 'local_get',
            name: expression.callee.name,
            representation: 'closure_ref',
          },
          args: expression.args.map((arg) => lowerExpression(arg, context)),
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
        args: expression.args.map((arg) => lowerExpression(arg, context)),
        representation,
      };
    }
    case 'binary_expression': {
      const left = lowerExpression(expression.left, context);
      const right = lowerExpression(expression.right, context);
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
  const fields = type.fields.map((field) => ({
    name: field.name,
    representation: representationForSemanticType(field.type as SemanticTypeIR),
  }));
  return objectLocalForSemanticType(type, fields, context);
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

function lowerTryStatement(
  statement: Extract<SourceStatementIR, { kind: 'try' }>,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  if (statement.catchBlock || statement.catchBinding) {
    context.unsupportedKinds.add('try_catch');
    return [{ kind: 'unsupported_statement', sourceKind: 'try' }];
  }
  const finallyBlock = statement.finallyBlock ?? [];
  if (
    sourceStatementsContainControlTransfer(statement.tryBlock) ||
    sourceStatementsContainControlTransfer(finallyBlock)
  ) {
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
    functionResultArrayLocals: parentContext.functionResultArrayLocals,
    functionResultRepresentations: parentContext.functionResultRepresentations,
    localRepresentations,
    locals: [],
    arrayLocals,
    boxedLocals,
    closureLocals: new Map(),
    localDeclarationKinds,
    localTypesByKey: new Map(),
    moduleState: parentContext.moduleState,
    objectLayoutsByKey: parentContext.objectLayoutsByKey,
    objectLocals: new Map(),
    classesByName: parentContext.classesByName,
    pendingStatements: [],
    runtimeFamilies: new Set(),
    stringLiteralIds: parentContext.stringLiteralIds,
    stringLiterals: parentContext.stringLiterals,
    switchBreakLocalStack: [],
    tempIndex: 0,
    unsupportedKinds,
  };
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

function lowerClassConstructionDeclaration(
  targetName: string,
  initializer: Extract<SourceExpressionIR, { kind: 'new_expression' }>,
  declarationKind: SourceSemanticLocalDeclarationKind,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] | undefined {
  if (initializer.callee.kind !== 'identifier') {
    context.unsupportedKinds.add('class_constructor_callee');
    return undefined;
  }
  const classInfo = context.classesByName.get(initializer.callee.name);
  if (!classInfo) {
    return undefined;
  }
  const unsupportedMember = classInfo.members.find((member) =>
    member.static || member.kind === 'method' || member.kind === 'getter' ||
    member.kind === 'setter'
  );
  if (unsupportedMember) {
    context.unsupportedKinds.add(`class_member:${unsupportedMember.kind}`);
    return undefined;
  }
  const properties = classInfo.members.filter((member) => member.kind === 'property');
  if (properties.some((property) => !property.initializer)) {
    context.unsupportedKinds.add('class_property_initializer');
    return undefined;
  }
  const constructor = classInfo.members.find((member) => member.kind === 'constructor');
  if (constructor && constructor.params.length !== initializer.args.length) {
    context.unsupportedKinds.add('class_constructor_arity');
    return undefined;
  }
  const constructorParamNames = constructor
    ? constructor.params.map((param, index) =>
      param.kind === 'identifier_binding' ? param.name : `__source_class_param_${index}`
    )
    : [];
  const transientNames = ['this', ...constructorParamNames];
  if (
    transientNames.includes(targetName) ||
    transientNames.some((name) =>
      context.localRepresentations.has(name) ||
      context.objectLocals.has(name) ||
      context.arrayLocals.has(name) ||
      context.closureLocals.has(name) ||
      context.boxedLocals.has(name)
    )
  ) {
    context.unsupportedKinds.add('class_constructor_binding_collision');
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
    addLocal(context, param.name, value.representation);
    context.localDeclarationKinds.set(param.name, 'param');
    statements.push({ kind: 'local_set', name: param.name, value });
  }
  addLocal(context, 'this', 'heap_ref');
  context.localDeclarationKinds.set('this', 'param');
  context.objectLocals.set('this', objectLocal);
  statements.push({
    kind: 'local_set',
    name: 'this',
    value: { kind: 'local_get', name: targetName, representation: 'heap_ref' },
  });
  statements.push(
    ...constructor.body.flatMap((statement) => [...lowerStatement(statement, context)]),
  );
  for (const name of transientNames) {
    context.localRepresentations.delete(name);
    context.arrayLocals.delete(name);
    context.boxedLocals.delete(name);
    context.closureLocals.delete(name);
    context.localDeclarationKinds.delete(name);
    context.objectLocals.delete(name);
  }
  return statements;
}

function lowerStatement(
  statement: SourceStatementIR,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  switch (statement.kind) {
    case 'variable_declaration': {
      return statement.declarations.flatMap((declaration): SemanticStatementIR[] => {
        if (
          declaration.binding.kind === 'object_binding' &&
          declaration.initializer?.kind === 'identifier'
        ) {
          const initializer = lowerExpression(declaration.initializer, context);
          const statements = takePendingStatements(context);
          const objectName = declaration.initializer.name;
          const objectLayout = context.objectLocals.get(objectName);
          if (!objectLayout || initializer.representation !== 'heap_ref') {
            context.unsupportedKinds.add(`object_binding:${objectName}`);
            return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
          }
          const bindingStatements = lowerObjectBindingFromLocal(
            declaration.binding,
            objectName,
            objectLayout,
            context,
            'variable_declaration',
          );
          if (!bindingStatements) {
            return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
          }
          return [...statements, ...bindingStatements];
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
        if (declaration.initializer.kind === 'new_expression') {
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
        addLocal(context, declaration.binding.name, value.representation);
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
      const value = statement.expression
        ? lowerExpression(statement.expression, context)
        : { kind: 'undefined_literal', representation: 'tagged_ref' } as SemanticExpressionIR;
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
      return [{ kind: 'break' }];
    }
    case 'continue':
      return [{ kind: 'continue' }];
    case 'throw': {
      const value = lowerExpression(statement.expression, context);
      return [...takePendingStatements(context), { kind: 'throw_tagged', value }];
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
  functionResultRepresentations: Map<string, CompilerValueType>,
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
    functionResultArrayLocals,
    functionResultRepresentations,
    localRepresentations,
    locals: [],
    arrayLocals,
    boxedLocals: new Map(),
    closureLocals: new Map(),
    localDeclarationKinds: new Map(
      params.map((param) => [param.name, 'param' as const]),
    ),
    localTypesByKey,
    moduleState,
    objectLayoutsByKey,
    objectLocals: new Map(),
    classesByName,
    pendingStatements: [],
    runtimeFamilies: new Set(),
    stringLiteralIds,
    stringLiterals,
    switchBreakLocalStack: [],
    tempIndex: 0,
    unsupportedKinds,
  };
  if (!signature) {
    unsupportedKinds.add('missing_function_signature');
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
  const body = [
    ...parameterBindingStatements,
    ...lowerFunctionBody(func, context),
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
  for (const module of source.modules) {
    for (const func of module.functions) {
      const signature = findFunctionSignature(sharedFacts, module, func);
      if (signature) {
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
        functionResultRepresentations,
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
