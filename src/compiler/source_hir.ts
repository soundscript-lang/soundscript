import ts from 'typescript';
import { normalize } from '../platform/path.ts';

export interface SourceSpanIR {
  fileName: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface SourceModuleIR {
  kind: 'source_module';
  fileName: string;
  functions: SourceFunctionIR[];
  classes: SourceClassIR[];
  statements: SourceStatementIR[];
}

export interface SourceFunctionIR {
  kind: 'source_function';
  name: string;
  exported: boolean;
  async: boolean;
  generator: boolean;
  params: SourceBindingIR[];
  body: SourceStatementIR[];
  span: SourceSpanIR;
}

export interface SourceClassIR {
  kind: 'source_class';
  name: string;
  exported: boolean;
  members: SourceClassMemberIR[];
  span: SourceSpanIR;
}

export interface SourceClassMemberIR {
  kind: 'constructor' | 'method' | 'property' | 'getter' | 'setter';
  name: string;
  static: boolean;
  span: SourceSpanIR;
}

export type SourceBindingIR =
  | { kind: 'identifier_binding'; name: string; span: SourceSpanIR }
  | { kind: 'object_binding'; elements: readonly SourceBindingIR[]; span: SourceSpanIR }
  | { kind: 'array_binding'; elements: readonly SourceBindingIR[]; span: SourceSpanIR }
  | { kind: 'unknown_binding'; text: string; span: SourceSpanIR };

export type SourceStatementIR =
  | SourceVariableDeclarationStatementIR
  | SourceExpressionStatementIR
  | SourceReturnStatementIR
  | SourceIfStatementIR
  | SourceWhileStatementIR
  | SourceDoWhileStatementIR
  | SourceForStatementIR
  | SourceForOfStatementIR
  | SourceSwitchStatementIR
  | SourceBreakStatementIR
  | SourceContinueStatementIR
  | SourceThrowStatementIR
  | SourceTryStatementIR
  | SourceBlockStatementIR
  | SourceUnknownStatementIR;

export interface SourceVariableDeclarationStatementIR {
  kind: 'variable_declaration';
  declarationKind: 'const' | 'let' | 'var';
  declarations: readonly {
    binding: SourceBindingIR;
    initializer?: SourceExpressionIR;
  }[];
  span: SourceSpanIR;
}

export interface SourceExpressionStatementIR {
  kind: 'expression_statement';
  expression: SourceExpressionIR;
  span: SourceSpanIR;
}

export interface SourceReturnStatementIR {
  kind: 'return';
  expression?: SourceExpressionIR;
  span: SourceSpanIR;
}

export interface SourceIfStatementIR {
  kind: 'if';
  test: SourceExpressionIR;
  consequent: SourceStatementIR[];
  alternate: SourceStatementIR[];
  span: SourceSpanIR;
}

export interface SourceWhileStatementIR {
  kind: 'while';
  test: SourceExpressionIR;
  body: SourceStatementIR[];
  span: SourceSpanIR;
}

export interface SourceDoWhileStatementIR {
  kind: 'do_while';
  body: SourceStatementIR[];
  test: SourceExpressionIR;
  span: SourceSpanIR;
}

export interface SourceForStatementIR {
  kind: 'for';
  initializer?: SourceVariableDeclarationStatementIR | SourceExpressionIR;
  test?: SourceExpressionIR;
  incrementor?: SourceExpressionIR;
  body: SourceStatementIR[];
  span: SourceSpanIR;
}

export interface SourceForOfStatementIR {
  kind: 'for_of';
  await: boolean;
  left: SourceBindingIR | SourceExpressionIR;
  right: SourceExpressionIR;
  body: SourceStatementIR[];
  span: SourceSpanIR;
}

export interface SourceSwitchStatementIR {
  kind: 'switch';
  expression: SourceExpressionIR;
  clauses: readonly SourceSwitchClauseIR[];
  span: SourceSpanIR;
}

export interface SourceSwitchClauseIR {
  kind: 'case' | 'default';
  expression?: SourceExpressionIR;
  statements: SourceStatementIR[];
  span: SourceSpanIR;
}

export interface SourceBreakStatementIR {
  kind: 'break';
  span: SourceSpanIR;
}

export interface SourceContinueStatementIR {
  kind: 'continue';
  span: SourceSpanIR;
}

export interface SourceThrowStatementIR {
  kind: 'throw';
  expression: SourceExpressionIR;
  span: SourceSpanIR;
}

export interface SourceTryStatementIR {
  kind: 'try';
  tryBlock: SourceStatementIR[];
  catchBinding?: SourceBindingIR;
  catchBlock?: SourceStatementIR[];
  finallyBlock?: SourceStatementIR[];
  span: SourceSpanIR;
}

export interface SourceBlockStatementIR {
  kind: 'block';
  statements: SourceStatementIR[];
  span: SourceSpanIR;
}

export interface SourceUnknownStatementIR {
  kind: 'unknown_statement';
  syntaxKind: string;
  text: string;
  span: SourceSpanIR;
}

export type SourceExpressionRole = 'read' | 'write';

export type SourceExpressionIR =
  | { kind: 'identifier'; name: string; role: SourceExpressionRole; span: SourceSpanIR }
  | {
    kind: 'property_access';
    object: SourceExpressionIR;
    property: string;
    role: SourceExpressionRole;
    span: SourceSpanIR;
  }
  | {
    kind: 'element_access';
    object: SourceExpressionIR;
    index?: SourceExpressionIR;
    role: SourceExpressionRole;
    span: SourceSpanIR;
  }
  | {
    kind: 'literal';
    literalKind: 'number' | 'string' | 'boolean' | 'null' | 'undefined';
    text: string;
    span: SourceSpanIR;
  }
  | {
    kind: 'binary_expression';
    operator: string;
    left: SourceExpressionIR;
    right: SourceExpressionIR;
    span: SourceSpanIR;
  }
  | {
    kind: 'logical_expression';
    operator: '&&' | '||' | '??';
    left: SourceExpressionIR;
    right: SourceExpressionIR;
    span: SourceSpanIR;
  }
  | {
    kind: 'unary_expression';
    operator: string;
    operand: SourceExpressionIR;
    span: SourceSpanIR;
  }
  | {
    kind: 'update_expression';
    operator: '++' | '--';
    operand: SourceExpressionIR;
    prefix: boolean;
    span: SourceSpanIR;
  }
  | {
    kind: 'conditional_expression';
    test: SourceExpressionIR;
    consequent: SourceExpressionIR;
    alternate: SourceExpressionIR;
    span: SourceSpanIR;
  }
  | {
    kind: 'assignment_expression';
    operator: string;
    left: SourceExpressionIR;
    right: SourceExpressionIR;
    span: SourceSpanIR;
  }
  | {
    kind: 'call_expression';
    callee: SourceExpressionIR;
    args: readonly SourceExpressionIR[];
    span: SourceSpanIR;
  }
  | {
    kind: 'new_expression';
    callee: SourceExpressionIR;
    args: readonly SourceExpressionIR[];
    span: SourceSpanIR;
  }
  | { kind: 'await_expression'; expression: SourceExpressionIR; span: SourceSpanIR }
  | { kind: 'array_literal'; elements: readonly SourceExpressionIR[]; span: SourceSpanIR }
  | {
    kind: 'object_literal';
    properties: readonly SourceObjectLiteralPropertyIR[];
    span: SourceSpanIR;
  }
  | { kind: 'unknown_expression'; syntaxKind: string; text: string; span: SourceSpanIR };

export interface SourceObjectLiteralPropertyIR {
  name: string;
  value: SourceExpressionIR;
  span: SourceSpanIR;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function spanOf(sourceFile: ts.SourceFile, node: ts.Node): SourceSpanIR {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  return {
    fileName: sourceFile.fileName,
    start,
    end,
    line: startPosition.line + 1,
    column: startPosition.character + 1,
    endLine: endPosition.line + 1,
    endColumn: endPosition.character + 1,
  };
}

function syntaxKindName(kind: ts.SyntaxKind): string {
  return ts.SyntaxKind[kind] ?? String(kind);
}

function declarationKindOf(flags: ts.NodeFlags): 'const' | 'let' | 'var' {
  if ((flags & ts.NodeFlags.Const) !== 0) {
    return 'const';
  }
  if ((flags & ts.NodeFlags.Let) !== 0) {
    return 'let';
  }
  return 'var';
}

function expressionRoleForChild(role: SourceExpressionRole): SourceExpressionRole {
  return role === 'write' ? 'read' : role;
}

function prefixUnaryOperatorForSource(operator: ts.PrefixUnaryOperator): string {
  return ts.tokenToString(operator) ?? syntaxKindName(operator);
}

function updateOperatorForSource(operator: ts.SyntaxKind): '++' | '--' {
  return operator === ts.SyntaxKind.PlusPlusToken ? '++' : '--';
}

function isAssignmentOperatorForSource(operator: string): boolean {
  return [
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '**=',
    '<<=',
    '>>=',
    '>>>=',
    '&=',
    '|=',
    '^=',
    '&&=',
    '||=',
    '??=',
  ].includes(operator);
}

function lowerBinding(sourceFile: ts.SourceFile, name: ts.BindingName): SourceBindingIR {
  if (ts.isIdentifier(name)) {
    return {
      kind: 'identifier_binding',
      name: name.text,
      span: spanOf(sourceFile, name),
    };
  }

  if (ts.isObjectBindingPattern(name)) {
    return {
      kind: 'object_binding',
      elements: name.elements.map((element) => lowerBinding(sourceFile, element.name)),
      span: spanOf(sourceFile, name),
    };
  }

  if (ts.isArrayBindingPattern(name)) {
    return {
      kind: 'array_binding',
      elements: name.elements
        .filter(ts.isBindingElement)
        .map((element) => lowerBinding(sourceFile, element.name)),
      span: spanOf(sourceFile, name),
    };
  }

  return {
    kind: 'unknown_binding',
    text: '<unknown>',
    span: spanOf(sourceFile, name),
  };
}

function lowerLValueExpression(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
): SourceExpressionIR {
  return lowerExpression(sourceFile, expression, 'write');
}

function lowerExpression(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  role: SourceExpressionRole = 'read',
): SourceExpressionIR {
  if (ts.isParenthesizedExpression(expression)) {
    return lowerExpression(sourceFile, expression.expression, role);
  }

  if (ts.isIdentifier(expression) && expression.text === 'undefined') {
    return {
      kind: 'literal',
      literalKind: 'undefined',
      text: 'undefined',
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isIdentifier(expression)) {
    return {
      kind: 'identifier',
      name: expression.text,
      role,
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return {
      kind: 'property_access',
      object: lowerExpression(sourceFile, expression.expression, expressionRoleForChild(role)),
      property: expression.name.text,
      role,
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isElementAccessExpression(expression)) {
    return {
      kind: 'element_access',
      object: lowerExpression(sourceFile, expression.expression, expressionRoleForChild(role)),
      index: expression.argumentExpression
        ? lowerExpression(sourceFile, expression.argumentExpression)
        : undefined,
      role,
      span: spanOf(sourceFile, expression),
    };
  }

  if (
    ts.isNumericLiteral(expression) ||
    ts.isStringLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    const literalKind = ts.isNumericLiteral(expression)
      ? 'number'
      : ts.isStringLiteral(expression)
      ? 'string'
      : expression.kind === ts.SyntaxKind.NullKeyword
      ? 'null'
      : 'boolean';
    return {
      kind: 'literal',
      literalKind,
      text: expression.getText(sourceFile),
      span: spanOf(sourceFile, expression),
    };
  }

  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.PlusPlusToken ||
      expression.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return {
      kind: 'update_expression',
      operator: updateOperatorForSource(expression.operator),
      operand: lowerLValueExpression(sourceFile, expression.operand),
      prefix: true,
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isPrefixUnaryExpression(expression)) {
    return {
      kind: 'unary_expression',
      operator: prefixUnaryOperatorForSource(expression.operator),
      operand: lowerExpression(sourceFile, expression.operand),
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isTypeOfExpression(expression)) {
    return {
      kind: 'unary_expression',
      operator: 'typeof',
      operand: lowerExpression(sourceFile, expression.expression),
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isPostfixUnaryExpression(expression)) {
    return {
      kind: 'update_expression',
      operator: updateOperatorForSource(expression.operator),
      operand: lowerLValueExpression(sourceFile, expression.operand),
      prefix: false,
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isConditionalExpression(expression)) {
    return {
      kind: 'conditional_expression',
      test: lowerExpression(sourceFile, expression.condition),
      consequent: lowerExpression(sourceFile, expression.whenTrue),
      alternate: lowerExpression(sourceFile, expression.whenFalse),
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.getText(sourceFile);
    if (isAssignmentOperatorForSource(operator)) {
      return {
        kind: 'assignment_expression',
        operator,
        left: lowerLValueExpression(sourceFile, expression.left),
        right: lowerExpression(sourceFile, expression.right),
        span: spanOf(sourceFile, expression),
      };
    }
    if (operator === '&&' || operator === '||' || operator === '??') {
      return {
        kind: 'logical_expression',
        operator,
        left: lowerExpression(sourceFile, expression.left),
        right: lowerExpression(sourceFile, expression.right),
        span: spanOf(sourceFile, expression),
      };
    }
    return {
      kind: 'binary_expression',
      operator,
      left: lowerExpression(sourceFile, expression.left),
      right: lowerExpression(sourceFile, expression.right),
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isCallExpression(expression)) {
    return {
      kind: 'call_expression',
      callee: lowerExpression(sourceFile, expression.expression),
      args: expression.arguments.map((argument) => lowerExpression(sourceFile, argument)),
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isNewExpression(expression)) {
    return {
      kind: 'new_expression',
      callee: lowerExpression(sourceFile, expression.expression),
      args: expression.arguments?.map((argument) => lowerExpression(sourceFile, argument)) ?? [],
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isAwaitExpression(expression)) {
    return {
      kind: 'await_expression',
      expression: lowerExpression(sourceFile, expression.expression),
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isArrayLiteralExpression(expression)) {
    return {
      kind: 'array_literal',
      elements: expression.elements.map((element) => lowerExpression(sourceFile, element)),
      span: spanOf(sourceFile, expression),
    };
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return {
      kind: 'object_literal',
      properties: expression.properties
        .filter(ts.isPropertyAssignment)
        .map((property) => ({
          name: property.name.getText(sourceFile),
          value: lowerExpression(sourceFile, property.initializer),
          span: spanOf(sourceFile, property),
        })),
      span: spanOf(sourceFile, expression),
    };
  }

  return {
    kind: 'unknown_expression',
    syntaxKind: syntaxKindName(expression.kind),
    text: expression.getText(sourceFile),
    span: spanOf(sourceFile, expression),
  };
}

function lowerStatement(sourceFile: ts.SourceFile, statement: ts.Statement): SourceStatementIR {
  if (ts.isVariableStatement(statement)) {
    return {
      kind: 'variable_declaration',
      declarationKind: declarationKindOf(statement.declarationList.flags),
      declarations: statement.declarationList.declarations.map((declaration) => ({
        binding: lowerBinding(sourceFile, declaration.name),
        initializer: declaration.initializer
          ? lowerExpression(sourceFile, declaration.initializer)
          : undefined,
      })),
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isExpressionStatement(statement)) {
    return {
      kind: 'expression_statement',
      expression: lowerExpression(sourceFile, statement.expression),
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isReturnStatement(statement)) {
    return {
      kind: 'return',
      expression: statement.expression
        ? lowerExpression(sourceFile, statement.expression)
        : undefined,
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isBreakStatement(statement)) {
    return {
      kind: 'break',
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isContinueStatement(statement)) {
    return {
      kind: 'continue',
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isThrowStatement(statement) && statement.expression) {
    return {
      kind: 'throw',
      expression: lowerExpression(sourceFile, statement.expression),
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isIfStatement(statement)) {
    return {
      kind: 'if',
      test: lowerExpression(sourceFile, statement.expression),
      consequent: lowerStatementList(sourceFile, statement.thenStatement),
      alternate: statement.elseStatement
        ? lowerStatementList(sourceFile, statement.elseStatement)
        : [],
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isWhileStatement(statement)) {
    return {
      kind: 'while',
      test: lowerExpression(sourceFile, statement.expression),
      body: lowerStatementList(sourceFile, statement.statement),
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isDoStatement(statement)) {
    return {
      kind: 'do_while',
      body: lowerStatementList(sourceFile, statement.statement),
      test: lowerExpression(sourceFile, statement.expression),
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isForStatement(statement)) {
    return {
      kind: 'for',
      initializer: statement.initializer
        ? ts.isVariableDeclarationList(statement.initializer)
          ? {
            kind: 'variable_declaration',
            declarationKind: declarationKindOf(statement.initializer.flags),
            declarations: statement.initializer.declarations.map((declaration) => ({
              binding: lowerBinding(sourceFile, declaration.name),
              initializer: declaration.initializer
                ? lowerExpression(sourceFile, declaration.initializer)
                : undefined,
            })),
            span: spanOf(sourceFile, statement.initializer),
          }
          : lowerExpression(sourceFile, statement.initializer)
        : undefined,
      test: statement.condition ? lowerExpression(sourceFile, statement.condition) : undefined,
      incrementor: statement.incrementor
        ? lowerExpression(sourceFile, statement.incrementor)
        : undefined,
      body: lowerStatementList(sourceFile, statement.statement),
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isForOfStatement(statement)) {
    const left = ts.isVariableDeclarationList(statement.initializer)
      ? lowerBinding(sourceFile, statement.initializer.declarations[0].name)
      : lowerLValueExpression(sourceFile, statement.initializer);
    return {
      kind: 'for_of',
      await: statement.awaitModifier !== undefined,
      left,
      right: lowerExpression(sourceFile, statement.expression),
      body: lowerStatementList(sourceFile, statement.statement),
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isSwitchStatement(statement)) {
    return {
      kind: 'switch',
      expression: lowerExpression(sourceFile, statement.expression),
      clauses: statement.caseBlock.clauses.map((clause) =>
        ts.isCaseClause(clause)
          ? {
            kind: 'case',
            expression: lowerExpression(sourceFile, clause.expression),
            statements: lowerStatements(sourceFile, clause.statements),
            span: spanOf(sourceFile, clause),
          }
          : {
            kind: 'default',
            statements: lowerStatements(sourceFile, clause.statements),
            span: spanOf(sourceFile, clause),
          }
      ),
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isTryStatement(statement)) {
    return {
      kind: 'try',
      tryBlock: lowerStatements(sourceFile, statement.tryBlock.statements),
      catchBinding: statement.catchClause?.variableDeclaration
        ? lowerBinding(sourceFile, statement.catchClause.variableDeclaration.name)
        : undefined,
      catchBlock: statement.catchClause
        ? lowerStatements(sourceFile, statement.catchClause.block.statements)
        : undefined,
      finallyBlock: statement.finallyBlock
        ? lowerStatements(sourceFile, statement.finallyBlock.statements)
        : undefined,
      span: spanOf(sourceFile, statement),
    };
  }

  if (ts.isBlock(statement)) {
    return {
      kind: 'block',
      statements: lowerStatements(sourceFile, statement.statements),
      span: spanOf(sourceFile, statement),
    };
  }

  return {
    kind: 'unknown_statement',
    syntaxKind: syntaxKindName(statement.kind),
    text: statement.getText(sourceFile),
    span: spanOf(sourceFile, statement),
  };
}

function lowerStatementList(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
): SourceStatementIR[] {
  return ts.isBlock(statement)
    ? lowerStatements(sourceFile, statement.statements)
    : [lowerStatement(sourceFile, statement)];
}

function lowerStatements(
  sourceFile: ts.SourceFile,
  statements: ts.NodeArray<ts.Statement>,
): SourceStatementIR[] {
  return statements
    .filter((statement) =>
      !ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement)
    )
    .map((statement) => lowerStatement(sourceFile, statement));
}

function lowerFunction(sourceFile: ts.SourceFile, node: ts.FunctionDeclaration): SourceFunctionIR {
  return {
    kind: 'source_function',
    name: node.name?.text ?? '<anonymous>',
    exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
    async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    generator: node.asteriskToken !== undefined,
    params: node.parameters.map((param) => lowerBinding(sourceFile, param.name)),
    body: node.body ? lowerStatements(sourceFile, node.body.statements) : [],
    span: spanOf(sourceFile, node),
  };
}

function lowerClassMember(sourceFile: ts.SourceFile, member: ts.ClassElement): SourceClassMemberIR {
  const staticMember = hasModifier(member, ts.SyntaxKind.StaticKeyword);
  const span = spanOf(sourceFile, member);
  if (ts.isConstructorDeclaration(member)) {
    return { kind: 'constructor', name: 'constructor', static: false, span };
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return {
      kind: 'getter',
      name: member.name.getText(sourceFile),
      static: staticMember,
      span,
    };
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return {
      kind: 'setter',
      name: member.name.getText(sourceFile),
      static: staticMember,
      span,
    };
  }
  if (ts.isMethodDeclaration(member)) {
    return {
      kind: 'method',
      name: member.name.getText(sourceFile),
      static: staticMember,
      span,
    };
  }
  if (ts.isPropertyDeclaration(member)) {
    return {
      kind: 'property',
      name: member.name.getText(sourceFile),
      static: staticMember,
      span,
    };
  }
  return {
    kind: 'property',
    name: '<unknown>',
    static: staticMember,
    span,
  };
}

function lowerClass(sourceFile: ts.SourceFile, node: ts.ClassDeclaration): SourceClassIR {
  return {
    kind: 'source_class',
    name: node.name?.text ?? '<anonymous>',
    exported: hasModifier(node, ts.SyntaxKind.ExportKeyword),
    members: node.members.map((member) => lowerClassMember(sourceFile, member)),
    span: spanOf(sourceFile, node),
  };
}

function sourceFileBelongsToProject(sourceFile: ts.SourceFile, projectDirectory: string): boolean {
  const normalizedFileName = normalize(ts.sys.resolvePath(sourceFile.fileName));
  const normalizedProjectDirectory = normalize(ts.sys.resolvePath(projectDirectory));
  return normalizedFileName === normalizedProjectDirectory ||
    normalizedFileName.startsWith(`${normalizedProjectDirectory}/`);
}

export function createSourceHIRFromProgram(
  program: ts.Program,
  projectDirectory: string,
): { kind: 'source_hir'; modules: SourceModuleIR[] } {
  const modules = program.getSourceFiles()
    .filter((sourceFile) =>
      !sourceFile.isDeclarationFile && sourceFileBelongsToProject(sourceFile, projectDirectory)
    )
    .map((sourceFile): SourceModuleIR => ({
      kind: 'source_module',
      fileName: sourceFile.fileName,
      functions: sourceFile.statements.filter(ts.isFunctionDeclaration).map((node) =>
        lowerFunction(sourceFile, node)
      ),
      classes: sourceFile.statements.filter(ts.isClassDeclaration).map((node) =>
        lowerClass(sourceFile, node)
      ),
      statements: lowerStatements(sourceFile, sourceFile.statements),
    }));

  return {
    kind: 'source_hir',
    modules,
  };
}
