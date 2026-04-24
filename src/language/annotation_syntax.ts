import ts from 'typescript';

export interface AnnotationTextRange {
  readonly end: number;
  readonly start: number;
}

export interface ParsedAnnotationIdentifierValue {
  readonly kind: 'identifier';
  readonly name: string;
  readonly text: string;
}

export interface ParsedAnnotationMemberValue {
  readonly kind: 'member';
  readonly path: readonly string[];
  readonly text: string;
}

export interface ParsedAnnotationNullValue {
  readonly kind: 'null';
  readonly text: string;
}

export interface ParsedAnnotationRegexpValue {
  readonly flags: string;
  readonly kind: 'regexp';
  readonly pattern: string;
  readonly text: string;
}

export interface ParsedAnnotationStringValue {
  readonly kind: 'string';
  readonly text: string;
  readonly value: string;
}

export interface ParsedAnnotationBigIntValue {
  readonly kind: 'bigint';
  readonly text: string;
  readonly value: string;
}

export interface ParsedAnnotationNumberValue {
  readonly kind: 'number';
  readonly text: string;
  readonly value: number;
}

export interface ParsedAnnotationBooleanValue {
  readonly kind: 'boolean';
  readonly text: string;
  readonly value: boolean;
}

export interface ParsedAnnotationUndefinedValue {
  readonly kind: 'undefined';
  readonly text: string;
}

export interface ParsedAnnotationArrayValue {
  readonly elements: readonly ParsedAnnotationValue[];
  readonly kind: 'array';
  readonly text: string;
}

export interface ParsedAnnotationObjectProperty {
  readonly name: string;
  readonly text: string;
  readonly value: ParsedAnnotationValue;
}

export interface ParsedAnnotationObjectValue {
  readonly kind: 'object';
  readonly properties: readonly ParsedAnnotationObjectProperty[];
  readonly text: string;
}

export type ParsedAnnotationValue =
  | ParsedAnnotationArrayValue
  | ParsedAnnotationBigIntValue
  | ParsedAnnotationBooleanValue
  | ParsedAnnotationIdentifierValue
  | ParsedAnnotationMemberValue
  | ParsedAnnotationNullValue
  | ParsedAnnotationNumberValue
  | ParsedAnnotationObjectValue
  | ParsedAnnotationRegexpValue
  | ParsedAnnotationStringValue
  | ParsedAnnotationUndefinedValue;

export type ParsedAnnotationArgument =
  | {
    readonly kind: 'named';
    readonly name: string;
    readonly text: string;
    readonly value: ParsedAnnotationValue;
  }
  | {
    readonly kind: 'positional';
    readonly text: string;
    readonly value: ParsedAnnotationValue;
  };

export interface ParsedAnnotationSyntax {
  readonly arguments?: readonly ParsedAnnotationArgument[];
  readonly argumentsText?: string;
  readonly nameRange?: AnnotationTextRange;
  readonly name: string;
  readonly path: readonly string[];
  readonly range?: AnnotationTextRange;
  readonly text: string;
}

export type ParsedAnnotation = ParsedAnnotationSyntax;

export interface ParsedAnnotationComment {
  readonly annotations: readonly ParsedAnnotation[];
  readonly kind: 'annotation';
  readonly line: number;
  readonly range?: AnnotationTextRange;
  readonly text: string;
}

export interface ParsedAnnotationParseError {
  readonly kind: 'annotation-parse-error';
  readonly line: number;
  readonly message: string;
  readonly text: string;
}

export interface ParsedTypeScriptPragma {
  readonly kind: 'banned-ts-pragma';
  readonly line: number;
  readonly text: string;
}

export type ParsedAnnotationEntry =
  | ParsedAnnotationComment
  | ParsedAnnotationParseError
  | ParsedTypeScriptPragma;

export interface ParsedAnnotationBlock {
  readonly annotations: readonly ParsedAnnotation[];
  readonly endLine: number;
  readonly range: AnnotationTextRange;
  readonly startLine: number;
  readonly targetNode?: ts.Node;
  readonly text: string;
}

export interface AnnotationLookup {
  getAttachedAnnotationBlock(node: ts.Node): ParsedAnnotationBlock | undefined;
  getAttachedAnnotations(node: ts.Node): readonly ParsedAnnotation[];
  getBlocks(): readonly ParsedAnnotationBlock[];
  getEntries(): readonly ParsedAnnotationEntry[];
  getEntriesForLine(line: number): readonly ParsedAnnotationEntry[];
  hasAttachedAnnotation(node: ts.Node, name: string): boolean;
}

const ANNOTATION_COMMENT_PATTERN = /^\/\/\s*#\[/u;
export const BUILTIN_DIRECTIVE_NAMES: ReadonlySet<string> = new Set([
  'effects',
  'extern',
  'interop',
  'newtype',
  'unsafe',
  'value',
  'variance',
]);

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Start}_$]/u.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[\p{ID_Continue}_$\u200C\u200D-]/u.test(character);
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && /[0-9]/u.test(character);
}

function trimRange(
  text: string,
  start: number,
  end: number,
): { end: number; start: number; text: string } {
  let nextStart = start;
  let nextEnd = end;
  while (nextStart < nextEnd && /\s/u.test(text[nextStart] ?? '')) {
    nextStart += 1;
  }
  while (nextEnd > nextStart && /\s/u.test(text[nextEnd - 1] ?? '')) {
    nextEnd -= 1;
  }
  return {
    end: nextEnd,
    start: nextStart,
    text: text.slice(nextStart, nextEnd),
  };
}

function skipWhitespace(text: string, index: number): number {
  let nextIndex = index;
  while (nextIndex < text.length && /\s/u.test(text[nextIndex] ?? '')) {
    nextIndex += 1;
  }
  return nextIndex;
}

function readStringLiteral(text: string, start: number): number | string {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") {
    return 'Expected a string literal.';
  }

  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index + 1;
    }
    index += 1;
  }

  return 'String literals in annotation arguments must terminate before the annotation closes.';
}

function readRegExpLiteral(
  text: string,
  start: number,
): { readonly end: number; readonly flags: string; readonly pattern: string } | string {
  if (text[start] !== '/') {
    return 'Expected a regular expression literal.';
  }

  let index = start + 1;
  let inCharacterClass = false;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      index += 1;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      index += 1;
      continue;
    }
    if (character === '/' && !inCharacterClass) {
      const flagsStart = index + 1;
      let flagsEnd = flagsStart;
      while (/[a-z]/iu.test(text[flagsEnd] ?? '')) {
        flagsEnd += 1;
      }
      return {
        end: flagsEnd,
        flags: text.slice(flagsStart, flagsEnd),
        pattern: text.slice(start + 1, index),
      };
    }
    index += 1;
  }

  return 'Regular expression literals in annotation arguments must terminate before the annotation closes.';
}

function parseIdentifierName(
  text: string,
  start: number,
  allowDots: boolean,
): { end: number; name: string } | string {
  if (!isIdentifierStart(text[start])) {
    return 'Annotation names must use identifier-like segments such as `unsafe`, `variance`, or `_hkt_`.';
  }

  let index = start + 1;
  while (isIdentifierPart(text[index])) {
    index += 1;
  }

  while (allowDots && text[index] === '.') {
    const segmentStart = index + 1;
    if (!isIdentifierStart(text[segmentStart])) {
      return 'Annotation names must use identifier-like dotted segments such as `layout.value`.';
    }
    index = segmentStart + 1;
    while (isIdentifierPart(text[index])) {
      index += 1;
    }
  }

  return {
    end: index,
    name: text.slice(start, index),
  };
}

class AnnotationValueParser {
  #index = 0;

  constructor(private readonly text: string) {}

  parseArguments(): readonly ParsedAnnotationArgument[] | string {
    const args: ParsedAnnotationArgument[] = [];
    this.#index = skipWhitespace(this.text, this.#index);
    if (this.#index >= this.text.length) {
      return args;
    }

    while (this.#index < this.text.length) {
      const argument = this.parseArgument();
      if (typeof argument === 'string') {
        return argument;
      }
      args.push(argument);
      this.#index = skipWhitespace(this.text, this.#index);
      if (this.#index >= this.text.length) {
        return args;
      }
      if (this.text[this.#index] !== ',') {
        return 'Annotation argument lists must separate items with commas.';
      }
      this.#index += 1;
      this.#index = skipWhitespace(this.text, this.#index);
      if (this.#index >= this.text.length) {
        return 'Annotation argument lists do not allow trailing commas.';
      }
    }

    return args;
  }

  parseValue(): ParsedAnnotationValue | string {
    return this.parseValueAtCurrentIndex();
  }

  private parseArgument(): ParsedAnnotationArgument | string {
    const start = this.#index;
    const namedArgument = this.tryParseNamedArgument();
    if (typeof namedArgument !== 'string' || this.#index !== start) {
      return namedArgument;
    }

    const value = this.parseValueAtCurrentIndex();
    if (typeof value === 'string') {
      return value;
    }

    return {
      kind: 'positional',
      text: this.text.slice(start, this.#index),
      value,
    };
  }

  private parseArrayValue(): ParsedAnnotationArrayValue | string {
    const start = this.#index;
    if (this.text[this.#index] !== '[') {
      return 'Expected an array literal.';
    }
    this.#index += 1;
    this.#index = skipWhitespace(this.text, this.#index);
    const elements: ParsedAnnotationValue[] = [];

    if (this.text[this.#index] === ']') {
      this.#index += 1;
      return {
        elements,
        kind: 'array',
        text: this.text.slice(start, this.#index),
      };
    }

    while (this.#index < this.text.length) {
      const value = this.parseValueAtCurrentIndex();
      if (typeof value === 'string') {
        return value;
      }
      elements.push(value);
      this.#index = skipWhitespace(this.text, this.#index);
      if (this.text[this.#index] === ']') {
        this.#index += 1;
        return {
          elements,
          kind: 'array',
          text: this.text.slice(start, this.#index),
        };
      }
      if (this.text[this.#index] !== ',') {
        return 'Array literals in annotation arguments must separate elements with commas.';
      }
      this.#index += 1;
      this.#index = skipWhitespace(this.text, this.#index);
      if (this.text[this.#index] === ']') {
        return 'Array literals in annotation arguments do not allow trailing commas.';
      }
    }

    return 'Array literals in annotation arguments must close with `]`.';
  }

  private parseBooleanOrIdentifierValue():
    | ParsedAnnotationBooleanValue
    | ParsedAnnotationIdentifierValue
    | ParsedAnnotationMemberValue
    | ParsedAnnotationNullValue
    | ParsedAnnotationUndefinedValue
    | string {
    const parsedName = parseIdentifierName(this.text, this.#index, true);
    if (typeof parsedName === 'string') {
      return parsedName;
    }
    this.#index = parsedName.end;
    if (parsedName.name === 'true' || parsedName.name === 'false') {
      return {
        kind: 'boolean',
        text: parsedName.name,
        value: parsedName.name === 'true',
      };
    }
    if (parsedName.name === 'null') {
      return {
        kind: 'null',
        text: parsedName.name,
      };
    }
    if (parsedName.name === 'undefined') {
      return {
        kind: 'undefined',
        text: parsedName.name,
      };
    }
    if (parsedName.name.includes('.')) {
      return {
        kind: 'member',
        path: parsedName.name.split('.'),
        text: parsedName.name,
      };
    }
    return {
      kind: 'identifier',
      name: parsedName.name,
      text: parsedName.name,
    };
  }

  private parseNumberValue(): ParsedAnnotationNumberValue | string {
    const remaining = this.text.slice(this.#index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?/u.exec(remaining);
    if (!match) {
      return 'Expected a number literal.';
    }
    const numberText = match[0] ?? '';
    this.#index += numberText.length;
    return {
      kind: 'number',
      text: numberText,
      value: Number(numberText),
    };
  }

  private parseBigIntValue(): ParsedAnnotationBigIntValue | string {
    const remaining = this.text.slice(this.#index);
    const match = /^-?(?:0|[1-9][0-9]*)n/u.exec(remaining);
    if (!match) {
      return 'Expected a bigint literal.';
    }
    const bigintText = match[0] ?? '';
    this.#index += bigintText.length;
    return {
      kind: 'bigint',
      text: bigintText,
      value: bigintText.slice(0, -1),
    };
  }

  private parseObjectValue(): ParsedAnnotationObjectValue | string {
    const start = this.#index;
    if (this.text[this.#index] !== '{') {
      return 'Expected an object literal.';
    }
    this.#index += 1;
    this.#index = skipWhitespace(this.text, this.#index);
    const properties: ParsedAnnotationObjectProperty[] = [];

    if (this.text[this.#index] === '}') {
      this.#index += 1;
      return {
        kind: 'object',
        properties,
        text: this.text.slice(start, this.#index),
      };
    }

    while (this.#index < this.text.length) {
      const propertyStart = this.#index;
      let propertyName: string;
      const propertyStartChar = this.text[this.#index];
      if (propertyStartChar === '"' || propertyStartChar === "'") {
        const parsedName = this.parseStringValue();
        if (typeof parsedName === 'string') {
          return parsedName;
        }
        propertyName = parsedName.value;
      } else {
        const parsedName = parseIdentifierName(this.text, this.#index, false);
        if (typeof parsedName === 'string') {
          return 'Object literals in annotation arguments require identifier or string literal property names.';
        }
        this.#index = parsedName.end;
        propertyName = parsedName.name;
      }
      this.#index = skipWhitespace(this.text, this.#index);
      if (this.text[this.#index] !== ':') {
        return `Object literal property \`${propertyName}\` must use \`name: value\` syntax.`;
      }
      this.#index += 1;
      this.#index = skipWhitespace(this.text, this.#index);
      const value = this.parseValueAtCurrentIndex();
      if (typeof value === 'string') {
        return value;
      }
      properties.push({
        name: propertyName,
        text: this.text.slice(propertyStart, this.#index),
        value,
      });
      this.#index = skipWhitespace(this.text, this.#index);
      if (this.text[this.#index] === '}') {
        this.#index += 1;
        return {
          kind: 'object',
          properties,
          text: this.text.slice(start, this.#index),
        };
      }
      if (this.text[this.#index] !== ',') {
        return 'Object literals in annotation arguments must separate properties with commas.';
      }
      this.#index += 1;
      this.#index = skipWhitespace(this.text, this.#index);
      if (this.text[this.#index] === '}') {
        return 'Object literals in annotation arguments do not allow trailing commas.';
      }
    }

    return 'Object literals in annotation arguments must close with `}`.';
  }

  private parseStringValue(): ParsedAnnotationStringValue | string {
    const start = this.#index;
    const end = readStringLiteral(this.text, start);
    if (typeof end === 'string') {
      return end;
    }

    const literalText = this.text.slice(start, end);
    this.#index = end;
    try {
      return {
        kind: 'string',
        text: literalText,
        value: JSON.parse(literalText.replace(/^'/u, '"').replace(/'$/u, '"')),
      };
    } catch {
      const quote = literalText[0];
      const innerText = literalText.slice(1, -1);
      const normalized = quote === "'"
        ? `"${innerText.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
        : literalText;
      return {
        kind: 'string',
        text: literalText,
        value: JSON.parse(normalized),
      };
    }
  }

  private parseRegexpValue(): ParsedAnnotationRegexpValue | string {
    const start = this.#index;
    const parsed = readRegExpLiteral(this.text, start);
    if (typeof parsed === 'string') {
      return parsed;
    }
    this.#index = parsed.end;
    return {
      flags: parsed.flags,
      kind: 'regexp',
      pattern: parsed.pattern,
      text: this.text.slice(start, parsed.end),
    };
  }

  private parseValueAtCurrentIndex(): ParsedAnnotationValue | string {
    this.#index = skipWhitespace(this.text, this.#index);
    const character = this.text[this.#index];
    if (character === '"' || character === "'") {
      return this.parseStringValue();
    }
    if (character === '[') {
      return this.parseArrayValue();
    }
    if (character === '{') {
      return this.parseObjectValue();
    }
    if (character === '/') {
      return this.parseRegexpValue();
    }
    if (character === '-' || isDigit(character)) {
      const bigintValue = this.parseBigIntValue();
      if (typeof bigintValue !== 'string') {
        return bigintValue;
      }
      if (bigintValue !== 'Expected a bigint literal.') {
        return bigintValue;
      }
      this.#index = skipWhitespace(this.text, this.#index);
      return this.parseNumberValue();
    }
    if (isIdentifierStart(character)) {
      return this.parseBooleanOrIdentifierValue();
    }
    return 'Annotation arguments must use identifiers, member references, strings, numbers, bigint literals, booleans, null, undefined, regular expressions, arrays, or objects.';
  }

  private tryParseNamedArgument(): ParsedAnnotationArgument | string {
    const start = this.#index;
    const parsedName = parseIdentifierName(this.text, this.#index, false);
    if (typeof parsedName === 'string') {
      return parsedName;
    }

    this.#index = parsedName.end;
    const afterName = skipWhitespace(this.text, this.#index);
    if (this.text[afterName] !== ':') {
      this.#index = start;
      return 'not-a-named-argument';
    }

    this.#index = skipWhitespace(this.text, afterName + 1);
    const value = this.parseValueAtCurrentIndex();
    if (typeof value === 'string') {
      return value;
    }

    return {
      kind: 'named',
      name: parsedName.name,
      text: this.text.slice(start, this.#index),
      value,
    };
  }
}

function splitAnnotationItems(
  innerText: string,
): readonly { end: number; start: number; text: string }[] | string {
  const items: Array<{ end: number; start: number; text: string }> = [];
  let itemStart = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = 0; index < innerText.length; index += 1) {
    const character = innerText[index];
    if (character === '"' || character === "'") {
      const stringEnd = readStringLiteral(innerText, index);
      if (typeof stringEnd === 'string') {
        return stringEnd;
      }
      index = stringEnd - 1;
      continue;
    }
    if (character === '/') {
      const regexpEnd = readRegExpLiteral(innerText, index);
      if (typeof regexpEnd === 'string') {
        return regexpEnd;
      }
      index = regexpEnd.end - 1;
      continue;
    }

    if (character === '(') {
      parenDepth += 1;
      continue;
    }
    if (character === ')') {
      if (parenDepth === 0) {
        return 'Annotation arguments contain an unexpected closing parenthesis.';
      }
      parenDepth -= 1;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      if (bracketDepth === 0) {
        return 'Annotation arguments contain an unexpected closing bracket.';
      }
      bracketDepth -= 1;
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      if (braceDepth === 0) {
        return 'Annotation arguments contain an unexpected closing brace.';
      }
      braceDepth -= 1;
      continue;
    }
    if (character === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const trimmed = trimRange(innerText, itemStart, index);
      if (trimmed.text.length === 0) {
        return 'Annotation lists do not allow empty items.';
      }
      items.push(trimmed);
      itemStart = index + 1;
    }
  }

  if (parenDepth !== 0) {
    return 'Annotation arguments must use balanced parentheses.';
  }
  if (bracketDepth !== 0) {
    return 'Annotation arguments must use balanced brackets.';
  }
  if (braceDepth !== 0) {
    return 'Annotation arguments must use balanced braces.';
  }

  const trimmed = trimRange(innerText, itemStart, innerText.length);
  if (trimmed.text.length === 0) {
    return 'Annotation lists do not allow empty items.';
  }
  items.push(trimmed);
  return items;
}

export function parseAnnotationArgumentsText(
  argumentsText: string,
): readonly ParsedAnnotationArgument[] | string {
  return new AnnotationValueParser(argumentsText).parseArguments();
}

export function parseAnnotationItemText(
  itemText: string,
): ParsedAnnotationSyntax | string {
  const trimmed = itemText.trim();
  const parsedName = parseIdentifierName(trimmed, 0, true);
  if (typeof parsedName === 'string') {
    return parsedName;
  }

  let index = skipWhitespace(trimmed, parsedName.end);
  if (index >= trimmed.length) {
    return {
      name: parsedName.name,
      path: parsedName.name.split('.'),
      text: trimmed,
    };
  }

  if (trimmed[index] !== '(') {
    return 'Annotation items may only contain a name and an optional argument list.';
  }

  const argumentsStart = index + 1;
  let parenDepth = 1;
  let bracketDepth = 0;
  let braceDepth = 0;
  index += 1;
  while (index < trimmed.length) {
    const character = trimmed[index];
    if (character === '"' || character === "'") {
      const stringEnd = readStringLiteral(trimmed, index);
      if (typeof stringEnd === 'string') {
        return stringEnd;
      }
      index = stringEnd;
      continue;
    }
    if (character === '/') {
      const regexpEnd = readRegExpLiteral(trimmed, index);
      if (typeof regexpEnd === 'string') {
        return regexpEnd;
      }
      index = regexpEnd.end;
      continue;
    }
    if (character === '(') {
      parenDepth += 1;
      index += 1;
      continue;
    }
    if (character === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        break;
      }
      if (parenDepth < 0) {
        return 'Annotation arguments contain an unexpected closing parenthesis.';
      }
      index += 1;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      index += 1;
      continue;
    }
    if (character === ']') {
      if (bracketDepth === 0) {
        return 'Annotation arguments contain an unexpected closing bracket.';
      }
      bracketDepth -= 1;
      index += 1;
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (character === '}') {
      if (braceDepth === 0) {
        return 'Annotation arguments contain an unexpected closing brace.';
      }
      braceDepth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }

  if (index >= trimmed.length || parenDepth !== 0) {
    return 'Annotation arguments must use balanced parentheses.';
  }
  if (bracketDepth !== 0) {
    return 'Annotation arguments must use balanced brackets.';
  }
  if (braceDepth !== 0) {
    return 'Annotation arguments must use balanced braces.';
  }
  if (trimmed.slice(index + 1).trim().length > 0) {
    return 'Annotation items may only contain a name and an optional argument list.';
  }

  const argumentsText = trimmed.slice(argumentsStart, index).trim();
  const parsedArguments = parseAnnotationArgumentsText(argumentsText);
  if (typeof parsedArguments === 'string') {
    return parsedArguments;
  }

  return {
    arguments: parsedArguments.length === 0 ? [] : parsedArguments,
    argumentsText,
    name: parsedName.name,
    path: parsedName.name.split('.'),
    text: trimmed,
  };
}

export function parseAnnotationCommentText(
  commentText: string,
): { annotations: readonly ParsedAnnotationSyntax[]; text: string } | string | null {
  if (!ANNOTATION_COMMENT_PATTERN.test(commentText)) {
    return null;
  }

  const openMarkerText = commentText.match(ANNOTATION_COMMENT_PATTERN)?.[0];
  if (!openMarkerText) {
    return null;
  }

  const bodyStart = openMarkerText.length;
  let closingBracketIndex = -1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = bodyStart; index < commentText.length; index += 1) {
    const character = commentText[index];
    if (character === '"' || character === "'") {
      const stringEnd = readStringLiteral(commentText, index);
      if (typeof stringEnd === 'string') {
        return stringEnd;
      }
      index = stringEnd - 1;
      continue;
    }
    if (character === '/') {
      const regexpEnd = readRegExpLiteral(commentText, index);
      if (typeof regexpEnd === 'string') {
        return regexpEnd;
      }
      index = regexpEnd.end - 1;
      continue;
    }

    if (character === '(') {
      parenDepth += 1;
      continue;
    }
    if (character === ')') {
      if (parenDepth === 0) {
        return 'Annotation arguments contain an unexpected closing parenthesis.';
      }
      parenDepth -= 1;
      continue;
    }
    if (character === '[') {
      bracketDepth += 1;
      continue;
    }
    if (character === ']') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        closingBracketIndex = index;
        break;
      }
      if (bracketDepth === 0) {
        return 'Annotation arguments contain an unexpected closing bracket.';
      }
      bracketDepth -= 1;
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      continue;
    }
    if (character === '}') {
      if (braceDepth === 0) {
        return 'Annotation arguments contain an unexpected closing brace.';
      }
      braceDepth -= 1;
      continue;
    }
  }

  if (closingBracketIndex === -1) {
    return 'Annotation comments must close with `]`.';
  }
  if (parenDepth !== 0) {
    return 'Annotation arguments must use balanced parentheses.';
  }
  if (bracketDepth !== 0) {
    return 'Annotation arguments must use balanced brackets.';
  }
  if (braceDepth !== 0) {
    return 'Annotation arguments must use balanced braces.';
  }

  const trimmedBody = trimRange(commentText, bodyStart, closingBracketIndex);
  const innerText = trimmedBody.text;
  if (innerText.length === 0) {
    return 'Annotation comments must contain at least one annotation item.';
  }

  const splitItems = splitAnnotationItems(innerText);
  if (typeof splitItems === 'string') {
    return splitItems;
  }

  const annotations: ParsedAnnotationSyntax[] = [];
  for (const item of splitItems) {
    const parsedAnnotation = parseAnnotationItemText(item.text);
    if (typeof parsedAnnotation === 'string') {
      return parsedAnnotation;
    }
    const parsedName = parseIdentifierName(item.text, 0, true);
    if (typeof parsedName === 'string') {
      return parsedName;
    }
    const absoluteStart = trimmedBody.start + item.start;
    annotations.push({
      ...parsedAnnotation,
      nameRange: {
        start: absoluteStart,
        end: absoluteStart + parsedName.end,
      },
      range: {
        start: absoluteStart,
        end: trimmedBody.start + item.end,
      },
    });
  }

  return {
    annotations,
    text: commentText.trim(),
  };
}

interface ScannedComment {
  readonly endLine: number;
  readonly entry?: ParsedAnnotationEntry;
  readonly kind: 'annotation' | 'annotation-parse-error' | 'banned-ts-pragma' | 'other-comment';
  readonly range: AnnotationTextRange;
  readonly standalone: boolean;
  readonly startLine: number;
}

function isAnnotationTargetNode(node: ts.Node): boolean {
  return ts.isStatement(node) ||
    ts.isBindingElement(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassElement(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isImportClause(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isTypeElement(node);
}

function getNodeStartLine(node: ts.Node): number {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function parseTypeScriptPragma(commentText: string): string | undefined {
  if (commentText.startsWith('//')) {
    const match = commentText.match(/^\/\/\s*(@ts-[a-z-]+)\b/u);
    if (match?.[1]) {
      return match[1];
    }

    const tripleSlashDirective = commentText
      .trim()
      .match(/^\/\/\/\s*<(?:reference|amd-(?:module|dependency))\b[^>]*>/u);
    return tripleSlashDirective?.[0];
  }

  if (!commentText.startsWith('/*')) {
    return undefined;
  }

  const withoutOpen = commentText.replace(/^\/\*+\s?/u, '');
  const withoutClose = withoutOpen.replace(/\*\/\s*$/u, '');

  for (const rawLine of withoutClose.split(/\r?\n/u)) {
    const line = rawLine.trimStart().replace(/^\*\s?/u, '');
    if (line.length === 0) {
      continue;
    }

    const match = line.match(/^(@ts-[a-z-]+)\b/u);
    return match?.[1];
  }

  return undefined;
}

function createAnnotationParseError(
  line: number,
  text: string,
  message: string,
): ParsedAnnotationParseError {
  return {
    kind: 'annotation-parse-error',
    line,
    message,
    text,
  };
}

function absolutizeAnnotationComment(
  comment: { annotations: readonly ParsedAnnotationSyntax[]; text: string },
  absoluteStart: number,
  line: number,
  range: AnnotationTextRange,
): ParsedAnnotationComment {
  return {
    annotations: comment.annotations.map((annotation) => ({
      ...annotation,
      nameRange: annotation.nameRange
        ? {
          start: absoluteStart + annotation.nameRange.start,
          end: absoluteStart + annotation.nameRange.end,
        }
        : undefined,
      range: annotation.range
        ? {
          start: absoluteStart + annotation.range.start,
          end: absoluteStart + annotation.range.end,
        }
        : undefined,
    })),
    kind: 'annotation',
    line,
    range,
    text: comment.text,
  };
}

function parseAnnotationEntry(
  commentText: string,
  line: number,
  standalone: boolean,
  absoluteStart: number,
  range: AnnotationTextRange,
): ParsedAnnotationEntry | undefined {
  if (ANNOTATION_COMMENT_PATTERN.test(commentText)) {
    if (!standalone) {
      return createAnnotationParseError(
        line,
        commentText.trim(),
        'Annotation comments must appear on their own line.',
      );
    }

    const parsedComment = parseAnnotationCommentText(commentText);
    if (typeof parsedComment === 'string') {
      return createAnnotationParseError(line, commentText.trim(), parsedComment);
    }
    if (parsedComment) {
      return absolutizeAnnotationComment(parsedComment, absoluteStart, line, range);
    }
  }

  const tsPragmaText = parseTypeScriptPragma(commentText);
  if (tsPragmaText) {
    return {
      kind: 'banned-ts-pragma',
      line,
      text: tsPragmaText,
    };
  }

  return undefined;
}

function traverseNode(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => traverseNode(child, visitor));
}

export function createAnnotationLookup(sourceFile: ts.SourceFile): AnnotationLookup {
  const entriesByLine = new Map<number, ParsedAnnotationEntry[]>();
  const entries: ParsedAnnotationEntry[] = [];
  const scannedComments: ScannedComment[] = [];
  const candidateNodesByStartLine = new Map<number, ts.Node[]>();
  const blocksByTargetNode = new WeakMap<ts.Node, ParsedAnnotationBlock>();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    sourceFile.languageVariant,
    sourceFile.text,
  );
  const lineStarts = sourceFile.getLineStarts();

  traverseNode(sourceFile, (node) => {
    if (!isAnnotationTargetNode(node)) {
      return;
    }

    const startLine = getNodeStartLine(node);
    const lineNodes = candidateNodesByStartLine.get(startLine);
    if (lineNodes) {
      lineNodes.push(node);
    } else {
      candidateNodesByStartLine.set(startLine, [node]);
    }
  });

  if (sourceFile.isDeclarationFile) {
    const sourceLines = sourceFile.text.split(/\r?\n/u);
    let absoluteLineStart = 0;
    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
      const rawLine = sourceLines[lineIndex] ?? '';
      const trimmedStart = rawLine.trimStart();
      if (!trimmedStart.startsWith('//')) {
        absoluteLineStart += rawLine.length + 1;
        continue;
      }

      const trimmedOffset = rawLine.indexOf(trimmedStart);
      const start = absoluteLineStart + Math.max(trimmedOffset, 0);
      const end = absoluteLineStart + rawLine.length;
      const line = lineIndex + 1;
      const range = { start, end };
      const entry = parseAnnotationEntry(trimmedStart, line, true, start, range);
      scannedComments.push({
        endLine: line,
        entry,
        kind: entry?.kind ?? 'other-comment',
        range,
        standalone: true,
        startLine: line,
      });

      if (entry) {
        const lineEntries = entriesByLine.get(line);
        if (lineEntries) {
          lineEntries.push(entry);
        } else {
          entriesByLine.set(line, [entry]);
        }
        entries.push(entry);
      }

      absoluteLineStart += rawLine.length + 1;
    }
  }

  while (true) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) {
      break;
    }

    if (
      token !== ts.SyntaxKind.MultiLineCommentTrivia &&
      !(token === ts.SyntaxKind.SingleLineCommentTrivia && !sourceFile.isDeclarationFile)
    ) {
      continue;
    }

    const tokenStart = scanner.getTokenPos();
    const tokenText = scanner.getTokenText();
    const tokenEnd = tokenStart + tokenText.length;
    const startLineInfo = sourceFile.getLineAndCharacterOfPosition(tokenStart);
    const endLineInfo = sourceFile.getLineAndCharacterOfPosition(tokenEnd);
    const line = startLineInfo.line + 1;
    const endLine = endLineInfo.line + 1;
    const lineStart = lineStarts[startLineInfo.line] ?? tokenStart;
    const standalone = sourceFile.text.slice(lineStart, tokenStart).trim().length === 0;
    const range = { start: tokenStart, end: tokenEnd };
    const entry = parseAnnotationEntry(tokenText, line, standalone, tokenStart, range);

    scannedComments.push({
      endLine,
      entry,
      kind: entry?.kind ?? 'other-comment',
      range,
      standalone,
      startLine: line,
    });

    if (!entry) {
      continue;
    }

    const lineEntries = entriesByLine.get(line);
    if (lineEntries) {
      lineEntries.push(entry);
    } else {
      entriesByLine.set(line, [entry]);
    }
    entries.push(entry);
  }

  if (sourceFile.languageVariant === ts.LanguageVariant.JSX) {
    const existingCommentRanges = new Set(
      scannedComments.map((comment) => `${comment.range.start}:${comment.range.end}`),
    );
    const sourceLines = sourceFile.text.split(/\r?\n/u);
    let absoluteLineStart = 0;
    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
      const rawLine = sourceLines[lineIndex] ?? '';
      const trimmedStart = rawLine.trimStart();
      if (!trimmedStart.startsWith('//')) {
        absoluteLineStart += rawLine.length + 1;
        continue;
      }

      const trimmedOffset = rawLine.indexOf(trimmedStart);
      const start = absoluteLineStart + Math.max(trimmedOffset, 0);
      const end = absoluteLineStart + rawLine.length;
      const rangeKey = `${start}:${end}`;
      if (existingCommentRanges.has(rangeKey)) {
        absoluteLineStart += rawLine.length + 1;
        continue;
      }

      const line = lineIndex + 1;
      const range = { start, end };
      const entry = parseAnnotationEntry(trimmedStart, line, true, start, range);
      scannedComments.push({
        endLine: line,
        entry,
        kind: entry?.kind ?? 'other-comment',
        range,
        standalone: true,
        startLine: line,
      });

      if (entry) {
        const lineEntries = entriesByLine.get(line);
        if (lineEntries) {
          lineEntries.push(entry);
        } else {
          entriesByLine.set(line, [entry]);
        }
        entries.push(entry);
      }

      absoluteLineStart += rawLine.length + 1;
    }

    scannedComments.sort((left, right) => left.range.start - right.range.start);
  }

  const annotationBlocks: ParsedAnnotationBlock[] = [];
  for (let index = 0; index < scannedComments.length; index += 1) {
    const scannedComment = scannedComments[index];
    if (scannedComment.kind !== 'annotation' || !scannedComment.standalone) {
      continue;
    }

    const previousComment = scannedComments[index - 1];
    if (
      previousComment &&
      previousComment.kind === 'annotation' &&
      previousComment.standalone &&
      previousComment.endLine + 1 === scannedComment.startLine
    ) {
      continue;
    }

    const blockComments: ScannedComment[] = [scannedComment];
    let currentIndex = index + 1;
    while (currentIndex < scannedComments.length) {
      const candidate = scannedComments[currentIndex];
      const previousBlockComment = blockComments[blockComments.length - 1];
      if (
        candidate.kind !== 'annotation' ||
        !candidate.standalone ||
        previousBlockComment.endLine + 1 !== candidate.startLine
      ) {
        break;
      }

      blockComments.push(candidate);
      currentIndex += 1;
    }

    const annotations = blockComments.flatMap((comment) =>
      comment.entry?.kind === 'annotation' ? comment.entry.annotations : []
    );
    const startLine = blockComments[0]?.startLine ?? scannedComment.startLine;
    const endLine = blockComments[blockComments.length - 1]?.endLine ?? scannedComment.endLine;
    const targetNode = candidateNodesByStartLine.get(endLine + 1)?.[0];
    const block: ParsedAnnotationBlock = {
      annotations,
      endLine,
      range: {
        start: blockComments[0]?.range.start ?? scannedComment.range.start,
        end: blockComments[blockComments.length - 1]?.range.end ?? scannedComment.range.end,
      },
      startLine,
      targetNode,
      text: blockComments.map((comment) => comment.entry?.text ?? '').join('\n'),
    };
    annotationBlocks.push(block);
    if (targetNode) {
      blocksByTargetNode.set(targetNode, block);
    }
  }

  return {
    getAttachedAnnotationBlock(node: ts.Node): ParsedAnnotationBlock | undefined {
      return blocksByTargetNode.get(node);
    },
    getAttachedAnnotations(node: ts.Node): readonly ParsedAnnotation[] {
      return blocksByTargetNode.get(node)?.annotations ?? [];
    },
    getBlocks(): readonly ParsedAnnotationBlock[] {
      return annotationBlocks;
    },
    getEntries(): readonly ParsedAnnotationEntry[] {
      return entries;
    },
    getEntriesForLine(line: number): readonly ParsedAnnotationEntry[] {
      return entriesByLine.get(line) ?? [];
    },
    hasAttachedAnnotation(node: ts.Node, name: string): boolean {
      return blocksByTargetNode.get(node)?.annotations.some((annotation) =>
        annotation.name === name
      ) ??
        false;
    },
  };
}
