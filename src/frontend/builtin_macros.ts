import type {
  InvocationSyntax,
  MacroContext,
  MacroDefinition,
  MacroFormatContext,
  MacroHoverContext,
  MacroHoverResult,
  MacroSyntaxNode,
} from './macro_api.ts';
import { macroSignature } from './macro_api.ts';
import { attachMacroFactoryMetadata } from './macro_api_internal.ts';
import { cssFragments, expandCssMacro } from './css_macro.ts';
import { expandGraphqlMacro, graphqlFragments } from './graphql_macro.ts';
export { Do, hkt } from './hkt_macro.ts';
import {
  expandMatchMacro,
  hoverMatchMacro,
  hoverMatchMacroPosition,
  semanticTokensForMatchMacro,
} from './match_macro.ts';
import { expandSqlMacro, sqlFragments } from './sql_macro.ts';
import type { SourceSpan } from './macro_types.ts';
import { fromFileUrl } from '../platform/path.ts';

interface ExprBuiltinMacroSyntaxNode extends MacroSyntaxNode {
  readonly data: {
    readonly details: readonly string[];
    readonly operandSpan: SourceSpan | null;
  };
  readonly kind: 'Try' | 'lazy' | 'log' | 'memo';
}

const EXPR_BUILTIN_SUMMARY_DETAILS: Readonly<
  Record<ExprBuiltinMacroSyntaxNode['kind'], readonly string[]>
> = {
  Try: [
    'Unwraps `Result<Ok, Err>`. If the operand is `err`, the enclosing function returns that error immediately.',
  ],
  lazy: ['Wraps the operand in a thunk so it is only evaluated when later invoked.'],
  log: [
    'Evaluates the operand, logs its source text and value, then yields the original value unchanged.',
  ],
  memo: [
    'Wraps the operand in a thunk that caches the first computed value and returns it on later calls.',
  ],
};

function containsOffset(span: SourceSpan, position: number): boolean {
  return position >= span.start && position < span.end;
}

function buildExprBuiltinMacroSyntaxNode(
  ctx: MacroContext,
  kind: ExprBuiltinMacroSyntaxNode['kind'],
  details: readonly string[],
): ExprBuiltinMacroSyntaxNode {
  return {
    data: {
      details: [...details],
      operandSpan: ctx.invocation.args[0]?.span ?? null,
    },
    kind,
    span: ctx.invocationSpan(),
  };
}

function hoverExprBuiltinMacro(ctx: MacroHoverContext): MacroHoverResult | null {
  const node = ctx.node as MacroSyntaxNode & Partial<ExprBuiltinMacroSyntaxNode> & {
    readonly name?: string;
  };
  const macroKind = (
    node.kind === 'Try' ||
      node.kind === 'lazy' ||
      node.kind === 'log' ||
      node.kind === 'memo'
      ? node.kind
      : node.name
  ) as ExprBuiltinMacroSyntaxNode['kind'] | undefined;
  if (!macroKind) {
    return null;
  }

  const operandSpan = node.data?.operandSpan ?? null;
  const position = node.span.start + ctx.offset;
  if (operandSpan && containsOffset(operandSpan, position)) {
    return null;
  }

  const details = node.data?.details ?? EXPR_BUILTIN_SUMMARY_DETAILS[macroKind];
  return {
    contents: [
      `**macro** \`${macroKind}\``,
      '',
      ...details,
    ].join('\n'),
  };
}

function formatMatchBuiltinMacro(ctx: MacroFormatContext): string {
  const node = ctx.node as InvocationSyntax;
  const [value, arms] = node.args;
  if (!value || !arms) {
    return node.text();
  }

  return `Match(${ctx.formatExpression(value.text())}, ${ctx.formatExpression(arms.text())})`;
}

const SINGLE_EXPR_SIGNATURE = macroSignature.of(macroSignature.expr('value'));
const OPTIONAL_SINGLE_EXPR_SIGNATURE = macroSignature.of(
  macroSignature.optional(macroSignature.expr('message')),
);
const EXPR_CASE = macroSignature.case('expr', macroSignature.expr('value'));
const BLOCK_CASE = macroSignature.case('block', macroSignature.block('body'));
const EXPR_OR_BLOCK_SIGNATURE = macroSignature.oneOf(
  EXPR_CASE,
  BLOCK_CASE,
);
const BLOCK_SIGNATURE = macroSignature.of(macroSignature.block('body'));
const DEFER_SIGNATURE = macroSignature.of(macroSignature.functionExpr('cleanup'));
const MATCH_SIGNATURE = macroSignature.of(
  macroSignature.expr('value'),
  macroSignature.arrayLiteral('arms'),
);
const TEMPLATE_SIGNATURE = macroSignature.of(macroSignature.template('template'));
const BUILTIN_MACRO_FILE_NAME = fromFileUrl(import.meta.url);

function attachBuiltinFactory<T extends () => MacroDefinition>(
  factory: T,
  form: 'call' | 'tag',
): T {
  return attachMacroFactoryMetadata(factory, {
    form,
    moduleFileName: BUILTIN_MACRO_FILE_NAME,
  }) as T;
}

// #[macro(call)]
export function log(): MacroDefinition<typeof SINGLE_EXPR_SIGNATURE> {
  return {
    expand(ctx, signature) {
      const expr = signature.args.value;
      const valueName = ctx.fresh.binding('__sts_log_value');
      return ctx.output.expr(
        ctx.quote.expr`
          (() => {
            const ${valueName} = ${expr};
            console.log(${JSON.stringify(expr.text())}, ${valueName});
            return ${valueName};
          })()
        `,
      );
    },
    hover(ctx) {
      return hoverExprBuiltinMacro(ctx);
    },
    parse(ctx) {
      return buildExprBuiltinMacroSyntaxNode(
        ctx,
        'log',
        ['Evaluates the operand, logs its source text and value, then yields the original value unchanged.'],
      );
    },
    signature: SINGLE_EXPR_SIGNATURE,
  };
}
attachBuiltinFactory(log, 'call');

function expandedPrimaryExprText(ctx: MacroContext): string {
  return ctx.semantics.primaryExprExpanded()?.text() ?? ctx.syntax.primaryExpr().text();
}

// #[macro(call)]
export function lazy(): MacroDefinition<typeof EXPR_OR_BLOCK_SIGNATURE> {
  return {
    expand(ctx, signature) {
      if (signature.caseName === 'expr') {
        return ctx.output.expr(ctx.quote.expr`() => (${expandedPrimaryExprText(ctx)})`);
      }

      return ctx.output.expr(ctx.quote.expr`() => (() => ${signature.args.body})()`);
    },
    hover(ctx) {
      return hoverExprBuiltinMacro(ctx);
    },
    parse(ctx) {
      return buildExprBuiltinMacroSyntaxNode(
        ctx,
        'lazy',
        ['Wraps the operand in a thunk so it is not evaluated until the thunk is invoked.'],
      );
    },
    signature: EXPR_OR_BLOCK_SIGNATURE,
  };
}
attachBuiltinFactory(lazy, 'call');

// #[macro(call)]
export function memo(): MacroDefinition<typeof EXPR_OR_BLOCK_SIGNATURE> {
  return {
    expand(ctx, signature) {
      const readyName = ctx.fresh.binding('__sts_memo_ready');
      const valueName = ctx.fresh.binding('__sts_memo_value');
      const computation = signature.caseName === 'block'
        ? `(() => ${signature.args.body.text()})()`
        : `(${expandedPrimaryExprText(ctx)})`;

      return ctx.output.expr(ctx.quote.expr`
        (() => {
          let ${readyName} = false;
          let ${valueName};
          return () => {
            if (!${readyName}) {
              ${valueName} = ${computation};
              ${readyName} = true;
            }
            return ${valueName};
          };
        })()
      `);
    },
    hover(ctx) {
      return hoverExprBuiltinMacro(ctx);
    },
    parse(ctx) {
      return buildExprBuiltinMacroSyntaxNode(
        ctx,
        'memo',
        ['Wraps the operand in a thunk that caches the first computed value and returns it on later calls.'],
      );
    },
    signature: EXPR_OR_BLOCK_SIGNATURE,
  };
}
attachBuiltinFactory(memo, 'call');

// #[macro(call)]
export function Try(): MacroDefinition<typeof SINGLE_EXPR_SIGNATURE> {
  return {
    expand(ctx) {
      const placement = ctx.controlFlow.placement();
      if (placement.kind === 'unsupported') {
        if (placement.reason === 'multi-declaration') {
          ctx.error(
            'Try currently only supports declarations with a single variable declarator.',
          );
        }
        ctx.error(
          'Try currently only supports expression sites that can be hoisted through the nearest enclosing statement.',
        );
      }

      const enclosingFunction = ctx.semantics.primaryExprEnclosingFunction() ??
        ctx.semantics.enclosingFunction();
      const activeEnclosingFunction = enclosingFunction ??
        ctx.error('Try can only be used inside a function or method body.');

      if (activeEnclosingFunction.isGenerator) {
        ctx.error('Try does not yet support generators or yield-based Result flows.');
      }

      const expandedOperand = ctx.semantics.primaryExprExpanded() ??
        ctx.error(
          'Try could not resolve the operand expression for semantic analysis.',
        );
      const operandPrelude = ctx.semantics.primaryExprPrelude() ?? [];
      const operandType = ctx.semantics.primaryExprType();
      const activeOperandCarrier = ((): NonNullable<
        ReturnType<typeof ctx.semantics.primaryExprTryCarrier>
      > => {
        const carrier = ctx.semantics.primaryExprTryCarrier();
        if (carrier) {
          return carrier;
        }
        const canonicalCarrier = operandType
          ? ctx.semantics.classifyCanonicalResultCarrierType(operandType)
          : null;
        if (canonicalCarrier?.requiresAwait) {
          return ctx.error(
            'Try requires a direct Result, Option, or nullish carrier. Await Promises explicitly before calling Try.',
          );
        }
        return ctx.error('Try requires a direct Result, Option, or nullish carrier.');
      })();

      const temp = ctx.controlFlow.freshBinding('__sts_attempt');
      const expandedOperandText = expandedOperand.text();

      if (activeOperandCarrier.kind === 'result') {
        const isOptionCarrier = activeOperandCarrier.family === 'option';
        const enclosingResult = ctx.semantics.primaryExprEnclosingFunctionCanonicalResult() ??
          ctx.semantics.enclosingFunctionCanonicalResult();
        const activeEnclosingResult = enclosingResult ??
          ctx.error(
            activeEnclosingFunction.isAsync
              ? 'Try requires async functions to return Promise<soundscript Result<Ok, Err>>.'
              : 'Try requires the enclosing function to return soundscript Result<Ok, Err>.',
          );

        if (
          activeEnclosingFunction.hasDeclaredReturnType &&
          !ctx.semantics.isAssignable(activeOperandCarrier.errType, activeEnclosingResult.errType)
        ) {
          ctx.error('Try cannot return this error type from the enclosing function.');
        }

        const isErr = !isOptionCarrier ? ctx.runtime.named('sts:result', 'isErr').text() : null;
        const isNone = isOptionCarrier ? ctx.runtime.named('sts:result', 'isNone').text() : null;
        const errFactory = !isOptionCarrier ? ctx.runtime.named('sts:result', 'err').text() : null;
        const location = ctx.location();
        const traceFrame = [
          `{ file: ${
            JSON.stringify(location.filePath)
          }, line: ${location.line}, column: ${location.column}${
            activeEnclosingFunction.name
              ? `, fn: ${JSON.stringify(activeEnclosingFunction.name)}`
              : ''
          } }`,
        ].join('');
        const tracesFailure = !isOptionCarrier &&
          ctx.semantics.classifyCanonicalFailureType(activeOperandCarrier.errType) !== null;
        const errorReturn = tracesFailure && errFactory
          ? `${errFactory}(${temp}.error.withFrame(${traceFrame}))`
          : temp;
        const failureCheck = isOptionCarrier && isNone ? `${isNone}(${temp})` : `${isErr}(${temp})`;
        return ctx.controlFlow.rewriteWithValue(
          [
            ...operandPrelude,
            ...ctx.quote.stmts`
              const ${temp} = ${expandedOperandText};
              if (${failureCheck}) { return ${errorReturn}; }
            `,
          ],
          ctx.quote.expr`${temp}.value`,
        );
      }

      const enclosingReturnType = activeEnclosingFunction.isAsync
        ? ctx.semantics.awaitedType(activeEnclosingFunction.returnType)
        : activeEnclosingFunction.returnType;
      for (const nullishKind of activeOperandCarrier.nullishKinds) {
        const nullishType = nullishKind === 'null'
          ? ctx.semantics.nullType()
          : ctx.semantics.undefinedType();
        if (!ctx.semantics.isAssignable(nullishType, enclosingReturnType)) {
          ctx.error('Try cannot return this nullish value from the enclosing function.');
        }
      }

      const nullishCheck = activeOperandCarrier.nullishKinds.length === 2
        ? `${temp} == null`
        : activeOperandCarrier.nullishKinds[0] === 'null'
        ? `${temp} === null`
        : `${temp} === undefined`;
      return ctx.controlFlow.rewriteWithValue(
        [
          ...operandPrelude,
          ...ctx.quote.stmts`
            const ${temp} = ${expandedOperandText};
            if (${nullishCheck}) { return ${temp}; }
          `,
        ],
        ctx.quote.expr`${temp}`,
      );
    },
    hover(ctx) {
      return hoverExprBuiltinMacro(ctx);
    },
    parse(ctx) {
      const details = [
        'Unwraps a direct `Result<Ok, Err>`, `Option<T>`, or nullish carrier. Failing carriers return early from the enclosing function.',
      ];
      const tryCarrier = ctx.semantics.primaryExprTryCarrier();
      if (tryCarrier?.kind === 'result') {
        details.push(`operand: \`${tryCarrier.resultType.displayText}\``);
        details.push(`yields: \`${tryCarrier.okType.displayText}\``);
        details.push(
          `returns early on: \`${
            tryCarrier.family === 'option' ? 'None' : tryCarrier.errType.displayText
          }\``,
        );
      } else if (tryCarrier?.kind === 'nullish') {
        details.push(`operand: \`${tryCarrier.carrierType.displayText}\``);
        details.push(`yields: \`${tryCarrier.valueType.displayText}\``);
        details.push(
          `returns early on: \`${tryCarrier.nullishKinds.join(' | ')}\``,
        );
      }
      return buildExprBuiltinMacroSyntaxNode(ctx, 'Try', details);
    },
    signature: SINGLE_EXPR_SIGNATURE,
  };
}
attachBuiltinFactory(Try, 'call');

// #[macro(call)]
export function Defer(): MacroDefinition<typeof DEFER_SIGNATURE> {
  return {
    expand(ctx, signature) {
      if (!ctx.semantics.enclosingFunction()) {
        ctx.error('Defer can only be used inside a function or method body.');
      }

      const cleanupBody = signature.args.cleanup.body() ??
        ctx.error('Defer only supports: Defer(() => { ... }).');

      return ctx.controlFlow.deferCleanup(cleanupBody);
    },
    signature: DEFER_SIGNATURE,
  };
}
attachBuiltinFactory(Defer, 'call');

// #[macro(call)]
export function assert(): MacroDefinition<typeof SINGLE_EXPR_SIGNATURE> {
  return {
    expand(ctx, signature) {
      const operandText = ctx.semantics.argExpanded(0)?.text() ?? signature.args.value.text();
      const message = JSON.stringify(`Assertion failed: ${ctx.syntax.primaryExpr().text()}`);

      if (ctx.kind === 'stmt') {
        return ctx.output.stmt(
          ctx.quote.stmt`if (!(${operandText})) { throw new Error(${message}); }`,
        );
      }

      const temp = ctx.fresh.binding('__sts_assert');
      return ctx.output.expr(ctx.quote.expr`
        (() => {
          const ${temp} = (${operandText});
          if (!${temp}) { throw new Error(${message}); }
          return ${temp};
        })()
      `);
    },
    signature: SINGLE_EXPR_SIGNATURE,
  };
}
attachBuiltinFactory(assert, 'call');

function buildThrowingBuiltinMacro(
  name: 'todo' | 'unreachable',
  prefix: string,
): MacroDefinition<typeof OPTIONAL_SINGLE_EXPR_SIGNATURE> {
  return {
    expand(ctx, signature) {
      const messageExpr = signature.args.message === null
        ? null
        : ctx.semantics.argExpanded(0)?.text() ?? signature.args.message.text();
      const messageText = messageExpr === null
        ? JSON.stringify(prefix)
        : `\`${prefix}: \${String(${messageExpr})}\``;

      if (ctx.kind === 'stmt') {
        return ctx.output.stmt(ctx.quote.stmt`throw new Error(${messageText});`);
      }

      return ctx.output.expr(ctx.quote.expr`(() => { throw new Error(${messageText}); })()`);
    },
    signature: OPTIONAL_SINGLE_EXPR_SIGNATURE,
  };
}

// #[macro(call)]
export function todo(): MacroDefinition<typeof OPTIONAL_SINGLE_EXPR_SIGNATURE> {
  return buildThrowingBuiltinMacro('todo', 'TODO');
}
attachBuiltinFactory(todo, 'call');

// #[macro(call)]
export function unreachable(): MacroDefinition<typeof OPTIONAL_SINGLE_EXPR_SIGNATURE> {
  return buildThrowingBuiltinMacro('unreachable', 'Unreachable');
}
attachBuiltinFactory(unreachable, 'call');

// #[macro(call)]
export function Match(): MacroDefinition<typeof MATCH_SIGNATURE> {
  return {
    expand(ctx, signature) {
      return expandMatchMacro(ctx, signature.args.value, signature.args.arms);
    },
    format(ctx) {
      return formatMatchBuiltinMacro(ctx);
    },
    hover(ctx) {
      return hoverMatchMacro(ctx);
    },
    positionHover(ctx) {
      return hoverMatchMacroPosition(ctx);
    },
    parse(ctx) {
      return ctx.syntax.root();
    },
    semanticTokens(ctx) {
      return semanticTokensForMatchMacro(ctx);
    },
    signature: MATCH_SIGNATURE,
  };
}
attachBuiltinFactory(Match, 'call');

// #[macro(tag)]
export function sql(): MacroDefinition<typeof TEMPLATE_SIGNATURE> {
  return {
    expand(ctx) {
      return expandSqlMacro(ctx);
    },
    fragments(ctx) {
      return sqlFragments(ctx);
    },
    signature: TEMPLATE_SIGNATURE,
  };
}
attachBuiltinFactory(sql, 'tag');

// #[macro(tag)]
export function css(): MacroDefinition<typeof TEMPLATE_SIGNATURE> {
  return {
    expand(ctx) {
      return expandCssMacro(ctx);
    },
    fragments(ctx) {
      return cssFragments(ctx);
    },
    signature: TEMPLATE_SIGNATURE,
  };
}
attachBuiltinFactory(css, 'tag');

// #[macro(tag)]
export function graphql(): MacroDefinition<typeof TEMPLATE_SIGNATURE> {
  return {
    expand(ctx) {
      return expandGraphqlMacro(ctx);
    },
    fragments(ctx) {
      return graphqlFragments(ctx);
    },
    signature: TEMPLATE_SIGNATURE,
  };
}
attachBuiltinFactory(graphql, 'tag');
