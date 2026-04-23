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
  type SemanticRuntimeFamilyId,
  type SemanticStatementIR,
  type SemanticTypeIR,
} from './semantic_ir.ts';
import type { SharedSemanticFactsIR } from '../semantic/shared_semantic_facts.ts';

interface FunctionLoweringContext {
  localRepresentations: Map<string, CompilerValueType>;
  stringLiteralIds: Map<string, number>;
  stringLiterals: string[];
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
    case 'return':
      return [{
        kind: 'return',
        value: statement.expression
          ? lowerExpression(statement.expression, context)
          : { kind: 'undefined_literal', representation: 'tagged_ref' },
      }];
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

function lowerFunction(
  module: SourceModuleIR,
  func: SourceFunctionIR,
  sharedFacts: SharedSemanticFactsIR,
  stringLiteralIds: Map<string, number>,
  stringLiterals: string[],
): SemanticFunctionIR {
  const boundary = findBoundarySurface(sharedFacts, module, func);
  const localRepresentations = new Map<string, CompilerValueType>();
  const params = (boundary?.params ?? []).map((param) => {
    const representation = representationForSemanticType(param.type as SemanticTypeIR);
    localRepresentations.set(param.name, representation);
    return {
      name: param.name,
      representation,
      hostBoundary: param.type as SemanticTypeIR,
    };
  });
  const unsupportedKinds = new Set<string>();
  const context: FunctionLoweringContext = {
    localRepresentations,
    stringLiteralIds,
    stringLiterals,
    unsupportedKinds,
  };
  if (!boundary && func.exported) {
    unsupportedKinds.add('missing_boundary_surface');
  }
  const body = lowerFunctionBody(func, context);
  const unsupportedBodyKinds = [...unsupportedKinds].sort();
  const result = boundary
    ? representationForSemanticType(boundary.result as SemanticTypeIR)
    : 'tagged_ref';
  const runtimeFamilies = boundary
    ? collectSemanticRuntimeFamiliesFromTypes([
      ...boundary.params.map((param) => param.type as SemanticTypeIR),
      boundary.result as SemanticTypeIR,
    ])
    : [];

  return {
    name: func.name,
    exportName: boundary ? `${boundary.path}:${boundary.name}` : func.name,
    params,
    locals: [],
    result,
    body,
    bodyStatus: unsupportedBodyKinds.length === 0 ? 'emittable' : 'stub',
    unsupportedBodyKinds,
    runtimeFamilies,
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
  const functions = source.modules.flatMap((module) =>
    module.functions.map((func) =>
      lowerFunction(module, func, sharedFacts, stringLiteralIds, stringLiterals)
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
    objectLayouts: sharedFacts.objectLayouts as SemanticModuleIR['objectLayouts'],
    unionBoundaries: [],
    runtimeFamilies: [...runtimeFamilies].sort(),
    diagnostics: [],
  };
}
