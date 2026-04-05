import ts from 'typescript';

import type {
  MacroParseDiagnostic,
  ParsedMacroDeclarationKind,
  ParsedMacroInvocation,
  ParsedMacroInvocationKind,
  SourceSpan,
} from './macro_types.ts';

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

function getFragmentScriptKind(fileName: string): ts.ScriptKind {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.sts') || lowered.endsWith('.tsx') || lowered.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lowered.endsWith('.js') || lowered.endsWith('.mjs') || lowered.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Start}_$]/u.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Continue}_$\u200C\u200D]/u.test(character);
}

function parseMacroName(
  fileName: string,
  text: string,
  start: number,
): { end: number; nameSpan: SourceSpan; nameText: string } | MacroParseDiagnostic {
  if (text[start] !== '#') {
    return {
      fileName,
      reason: 'missing-macro-name',
      span: createSpan(fileName, start, Math.min(start + 1, text.length)),
    };
  }

  const firstCharacter = text[start + 1];
  if (!isIdentifierStart(firstCharacter)) {
    return {
      fileName,
      reason: 'missing-macro-name',
      span: createSpan(fileName, start, Math.min(start + 1, text.length)),
    };
  }

  let index = start + 2;
  while (isIdentifierPart(text[index])) {
    index += 1;
  }

  return {
    end: index,
    nameSpan: createSpan(fileName, start + 1, index),
    nameText: text.slice(start + 1, index),
  };
}

function parseBalancedRegion(
  fileName: string,
  text: string,
  start: number,
  openChar: '(' | '{',
  closeChar: ')' | '}',
): SourceSpan | MacroParseDiagnostic {
  if (text[start] !== openChar) {
    return {
      fileName,
      reason: openChar === '(' ? 'unterminated-arglist' : 'unterminated-block',
      span: createSpan(fileName, start, Math.min(start + 1, text.length)),
    };
  }

  let depth = 0;
  let index = start;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1;
      }
      index = Math.min(index + 2, text.length);
      continue;
    }

    if (character === openChar) {
      depth += 1;
    } else if (character === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return createSpan(fileName, start, index + 1);
      }
    }

    index += 1;
  }

  return {
    fileName,
    reason: openChar === '(' ? 'unterminated-arglist' : 'unterminated-block',
    span: createSpan(fileName, start, text.length),
  };
}

function splitArguments(
  fileName: string,
  text: string,
  arglistSpan: SourceSpan,
): SourceSpan[] | MacroParseDiagnostic {
  const args: SourceSpan[] = [];
  let segmentStart = arglistSpan.start + 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let index = arglistSpan.start + 1;

  while (index < arglistSpan.end - 1) {
    const character = text[index];
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      index += 1;
      while (index < arglistSpan.end - 1) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < arglistSpan.end - 1 && text[index] !== '\n') {
        index += 1;
      }
      continue;
    }

    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (
        index + 1 < arglistSpan.end - 1 &&
        !(text[index] === '*' && text[index + 1] === '/')
      ) {
        index += 1;
      }
      index = Math.min(index + 2, arglistSpan.end - 1);
      continue;
    }

    switch (character) {
      case '(':
        parenDepth += 1;
        break;
      case ')':
        parenDepth -= 1;
        break;
      case '[':
        bracketDepth += 1;
        break;
      case ']':
        bracketDepth -= 1;
        break;
      case '{':
        braceDepth += 1;
        break;
      case '}':
        braceDepth -= 1;
        break;
      case ',':
        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
          const argumentStart = skipTrivia(text, segmentStart);
          let argumentEnd = index;
          while (argumentEnd > argumentStart && /\s/u.test(text[argumentEnd - 1])) {
            argumentEnd -= 1;
          }
          if (argumentStart === argumentEnd) {
            return {
              fileName,
              reason: 'unexpected-token',
              span: createSpan(fileName, index, index + 1),
            };
          }
          args.push(createSpan(fileName, argumentStart, argumentEnd));
          segmentStart = index + 1;
        }
        break;
      default:
        break;
    }

    index += 1;
  }

  const argumentStart = skipTrivia(text, segmentStart);
  let argumentEnd = arglistSpan.end - 1;
  while (argumentEnd > argumentStart && /\s/u.test(text[argumentEnd - 1])) {
    argumentEnd -= 1;
  }
  if (argumentStart < argumentEnd) {
    args.push(createSpan(fileName, argumentStart, argumentEnd));
  } else if (segmentStart < arglistSpan.end - 1) {
    return {
      fileName,
      reason: 'unexpected-token',
      span: createSpan(fileName, arglistSpan.end - 1, arglistSpan.end - 1),
    };
  }

  return args;
}

function hasTrailingOperandSeparator(text: string, start: number, end: number): boolean {
  return skipTrivia(text, start) > start &&
    end > start &&
    !/[\r\n]/u.test(text.slice(start, end));
}

function canAttachTrailingBlock(text: string, start: number, expressionEnd: number): boolean {
  let currentIndex = expressionEnd;
  while (currentIndex > start && /\s/u.test(text[currentIndex - 1])) {
    currentIndex -= 1;
  }

  const trimmedExpression = text.slice(start, currentIndex);
  if (
    trimmedExpression.includes('=>') ||
    /^async\s+function\b/u.test(trimmedExpression) ||
    trimmedExpression.startsWith('function') ||
    trimmedExpression.startsWith('class')
  ) {
    return false;
  }

  while (currentIndex > start) {
    currentIndex -= 1;
    const character = text[currentIndex];
    if (/\s/u.test(character)) {
      continue;
    }
    return character !== '?' && character !== ':' && character !== '=';
  }

  return true;
}

function parseExpressionSlice(
  fileName: string,
  text: string,
  start: number,
):
  | { end: number; expressionSpan: SourceSpan; trailingBlockSpan?: SourceSpan }
  | MacroParseDiagnostic {
  let index = start;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let topLevelConditionalDepth = 0;
  let expressionEnd = start;

  while (index < text.length) {
    const character = text[index];

    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      expressionEnd = index;
      continue;
    }

    if (character === '/' && text[index + 1] === '/') {
      break;
    }

    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (index + 1 < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index += 1;
      }
      index = Math.min(index + 2, text.length);
      expressionEnd = index;
      continue;
    }

    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (
        character === ';' ||
        character === ',' ||
        character === ')' ||
        character === ']' ||
        (character === ':' && topLevelConditionalDepth === 0)
      ) {
        break;
      }
      if (character === '{') {
        if (!canAttachTrailingBlock(text, start, expressionEnd)) {
          braceDepth += 1;
          index += 1;
          expressionEnd = index;
          continue;
        }

        let trimmedExpressionEnd = expressionEnd;
        while (trimmedExpressionEnd > start && /\s/u.test(text[trimmedExpressionEnd - 1])) {
          trimmedExpressionEnd -= 1;
        }
        const expressionSpan = createSpan(fileName, start, trimmedExpressionEnd);
        if (expressionSpan.start === expressionSpan.end) {
          return {
            fileName,
            reason: 'missing-expression',
            span: createSpan(fileName, start, start),
          };
        }
        const trailingBlockSpan = parseBalancedRegion(fileName, text, index, '{', '}');
        if ('reason' in trailingBlockSpan) {
          return trailingBlockSpan;
        }
        return {
          end: trailingBlockSpan.end,
          expressionSpan,
          trailingBlockSpan,
        };
      }
    }

    switch (character) {
      case '?':
        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && text[index + 1] !== '?') {
          topLevelConditionalDepth += 1;
        }
        break;
      case ':':
        if (
          parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && topLevelConditionalDepth > 0
        ) {
          topLevelConditionalDepth -= 1;
        }
        break;
      case '(':
        parenDepth += 1;
        break;
      case ')':
        if (parenDepth === 0) {
          break;
        }
        parenDepth -= 1;
        break;
      case '[':
        bracketDepth += 1;
        break;
      case ']':
        if (bracketDepth > 0) {
          bracketDepth -= 1;
        }
        break;
      case '{':
        braceDepth += 1;
        break;
      case '}':
        if (braceDepth > 0) {
          braceDepth -= 1;
        } else {
          break;
        }
        break;
      default:
        break;
    }

    index += 1;
    expressionEnd = index;
  }

  while (expressionEnd > start && /\s/u.test(text[expressionEnd - 1])) {
    expressionEnd -= 1;
  }

  if (expressionEnd === start) {
    return {
      fileName,
      reason: 'missing-expression',
      span: createSpan(fileName, start, start),
    };
  }

  return {
    end: expressionEnd,
    expressionSpan: createSpan(fileName, start, expressionEnd),
  };
}

function determineRewriteKind(text: string, start: number): 'expr' | 'stmt' {
  const before = text.slice(0, start).trimEnd();

  function isInForHeaderAfterSemicolon(): boolean {
    if (!before.endsWith(';')) {
      return false;
    }

    let parenDepth = 0;
    let semicolonCount = 0;
    for (let index = before.length - 1; index >= 0; index -= 1) {
      const character = before[index];
      if (character === ')') {
        parenDepth += 1;
        continue;
      }
      if (character === '(') {
        if (parenDepth === 0) {
          let lookbehind = index - 1;
          while (lookbehind >= 0 && /\s/u.test(before[lookbehind]!)) {
            lookbehind -= 1;
          }
          return before.slice(Math.max(0, lookbehind - 2), lookbehind + 1) === 'for' &&
            semicolonCount >= 1;
        }
        parenDepth -= 1;
        continue;
      }
      if (parenDepth === 0 && character === ';') {
        semicolonCount += 1;
      }
    }

    return false;
  }

  if (
    before.endsWith('return') ||
    before.endsWith('throw') ||
    before.endsWith('case') ||
    before.endsWith('of') ||
    before.endsWith('in') ||
    isInForHeaderAfterSemicolon()
  ) {
    return 'expr';
  }

  let index = before.length - 1;
  while (index >= 0) {
    const character = before[index];
    if (character === ' ' || character === '\t' || character === '\r' || character === '\n') {
      index -= 1;
      continue;
    }
    return character === '=' || character === '(' || character === '[' || character === ',' ||
        character === ':' || character === '?' || character === '&' || character === '|' ||
        character === '^' || character === '+' || character === '-' || character === '*' ||
        character === '/' || character === '%' || character === '!' || character === '~'
      ? 'expr'
      : 'stmt';
  }

  return 'stmt';
}

function parseDeclarationSlice(
  fileName: string,
  text: string,
  start: number,
): {
  declarationKind: ParsedMacroDeclarationKind;
  declarationName: string | null;
  declarationSpan: SourceSpan;
  end: number;
} | null {
  const slice = text.slice(start);
  const sourceFile = ts.createSourceFile(
    `/virtual/macro_decl_probe${
      fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? '.tsx' : '.ts'
    }`,
    slice,
    ts.ScriptTarget.Latest,
    true,
    getFragmentScriptKind(fileName),
  );
  const [firstStatement] = sourceFile.statements;
  if (!firstStatement) {
    return null;
  }

  if (ts.isClassDeclaration(firstStatement)) {
    return {
      declarationKind: 'class',
      declarationName: firstStatement.name?.text ?? null,
      declarationSpan: createSpan(fileName, start, start + firstStatement.end),
      end: start + firstStatement.end,
    };
  }

  if (ts.isFunctionDeclaration(firstStatement)) {
    return {
      declarationKind: 'function',
      declarationName: firstStatement.name?.text ?? null,
      declarationSpan: createSpan(fileName, start, start + firstStatement.end),
      end: start + firstStatement.end,
    };
  }

  if (ts.isInterfaceDeclaration(firstStatement)) {
    return {
      declarationKind: 'interface',
      declarationName: firstStatement.name.text,
      declarationSpan: createSpan(fileName, start, start + firstStatement.end),
      end: start + firstStatement.end,
    };
  }

  if (ts.isTypeAliasDeclaration(firstStatement)) {
    return {
      declarationKind: 'typeAlias',
      declarationName: firstStatement.name.text,
      declarationSpan: createSpan(fileName, start, start + firstStatement.end),
      end: start + firstStatement.end,
    };
  }

  return null;
}

function shouldTryBareDeclarationParse(text: string, start: number): boolean {
  const preview = text.slice(start, start + 64);
  return preview.startsWith('@') ||
    /^class\s+[\p{ID_Start}_$]/u.test(preview) ||
    /^function\s+[\p{ID_Start}_$]/u.test(preview) ||
    /^interface\s+[\p{ID_Start}_$]/u.test(preview) ||
    /^type\s+[\p{ID_Start}_$]/u.test(preview) ||
    preview.startsWith('export ') ||
    preview.startsWith('declare ') ||
    preview.startsWith('abstract ') ||
    /^async\s+function\b/u.test(preview);
}

function createInvocation(
  fileName: string,
  text: string,
  start: number,
  name: { end: number; nameSpan: SourceSpan; nameText: string },
  invocationKind: ParsedMacroInvocationKind,
  argumentSpans: ParsedMacroInvocation['argumentSpans'],
  end: number,
  trailingBlockSpan?: SourceSpan,
  declarationInfo?: {
    declarationKind: ParsedMacroDeclarationKind;
    declarationName: string | null;
    declarationSpan: SourceSpan;
  },
): ParsedMacroInvocation {
  return {
    argumentSpans,
    declarationKind: declarationInfo?.declarationKind,
    declarationName: declarationInfo?.declarationName,
    declarationSpan: declarationInfo?.declarationSpan,
    fileName,
    hashSpan: createSpan(fileName, start, start + 1),
    invocationKind,
    nameSpan: name.nameSpan,
    nameText: name.nameText,
    rewriteKind: determineRewriteKind(text, start),
    siteKind: declarationInfo ? 'annotation' : 'call',
    span: createSpan(fileName, start, end),
    trailingBlockSpan,
  };
}

export function parseMacroInvocationAt(
  fileName: string,
  text: string,
  start: number,
): ParsedMacroInvocation | MacroParseDiagnostic {
  const parsedName = parseMacroName(fileName, text, start);
  if ('reason' in parsedName) {
    return parsedName;
  }
  const rewriteKind = determineRewriteKind(text, start);

  let index = skipTrivia(text, parsedName.end);
  if (index >= text.length) {
    return {
      fileName,
      reason: 'missing-expression',
      span: createSpan(fileName, start, text.length),
    };
  }

  if (text[index] === '{') {
    const blockSpan = parseBalancedRegion(fileName, text, index, '{', '}');
    if ('reason' in blockSpan) {
      return blockSpan;
    }

    return createInvocation(
      fileName,
      text,
      start,
      parsedName,
      'block',
      [{ kind: 'BlockArg', span: blockSpan }],
      blockSpan.end,
      undefined,
      undefined,
    );
  }

  if (text[index] === '(') {
    const arglistSpan = parseBalancedRegion(fileName, text, index, '(', ')');
    if ('reason' in arglistSpan) {
      return arglistSpan;
    }

    const afterParenIndex = skipTrivia(text, arglistSpan.end);
    const splitResult = splitArguments(fileName, text, arglistSpan);
    if ('reason' in splitResult) {
      return splitResult;
    }

    const argumentSpans = splitResult.map((span) => ({
      kind: 'ExprArg' as const,
      span,
    }));

    index = afterParenIndex;
    if (text[index] === '{') {
      const trailingBlockSpan = parseBalancedRegion(fileName, text, index, '{', '}');
      if ('reason' in trailingBlockSpan) {
        return trailingBlockSpan;
      }

      return createInvocation(
        fileName,
        text,
        start,
        parsedName,
        'arglist+block',
        argumentSpans,
        trailingBlockSpan.end,
        trailingBlockSpan,
        undefined,
      );
    }

    if (rewriteKind === 'stmt') {
      const declarationInfo = parseDeclarationSlice(fileName, text, index);
      if (declarationInfo) {
        return createInvocation(
          fileName,
          text,
          start,
          parsedName,
          'arglist+decl',
          argumentSpans,
          declarationInfo.end,
          undefined,
          declarationInfo,
        );
      }
    }

    if (hasTrailingOperandSeparator(text, arglistSpan.end, index)) {
      const trailingExpression = parseExpressionSlice(fileName, text, index);
      if ('reason' in trailingExpression) {
        return trailingExpression;
      }

      if (trailingExpression.trailingBlockSpan) {
        return {
          fileName,
          reason: 'unexpected-token',
          span: trailingExpression.trailingBlockSpan,
        };
      }

      return createInvocation(
        fileName,
        text,
        start,
        parsedName,
        'arglist',
        [
          ...argumentSpans,
          { kind: 'ExprArg', span: trailingExpression.expressionSpan },
        ],
        trailingExpression.end,
        undefined,
        undefined,
      );
    }

    return createInvocation(
      fileName,
      text,
      start,
      parsedName,
      'arglist',
      argumentSpans,
      arglistSpan.end,
      undefined,
      undefined,
    );
  }

  if (rewriteKind === 'stmt' && shouldTryBareDeclarationParse(text, index)) {
    const declarationInfo = parseDeclarationSlice(fileName, text, index);
    if (declarationInfo) {
      return createInvocation(
        fileName,
        text,
        start,
        parsedName,
        'decl',
        [],
        declarationInfo.end,
        undefined,
        declarationInfo,
      );
    }
  }

  const expression = parseExpressionSlice(fileName, text, index);
  if ('reason' in expression) {
    return expression;
  }

  if (expression.trailingBlockSpan) {
    return {
      fileName,
      reason: 'unexpected-token',
      span: expression.trailingBlockSpan,
    };
  }

  return createInvocation(
    fileName,
    text,
    start,
    parsedName,
    'arglist',
    [{ kind: 'ExprArg', span: expression.expressionSpan }],
    expression.end,
    undefined,
    undefined,
  );
}
