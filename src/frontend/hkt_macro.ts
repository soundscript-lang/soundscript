import ts from 'typescript';

import { fromFileUrl } from '../platform/path.ts';
import { STS_HKT_MODULE_SPECIFIER } from '../soundscript_runtime_specifiers.ts';
import type { MacroDefinition } from './macro_api.ts';
import { macroSignature } from './macro_api.ts';
import { attachMacroFactoryMetadata } from './macro_api_internal.ts';
import {
  createDeclSyntaxFromText,
  createExprSyntaxFromText,
  getHostDeclaration,
  getHostExpression,
} from './macro_syntax_internal.ts';

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const DO_BIND_HELPER_PROPERTY = 'macroBind';
const DO_HELPER_PROPERTY = 'macroGen';
const HKT_MODULE_SPECIFIER = STS_HKT_MODULE_SPECIFIER;
const HKT_MACRO_FILE_NAME = fromFileUrl(import.meta.url);
const HKT_DECL_SIGNATURE = macroSignature.of(macroSignature.interfaceDecl('target'));
const DO_SIGNATURE = macroSignature.of(
  macroSignature.expr('monad'),
  macroSignature.functionExpr('body'),
);

function attachHktFactory<T extends () => MacroDefinition>(factory: T, form: 'call' | 'decl'): T {
  return attachMacroFactoryMetadata(factory, { form, moduleFileName: HKT_MACRO_FILE_NAME }) as T;
}

function printNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

function indent(text: string, prefix = '  '): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function createTypeSlot(index: number): ts.TypeNode {
  return ts.factory.createIndexedAccessTypeNode(
    ts.factory.createIndexedAccessTypeNode(
      ts.factory.createThisTypeNode(),
      ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral('Args')),
    ),
    ts.factory.createLiteralTypeNode(ts.factory.createNumericLiteral(index)),
  );
}

function rewriteHktMemberType(
  node: ts.TypeNode,
  typeParameters: ReadonlyMap<string, number>,
): ts.TypeNode {
  const transformed = ts.transform(node, [(
    context: ts.TransformationContext,
  ) =>
  (root: ts.Node) =>
    ts.visitNode(root, function visit(current): ts.VisitResult<ts.Node> {
      if (
        ts.isTypeReferenceNode(current) &&
        current.typeArguments === undefined &&
        ts.isIdentifier(current.typeName)
      ) {
        const index = typeParameters.get(current.typeName.text);
        if (index !== undefined) {
          return createTypeSlot(index);
        }
      }
      return ts.visitEachChild(current, visit, context);
    })]);
  try {
    const [rewritten] = transformed.transformed;
    if (!rewritten || !ts.isTypeNode(rewritten)) {
      throw new Error('Expected HKT member type rewrite to produce a type node.');
    }
    return rewritten;
  } finally {
    transformed.dispose();
  }
}

function hasReadonlyModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
}

function modifierText(
  modifiers: readonly ts.ModifierLike[] | undefined,
  sourceFile: ts.SourceFile,
): string {
  const printed = modifiers
    ?.filter((modifier): modifier is ts.Modifier => !ts.isDecorator(modifier))
    .map((modifier) => printNode(modifier, sourceFile))
    .join(' ') ?? '';
  return printed.length > 0 ? `${printed} ` : '';
}

function bindingIdentifiers(name: ts.BindingName): readonly ts.Identifier[] {
  if (ts.isIdentifier(name)) {
    return [name];
  }

  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name)
  );
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isArrowFunction(parent) &&
      parent.parameters.some((parameter) => parameter.name === node)) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node)
  );
}

function isIgnoredValueName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node)
  );
}

function assertNoBindInNestedFunction(
  node: ts.SignatureDeclaration,
  bindName: string,
  error: (message: string) => never,
) {
  const found = ts.forEachChild(node, function visit(current): true | undefined {
    if (ts.isTypeNode(current)) {
      return undefined;
    }
    if (ts.isIdentifier(current) && current.text === bindName && !isIgnoredValueName(current)) {
      return true;
    }
    return ts.forEachChild(current, visit);
  });

  if (found) {
    error(`Do does not allow \`${bindName}\` inside nested functions.`);
  }
}

function assertNoBindShadowing(
  name: ts.BindingName,
  bindName: string,
  error: (message: string) => never,
) {
  for (const identifier of bindingIdentifiers(name)) {
    if (identifier.text === bindName) {
      error(`Do does not allow rebinding \`${bindName}\` inside the callback body.`);
    }
  }
}

function isNestedLabel(node: ts.LabeledStatement): boolean {
  return ts.isLabeledStatement(node.parent) && node.parent.statement === node;
}

function collectLabelChain(node: ts.LabeledStatement): {
  labels: readonly string[];
  statement: ts.Statement;
} {
  const labels: string[] = [node.label.text];
  let statement = node.statement;

  while (ts.isLabeledStatement(statement)) {
    labels.push(statement.label.text);
    statement = statement.statement;
  }

  return { labels, statement };
}

function createThrowTypeError(message: string): ts.Expression {
  return ts.factory.createCallExpression(
    ts.factory.createParenthesizedExpression(
      ts.factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        ts.factory.createBlock(
          [
            ts.factory.createThrowStatement(
              ts.factory.createNewExpression(
                ts.factory.createIdentifier('TypeError'),
                undefined,
                [ts.factory.createStringLiteral(message)],
              ),
            ),
          ],
          true,
        ),
      ),
    ),
    undefined,
    [],
  );
}

function createAsyncIteratorValueStatement(
  initializer: ts.ForInitializer,
  stepValue: ts.Expression,
  bindName: string,
  error: (message: string) => never,
): ts.Statement {
  if (ts.isVariableDeclarationList(initializer)) {
    if ((initializer.flags & ts.NodeFlags.BlockScoped) === 0) {
      error('Do only supports `const` and `let` declarations inside the callback body.');
    }
    if (initializer.declarations.length !== 1) {
      error('Do requires `for await...of` declarations to bind exactly one value.');
    }
    const [declaration] = initializer.declarations;
    if (!declaration) {
      error('Do requires `for await...of` declarations to bind exactly one value.');
    }
    if (declaration.initializer) {
      error('Do does not support initializers in `for await...of` declarations.');
    }
    assertNoBindShadowing(declaration.name, bindName, error);
    return ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            declaration.name,
            undefined,
            declaration.type,
            stepValue,
          ),
        ],
        initializer.flags,
      ),
    );
  }

  return ts.factory.createExpressionStatement(
    ts.factory.createBinaryExpression(
      initializer,
      ts.factory.createToken(ts.SyntaxKind.EqualsToken),
      stepValue,
    ),
  );
}

function lowerForAwaitStatement(
  loop: ts.ForOfStatement,
  labels: readonly string[],
  bindName: string,
  monadBindingName: string,
  bindHelperName: string,
  allocateBindTempName: () => string,
  allocateAsyncName: (kind: string) => string,
  visit: (node: ts.Node) => ts.VisitResult<ts.Node>,
  allowAwait: boolean,
  error: (message: string) => never,
): ts.Statement {
  if (!allowAwait) {
    error('Do only supports `for await...of` inside async callbacks.');
  }
  if (
    ts.isVariableDeclarationList(loop.initializer) &&
    (loop.initializer.flags & ts.NodeFlags.BlockScoped) === 0
  ) {
    error('Do only supports `const` and `let` declarations inside the callback body.');
  }

  const iterableName = allocateAsyncName('iterable');
  const iteratorMethodName = allocateAsyncName('iterator_method');
  const iteratorName = allocateAsyncName('iterator');
  const doneName = allocateAsyncName('done');
  const stepName = allocateAsyncName('step');
  const bindTempName = allocateBindTempName();
  const iteratorCloseTempName = allocateBindTempName();

  const iterableExpression = ts.visitNode(loop.expression, visit) as ts.Expression;
  const bodyStatement = ts.visitNode(loop.statement, visit) as ts.Statement;
  const bodyStatements = ts.isBlock(bodyStatement)
    ? [...bodyStatement.statements]
    : [bodyStatement];

  const stepValueExpression = ts.factory.createPropertyAccessExpression(
    ts.factory.createIdentifier(stepName),
    'value',
  );
  const stepBindingStatement = ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          stepName,
          undefined,
          undefined,
          ts.factory.createCallExpression(
            ts.factory.createIdentifier(bindHelperName),
            undefined,
            [
              ts.factory.createBinaryExpression(
                ts.factory.createIdentifier(bindTempName),
                ts.factory.createToken(ts.SyntaxKind.EqualsToken),
                ts.factory.createCallExpression(
                  ts.factory.createPropertyAccessExpression(
                    ts.factory.createIdentifier(monadBindingName),
                    'fromPromise',
                  ),
                  undefined,
                  [
                    ts.factory.createCallExpression(
                      ts.factory.createPropertyAccessExpression(
                        ts.factory.createIdentifier(iteratorName),
                        'next',
                      ),
                      undefined,
                      [],
                    ),
                  ],
                ),
              ),
              ts.factory.createYieldExpression(
                undefined,
                ts.factory.createIdentifier(bindTempName),
              ),
            ],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );

  const loopStatements: ts.Statement[] = [
    stepBindingStatement,
    ts.factory.createIfStatement(
      ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier(stepName),
        'done',
      ),
      ts.factory.createBlock(
        [
          ts.factory.createExpressionStatement(
            ts.factory.createBinaryExpression(
              ts.factory.createIdentifier(doneName),
              ts.factory.createToken(ts.SyntaxKind.EqualsToken),
              ts.factory.createTrue(),
            ),
          ),
          ts.factory.createBreakStatement(),
        ],
        true,
      ),
    ),
    createAsyncIteratorValueStatement(
      loop.initializer,
      stepValueExpression,
      bindName,
      error,
    ),
    ...bodyStatements,
  ];

  let loopStatement: ts.Statement = ts.factory.createWhileStatement(
    ts.factory.createTrue(),
    ts.factory.createBlock(loopStatements, true),
  );
  for (const label of [...labels].reverse()) {
    loopStatement = ts.factory.createLabeledStatement(label, loopStatement);
  }

  return ts.factory.createBlock(
    [
      ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              iterableName,
              undefined,
              undefined,
              iterableExpression,
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
      ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              iteratorMethodName,
              undefined,
              undefined,
              ts.factory.createElementAccessExpression(
                ts.factory.createIdentifier(iterableName),
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier('Symbol'),
                  'asyncIterator',
                ),
              ),
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
      ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              iteratorName,
              undefined,
              undefined,
              ts.factory.createConditionalExpression(
                ts.factory.createBinaryExpression(
                  ts.factory.createTypeOfExpression(
                    ts.factory.createIdentifier(iteratorMethodName),
                  ),
                  ts.factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
                  ts.factory.createStringLiteral('function'),
                ),
                ts.factory.createToken(ts.SyntaxKind.QuestionToken),
                ts.factory.createCallExpression(
                  ts.factory.createElementAccessExpression(
                    ts.factory.createIdentifier(iterableName),
                    ts.factory.createPropertyAccessExpression(
                      ts.factory.createIdentifier('Symbol'),
                      'asyncIterator',
                    ),
                  ),
                  undefined,
                  [],
                ),
                ts.factory.createToken(ts.SyntaxKind.ColonToken),
                createThrowTypeError(
                  'Do `for await...of` requires an async iterable value.',
                ),
              ),
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
      ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              doneName,
              undefined,
              undefined,
              ts.factory.createFalse(),
            ),
          ],
          ts.NodeFlags.Let,
        ),
      ),
      ts.factory.createTryStatement(
        ts.factory.createBlock([loopStatement], true),
        undefined,
        ts.factory.createBlock(
          [
            ts.factory.createIfStatement(
              ts.factory.createBinaryExpression(
                ts.factory.createPrefixUnaryExpression(
                  ts.SyntaxKind.ExclamationToken,
                  ts.factory.createIdentifier(doneName),
                ),
                ts.factory.createToken(ts.SyntaxKind.AmpersandAmpersandToken),
                ts.factory.createBinaryExpression(
                  ts.factory.createTypeOfExpression(
                    ts.factory.createPropertyAccessExpression(
                      ts.factory.createIdentifier(iteratorName),
                      'return',
                    ),
                  ),
                  ts.factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
                  ts.factory.createStringLiteral('function'),
                ),
              ),
              ts.factory.createBlock(
                [
                  ts.factory.createExpressionStatement(
                    ts.factory.createCallExpression(
                      ts.factory.createIdentifier(bindHelperName),
                      undefined,
                      [
                        ts.factory.createBinaryExpression(
                          ts.factory.createIdentifier(iteratorCloseTempName),
                          ts.factory.createToken(ts.SyntaxKind.EqualsToken),
                          ts.factory.createCallExpression(
                            ts.factory.createPropertyAccessExpression(
                              ts.factory.createIdentifier(monadBindingName),
                              'fromPromise',
                            ),
                            undefined,
                            [
                              ts.factory.createCallExpression(
                                ts.factory.createPropertyAccessExpression(
                                  ts.factory.createIdentifier(iteratorName),
                                  'return',
                                ),
                                undefined,
                                [],
                              ),
                            ],
                          ),
                        ),
                        ts.factory.createYieldExpression(
                          undefined,
                          ts.factory.createIdentifier(iteratorCloseTempName),
                        ),
                      ],
                    ),
                  ),
                ],
                true,
              ),
            ),
          ],
          true,
        ),
      ),
    ],
    true,
  );
}

function lowerDoBlock(
  body: ts.Block,
  bindName: string,
  monadBindingName: string,
  bindHelperName: string,
  helperSuffix: string,
  bindTempPrefix: string,
  allowAwait: boolean,
  error: (message: string) => never,
): ts.Block {
  const bindTempNames: string[] = [];
  const allocateBindTempName = () => {
    const name = `${bindTempPrefix}${bindTempNames.length}`;
    bindTempNames.push(name);
    return name;
  };
  let asyncTempIndex = 0;
  const allocateAsyncName = (kind: string) =>
    `__sts_do_async_${kind}_${helperSuffix}_${asyncTempIndex++}`;
  const transformed = ts.transform(body, [(
    context: ts.TransformationContext,
  ) =>
  (root: ts.Node) =>
    ts.visitNode(root, function visit(node): ts.VisitResult<ts.Node> {
      if (ts.isTypeNode(node)) {
        return node;
      }
      if (ts.isFunctionLike(node)) {
        assertNoBindInNestedFunction(node, bindName, error);
        return node;
      }
      if (ts.isAwaitExpression(node)) {
        if (!allowAwait) {
          error('Do only supports `await` inside async callbacks.');
        }
        const tempName = allocateBindTempName();
        return ts.factory.createCallExpression(
          ts.factory.createIdentifier(bindHelperName),
          undefined,
          [
            ts.factory.createBinaryExpression(
              ts.factory.createIdentifier(tempName),
              ts.factory.createToken(ts.SyntaxKind.EqualsToken),
              ts.factory.createCallExpression(
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier(monadBindingName),
                  'fromPromise',
                ),
                undefined,
                [ts.visitNode(node.expression, visit) as ts.Expression],
              ),
            ),
            ts.factory.createYieldExpression(
              undefined,
              ts.factory.createIdentifier(tempName),
            ),
          ],
        );
      }
      if (ts.isYieldExpression(node)) {
        error('Do does not support explicit `yield` inside the callback body.');
      }
      if (ts.isMetaProperty(node)) {
        error('Do does not support `new.target` inside the callback body.');
      }
      if (node.kind === ts.SyntaxKind.SuperKeyword) {
        error('Do does not support `super` inside the callback body.');
      }
      if (ts.isIdentifier(node) && node.text === 'arguments' && !isIgnoredValueName(node)) {
        error('Do does not support `arguments` inside the callback body.');
      }
      if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) {
        error('Do only supports `const` and `let` declarations inside the callback body.');
      }
      if (ts.isVariableDeclaration(node)) {
        assertNoBindShadowing(node.name, bindName, error);
      }
      if (ts.isLabeledStatement(node) && !isNestedLabel(node)) {
        const { labels, statement } = collectLabelChain(node);
        if (ts.isForOfStatement(statement) && statement.awaitModifier) {
          return lowerForAwaitStatement(
            statement,
            labels,
            bindName,
            monadBindingName,
            bindHelperName,
            allocateBindTempName,
            allocateAsyncName,
            visit,
            allowAwait,
            error,
          );
        }
      }
      if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        if (
          ts.isVariableDeclarationList(node.initializer) &&
          (node.initializer.flags & ts.NodeFlags.BlockScoped) === 0
        ) {
          error('Do only supports `const` and `let` declarations inside the callback body.');
        }
      }
      if (ts.isForOfStatement(node) && node.awaitModifier) {
        if (ts.isLabeledStatement(node.parent)) {
          return node;
        }
        return lowerForAwaitStatement(
          node,
          [],
          bindName,
          monadBindingName,
          bindHelperName,
          allocateBindTempName,
          allocateAsyncName,
          visit,
          allowAwait,
          error,
        );
      }
      if (
        ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === bindName
      ) {
        if ((node.typeArguments?.length ?? 0) > 0 || node.arguments.length !== 1) {
          error('Do bind sites must use the form `bind(expr)`.');
        }
        const tempName = allocateBindTempName();
        return ts.factory.createCallExpression(
          ts.factory.createIdentifier(bindHelperName),
          undefined,
          [
            ts.factory.createBinaryExpression(
              ts.factory.createIdentifier(tempName),
              ts.factory.createToken(ts.SyntaxKind.EqualsToken),
              ts.visitNode(node.arguments[0]!, visit) as ts.Expression,
            ),
            ts.factory.createYieldExpression(
              undefined,
              ts.factory.createIdentifier(tempName),
            ),
          ],
        );
      }
      if (ts.isIdentifier(node) && node.text === bindName) {
        if (isDeclarationName(node)) {
          error(`Do does not allow rebinding \`${bindName}\` inside the callback body.`);
        }
        if (!isIgnoredValueName(node)) {
          error('Do bind sites must use the form `bind(expr)`.');
        }
      }
      return ts.visitEachChild(node, visit, context);
    })]);
  try {
    const [firstRewritten] = transformed.transformed;
    if (!firstRewritten || !ts.isBlock(firstRewritten)) {
      throw new Error('Expected Do lowering to produce a block.');
    }
    let rewritten: ts.Block = firstRewritten;
    if (bindTempNames.length > 0) {
      rewritten = ts.factory.updateBlock(rewritten, [
        ts.factory.createVariableStatement(
          undefined,
          ts.factory.createVariableDeclarationList(
            bindTempNames.map((name) => ts.factory.createVariableDeclaration(name)),
            ts.NodeFlags.Let,
          ),
        ),
        ...rewritten.statements,
      ]);
    }
    return rewritten;
  } finally {
    transformed.dispose();
  }
}

// #[macro(decl)]
export function hkt(): MacroDefinition<typeof HKT_DECL_SIGNATURE> {
  return {
    declarationKinds: ['interface'],
    expand(ctx, signature) {
      const declaration = getHostDeclaration(signature.args.target);
      const interfaceDeclaration = ts.isInterfaceDeclaration(declaration)
        ? declaration
        : ctx.error('hkt only supports interface declarations.');

      if ((interfaceDeclaration.typeParameters?.length ?? 0) < 1) {
        ctx.error('hkt requires at least one type parameter.');
      }
      if ((interfaceDeclaration.heritageClauses?.length ?? 0) > 0) {
        ctx.error('hkt does not yet support interface extends clauses.');
      }

      const typeParameters = interfaceDeclaration.typeParameters ?? [];
      for (const typeParameter of typeParameters) {
        if (typeParameter.constraint || typeParameter.default) {
          ctx.error('hkt does not yet support constrained or defaulted type parameters.');
        }
      }

      if (interfaceDeclaration.members.length !== 1) {
        ctx.error('hkt requires exactly one `readonly type: ...` member.');
      }

      const [memberNode] = interfaceDeclaration.members;
      const member = memberNode && ts.isPropertySignature(memberNode)
        ? memberNode
        : ctx.error('hkt requires exactly one `readonly type: ...` member.');
      if (!ts.isIdentifier(member.name) || member.name.text !== 'type') {
        ctx.error('hkt requires the interface member to be named `type`.');
      }
      if (!hasReadonlyModifier(member)) {
        ctx.error('hkt requires `type` to be declared as a readonly property.');
      }
      if (!member.type || member.questionToken) {
        ctx.error('hkt requires `type` to have an explicit non-optional type.');
      }
      const memberType = member.type ??
        ctx.error('hkt requires `type` to have an explicit non-optional type.');

      const typeParameterIndexes = new Map(
        typeParameters.map((typeParameter, index) => [typeParameter.name.text, index] as const),
      );
      const rewrittenMemberType = rewriteHktMemberType(memberType, typeParameterIndexes);
      const updatedMember = ts.factory.updatePropertySignature(
        member,
        member.modifiers,
        member.name,
        undefined,
        rewrittenMemberType,
      );
      const sourceFile = interfaceDeclaration.getSourceFile();
      const declarationText = [
        `${
          modifierText(interfaceDeclaration.modifiers, sourceFile)
        }interface ${interfaceDeclaration.name.text} {`,
        '  readonly Args: readonly unknown[];',
        indent(printNode(updatedMember, sourceFile)),
        '}',
      ].join('\n');

      return ctx.output.stmt(
        createDeclSyntaxFromText(
          ctx.invocationSpan().fileName,
          signature.args.target.span,
          declarationText,
        ),
      );
    },
    signature: HKT_DECL_SIGNATURE,
  };
}
attachHktFactory(hkt, 'decl');

// #[macro(call)]
export function Do(): MacroDefinition<typeof DO_SIGNATURE> {
  return {
    expand(ctx, signature) {
      const callbackText = ctx.semantics.argExpanded(1)?.text() ?? signature.args.body.text();
      const callbackExpr = createExprSyntaxFromText(
        ctx.invocationSpan().fileName,
        signature.args.body.span,
        callbackText,
      );
      const callbackNode = getHostExpression(callbackExpr);
      const callback = ts.isArrowFunction(callbackNode)
        ? callbackNode
        : ctx.error('Do only supports callbacks of the form `(bind) => { ... }`.');
      const isAsyncCallback =
        ts.getModifiers(callback)?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.AsyncKeyword
        ) ??
          false;
      if ((callback.typeParameters?.length ?? 0) > 0) {
        ctx.error('Do does not support generic callbacks.');
      }
      if (callback.parameters.length !== 1 || !ts.isIdentifier(callback.parameters[0]!.name)) {
        ctx.error('Do only supports callbacks of the form `(bind) => { ... }`.');
      }

      const [bindParameter] = callback.parameters;
      if (!bindParameter || bindParameter.dotDotDotToken || bindParameter.initializer) {
        ctx.error('Do only supports callbacks of the form `(bind) => { ... }`.');
      }
      const bindParameterName = ts.isIdentifier(bindParameter.name)
        ? bindParameter.name
        : ctx.error('Do only supports callbacks of the form `(bind) => { ... }`.');
      if (bindParameterName.text !== 'bind') {
        ctx.error('Do requires the callback parameter to be named `bind`.');
      }
      const callbackBody = ts.isBlock(callback.body)
        ? callback.body
        : ctx.error('Do requires a block-bodied callback.');

      const bindName = bindParameterName.text;
      const helperSuffix = String(ctx.invocationSpan().start);
      const monadBindingName = `__sts_do_monad_${helperSuffix}`;
      const bindHelperName = `__sts_do_bind_${helperSuffix}`;
      const callbackBindingName = `__sts_do_callback_${helperSuffix}`;
      const bindTempPrefix = `__sts_do_effect_${helperSuffix}_`;
      const loweredBody = lowerDoBlock(
        callbackBody,
        bindName,
        monadBindingName,
        bindHelperName,
        helperSuffix,
        bindTempPrefix,
        isAsyncCallback,
        (message) => ctx.error(message),
      );
      const sourceFile = callback.getSourceFile();
      const monadText = ctx.semantics.argExpanded(0)?.text() ?? signature.args.monad.text();
      const callbackBodyText = printNode(callbackBody, sourceFile);
      const monadTypeText = `import(${
        JSON.stringify(HKT_MODULE_SPECIFIER)
      }).MonadTypeLambda<typeof ${monadBindingName}>`;
      const callbackReturnTypeText = isAsyncCallback
        ? `Awaited<ReturnType<typeof ${callbackBindingName}>>`
        : `ReturnType<typeof ${callbackBindingName}>`;
      const loweredText = [
        '(() => {',
        `  const ${monadBindingName} = ${monadText};`,
        `  const ${bindHelperName} = ${ctx.name}.${DO_BIND_HELPER_PROPERTY}<${monadTypeText}>(${monadBindingName});`,
        `  const ${callbackBindingName} = ${isAsyncCallback ? 'async ' : ''}(bind: import(${
          JSON.stringify(HKT_MODULE_SPECIFIER)
        }).Binder<${monadTypeText}>) => ${callbackBodyText};`,
        `  return ${ctx.name}.${DO_HELPER_PROPERTY}<`,
        `    ${monadTypeText},`,
        `    ${callbackReturnTypeText}`,
        '  >(',
        `    ${monadBindingName},`,
        `    () => (function* (): Generator<`,
        `      import(${JSON.stringify(HKT_MODULE_SPECIFIER)}).Kind<`,
        `        ${monadTypeText},`,
        '        unknown',
        '      >,',
        `      ${callbackReturnTypeText},`,
        '      unknown',
        `    > ${printNode(loweredBody, sourceFile)}).call(this),`,
        '  );',
        '})()',
      ].join('\n');

      return ctx.output.expr(
        createExprSyntaxFromText(ctx.invocationSpan().fileName, ctx.invocationSpan(), loweredText),
      );
    },
    signature: DO_SIGNATURE,
  };
}
attachHktFactory(Do, 'call');
