import type { PreparedSourceFile } from '../frontend/project_frontend.ts';
import { mapProgramPositionToSource } from '../frontend/project_frontend.ts';

interface SourceMapV3 {
  version: 3;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
}

interface DecodedSegment {
  generatedColumn: number;
  nameIndex?: number;
  originalColumn?: number;
  originalLine?: number;
  sourceIndex?: number;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = new Map([...BASE64_ALPHABET].map((character, index) => [character, index]));

function toVlqSigned(value: number): number {
  return value < 0 ? ((-value) << 1) + 1 : value << 1;
}

function fromVlqSigned(value: number): number {
  const isNegative = (value & 1) === 1;
  const shifted = value >> 1;
  return isNegative ? -shifted : shifted;
}

function encodeVlqValue(value: number): string {
  let remaining = toVlqSigned(value);
  let output = '';

  do {
    let digit = remaining & 31;
    remaining >>= 5;
    if (remaining > 0) {
      digit |= 32;
    }
    output += BASE64_ALPHABET[digit];
  } while (remaining > 0);

  return output;
}

function decodeVlqValue(text: string, startIndex: number): { nextIndex: number; value: number } {
  let index = startIndex;
  let shift = 0;
  let value = 0;

  while (index < text.length) {
    const digit = BASE64_LOOKUP.get(text[index]!);
    if (digit === undefined) {
      throw new Error(`Invalid source-map VLQ character ${JSON.stringify(text[index])}.`);
    }

    value += (digit & 31) << shift;
    index += 1;
    if ((digit & 32) === 0) {
      return { nextIndex: index, value: fromVlqSigned(value) };
    }
    shift += 5;
  }

  throw new Error('Unterminated source-map VLQ segment.');
}

function decodeMappings(mappings: string): DecodedSegment[][] {
  if (mappings.length === 0) {
    return [[]];
  }

  const lines = mappings.split(';');
  const decoded: DecodedSegment[][] = [];

  let previousSourceIndex = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  let previousNameIndex = 0;

  for (const line of lines) {
    const segments: DecodedSegment[] = [];
    let previousGeneratedColumn = 0;

    if (line.length > 0) {
      for (const rawSegment of line.split(',')) {
        if (rawSegment.length === 0) {
          continue;
        }

        let cursor = 0;
        const generatedColumnResult = decodeVlqValue(rawSegment, cursor);
        cursor = generatedColumnResult.nextIndex;
        previousGeneratedColumn += generatedColumnResult.value;
        const segment: DecodedSegment = {
          generatedColumn: previousGeneratedColumn,
        };

        if (cursor < rawSegment.length) {
          const sourceIndexResult = decodeVlqValue(rawSegment, cursor);
          cursor = sourceIndexResult.nextIndex;
          previousSourceIndex += sourceIndexResult.value;
          segment.sourceIndex = previousSourceIndex;

          const originalLineResult = decodeVlqValue(rawSegment, cursor);
          cursor = originalLineResult.nextIndex;
          previousOriginalLine += originalLineResult.value;
          segment.originalLine = previousOriginalLine;

          const originalColumnResult = decodeVlqValue(rawSegment, cursor);
          cursor = originalColumnResult.nextIndex;
          previousOriginalColumn += originalColumnResult.value;
          segment.originalColumn = previousOriginalColumn;

          if (cursor < rawSegment.length) {
            const nameIndexResult = decodeVlqValue(rawSegment, cursor);
            previousNameIndex += nameIndexResult.value;
            segment.nameIndex = previousNameIndex;
          }
        }

        segments.push(segment);
      }
    }

    decoded.push(segments);
  }

  return decoded;
}

function encodeMappings(lines: readonly DecodedSegment[][]): string {
  let previousSourceIndex = 0;
  let previousOriginalLine = 0;
  let previousOriginalColumn = 0;
  let previousNameIndex = 0;

  return lines.map((segments) => {
    let previousGeneratedColumn = 0;

    return segments.map((segment) => {
      let encoded = encodeVlqValue(segment.generatedColumn - previousGeneratedColumn);
      previousGeneratedColumn = segment.generatedColumn;

      if (
        segment.sourceIndex !== undefined && segment.originalLine !== undefined &&
        segment.originalColumn !== undefined
      ) {
        encoded += encodeVlqValue(segment.sourceIndex - previousSourceIndex);
        previousSourceIndex = segment.sourceIndex;

        encoded += encodeVlqValue(segment.originalLine - previousOriginalLine);
        previousOriginalLine = segment.originalLine;

        encoded += encodeVlqValue(segment.originalColumn - previousOriginalColumn);
        previousOriginalColumn = segment.originalColumn;

        if (segment.nameIndex !== undefined) {
          encoded += encodeVlqValue(segment.nameIndex - previousNameIndex);
          previousNameIndex = segment.nameIndex;
        }
      }

      return encoded;
    }).join(',');
  }).join(';');
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function positionForLineAndColumn(
  lineStarts: readonly number[],
  line: number,
  column: number,
): number {
  const lineStart = lineStarts[line] ?? lineStarts[lineStarts.length - 1] ?? 0;
  return lineStart + column;
}

function lineAndColumnForPosition(
  lineStarts: readonly number[],
  position: number,
): { column: number; line: number } {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const lineStart = lineStarts[mid]!;
    const nextLineStart = lineStarts[mid + 1] ?? Number.POSITIVE_INFINITY;

    if (position < lineStart) {
      high = mid - 1;
      continue;
    }
    if (position >= nextLineStart) {
      low = mid + 1;
      continue;
    }

    return {
      line: mid,
      column: position - lineStart,
    };
  }

  const fallbackLine = Math.max(0, lineStarts.length - 1);
  return {
    line: fallbackLine,
    column: Math.max(0, position - (lineStarts[fallbackLine] ?? 0)),
  };
}

function stripSourceMappingUrl(code: string): string {
  return code.replace(/\n\/\/# sourceMappingURL=.*$/u, '');
}

export interface ComposedSourceMapResult {
  code: string;
  map: SourceMapV3;
  mapText: string;
}

export function composeTranspiledSourceMapToOriginal(
  code: string,
  emittedSourceMapText: string,
  preparedFile: PreparedSourceFile,
  sourcePath: string,
): ComposedSourceMapResult {
  const emittedSourceMap = JSON.parse(emittedSourceMapText) as SourceMapV3;
  const decodedMappings = decodeMappings(emittedSourceMap.mappings);
  const rewrittenLineStarts = computeLineStarts(preparedFile.rewrittenText);
  const originalLineStarts = computeLineStarts(preparedFile.originalText);

  const remappedSegments = decodedMappings.map((line) =>
    line.map((segment) => {
      if (
        segment.sourceIndex === undefined || segment.originalLine === undefined ||
        segment.originalColumn === undefined
      ) {
        return {
          generatedColumn: segment.generatedColumn,
        };
      }

      const rewrittenPosition = positionForLineAndColumn(
        rewrittenLineStarts,
        segment.originalLine,
        segment.originalColumn,
      );
      const mappedSource = mapProgramPositionToSource(preparedFile, rewrittenPosition);
      const mappedLineAndColumn = lineAndColumnForPosition(
        originalLineStarts,
        mappedSource.position,
      );

      return {
        generatedColumn: segment.generatedColumn,
        originalColumn: mappedLineAndColumn.column,
        originalLine: mappedLineAndColumn.line,
        sourceIndex: 0,
      };
    })
  );

  const composedMap: SourceMapV3 = {
    file: emittedSourceMap.file,
    mappings: encodeMappings(remappedSegments),
    names: [],
    sources: [sourcePath],
    sourcesContent: [preparedFile.originalText],
    version: 3,
  };

  return {
    code: stripSourceMappingUrl(code),
    map: composedMap,
    mapText: `${JSON.stringify(composedMap)}\n`,
  };
}

export function inlineSourceMapComment(mapText: string): string {
  const base64 = btoa(mapText);
  return `//# sourceMappingURL=data:application/json;base64,${base64}`;
}

export function stripTrailingSourceMapComment(code: string): string {
  return stripSourceMappingUrl(code);
}
