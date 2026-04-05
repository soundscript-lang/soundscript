import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';

const enum FieldInitializationState {
  Uninitialized = 0,
  MaybeInitialized = 1,
  DefinitelyInitialized = 2,
}

const enum TrackedValueMask {
  None = 0,
  ThisAlias = 1 << 0,
  CapturedThisClosure = 1 << 1,
}

type ClassLikeDeclaration = ts.ClassDeclaration | ts.ClassExpression;

interface ClassLifecycleInfo {
  fieldNames: ReadonlySet<string>;
  hasBaseClass: boolean;
}

interface LifecycleState {
  readonly fieldStates: Map<string, FieldInitializationState>;
  readonly trackedValues: Map<number, TrackedValueMask>;
}

type ReceiverKind = 'super' | 'this';

type ConstructionHazardKind =
  | 'captured closure call'
  | 'receiver accessor dispatch'
  | 'receiver method dispatch'
  | 'tracked this alias escape'
  | 'tracked this argument escape'
  | 'tracked this return'
  | 'tracked this throw';

interface LifecycleDiagnosticInfo {
  hazardKind: ConstructionHazardKind;
  memberName?: string;
  node: ts.Node;
  receiverKind?: ReceiverKind;
}

interface FieldInitializationDiagnosticInfo {
  accessKind: 'object destructuring' | 'this property access';
  fieldName?: string;
  node: ts.Node;
}

function createLifecycleExample(info: LifecycleDiagnosticInfo): string {
  if (
    info.hazardKind === 'receiver method dispatch' ||
    info.hazardKind === 'receiver accessor dispatch'
  ) {
    return `Write fields directly during construction, then call \`${info.memberName ?? 'the member'}\` from a post-construction method or factory step instead of from the constructor.`;
  }

  return 'Finish initialization first, then pass `this` or code that captures it to other routines only after construction completes.';
}

function createLifecycleNote(info: LifecycleDiagnosticInfo): string {
  if (
    info.hazardKind === 'receiver method dispatch' ||
    info.hazardKind === 'receiver accessor dispatch'
  ) {
    const receiver = info.receiverKind ?? 'this';
    return `This constructor dispatches through \`${receiver}.${info.memberName ?? 'member'}\` before construction completes.`;
  }

  if (info.hazardKind === 'captured closure call') {
    return 'This constructor calls a closure that captures `this` before construction completes.';
  }

  if (info.hazardKind === 'tracked this argument escape') {
    return 'This constructor passes `this` or a value that captures it into another call before construction completes.';
  }

  if (info.hazardKind === 'tracked this return') {
    return 'This constructor returns `this` or a value that captures it before construction completes.';
  }

  if (info.hazardKind === 'tracked this throw') {
    return 'This constructor throws `this` or a value that captures it before construction completes.';
  }

  return 'This constructor stores or forwards `this` before construction completes.';
}

function createLifecycleDiagnostic(info: LifecycleDiagnosticInfo): SoundDiagnostic {
  const example = createLifecycleExample(info);

  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.constructionLifecycleViolation,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.constructionLifecycleViolation,
    metadata: {
      rule: 'construction_lifecycle_violation',
      primarySymbol: info.memberName,
      fixability: 'local_rewrite',
      invariant:
        'Constructors and field initializers must finish establishing instance state before they dispatch through members or let `this` escape.',
      replacementFamily: 'finish_initialization_before_dispatch',
      evidence: [
        { label: 'hazardKind', value: info.hazardKind },
        ...(info.receiverKind ? [{ label: 'receiver', value: info.receiverKind }] : []),
        ...(info.memberName ? [{ label: 'memberName', value: info.memberName }] : []),
      ],
      counterexample:
        'Dispatching through instance members before construction completes can observe partially initialized state or overridden subclass behavior.',
      example,
    },
    notes: [
      createLifecycleNote(info),
      `Example: ${example}`,
    ],
    hint: 'Finish initialization before calling instance members or letting `this` escape.',
    ...getNodeDiagnosticRange(info.node),
  };
}

function createFieldInitializationDiagnostic(info: FieldInitializationDiagnosticInfo): SoundDiagnostic {
  const fieldName = info.fieldName ?? 'this field';
  const example =
    `Assign \`${fieldName}\` on every path before reading it, or move the read after the initializing assignment.`;

  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.fieldReadBeforeInitialization,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.fieldReadBeforeInitialization,
    metadata: {
      rule: 'field_read_before_initialization',
      primarySymbol: info.fieldName,
      fixability: 'local_rewrite',
      invariant:
        'Instance fields must be definitely initialized on every path before reads during construction or field initialization.',
      replacementFamily: 'initialize_before_read',
      evidence: [
        ...(info.fieldName ? [{ label: 'fieldName', value: info.fieldName }] : []),
        { label: 'accessKind', value: info.accessKind },
      ],
      counterexample:
        'A read before definite initialization can observe an uninitialized field or depend on constructor ordering that soundscript cannot prove safe.',
      example,
    },
    notes: [
      `The read of \`${fieldName}\` can happen before that field is definitely initialized on every path.`,
      `Example: ${example}`,
    ],
    hint: 'Initialize the field before reading it, or defer the read until after construction establishes the value.',
    ...getNodeDiagnosticRange(info.node),
  };
}

function cloneState(state: LifecycleState): LifecycleState {
  return {
    fieldStates: new Map(state.fieldStates),
    trackedValues: new Map(state.trackedValues),
  };
}

function mergeFieldState(
  left: FieldInitializationState,
  right: FieldInitializationState,
): FieldInitializationState {
  if (left === right) {
    return left;
  }

  if (
    left === FieldInitializationState.DefinitelyInitialized &&
    right === FieldInitializationState.DefinitelyInitialized
  ) {
    return FieldInitializationState.DefinitelyInitialized;
  }

  if (
    left === FieldInitializationState.Uninitialized &&
    right === FieldInitializationState.Uninitialized
  ) {
    return FieldInitializationState.Uninitialized;
  }

  return FieldInitializationState.MaybeInitialized;
}

function mergeStates(states: readonly LifecycleState[]): LifecycleState | null {
  if (states.length === 0) {
    return null;
  }

  const mergedFieldStates = new Map(states[0]!.fieldStates);
  const mergedTrackedValues = new Map(states[0]!.trackedValues);

  for (const state of states.slice(1)) {
    for (const [fieldName, fieldState] of state.fieldStates) {
      mergedFieldStates.set(
        fieldName,
        mergeFieldState(mergedFieldStates.get(fieldName) ?? FieldInitializationState.Uninitialized, fieldState),
      );
    }

    for (const [symbolId, mask] of state.trackedValues) {
      mergedTrackedValues.set(symbolId, (mergedTrackedValues.get(symbolId) ?? TrackedValueMask.None) | mask);
    }
  }

  return {
    fieldStates: mergedFieldStates,
    trackedValues: mergedTrackedValues,
  };
}

function getSimpleNameText(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) {
    return undefined;
  }

  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  return undefined;
}

function hasStaticModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
}

function isParameterProperty(parameter: ts.ParameterDeclaration): boolean {
  if (!ts.isIdentifier(parameter.name)) {
    return false;
  }

  const modifierFlags = ts.getCombinedModifierFlags(parameter);
  return (modifierFlags & (
    ts.ModifierFlags.Public |
    ts.ModifierFlags.Private |
    ts.ModifierFlags.Protected |
    ts.ModifierFlags.Readonly
  )) !== 0;
}

function collectClassLifecycleInfo(classLike: ClassLikeDeclaration): ClassLifecycleInfo {
  const fieldNames = new Set<string>();
  let constructorDeclaration: ts.ConstructorDeclaration | undefined;

  for (const member of classLike.members) {
    if (ts.isConstructorDeclaration(member)) {
      constructorDeclaration = member;
      continue;
    }

    if (hasStaticModifier(member)) {
      continue;
    }

    if (
      (ts.isPropertyDeclaration(member) || ts.isAccessor(member)) &&
      getSimpleNameText(member.name)
    ) {
      fieldNames.add(getSimpleNameText(member.name)!);
    }
  }

  for (const parameter of constructorDeclaration?.parameters ?? []) {
    const parameterName = getSimpleNameText(parameter.name);
    if (isParameterProperty(parameter) && parameterName) {
      fieldNames.add(parameterName);
    }
  }

  return {
    fieldNames,
    hasBaseClass: (classLike.heritageClauses ?? []).some((clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length > 0
    ),
  };
}

function createInitialState(classInfo: ClassLifecycleInfo): LifecycleState {
  return {
    fieldStates: new Map(
      [...classInfo.fieldNames].map((fieldName) =>
        [fieldName, FieldInitializationState.Uninitialized] as const
      ),
    ),
    trackedValues: new Map<number, TrackedValueMask>(),
  };
}

function getTrackedMaskForSymbol(
  context: AnalysisContext,
  state: LifecycleState,
  symbol: ts.Symbol | undefined,
): TrackedValueMask {
  return symbol ? state.trackedValues.get(context.getSymbolId(symbol)) ?? TrackedValueMask.None : TrackedValueMask.None;
}

function setTrackedMaskForSymbol(
  context: AnalysisContext,
  state: LifecycleState,
  symbol: ts.Symbol | undefined,
  mask: TrackedValueMask,
): void {
  if (!symbol) {
    return;
  }

  const symbolId = context.getSymbolId(symbol);
  if (mask === TrackedValueMask.None) {
    state.trackedValues.delete(symbolId);
    return;
  }

  state.trackedValues.set(symbolId, mask);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function functionCapturesTrackedThis(
  context: AnalysisContext,
  state: LifecycleState,
  node: ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  let captures = false;

  function visit(current: ts.Node, allowThisKeyword: boolean): void {
    if (captures) {
      return;
    }

    if (current !== node && ts.isClassLike(current)) {
      return;
    }

    if (current !== node && ts.isFunctionLike(current)) {
      if (ts.isArrowFunction(current)) {
        visit(current.body, allowThisKeyword);
      } else if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)
      ) {
        if (current.body) {
          visit(current.body, false);
        }
      }
      return;
    }

    if (allowThisKeyword && current.kind === ts.SyntaxKind.ThisKeyword) {
      captures = true;
      return;
    }

    if (ts.isIdentifier(current)) {
      const symbol = context.checker.getSymbolAtLocation(current);
      if ((getTrackedMaskForSymbol(context, state, symbol) & TrackedValueMask.ThisAlias) !== 0) {
        captures = true;
        return;
      }
    }

    ts.forEachChild(current, (child) => visit(child, allowThisKeyword));
  }

  visit(node.body, ts.isArrowFunction(node));
  return captures;
}

function classifyExpressionValueMask(
  context: AnalysisContext,
  state: LifecycleState,
  expression: ts.Expression,
): TrackedValueMask {
  const current = unwrapExpression(expression);

  if (current.kind === ts.SyntaxKind.ThisKeyword) {
    return TrackedValueMask.ThisAlias;
  }

  if (ts.isIdentifier(current)) {
    return getTrackedMaskForSymbol(context, state, context.checker.getSymbolAtLocation(current));
  }

  if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
    return functionCapturesTrackedThis(context, state, current)
      ? TrackedValueMask.CapturedThisClosure
      : TrackedValueMask.None;
  }

  return TrackedValueMask.None;
}

function expressionContainsTrackedValue(
  context: AnalysisContext,
  state: LifecycleState,
  expression: ts.Expression,
): TrackedValueMask {
  const directMask = classifyExpressionValueMask(context, state, expression);
  if (directMask !== TrackedValueMask.None) {
    return directMask;
  }

  if (
    ts.isFunctionExpression(expression) ||
    ts.isArrowFunction(expression) ||
    ts.isClassExpression(expression)
  ) {
    return TrackedValueMask.None;
  }

  let result = TrackedValueMask.None;
  ts.forEachChild(expression, (child) => {
    if (result !== TrackedValueMask.None || !ts.isExpression(child)) {
      return;
    }
    result |= expressionContainsTrackedValue(context, state, child);
  });
  return result;
}

function getReceiverKind(
  context: AnalysisContext,
  state: LifecycleState,
  expression: ts.Expression,
): ReceiverKind | undefined {
  const current = unwrapExpression(expression);
  if (current.kind === ts.SyntaxKind.ThisKeyword) {
    return 'this';
  }
  if (current.kind === ts.SyntaxKind.SuperKeyword) {
    return 'super';
  }

  if (ts.isIdentifier(current)) {
    const symbol = context.checker.getSymbolAtLocation(current);
    return (getTrackedMaskForSymbol(context, state, symbol) & TrackedValueMask.ThisAlias) !== 0
      ? 'this'
      : undefined;
  }

  return undefined;
}

function getMemberSymbol(
  context: AnalysisContext,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ts.Symbol | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return context.checker.getSymbolAtLocation(node.name);
  }

  const memberName = node.argumentExpression && (
      ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)
    )
    ? node.argumentExpression.text
    : undefined;
  if (!memberName) {
    return undefined;
  }

  return context.checker.getTypeAtLocation(node.expression).getProperty(memberName);
}

function getMemberName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  return ts.isPropertyAccessExpression(node)
    ? getSimpleNameText(node.name)
    : node.argumentExpression &&
        (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))
    ? node.argumentExpression.text
    : undefined;
}

function isInstanceMethodSymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) {
    return false;
  }

  return (symbol.declarations ?? []).some((declaration) =>
    !declaration.getSourceFile().isDeclarationFile &&
    (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) &&
    !hasStaticModifier(declaration)
  );
}

function isInstanceAccessorSymbol(symbol: ts.Symbol | undefined): boolean {
  if (!symbol) {
    return false;
  }

  return (symbol.declarations ?? []).some((declaration) =>
    !declaration.getSourceFile().isDeclarationFile &&
    (ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) &&
    !hasStaticModifier(declaration)
  );
}

function getTrackedFieldName(
  classInfo: ClassLifecycleInfo,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  const memberName = ts.isPropertyAccessExpression(node)
    ? getSimpleNameText(node.name)
    : node.argumentExpression &&
        (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))
    ? node.argumentExpression.text
    : undefined;
  if (!memberName || !classInfo.fieldNames.has(memberName)) {
    return undefined;
  }

  return memberName;
}

function isSimpleAssignmentOperator(token: ts.SyntaxKind): boolean {
  return token === ts.SyntaxKind.EqualsToken;
}

function isAssignmentOperator(token: ts.SyntaxKind): boolean {
  return token >= ts.SyntaxKind.FirstAssignment && token <= ts.SyntaxKind.LastAssignment;
}

function getFieldAccessMode(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): 'read' | 'readwrite' | 'write' {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node && isAssignmentOperator(parent.operatorToken.kind)) {
    return isSimpleAssignmentOperator(parent.operatorToken.kind) ? 'write' : 'readwrite';
  }

  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return 'readwrite';
  }

  return 'read';
}

function isDirectMethodCall(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  const parent = node.parent;
  return (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node;
}

function getDirectSuperCallStatement(
  statement: ts.Statement,
): ts.CallExpression | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) {
    return undefined;
  }

  const callee = unwrapExpression(statement.expression.expression);
  return callee.kind === ts.SyntaxKind.SuperKeyword ? statement.expression : undefined;
}

function pushDiagnostic(
  diagnostics: SoundDiagnostic[],
  seen: Set<string>,
  diagnostic: SoundDiagnostic,
): void {
  const key =
    `${diagnostic.code}:${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column}:` +
    `${diagnostic.endLine}:${diagnostic.endColumn}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  diagnostics.push(diagnostic);
}

function analyzeExpression(
  context: AnalysisContext,
  classInfo: ClassLifecycleInfo,
  state: LifecycleState,
  expression: ts.Expression,
  diagnostics: SoundDiagnostic[],
  seen: Set<string>,
): void {
  const current = unwrapExpression(expression);

  if (ts.isFunctionExpression(current) || ts.isArrowFunction(current) || ts.isClassExpression(current)) {
    return;
  }

  if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
    const callee = current.expression;
    const calleeMask = classifyExpressionValueMask(context, state, callee);
    if ((calleeMask & TrackedValueMask.CapturedThisClosure) !== 0) {
      pushDiagnostic(
        diagnostics,
        seen,
        createLifecycleDiagnostic({ node: callee, hazardKind: 'captured closure call' }),
      );
    }

    if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      (getReceiverKind(context, state, callee.expression) === 'this' ||
        getReceiverKind(context, state, callee.expression) === 'super')
    ) {
      const receiverKind = getReceiverKind(context, state, callee.expression);
      const memberSymbol = getMemberSymbol(context, callee);
      if (isInstanceMethodSymbol(memberSymbol) || isInstanceAccessorSymbol(memberSymbol)) {
        pushDiagnostic(
          diagnostics,
          seen,
          createLifecycleDiagnostic({
            node: callee,
            hazardKind: isInstanceAccessorSymbol(memberSymbol)
              ? 'receiver accessor dispatch'
              : 'receiver method dispatch',
            memberName: getMemberName(callee),
            receiverKind,
          }),
        );
      }
    } else if (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      (classifyExpressionValueMask(context, state, callee.expression) &
          TrackedValueMask.CapturedThisClosure) !== 0
    ) {
      pushDiagnostic(
        diagnostics,
        seen,
        createLifecycleDiagnostic({
          node: callee.expression,
          hazardKind: 'tracked this alias escape',
        }),
      );
    } else {
      analyzeExpression(context, classInfo, state, callee, diagnostics, seen);
    }

    for (const argument of current.arguments ?? []) {
      analyzeExpression(context, classInfo, state, argument, diagnostics, seen);
      if (expressionContainsTrackedValue(context, state, argument) !== TrackedValueMask.None) {
        pushDiagnostic(
          diagnostics,
          seen,
          createLifecycleDiagnostic({ node: argument, hazardKind: 'tracked this argument escape' }),
        );
      }
    }

    return;
  }

  if (ts.isBinaryExpression(current) && isAssignmentOperator(current.operatorToken.kind)) {
    analyzeExpression(context, classInfo, state, current.right, diagnostics, seen);

    const rightValueMask = classifyExpressionValueMask(context, state, current.right);
    const rightContainsTrackedValue = expressionContainsTrackedValue(context, state, current.right);

    if (ts.isIdentifier(current.left)) {
      const leftSymbol = context.checker.getSymbolAtLocation(current.left);
      if (rightValueMask !== TrackedValueMask.None) {
        setTrackedMaskForSymbol(context, state, leftSymbol, rightValueMask);
      } else {
        setTrackedMaskForSymbol(context, state, leftSymbol, TrackedValueMask.None);
        if (rightContainsTrackedValue !== TrackedValueMask.None) {
          pushDiagnostic(
            diagnostics,
            seen,
            createLifecycleDiagnostic({ node: current.right, hazardKind: 'tracked this alias escape' }),
          );
        }
      }
      return;
    }

    if (ts.isPropertyAccessExpression(current.left) || ts.isElementAccessExpression(current.left)) {
      analyzePropertyAccess(context, classInfo, state, current.left, diagnostics, seen);
      if (rightContainsTrackedValue !== TrackedValueMask.None) {
        pushDiagnostic(
          diagnostics,
          seen,
          createLifecycleDiagnostic({ node: current.right, hazardKind: 'tracked this alias escape' }),
        );
      }
      return;
    }

    analyzeExpression(context, classInfo, state, current.left, diagnostics, seen);
    if (rightContainsTrackedValue !== TrackedValueMask.None) {
      pushDiagnostic(
        diagnostics,
        seen,
        createLifecycleDiagnostic({ node: current.right, hazardKind: 'tracked this alias escape' }),
      );
    }
    return;
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    analyzePropertyAccess(context, classInfo, state, current, diagnostics, seen);
    return;
  }

  if (ts.isConditionalExpression(current)) {
    analyzeExpression(context, classInfo, state, current.condition, diagnostics, seen);
    analyzeExpression(context, classInfo, state, current.whenTrue, diagnostics, seen);
    analyzeExpression(context, classInfo, state, current.whenFalse, diagnostics, seen);
    return;
  }

  if (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) {
    analyzeExpression(context, classInfo, state, current.operand, diagnostics, seen);
    return;
  }

  if (ts.isArrayLiteralExpression(current) || ts.isObjectLiteralExpression(current)) {
    for (const child of current.getChildren(current.getSourceFile())) {
      if (ts.isExpression(child)) {
        analyzeExpression(context, classInfo, state, child, diagnostics, seen);
      }
    }
    return;
  }

  ts.forEachChild(current, (child) => {
    if (ts.isExpression(child)) {
      analyzeExpression(context, classInfo, state, child, diagnostics, seen);
    }
  });
}

function analyzePropertyAccess(
  context: AnalysisContext,
  classInfo: ClassLifecycleInfo,
  state: LifecycleState,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  diagnostics: SoundDiagnostic[],
  seen: Set<string>,
): void {
  analyzeExpression(context, classInfo, state, node.expression, diagnostics, seen);
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    analyzeExpression(context, classInfo, state, node.argumentExpression, diagnostics, seen);
  }

  const receiverKind = getReceiverKind(context, state, node.expression);
  if (!receiverKind) {
    return;
  }

  const memberSymbol = getMemberSymbol(context, node);
  if (isInstanceAccessorSymbol(memberSymbol)) {
    pushDiagnostic(
      diagnostics,
      seen,
      createLifecycleDiagnostic({
        node,
        hazardKind: 'receiver accessor dispatch',
        memberName: getMemberName(node),
        receiverKind,
      }),
    );
    return;
  }

  if (isDirectMethodCall(node) && isInstanceMethodSymbol(memberSymbol)) {
    pushDiagnostic(
      diagnostics,
      seen,
      createLifecycleDiagnostic({
        node,
        hazardKind: 'receiver method dispatch',
        memberName: getMemberName(node),
        receiverKind,
      }),
    );
    return;
  }

  if (receiverKind !== 'this') {
    return;
  }

  const fieldName = getTrackedFieldName(classInfo, node);
  if (!fieldName) {
    return;
  }

  const accessMode = getFieldAccessMode(node);
  if (accessMode !== 'write' &&
    (state.fieldStates.get(fieldName) ?? FieldInitializationState.Uninitialized) !==
      FieldInitializationState.DefinitelyInitialized) {
    pushDiagnostic(
      diagnostics,
      seen,
      createFieldInitializationDiagnostic({
        node,
        fieldName,
        accessKind: 'this property access',
      }),
    );
  }

  if (accessMode !== 'read') {
    state.fieldStates.set(fieldName, FieldInitializationState.DefinitelyInitialized);
  }
}

function analyzeObjectBindingPatternFromThis(
  context: AnalysisContext,
  classInfo: ClassLifecycleInfo,
  state: LifecycleState,
  declaration: ts.VariableDeclaration,
  diagnostics: SoundDiagnostic[],
  seen: Set<string>,
): void {
  if (!declaration.initializer || !ts.isObjectBindingPattern(declaration.name)) {
    return;
  }

  const receiverKind = getReceiverKind(context, state, declaration.initializer);
  if (receiverKind !== 'this' && receiverKind !== 'super') {
    return;
  }

  for (const element of declaration.name.elements) {
    const memberName = getSimpleNameText(element.propertyName ?? element.name);
    if (!memberName) {
      continue;
    }

    const receiverType = context.checker.getTypeAtLocation(declaration.initializer);
    const memberSymbol = receiverType.getProperty(memberName);
    if (isInstanceAccessorSymbol(memberSymbol)) {
      pushDiagnostic(
        diagnostics,
        seen,
        createLifecycleDiagnostic({
          node: element,
          hazardKind: 'receiver accessor dispatch',
          memberName,
          receiverKind,
        }),
      );
      continue;
    }

    if (receiverKind === 'this' && classInfo.fieldNames.has(memberName)) {
      const fieldState = state.fieldStates.get(memberName) ?? FieldInitializationState.Uninitialized;
      if (fieldState !== FieldInitializationState.DefinitelyInitialized) {
        pushDiagnostic(
          diagnostics,
          seen,
          createFieldInitializationDiagnostic({
            node: element,
            fieldName: memberName,
            accessKind: 'object destructuring',
          }),
        );
      }
    }
  }
}

function analyzeVariableDeclaration(
  context: AnalysisContext,
  classInfo: ClassLifecycleInfo,
  state: LifecycleState,
  declaration: ts.VariableDeclaration,
  diagnostics: SoundDiagnostic[],
  seen: Set<string>,
): void {
  if (!declaration.initializer) {
    return;
  }

  analyzeExpression(context, classInfo, state, declaration.initializer, diagnostics, seen);
  analyzeObjectBindingPatternFromThis(context, classInfo, state, declaration, diagnostics, seen);

  const directMask = classifyExpressionValueMask(context, state, declaration.initializer);
  const containedMask = expressionContainsTrackedValue(context, state, declaration.initializer);

  if (ts.isIdentifier(declaration.name)) {
    const symbol = context.checker.getSymbolAtLocation(declaration.name);
    if (directMask !== TrackedValueMask.None) {
      setTrackedMaskForSymbol(context, state, symbol, directMask);
      return;
    }

    setTrackedMaskForSymbol(context, state, symbol, TrackedValueMask.None);
    if (containedMask !== TrackedValueMask.None) {
      pushDiagnostic(
        diagnostics,
        seen,
        createLifecycleDiagnostic({
          node: declaration.initializer,
          hazardKind: 'tracked this alias escape',
        }),
      );
    }
    return;
  }

  if (containedMask !== TrackedValueMask.None) {
    pushDiagnostic(
      diagnostics,
      seen,
      createLifecycleDiagnostic({
        node: declaration.initializer,
        hazardKind: 'tracked this alias escape',
      }),
    );
  }
}

function analyzeStatement(
  context: AnalysisContext,
  classInfo: ClassLifecycleInfo,
  state: LifecycleState,
  statement: ts.Statement,
  diagnostics: SoundDiagnostic[],
  seen: Set<string>,
): LifecycleState | null {
  if (ts.isBlock(statement)) {
    return analyzeStatements(context, classInfo, cloneState(state), statement.statements, diagnostics, seen);
  }

  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      analyzeVariableDeclaration(context, classInfo, state, declaration, diagnostics, seen);
    }
    return state;
  }

  if (ts.isExpressionStatement(statement)) {
    analyzeExpression(context, classInfo, state, statement.expression, diagnostics, seen);
    return state;
  }

  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
    if (statement.expression) {
      analyzeExpression(context, classInfo, state, statement.expression, diagnostics, seen);
      if (expressionContainsTrackedValue(context, state, statement.expression) !== TrackedValueMask.None) {
        pushDiagnostic(
          diagnostics,
          seen,
          createLifecycleDiagnostic({
            node: statement.expression,
            hazardKind: ts.isReturnStatement(statement) ? 'tracked this return' : 'tracked this throw',
          }),
        );
      }
    }
    return null;
  }

  if (ts.isIfStatement(statement)) {
    analyzeExpression(context, classInfo, state, statement.expression, diagnostics, seen);
    const thenState = analyzeStatement(
      context,
      classInfo,
      cloneState(state),
      statement.thenStatement,
      diagnostics,
      seen,
    );
    const elseState = statement.elseStatement
      ? analyzeStatement(context, classInfo, cloneState(state), statement.elseStatement, diagnostics, seen)
      : cloneState(state);
    return mergeStates([thenState, elseState].filter((value): value is LifecycleState => value !== null));
  }

  if (ts.isWhileStatement(statement)) {
    analyzeExpression(context, classInfo, state, statement.expression, diagnostics, seen);
    const bodyState = analyzeStatement(
      context,
      classInfo,
      cloneState(state),
      statement.statement,
      diagnostics,
      seen,
    );
    return mergeStates([state, bodyState].filter((value): value is LifecycleState => value !== null));
  }

  if (ts.isDoStatement(statement)) {
    const bodyState = analyzeStatement(
      context,
      classInfo,
      cloneState(state),
      statement.statement,
      diagnostics,
      seen,
    );
    if (bodyState) {
      analyzeExpression(context, classInfo, bodyState, statement.expression, diagnostics, seen);
    }
    return mergeStates([state, bodyState].filter((value): value is LifecycleState => value !== null));
  }

  if (ts.isForStatement(statement)) {
    if (statement.initializer) {
      if (ts.isVariableDeclarationList(statement.initializer)) {
        for (const declaration of statement.initializer.declarations) {
          analyzeVariableDeclaration(context, classInfo, state, declaration, diagnostics, seen);
        }
      } else {
        analyzeExpression(context, classInfo, state, statement.initializer, diagnostics, seen);
      }
    }
    if (statement.condition) {
      analyzeExpression(context, classInfo, state, statement.condition, diagnostics, seen);
    }
    const bodyState = analyzeStatement(
      context,
      classInfo,
      cloneState(state),
      statement.statement,
      diagnostics,
      seen,
    );
    if (bodyState && statement.incrementor) {
      analyzeExpression(context, classInfo, bodyState, statement.incrementor, diagnostics, seen);
    }
    return mergeStates([state, bodyState].filter((value): value is LifecycleState => value !== null));
  }

  if (ts.isForOfStatement(statement) || ts.isForInStatement(statement)) {
    analyzeExpression(context, classInfo, state, statement.expression, diagnostics, seen);
    const bodyState = analyzeStatement(
      context,
      classInfo,
      cloneState(state),
      statement.statement,
      diagnostics,
      seen,
    );
    return mergeStates([state, bodyState].filter((value): value is LifecycleState => value !== null));
  }

  if (ts.isSwitchStatement(statement)) {
    analyzeExpression(context, classInfo, state, statement.expression, diagnostics, seen);
    const clauseStates: LifecycleState[] = [];
    for (const clause of statement.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        analyzeExpression(context, classInfo, state, clause.expression, diagnostics, seen);
      }
      const clauseState = analyzeStatements(
        context,
        classInfo,
        cloneState(state),
        clause.statements,
        diagnostics,
        seen,
      );
      if (clauseState) {
        clauseStates.push(clauseState);
      }
    }
    clauseStates.push(state);
    return mergeStates(clauseStates);
  }

  if (ts.isTryStatement(statement)) {
    const tryState = analyzeStatement(
      context,
      classInfo,
      cloneState(state),
      statement.tryBlock,
      diagnostics,
      seen,
    );
    const catchState = statement.catchClause
      ? analyzeStatement(
        context,
        classInfo,
        cloneState(state),
        statement.catchClause.block,
        diagnostics,
        seen,
      )
      : null;
    const mergedBeforeFinally = mergeStates(
      [tryState, catchState].filter((value): value is LifecycleState => value !== null),
    ) ?? cloneState(state);
    return statement.finallyBlock
      ? analyzeStatement(
        context,
        classInfo,
        mergedBeforeFinally,
        statement.finallyBlock,
        diagnostics,
        seen,
      )
      : mergedBeforeFinally;
  }

  ts.forEachChild(statement, (child) => {
    if (ts.isExpression(child)) {
      analyzeExpression(context, classInfo, state, child, diagnostics, seen);
    }
  });
  return state;
}

function analyzeStatements(
  context: AnalysisContext,
  classInfo: ClassLifecycleInfo,
  initialState: LifecycleState,
  statements: readonly ts.Statement[],
  diagnostics: SoundDiagnostic[],
  seen: Set<string>,
): LifecycleState | null {
  let currentState: LifecycleState | null = initialState;

  for (const statement of statements) {
    if (context.isGeneratedNode(statement)) {
      continue;
    }

    if (!currentState) {
      return null;
    }
    currentState = analyzeStatement(context, classInfo, currentState, statement, diagnostics, seen);
  }

  return currentState;
}

function applyParameterPropertyInitialization(
  constructorDeclaration: ts.ConstructorDeclaration | undefined,
  state: LifecycleState,
): void {
  for (const parameter of constructorDeclaration?.parameters ?? []) {
    const parameterName = getSimpleNameText(parameter.name);
    if (isParameterProperty(parameter) && parameterName) {
      state.fieldStates.set(parameterName, FieldInitializationState.DefinitelyInitialized);
    }
  }
}

function analyzeFieldInitializers(
  context: AnalysisContext,
  classInfo: ClassLifecycleInfo,
  classLike: ClassLikeDeclaration,
  state: LifecycleState,
  diagnostics: SoundDiagnostic[],
  seen: Set<string>,
): void {
  for (const member of classLike.members) {
    if (!ts.isPropertyDeclaration(member) || hasStaticModifier(member) || !member.initializer) {
      continue;
    }

    analyzeExpression(context, classInfo, state, member.initializer, diagnostics, seen);
    const fieldName = getSimpleNameText(member.name);
    if (fieldName) {
      state.fieldStates.set(fieldName, FieldInitializationState.DefinitelyInitialized);
    }
  }
}

function analyzeClassLike(
  context: AnalysisContext,
  classLike: ClassLikeDeclaration,
  diagnostics: SoundDiagnostic[],
  seen: Set<string>,
): void {
  const classInfo = collectClassLifecycleInfo(classLike);
  const constructorDeclaration = classLike.members.find(ts.isConstructorDeclaration);

  if (!classInfo.hasBaseClass) {
    const state = createInitialState(classInfo);
    analyzeFieldInitializers(context, classInfo, classLike, state, diagnostics, seen);
    applyParameterPropertyInitialization(constructorDeclaration, state);
    if (constructorDeclaration?.body) {
      analyzeStatements(
        context,
        classInfo,
        state,
        constructorDeclaration.body.statements,
        diagnostics,
        seen,
      );
    }
    return;
  }

  const state = createInitialState(classInfo);
  if (!constructorDeclaration?.body) {
    analyzeFieldInitializers(context, classInfo, classLike, state, diagnostics, seen);
    return;
  }

  const statements = constructorDeclaration.body.statements;
  const superStatementIndex = statements.findIndex((statement) => getDirectSuperCallStatement(statement) !== undefined);
  if (superStatementIndex === -1) {
    return;
  }

  if (superStatementIndex > 0) {
    analyzeStatements(
      context,
      classInfo,
      state,
      statements.slice(0, superStatementIndex + 1),
      diagnostics,
      seen,
    );
  } else {
    analyzeExpression(
      context,
      classInfo,
      state,
      getDirectSuperCallStatement(statements[superStatementIndex]!)!,
      diagnostics,
      seen,
    );
  }

  analyzeFieldInitializers(context, classInfo, classLike, state, diagnostics, seen);
  applyParameterPropertyInitialization(constructorDeclaration, state);
  analyzeStatements(
    context,
    classInfo,
    state,
    statements.slice(superStatementIndex + 1),
    diagnostics,
    seen,
  );
}

export function runClassLifecycleRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];
  const seen = new Set<string>();

  context.forEachSourceFile((sourceFile) => {
    context.traverse(sourceFile, (node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        analyzeClassLike(context, node, diagnostics, seen);
      }
    });
  });

  return diagnostics;
}
