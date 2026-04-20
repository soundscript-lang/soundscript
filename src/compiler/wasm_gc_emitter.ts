import type { SemanticExpressionIR, SemanticStatementIR, SemanticTypeIR } from './semantic_ir.ts';
import type {
  WasmGcBoundaryPlanIR,
  WasmGcBoundaryValuePlanIR,
  WasmGcFieldPlanIR,
  WasmGcFunctionPlanIR,
  WasmGcHelperPlanIR,
  WasmGcModulePlanIR,
  WasmGcTypePlanIR,
} from './wasm_gc_backend_ir.ts';

function sanitizeIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized : 'value';
}

function joinOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(',') : 'none';
}

function indentLines(lines: readonly string[]): readonly string[] {
  return lines.map((line) => `  ${line}`);
}

function wasmTypeForSemanticType(type: SemanticTypeIR): string {
  switch (type.kind) {
    case 'boolean':
      return 'i32';
    case 'number':
      return 'f64';
    case 'undefined':
    case 'null':
    case 'host_handle':
      return 'externref';
    case 'string':
    case 'bigint':
    case 'symbol':
    case 'object':
    case 'array':
    case 'map':
    case 'set':
    case 'promise':
    case 'generator':
    case 'closure':
    case 'class_constructor':
    case 'finite_union':
    case 'union':
    case 'value_class':
      return '(ref null eq)';
    case 'machine_numeric':
      return 'reserved';
    default: {
      const exhaustiveCheck: never = type;
      return exhaustiveCheck;
    }
  }
}

function renderField(field: WasmGcFieldPlanIR): string {
  return `    (field $${sanitizeIdentifier(field.name)} (mut ${field.wasmType}))`;
}

function renderRuntimeFamilyTypePlan(plan: WasmGcTypePlanIR): readonly string[] {
  if (plan.family === 'array') {
    return [`  (type ${plan.name} (array (mut f64)))`];
  }
  return [`  ;; runtime-family ${plan.family} type ${plan.name} kind=${plan.wasmKind}`];
}

function renderObjectLayoutTypePlan(plan: WasmGcTypePlanIR): readonly string[] {
  const fields = plan.fields ?? [];
  if (fields.length === 0) {
    return [`  (type ${plan.name} (struct))`];
  }
  return [
    `  (type ${plan.name} (struct`,
    ...fields.map(renderField),
    '  ))',
  ];
}

function renderBoundaryValueTypePlan(plan: WasmGcTypePlanIR): readonly string[] {
  const boundary = plan.boundary;
  const semanticType = plan.semanticType;
  if (!boundary || !semanticType) {
    return [`  ;; boundary-value ${plan.name} missing-boundary-metadata`];
  }
  return [
    `  ;; boundary-value ${boundary.direction} ${boundary.name} ${boundary.path} ` +
    `${plan.wasmKind} ${wasmTypeForSemanticType(semanticType)} ` +
    `families=${joinOrNone(plan.runtimeFamilies ?? [])}`,
  ];
}

function renderTypePlan(plan: WasmGcTypePlanIR): readonly string[] {
  switch (plan.source) {
    case 'runtime_family':
      return renderRuntimeFamilyTypePlan(plan);
    case 'object_layout':
      return renderObjectLayoutTypePlan(plan);
    case 'boundary_value':
      return renderBoundaryValueTypePlan(plan);
    default: {
      const exhaustiveCheck: never = plan.source;
      return exhaustiveCheck;
    }
  }
}

function helperLabel(helper: WasmGcHelperPlanIR): string {
  return helper.kind === 'adapter' ? 'adapter' : 'helper';
}

function renderHelperPlan(helper: WasmGcHelperPlanIR): string {
  return `  ;; ${helperLabel(helper)} ${helper.name} family=${helper.family} kind=${helper.kind}`;
}

function renderBoundaryValue(
  role: 'param' | 'result',
  value: WasmGcBoundaryValuePlanIR,
): string {
  const name = value.name ? ` ${sanitizeIdentifier(value.name)}: ` : ' ';
  return `    ;; ${role}${name}${wasmTypeForSemanticType(value.type)} families=${
    joinOrNone(value.runtimeFamilies)
  }`;
}

function boundaryFunctionName(boundary: WasmGcBoundaryPlanIR): string {
  return `$__wasm_gc_boundary_${boundary.direction}_${sanitizeIdentifier(boundary.name)}`;
}

function renderBoundaryPlan(boundary: WasmGcBoundaryPlanIR): readonly string[] {
  return [
    `  (func ${boundaryFunctionName(boundary)}`,
    ...boundary.params.map((param) => renderBoundaryValue('param', param)),
    renderBoundaryValue('result', boundary.result),
    `    ;; adapters=${joinOrNone(boundary.adapterHelpers)}`,
    `    ;; wrapper_hooks=${joinOrNone(boundary.wrapperHooks)}`,
    '  )',
  ];
}

function wasmTypeForCompilerValueType(valueType: string): string {
  switch (valueType) {
    case 'f64':
    case 'i32':
      return valueType;
    case 'string_ref':
    case 'owned_string_ref':
    case 'symbol_ref':
      return 'externref';
    case 'tagged_ref':
      return `(ref null ${taggedValueTypeName()})`;
    case 'heap_ref':
    case 'box_ref':
    case 'closure_ref':
    case 'class_constructor_ref':
      return '(ref null eq)';
    case 'owned_number_array_ref':
      return '(ref $array_runtime)';
    case 'owned_array_ref':
    case 'owned_heap_array_ref':
    case 'owned_boolean_array_ref':
    case 'owned_tagged_array_ref':
      return '(ref null eq)';
    default:
      return valueType;
  }
}

function taggedValueTypeName(): string {
  return '$tagged_value';
}

function wasmTypeForHostFunctionParam(
  param: WasmGcFunctionPlanIR['params'][number],
): string {
  const boundary = param.hostBoundary;
  if (boundary?.kind === 'closure' && boundary.signatureIds?.length === 1) {
    return `(ref null ${closureSignatureTypeName(boundary.signatureIds[0])})`;
  }
  return wasmTypeForCompilerValueType(param.wasmType);
}

function objectLayoutTypeName(representationName: string): string {
  return `$object_layout_${sanitizeIdentifier(representationName)}`;
}

function closureSignatureTypeName(signatureId: number): string {
  return `$closure_sig_${signatureId}`;
}

function closureFunctionName(functionId: number): string {
  return `$closure_${functionId}`;
}

function closureEnvTypeName(functionId: number): string {
  return `$closure_env_${functionId}`;
}

function boxTypeName(valueType: string): string {
  return `$box_${sanitizeIdentifier(valueType)}`;
}

const TAGGED_NUMBER_TAG = 2;
const TAGGED_BOOLEAN_TAG = 1;
const TAGGED_STRING_TAG = 3;
const TAGGED_HEAP_OBJECT_TAG = 4;
const TAGGED_SYMBOL_TAG = 5;
const TAGGED_NULL_TAG = 6;

interface FunctionRenderContext {
  boxLocalValueTypes: ReadonlyMap<string, string>;
  closureLocalLiterals: ReadonlyMap<
    string,
    Extract<SemanticExpressionIR, { kind: 'closure_literal' }>
  >;
  fallbackObjectLocalLayouts: ReadonlyMap<string, FallbackObjectLocalLayout>;
  dynamicObjectLocalLayouts: ReadonlyMap<string, DynamicObjectLocalLayout>;
  localAliases: ReadonlyMap<string, string>;
}

interface FallbackObjectLocalLayout {
  typeName: string;
  entries: Extract<SemanticStatementIR, { kind: 'fallback_object_new' }>['entries'];
}

interface DynamicObjectLocalLayout {
  typeName: string;
  entries: readonly {
    keyName: string;
    valueName: string;
    valueType: string;
  }[];
}

const EMPTY_RENDER_CONTEXT: FunctionRenderContext = {
  boxLocalValueTypes: new Map(),
  closureLocalLiterals: new Map(),
  fallbackObjectLocalLayouts: new Map(),
  dynamicObjectLocalLayouts: new Map(),
  localAliases: new Map(),
};

function closureLocalLiterals(
  func: WasmGcFunctionPlanIR,
): ReadonlyMap<string, Extract<SemanticExpressionIR, { kind: 'closure_literal' }>> {
  const literals = new Map<string, Extract<SemanticExpressionIR, { kind: 'closure_literal' }>>();
  for (const statement of func.body) {
    if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'closure_literal'
    ) {
      literals.set(statement.name, statement.value);
    }
  }
  return literals;
}

function boxLocalValueTypes(func: WasmGcFunctionPlanIR): ReadonlyMap<string, string> {
  const valueTypes = new Map<string, string>();
  for (const statement of func.body) {
    if (statement.kind === 'local_set' && statement.value.kind === 'box_new') {
      valueTypes.set(statement.name, statement.value.valueType);
    }
  }
  return valueTypes;
}

function localAliases(func: WasmGcFunctionPlanIR): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of func.body) {
    if (statement.kind !== 'local_set' || statement.value.kind !== 'local_get') {
      continue;
    }
    aliases.set(statement.name, resolveLocalAlias(statement.value.name, aliases));
  }
  return aliases;
}

function resolveLocalAlias(name: string, aliases: ReadonlyMap<string, string>): string {
  let current = name;
  const seen = new Set<string>();
  while (aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = aliases.get(current)!;
  }
  return current;
}

function fallbackObjectLayoutTypeName(
  representationName: string,
  keys: readonly string[],
): string {
  return `$fallback_object_layout_${sanitizeIdentifier(representationName)}_${
    keys.map(sanitizeIdentifier).join('_') || 'empty'
  }`;
}

function fallbackObjectLocalLayouts(
  func: WasmGcFunctionPlanIR,
): ReadonlyMap<string, FallbackObjectLocalLayout> {
  const layouts = new Map<string, FallbackObjectLocalLayout>();
  for (const statement of func.body) {
    if (statement.kind === 'fallback_object_new') {
      layouts.set(statement.targetName, {
        typeName: fallbackObjectLayoutTypeName(
          statement.representationName,
          statement.entries.map((entry) => entry.key),
        ),
        entries: statement.entries,
      });
    }
  }
  return layouts;
}

function dynamicObjectLayoutTypeName(
  representationName: string,
  entryCount: number,
): string {
  return `$dynamic_object_layout_${sanitizeIdentifier(representationName)}_${entryCount}`;
}

function dynamicObjectLocalLayouts(
  func: WasmGcFunctionPlanIR,
): ReadonlyMap<string, DynamicObjectLocalLayout> {
  const layouts = new Map<string, DynamicObjectLocalLayout>();
  for (const statement of func.body) {
    if (statement.kind === 'dynamic_object_new') {
      layouts.set(statement.targetName, {
        typeName: dynamicObjectLayoutTypeName(
          statement.representationName,
          Math.max(statement.entries.length, 1),
        ),
        entries: statement.entries,
      });
    } else if (
      statement.kind === 'local_set' &&
      statement.value.kind === 'local_get' &&
      layouts.has(statement.value.name)
    ) {
      layouts.set(statement.name, layouts.get(statement.value.name)!);
    } else if (statement.kind === 'dynamic_object_property_set') {
      const existing = layouts.get(statement.objectName);
      if (existing && existing.entries.length === 0) {
        layouts.set(statement.objectName, {
          ...existing,
          entries: [{
            keyName: statement.propertyKeyName,
            valueName: statement.valueName,
            valueType: statement.valueType,
          }],
        });
      }
    }
  }
  return layouts;
}

function dynamicObjectEntryIndex(
  layout: DynamicObjectLocalLayout | undefined,
  propertyKeyName: string,
  aliases: ReadonlyMap<string, string>,
): number {
  if (!layout) {
    return 0;
  }
  const propertyKeyRoot = resolveLocalAlias(propertyKeyName, aliases);
  const index = layout.entries.findIndex((entry) =>
    resolveLocalAlias(entry.keyName, aliases) === propertyKeyRoot
  );
  return index >= 0 ? index : 0;
}

function renderIndexExpression(
  expression: SemanticExpressionIR,
  indent: string,
  context: FunctionRenderContext,
): readonly string[] {
  if (expression.kind === 'number_literal' && Number.isInteger(expression.value)) {
    return [`${indent}i32.const ${expression.value}`];
  }
  const rendered = renderExpression(expression, indent, context);
  return expression.representation === 'i32' ? rendered : [...rendered, `${indent}i32.trunc_f64_s`];
}

function renderExpression(
  expression: SemanticExpressionIR,
  indent = '    ',
  context: FunctionRenderContext = EMPTY_RENDER_CONTEXT,
): readonly string[] {
  switch (expression.kind) {
    case 'number_literal':
      return [`${indent}f64.const ${expression.value}`];
    case 'boolean_literal':
      return [`${indent}i32.const ${expression.value ? 1 : 0}`];
    case 'null_literal':
      return [
        `${indent}i32.const ${TAGGED_NULL_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'local_get':
      return [`${indent}local.get $${sanitizeIdentifier(expression.name)}`];
    case 'string_to_owned':
    case 'owned_string_to_host':
      return renderExpression(expression.value, indent, context);
    case 'tag_number':
      return [
        `${indent}i32.const ${TAGGED_NUMBER_TAG}`,
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_boolean':
      return [
        `${indent}i32.const ${TAGGED_BOOLEAN_TAG}`,
        ...renderExpression(expression.value, indent, context),
        `${indent}f64.convert_i32_s`,
        `${indent}ref.null extern`,
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_string':
      return [
        `${indent}i32.const ${TAGGED_STRING_TAG}`,
        `${indent}f64.const 0`,
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_symbol':
      return [
        `${indent}i32.const ${TAGGED_SYMBOL_TAG}`,
        `${indent}f64.const 0`,
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.null eq`,
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'tag_heap_object':
      return [
        `${indent}i32.const ${TAGGED_HEAP_OBJECT_TAG}`,
        `${indent}f64.const 0`,
        `${indent}ref.null extern`,
        ...renderExpression(expression.value, indent, context),
        `${indent}struct.new ${taggedValueTypeName()}`,
      ];
    case 'untag_number':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
      ];
    case 'untag_boolean':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $number_payload`,
        `${indent}i32.trunc_f64_s`,
      ];
    case 'untag_owned_string':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $extern_payload`,
      ];
    case 'untag_symbol':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $extern_payload`,
      ];
    case 'untag_heap_object':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $heap_payload`,
        `${indent}ref.cast ${wasmTypeForCompilerValueType(expression.representation)}`,
      ];
    case 'tagged_is_null':
    case 'tagged_has_tag': {
      const tag = expression.kind === 'tagged_is_null' ? TAGGED_NULL_TAG : expression.tag;
      const comparison = [
        ...renderExpression(expression.value, indent, context),
        `${indent}ref.cast (ref ${taggedValueTypeName()})`,
        `${indent}struct.get ${taggedValueTypeName()} $tag`,
        `${indent}i32.const ${tag}`,
        `${indent}i32.eq`,
      ];
      return expression.negated ? [...comparison, `${indent}i32.eqz`] : comparison;
    }
    case 'owned_number_array_literal':
      return [
        ...expression.elements.flatMap((element) => renderExpression(element, indent, context)),
        `${indent}array.new_fixed $array_runtime ${expression.elements.length}`,
      ];
    case 'owned_number_array_element':
      return [
        ...renderExpression(expression.value, indent, context),
        ...renderIndexExpression(expression.index, indent, context),
        `${indent}array.get $array_runtime`,
      ];
    case 'owned_array_length':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}array.len`,
        `${indent}f64.convert_i32_s`,
      ];
    case 'closure_literal':
      return expression.captures.length === 0
        ? [`${indent}ref.func ${closureFunctionName(expression.functionId)}`]
        : [
          ...expression.captures.flatMap((capture) => renderExpression(capture, indent, context)),
          `${indent}struct.new ${closureEnvTypeName(expression.functionId)}`,
        ];
    case 'closure_call':
      if (
        expression.callee.kind === 'closure_literal' &&
        expression.callee.captures.length > 0
      ) {
        return [
          ...expression.callee.captures.flatMap((capture) =>
            renderExpression(capture, indent, context)
          ),
          ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
          `${indent}call ${closureFunctionName(expression.callee.functionId)}`,
        ];
      }
      if (
        expression.callee.kind === 'local_get' &&
        context.closureLocalLiterals.has(expression.callee.name) &&
        context.closureLocalLiterals.get(expression.callee.name)!.captures.length > 0
      ) {
        const calleeName = expression.callee.name;
        const literal = context.closureLocalLiterals.get(expression.callee.name)!;
        return [
          ...literal.captures.flatMap((_, index) => [
            `${indent}local.get $${sanitizeIdentifier(calleeName)}`,
            `${indent}ref.cast (ref ${closureEnvTypeName(literal.functionId)})`,
            `${indent}struct.get ${closureEnvTypeName(literal.functionId)} $capture_${index}`,
          ]),
          ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
          `${indent}call ${closureFunctionName(literal.functionId)}`,
        ];
      }
      return [
        ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
        ...renderExpression(expression.callee, indent, context),
        `${indent}call_ref ${closureSignatureTypeName(expression.signatureId)}`,
      ];
    case 'call':
      return [
        ...expression.args.flatMap((arg) => renderExpression(arg, indent, context)),
        `${indent}call $${sanitizeIdentifier(expression.callee)}`,
      ];
    case 'box_new':
      return [
        ...renderExpression(expression.value, indent, context),
        `${indent}struct.new ${boxTypeName(expression.valueType)}`,
      ];
    case 'box_get':
      return [
        ...renderExpression(expression.box, indent, context),
        `${indent}ref.cast (ref ${boxTypeName(expression.valueType)})`,
        `${indent}struct.get ${boxTypeName(expression.valueType)} $value`,
      ];
    case 'binary':
      return [
        ...renderExpression(expression.left, indent, context),
        ...renderExpression(expression.right, indent, context),
        `${indent}${expression.op}`,
      ];
    case 'unsupported_expression':
      return [`${indent};; unsupported expression ${expression.sourceKind}`];
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function renderStatement(
  statement: SemanticStatementIR,
  indent = '    ',
  context: FunctionRenderContext = EMPTY_RENDER_CONTEXT,
): readonly string[] {
  switch (statement.kind) {
    case 'return':
      return [...renderExpression(statement.value, indent, context), `${indent}return`];
    case 'local_set':
      return [
        ...renderExpression(statement.value, indent, context),
        `${indent}local.set $${sanitizeIdentifier(statement.name)}`,
      ];
    case 'expression':
      return [...renderExpression(statement.value, indent, context), `${indent}drop`];
    case 'specialized_object_new':
      return [
        ...statement.fieldValueNames.map((fieldValueName) =>
          `${indent}local.get $${sanitizeIdentifier(fieldValueName)}`
        ),
        `${indent}struct.new ${objectLayoutTypeName(statement.representationName)}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    case 'specialized_object_field_get':
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${objectLayoutTypeName(statement.representationName)})`,
        `${indent}struct.get ${objectLayoutTypeName(statement.representationName)} $${
          sanitizeIdentifier(statement.fieldName)
        }`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    case 'specialized_object_field_set':
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${objectLayoutTypeName(statement.representationName)})`,
        ...renderExpression(statement.value, indent, context),
        `${indent}struct.set ${objectLayoutTypeName(statement.representationName)} $${
          sanitizeIdentifier(statement.fieldName)
        }`,
      ];
    case 'fallback_object_new': {
      const layout = context.fallbackObjectLocalLayouts.get(statement.targetName);
      const typeName = layout?.typeName ??
        fallbackObjectLayoutTypeName(
          statement.representationName,
          statement.entries.map((entry) => entry.key),
        );
      return [
        ...statement.entries.map((entry) =>
          `${indent}local.get $${sanitizeIdentifier(entry.valueName)}`
        ),
        `${indent}struct.new ${typeName}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    }
    case 'fallback_object_property_get': {
      const layout = context.fallbackObjectLocalLayouts.get(statement.objectName);
      const typeName = layout?.typeName ??
        fallbackObjectLayoutTypeName(statement.representationName, [statement.propertyKey]);
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${typeName})`,
        `${indent}struct.get ${typeName} $${sanitizeIdentifier(statement.propertyKey)}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    }
    case 'dynamic_object_new': {
      const layout = context.dynamicObjectLocalLayouts.get(statement.targetName);
      const typeName = layout?.typeName ??
        dynamicObjectLayoutTypeName(
          statement.representationName,
          Math.max(statement.entries.length, 1),
        );
      const entries = layout?.entries.length ? layout.entries : statement.entries;
      return [
        ...entries.flatMap((entry) => [
          `${indent}local.get $${sanitizeIdentifier(entry.keyName)}`,
          `${indent}local.get $${sanitizeIdentifier(entry.valueName)}`,
        ]),
        ...(entries.length === 0 ? [`${indent}ref.null extern`, `${indent}f64.const 0`] : []),
        `${indent}struct.new ${typeName}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    }
    case 'dynamic_object_property_get': {
      const layout = context.dynamicObjectLocalLayouts.get(statement.objectName);
      const typeName = layout?.typeName ??
        dynamicObjectLayoutTypeName(statement.representationName, 1);
      const index = dynamicObjectEntryIndex(
        layout,
        statement.propertyKeyName,
        context.localAliases,
      );
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${typeName})`,
        `${indent}struct.get ${typeName} $value_${index}`,
        `${indent}local.set $${sanitizeIdentifier(statement.targetName)}`,
      ];
    }
    case 'dynamic_object_property_set': {
      const layout = context.dynamicObjectLocalLayouts.get(statement.objectName);
      const typeName = layout?.typeName ??
        dynamicObjectLayoutTypeName(statement.representationName, 1);
      const index = dynamicObjectEntryIndex(
        layout,
        statement.propertyKeyName,
        context.localAliases,
      );
      return [
        `${indent}local.get $${sanitizeIdentifier(statement.objectName)}`,
        `${indent}ref.cast (ref ${typeName})`,
        `${indent}local.get $${sanitizeIdentifier(statement.valueName)}`,
        `${indent}struct.set ${typeName} $value_${index}`,
      ];
    }
    case 'box_set':
      return [
        ...renderExpression(statement.box, indent, context),
        `${indent}ref.cast (ref ${boxTypeName(statement.valueType)})`,
        ...renderExpression(statement.value, indent, context),
        `${indent}struct.set ${boxTypeName(statement.valueType)} $value`,
      ];
    case 'owned_number_array_set':
      return [
        ...renderExpression(statement.array, indent, context),
        ...renderIndexExpression(statement.index, indent, context),
        ...renderExpression(statement.value, indent, context),
        `${indent}array.set $array_runtime`,
      ];
    case 'if':
      return [
        ...renderExpression(statement.condition, indent, context),
        `${indent}if`,
        ...statement.thenBody.flatMap((nested) => renderStatement(nested, `${indent}  `, context)),
        ...(statement.elseBody.length > 0
          ? [
            `${indent}else`,
            ...statement.elseBody.flatMap((nested) =>
              renderStatement(nested, `${indent}  `, context)
            ),
          ]
          : []),
        `${indent}end`,
      ];
    case 'while':
      return [
        `${indent}block`,
        `${indent}  loop`,
        ...renderExpression(statement.condition, `${indent}    `, context),
        `${indent}    i32.eqz`,
        `${indent}    br_if 1`,
        ...statement.body.flatMap((nested) => renderStatement(nested, `${indent}    `, context)),
        `${indent}    br 0`,
        `${indent}  end`,
        `${indent}end`,
      ];
    case 'trap':
      return [`${indent}unreachable`];
    case 'unsupported_statement':
      return [`${indent};; unsupported statement ${statement.sourceKind}`];
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function renderFunctionPlan(func: WasmGcFunctionPlanIR): readonly string[] {
  if (func.hostImport) {
    return [];
  }
  if (func.bodyStatus !== 'emittable') {
    return [
      `  ;; function ${func.name} export=${func.exportName} params=${
        joinOrNone(func.params.map((param) => param.wasmType))
      } result=${func.result} body_status=stub unsupported=${
        joinOrNone(func.unsupportedBodyKinds)
      }`,
    ];
  }

  const exportClause = func.exportName.length > 0 && func.closureFunctionId === undefined
    ? ` (export ${JSON.stringify(func.exportName)})`
    : '';
  const context: FunctionRenderContext = {
    boxLocalValueTypes: boxLocalValueTypes(func),
    closureLocalLiterals: closureLocalLiterals(func),
    fallbackObjectLocalLayouts: fallbackObjectLocalLayouts(func),
    dynamicObjectLocalLayouts: dynamicObjectLocalLayouts(func),
    localAliases: localAliases(func),
  };
  const params = func.params.map((param, index) =>
    ` (param $${sanitizeIdentifier(param.name)} ${
      func.closureCaptureCount !== undefined &&
        index < func.closureCaptureCount
        ? `(ref null ${boxTypeName(func.closureCaptureValueTypes?.[index] ?? param.wasmType)})`
        : wasmTypeForCompilerValueType(param.wasmType)
    })`
  ).join('');
  const result = func.result.length > 0
    ? ` (result ${wasmTypeForCompilerValueType(func.result)})`
    : '';
  const typeUse = func.closureSignatureId !== undefined &&
      (func.closureCaptureCount ?? 0) === 0
    ? ` (type ${closureSignatureTypeName(func.closureSignatureId)})`
    : '';
  return [
    `  (func $${sanitizeIdentifier(func.name)}${typeUse}${exportClause}${params}${result}`,
    ...func.locals.map((local) =>
      `    (local $${sanitizeIdentifier(local.name)} ${
        local.wasmType === 'closure_ref' && context.closureLocalLiterals.has(local.name)
          ? context.closureLocalLiterals.get(local.name)!.captures.length === 0
            ? `(ref null ${
              closureSignatureTypeName(context.closureLocalLiterals.get(local.name)!.signatureId)
            })`
            : `(ref null ${
              closureEnvTypeName(context.closureLocalLiterals.get(local.name)!.functionId)
            })`
          : context.fallbackObjectLocalLayouts.has(local.name)
          ? `(ref null ${context.fallbackObjectLocalLayouts.get(local.name)!.typeName})`
          : context.dynamicObjectLocalLayouts.has(local.name)
          ? `(ref null ${context.dynamicObjectLocalLayouts.get(local.name)!.typeName})`
          : local.wasmType === 'box_ref' && context.boxLocalValueTypes.has(local.name)
          ? `(ref null ${boxTypeName(context.boxLocalValueTypes.get(local.name)!)})`
          : wasmTypeForCompilerValueType(local.wasmType)
      })`
    ),
    ...func.body.flatMap((statement) => renderStatement(statement, '    ', context)),
    '  )',
  ];
}

function renderHostImportPlan(func: WasmGcFunctionPlanIR): readonly string[] {
  if (!func.hostImport) {
    return [];
  }
  const params = func.params.map((param) =>
    ` (param $${sanitizeIdentifier(param.name)} ${wasmTypeForHostFunctionParam(param)})`
  ).join('');
  const result = func.result.length > 0
    ? ` (result ${wasmTypeForCompilerValueType(func.result)})`
    : '';
  return [
    `  (import ${JSON.stringify(func.hostImport.module)} ${
      JSON.stringify(func.hostImport.name)
    } (func $${sanitizeIdentifier(func.name)}${params}${result}))`,
  ];
}

function renderClosureSignatureTypes(plan: WasmGcModulePlanIR): readonly string[] {
  return plan.functionPlans
    .filter((func) =>
      func.closureSignatureId !== undefined && func.closureFunctionId !== undefined &&
      (func.closureCaptureCount ?? 0) === 0
    )
    .sort((left, right) => left.closureSignatureId! - right.closureSignatureId!)
    .map((func) =>
      `  (type ${closureSignatureTypeName(func.closureSignatureId!)} (func${
        func.params.map((param) => ` (param ${wasmTypeForCompilerValueType(param.wasmType)})`)
          .join('')
      }${func.result.length > 0 ? ` (result ${wasmTypeForCompilerValueType(func.result)})` : ''}))`
    );
}

function renderDeclaredClosureElements(plan: WasmGcModulePlanIR): readonly string[] {
  const closureFunctions = plan.functionPlans
    .filter((func) => func.closureFunctionId !== undefined && (func.closureCaptureCount ?? 0) === 0)
    .sort((left, right) => left.closureFunctionId! - right.closureFunctionId!);
  if (closureFunctions.length === 0) {
    return [];
  }
  return [
    '  ;; elements',
    ...closureFunctions.map((func) =>
      `  (elem declare func ${closureFunctionName(func.closureFunctionId!)})`
    ),
  ];
}

function collectBoxValueTypesFromExpression(
  expression: SemanticExpressionIR,
  valueTypes: Set<string>,
): void {
  switch (expression.kind) {
    case 'box_new':
      valueTypes.add(expression.valueType);
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      break;
    case 'box_get':
      valueTypes.add(expression.valueType);
      collectBoxValueTypesFromExpression(expression.box, valueTypes);
      break;
    case 'closure_literal':
      expression.captureValueTypes.forEach((valueType) => valueTypes.add(valueType));
      expression.captures.forEach((capture) =>
        collectBoxValueTypesFromExpression(capture, valueTypes)
      );
      break;
    case 'closure_call':
      collectBoxValueTypesFromExpression(expression.callee, valueTypes);
      expression.args.forEach((arg) => collectBoxValueTypesFromExpression(arg, valueTypes));
      break;
    case 'tag_number':
    case 'tag_boolean':
    case 'tag_string':
    case 'tag_symbol':
    case 'tag_heap_object':
    case 'untag_number':
    case 'untag_boolean':
    case 'untag_owned_string':
    case 'untag_symbol':
    case 'untag_heap_object':
    case 'tagged_is_null':
    case 'tagged_has_tag':
    case 'string_to_owned':
    case 'owned_string_to_host':
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      break;
    case 'call':
      expression.args.forEach((arg) => collectBoxValueTypesFromExpression(arg, valueTypes));
      break;
    case 'owned_number_array_literal':
      expression.elements.forEach((element) =>
        collectBoxValueTypesFromExpression(element, valueTypes)
      );
      break;
    case 'owned_number_array_element':
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      collectBoxValueTypesFromExpression(expression.index, valueTypes);
      break;
    case 'owned_array_length':
      collectBoxValueTypesFromExpression(expression.value, valueTypes);
      break;
    case 'binary':
      collectBoxValueTypesFromExpression(expression.left, valueTypes);
      collectBoxValueTypesFromExpression(expression.right, valueTypes);
      break;
    case 'number_literal':
    case 'boolean_literal':
    case 'null_literal':
    case 'local_get':
    case 'unsupported_expression':
      break;
    default: {
      const exhaustiveCheck: never = expression;
      return exhaustiveCheck;
    }
  }
}

function collectBoxValueTypesFromStatement(
  statement: SemanticStatementIR,
  valueTypes: Set<string>,
): void {
  switch (statement.kind) {
    case 'return':
    case 'local_set':
    case 'expression':
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'box_set':
      valueTypes.add(statement.valueType);
      collectBoxValueTypesFromExpression(statement.box, valueTypes);
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'owned_number_array_set':
      collectBoxValueTypesFromExpression(statement.array, valueTypes);
      collectBoxValueTypesFromExpression(statement.index, valueTypes);
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'specialized_object_field_set':
      collectBoxValueTypesFromExpression(statement.value, valueTypes);
      break;
    case 'if':
      collectBoxValueTypesFromExpression(statement.condition, valueTypes);
      statement.thenBody.forEach((nested) => collectBoxValueTypesFromStatement(nested, valueTypes));
      statement.elseBody.forEach((nested) => collectBoxValueTypesFromStatement(nested, valueTypes));
      break;
    case 'while':
      collectBoxValueTypesFromExpression(statement.condition, valueTypes);
      statement.body.forEach((nested) => collectBoxValueTypesFromStatement(nested, valueTypes));
      break;
    case 'specialized_object_new':
    case 'specialized_object_field_get':
    case 'fallback_object_new':
    case 'fallback_object_property_get':
    case 'dynamic_object_new':
    case 'dynamic_object_property_get':
    case 'dynamic_object_property_set':
    case 'trap':
    case 'unsupported_statement':
      break;
    default: {
      const exhaustiveCheck: never = statement;
      return exhaustiveCheck;
    }
  }
}

function renderBoxTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const valueTypes = new Set<string>();
  for (const func of plan.functionPlans) {
    func.closureCaptureValueTypes?.forEach((valueType) => valueTypes.add(valueType));
    func.body.forEach((statement) => collectBoxValueTypesFromStatement(statement, valueTypes));
  }
  return [...valueTypes].sort().map((valueType) =>
    `  (type ${boxTypeName(valueType)} (struct (field $value (mut ${
      wasmTypeForCompilerValueType(valueType)
    }))))`
  );
}

function renderCapturedClosureEnvTypes(plan: WasmGcModulePlanIR): readonly string[] {
  return plan.functionPlans
    .filter((func) => func.closureFunctionId !== undefined && (func.closureCaptureCount ?? 0) > 0)
    .sort((left, right) => left.closureFunctionId! - right.closureFunctionId!)
    .flatMap((func) => [
      `  (type ${closureEnvTypeName(func.closureFunctionId!)} (struct`,
      ...Array.from(
        { length: func.closureCaptureCount ?? 0 },
        (_, index) =>
          `    (field $capture_${index} (mut (ref null ${
            boxTypeName(func.closureCaptureValueTypes?.[index] ?? 'heap_ref')
          })))`,
      ),
      '  ))',
    ]);
}

function renderFallbackObjectTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const layouts = new Map<string, FallbackObjectLocalLayout>();
  for (const func of plan.functionPlans) {
    for (const layout of fallbackObjectLocalLayouts(func).values()) {
      layouts.set(layout.typeName, layout);
    }
  }
  return [...layouts.values()]
    .sort((left, right) => left.typeName.localeCompare(right.typeName))
    .flatMap((layout) => [
      `  (type ${layout.typeName} (struct`,
      ...layout.entries.map((entry) =>
        `    (field $${sanitizeIdentifier(entry.key)} (mut ${
          wasmTypeForCompilerValueType(entry.valueType)
        }))`
      ),
      '  ))',
    ]);
}

function renderDynamicObjectTypes(plan: WasmGcModulePlanIR): readonly string[] {
  const layouts = new Map<string, DynamicObjectLocalLayout>();
  for (const func of plan.functionPlans) {
    for (const layout of dynamicObjectLocalLayouts(func).values()) {
      layouts.set(layout.typeName, layout);
    }
  }
  return [...layouts.values()]
    .sort((left, right) => left.typeName.localeCompare(right.typeName))
    .flatMap((layout) => [
      `  (type ${layout.typeName} (struct`,
      ...Array.from({ length: Math.max(layout.entries.length, 1) }, (_, index) => [
        `    (field $key_${index} (mut externref))`,
        `    (field $value_${index} (mut ${
          wasmTypeForCompilerValueType(layout.entries[index]?.valueType ?? 'f64')
        }))`,
      ]).flat(),
      '  ))',
    ]);
}

function renderTaggedValueType(plan: WasmGcModulePlanIR): readonly string[] {
  const usesFiniteUnion = plan.helperPlans.some((helper) => helper.family === 'finite_union') ||
    plan.functionPlans.some((func) =>
      func.result === 'tagged_ref' ||
      func.params.some((param) => param.wasmType === 'tagged_ref') ||
      func.locals.some((local) => local.wasmType === 'tagged_ref')
    );
  return usesFiniteUnion
    ? [
      `  (type ${taggedValueTypeName()} (struct`,
      '    (field $tag (mut i32))',
      '    (field $number_payload (mut f64))',
      '    (field $extern_payload (mut externref))',
      '    (field $heap_payload (mut (ref null eq)))',
      '  ))',
    ]
    : [];
}

export function emitWasmGcModulePlan(plan: WasmGcModulePlanIR): string {
  const boxTypes = renderBoxTypes(plan);
  const closureSignatureTypes = renderClosureSignatureTypes(plan);
  const capturedClosureEnvTypes = renderCapturedClosureEnvTypes(plan);
  const fallbackObjectTypes = renderFallbackObjectTypes(plan);
  const dynamicObjectTypes = renderDynamicObjectTypes(plan);
  const taggedValueTypes = renderTaggedValueType(plan);
  const hostImportPlans = plan.functionPlans.flatMap(renderHostImportPlan);
  const lines = [
    '(module',
    '  ;; soundscript wasm-gc shadow module',
    `  ;; capabilities target=${plan.capabilities.target} managed_refs=${
      String(plan.capabilities.managedReferences)
    } custom_collector=${String(plan.capabilities.customCollector)}`,
    '  ;; types',
    ...(
      plan.typePlans.length > 0 || boxTypes.length > 0 || closureSignatureTypes.length > 0 ||
        capturedClosureEnvTypes.length > 0 || fallbackObjectTypes.length > 0 ||
        dynamicObjectTypes.length > 0 || taggedValueTypes.length > 0
        ? [
          ...indentLines(plan.typePlans.flatMap(renderTypePlan)),
          ...taggedValueTypes,
          ...fallbackObjectTypes,
          ...dynamicObjectTypes,
          ...boxTypes,
          ...closureSignatureTypes,
          ...capturedClosureEnvTypes,
        ]
        : ['    ;; none']
    ),
    ...(hostImportPlans.length > 0 ? ['  ;; imports', ...hostImportPlans] : []),
    '  ;; helpers',
    ...(plan.helperPlans.length > 0 ? indentLines(plan.helperPlans.map(renderHelperPlan)) : [
      '    ;; none',
    ]),
    '  ;; functions',
    ...plan.functionPlans.flatMap(renderFunctionPlan),
    ...renderDeclaredClosureElements(plan),
    '  ;; boundaries',
    ...(plan.boundaryPlans.length > 0 ? plan.boundaryPlans.flatMap(renderBoundaryPlan) : [
      '  ;; none',
    ]),
    '  ;; diagnostics',
    ...(plan.diagnostics.length > 0
      ? plan.diagnostics.map((diagnostic) =>
        `    ;; diagnostic ${diagnostic.code} ${diagnostic.family}: ${diagnostic.message}`
      )
      : ['    ;; none']),
    ')',
    '',
  ];
  return lines.join('\n');
}
