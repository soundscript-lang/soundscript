import ts from 'typescript';

type PreviousToken = ts.SyntaxKind | undefined;

export interface BraceFrame {
  kind: 'block' | 'class-body';
}

export interface HashContext {
  braceStack: readonly BraceFrame[];
  hasLineBreakBeforeHash: boolean;
  insideParameterList: boolean;
  previousSignificantToken: PreviousToken;
}

function inClassBody(context: HashContext): boolean {
  const frame = context.braceStack.at(-1);
  return frame?.kind === 'class-body';
}

function isPrivateMemberDeclarationContext(context: HashContext): boolean {
  if (!inClassBody(context)) {
    return false;
  }

  switch (context.previousSignificantToken) {
    case ts.SyntaxKind.OpenBraceToken:
    case ts.SyntaxKind.CloseBraceToken:
    case ts.SyntaxKind.SemicolonToken:
    case ts.SyntaxKind.PublicKeyword:
    case ts.SyntaxKind.PrivateKeyword:
    case ts.SyntaxKind.ProtectedKeyword:
    case ts.SyntaxKind.StaticKeyword:
    case ts.SyntaxKind.ReadonlyKeyword:
    case ts.SyntaxKind.OverrideKeyword:
    case ts.SyntaxKind.AsyncKeyword:
    case ts.SyntaxKind.GetKeyword:
    case ts.SyntaxKind.SetKeyword:
    case ts.SyntaxKind.AsteriskToken:
      return true;
    default:
      return false;
  }
}

function canStartExpressionOrStatement(context: HashContext): boolean {
  const previousToken = context.previousSignificantToken;
  switch (previousToken) {
    case undefined:
    case ts.SyntaxKind.OpenParenToken:
    case ts.SyntaxKind.OpenBracketToken:
    case ts.SyntaxKind.OpenBraceToken:
    case ts.SyntaxKind.CommaToken:
    case ts.SyntaxKind.SemicolonToken:
    case ts.SyntaxKind.ColonToken:
    case ts.SyntaxKind.EqualsToken:
    case ts.SyntaxKind.EqualsGreaterThanToken:
    case ts.SyntaxKind.ReturnKeyword:
    case ts.SyntaxKind.ThrowKeyword:
    case ts.SyntaxKind.QuestionToken:
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.BarBarToken:
    case ts.SyntaxKind.AmpersandToken:
    case ts.SyntaxKind.AmpersandAmpersandToken:
    case ts.SyntaxKind.CaretToken:
    case ts.SyntaxKind.PlusToken:
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.AsteriskToken:
    case ts.SyntaxKind.SlashToken:
    case ts.SyntaxKind.PercentToken:
    case ts.SyntaxKind.ExclamationToken:
    case ts.SyntaxKind.TildeToken:
    case ts.SyntaxKind.AwaitKeyword:
    case ts.SyntaxKind.CaseKeyword:
    case ts.SyntaxKind.OfKeyword:
    case ts.SyntaxKind.InKeyword:
    case ts.SyntaxKind.QuestionQuestionToken:
      return true;
    case ts.SyntaxKind.CloseBraceToken:
      return context.hasLineBreakBeforeHash;
    default:
      return false;
  }
}

export type HashClassification =
  | { kind: 'macro-start' }
  | { kind: 'private-name' }
  | { kind: 'invalid-hash'; reason: 'illegal-context' };

export function classifyHashContext(context: HashContext): HashClassification {
  if (
    context.insideParameterList &&
    (context.previousSignificantToken === ts.SyntaxKind.OpenParenToken ||
      context.previousSignificantToken === ts.SyntaxKind.CommaToken)
  ) {
    return { kind: 'invalid-hash', reason: 'illegal-context' };
  }

  if (
    context.previousSignificantToken === ts.SyntaxKind.DotToken ||
    context.previousSignificantToken === ts.SyntaxKind.QuestionDotToken ||
    isPrivateMemberDeclarationContext(context)
  ) {
    return { kind: 'private-name' };
  }

  if (canStartExpressionOrStatement(context)) {
    return { kind: 'macro-start' };
  }

  return { kind: 'invalid-hash', reason: 'illegal-context' };
}
