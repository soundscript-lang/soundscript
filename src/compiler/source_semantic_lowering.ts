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

interface FunctionLoweringContext {
  functionResultRepresentations: Map<string, CompilerValueType>;
  localRepresentations: Map<string, CompilerValueType>;
  locals: { name: string; representation: CompilerValueType }[];
  objectLayoutsByKey: Map<string, SemanticObjectLayoutIR>;
  objectLocals: Map<string, SourceSemanticObjectLocal>;
  pendingStatements: SemanticStatementIR[];
  runtimeFamilies: Set<SemanticRuntimeFamilyId>;
  stringLiteralIds: Map<string, number>;
  stringLiterals: string[];
  tempIndex: number;
  unsupportedKinds: Set<string>;
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
      return 'owned_array_ref';
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
      if (object.representation === 'owned_number_array_ref' && index.representation === 'f64') {
        context.runtimeFamilies.add('array');
        return {
          kind: 'owned_number_array_element',
          value: object,
          index,
          representation: 'f64',
        };
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
          return [...statements, { kind: 'local_set', name: target, value }];
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
  const params = (signature?.params ?? []).map((param) => {
    const representation = representationForSemanticType(param.type);
    localRepresentations.set(param.name, representation);
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
