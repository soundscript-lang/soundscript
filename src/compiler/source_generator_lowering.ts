import type { CompilerValueType } from './ir.ts';
import type {
  SourceExpressionIR,
  SourceFunctionIR,
  SourceStatementIR,
} from './source_hir.ts';
import type {
  SemanticExpressionIR,
  SemanticFunctionIR,
  SemanticStatementIR,
} from './semantic_ir.ts';

const GENERATOR_MODE_NEXT = 0;
const GENERATOR_MODE_RETURN = 1;
const GENERATOR_MODE_THROW = 2;
const GENERATOR_COMPLETED_PC = -1;

const GENERATOR_PC_KEY = '__ss_generator_pc';
const GENERATOR_STEP_KEY = '__ss_generator_step';
const GENERATOR_COMPLETION_KEY = '__ss_generator_completion';

export { GENERATOR_MODE_NEXT, GENERATOR_MODE_RETURN, GENERATOR_MODE_THROW };

export interface GeneratorLoweringState {
  nextClosureFunctionId: number;
  generatedFunctions: SemanticFunctionIR[];
  nextClosureSignatureId: number;
}

interface SourceGeneratorSegment {
  pc: number;
  statements: readonly SourceStatementIR[];
  terminal: SourceGeneratorTerminal;
}

type SourceGeneratorTerminal =
  | { kind: 'yield'; expression?: SourceExpressionIR; resumeBindingName?: string; nextPc: number }
  | { kind: 'return'; expression?: SourceExpressionIR }
  | { kind: 'throw'; expression?: SourceExpressionIR }
  | { kind: 'implicit' };

interface SourceGeneratorFramePlan {
  segments: readonly SourceGeneratorSegment[];
}

interface FunctionLoweringContext {
  functionName: string;
  localRepresentations: Map<string, CompilerValueType>;
  locals: { name: string; representation: CompilerValueType }[];
  moduleState: GeneratorLoweringState;
  runtimeFamilies: Set<string>;
  unsupportedKinds: Set<string>;
  pendingStatements: SemanticStatementIR[];
  stringLiteralIds: Map<string, number>;
  stringLiterals: string[];
  tempIndex: number;
  boxedLocals: Map<string, CompilerValueType>;
  localDeclarationKinds: Map<string, string>;
  objectLocals: Map<string, unknown>;
  arrayLocals: Map<string, unknown>;
  closureLocals: Map<string, unknown>;
  mapLocals: Map<string, unknown>;
  setLocals: Map<string, unknown>;
  unionLocals: Map<string, unknown>;
  objectLayoutsByKey: Map<string, unknown>;
  classesByName: ReadonlyMap<string, unknown>;
  switchBreakLocalStack: string[];
  throwTargets: unknown[];
  completionTargets: unknown[];
  currentResultType?: { kind: string };
  functionResultArrayLocals: Map<string, unknown>;
  functionParamTypes: Map<string, unknown>;
  functionResultRepresentations: Map<string, CompilerValueType>;
  functionResultTypes: Map<string, unknown>;
  constructorLocals: Map<string, unknown>;
  sourceFunctionName: string;
  asyncFunction: boolean;
}

export function buildSourceGeneratorFramePlan(
  statements: readonly SourceStatementIR[],
): SourceGeneratorFramePlan | undefined {
  const segments: SourceGeneratorSegment[] = [];
  let currentStatements: SourceStatementIR[] = [];
  let currentPc = 0;

  for (const statement of statements) {
    switch (statement.kind) {
      case 'expression_statement': {
        if (isYieldExpressionStatement(statement)) {
          const yieldExpr = (statement.expression as { kind: 'yield_expression'; expression?: SourceExpressionIR });
          segments.push({
            pc: currentPc,
            statements: currentStatements,
            terminal: {
              kind: 'yield',
              expression: yieldExpr.expression,
              nextPc: currentPc + 1,
            },
          });
          currentPc += 1;
          currentStatements = [];
          break;
        }
        currentStatements.push(statement);
        break;
      }
      case 'variable_declaration': {
        const assignResult = trySplitYieldAssignment(statement, currentPc, currentStatements);
        if (assignResult) {
          segments.push(...assignResult);
          currentPc += assignResult.length;
          currentStatements = [];
          break;
        }
        currentStatements.push(statement);
        break;
      }
      case 'return':
        segments.push({
          pc: currentPc,
          statements: currentStatements,
          terminal: { kind: 'return', expression: statement.expression },
        });
        currentPc += 1;
        currentStatements = [];
        break;
      case 'throw':
        segments.push({
          pc: currentPc,
          statements: currentStatements,
          terminal: { kind: 'throw', expression: statement.expression },
        });
        currentPc += 1;
        currentStatements = [];
        break;
      default:
        currentStatements.push(statement);
        break;
    }
  }

  segments.push({
    pc: currentPc,
    statements: currentStatements,
    terminal: { kind: 'implicit' },
  });

  return { segments };
}

function isYieldExpressionStatement(statement: SourceStatementIR): boolean {
  return statement.kind === 'expression_statement' &&
    typeof statement.expression === 'object' &&
    statement.expression !== null &&
    'kind' in statement.expression &&
    (statement.expression as { kind: string }).kind === 'yield_expression';
}

function trySplitYieldAssignment(
  statement: SourceStatementIR,
  currentPc: number,
  currentStatements: readonly SourceStatementIR[],
): readonly SourceGeneratorSegment[] | undefined {
  if (statement.kind !== 'variable_declaration') return undefined;
  const varDecl = statement as {
    kind: 'variable_declaration';
    declarations: readonly {
      binding: { kind: string; name: string };
      initializer?: SourceExpressionIR;
    }[];
  };
  for (let idx = 0; idx < varDecl.declarations.length; idx++) {
    const decl = varDecl.declarations[idx];
    if (decl.initializer && typeof decl.initializer === 'object' && decl.initializer !== null &&
      'kind' in decl.initializer && (decl.initializer as { kind: string }).kind === 'yield_expression') {
      const yieldExpr = decl.initializer as { kind: 'yield_expression'; expression?: SourceExpressionIR };
      const bindingName = decl.binding.name;
      const leadingDecls = varDecl.declarations.slice(0, idx);
      const afterStatements: SourceStatementIR[] = [];
      if (leadingDecls.length > 0) {
        currentStatements = [
          ...currentStatements,
          { ...statement, declarations: leadingDecls } as unknown as SourceStatementIR,
        ];
      }
      const yieldSegment: SourceGeneratorSegment = {
        pc: currentPc,
        statements: currentStatements,
        terminal: {
          kind: 'yield',
          expression: yieldExpr.expression,
          resumeBindingName: bindingName,
          nextPc: currentPc + 1,
        },
      };
      const trailingDecls = varDecl.declarations.slice(idx + 1);
      if (trailingDecls.length > 0) {
        afterStatements.push({ ...statement, declarations: trailingDecls } as unknown as SourceStatementIR);
      }
      const resumeSegment: SourceGeneratorSegment = {
        pc: currentPc + 1,
        statements: afterStatements,
        terminal: { kind: 'implicit' },
      };
      return [yieldSegment, resumeSegment];
    }
  }
  return undefined;
}

export function lowerSourceGeneratorFramePlan(
  plan: SourceGeneratorFramePlan,
  context: FunctionLoweringContext,
  outerFunc: SourceFunctionIR,
  lowerStatement: (statement: SourceStatementIR, ctx: FunctionLoweringContext) => readonly SemanticStatementIR[],
  lowerExpression: (expression: SourceExpressionIR, ctx: FunctionLoweringContext) => SemanticExpressionIR,
): AsyncGenerator<SemanticStatementIR[], void, unknown> {
  context.runtimeFamilies.add('sync_generator');
  context.runtimeFamilies.add('dynamic_object');
  context.runtimeFamilies.add('closure');
  context.runtimeFamilies.add('string');

  const stepClosureFunctionId = context.moduleState.nextClosureFunctionId;
  context.moduleState.nextClosureFunctionId += 1;

  const signatureId = context.moduleState.nextClosureSignatureId;
  context.moduleState.nextClosureSignatureId += 1;

  const closureContext = createGeneratorClosureContext(context, stepClosureFunctionId);

  const stepClosureBody = lowerGeneratorStepClosureBody(
    plan,
    closureContext,
    lowerStatement,
    lowerExpression,
  );

  const unsupportedBodyKinds = [...closureContext.unsupportedKinds].sort();
  context.moduleState.generatedFunctions.push({
    name: `closure_generator_step_${stepClosureFunctionId}`,
    exportName: '',
    params: [
      { name: 'generator_mode', representation: 'f64' },
      { name: 'generator_resume_value', representation: 'tagged_ref' },
    ],
    locals: closureContext.locals,
    result: 'tagged_ref',
    body: stepClosureBody,
    bodyStatus: unsupportedBodyKinds.length === 0 ? 'emittable' : 'stub',
    unsupportedBodyKinds,
    runtimeFamilies: [...new Set([...closureContext.runtimeFamilies])].sort(),
    hostImported: false,
    hostExported: false,
    unionBoundaries: [],
    closureFunctionId: stepClosureFunctionId,
    closureSignatureId: signatureId,
    closureCaptureCount: 1,
    closureCaptureValueTypes: ['tagged_ref'],
  });

  const generatorObjectName = nextTempLocalName(context, 'generator');
  addLocal(context, generatorObjectName, 'heap_ref');
  const genDynamicRepName = nextTempLocalName(context, 'generator_dyn_repr');

  const pcKey = materializeGeneratorStringKey(GENERATOR_PC_KEY, context, 'generator_pc_key');
  const stepKey = materializeGeneratorStringKey(GENERATOR_STEP_KEY, context, 'generator_step_key');

  const stepClosureName = nextTempLocalName(context, 'generator_step_closure');
  addLocal(context, stepClosureName, 'closure_ref');

  const pcValueName = nextTempLocalName(context, 'generator_initial_pc');
  addLocal(context, pcValueName, 'f64');

  const outerStatements: SemanticStatementIR[] = [
    ...context.pendingStatements,
    ...pcKey.statements,
    ...stepKey.statements,
    {
      kind: 'dynamic_object_new',
      targetName: generatorObjectName,
      representationName: genDynamicRepName,
      entries: [
        { keyName: pcKey.keyName, valueName: pcValueName, valueType: 'f64' },
        { keyName: stepKey.keyName, valueName: stepClosureName, valueType: 'closure_ref' },
      ],
    },
    {
      kind: 'local_set',
      name: pcValueName,
      value: { kind: 'number_literal', value: 0, representation: 'f64' },
    },
    {
      kind: 'local_set',
      name: stepClosureName,
      value: {
        kind: 'closure_literal',
        functionId: stepClosureFunctionId,
        signatureId,
        captures: [{ kind: 'local_get', name: generatorObjectName, representation: 'heap_ref' }],
        captureValueTypes: ['heap_ref'],
        representation: 'closure_ref',
      },
    },
    {
      kind: 'dynamic_object_property_set',
      objectName: generatorObjectName,
      representationName: genDynamicRepName,
      propertyKeyName: pcKey.keyName,
      value: { kind: 'local_get', name: pcValueName, representation: 'f64' },
      valueType: 'f64',
    },
    {
      kind: 'dynamic_object_property_set',
      objectName: generatorObjectName,
      representationName: genDynamicRepName,
      propertyKeyName: stepKey.keyName,
      value: { kind: 'local_get', name: stepClosureName, representation: 'closure_ref' },
      valueType: 'closure_ref',
    },
  ];

  context.pendingStatements = [];
  outerStatements.push(
    {
      kind: 'return',
      value: { kind: 'local_get', name: generatorObjectName, representation: 'heap_ref' },
    },
  );

  return outerStatements;
}

function createGeneratorClosureContext(
  parentContext: FunctionLoweringContext,
  functionId: number,
): FunctionLoweringContext {
  const name = `generator_step_${functionId}`;
  return {
    functionName: name,
    sourceFunctionName: name,
    asyncFunction: false,
    localRepresentations: new Map(parentContext.localRepresentations),
    locals: [],
    moduleState: parentContext.moduleState,
    runtimeFamilies: new Set<string>(),
    unsupportedKinds: new Set<string>(),
    pendingStatements: [],
    stringLiteralIds: parentContext.stringLiteralIds,
    stringLiterals: parentContext.stringLiterals,
    tempIndex: 0,
    boxedLocals: parentContext.boxedLocals,
    localDeclarationKinds: parentContext.localDeclarationKinds,
    objectLocals: parentContext.objectLocals,
    arrayLocals: parentContext.arrayLocals,
    closureLocals: parentContext.closureLocals,
    mapLocals: parentContext.mapLocals,
    setLocals: parentContext.setLocals,
    unionLocals: parentContext.unionLocals,
    objectLayoutsByKey: parentContext.objectLayoutsByKey,
    classesByName: parentContext.classesByName,
    switchBreakLocalStack: [],
    throwTargets: [],
    completionTargets: [],
    currentResultType: undefined,
    functionResultArrayLocals: parentContext.functionResultArrayLocals,
    functionParamTypes: parentContext.functionParamTypes,
    functionResultRepresentations: parentContext.functionResultRepresentations,
    functionResultTypes: parentContext.functionResultTypes,
    constructorLocals: parentContext.constructorLocals,
  };
}

function lowerGeneratorStepClosureBody(
  plan: SourceGeneratorFramePlan,
  context: FunctionLoweringContext,
  lowerStatement: (statement: SourceStatementIR, ctx: FunctionLoweringContext) => readonly SemanticStatementIR[],
  lowerExpression: (expression: SourceExpressionIR, ctx: FunctionLoweringContext) => SemanticExpressionIR,
): SemanticStatementIR[] {
  const pcLocal = nextTempLocalName(context, 'generator_pc');
  addLocal(context, pcLocal, 'f64');
  const modeLocal = nextTempLocalName(context, 'generator_mode');
  addLocal(context, modeLocal, 'f64');
  const resumeValueLocal = nextTempLocalName(context, 'generator_resume');
  addLocal(context, resumeValueLocal, 'tagged_ref');

  const body: SemanticStatementIR[] = [
    {
      kind: 'local_set',
      name: modeLocal,
      value: { kind: 'local_get', name: 'generator_mode', representation: 'f64' },
    },
    {
      kind: 'local_set',
      name: resumeValueLocal,
      value: { kind: 'local_get', name: 'generator_resume_value', representation: 'tagged_ref' },
    },
  ];

  body.push({
    kind: 'if',
    condition: {
      kind: 'binary',
      op: 'f64.eq',
      left: { kind: 'local_get', name: modeLocal, representation: 'f64' },
      right: { kind: 'number_literal', value: GENERATOR_MODE_THROW, representation: 'f64' },
      representation: 'i32',
    },
    thenBody: [
      { kind: 'throw_tagged', value: { kind: 'local_get', name: resumeValueLocal, representation: 'tagged_ref' } },
    ],
    elseBody: [],
  });

  const iterResultName = nextTempLocalName(context, 'iter_result');
  addLocal(context, iterResultName, 'heap_ref');
  const iterValueName = nextTempLocalName(context, 'iter_value');
  addLocal(context, iterValueName, 'tagged_ref');
  const iterDoneName = nextTempLocalName(context, 'iter_done');
  addLocal(context, iterDoneName, 'f64');

  body.push({
    kind: 'if',
    condition: {
      kind: 'binary',
      op: 'f64.eq',
      left: { kind: 'local_get', name: modeLocal, representation: 'f64' },
      right: { kind: 'number_literal', value: GENERATOR_MODE_RETURN, representation: 'f64' },
      representation: 'i32',
    },
    thenBody: buildIteratorResultReturn(
      context,
      iterResultName, iterValueName, iterDoneName,
      { kind: 'undefined_literal', representation: 'tagged_ref' },
      true,
    ),
    elseBody: [],
  });

  let pcDispatchBody: SemanticStatementIR[] = [];
  let nextSegmentIdx = 0;

  for (const segment of plan.segments) {
    const segmentBody: SemanticStatementIR[] = [];

    for (const stmt of segment.statements) {
      segmentBody.push(...lowerStatement(stmt, context));
    }

    if (nextSegmentIdx < plan.segments.length - 1) {
      const nextSegment = plan.segments[nextSegmentIdx + 1];

      switch (segment.terminal.kind) {
        case 'yield': {
          const yieldValue = segment.terminal.expression
            ? lowerExpression(segment.terminal.expression, context)
            : { kind: 'undefined_literal', representation: 'tagged_ref' };
          segmentBody.push(
            ...buildIteratorResultReturn(
              context,
              iterResultName, iterValueName, iterDoneName,
              yieldValue,
              false,
            ),
          );
          break;
        }
        case 'return': {
          const returnValue = segment.terminal.expression
            ? lowerExpression(segment.terminal.expression, context)
            : { kind: 'undefined_literal', representation: 'tagged_ref' };
          segmentBody.push(
            ...buildIteratorResultReturn(
              context,
              iterResultName, iterValueName, iterDoneName,
              returnValue,
              true,
            ),
          );
          break;
        }
        case 'throw':
          segmentBody.push({
            kind: 'throw_tagged',
            value: segment.terminal.expression
              ? lowerExpression(segment.terminal.expression, context)
              : { kind: 'undefined_literal', representation: 'tagged_ref' },
          });
          break;
        case 'implicit':
          segmentBody.push(
            ...buildIteratorResultReturn(
              context,
              iterResultName, iterValueName, iterDoneName,
              { kind: 'undefined_literal', representation: 'tagged_ref' },
              true,
            ),
          );
          break;
      }
    } else {
      segmentBody.push(
        ...buildIteratorResultReturn(
          context,
          iterResultName, iterValueName, iterDoneName,
          { kind: 'undefined_literal', representation: 'tagged_ref' },
          true,
        ),
      );
    }

    if (pcDispatchBody.length === 0) {
      pcDispatchBody = [{
        kind: 'if',
        condition: {
          kind: 'binary',
          op: 'f64.eq',
          left: { kind: 'local_get', name: pcLocal, representation: 'f64' },
          right: { kind: 'number_literal', value: segment.pc, representation: 'f64' },
          representation: 'i32',
        },
        thenBody: segmentBody,
        elseBody: [],
      }];
    } else {
      pcDispatchBody[pcDispatchBody.length - 1] = {
        kind: 'if',
        condition: (pcDispatchBody[pcDispatchBody.length - 1] as { kind: 'if'; condition: unknown }).condition,
        thenBody: (pcDispatchBody[pcDispatchBody.length - 1] as { kind: 'if'; thenBody: unknown }).thenBody,
        elseBody: [{
          kind: 'if',
          condition: {
            kind: 'binary',
            op: 'f64.eq',
            left: { kind: 'local_get', name: pcLocal, representation: 'f64' },
            right: { kind: 'number_literal', value: segment.pc, representation: 'f64' },
            representation: 'i32',
          },
          thenBody: segmentBody,
          elseBody: [],
        }],
      };
    }
    nextSegmentIdx += 1;
  }

  if (pcDispatchBody.length > 0) {
    body.push(...pcDispatchBody);
  }

  return body;
}

function buildIteratorResultReturn(
  context: FunctionLoweringContext,
  resultName: string,
  valueLocal: string,
  doneLocal: string,
  value: SemanticExpressionIR,
  done: boolean,
): SemanticStatementIR[] {
  const repName = nextTempLocalName(context, 'iter_result_repr');
  const valueKey = materializeGeneratorStringKey('value', context, 'iter_value_key');
  const doneKey = materializeGeneratorStringKey('done', context, 'iter_done_key');
  const initValue = { kind: 'undefined_literal', representation: 'tagged_ref' } as SemanticExpressionIR;
  const initDone = { kind: 'boolean_literal', value: false, representation: 'i32' } as SemanticExpressionIR;
  return [
    ...valueKey.statements,
    ...doneKey.statements,
    { kind: 'local_set', name: valueLocal, value: initValue },
    { kind: 'local_set', name: doneLocal, value: initDone },
    {
      kind: 'dynamic_object_new',
      targetName: resultName,
      representationName: repName,
      entries: [
        { keyName: valueKey.keyName, valueName: valueLocal, valueType: 'tagged_ref' },
        { keyName: doneKey.keyName, valueName: doneLocal, valueType: 'f64' },
      ],
    },
    {
      kind: 'dynamic_object_property_set',
      objectName: resultName,
      representationName: repName,
      propertyKeyName: valueKey.keyName,
      value,
      valueType: 'tagged_ref',
    },
    {
      kind: 'dynamic_object_property_set',
      objectName: resultName,
      representationName: repName,
      propertyKeyName: doneKey.keyName,
      value: { kind: 'boolean_literal', value: done, representation: 'i32' },
      valueType: 'f64',
    },
    { kind: 'return', value: { kind: 'local_get', name: resultName, representation: 'heap_ref' } },
  ];
}

function nextTempLocalName(context: FunctionLoweringContext, prefix: string): string {
  const name = `${prefix}_${context.tempIndex}`;
  context.tempIndex += 1;
  return name;
}

function addLocal(
  context: FunctionLoweringContext,
  name: string,
  representation: CompilerValueType,
): void {
  context.localRepresentations.set(name, representation);
  context.locals.push({ name, representation });
}

function getStringLiteralId(context: FunctionLoweringContext, text: string): number {
  const existing = context.stringLiteralIds.get(text);
  if (existing !== undefined) return existing;
  const id = context.stringLiterals.length;
  context.stringLiteralIds.set(text, id);
  context.stringLiterals.push(text);
  return id;
}

function materializeGeneratorStringKey(
  text: string,
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
        literalId: getStringLiteralId(context, text),
        representation: 'owned_string_ref',
      },
    }],
  };
}

function makeReturnExpression(value: SemanticExpressionIR): SemanticStatementIR {
  return { kind: 'return', value };
}
