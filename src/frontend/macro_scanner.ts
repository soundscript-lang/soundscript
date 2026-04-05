import ts from 'typescript';

import { type BraceFrame, classifyHashContext } from './hash_context.ts';
import type { HashDiagnostic, ScannedHash, ScanResult, SourceSpan } from './macro_types.ts';

interface ParenFrame {
  kind: 'ordinary' | 'parameter-list';
}

function isTemplateHeadToken(token: ts.SyntaxKind): boolean {
  return token === ts.SyntaxKind.TemplateHead;
}

function isTemplateMiddleToken(token: ts.SyntaxKind): boolean {
  return token === ts.SyntaxKind.TemplateMiddle;
}

function isTemplateTailToken(token: ts.SyntaxKind): boolean {
  return token === ts.SyntaxKind.TemplateTail;
}

function isTriviaToken(token: ts.SyntaxKind): boolean {
  return token === ts.SyntaxKind.WhitespaceTrivia ||
    token === ts.SyntaxKind.NewLineTrivia ||
    token === ts.SyntaxKind.SingleLineCommentTrivia ||
    token === ts.SyntaxKind.MultiLineCommentTrivia;
}

function createSpan(fileName: string, start: number, end: number): SourceSpan {
  return { fileName, start, end };
}

function skipTrivia(text: string, index: number): number {
  let currentIndex = index;

  while (currentIndex < text.length) {
    const character = text[currentIndex];
    const nextCharacter = text[currentIndex + 1];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      currentIndex += 1;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      currentIndex += 2;
      while (currentIndex < text.length && text[currentIndex] !== '\n') {
        currentIndex += 1;
      }
      continue;
    }

    if (character === '/' && nextCharacter === '*') {
      currentIndex += 2;
      while (
        currentIndex + 1 < text.length &&
        !(text[currentIndex] === '*' && text[currentIndex + 1] === '/')
      ) {
        currentIndex += 1;
      }
      currentIndex = Math.min(currentIndex + 2, text.length);
      continue;
    }

    break;
  }

  return currentIndex;
}

function parseHashName(
  tokenText: string,
  text: string,
  start: number,
): { end: number; nameText: string } | undefined {
  if (tokenText.startsWith('#') && tokenText.length > 1) {
    return {
      end: start + tokenText.length,
      nameText: tokenText.slice(1),
    };
  }

  if (text[start + 1] === undefined) {
    return undefined;
  }

  return undefined;
}

function isSingleParameterArrowContext(text: string, hashEnd: number): boolean {
  let currentIndex = hashEnd;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  while (currentIndex < text.length) {
    currentIndex = skipTrivia(text, currentIndex);
    const character = text[currentIndex];
    switch (character) {
      case '(':
        parenDepth += 1;
        currentIndex += 1;
        break;
      case '[':
        bracketDepth += 1;
        currentIndex += 1;
        break;
      case '{':
        braceDepth += 1;
        currentIndex += 1;
        break;
      case ')':
        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
          currentIndex = skipTrivia(text, currentIndex + 1);
          return text.slice(currentIndex, currentIndex + 2) === '=>';
        }

        parenDepth = Math.max(parenDepth - 1, 0);
        currentIndex += 1;
        break;
      case ']':
        bracketDepth = Math.max(bracketDepth - 1, 0);
        currentIndex += 1;
        break;
      case '}':
        braceDepth = Math.max(braceDepth - 1, 0);
        currentIndex += 1;
        break;
      case '"':
      case "'":
      case '`': {
        const quote = character;
        currentIndex += 1;
        while (currentIndex < text.length) {
          if (text[currentIndex] === '\\') {
            currentIndex += 2;
            continue;
          }
          if (text[currentIndex] === quote) {
            currentIndex += 1;
            break;
          }
          currentIndex += 1;
        }
        break;
      }
      default:
        currentIndex += 1;
        break;
    }
  }

  return false;
}

function isClassMemberNameStartToken(token: ts.SyntaxKind): boolean {
  switch (token) {
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.PrivateIdentifier:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.OpenBracketToken:
      return true;
    default:
      return false;
  }
}

function isClassMemberDeclarationContext(
  braceStack: readonly BraceFrame[],
  previousSignificantToken: ts.SyntaxKind | undefined,
): boolean {
  if (braceStack.at(-1)?.kind !== 'class-body') {
    return false;
  }

  switch (previousSignificantToken) {
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

function canStartRegularExpression(
  previousSignificantToken: ts.SyntaxKind | undefined,
): boolean {
  switch (previousSignificantToken) {
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
    default:
      return false;
  }
}

export function scanMacroCandidates(fileName: string, text: string): ScanResult {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const hashes: ScannedHash[] = [];
  const diagnostics: HashDiagnostic[] = [];
  const braceStack: BraceFrame[] = [];
  const parenStack: ParenFrame[] = [];
  const templateInterpolationBraceDepths: number[] = [];
  let previousSignificantToken: ts.SyntaxKind | undefined;
  let previousSignificantTokenEnd = 0;
  let pendingClassBodyDepth: number | undefined;
  let pendingClassTypeParameterDepth = 0;
  let pendingClassMemberParameterList = false;
  let pendingFunctionParameterList = false;

  while (true) {
    let token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) {
      break;
    }

    let tokenStart = scanner.getTokenPos();
    let tokenText = scanner.getTokenText();

    if (
      (token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) &&
      canStartRegularExpression(previousSignificantToken)
    ) {
      token = scanner.reScanSlashToken();
      tokenStart = scanner.getTokenPos();
      tokenText = scanner.getTokenText();
    }

    const activeTemplateInterpolationDepth = templateInterpolationBraceDepths.at(-1);
    if (token === ts.SyntaxKind.CloseBraceToken && activeTemplateInterpolationDepth !== undefined) {
      if (activeTemplateInterpolationDepth === 0) {
        token = scanner.reScanTemplateToken(false);
        tokenStart = scanner.getTokenPos();
        tokenText = scanner.getTokenText();
      } else {
        templateInterpolationBraceDepths[templateInterpolationBraceDepths.length - 1] =
          activeTemplateInterpolationDepth - 1;
      }
    }

    if (
      pendingClassBodyDepth !== undefined &&
      token === ts.SyntaxKind.FirstTemplateToken &&
      tokenText.startsWith('`') &&
      tokenText.length > 1
    ) {
      scanner.setTextPos(tokenStart + 1);
      previousSignificantToken = token;
      continue;
    }

    if (text[tokenStart] === '#') {
      const parsedName = parseHashName(tokenText, text, tokenStart);
      if (!parsedName) {
        diagnostics.push({
          fileName,
          reason: 'not-followed-by-identifier',
          span: createSpan(fileName, tokenStart, tokenStart + 1),
        });
      } else {
        const insideParameterList = parenStack.at(-1)?.kind === 'parameter-list';
        const classification = (
            previousSignificantToken === ts.SyntaxKind.OpenParenToken ||
            previousSignificantToken === ts.SyntaxKind.CommaToken
          ) &&
            !insideParameterList &&
            isSingleParameterArrowContext(text, parsedName.end)
          ? { kind: 'invalid-hash' as const, reason: 'illegal-context' as const }
          : classifyHashContext({
            braceStack,
            hasLineBreakBeforeHash: text.slice(previousSignificantTokenEnd, tokenStart).includes('\n'),
            insideParameterList,
            previousSignificantToken,
          });
        if (classification.kind === 'invalid-hash') {
          diagnostics.push({
            fileName,
            reason: classification.reason,
            span: createSpan(fileName, tokenStart, parsedName.end),
          });
        } else {
          hashes.push({
            kind: classification.kind,
            nameText: parsedName.nameText,
            span: createSpan(fileName, tokenStart, parsedName.end),
          });
        }
      }
    }

    if (isTriviaToken(token)) {
      continue;
    }

    if (isTemplateHeadToken(token) || isTemplateMiddleToken(token)) {
      if (isTemplateHeadToken(token)) {
        templateInterpolationBraceDepths.push(0);
      } else {
        templateInterpolationBraceDepths[templateInterpolationBraceDepths.length - 1] = 0;
      }
    } else if (isTemplateTailToken(token)) {
      templateInterpolationBraceDepths.pop();
    }

    if (token === ts.SyntaxKind.ClassKeyword) {
      pendingClassBodyDepth = 0;
      pendingClassTypeParameterDepth = 0;
      pendingClassMemberParameterList = false;
      pendingFunctionParameterList = false;
    }

    if (pendingClassBodyDepth !== undefined) {
      switch (token) {
        case ts.SyntaxKind.LessThanToken:
          pendingClassTypeParameterDepth += 1;
          break;
        case ts.SyntaxKind.GreaterThanToken:
          pendingClassTypeParameterDepth = Math.max(pendingClassTypeParameterDepth - 1, 0);
          break;
        case ts.SyntaxKind.GreaterThanGreaterThanToken:
          pendingClassTypeParameterDepth = Math.max(pendingClassTypeParameterDepth - 2, 0);
          break;
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
          pendingClassTypeParameterDepth = Math.max(pendingClassTypeParameterDepth - 3, 0);
          break;
        case ts.SyntaxKind.OpenParenToken:
        case ts.SyntaxKind.OpenBracketToken:
          pendingClassBodyDepth += 1;
          break;
        case ts.SyntaxKind.CloseParenToken:
        case ts.SyntaxKind.CloseBracketToken:
          if (pendingClassBodyDepth > 0) {
            pendingClassBodyDepth -= 1;
          }
          break;
        case ts.SyntaxKind.OpenBraceToken:
          if (pendingClassBodyDepth === 0 && pendingClassTypeParameterDepth === 0) {
            braceStack.push({ kind: 'class-body' });
            pendingClassBodyDepth = undefined;
            pendingClassTypeParameterDepth = 0;
          } else {
            pendingClassBodyDepth += 1;
            braceStack.push({ kind: 'block' });
          }
          break;
        case ts.SyntaxKind.CloseBraceToken: {
          const popped = braceStack.pop();
          if (popped && pendingClassBodyDepth > 0) {
            pendingClassBodyDepth -= 1;
          }
          break;
        }
      }
    } else {
      if (token === ts.SyntaxKind.OpenBraceToken) {
        braceStack.push({ kind: 'block' });
        if (templateInterpolationBraceDepths.length > 0) {
          templateInterpolationBraceDepths[templateInterpolationBraceDepths.length - 1] += 1;
        }
      }

      if (token === ts.SyntaxKind.CloseBraceToken) {
        braceStack.pop();
      }
    }

    if (token === ts.SyntaxKind.FunctionKeyword) {
      pendingFunctionParameterList = true;
      pendingClassMemberParameterList = false;
    }

    if (token === ts.SyntaxKind.OpenParenToken) {
      parenStack.push({
        kind: pendingFunctionParameterList || pendingClassMemberParameterList
          ? 'parameter-list'
          : 'ordinary',
      });
      pendingFunctionParameterList = false;
      pendingClassMemberParameterList = false;
    } else if (token === ts.SyntaxKind.CloseParenToken) {
      parenStack.pop();
    } else if (
      token !== ts.SyntaxKind.Identifier &&
      token !== ts.SyntaxKind.StringLiteral &&
      token !== ts.SyntaxKind.NumericLiteral &&
      token !== ts.SyntaxKind.PrivateIdentifier &&
      token !== ts.SyntaxKind.OpenBracketToken &&
      token !== ts.SyntaxKind.CloseBracketToken &&
      token !== ts.SyntaxKind.FunctionKeyword
    ) {
      pendingFunctionParameterList = false;
      if (token !== ts.SyntaxKind.AsyncKeyword && token !== ts.SyntaxKind.AsteriskToken) {
        pendingClassMemberParameterList = false;
      }
    }

    if (
      isClassMemberNameStartToken(token) &&
      isClassMemberDeclarationContext(braceStack, previousSignificantToken)
    ) {
      pendingClassMemberParameterList = true;
    }

    previousSignificantToken = token;
    previousSignificantTokenEnd = tokenStart + tokenText.length;
  }

  return {
    diagnostics,
    hashes,
  };
}
