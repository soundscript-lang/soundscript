import ts from 'typescript';

// Internal bridge from frontend-owned macro wrappers to the current TypeScript host substrate.
// Macro authors should depend on macro_api.ts instead of this module.

import type {
  BlockSyntax,
  DeclSyntax,
  ExprSyntax,
  InvocationSyntax,
  JsxSyntax,
  MacroAnyClassMemberSyntax,
  MacroAnyJsxAttributeSyntax,
  MacroAnyJsxChildSyntax,
  MacroArgumentView,
  MacroArrayLiteralElementSyntax,
  MacroArrayLiteralExprSyntax,
  MacroBinaryExprPattern,
  MacroBinaryOperator,
  MacroBindingIdentifierSyntax,
  MacroCallExprPattern,
  MacroClassConstructorSyntax,
  MacroClassDeclSyntax,
  MacroClassFieldSyntax,
  MacroClassMethodSyntax,
  MacroConditionalExprPattern,
  MacroDeclarationKind,
  MacroFieldBuildOptions,
  MacroForBuildOptions,
  MacroFunctionBuildOptions,
  MacroFunctionDeclSyntax,
  MacroFunctionExprSyntax,
  MacroIfBuildOptions,
  MacroInterfaceDeclSyntax,
  MacroInvocationForm,
  MacroJsxAttributeSyntax,
  MacroJsxElementSyntax,
  MacroJsxExpressionSyntax,
  MacroJsxFragmentSyntax,
  MacroJsxSpreadAttributeSyntax,
  MacroJsxTextSyntax,
  MacroLiteralTypeSyntax,
  MacroMethodBuildOptions,
  MacroModifierName,
  MacroObjectMemberBuildOptions,
  MacroObjectTypeMemberSyntax,
  MacroObjectTypeSyntax,
  MacroParameterBuildOptions,
  MacroParameterSyntax,
  MacroPropertyAccessPattern,
  MacroSetterBuildOptions,
  MacroSyntaxNode,
  MacroSyntaxRewriteOptions,
  MacroTemplateOperand,
  MacroTemplateQuasi,
  MacroTypeAliasDeclSyntax,
  MacroTypeParameterSyntax,
  MacroUnaryOperator,
  MacroUnionTypeSyntax,
  StmtSyntax,
  TypeSyntax,
} from './macro_api.ts';
import {
  parseHostExpression,
  parseHostStatements,
  parseSingleHostStatement,
  synthesizeHostNode,
} from './macro_host_ast_internal.ts';
import { parseMacroInvocationAt } from './macro_parser.ts';
import { scanMacroCandidates } from './macro_scanner.ts';
import type { SourceSpan } from './macro_types.ts';

const HOST_NODE = Symbol.for('soundscript.macro-syntax.host-node');
const HOST_SOURCE_FILE = Symbol.for('soundscript.macro-syntax.host-source-file');
const HOST_HINT = Symbol.for('soundscript.macro-syntax.host-hint');
const HOST_SOURCE_OFFSET = Symbol.for('soundscript.macro-syntax.host-source-offset');

type HostHint = ts.EmitHint;

interface HostBackedSyntaxNode {
  readonly [HOST_HINT]: HostHint;
  readonly [HOST_NODE]: ts.Node;
  readonly [HOST_SOURCE_FILE]: ts.SourceFile;
}

type SourceFileWithOffset = ts.SourceFile & {
  [HOST_SOURCE_OFFSET]?: number;
};

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

function withHostNode<T extends MacroSyntaxNode>(
  node: T,
  hostNode: ts.Node,
  sourceFile: ts.SourceFile,
  hint: HostHint,
): T {
  return Object.assign(node, {
    [HOST_HINT]: hint,
    [HOST_NODE]: hostNode,
    [HOST_SOURCE_FILE]: sourceFile,
  });
}

function printHostNode(node: ts.Node, sourceFile: ts.SourceFile, hint: HostHint): string {
  return printer.printNode(hint, node, sourceFile);
}

function offsetSpan(baseSpan: SourceSpan, innerSpan: SourceSpan): SourceSpan {
  return {
    fileName: baseSpan.fileName,
    start: baseSpan.start + innerSpan.start,
    end: baseSpan.start + innerSpan.end,
  };
}

function setSourceFileOffset(sourceFile: ts.SourceFile, offset: number): ts.SourceFile {
  (sourceFile as SourceFileWithOffset)[HOST_SOURCE_OFFSET] = offset;
  return sourceFile;
}

function sourceFileOffset(sourceFile: ts.SourceFile): number {
  return (sourceFile as SourceFileWithOffset)[HOST_SOURCE_OFFSET] ?? 0;
}

function scriptKindForHostFile(fileName: string): ts.ScriptKind {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.sts') || lowered.endsWith('.tsx') || lowered.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lowered.endsWith('.js') || lowered.endsWith('.mjs') || lowered.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function ensureNoParseDiagnostics(sourceFile: ts.SourceFile, message: string): void {
  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    throw new Error(message);
  }
}

function fallbackText(node: MacroSyntaxNode): string {
  const hostBacked = node as MacroSyntaxNode & Partial<HostBackedSyntaxNode>;
  if (hostBacked[HOST_NODE] && hostBacked[HOST_SOURCE_FILE]) {
    return printHostNode(
      hostBacked[HOST_NODE],
      hostBacked[HOST_SOURCE_FILE],
      hostBacked[HOST_HINT] ?? ts.EmitHint.Unspecified,
    );
  }
  return '';
}

export function getHostNode(node: MacroSyntaxNode): ts.Node | null {
  return (node as MacroSyntaxNode & Partial<HostBackedSyntaxNode>)[HOST_NODE] ?? null;
}

export function getHostExpression(node: ExprSyntax): ts.Expression {
  const hostNode = getHostNode(node);
  if (!hostNode || !ts.isExpression(hostNode)) {
    throw new Error('Expected an expression-backed syntax node.');
  }
  return hostNode;
}

export function getHostStatement(node: StmtSyntax | DeclSyntax): ts.Statement {
  const hostNode = getHostNode(node);
  if (!hostNode || !ts.isStatement(hostNode)) {
    throw new Error('Expected a statement-backed syntax node.');
  }
  return hostNode;
}

export function getHostBlock(node: BlockSyntax): ts.Block {
  const hostNode = getHostNode(node);
  if (!hostNode || !ts.isBlock(hostNode)) {
    throw new Error('Expected a block-backed syntax node.');
  }
  return hostNode;
}

export function getHostDeclaration(
  node: DeclSyntax,
):
  | ts.ClassDeclaration
  | ts.FunctionDeclaration
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration {
  const hostNode = getHostNode(node);
  if (
    !hostNode ||
    (!ts.isClassDeclaration(hostNode) && !ts.isFunctionDeclaration(hostNode) &&
      !ts.isInterfaceDeclaration(hostNode) && !ts.isTypeAliasDeclaration(hostNode))
  ) {
    throw new Error('Expected a declaration-backed syntax node.');
  }
  return hostNode;
}

export function getHostJsx(
  node: JsxSyntax,
): ts.JsxChild | ts.JsxOpeningLikeElement | ts.JsxAttributeLike {
  const hostNode = getHostNode(node);
  if (!hostNode) {
    throw new Error('Expected a JSX-backed syntax node.');
  }
  return hostNode as ts.JsxChild | ts.JsxOpeningLikeElement | ts.JsxAttributeLike;
}

function nodeSpan(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  fallback: SourceSpan,
): SourceSpan {
  if (node.pos >= 0 && node.end >= 0) {
    const offset = sourceFileOffset(sourceFile);
    return {
      fileName: fallback.fileName,
      start: offset + node.getStart(sourceFile, false),
      end: offset + node.end,
    };
  }
  return {
    fileName: fallback.fileName,
    start: fallback.start,
    end: fallback.end,
  };
}

function hasModifier(
  node: { readonly modifiers?: readonly ts.ModifierLike[] },
  name: MacroModifierName,
): boolean {
  const expectedKind = (() => {
    switch (name) {
      case 'async':
        return ts.SyntaxKind.AsyncKeyword;
      case 'default':
        return ts.SyntaxKind.DefaultKeyword;
      case 'export':
        return ts.SyntaxKind.ExportKeyword;
      case 'private':
        return ts.SyntaxKind.PrivateKeyword;
      case 'protected':
        return ts.SyntaxKind.ProtectedKeyword;
      case 'public':
        return ts.SyntaxKind.PublicKeyword;
      case 'readonly':
        return ts.SyntaxKind.ReadonlyKeyword;
      case 'static':
        return ts.SyntaxKind.StaticKeyword;
    }
  })();
  return node.modifiers?.some((modifier) => modifier.kind === expectedKind) ?? false;
}

function createModifierNodes(
  names: readonly MacroModifierName[] | undefined,
): readonly ts.Modifier[] | undefined {
  if (!names || names.length === 0) {
    return undefined;
  }
  return names.map((name) => {
    switch (name) {
      case 'async':
        return ts.factory.createModifier(ts.SyntaxKind.AsyncKeyword);
      case 'default':
        return ts.factory.createModifier(ts.SyntaxKind.DefaultKeyword);
      case 'export':
        return ts.factory.createModifier(ts.SyntaxKind.ExportKeyword);
      case 'private':
        return ts.factory.createModifier(ts.SyntaxKind.PrivateKeyword);
      case 'protected':
        return ts.factory.createModifier(ts.SyntaxKind.ProtectedKeyword);
      case 'public':
        return ts.factory.createModifier(ts.SyntaxKind.PublicKeyword);
      case 'readonly':
        return ts.factory.createModifier(ts.SyntaxKind.ReadonlyKeyword);
      case 'static':
        return ts.factory.createModifier(ts.SyntaxKind.StaticKeyword);
    }
  });
}

function createBuildSourceFile(fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    '',
    ts.ScriptTarget.Latest,
    true,
    scriptKindForHostFile(fileName),
  );
}

function cloneBlockNode(block: BlockSyntax): ts.Block {
  return synthesizeHostNode(ts.factory.createBlock([...getHostBlock(block).statements], true));
}

function createBinaryOperatorToken(operator: MacroBinaryOperator): ts.BinaryOperatorToken {
  switch (operator) {
    case '&':
      return ts.factory.createToken(ts.SyntaxKind.AmpersandToken);
    case '<':
      return ts.factory.createToken(ts.SyntaxKind.LessThanToken);
    case '+':
      return ts.factory.createToken(ts.SyntaxKind.PlusToken);
    case '=':
      return ts.factory.createToken(ts.SyntaxKind.EqualsToken);
    case '!==':
      return ts.factory.createToken(ts.SyntaxKind.ExclamationEqualsEqualsToken);
    case '===':
      return ts.factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken);
    case '|':
      return ts.factory.createToken(ts.SyntaxKind.BarToken);
  }
}

function createUnaryOperatorToken(operator: MacroUnaryOperator): ts.PrefixUnaryOperator {
  switch (operator) {
    case '!':
      return ts.SyntaxKind.ExclamationToken;
  }
}

function createBuiltExprSyntax(
  fileName: string,
  node: ts.Expression,
): ExprSyntax {
  const sourceFile = createBuildSourceFile(fileName);
  return createExprSyntaxFromNode(synthesizeHostNode(node), sourceFile, {
    fileName,
    start: 0,
    end: 0,
  });
}

function createBuiltStmtSyntax(
  fileName: string,
  node: ts.Statement,
): StmtSyntax {
  const sourceFile = createBuildSourceFile(fileName);
  return createStmtSyntaxFromNode(synthesizeHostNode(node), sourceFile, {
    fileName,
    start: 0,
    end: 0,
  });
}

function createTypeNodeFromText(fileName: string, typeText: string): ts.TypeNode {
  const sourceFile = ts.createSourceFile(
    fileName,
    `type __SoundscriptMacroParam = ${typeText};`,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForHostFile(fileName),
  );
  ensureNoParseDiagnostics(
    sourceFile,
    'Macro builder parameter types must parse as valid host-language types.',
  );
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isTypeAliasDeclaration(statement) || !statement.type) {
    throw new Error('Macro builder parameter types must parse as valid host-language types.');
  }
  return synthesizeHostNode(statement.type);
}

function createParameterDeclarations(
  fileName: string,
  parameters: readonly (string | MacroParameterBuildOptions)[] | undefined,
): readonly ts.ParameterDeclaration[] {
  return (parameters ?? []).map((parameter) => {
    const normalized = typeof parameter === 'string' ? { name: parameter } : parameter;
    return synthesizeHostNode(
      ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        normalized.name,
        undefined,
        normalized.type ? createTypeNodeFromText(fileName, normalized.type) : undefined,
        undefined,
      ),
    );
  });
}

function collectThisMemberReferences(node: ts.Node | null): readonly string[] {
  if (!node) {
    return [];
  }

  const references = new Set<string>();
  function visit(current: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(current) &&
      current.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(current.name)
    ) {
      references.add(current.name.text);
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return [...references];
}

function containsCallNamed(node: ts.Node | null, name: string): boolean {
  if (!node) {
    return false;
  }
  let found = false;
  function visit(current: ts.Node): void {
    if (found) {
      return;
    }
    if (ts.isCallExpression(current)) {
      const callee = unwrapParenthesizedExpressionNode(current.expression);
      if (ts.isIdentifier(callee) && callee.text === name) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function unwrapParenthesizedExpressionNode(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function expressionAsIdentifier(node: ts.Expression): string | null {
  const unwrapped = unwrapParenthesizedExpressionNode(node);
  return ts.isIdentifier(unwrapped) ? unwrapped.text : null;
}

function createArrayLiteralElementSyntaxFromNode(
  node: ts.Expression | ts.SpreadElement | ts.OmittedExpression,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroArrayLiteralElementSyntax {
  if (ts.isOmittedExpression(node)) {
    return withHostNode(
      {
        expression() {
          return null;
        },
        isSpread: false,
        kind: 'array_elision',
        span: nodeSpan(node, sourceFile, fallbackSpan),
        text() {
          return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
        },
      },
      node,
      sourceFile,
      ts.EmitHint.Unspecified,
    );
  }

  const expression = ts.isSpreadElement(node) ? node.expression : node;
  return withHostNode(
    {
      expression() {
        return createExprSyntaxFromNode(
          expression,
          sourceFile,
          nodeSpan(expression, sourceFile, fallbackSpan),
        );
      },
      isSpread: ts.isSpreadElement(node),
      kind: 'array_element',
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function expressionAsArrayLiteral(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
): MacroArrayLiteralExprSyntax | null {
  const unwrapped = unwrapParenthesizedExpressionNode(node);
  if (!ts.isArrayLiteralExpression(unwrapped)) {
    return null;
  }

  const base = createExprSyntaxFromNode(unwrapped, sourceFile, span);
  return {
    ...base,
    asArrayLiteral() {
      return this;
    },
    elements: unwrapped.elements.map((element) =>
      createArrayLiteralElementSyntaxFromNode(
        element,
        sourceFile,
        nodeSpan(element, sourceFile, span),
      )
    ),
  };
}

function expressionAsPropertyAccess(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
): MacroPropertyAccessPattern | null {
  const unwrapped = unwrapParenthesizedExpressionNode(node);
  if (!ts.isPropertyAccessExpression(unwrapped)) {
    return null;
  }
  return {
    name: unwrapped.name.text,
    object: createExprSyntaxFromNode(
      unwrapped.expression,
      sourceFile,
      nodeSpan(unwrapped.expression, sourceFile, span),
    ),
  };
}

function expressionAsCall(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
): MacroCallExprPattern | null {
  const unwrapped = unwrapParenthesizedExpressionNode(node);
  if (!ts.isCallExpression(unwrapped)) {
    return null;
  }
  return {
    args: unwrapped.arguments.map((argument) =>
      createExprSyntaxFromNode(argument, sourceFile, nodeSpan(argument, sourceFile, span))
    ),
    callee: createExprSyntaxFromNode(
      unwrapped.expression,
      sourceFile,
      nodeSpan(unwrapped.expression, sourceFile, span),
    ),
  };
}

function expressionAsBinary(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
): MacroBinaryExprPattern | null {
  const unwrapped = unwrapParenthesizedExpressionNode(node);
  if (!ts.isBinaryExpression(unwrapped)) {
    return null;
  }
  return {
    left: createExprSyntaxFromNode(
      unwrapped.left,
      sourceFile,
      nodeSpan(unwrapped.left, sourceFile, span),
    ),
    operator: ts.tokenToString(unwrapped.operatorToken.kind) ??
      unwrapped.operatorToken.getText(sourceFile),
    right: createExprSyntaxFromNode(
      unwrapped.right,
      sourceFile,
      nodeSpan(unwrapped.right, sourceFile, span),
    ),
  };
}

function expressionAsConditional(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
): MacroConditionalExprPattern | null {
  const unwrapped = unwrapParenthesizedExpressionNode(node);
  if (!ts.isConditionalExpression(unwrapped)) {
    return null;
  }
  return {
    condition: createExprSyntaxFromNode(
      unwrapped.condition,
      sourceFile,
      nodeSpan(unwrapped.condition, sourceFile, span),
    ),
    whenFalse: createExprSyntaxFromNode(
      unwrapped.whenFalse,
      sourceFile,
      nodeSpan(unwrapped.whenFalse, sourceFile, span),
    ),
    whenTrue: createExprSyntaxFromNode(
      unwrapped.whenTrue,
      sourceFile,
      nodeSpan(unwrapped.whenTrue, sourceFile, span),
    ),
  };
}

function expressionAsJsxElement(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
): MacroJsxElementSyntax | null {
  const current = unwrapParenthesizedExpressionNode(node);
  if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
    return createJsxElementSyntaxFromNode(
      current,
      sourceFile,
      nodeSpan(current, sourceFile, span),
    );
  }
  return null;
}

function expressionAsJsxFragment(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
): MacroJsxFragmentSyntax | null {
  const current = unwrapParenthesizedExpressionNode(node);
  if (ts.isJsxFragment(current)) {
    return createJsxFragmentSyntaxFromNode(
      current,
      sourceFile,
      nodeSpan(current, sourceFile, span),
    );
  }
  return null;
}

function replaceThisNode<T extends ts.Node>(
  node: T,
  replacement: ExprSyntax,
): T {
  return rewriteNode(node, { replaceThisWith: replacement });
}

function cloneExpressionNode(node: ts.Expression): ts.Expression {
  return synthesizeHostNode(
    (ts.factory as typeof ts.factory & { cloneNode(node: ts.Expression): ts.Expression }).cloneNode(
      node,
    ),
  );
}

function compoundAssignmentOperatorTokenForRewrite(
  kind: ts.SyntaxKind,
): ts.BinaryOperatorToken | null {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken:
      return ts.factory.createToken(ts.SyntaxKind.PlusToken);
    case ts.SyntaxKind.MinusEqualsToken:
      return ts.factory.createToken(ts.SyntaxKind.MinusToken);
    case ts.SyntaxKind.AsteriskEqualsToken:
      return ts.factory.createToken(ts.SyntaxKind.AsteriskToken);
    case ts.SyntaxKind.SlashEqualsToken:
      return ts.factory.createToken(ts.SyntaxKind.SlashToken);
    case ts.SyntaxKind.PercentEqualsToken:
      return ts.factory.createToken(ts.SyntaxKind.PercentToken);
    default:
      return null;
  }
}

function updateOperatorTokenForRewrite(kind: ts.SyntaxKind): ts.BinaryOperatorToken | null {
  switch (kind) {
    case ts.SyntaxKind.PlusPlusToken:
      return ts.factory.createToken(ts.SyntaxKind.PlusToken);
    case ts.SyntaxKind.MinusMinusToken:
      return ts.factory.createToken(ts.SyntaxKind.MinusToken);
    default:
      return null;
  }
}

function thisPropertyNameForRewrite(expression: ts.Expression): string | null {
  return ts.isPropertyAccessExpression(expression) &&
      expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ? expression.name.text
    : null;
}

function rewriteNode<T extends ts.Node>(
  node: T,
  options: MacroSyntaxRewriteOptions,
): T {
  const replaceThisWith = options.replaceThisWith
    ? getHostExpression(options.replaceThisWith)
    : null;
  const replaceCallNamed = new Map(
    Object.entries(options.replaceCallNamed ?? {}).map(([name, replacement]) => [
      name,
      getHostExpression(replacement),
    ]),
  );
  const replaceThisMemberWriteNamed = new Map(
    Object.entries(options.replaceThisMemberWriteNamed ?? {}).map(([name, replacement]) => [
      name,
      getHostExpression(replacement),
    ]),
  );
  let temporaryCount = 0;
  const transformed = ts.transform(node, [(
    context: ts.TransformationContext,
  ) =>
  (root: ts.Node) =>
    ts.visitNode(root, function visit(current): ts.Node {
      if (ts.isBinaryExpression(current)) {
        const targetName = thisPropertyNameForRewrite(current.left);
        const setterExpression = targetName
          ? replaceThisMemberWriteNamed.get(targetName)
          : undefined;
        if (targetName && setterExpression) {
          if (current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            return synthesizeHostNode(
              ts.factory.createCallExpression(
                cloneExpressionNode(setterExpression),
                undefined,
                [ts.visitNode(current.right, visit) as ts.Expression],
              ),
            );
          }
          const operator = compoundAssignmentOperatorTokenForRewrite(current.operatorToken.kind);
          if (operator) {
            const receiver = replaceThisWith
              ? cloneExpressionNode(replaceThisWith)
              : ts.factory.createThis();
            return synthesizeHostNode(
              ts.factory.createCallExpression(
                cloneExpressionNode(setterExpression),
                undefined,
                [
                  ts.factory.createBinaryExpression(
                    ts.factory.createPropertyAccessExpression(receiver, targetName),
                    operator,
                    ts.visitNode(current.right, visit) as ts.Expression,
                  ),
                ],
              ),
            );
          }
        }
      }
      if (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) {
        const targetName = thisPropertyNameForRewrite(current.operand);
        const setterExpression = targetName
          ? replaceThisMemberWriteNamed.get(targetName)
          : undefined;
        if (targetName && setterExpression) {
          const operator = updateOperatorTokenForRewrite(current.operator);
          if (operator) {
            const receiver = replaceThisWith
              ? cloneExpressionNode(replaceThisWith)
              : ts.factory.createThis();
            const currentValue = ts.factory.createPropertyAccessExpression(receiver, targetName);
            const nextValue = ts.factory.createBinaryExpression(
              currentValue,
              operator,
              ts.factory.createNumericLiteral(1),
            );
            if (ts.isPrefixUnaryExpression(current)) {
              return synthesizeHostNode(
                ts.factory.createCallExpression(
                  cloneExpressionNode(setterExpression),
                  undefined,
                  [nextValue],
                ),
              );
            }
            if (current.parent && ts.isExpressionStatement(current.parent)) {
              return synthesizeHostNode(
                ts.factory.createCallExpression(
                  cloneExpressionNode(setterExpression),
                  undefined,
                  [nextValue],
                ),
              );
            }

            const previousName = `__sts_prev_${temporaryCount++}`;
            return synthesizeHostNode(
              ts.factory.createCallExpression(
                ts.factory.createParenthesizedExpression(
                  ts.factory.createArrowFunction(
                    undefined,
                    undefined,
                    [],
                    undefined,
                    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                    ts.factory.createBlock([
                      ts.factory.createVariableStatement(
                        undefined,
                        ts.factory.createVariableDeclarationList([
                          ts.factory.createVariableDeclaration(
                            previousName,
                            undefined,
                            undefined,
                            currentValue,
                          ),
                        ], ts.NodeFlags.Const),
                      ),
                      ts.factory.createExpressionStatement(
                        ts.factory.createCallExpression(
                          cloneExpressionNode(setterExpression),
                          undefined,
                          [
                            ts.factory.createBinaryExpression(
                              ts.factory.createIdentifier(previousName),
                              operator,
                              ts.factory.createNumericLiteral(1),
                            ),
                          ],
                        ),
                      ),
                      ts.factory.createReturnStatement(ts.factory.createIdentifier(previousName)),
                    ], true),
                  ),
                ),
                undefined,
                [],
              ),
            );
          }
        }
      }
      if (replaceThisWith && current.kind === ts.SyntaxKind.ThisKeyword) {
        return cloneExpressionNode(replaceThisWith);
      }
      if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
        const replacementCallee = replaceCallNamed.get(current.expression.text);
        if (replacementCallee) {
          return synthesizeHostNode(
            ts.factory.updateCallExpression(
              current,
              cloneExpressionNode(replacementCallee),
              current.typeArguments,
              current.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
            ),
          );
        }
      }
      return ts.visitEachChild(current, visit, context);
    })]);
  try {
    const [rewritten] = transformed.transformed;
    if (!rewritten) {
      throw new Error('Macro syntax transform produced an empty result.');
    }
    return rewritten as T;
  } finally {
    transformed.dispose();
  }
}

function rewriteExprSyntax(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
  options: MacroSyntaxRewriteOptions,
): ExprSyntax {
  return createExprSyntaxFromNode(rewriteNode(node, options), sourceFile, span);
}

function rewriteBlockSyntax(
  node: ts.Block,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
  options: MacroSyntaxRewriteOptions,
): BlockSyntax {
  return createBlockSyntaxFromNode(rewriteNode(node, options), sourceFile, span);
}

function resolveThisDependenciesForClass(
  node: ts.ClassDeclaration,
  rootMemberNames: readonly string[],
  target: ExprSyntax | BlockSyntax,
): readonly string[] {
  const rootNames = new Set(rootMemberNames);
  const getters = new Map<string, ts.GetAccessorDeclaration>();
  for (const member of node.members) {
    if (
      ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name) &&
      member.body
    ) {
      getters.set(member.name.text, member);
    }
  }

  const cache = new Map<string, ReadonlySet<string>>();
  function resolveMember(
    memberName: string,
    seen: ReadonlySet<string> = new Set(),
  ): ReadonlySet<string> {
    if (rootNames.has(memberName)) {
      return new Set([memberName]);
    }

    const cached = cache.get(memberName);
    if (cached) {
      return cached;
    }
    if (seen.has(memberName)) {
      return new Set();
    }

    const getter = getters.get(memberName);
    if (!getter?.body) {
      return new Set();
    }

    const nextSeen = new Set(seen);
    nextSeen.add(memberName);
    const dependencies = new Set<string>();
    for (const reference of collectThisMemberReferences(getter.body)) {
      for (const dependency of resolveMember(reference, nextSeen)) {
        dependencies.add(dependency);
      }
    }
    cache.set(memberName, dependencies);
    return dependencies;
  }

  const dependencies = new Set<string>();
  for (const reference of target.thisMemberReferences()) {
    for (const dependency of resolveMember(reference)) {
      dependencies.add(dependency);
    }
  }
  return [...dependencies];
}

function returnedJsxNode(
  node:
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.FunctionDeclaration,
): ts.JsxElement | ts.JsxSelfClosingElement | null {
  if (!node.body) {
    return null;
  }
  if (node.body.statements.length !== 1) {
    return null;
  }
  const [statement] = node.body.statements;
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
    return null;
  }
  if (ts.isJsxElement(statement.expression) || ts.isJsxSelfClosingElement(statement.expression)) {
    return statement.expression;
  }
  return null;
}

function returnedExprNode(
  node:
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.FunctionDeclaration,
): ts.Expression | null {
  if (!node.body) {
    return null;
  }
  if (node.body.statements.length !== 1) {
    return null;
  }
  const [statement] = node.body.statements;
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
    return null;
  }
  return statement.expression;
}

function typeElementNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) {
    return null;
  }
  if (
    ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return null;
}

function createObjectTypeMemberSyntaxFromNode(
  node: ts.TypeElement,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroObjectTypeMemberSyntax {
  const memberKind: MacroObjectTypeMemberSyntax['memberKind'] = ts.isPropertySignature(node)
    ? 'property_signature'
    : ts.isMethodSignature(node)
    ? 'method_signature'
    : ts.isIndexSignatureDeclaration(node)
    ? 'index_signature'
    : ts.isConstructSignatureDeclaration(node)
    ? 'construct_signature'
    : 'call_signature';

  return withHostNode(
    {
      explicitType() {
        if (
          ts.isPropertySignature(node) ||
          ts.isMethodSignature(node) ||
          ts.isIndexSignatureDeclaration(node) ||
          ts.isConstructSignatureDeclaration(node) ||
          ts.isCallSignatureDeclaration(node)
        ) {
          return node.type
            ? createTypeSyntaxFromNode(
              node.type,
              sourceFile,
              nodeSpan(node.type, sourceFile, fallbackSpan),
            )
            : null;
        }
        return null;
      },
      hasExplicitType() {
        if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) {
          return node.type !== undefined;
        }
        if (ts.isIndexSignatureDeclaration(node) || ts.isConstructSignatureDeclaration(node)) {
          return node.type !== undefined;
        }
        if (ts.isCallSignatureDeclaration(node)) {
          return node.type !== undefined;
        }
        return false;
      },
      isOptional() {
        return (
          (ts.isPropertySignature(node) || ts.isMethodSignature(node)) &&
          node.questionToken !== undefined
        );
      },
      kind: 'type_member',
      memberKind,
      name: 'name' in node ? typeElementNameText(node.name) : null,
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createTypeSyntaxFromNode(
  node: ts.TypeNode,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): TypeSyntax {
  if (ts.isUnionTypeNode(node)) {
    const members = node.types.map((member) =>
      createTypeSyntaxFromNode(member, sourceFile, fallbackSpan)
    );
    let unionTypeSyntax!: MacroUnionTypeSyntax;
    unionTypeSyntax = withHostNode(
      {
        asLiteral() {
          return null;
        },
        asObjectLiteral() {
          return null;
        },
        asUnion() {
          return unionTypeSyntax;
        },
        kind: 'type',
        members,
        span: nodeSpan(node, sourceFile, fallbackSpan),
        text() {
          return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
        },
      },
      node,
      sourceFile,
      ts.EmitHint.Unspecified,
    );
    return unionTypeSyntax;
  }

  if (ts.isLiteralTypeNode(node)) {
    const literal = (() => {
      if (ts.isStringLiteral(node.literal) || ts.isNoSubstitutionTemplateLiteral(node.literal)) {
        return {
          literalKind: 'string' as const,
          value: node.literal.text,
        };
      }
      if (ts.isNumericLiteral(node.literal)) {
        return {
          literalKind: 'number' as const,
          value: Number(node.literal.text),
        };
      }
      if (node.literal.kind === ts.SyntaxKind.TrueKeyword) {
        return {
          literalKind: 'boolean' as const,
          value: true,
        };
      }
      if (node.literal.kind === ts.SyntaxKind.FalseKeyword) {
        return {
          literalKind: 'boolean' as const,
          value: false,
        };
      }
      if (
        ts.isPrefixUnaryExpression(node.literal) &&
        node.literal.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(node.literal.operand)
      ) {
        return {
          literalKind: 'number' as const,
          value: -Number(node.literal.operand.text),
        };
      }
      return null;
    })();

    if (literal) {
      let literalTypeSyntax!: MacroLiteralTypeSyntax;
      literalTypeSyntax = withHostNode(
        {
          asLiteral() {
            return literalTypeSyntax;
          },
          asObjectLiteral() {
            return null;
          },
          asUnion() {
            return null;
          },
          kind: 'type',
          literalKind: literal.literalKind,
          span: nodeSpan(node, sourceFile, fallbackSpan),
          text() {
            return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
          },
          value: literal.value,
        },
        node,
        sourceFile,
        ts.EmitHint.Unspecified,
      );
      return literalTypeSyntax;
    }
  }

  if (ts.isTypeLiteralNode(node)) {
    const members = node.members.map((member) =>
      createObjectTypeMemberSyntaxFromNode(member, sourceFile, fallbackSpan)
    );
    let objectTypeSyntax!: MacroObjectTypeSyntax;
    objectTypeSyntax = withHostNode(
      {
        asLiteral() {
          return null;
        },
        asObjectLiteral() {
          return objectTypeSyntax;
        },
        asUnion() {
          return null;
        },
        kind: 'type',
        members,
        span: nodeSpan(node, sourceFile, fallbackSpan),
        text() {
          return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
        },
      },
      node,
      sourceFile,
      ts.EmitHint.Unspecified,
    );
    return objectTypeSyntax;
  }

  return withHostNode(
    {
      asLiteral() {
        return null;
      },
      asObjectLiteral() {
        return null;
      },
      asUnion() {
        return null;
      },
      kind: 'type',
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createTypeSyntaxFromText(
  fileName: string,
  span: SourceSpan,
  text: string,
): TypeSyntax {
  const sourceFile = ts.createSourceFile(
    fileName,
    `type __MacroType = ${text};`,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForHostFile(fileName),
  );
  ensureNoParseDiagnostics(
    sourceFile,
    'Generated macro type syntax must parse as a valid type expression.',
  );
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isTypeAliasDeclaration(statement)) {
    throw new Error('Generated macro type syntax must parse as a valid type expression.');
  }
  return createTypeSyntaxFromNode(
    statement.type,
    setSourceFileOffset(sourceFile, span.start - statement.type.getStart(sourceFile, false)),
    span,
  );
}

function createTypeParameterSyntaxFromNode(
  node: ts.TypeParameterDeclaration,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroTypeParameterSyntax {
  return withHostNode(
    {
      constraint() {
        return node.constraint
          ? createTypeSyntaxFromNode(
            node.constraint,
            sourceFile,
            nodeSpan(node.constraint, sourceFile, fallbackSpan),
          )
          : null;
      },
      defaultType() {
        return node.default
          ? createTypeSyntaxFromNode(
            node.default,
            sourceFile,
            nodeSpan(node.default, sourceFile, fallbackSpan),
          )
          : null;
      },
      kind: 'type_parameter',
      name: node.name.text,
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createParameterSyntaxFromNode(
  node: ts.ParameterDeclaration,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroParameterSyntax {
  function collectBindingIdentifiers(
    name: ts.BindingName,
  ): readonly MacroBindingIdentifierSyntax[] {
    if (ts.isIdentifier(name)) {
      return [withHostNode(
        {
          kind: 'binding_identifier',
          name: name.text,
          span: nodeSpan(name, sourceFile, fallbackSpan),
        },
        name,
        sourceFile,
        ts.EmitHint.Unspecified,
      )];
    }

    const bindings: MacroBindingIdentifierSyntax[] = [];
    for (const element of name.elements) {
      if (!ts.isBindingElement(element)) {
        continue;
      }
      bindings.push(...collectBindingIdentifiers(element.name));
    }
    return bindings;
  }

  return withHostNode(
    {
      bindingIdentifiers() {
        return collectBindingIdentifiers(node.name);
      },
      explicitType() {
        return node.type ? createTypeSyntaxFromNode(node.type, sourceFile, fallbackSpan) : null;
      },
      hasDefault() {
        return node.initializer !== undefined;
      },
      hasExplicitType() {
        return node.type !== undefined;
      },
      isRest() {
        return node.dotDotDotToken !== undefined;
      },
      kind: 'parameter',
      name: ts.isIdentifier(node.name) ? node.name.text : null,
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createJsxTextSyntaxFromNode(
  node: ts.JsxText,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroJsxTextSyntax {
  return withHostNode(
    {
      kind: 'jsx_text',
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
      value: node.getText(sourceFile),
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createJsxExpressionSyntaxFromNode(
  node: ts.JsxExpression,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroJsxExpressionSyntax {
  return withHostNode(
    {
      kind: 'jsx_expr',
      span: nodeSpan(node, sourceFile, fallbackSpan),
      expression() {
        return node.expression
          ? createExprSyntaxFromNode(
            node.expression,
            sourceFile,
            nodeSpan(node.expression, sourceFile, fallbackSpan),
          )
          : null;
      },
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createJsxChildSyntaxFromNode(
  node: ts.JsxChild,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): readonly MacroAnyJsxChildSyntax[] {
  if (ts.isJsxText(node)) {
    return [createJsxTextSyntaxFromNode(node, sourceFile, fallbackSpan)];
  }
  if (ts.isJsxExpression(node)) {
    return [createJsxExpressionSyntaxFromNode(node, sourceFile, fallbackSpan)];
  }
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    return [createJsxElementSyntaxFromNode(node, sourceFile, fallbackSpan)];
  }
  if (ts.isJsxFragment(node)) {
    return [createJsxFragmentSyntaxFromNode(node, sourceFile, fallbackSpan)];
  }
  return [];
}

function createJsxChildren(
  children: readonly ts.JsxChild[],
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): readonly MacroAnyJsxChildSyntax[] {
  return children.flatMap((child) => createJsxChildSyntaxFromNode(child, sourceFile, fallbackSpan));
}

function createJsxAttributeSyntaxFromNode(
  node: ts.JsxAttribute,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroJsxAttributeSyntax {
  return withHostNode(
    {
      kind: 'jsx_attribute',
      name: ts.isIdentifier(node.name) ? node.name.text : node.name.getText(sourceFile),
      span: nodeSpan(node, sourceFile, fallbackSpan),
      expression() {
        if (
          !node.initializer || !ts.isJsxExpression(node.initializer) || !node.initializer.expression
        ) {
          return null;
        }
        return createExprSyntaxFromNode(
          node.initializer.expression,
          sourceFile,
          nodeSpan(node.initializer.expression, sourceFile, fallbackSpan),
        );
      },
      stringValue() {
        return node.initializer && ts.isStringLiteral(node.initializer)
          ? node.initializer.text
          : null;
      },
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createJsxSpreadAttributeSyntaxFromNode(
  node: ts.JsxSpreadAttribute,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroJsxSpreadAttributeSyntax {
  return withHostNode(
    {
      kind: 'jsx_spread_attribute',
      span: nodeSpan(node, sourceFile, fallbackSpan),
      expression() {
        return createExprSyntaxFromNode(
          node.expression,
          sourceFile,
          nodeSpan(node.expression, sourceFile, fallbackSpan),
        );
      },
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

export function createJsxElementSyntaxFromNode(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroJsxElementSyntax {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const tagName = ts.isIdentifier(opening.tagName) ? opening.tagName.text : null;
  const attributes = () =>
    opening.attributes.properties.map((property): MacroAnyJsxAttributeSyntax =>
      ts.isJsxAttribute(property)
        ? createJsxAttributeSyntaxFromNode(property, sourceFile, fallbackSpan)
        : createJsxSpreadAttributeSyntaxFromNode(property, sourceFile, fallbackSpan)
    );
  return withHostNode(
    {
      attribute(name: string) {
        return attributes().find((attribute) =>
          attribute.kind === 'jsx_attribute' && attribute.name === name
        ) ?? null;
      },
      attributes,
      children() {
        if (ts.isJsxSelfClosingElement(node)) {
          return [];
        }
        return createJsxChildren(node.children, sourceFile, fallbackSpan);
      },
      kind: 'jsx_element',
      selfClosing: ts.isJsxSelfClosingElement(node),
      span: nodeSpan(node, sourceFile, fallbackSpan),
      tagName,
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createJsxFragmentSyntaxFromNode(
  node: ts.JsxFragment,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroJsxFragmentSyntax {
  return withHostNode(
    {
      children() {
        return createJsxChildren(node.children, sourceFile, fallbackSpan);
      },
      kind: 'jsx_fragment',
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createFunctionExprSyntaxFromNode(
  node: ts.ArrowFunction | ts.FunctionExpression,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroFunctionExprSyntax {
  const span = nodeSpan(node, sourceFile, fallbackSpan);
  const syntax: MacroFunctionExprSyntax = withHostNode(
    {
      asArrayLiteral() {
        return null;
      },
      asBinary() {
        return null;
      },
      asCall() {
        return null;
      },
      asConditional() {
        return null;
      },
      asFunction() {
        return syntax;
      },
      asIdentifier() {
        return null;
      },
      asInvocation() {
        return null;
      },
      asJsxElement() {
        return null;
      },
      asJsxFragment() {
        return null;
      },
      asPropertyAccess() {
        return null;
      },
      body() {
        return ts.isBlock(node.body)
          ? createBlockSyntaxFromNode(node.body, sourceFile, nodeSpan(node.body, sourceFile, span))
          : null;
      },
      containsCallNamed(name: string) {
        return containsCallNamed(node, name);
      },
      functionKind: ts.isArrowFunction(node) ? 'arrow' : 'function',
      hasAsyncModifier() {
        return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
          false;
      },
      isBooleanLiteral() {
        return false;
      },
      isNullLiteral() {
        return false;
      },
      kind: 'expr',
      parameters: node.parameters.map((parameter) =>
        createParameterSyntaxFromNode(parameter, sourceFile, nodeSpan(parameter, sourceFile, span))
      ),
      replaceThis(replacement: ExprSyntax) {
        return createExprSyntaxFromNode(replaceThisNode(node, replacement), sourceFile, span);
      },
      rewrite(options: MacroSyntaxRewriteOptions) {
        return rewriteExprSyntax(node, sourceFile, span, options);
      },
      returnedExpr() {
        if (ts.isBlock(node.body)) {
          if (node.body.statements.length !== 1) {
            return null;
          }
          const [statement] = node.body.statements;
          if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
            return null;
          }
          return createExprSyntaxFromNode(
            statement.expression,
            sourceFile,
            nodeSpan(statement.expression, sourceFile, span),
          );
        }
        return createExprSyntaxFromNode(
          node.body,
          sourceFile,
          nodeSpan(node.body, sourceFile, span),
        );
      },
      returnedJsx() {
        return syntax.returnedExpr()?.asJsxElement() ?? null;
      },
      span,
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Expression);
      },
      thisMemberReferences() {
        return collectThisMemberReferences(node);
      },
      typeParameterCount() {
        return node.typeParameters?.length ?? 0;
      },
      unparenthesized() {
        return syntax;
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Expression,
  );
  return syntax;
}

function createClassFieldSyntaxFromNode(
  node: ts.PropertyDeclaration,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroClassFieldSyntax {
  return withHostNode(
    {
      explicitType() {
        return node.type
          ? createTypeSyntaxFromNode(
            node.type,
            sourceFile,
            nodeSpan(node.type, sourceFile, fallbackSpan),
          )
          : null;
      },
      hasExplicitType() {
        return node.type !== undefined;
      },
      hasModifier(name: MacroModifierName) {
        return hasModifier(node, name);
      },
      initializer() {
        return node.initializer
          ? createExprSyntaxFromNode(
            node.initializer,
            sourceFile,
            nodeSpan(node.initializer, sourceFile, fallbackSpan),
          )
          : null;
      },
      isOptional() {
        return node.questionToken !== undefined;
      },
      kind: 'class_member',
      memberKind: 'field',
      name: ts.isIdentifier(node.name) ? node.name.text : null,
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
      withInitializer(initializer: ExprSyntax | null) {
        return createClassFieldSyntaxFromNode(
          ts.factory.updatePropertyDeclaration(
            node,
            node.modifiers,
            node.name,
            node.questionToken ?? node.exclamationToken,
            node.type,
            initializer ? getHostExpression(initializer) : undefined,
          ),
          sourceFile,
          fallbackSpan,
        );
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createClassMethodSyntaxFromNode(
  node: ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroClassMethodSyntax {
  return withHostNode(
    {
      body() {
        return node.body
          ? createBlockSyntaxFromNode(
            node.body,
            sourceFile,
            nodeSpan(node.body, sourceFile, fallbackSpan),
          )
          : null;
      },
      hasModifier(name: MacroModifierName) {
        return hasModifier(node, name);
      },
      kind: 'class_member',
      memberKind: ts.isGetAccessorDeclaration(node)
        ? 'getter'
        : ts.isSetAccessorDeclaration(node)
        ? 'setter'
        : 'method',
      name: ts.isIdentifier(node.name) ? node.name.text : null,
      parameters: node.parameters.map((parameter) =>
        createParameterSyntaxFromNode(parameter, sourceFile, fallbackSpan)
      ),
      returnedExpr() {
        const returned = returnedExprNode(node);
        return returned
          ? createExprSyntaxFromNode(
            returned,
            sourceFile,
            nodeSpan(returned, sourceFile, fallbackSpan),
          )
          : null;
      },
      returnedJsx() {
        const jsx = returnedJsxNode(node);
        return jsx
          ? createJsxElementSyntaxFromNode(jsx, sourceFile, nodeSpan(jsx, sourceFile, fallbackSpan))
          : null;
      },
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
      withBody(body: BlockSyntax) {
        const hostBody = getHostBlock(body);
        const updated = ts.isGetAccessorDeclaration(node)
          ? ts.factory.updateGetAccessorDeclaration(
            node,
            node.modifiers,
            node.name,
            node.parameters,
            node.type,
            hostBody,
          )
          : ts.isSetAccessorDeclaration(node)
          ? ts.factory.updateSetAccessorDeclaration(
            node,
            node.modifiers,
            node.name,
            node.parameters,
            hostBody,
          )
          : ts.factory.updateMethodDeclaration(
            node,
            node.modifiers,
            node.asteriskToken,
            node.name,
            node.questionToken,
            node.typeParameters,
            node.parameters,
            node.type,
            hostBody,
          );
        return createClassMethodSyntaxFromNode(updated, sourceFile, fallbackSpan);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createClassConstructorSyntaxFromNode(
  node: ts.ConstructorDeclaration,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroClassConstructorSyntax {
  return withHostNode(
    {
      body() {
        return node.body
          ? createBlockSyntaxFromNode(
            node.body,
            sourceFile,
            nodeSpan(node.body, sourceFile, fallbackSpan),
          )
          : null;
      },
      hasModifier(name: MacroModifierName) {
        return hasModifier(node, name);
      },
      kind: 'class_member',
      memberKind: 'constructor',
      name: null,
      parameters: node.parameters.map((parameter) =>
        createParameterSyntaxFromNode(parameter, sourceFile, fallbackSpan)
      ),
      span: nodeSpan(node, sourceFile, fallbackSpan),
      text() {
        return printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
      withBody(body: BlockSyntax) {
        return createClassConstructorSyntaxFromNode(
          ts.factory.updateConstructorDeclaration(
            node,
            node.modifiers,
            node.parameters,
            getHostBlock(body),
          ),
          sourceFile,
          fallbackSpan,
        );
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

function createClassMemberSyntaxFromNode(
  node: ts.ClassElement,
  sourceFile: ts.SourceFile,
  fallbackSpan: SourceSpan,
): MacroAnyClassMemberSyntax | null {
  if (ts.isPropertyDeclaration(node)) {
    return createClassFieldSyntaxFromNode(node, sourceFile, fallbackSpan);
  }
  if (
    ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return createClassMethodSyntaxFromNode(node, sourceFile, fallbackSpan);
  }
  if (ts.isConstructorDeclaration(node)) {
    return createClassConstructorSyntaxFromNode(node, sourceFile, fallbackSpan);
  }
  return null;
}

export function createExprSyntaxFromNode(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
  text?: string,
): ExprSyntax {
  const unwrapped = unwrapParenthesizedExpressionNode(node);
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) {
    return createFunctionExprSyntaxFromNode(unwrapped, sourceFile, span);
  }
  return withHostNode(
    {
      asArrayLiteral() {
        return expressionAsArrayLiteral(node, sourceFile, span);
      },
      asBinary() {
        return expressionAsBinary(node, sourceFile, span);
      },
      asCall() {
        return expressionAsCall(node, sourceFile, span);
      },
      asConditional() {
        return expressionAsConditional(node, sourceFile, span);
      },
      asFunction() {
        return null;
      },
      asIdentifier() {
        return expressionAsIdentifier(node);
      },
      asInvocation() {
        return expressionAsInvocation(
          span.fileName,
          span,
          text ?? printHostNode(node, sourceFile, ts.EmitHint.Expression),
        );
      },
      asJsxElement() {
        return expressionAsJsxElement(node, sourceFile, span);
      },
      asJsxFragment() {
        return expressionAsJsxFragment(node, sourceFile, span);
      },
      asPropertyAccess() {
        return expressionAsPropertyAccess(node, sourceFile, span);
      },
      containsCallNamed(name: string) {
        return containsCallNamed(node, name);
      },
      isBooleanLiteral(value: boolean) {
        const current = unwrapParenthesizedExpressionNode(node);
        return value
          ? current.kind === ts.SyntaxKind.TrueKeyword
          : current.kind === ts.SyntaxKind.FalseKeyword;
      },
      isNullLiteral() {
        return unwrapParenthesizedExpressionNode(node).kind === ts.SyntaxKind.NullKeyword;
      },
      kind: 'expr',
      replaceThis(replacement: ExprSyntax) {
        return createExprSyntaxFromNode(
          replaceThisNode(node, replacement),
          sourceFile,
          span,
        );
      },
      rewrite(options: MacroSyntaxRewriteOptions) {
        return rewriteExprSyntax(node, sourceFile, span, options);
      },
      span,
      text() {
        return text ?? printHostNode(node, sourceFile, ts.EmitHint.Expression);
      },
      thisMemberReferences() {
        return collectThisMemberReferences(node);
      },
      unparenthesized() {
        return createExprSyntaxFromNode(unwrapParenthesizedExpressionNode(node), sourceFile, span);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Expression,
  );
}

export function createBareExprSyntax(
  span: SourceSpan,
  text: string,
): ExprSyntax {
  return {
    asArrayLiteral() {
      return null;
    },
    asBinary() {
      return null;
    },
    asCall() {
      return null;
    },
    asConditional() {
      return null;
    },
    asFunction() {
      return null;
    },
    asIdentifier() {
      return null;
    },
    asInvocation() {
      return expressionAsInvocation(span.fileName, span, text);
    },
    asJsxElement() {
      return null;
    },
    asJsxFragment() {
      return null;
    },
    asPropertyAccess() {
      return null;
    },
    containsCallNamed() {
      return false;
    },
    isBooleanLiteral() {
      return false;
    },
    isNullLiteral() {
      return false;
    },
    kind: 'expr',
    replaceThis() {
      return this;
    },
    rewrite() {
      return this;
    },
    span,
    text() {
      return text;
    },
    thisMemberReferences() {
      return [];
    },
    unparenthesized() {
      return this;
    },
  };
}

export function createArgumentSyntax(
  index: number,
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
  text: string,
): MacroArgumentView {
  return withHostNode(
    {
      asArrayLiteral() {
        return expressionAsArrayLiteral(node, sourceFile, span);
      },
      asBinary() {
        return expressionAsBinary(node, sourceFile, span);
      },
      asCall() {
        return expressionAsCall(node, sourceFile, span);
      },
      asConditional() {
        return expressionAsConditional(node, sourceFile, span);
      },
      asFunction() {
        const current = unwrapParenthesizedExpressionNode(node);
        return ts.isArrowFunction(current) || ts.isFunctionExpression(current)
          ? createFunctionExprSyntaxFromNode(current, sourceFile, span)
          : null;
      },
      asIdentifier() {
        return expressionAsIdentifier(node);
      },
      asInvocation() {
        return expressionAsInvocation(span.fileName, span, text);
      },
      asJsxElement() {
        return expressionAsJsxElement(node, sourceFile, span);
      },
      asJsxFragment() {
        return expressionAsJsxFragment(node, sourceFile, span);
      },
      asPropertyAccess() {
        return expressionAsPropertyAccess(node, sourceFile, span);
      },
      containsCallNamed(name: string) {
        return containsCallNamed(node, name);
      },
      index,
      isBooleanLiteral(value: boolean) {
        const current = unwrapParenthesizedExpressionNode(node);
        return value
          ? current.kind === ts.SyntaxKind.TrueKeyword
          : current.kind === ts.SyntaxKind.FalseKeyword;
      },
      isNullLiteral() {
        return unwrapParenthesizedExpressionNode(node).kind === ts.SyntaxKind.NullKeyword;
      },
      kind: 'expr',
      replaceThis(replacement: ExprSyntax) {
        return createExprSyntaxFromNode(
          replaceThisNode(node, replacement),
          sourceFile,
          span,
        );
      },
      rewrite(options: MacroSyntaxRewriteOptions) {
        return rewriteExprSyntax(node, sourceFile, span, options);
      },
      span,
      text() {
        return text;
      },
      thisMemberReferences() {
        return collectThisMemberReferences(node);
      },
      unparenthesized() {
        return createExprSyntaxFromNode(unwrapParenthesizedExpressionNode(node), sourceFile, span);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Expression,
  );
}

export function createBareArgumentSyntax(
  index: number,
  span: SourceSpan,
  text: string,
): MacroArgumentView {
  const expr = createBareExprSyntax(span, text);
  return {
    asArrayLiteral: expr.asArrayLiteral,
    asBinary: expr.asBinary,
    asCall: expr.asCall,
    asConditional: expr.asConditional,
    asFunction: expr.asFunction,
    asIdentifier: expr.asIdentifier,
    asInvocation: expr.asInvocation,
    asJsxElement: expr.asJsxElement,
    asJsxFragment: expr.asJsxFragment,
    asPropertyAccess: expr.asPropertyAccess,
    containsCallNamed: expr.containsCallNamed,
    index,
    isBooleanLiteral: expr.isBooleanLiteral,
    isNullLiteral: expr.isNullLiteral,
    kind: 'expr',
    replaceThis: expr.replaceThis,
    rewrite: expr.rewrite,
    span,
    text() {
      return text;
    },
    thisMemberReferences: expr.thisMemberReferences,
    unparenthesized: expr.unparenthesized,
  };
}

function parseHostExpressionWithNestedMacroFallback(
  fileName: string,
  text: string,
  message: string,
): ts.Expression {
  try {
    return parseHostExpression(fileName, text, message);
  } catch {
    return parseHostExpression(
      fileName,
      neutralizeNestedMacrosForHostParse(fileName, text),
      message,
    );
  }
}

export function createArgumentSyntaxFromText(
  index: number,
  fileName: string,
  span: SourceSpan,
  text: string,
): MacroArgumentView {
  try {
    const node = parseHostExpressionWithNestedMacroFallback(
      fileName,
      text,
      'Macro expression operands must parse as exactly one host-language expression.',
    );
    const sourceFile = setSourceFileOffset(
      node.getSourceFile(),
      span.start - node.getStart(node.getSourceFile(), false),
    );
    return createArgumentSyntax(index, node, sourceFile, span, text);
  } catch {
    return createBareArgumentSyntax(index, span, text);
  }
}

export function createStmtSyntaxFromNode(
  node: ts.Statement,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
  text?: string,
): StmtSyntax {
  return withHostNode(
    {
      kind: 'stmt',
      span,
      text() {
        return text ?? printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

export function createBlockSyntaxFromNode(
  node: ts.Block,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
  text?: string,
): BlockSyntax {
  return withHostNode(
    {
      containsCallNamed(name: string) {
        return containsCallNamed(node, name);
      },
      kind: 'block',
      replaceThis(replacement: ExprSyntax) {
        return createBlockSyntaxFromNode(
          replaceThisNode(node, replacement),
          sourceFile,
          span,
        );
      },
      rewrite(options: MacroSyntaxRewriteOptions) {
        return rewriteBlockSyntax(node, sourceFile, span, options);
      },
      span,
      statements: node.statements.map((statement) =>
        createStmtSyntaxFromNode(statement, sourceFile, span)
      ),
      text() {
        return text ?? printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
      },
      thisMemberReferences() {
        return collectThisMemberReferences(node);
      },
    },
    node,
    sourceFile,
    ts.EmitHint.Unspecified,
  );
}

export function buildBlockSyntax(
  fileName: string,
  statements: readonly StmtSyntax[],
): BlockSyntax {
  const sourceFile = createBuildSourceFile(fileName);
  const block = synthesizeHostNode(ts.factory.createBlock(
    statements.map((statement) => synthesizeHostNode(getHostStatement(statement))),
    true,
  ));
  return createBlockSyntaxFromNode(block, sourceFile, {
    fileName,
    start: 0,
    end: 0,
  });
}

export function buildIdentifierExprSyntax(fileName: string, name: string): ExprSyntax {
  return createBuiltExprSyntax(fileName, ts.factory.createIdentifier(name));
}

export function buildThisExprSyntax(fileName: string): ExprSyntax {
  return createBuiltExprSyntax(fileName, ts.factory.createThis());
}

export function buildStringLiteralExprSyntax(fileName: string, value: string): ExprSyntax {
  return createBuiltExprSyntax(fileName, ts.factory.createStringLiteral(value));
}

export function buildNumberLiteralExprSyntax(fileName: string, value: number): ExprSyntax {
  if (value < 0) {
    return createBuiltExprSyntax(
      fileName,
      ts.factory.createPrefixUnaryExpression(
        ts.SyntaxKind.MinusToken,
        ts.factory.createNumericLiteral(Math.abs(value)),
      ),
    );
  }
  return createBuiltExprSyntax(fileName, ts.factory.createNumericLiteral(value));
}

export function buildBooleanLiteralExprSyntax(fileName: string, value: boolean): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    value ? ts.factory.createTrue() : ts.factory.createFalse(),
  );
}

export function buildNullLiteralExprSyntax(fileName: string): ExprSyntax {
  return createBuiltExprSyntax(fileName, ts.factory.createNull());
}

export function buildPropertyAccessExprSyntax(
  fileName: string,
  object: ExprSyntax,
  name: string,
): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    ts.factory.createPropertyAccessExpression(getHostExpression(object), name),
  );
}

export function buildCallExprSyntax(
  fileName: string,
  callee: ExprSyntax,
  args: readonly ExprSyntax[],
): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    ts.factory.createCallExpression(
      getHostExpression(callee),
      undefined,
      args.map((arg) => getHostExpression(arg)),
    ),
  );
}

export function buildElementAccessExprSyntax(
  fileName: string,
  object: ExprSyntax,
  index: ExprSyntax,
): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    ts.factory.createElementAccessExpression(
      getHostExpression(object),
      getHostExpression(index),
    ),
  );
}

export function buildNewExprSyntax(
  fileName: string,
  callee: ExprSyntax,
  args: readonly ExprSyntax[],
): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    ts.factory.createNewExpression(
      getHostExpression(callee),
      undefined,
      args.map((arg) => getHostExpression(arg)),
    ),
  );
}

export function buildBinaryExprSyntax(
  fileName: string,
  left: ExprSyntax,
  operator: MacroBinaryOperator,
  right: ExprSyntax,
): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    ts.factory.createBinaryExpression(
      getHostExpression(left),
      createBinaryOperatorToken(operator),
      getHostExpression(right),
    ),
  );
}

export function buildAssignmentExprSyntax(
  fileName: string,
  target: ExprSyntax,
  value: ExprSyntax,
): ExprSyntax {
  return buildBinaryExprSyntax(fileName, target, '=', value);
}

export function buildUnaryExprSyntax(
  fileName: string,
  operator: MacroUnaryOperator,
  value: ExprSyntax,
): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    ts.factory.createPrefixUnaryExpression(
      createUnaryOperatorToken(operator),
      getHostExpression(value),
    ),
  );
}

export function buildArrowFunctionExprSyntax(
  fileName: string,
  parameters: readonly (string | MacroParameterBuildOptions)[],
  body: BlockSyntax | ExprSyntax,
): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    ts.factory.createArrowFunction(
      undefined,
      undefined,
      createParameterDeclarations(fileName, parameters),
      undefined,
      ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      body.kind === 'block' ? cloneBlockNode(body) : getHostExpression(body),
    ),
  );
}

export function buildObjectLiteralExprSyntax(
  fileName: string,
  members: readonly MacroObjectMemberBuildOptions[],
): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    ts.factory.createObjectLiteralExpression(
      members.map((member): ts.ObjectLiteralElementLike => {
        if (member.kind === 'property') {
          return ts.factory.createPropertyAssignment(member.name, getHostExpression(member.value));
        }
        return ts.factory.createMethodDeclaration(
          undefined,
          undefined,
          member.name,
          undefined,
          undefined,
          createParameterDeclarations(fileName, member.parameters),
          member.returnType ? createTypeNodeFromText(fileName, member.returnType) : undefined,
          cloneBlockNode(member.body),
        );
      }),
      true,
    ),
  );
}

export function buildOptionalMethodCallExprSyntax(
  fileName: string,
  receiver: ExprSyntax,
  name: string,
  args: readonly ExprSyntax[],
): ExprSyntax {
  return createBuiltExprSyntax(
    fileName,
    ts.factory.createCallChain(
      ts.factory.createPropertyAccessChain(
        getHostExpression(receiver),
        ts.factory.createToken(ts.SyntaxKind.QuestionDotToken),
        name,
      ),
      undefined,
      undefined,
      args.map((arg) => getHostExpression(arg)),
    ),
  );
}

export function buildExprStmtSyntax(
  fileName: string,
  expression: ExprSyntax,
): StmtSyntax {
  return createBuiltStmtSyntax(
    fileName,
    ts.factory.createExpressionStatement(getHostExpression(expression)),
  );
}

export function buildConstDeclStmtSyntax(
  fileName: string,
  name: string,
  initializer: ExprSyntax,
): StmtSyntax {
  return createBuiltStmtSyntax(
    fileName,
    ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [ts.factory.createVariableDeclaration(
          name,
          undefined,
          undefined,
          getHostExpression(initializer),
        )],
        ts.NodeFlags.Const,
      ),
    ),
  );
}

export function buildLetDeclStmtSyntax(
  fileName: string,
  name: string,
  initializer: ExprSyntax,
): StmtSyntax {
  return createBuiltStmtSyntax(
    fileName,
    ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [ts.factory.createVariableDeclaration(
          name,
          undefined,
          undefined,
          getHostExpression(initializer),
        )],
        ts.NodeFlags.Let,
      ),
    ),
  );
}

export function buildReturnStmtSyntax(
  fileName: string,
  expression?: ExprSyntax,
): StmtSyntax {
  return createBuiltStmtSyntax(
    fileName,
    ts.factory.createReturnStatement(expression ? getHostExpression(expression) : undefined),
  );
}

export function buildIfStmtSyntax(
  fileName: string,
  options: MacroIfBuildOptions,
): StmtSyntax {
  return createBuiltStmtSyntax(
    fileName,
    ts.factory.createIfStatement(
      getHostExpression(options.condition),
      getHostBlock(buildBlockSyntax(fileName, options.thenStatements)),
      options.elseStatements
        ? getHostBlock(buildBlockSyntax(fileName, options.elseStatements))
        : undefined,
    ),
  );
}

function createForInitializer(
  initializer: ExprSyntax | {
    readonly kind: 'const' | 'let';
    readonly name: string;
    readonly value: ExprSyntax;
  } | undefined,
): ts.ForInitializer | undefined {
  if (!initializer) {
    return undefined;
  }
  if (
    typeof initializer === 'object' &&
    'kind' in initializer &&
    (initializer.kind === 'const' || initializer.kind === 'let')
  ) {
    const flags = initializer.kind === 'const' ? ts.NodeFlags.Const : ts.NodeFlags.Let;
    return ts.factory.createVariableDeclarationList(
      [ts.factory.createVariableDeclaration(
        initializer.name,
        undefined,
        undefined,
        getHostExpression(initializer.value),
      )],
      flags,
    );
  }
  return getHostExpression(initializer as ExprSyntax);
}

export function buildForStmtSyntax(
  fileName: string,
  options: MacroForBuildOptions,
): StmtSyntax {
  return createBuiltStmtSyntax(
    fileName,
    ts.factory.createForStatement(
      createForInitializer(options.initializer),
      options.condition ? getHostExpression(options.condition) : undefined,
      options.increment ? getHostExpression(options.increment) : undefined,
      getHostBlock(buildBlockSyntax(fileName, options.statements)),
    ),
  );
}

export function buildThrowStmtSyntax(
  fileName: string,
  expression: ExprSyntax,
): StmtSyntax {
  return createBuiltStmtSyntax(
    fileName,
    ts.factory.createThrowStatement(getHostExpression(expression)),
  );
}

export function createDeclSyntaxFromNode(
  node:
    | ts.ClassDeclaration
    | ts.FunctionDeclaration
    | ts.InterfaceDeclaration
    | ts.TypeAliasDeclaration,
  sourceFile: ts.SourceFile,
  span: SourceSpan,
  text?: string,
): DeclSyntax {
  if (ts.isClassDeclaration(node)) {
    const members = () =>
      node.members.flatMap((member) => {
        const wrapped = createClassMemberSyntaxFromNode(member, sourceFile, span);
        return wrapped ? [wrapped] : [];
      });
    const syntax: MacroClassDeclSyntax = withHostNode(
      {
        asClass() {
          return syntax;
        },
        asFunction() {
          return null;
        },
        asInterface() {
          return null;
        },
        asTypeAlias() {
          return null;
        },
        declarationKind: 'class',
        hasModifier(name: MacroModifierName) {
          return hasModifier(node, name);
        },
        kind: 'decl',
        member(name: string) {
          return members().find((member) => member.name === name) ?? null;
        },
        members,
        name: node.name?.text ?? null,
        resolveThisDependencies(
          target: ExprSyntax | BlockSyntax,
          rootMemberNames: readonly string[],
        ) {
          return resolveThisDependenciesForClass(node, rootMemberNames, target);
        },
        span,
        text() {
          return text ?? printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
        },
      },
      node,
      sourceFile,
      ts.EmitHint.Unspecified,
    );
    return syntax;
  }

  if (ts.isFunctionDeclaration(node)) {
    const syntax: MacroFunctionDeclSyntax = withHostNode(
      {
        asClass() {
          return null;
        },
        asFunction() {
          return syntax;
        },
        asInterface() {
          return null;
        },
        asTypeAlias() {
          return null;
        },
        body() {
          return node.body
            ? createBlockSyntaxFromNode(
              node.body,
              sourceFile,
              nodeSpan(node.body, sourceFile, span),
            )
            : null;
        },
        declarationKind: 'function',
        hasModifier(name: MacroModifierName) {
          return hasModifier(node, name);
        },
        kind: 'decl',
        name: node.name?.text ?? null,
        parameters: node.parameters.map((parameter) =>
          createParameterSyntaxFromNode(parameter, sourceFile, span)
        ),
        returnedExpr() {
          const returned = returnedExprNode(node);
          return returned
            ? createExprSyntaxFromNode(
              returned,
              sourceFile,
              nodeSpan(returned, sourceFile, span),
            )
            : null;
        },
        returnedJsx() {
          const jsx = returnedJsxNode(node);
          return jsx
            ? createJsxElementSyntaxFromNode(jsx, sourceFile, nodeSpan(jsx, sourceFile, span))
            : null;
        },
        span,
        text() {
          return text ?? printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
        },
      },
      node,
      sourceFile,
      ts.EmitHint.Unspecified,
    );
    return syntax;
  }

  if (ts.isInterfaceDeclaration(node)) {
    const members = node.members.map((member) =>
      createObjectTypeMemberSyntaxFromNode(member, sourceFile, nodeSpan(member, sourceFile, span))
    );
    const typeParameters = node.typeParameters?.map((parameter) =>
      createTypeParameterSyntaxFromNode(
        parameter,
        sourceFile,
        nodeSpan(parameter, sourceFile, span),
      )
    ) ?? [];
    const extendsTypes = node.heritageClauses
      ?.filter((clause) =>
        clause.token === ts.SyntaxKind.ExtendsKeyword
      )
      .flatMap((clause) =>
        clause.types.map((type) =>
          createTypeSyntaxFromText(
            sourceFile.fileName,
            nodeSpan(type, sourceFile, span),
            printHostNode(type, sourceFile, ts.EmitHint.Unspecified),
          )
        )
      ) ?? [];
    const syntax: MacroInterfaceDeclSyntax = withHostNode(
      {
        asClass() {
          return null;
        },
        asFunction() {
          return null;
        },
        asInterface() {
          return syntax;
        },
        asTypeAlias() {
          return null;
        },
        declarationKind: 'interface',
        extendsTypes,
        hasModifier(name: MacroModifierName) {
          return hasModifier(node, name);
        },
        kind: 'decl',
        members,
        name: node.name.text,
        span,
        text() {
          return text ?? printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
        },
        typeParameters,
      },
      node,
      sourceFile,
      ts.EmitHint.Unspecified,
    );
    return syntax;
  }

  if (ts.isTypeAliasDeclaration(node)) {
    const typeParameters = node.typeParameters?.map((parameter) =>
      createTypeParameterSyntaxFromNode(
        parameter,
        sourceFile,
        nodeSpan(parameter, sourceFile, span),
      )
    ) ?? [];
    const syntax: MacroTypeAliasDeclSyntax = withHostNode(
      {
        asClass() {
          return null;
        },
        asFunction() {
          return null;
        },
        asInterface() {
          return null;
        },
        asTypeAlias() {
          return syntax;
        },
        declarationKind: 'typeAlias',
        hasModifier(name: MacroModifierName) {
          return hasModifier(node, name);
        },
        kind: 'decl',
        name: node.name.text,
        span,
        text() {
          return text ?? printHostNode(node, sourceFile, ts.EmitHint.Unspecified);
        },
        type: createTypeSyntaxFromNode(
          node.type,
          sourceFile,
          nodeSpan(node.type, sourceFile, span),
        ),
        typeParameters,
      },
      node,
      sourceFile,
      ts.EmitHint.Unspecified,
    );
    return syntax;
  }

  throw new Error('Expected a declaration-backed syntax node.');
}

export function createInvocationSyntax(options: {
  readonly args: readonly MacroArgumentView[];
  readonly block: BlockSyntax | null;
  readonly declaration: DeclSyntax | null;
  readonly form: MacroInvocationForm;
  readonly hasBlock: boolean;
  readonly name: string;
  readonly span: SourceSpan;
  readonly text: string;
}): InvocationSyntax {
  return {
    args: options.args,
    block: options.block,
    declaration: options.declaration,
    form: options.form,
    hasBlock: options.hasBlock,
    kind: 'invocation',
    name: options.name,
    span: options.span,
    text() {
      return options.text;
    },
  };
}

function expressionAsInvocation(
  fileName: string,
  span: SourceSpan,
  text: string,
): InvocationSyntax | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('#')) {
    return null;
  }

  const leadingWhitespace = text.length - text.trimStart().length;
  const parsed = parseMacroInvocationAt(fileName, text, leadingWhitespace);
  if ('reason' in parsed || parsed.span.end !== text.length) {
    return null;
  }

  const args = parsed.argumentSpans
    .filter((argument) => argument.kind === 'ExprArg')
    .map((argument, index) =>
      createArgumentSyntaxFromText(
        index,
        fileName,
        offsetSpan(span, argument.span),
        text.slice(argument.span.start, argument.span.end),
      )
    );
  const block = parsed.trailingBlockSpan
    ? createBlockSyntaxFromText(
      fileName,
      offsetSpan(span, parsed.trailingBlockSpan),
      text.slice(parsed.trailingBlockSpan.start, parsed.trailingBlockSpan.end),
    )
    : parsed.invocationKind === 'block' && parsed.argumentSpans[0]?.kind === 'BlockArg'
    ? createBlockSyntaxFromText(
      fileName,
      offsetSpan(span, parsed.argumentSpans[0].span),
      text.slice(parsed.argumentSpans[0].span.start, parsed.argumentSpans[0].span.end),
    )
    : null;
  const declaration = parsed.declarationSpan
    ? createDeclSyntaxFromText(
      fileName,
      offsetSpan(span, parsed.declarationSpan),
      text.slice(parsed.declarationSpan.start, parsed.declarationSpan.end),
    )
    : null;

  return createInvocationSyntax({
    args,
    block,
    declaration,
    form: parsed.invocationKind === 'decl'
      ? 'decl'
      : parsed.invocationKind === 'arglist+decl'
      ? 'arglist_decl'
      : parsed.invocationKind === 'block'
      ? 'block'
      : 'arglist',
    hasBlock: block !== null,
    name: parsed.nameText,
    span,
    text,
  });
}

export function createClassMemberSyntaxListFromCode(
  fileName: string,
  code: string,
): readonly MacroAnyClassMemberSyntax[] {
  const sourceFile = ts.createSourceFile(
    fileName.endsWith('.tsx') || fileName.endsWith('.jsx') || fileName.endsWith('.sts')
      ? fileName
      : `${fileName}.tsx`,
    `class __SoundscriptQuotedMembers {${code}}`,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForHostFile(fileName),
  );
  ensureNoParseDiagnostics(sourceFile, '// #[component] generated invalid class members.');
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isClassDeclaration(statement)) {
    throw new Error('// #[component] generated invalid class members.');
  }
  return statement.members.flatMap((member) => {
    const wrapped = createClassMemberSyntaxFromNode(
      synthesizeHostNode(member),
      sourceFile,
      {
        fileName,
        start: 0,
        end: code.length,
      },
    );
    return wrapped ? [wrapped] : [];
  });
}

export function createTemplateSyntaxFromPieces(
  span: SourceSpan,
  text: string,
  quasis: readonly MacroTemplateQuasi[],
  expressions: readonly ExprSyntax[],
): MacroTemplateOperand {
  return {
    expressions,
    kind: 'template',
    quasis,
    span,
    text() {
      return text;
    },
  };
}

export function createExprSyntaxFromText(
  fileName: string,
  span: SourceSpan,
  text: string,
): ExprSyntax {
  const node = parseHostExpressionWithNestedMacroFallback(
    fileName,
    text,
    'Macro expression operands must parse as exactly one host-language expression.',
  );
  const parsedSourceFile = node.getSourceFile?.() ?? ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const sourceFile = setSourceFileOffset(
    parsedSourceFile,
    span.start - node.getStart(parsedSourceFile, false),
  );
  return createExprSyntaxFromNode(node, sourceFile, span, text);
}

export function createBlockSyntaxFromText(
  fileName: string,
  span: SourceSpan,
  text: string,
): BlockSyntax {
  try {
    const statement = parseSingleHostStatement(
      fileName,
      'macro_block_operand',
      text,
      'Macro block operands must parse as exactly one host-language block statement.',
    );
    if (!ts.isBlock(statement)) {
      throw new Error(
        'Macro block operands must parse as exactly one host-language block statement.',
      );
    }
    const sourceFile = setSourceFileOffset(
      statement.getSourceFile(),
      span.start - statement.getStart(statement.getSourceFile(), false),
    );
    return createBlockSyntaxFromNode(statement, sourceFile, span, text);
  } catch {
    try {
      const statement = parseSingleHostStatement(
        fileName,
        'macro_block_operand',
        neutralizeNestedMacrosForHostParse(fileName, text),
        'Macro block operands must parse as exactly one host-language block statement.',
      );
      if (!ts.isBlock(statement)) {
        throw new Error(
          'Macro block operands must parse as exactly one host-language block statement.',
        );
      }
      const sourceFile = setSourceFileOffset(
        statement.getSourceFile(),
        span.start - statement.getStart(statement.getSourceFile(), false),
      );
      return createBlockSyntaxFromNode(statement, sourceFile, span, text);
    } catch {
      return {
        containsCallNamed() {
          return false;
        },
        kind: 'block',
        replaceThis() {
          return this;
        },
        rewrite() {
          return this;
        },
        span,
        statements: [],
        text() {
          return text;
        },
        thisMemberReferences() {
          return [];
        },
      };
    }
  }
}

export function createDeclSyntaxFromText(
  fileName: string,
  span: SourceSpan,
  text: string,
): DeclSyntax {
  const parseText = (() => {
    try {
      const sourceFile = ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.Latest,
        true,
        scriptKindForHostFile(fileName),
      );
      ensureNoParseDiagnostics(
        sourceFile,
        'Macro declaration operands must parse as exactly one class, function, interface, or type alias declaration.',
      );
      return { sourceFile, statement: sourceFile.statements[0] };
    } catch {
      const neutralized = neutralizeNestedMacrosForHostParse(fileName, text);
      const sourceFile = ts.createSourceFile(
        fileName,
        neutralized,
        ts.ScriptTarget.Latest,
        true,
        scriptKindForHostFile(fileName),
      );
      ensureNoParseDiagnostics(
        sourceFile,
        'Macro declaration operands must parse as exactly one class, function, interface, or type alias declaration.',
      );
      return { sourceFile, statement: sourceFile.statements[0] };
    }
  })();

  const statement = parseText.statement;
  if (
    !ts.isClassDeclaration(statement) && !ts.isFunctionDeclaration(statement) &&
    !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)
  ) {
    throw new Error(
      'Macro declaration operands must parse as exactly one class, function, interface, or type alias declaration.',
    );
  }
  return createDeclSyntaxFromNode(
    statement,
    setSourceFileOffset(
      parseText.sourceFile,
      span.start - statement.getStart(parseText.sourceFile, false),
    ),
    span,
    text,
  );
}

export function createStmtListSyntaxFromCode(
  fileName: string,
  suffix: string,
  code: string,
): readonly StmtSyntax[] {
  const statements = parseHostStatements(
    fileName,
    suffix,
    code,
    'Quoted macro statements must parse as host-language statements.',
  );
  const sourceFile = statements[0]?.getSourceFile() ??
    ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return statements.map((statement) =>
    createStmtSyntaxFromNode(statement, sourceFile, {
      fileName,
      start: 0,
      end: code.length,
    })
  );
}

export function updateClassSyntax(
  base: MacroClassDeclSyntax,
  members: readonly MacroAnyClassMemberSyntax[],
): MacroClassDeclSyntax {
  const hostClassDecl = getHostNode(base);
  if (!hostClassDecl || !ts.isClassDeclaration(hostClassDecl)) {
    throw new Error('Expected a class declaration-backed syntax node.');
  }

  const updatedClass = synthesizeHostNode(ts.factory.updateClassDeclaration(
    hostClassDecl,
    hostClassDecl.modifiers,
    hostClassDecl.name,
    hostClassDecl.typeParameters,
    hostClassDecl.heritageClauses,
    members.map((member) => synthesizeHostNode(getHostNode(member) as ts.ClassElement)),
  ));
  return createDeclSyntaxFromNode(
    updatedClass,
    hostClassDecl.getSourceFile(),
    base.span,
  ).asClass()!;
}

export function buildClassFieldSyntax(
  fileName: string,
  options: MacroFieldBuildOptions,
): MacroClassFieldSyntax {
  const sourceFile = createBuildSourceFile(fileName);
  const initializer = options.initializer ? getHostExpression(options.initializer) : undefined;
  const field = synthesizeHostNode(ts.factory.createPropertyDeclaration(
    createModifierNodes(options.modifiers),
    options.name,
    undefined,
    options.type ? createTypeNodeFromText(fileName, options.type) : undefined,
    initializer,
  ));
  return createClassFieldSyntaxFromNode(field, sourceFile, {
    fileName,
    start: 0,
    end: 0,
  });
}

export function buildClassGetterSyntax(
  fileName: string,
  options: Omit<MacroMethodBuildOptions, 'parameters'>,
): MacroClassMethodSyntax {
  const sourceFile = createBuildSourceFile(fileName);
  const getter = synthesizeHostNode(ts.factory.createGetAccessorDeclaration(
    createModifierNodes(options.modifiers),
    options.name,
    [],
    undefined,
    cloneBlockNode(options.body),
  ));
  return createClassMethodSyntaxFromNode(getter, sourceFile, {
    fileName,
    start: 0,
    end: 0,
  });
}

export function buildClassSetterSyntax(
  fileName: string,
  options: MacroSetterBuildOptions,
): MacroClassMethodSyntax {
  const sourceFile = createBuildSourceFile(fileName);
  const parameter = typeof options.parameter === 'string'
    ? { name: options.parameter }
    : options.parameter;
  const setter = synthesizeHostNode(ts.factory.createSetAccessorDeclaration(
    createModifierNodes(options.modifiers),
    options.name,
    [
      synthesizeHostNode(ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        parameter.name,
        undefined,
        parameter.type ? createTypeNodeFromText(fileName, parameter.type) : undefined,
        undefined,
      )),
    ],
    cloneBlockNode(options.body),
  ));
  return createClassMethodSyntaxFromNode(setter, sourceFile, {
    fileName,
    start: 0,
    end: 0,
  });
}

export function buildClassMethodSyntax(
  fileName: string,
  options: MacroMethodBuildOptions,
): MacroClassMethodSyntax {
  const sourceFile = createBuildSourceFile(fileName);
  const method = synthesizeHostNode(ts.factory.createMethodDeclaration(
    createModifierNodes(options.modifiers),
    undefined,
    options.name,
    undefined,
    undefined,
    createParameterDeclarations(fileName, options.parameters),
    options.returnType ? createTypeNodeFromText(fileName, options.returnType) : undefined,
    cloneBlockNode(options.body),
  ));
  return createClassMethodSyntaxFromNode(method, sourceFile, {
    fileName,
    start: 0,
    end: 0,
  });
}

export function buildFunctionDeclSyntax(
  fileName: string,
  options: MacroFunctionBuildOptions,
): MacroFunctionDeclSyntax {
  const sourceFile = createBuildSourceFile(fileName);
  const declaration = synthesizeHostNode(ts.factory.createFunctionDeclaration(
    createModifierNodes(options.modifiers),
    undefined,
    options.name,
    undefined,
    createParameterDeclarations(fileName, options.parameters),
    options.returnType ? createTypeNodeFromText(fileName, options.returnType) : undefined,
    cloneBlockNode(options.body),
  ));
  return createDeclSyntaxFromNode(declaration, sourceFile, {
    fileName,
    start: 0,
    end: 0,
  }).asFunction()!;
}

export function syntaxText(node: MacroSyntaxNode): string {
  if ('text' in node && typeof node.text === 'function') {
    return node.text();
  }
  return fallbackText(node);
}

export function quoteText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => quoteText(entry)).join('\n');
  }
  if (value && typeof value === 'object' && 'kind' in value) {
    return syntaxText(value as MacroSyntaxNode);
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  throw new Error(`Unsupported macro quote interpolation value: ${String(value)}`);
}

function neutralizeNestedMacrosForHostParse(fileName: string, text: string): string {
  const hashes = scanMacroCandidates(fileName, text).hashes
    .filter((hash) => hash.kind === 'macro-start')
    .sort((left, right) => right.span.start - left.span.start);
  if (hashes.length === 0) {
    return text;
  }

  let rewritten = text;
  for (const hash of hashes) {
    const parsed = parseMacroInvocationAt(fileName, rewritten, hash.span.start);
    if ('reason' in parsed) {
      continue;
    }

    const args = parsed.argumentSpans
      .filter((argument) => argument.kind === 'ExprArg')
      .map((argument) => rewritten.slice(argument.span.start, argument.span.end));
    const block = parsed.trailingBlockSpan
      ? rewritten.slice(parsed.trailingBlockSpan.start, parsed.trailingBlockSpan.end)
      : (
          parsed.invocationKind === 'block' &&
          parsed.argumentSpans[0]?.kind === 'BlockArg'
        )
      ? rewritten.slice(parsed.argumentSpans[0].span.start, parsed.argumentSpans[0].span.end)
      : null;

    let replacement = `__sts_macro_${parsed.nameText}`;
    switch (parsed.invocationKind) {
      case 'arglist':
        replacement += `(${args.join(', ')})`;
        break;
      case 'block':
        replacement += `(() => ${block ?? '{}'})`;
        break;
      case 'arglist+block':
        replacement += `(${[...args, `() => ${block ?? '{}'}`].join(', ')})`;
        break;
      case 'decl':
      case 'arglist+decl':
        replacement = 'undefined';
        break;
    }

    rewritten = rewritten.slice(0, parsed.span.start) + replacement +
      rewritten.slice(parsed.span.end);
  }

  return rewritten;
}
