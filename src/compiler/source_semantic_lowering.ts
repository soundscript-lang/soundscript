import type { CompilerValueType } from './ir.ts';
import type {
  SourceExpressionIR,
  SourceFunctionIR,
  SourceModuleIR,
  SourceStatementIR,
} from './source_hir.ts';
import {
  collectSemanticRuntimeFamiliesFromTypes,
  type SemanticBoundarySurfaceIR,
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
  representationName: string;
  fields: readonly {
    name: string;
    representation: CompilerValueType;
  }[];
}

interface SourceSemanticArrayLocal {
  elementRepresentation: CompilerValueType;
}

interface FunctionLoweringContext {
  functionResultRepresentations: Map<string, CompilerValueType>;
  localRepresentations: Map<string, CompilerValueType>;
  locals: { name: string; representation: CompilerValueType }[];
  arrayLocals: Map<string, SourceSemanticArrayLocal>;
  objectLayoutsByKey: Map<string, SemanticObjectLayoutIR>;
  objectLocals: Map<string, SourceSemanticObjectLocal>;
  pendingStatements: SemanticStatementIR[];
  runtimeFamilies: Set<SemanticRuntimeFamilyId>;
  stringLiteralIds: Map<string, number>;
  stringLiterals: string[];
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

function binaryOperatorForSource(
  operator: string,
  left: SemanticExpressionIR,
  right: SemanticExpressionIR,
): { op: string; representation: CompilerValueType } | undefined {
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
      return { kind: 'local_get', name: expression.name, representation };
    }
    case 'property_access': {
      if (expression.object.kind === 'identifier') {
        const objectLayout = context.objectLocals.get(expression.object.name);
        const fieldIndex = objectLayout?.fields.findIndex((field) =>
          field.name === expression.property
        ) ?? -1;
        if (objectLayout && fieldIndex >= 0) {
          const field = objectLayout.fields[fieldIndex]!;
          const tempName = nextTempLocalName(context, `field_${expression.object.name}`);
          addLocal(context, tempName, field.representation);
          context.pendingStatements.push({
            kind: 'specialized_object_field_get',
            targetName: tempName,
            objectName: expression.object.name,
            representationName: objectLayout.representationName,
            fieldIndex,
            fieldName: field.name,
          });
          context.runtimeFamilies.add('specialized_object');
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

function lowerStatement(
  statement: SourceStatementIR,
  context: FunctionLoweringContext,
): readonly SemanticStatementIR[] {
  switch (statement.kind) {
    case 'variable_declaration': {
      return statement.declarations.flatMap((declaration): SemanticStatementIR[] => {
        if (declaration.binding.kind !== 'identifier_binding' || !declaration.initializer) {
          context.unsupportedKinds.add('variable_declaration');
          return [{ kind: 'unsupported_statement', sourceKind: 'variable_declaration' }];
        }
        if (declaration.initializer.kind === 'object_literal') {
          const fieldValueNames: string[] = [];
          const fieldTypes: { name: string; representation: CompilerValueType }[] = [];
          const statements: SemanticStatementIR[] = [];
          for (const property of declaration.initializer.properties) {
            const value = lowerExpression(property.value, context);
            statements.push(...takePendingStatements(context));
            const valueName = nextTempLocalName(context, `object_${declaration.binding.name}`);
            addLocal(context, valueName, value.representation);
            statements.push({ kind: 'local_set', name: valueName, value });
            fieldValueNames.push(valueName);
            fieldTypes.push({ name: property.name, representation: value.representation });
          }
          const representationName = registerSpecializedObjectLayout(context, fieldTypes);
          addLocal(context, declaration.binding.name, 'heap_ref');
          context.objectLocals.set(declaration.binding.name, {
            representationName,
            fields: fieldTypes,
          });
          statements.push({
            kind: 'specialized_object_new',
            targetName: declaration.binding.name,
            representationName,
            fieldValueNames,
          });
          return statements;
        }
        const value = lowerExpression(declaration.initializer, context);
        const statements = takePendingStatements(context);
        addLocal(context, declaration.binding.name, value.representation);
        const arrayLocal = arrayLocalInfoForExpression(value);
        if (arrayLocal) {
          context.arrayLocals.set(declaration.binding.name, arrayLocal);
        }
        return [...statements, { kind: 'local_set', name: declaration.binding.name, value }];
      });
    }
    case 'expression_statement': {
      if (
        statement.expression.kind === 'assignment_expression' &&
        statement.expression.operator === '='
      ) {
        const assignment = statement.expression;
        if (assignment.left.kind === 'identifier') {
          const value = lowerExpression(assignment.right, context);
          const target = assignment.left.name;
          if (!context.localRepresentations.has(target)) {
            context.unsupportedKinds.add(`unbound_assignment:${target}`);
            return [{ kind: 'unsupported_statement', sourceKind: 'assignment_expression' }];
          }
          const statements = takePendingStatements(context);
          const arrayLocal = arrayLocalInfoForExpression(value);
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
          const value = lowerExpression(assignment.right, context);
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
          if (objectLayout && fieldIndex >= 0) {
            const field = objectLayout.fields[fieldIndex]!;
            const value = lowerExpression(assignment.right, context);
            if (value.representation !== field.representation) {
              context.unsupportedKinds.add(`property_assignment:${field.name}`);
              return [{ kind: 'unsupported_statement', sourceKind: 'assignment_expression' }];
            }
            context.runtimeFamilies.add('specialized_object');
            return [
              ...takePendingStatements(context),
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
      if (condition.representation !== 'i32') {
        context.unsupportedKinds.add('if_condition');
      }
      return [{
        kind: 'if',
        condition,
        thenBody: statement.consequent.flatMap((child) => [...lowerStatement(child, context)]),
        elseBody: statement.alternate.flatMap((child) => [...lowerStatement(child, context)]),
      }];
    }
    case 'while': {
      const condition = lowerExpression(statement.test, context);
      if (condition.representation !== 'i32') {
        context.unsupportedKinds.add('while_condition');
      }
      return [{
        kind: 'while',
        condition,
        body: statement.body.flatMap((child) => [...lowerStatement(child, context)]),
      }];
    }
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
  functionResultRepresentations: Map<string, CompilerValueType>,
  objectLayoutsByKey: Map<string, SemanticObjectLayoutIR>,
  stringLiteralIds: Map<string, number>,
  stringLiterals: string[],
): SemanticFunctionIR {
  const signature = findFunctionSignature(sharedFacts, module, func);
  const boundary = signature?.boundary;
  const localRepresentations = new Map<string, CompilerValueType>();
  const arrayLocals = new Map<string, SourceSemanticArrayLocal>();
  const params = (signature?.params ?? []).map((param) => {
    const representation = representationForSemanticType(param.type);
    localRepresentations.set(param.name, representation);
    const arrayLocal = arrayLocalInfoForSemanticType(param.type);
    if (arrayLocal) {
      arrayLocals.set(param.name, arrayLocal);
    }
    return {
      name: param.name,
      representation,
      ...(boundary ? { hostBoundary: param.type } : {}),
    };
  });
  const unsupportedKinds = new Set<string>();
  const context: FunctionLoweringContext = {
    functionResultRepresentations,
    localRepresentations,
    locals: [],
    arrayLocals,
    objectLayoutsByKey,
    objectLocals: new Map(),
    pendingStatements: [],
    runtimeFamilies: new Set(),
    stringLiteralIds,
    stringLiterals,
    tempIndex: 0,
    unsupportedKinds,
  };
  if (!signature) {
    unsupportedKinds.add('missing_function_signature');
  }
  const body = lowerFunctionBody(func, context);
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
  const functionResultRepresentations = new Map<string, CompilerValueType>();
  for (const module of source.modules) {
    for (const func of module.functions) {
      const signature = findFunctionSignature(sharedFacts, module, func);
      if (signature) {
        functionResultRepresentations.set(
          func.name,
          representationForSemanticType(signature.result),
        );
      }
    }
  }
  const functions = source.modules.flatMap((module) =>
    module.functions.map((func) =>
      lowerFunction(
        module,
        func,
        sharedFacts,
        functionResultRepresentations,
        objectLayoutsByKey,
        stringLiteralIds,
        stringLiterals,
      )
    )
  );
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
  functions.forEach((func) =>
    func.runtimeFamilies.forEach((family) => runtimeFamilies.add(family))
  );

  return {
    kind: 'semantic_module',
    functions,
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
