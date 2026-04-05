import ts from 'typescript';

import { createAnnotationLookup } from '../annotation_syntax.ts';
import { fromFileUrl } from '../platform/path.ts';
import type {
  MacroAnnotation,
  MacroClassDeclSyntax,
  MacroClassFieldSyntax,
  MacroDefinition,
  MacroInterfaceDeclSyntax,
  MacroObjectTypeMemberSyntax,
  MacroObjectTypeSyntax,
  MacroReflectedDeclarationShape,
  MacroReflectedFieldShape,
  MacroReflectedTypeShape,
  MacroSyntaxNode,
  MacroTypeAliasDeclSyntax,
} from './macro_api.ts';
import { macroSignature } from './macro_api.ts';
import { attachMacroFactoryMetadata } from './macro_api_internal.ts';
import { getHostDeclaration, getHostNode } from './macro_syntax_internal.ts';

const DERIVE_MACRO_FILE_NAME = fromFileUrl(import.meta.url);
const DERIVE_SIGNATURE = macroSignature.oneOf(
  macroSignature.case('class', macroSignature.classDecl('target')),
  macroSignature.case('interface', macroSignature.interfaceDecl('target')),
  macroSignature.case('typeAlias', macroSignature.typeAliasDecl('target')),
);
const DECODE_SIGNATURE = macroSignature.oneOf(
  macroSignature.case('class', macroSignature.classDecl('target')),
  macroSignature.case('interface', macroSignature.interfaceDecl('target')),
  macroSignature.case('typeAlias', macroSignature.typeAliasDecl('target')),
);
const TAGGED_SIGNATURE = macroSignature.of(macroSignature.typeAliasDecl('target'));
type DeriveContext = Parameters<MacroDefinition<typeof DERIVE_SIGNATURE>['expand']>[0];

type PrimitiveFieldKind = 'bigint' | 'boolean' | 'number' | 'string';
type DerivedMacroName = 'codec' | 'decode' | 'encode' | 'eq' | 'hash';
type SupportedDerivedType =
  | { readonly kind: 'array'; readonly element: SupportedDerivedType }
  | { readonly kind: 'named'; readonly typeName: string }
  | { readonly kind: 'option'; readonly value: SupportedDerivedType }
  | { readonly kind: 'primitive'; readonly primitiveKind: PrimitiveFieldKind }
  | {
    readonly err: SupportedDerivedType;
    readonly kind: 'result';
    readonly ok: SupportedDerivedType;
  }
  | { readonly elements: readonly SupportedDerivedType[]; readonly kind: 'tuple' };

interface DerivedField {
  readonly eqHelper: string;
  readonly hashHelper: string;
  readonly name: string;
  readonly optional: boolean;
}

interface TaggedVariantField {
  readonly name: string;
  readonly optional: boolean;
  readonly typeText: string;
}

interface TaggedVariant {
  readonly constructorName: string;
  readonly constructorTypeParametersText: string;
  readonly kind: 'class' | 'object';
  readonly payloadFields: readonly TaggedVariantField[];
  readonly predicateName: string;
  readonly predicateConditionText: string;
  readonly predicateNarrowTypeText: string;
  readonly predicateTypeParametersText: string;
  readonly predicateValueTypeText: string;
  readonly returnExpressionText: string;
}

interface DecodedField {
  readonly decoderText: string;
  readonly localName: string;
  readonly optional: boolean;
  readonly wireName: string;
}

interface EncodedField {
  readonly encoderText: string;
  readonly localName: string;
  readonly optional: boolean;
  readonly wireName: string;
}

interface CodecField {
  readonly decodeText: string;
  readonly encodeText: string;
  readonly localName: string;
  readonly optional: boolean;
  readonly wireName: string;
}

interface TaggedDerivedVariant<TField> {
  readonly fields: readonly TField[];
  readonly tag: string;
}

const CLASS_DECODE_VALUE_PLACEHOLDER = '__sts_decoded_value__';

function attachDeriveFactory<T extends () => MacroDefinition>(factory: T): T {
  return attachMacroFactoryMetadata(factory, {
    form: 'decl',
    moduleFileName: DERIVE_MACRO_FILE_NAME,
  }) as T;
}

function findAnnotation(
  annotations: readonly MacroAnnotation[],
  name: string,
): MacroAnnotation | null {
  return annotations.find((annotation) => annotation.name === name) ?? null;
}

function annotationIdentifierArgument(annotation: MacroAnnotation): string | null {
  const [firstArgument] = annotation.arguments ?? [];
  return firstArgument?.value.kind === 'identifier' ? firstArgument.value.name : null;
}

function annotationStringArgument(annotation: MacroAnnotation): string | null {
  const [firstArgument] = annotation.arguments ?? [];
  return firstArgument?.value.kind === 'string' ? firstArgument.value.value : null;
}

function annotationDiagnosticNode(
  declaration: MacroClassDeclSyntax,
  annotation: MacroAnnotation,
): MacroSyntaxNode | null {
  const hostDeclaration = getHostDeclaration(declaration);
  const sourceFile = hostDeclaration.getSourceFile();
  const parsedAnnotation = createAnnotationLookup(sourceFile)
    .getAttachedAnnotations(hostDeclaration)
    .find((attached) => attached.name === annotation.name && attached.text === annotation.text);
  if (!parsedAnnotation?.range) {
    return null;
  }

  return {
    kind: 'annotation',
    span: {
      fileName: sourceFile.fileName,
      start: parsedAnnotation.range.start,
      end: parsedAnnotation.range.end,
    },
  };
}

function propertyAccessText(receiverName: string, propertyName: string): string {
  const receiver = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(receiverName.trim())
    ? receiverName.trim()
    : `(${receiverName.trim()})`;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(propertyName)
    ? `${receiver}.${propertyName}`
    : `${receiver}[${JSON.stringify(propertyName)}]`;
}

function propertyKeyText(propertyName: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(propertyName)
    ? propertyName
    : JSON.stringify(propertyName);
}

function primitiveKindForTypeText(typeText: string): PrimitiveFieldKind | null {
  const normalized = typeText.trim();
  switch (normalized) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return normalized as PrimitiveFieldKind;
    default:
      return null;
  }
}

function parseGenericTypeArgument(text: string, typeName: string): string | null {
  const parsed = parseGenericTypeArguments(text, typeName);
  return parsed?.length === 1 ? parsed[0]! : null;
}

function parseGenericTypeArguments(text: string, typeName: string): readonly string[] | null {
  const trimmed = text.trim();
  const prefix = `${typeName}<`;
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith('>')) {
    return null;
  }

  let angleDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;
  let segmentStart = prefix.length;
  const args: string[] = [];

  for (let index = typeName.length; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;

    if (inString !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }

    switch (char) {
      case '<':
        angleDepth += 1;
        continue;
      case '>':
        angleDepth -= 1;
        if (angleDepth < 0) {
          return null;
        }
        if (angleDepth === 0) {
          if (index !== trimmed.length - 1) {
            return null;
          }
          const segment = trimmed.slice(segmentStart, index).trim();
          if (segment.length === 0) {
            return null;
          }
          args.push(segment);
        }
        continue;
      case '{':
        braceDepth += 1;
        continue;
      case '}':
        braceDepth -= 1;
        if (braceDepth < 0) {
          return null;
        }
        continue;
      case '[':
        bracketDepth += 1;
        continue;
      case ']':
        bracketDepth -= 1;
        if (bracketDepth < 0) {
          return null;
        }
        continue;
      case '(':
        parenDepth += 1;
        continue;
      case ')':
        parenDepth -= 1;
        if (parenDepth < 0) {
          return null;
        }
        continue;
      case ',':
        if (angleDepth === 1 && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
          const segment = trimmed.slice(segmentStart, index).trim();
          if (segment.length === 0) {
            return null;
          }
          args.push(segment);
          segmentStart = index + 1;
        }
        continue;
      default:
        continue;
    }
  }

  if (
    angleDepth !== 0 || braceDepth !== 0 || bracketDepth !== 0 || parenDepth !== 0 ||
    inString !== null
  ) {
    return null;
  }

  return args;
}

function parseArrayInnerTypeText(typeText: string): string | null {
  const trimmed = typeText.trim();
  if (trimmed.startsWith('readonly ') && trimmed.endsWith('[]')) {
    return trimmed.slice('readonly '.length, -2).trim();
  }
  if (trimmed.endsWith('[]')) {
    return trimmed.slice(0, -2).trim();
  }
  return parseGenericTypeArgument(trimmed, 'Array') ??
    parseGenericTypeArgument(trimmed, 'ReadonlyArray');
}

function parseTupleElementTypeTexts(typeText: string): readonly string[] | null {
  const trimmed = typeText.trim();
  const tupleText = trimmed.startsWith('readonly [') ? trimmed.slice('readonly '.length) : trimmed;
  if (!tupleText.startsWith('[') || !tupleText.endsWith(']')) {
    return null;
  }

  const body = tupleText.slice(1, -1).trim();
  if (body.length === 0) {
    return [];
  }

  let angleDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;
  let segmentStart = 0;
  const elements: string[] = [];

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;

    if (inString !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }

    switch (char) {
      case '<':
        angleDepth += 1;
        continue;
      case '>':
        angleDepth -= 1;
        if (angleDepth < 0) {
          return null;
        }
        continue;
      case '{':
        braceDepth += 1;
        continue;
      case '}':
        braceDepth -= 1;
        if (braceDepth < 0) {
          return null;
        }
        continue;
      case '[':
        bracketDepth += 1;
        continue;
      case ']':
        bracketDepth -= 1;
        if (bracketDepth < 0) {
          return null;
        }
        continue;
      case '(':
        parenDepth += 1;
        continue;
      case ')':
        parenDepth -= 1;
        if (parenDepth < 0) {
          return null;
        }
        continue;
      case ',':
        if (angleDepth === 0 && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
          const segment = body.slice(segmentStart, index).trim();
          if (segment.length === 0) {
            return null;
          }
          elements.push(segment);
          segmentStart = index + 1;
        }
        continue;
      default:
        continue;
    }
  }

  if (
    angleDepth !== 0 || braceDepth !== 0 || bracketDepth !== 0 || parenDepth !== 0 ||
    inString !== null
  ) {
    return null;
  }

  const finalSegment = body.slice(segmentStart).trim();
  if (finalSegment.length === 0) {
    return null;
  }
  elements.push(finalSegment);
  return elements;
}

function parseSupportedDerivedType(typeText: string): SupportedDerivedType | null {
  const primitiveKind = primitiveKindForTypeText(typeText);
  if (primitiveKind) {
    return { kind: 'primitive', primitiveKind };
  }

  const arrayInner = parseArrayInnerTypeText(typeText);
  if (arrayInner !== null) {
    const element = parseSupportedDerivedType(arrayInner);
    return element ? { kind: 'array', element } : null;
  }

  const tupleElements = parseTupleElementTypeTexts(typeText);
  if (tupleElements !== null) {
    const elements = tupleElements.map((element) => parseSupportedDerivedType(element));
    return elements.every((element) => element !== null)
      ? { kind: 'tuple', elements: elements as readonly SupportedDerivedType[] }
      : null;
  }

  const optionInner = parseGenericTypeArgument(typeText, 'Option');
  if (optionInner !== null) {
    const value = parseSupportedDerivedType(optionInner);
    return value ? { kind: 'option', value } : null;
  }

  const resultArgs = parseGenericTypeArguments(typeText, 'Result');
  if (resultArgs?.length === 2) {
    const okType = parseSupportedDerivedType(resultArgs[0]!);
    const errType = parseSupportedDerivedType(resultArgs[1]!);
    return okType && errType ? { kind: 'result', ok: okType, err: errType } : null;
  }

  const trimmed = typeText.trim();
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(trimmed)) {
    return { kind: 'named', typeName: trimmed };
  }

  return null;
}

function supportedDerivedTypeFromShape(
  shape: MacroReflectedTypeShape,
): SupportedDerivedType | null {
  switch (shape.kind) {
    case 'primitive':
      return {
        kind: 'primitive',
        primitiveKind: shape.primitiveKind,
      };
    case 'named':
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(shape.name)
        ? { kind: 'named', typeName: shape.name }
        : null;
    case 'array': {
      const element = supportedDerivedTypeFromShape(shape.element);
      return element ? { kind: 'array', element } : null;
    }
    case 'tuple': {
      const elements = shape.elements.map((element) => supportedDerivedTypeFromShape(element));
      return elements.every((element) => element !== null)
        ? { kind: 'tuple', elements: elements as readonly SupportedDerivedType[] }
        : null;
    }
    case 'option': {
      const value = supportedDerivedTypeFromShape(shape.value);
      return value ? { kind: 'option', value } : null;
    }
    case 'result': {
      const ok = supportedDerivedTypeFromShape(shape.ok);
      const err = supportedDerivedTypeFromShape(shape.err);
      return ok && err ? { kind: 'result', ok, err } : null;
    }
    case 'object':
    case 'literal':
    case 'union':
    case 'unsupported':
      return null;
  }
}

function objectLikeDeclarationShape(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  macroName: DerivedMacroName,
): Extract<MacroReflectedDeclarationShape, { kind: 'objectLike' }> {
  const shape = ctx.reflect.declarationShape(declaration);
  if (shape.kind === 'objectLike') {
    return shape;
  }
  ctx.error(`${macroName} currently only supports object-like declarations in v1.`, declaration);
}

function discriminatedUnionDeclarationShape(
  ctx: DeriveContext,
  declaration: MacroTypeAliasDeclSyntax,
  macroName: DerivedMacroName | 'tagged',
): Extract<MacroReflectedDeclarationShape, { kind: 'discriminatedUnion' }> {
  const shape = ctx.reflect.declarationShape(declaration);
  if (shape.kind === 'discriminatedUnion') {
    return shape;
  }
  ctx.error(
    `${macroName} only supports // #[tagged] unions of object-like variants in v1.`,
    declaration,
  );
}

function eqHashUnsupportedFieldMessage(macroName: 'eq' | 'hash'): string {
  return `${macroName} only supports fields with explicit primitive, nested object literal, tuple, array, Option/Result, or named derived types in v1. Add // #[${macroName}.via(...)] or // #[${macroName}.skip].`;
}

function decodeLikeUnsupportedFieldMessage(
  macroName: 'codec' | 'decode' | 'encode',
): string {
  switch (macroName) {
    case 'decode':
      return 'decode only supports fields with explicit primitive, nested object literal, tuple, array, Option/Result, or named derived types in v1. Add // #[decode.via(...)] to supply a custom decoder.';
    case 'encode':
      return 'encode only supports fields with explicit primitive, nested object literal, tuple, array, Option/Result, or named derived types in v1. Add // #[encode.via(...)] to supply a custom encoder.';
    case 'codec':
      return 'codec only supports fields with explicit primitive, nested object literal, tuple, array, Option/Result, or named derived types in v1. Add // #[codec.via(...)] to supply a custom codec.';
  }
}

function compareHelperName(kind: PrimitiveFieldKind): string {
  switch (kind) {
    case 'string':
      return 'stringEq';
    case 'number':
      return 'numberEq';
    case 'boolean':
      return 'booleanEq';
    case 'bigint':
      return 'bigintEq';
  }
}

function hashHelperName(kind: PrimitiveFieldKind): string {
  switch (kind) {
    case 'string':
      return 'stringHash';
    case 'number':
      return 'numberHash';
    case 'boolean':
      return 'booleanHash';
    case 'bigint':
      return 'bigintHash';
  }
}

function decodeHelperName(kind: PrimitiveFieldKind): string {
  switch (kind) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'bigint';
  }
}

function encodeHelperName(kind: PrimitiveFieldKind): string {
  switch (kind) {
    case 'string':
      return 'stringEncoder';
    case 'number':
      return 'numberEncoder';
    case 'boolean':
      return 'booleanEncoder';
    case 'bigint':
      return 'bigintEncoder';
  }
}

function eqHelperTextForType(ctx: DeriveContext, type: SupportedDerivedType): string {
  switch (type.kind) {
    case 'primitive':
      return ctx.runtime.named('sts:compare', compareHelperName(type.primitiveKind)).text();
    case 'named':
      return `${ctx.runtime.named('sts:compare', 'lazyEq').text()}(() => ${type.typeName}Eq)`;
    case 'array':
      return `${ctx.runtime.named('sts:compare', 'arrayEq').text()}(${
        eqHelperTextForType(ctx, type.element)
      })`;
    case 'tuple':
      return `${ctx.runtime.named('sts:compare', 'tupleEq').text()}(${
        type.elements.map((element) => eqHelperTextForType(ctx, element)).join(', ')
      })`;
    case 'option':
      return `${ctx.runtime.named('sts:compare', 'optionEq').text()}(${
        eqHelperTextForType(ctx, type.value)
      })`;
    case 'result':
      return `${ctx.runtime.named('sts:compare', 'resultEq').text()}(${
        eqHelperTextForType(ctx, type.ok)
      }, ${eqHelperTextForType(ctx, type.err)})`;
  }
}

function hashHelperTextForType(ctx: DeriveContext, type: SupportedDerivedType): string {
  switch (type.kind) {
    case 'primitive':
      return ctx.runtime.named('sts:hash', hashHelperName(type.primitiveKind)).text();
    case 'named':
      return `${ctx.runtime.named('sts:hash', 'lazyHashEq').text()}(() => ${type.typeName}Hash)`;
    case 'array':
      return `${ctx.runtime.named('sts:hash', 'arrayHash').text()}(${
        hashHelperTextForType(ctx, type.element)
      })`;
    case 'tuple':
      return `${ctx.runtime.named('sts:hash', 'tupleHash').text()}(${
        type.elements.map((element) => hashHelperTextForType(ctx, element)).join(', ')
      })`;
    case 'option':
      return `${ctx.runtime.named('sts:hash', 'optionHash').text()}(${
        hashHelperTextForType(ctx, type.value)
      })`;
    case 'result':
      return `${ctx.runtime.named('sts:hash', 'resultHash').text()}(${
        hashHelperTextForType(ctx, type.ok)
      }, ${hashHelperTextForType(ctx, type.err)})`;
  }
}

function decodeHelperTextForType(ctx: DeriveContext, type: SupportedDerivedType): string {
  switch (type.kind) {
    case 'primitive':
      return ctx.runtime.named('sts:decode', decodeHelperName(type.primitiveKind)).text();
    case 'named':
      return `${ctx.runtime.named('sts:decode', 'lazy').text()}(() => ${type.typeName}Decoder)`;
    case 'array':
      return `${ctx.runtime.named('sts:decode', 'array').text()}(${
        decodeHelperTextForType(ctx, type.element)
      })`;
    case 'tuple':
      return `${ctx.runtime.named('sts:decode', 'tuple').text()}(${
        type.elements.map((element) => decodeHelperTextForType(ctx, element)).join(', ')
      })`;
    case 'option':
      return `${ctx.runtime.named('sts:decode', 'option').text()}(${
        decodeHelperTextForType(ctx, type.value)
      })`;
    case 'result':
      return `${ctx.runtime.named('sts:decode', 'result').text()}(${
        decodeHelperTextForType(ctx, type.ok)
      }, ${decodeHelperTextForType(ctx, type.err)})`;
  }
}

function encodeHelperTextForType(ctx: DeriveContext, type: SupportedDerivedType): string {
  switch (type.kind) {
    case 'primitive':
      return ctx.runtime.named('sts:encode', encodeHelperName(type.primitiveKind)).text();
    case 'named':
      return `${ctx.runtime.named('sts:encode', 'lazy').text()}(() => ${type.typeName}Encoder)`;
    case 'array':
      return `${ctx.runtime.named('sts:encode', 'array').text()}(${
        encodeHelperTextForType(ctx, type.element)
      })`;
    case 'tuple':
      return `${ctx.runtime.named('sts:encode', 'tuple').text()}(${
        type.elements.map((element) => encodeHelperTextForType(ctx, element)).join(', ')
      })`;
    case 'option':
      return `${ctx.runtime.named('sts:encode', 'option').text()}(${
        encodeHelperTextForType(ctx, type.value)
      })`;
    case 'result':
      return `${ctx.runtime.named('sts:encode', 'result').text()}(${
        encodeHelperTextForType(ctx, type.ok)
      }, ${encodeHelperTextForType(ctx, type.err)})`;
  }
}

function codecHelperTextsForType(
  ctx: DeriveContext,
  type: SupportedDerivedType,
): { readonly decodeText: string; readonly encodeText: string } {
  switch (type.kind) {
    case 'primitive':
      return {
        decodeText: ctx.runtime.named('sts:decode', decodeHelperName(type.primitiveKind)).text(),
        encodeText: ctx.runtime.named('sts:encode', encodeHelperName(type.primitiveKind)).text(),
      };
    case 'named':
      return {
        decodeText: `${
          ctx.runtime.named('sts:decode', 'lazy').text()
        }(() => ${type.typeName}Codec)`,
        encodeText: `${
          ctx.runtime.named('sts:encode', 'lazy').text()
        }(() => ${type.typeName}Codec)`,
      };
    case 'array': {
      const element = codecHelperTextsForType(ctx, type.element);
      return {
        decodeText: `${ctx.runtime.named('sts:decode', 'array').text()}(${element.decodeText})`,
        encodeText: `${ctx.runtime.named('sts:encode', 'array').text()}(${element.encodeText})`,
      };
    }
    case 'tuple':
      return {
        decodeText: `${ctx.runtime.named('sts:decode', 'tuple').text()}(${
          type.elements.map((element) => codecHelperTextsForType(ctx, element).decodeText).join(
            ', ',
          )
        })`,
        encodeText: `${ctx.runtime.named('sts:encode', 'tuple').text()}(${
          type.elements.map((element) => codecHelperTextsForType(ctx, element).encodeText).join(
            ', ',
          )
        })`,
      };
    case 'option': {
      const value = codecHelperTextsForType(ctx, type.value);
      return {
        decodeText: `${ctx.runtime.named('sts:decode', 'option').text()}(${value.decodeText})`,
        encodeText: `${ctx.runtime.named('sts:encode', 'option').text()}(${value.encodeText})`,
      };
    }
    case 'result': {
      const okType = codecHelperTextsForType(ctx, type.ok);
      const errType = codecHelperTextsForType(ctx, type.err);
      return {
        decodeText: `${
          ctx.runtime.named('sts:decode', 'result').text()
        }(${okType.decodeText}, ${errType.decodeText})`,
        encodeText: `${
          ctx.runtime.named('sts:encode', 'result').text()
        }(${okType.encodeText}, ${errType.encodeText})`,
      };
    }
  }
}

function expectedCompanionName(typeName: string, macroName: DerivedMacroName): string {
  switch (macroName) {
    case 'eq':
      return `${typeName}Eq`;
    case 'hash':
      return `${typeName}Hash`;
    case 'decode':
      return `${typeName}Decoder`;
    case 'encode':
      return `${typeName}Encoder`;
    case 'codec':
      return `${typeName}Codec`;
  }
}

function missingNamedDerivedCompanionMessage(
  macroName: DerivedMacroName,
  companionName: string,
): string {
  switch (macroName) {
    case 'eq':
    case 'hash':
      return `${macroName} requires the companion value "${companionName}" to be in scope for named derived types. Add an import or use // #[${macroName}.via(...)] or // #[${macroName}.skip].`;
    case 'decode':
      return `decode requires the companion value "${companionName}" to be in scope for named derived types. Add an import or use // #[decode.via(...)] to supply a custom decoder.`;
    case 'encode':
      return `encode requires the companion value "${companionName}" to be in scope for named derived types. Add an import or use // #[encode.via(...)] to supply a custom encoder.`;
    case 'codec':
      return `codec requires the companion value "${companionName}" to be in scope for named derived types. Add an import or use // #[codec.via(...)] to supply a custom codec.`;
  }
}

function assertNamedDerivedCompanionsInScope(
  ctx: DeriveContext,
  macroName: DerivedMacroName,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  errorNode: MacroSyntaxNode,
  type: SupportedDerivedType,
): void {
  switch (type.kind) {
    case 'primitive':
      return;
    case 'array':
      assertNamedDerivedCompanionsInScope(
        ctx,
        macroName,
        ownerTypeName,
        scopeNode,
        errorNode,
        type.element,
      );
      return;
    case 'tuple':
      for (const element of type.elements) {
        assertNamedDerivedCompanionsInScope(
          ctx,
          macroName,
          ownerTypeName,
          scopeNode,
          errorNode,
          element,
        );
      }
      return;
    case 'option':
      assertNamedDerivedCompanionsInScope(
        ctx,
        macroName,
        ownerTypeName,
        scopeNode,
        errorNode,
        type.value,
      );
      return;
    case 'result':
      assertNamedDerivedCompanionsInScope(
        ctx,
        macroName,
        ownerTypeName,
        scopeNode,
        errorNode,
        type.ok,
      );
      assertNamedDerivedCompanionsInScope(
        ctx,
        macroName,
        ownerTypeName,
        scopeNode,
        errorNode,
        type.err,
      );
      return;
    case 'named': {
      if (type.typeName === ownerTypeName) {
        return;
      }
      const companionName = expectedCompanionName(type.typeName, macroName);
      if (
        !ctx.semantics.valueBindingInScope(companionName) &&
        !ctx.semantics.localDeclarationHasAnnotation(type.typeName, macroName)
      ) {
        ctx.error(missingNamedDerivedCompanionMessage(macroName, companionName), errorNode);
      }
      return;
    }
  }
}

function eqHashFieldFromReflectedShape(
  ctx: DeriveContext,
  field: MacroReflectedFieldShape,
  macroName: 'eq' | 'hash',
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): DerivedField | null {
  const annotations = field.annotations;
  if (findAnnotation(annotations, `${macroName}.skip`)) {
    return null;
  }

  const viaAnnotation = findAnnotation(annotations, `${macroName}.via`);
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error(`${macroName}.via(...) requires a helper identifier.`, field.node);
  }

  if (viaIdentifier) {
    return {
      eqHelper: viaIdentifier,
      hashHelper: viaIdentifier,
      name: field.name,
      optional: field.optional,
    };
  }

  if (!field.type) {
    ctx.error(eqHashUnsupportedFieldMessage(macroName), field.node);
  }

  if (field.type.kind === 'object') {
    return {
      eqHelper: macroName === 'eq'
        ? nestedEqHelperTextFromFields(ctx, ownerTypeName, scopeNode, field.type.fields)
        : nestedHashHelperTextFromFields(ctx, ownerTypeName, scopeNode, field.type.fields),
      hashHelper: nestedHashHelperTextFromFields(ctx, ownerTypeName, scopeNode, field.type.fields),
      name: field.name,
      optional: field.optional,
    };
  }

  const fieldType = supportedDerivedTypeFromShape(field.type);
  if (!fieldType) {
    ctx.error(eqHashUnsupportedFieldMessage(macroName), field.node);
  }
  assertNamedDerivedCompanionsInScope(
    ctx,
    macroName,
    ownerTypeName,
    scopeNode,
    field.node,
    fieldType,
  );

  return {
    eqHelper: macroName === 'eq'
      ? eqHelperTextForType(ctx, fieldType)
      : hashHelperTextForType(ctx, fieldType),
    hashHelper: hashHelperTextForType(ctx, fieldType),
    name: field.name,
    optional: field.optional,
  };
}

function decodeFieldFromReflectedShape(
  ctx: DeriveContext,
  field: MacroReflectedFieldShape,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): DecodedField {
  const viaAnnotation = findAnnotation(field.annotations, 'decode.via');
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error('decode.via(...) requires a helper identifier.', field.node);
  }

  const renameAnnotation = findAnnotation(field.annotations, 'decode.rename');
  const renamedWireName = renameAnnotation ? annotationStringArgument(renameAnnotation) : null;
  if (renameAnnotation && !renamedWireName) {
    ctx.error('decode.rename(...) requires a string field name.', field.node);
  }

  if (!field.type) {
    ctx.error(decodeLikeUnsupportedFieldMessage('decode'), field.node);
  }

  const decoderText = (() => {
    if (viaIdentifier) {
      return viaIdentifier;
    }
    if (field.type.kind === 'object') {
      return nestedDecodeHelperTextFromFields(ctx, ownerTypeName, scopeNode, field.type.fields);
    }
    const fieldType = supportedDerivedTypeFromShape(field.type);
    if (!fieldType) {
      ctx.error(decodeLikeUnsupportedFieldMessage('decode'), field.node);
    }
    assertNamedDerivedCompanionsInScope(
      ctx,
      'decode',
      ownerTypeName,
      scopeNode,
      field.node,
      fieldType,
    );
    return decodeHelperTextForType(ctx, fieldType);
  })();

  return {
    decoderText,
    localName: field.name,
    optional: field.optional,
    wireName: renamedWireName ?? field.name,
  };
}

function encodeFieldFromReflectedShape(
  ctx: DeriveContext,
  field: MacroReflectedFieldShape,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): EncodedField {
  const viaAnnotation = findAnnotation(field.annotations, 'encode.via');
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error('encode.via(...) requires a helper identifier.', field.node);
  }

  const renameAnnotation = findAnnotation(field.annotations, 'encode.rename');
  const renamedWireName = renameAnnotation ? annotationStringArgument(renameAnnotation) : null;
  if (renameAnnotation && !renamedWireName) {
    ctx.error('encode.rename(...) requires a string field name.', field.node);
  }

  if (!field.type) {
    ctx.error(decodeLikeUnsupportedFieldMessage('encode'), field.node);
  }

  const encoderText = (() => {
    if (viaIdentifier) {
      return viaIdentifier;
    }
    if (field.type.kind === 'object') {
      return nestedEncodeHelperTextFromFields(ctx, ownerTypeName, scopeNode, field.type.fields);
    }
    const fieldType = supportedDerivedTypeFromShape(field.type);
    if (!fieldType) {
      ctx.error(decodeLikeUnsupportedFieldMessage('encode'), field.node);
    }
    assertNamedDerivedCompanionsInScope(
      ctx,
      'encode',
      ownerTypeName,
      scopeNode,
      field.node,
      fieldType,
    );
    return encodeHelperTextForType(ctx, fieldType);
  })();

  return {
    encoderText,
    localName: field.name,
    optional: field.optional,
    wireName: renamedWireName ?? field.name,
  };
}

function codecFieldFromReflectedShape(
  ctx: DeriveContext,
  field: MacroReflectedFieldShape,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): CodecField {
  const viaAnnotation = findAnnotation(field.annotations, 'codec.via');
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error('codec.via(...) requires a helper identifier.', field.node);
  }

  const renameAnnotation = findAnnotation(field.annotations, 'codec.rename');
  const renamedWireName = renameAnnotation ? annotationStringArgument(renameAnnotation) : null;
  if (renameAnnotation && !renamedWireName) {
    ctx.error('codec.rename(...) requires a string field name.', field.node);
  }

  if (!field.type) {
    ctx.error(decodeLikeUnsupportedFieldMessage('codec'), field.node);
  }

  const helperTexts = (() => {
    if (viaIdentifier) {
      return { decodeText: viaIdentifier, encodeText: viaIdentifier };
    }
    if (field.type.kind === 'object') {
      return nestedCodecHelperTextsFromFields(ctx, ownerTypeName, scopeNode, field.type.fields);
    }
    const fieldType = supportedDerivedTypeFromShape(field.type);
    if (!fieldType) {
      ctx.error(decodeLikeUnsupportedFieldMessage('codec'), field.node);
    }
    assertNamedDerivedCompanionsInScope(
      ctx,
      'codec',
      ownerTypeName,
      scopeNode,
      field.node,
      fieldType,
    );
    return codecHelperTextsForType(ctx, fieldType);
  })();

  return {
    decodeText: helperTexts.decodeText,
    encodeText: helperTexts.encodeText,
    localName: field.name,
    optional: field.optional,
    wireName: renamedWireName ?? field.name,
  };
}

function fieldFromObjectMember(
  ctx: Parameters<MacroDefinition<typeof DERIVE_SIGNATURE>['expand']>[0],
  member: MacroObjectTypeMemberSyntax,
  macroName: 'eq' | 'hash',
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): DerivedField | null {
  if (member.memberKind !== 'property_signature' || member.name === null) {
    ctx.error(`${macroName} only supports property-style object members in v1.`, member);
  }

  const annotations = ctx.syntax.annotations(member);
  if (findAnnotation(annotations, `${macroName}.skip`)) {
    return null;
  }

  const viaAnnotation = findAnnotation(annotations, `${macroName}.via`);
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error(`${macroName}.via(...) requires a helper identifier.`, member);
  }

  const explicitType = member.explicitType();
  if (!explicitType) {
    ctx.error(eqHashUnsupportedFieldMessage(macroName), member);
  }

  if (viaIdentifier) {
    return {
      eqHelper: viaIdentifier,
      hashHelper: viaIdentifier,
      name: member.name,
      optional: member.isOptional(),
    };
  }

  const objectType = explicitType.asObjectLiteral();
  if (objectType) {
    return {
      eqHelper: macroName === 'eq'
        ? nestedEqHelperText(ctx, ownerTypeName, scopeNode, objectType)
        : nestedHashHelperText(ctx, ownerTypeName, scopeNode, objectType),
      hashHelper: nestedHashHelperText(ctx, ownerTypeName, scopeNode, objectType),
      name: member.name,
      optional: member.isOptional(),
    };
  }

  const fieldType = parseSupportedDerivedType(explicitType.text());
  if (!fieldType) {
    ctx.error(eqHashUnsupportedFieldMessage(macroName), member);
  }
  assertNamedDerivedCompanionsInScope(ctx, macroName, ownerTypeName, scopeNode, member, fieldType);

  return {
    eqHelper: macroName === 'eq'
      ? eqHelperTextForType(ctx, fieldType)
      : hashHelperTextForType(ctx, fieldType),
    hashHelper: hashHelperTextForType(ctx, fieldType),
    name: member.name,
    optional: member.isOptional(),
  };
}

function fieldFromClassMember(
  ctx: Parameters<MacroDefinition<typeof DERIVE_SIGNATURE>['expand']>[0],
  field: MacroClassFieldSyntax,
  macroName: 'eq' | 'hash',
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): DerivedField | null {
  if (
    field.hasModifier('private') || field.hasModifier('protected') || field.hasModifier('static') ||
    field.name === null
  ) {
    return null;
  }

  const annotations = ctx.syntax.annotations(field);
  if (findAnnotation(annotations, `${macroName}.skip`)) {
    return null;
  }

  const viaAnnotation = findAnnotation(annotations, `${macroName}.via`);
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error(`${macroName}.via(...) requires a helper identifier.`, field);
  }

  const explicitType = field.explicitType();
  if (!explicitType) {
    ctx.error(eqHashUnsupportedFieldMessage(macroName), field);
  }

  if (viaIdentifier) {
    return {
      eqHelper: viaIdentifier,
      hashHelper: viaIdentifier,
      name: field.name,
      optional: field.isOptional(),
    };
  }

  const objectType = explicitType.asObjectLiteral();
  if (objectType) {
    return {
      eqHelper: macroName === 'eq'
        ? nestedEqHelperText(ctx, ownerTypeName, scopeNode, objectType)
        : nestedHashHelperText(ctx, ownerTypeName, scopeNode, objectType),
      hashHelper: nestedHashHelperText(ctx, ownerTypeName, scopeNode, objectType),
      name: field.name,
      optional: field.isOptional(),
    };
  }

  const fieldType = parseSupportedDerivedType(explicitType.text());
  if (!fieldType) {
    ctx.error(eqHashUnsupportedFieldMessage(macroName), field);
  }
  assertNamedDerivedCompanionsInScope(ctx, macroName, ownerTypeName, scopeNode, field, fieldType);

  return {
    eqHelper: macroName === 'eq'
      ? eqHelperTextForType(ctx, fieldType)
      : hashHelperTextForType(ctx, fieldType),
    hashHelper: hashHelperTextForType(ctx, fieldType),
    name: field.name,
    optional: field.isOptional(),
  };
}

function collectFields(
  ctx: Parameters<MacroDefinition<typeof DERIVE_SIGNATURE>['expand']>[0],
  macroName: 'eq' | 'hash',
  decoded: Parameters<MacroDefinition<typeof DERIVE_SIGNATURE>['expand']>[1],
): { readonly fields: readonly DerivedField[]; readonly typeName: string } {
  const declaration = decoded.args.target;
  const shape = objectLikeDeclarationShape(ctx, declaration, macroName);
  const typeName = shape.name ??
    ctx.error(
      `${macroName} currently requires named ${shape.declarationKind} declarations.`,
      declaration,
    );
  const fields = shape.fields
    .map((field) => eqHashFieldFromReflectedShape(ctx, field, macroName, typeName, declaration))
    .filter((field): field is DerivedField => field !== null);
  return { fields, typeName };
}

function eqCheckText(field: DerivedField, leftName: string, rightName: string): string {
  const leftAccess = propertyAccessText(leftName, field.name);
  const rightAccess = propertyAccessText(rightName, field.name);
  if (!field.optional) {
    return `${field.eqHelper}.equals(${leftAccess}, ${rightAccess})`;
  }
  return `${leftAccess} === ${rightAccess} || (${leftAccess} !== undefined && ${rightAccess} !== undefined && ${field.eqHelper}.equals(${leftAccess}, ${rightAccess}))`;
}

function hashExprText(field: DerivedField, receiverName: string): string {
  const access = propertyAccessText(receiverName, field.name);
  if (!field.optional) {
    return `${field.hashHelper}.hash(${access})`;
  }
  return `${access} === undefined ? 0 : ${field.hashHelper}.hash(${access})`;
}

function nestedEqHelperTextFromFields(
  ctx: DeriveContext,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  fields: readonly MacroReflectedFieldShape[],
): string {
  const derivedFields = fields.map((field) =>
    eqHashFieldFromReflectedShape(ctx, field, 'eq', ownerTypeName, scopeNode)
  ).filter((field): field is DerivedField => field !== null);
  const equalsBody = derivedFields.length === 0
    ? 'true'
    : derivedFields.map((field) => eqCheckText(field, 'left', 'right')).join(' && ');
  return `({
    equals(left, right) {
      return ${equalsBody};
    },
  })`;
}

function nestedHashHelperTextFromFields(
  ctx: DeriveContext,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  fields: readonly MacroReflectedFieldShape[],
): string {
  const derivedFields = fields.map((field) =>
    eqHashFieldFromReflectedShape(ctx, field, 'hash', ownerTypeName, scopeNode)
  ).filter((field): field is DerivedField => field !== null);
  const fromHashEq = ctx.runtime.named('sts:hash', 'fromHashEq').text();
  const combineHashes = ctx.runtime.named('sts:hash', 'combineHashes').text();
  const hashArgs = derivedFields.map((field) => hashExprText(field, 'value')).join(', ');
  const equalsBody = derivedFields.length === 0
    ? 'true'
    : derivedFields.map((field) => eqCheckText(field, 'left', 'right')).join(' && ');
  return `${fromHashEq}(
    (value) => ${combineHashes}(${hashArgs}),
    (left, right) => ${equalsBody},
  )`;
}

function nestedDecodeHelperTextFromFields(
  ctx: DeriveContext,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  fields: readonly MacroReflectedFieldShape[],
): string {
  const decodedFields = fields.map((field) =>
    decodeFieldFromReflectedShape(ctx, field, ownerTypeName, scopeNode)
  );
  const decodeObject = ctx.runtime.named('sts:decode', 'object').text();
  const decodeMap = ctx.runtime.named('sts:decode', 'map').text();
  const decodeOptional = ctx.runtime.named('sts:decode', 'optional').text();
  const shapeText = decodedFields.length === 0 ? '{}' : `{
        ${
    decodedFields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${decodeOptional}(${field.decoderText})` : field.decoderText
      }`
    ).join(',\n')
  }
      }`;
  const isIdentityProjection = decodedFields.every((field) => field.localName === field.wireName);
  if (isIdentityProjection) {
    return `${decodeObject}(${shapeText})`;
  }
  const projectionText = decodedFields.length === 0 ? '{}' : `({
        ${
    decodedFields.map((field) =>
      `${propertyKeyText(field.localName)}: ${propertyAccessText('value', field.wireName)}`
    ).join(',\n')
  }
      })`;
  return `${decodeMap}(
    ${decodeObject}(${shapeText}),
    (value) => ${projectionText},
  )`;
}

function nestedEncodeHelperTextFromFields(
  ctx: DeriveContext,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  fields: readonly MacroReflectedFieldShape[],
): string {
  const encodedFields = fields.map((field) =>
    encodeFieldFromReflectedShape(ctx, field, ownerTypeName, scopeNode)
  );
  const encodeContramap = ctx.runtime.named('sts:encode', 'contramap').text();
  const encodeObject = ctx.runtime.named('sts:encode', 'object').text();
  const encodeOptional = ctx.runtime.named('sts:encode', 'optional').text();
  const shapeText = encodedFields.length === 0 ? '{}' : `{
        ${
    encodedFields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${encodeOptional}(${field.encoderText})` : field.encoderText
      }`
    ).join(',\n')
  }
      }`;
  const isIdentityProjection = encodedFields.every((field) => field.localName === field.wireName);
  if (isIdentityProjection) {
    return `${encodeObject}(${shapeText})`;
  }
  const projectionText = encodedFields.length === 0 ? '({})' : `({
        ${
    encodedFields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${propertyAccessText('value', field.localName)}`
    ).join(',\n')
  }
      })`;
  return `${encodeContramap}(
    ${encodeObject}(${shapeText}),
    (value) => ${projectionText},
  )`;
}

function nestedCodecHelperTextsFromFields(
  ctx: DeriveContext,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  fields: readonly MacroReflectedFieldShape[],
): { readonly decodeText: string; readonly encodeText: string } {
  const codecFields = fields.map((field) =>
    codecFieldFromReflectedShape(ctx, field, ownerTypeName, scopeNode)
  );
  const decodeObject = ctx.runtime.named('sts:decode', 'object').text();
  const decodeMap = ctx.runtime.named('sts:decode', 'map').text();
  const decodeOptional = ctx.runtime.named('sts:decode', 'optional').text();
  const encodeContramap = ctx.runtime.named('sts:encode', 'contramap').text();
  const encodeObject = ctx.runtime.named('sts:encode', 'object').text();
  const encodeOptional = ctx.runtime.named('sts:encode', 'optional').text();
  const decodeShapeText = codecFields.length === 0 ? '{}' : `{
        ${
    codecFields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${decodeOptional}(${field.decodeText})` : field.decodeText
      }`
    ).join(',\n')
  }
      }`;
  const hasIdentityDecodeProjection = codecFields.every((field) =>
    field.localName === field.wireName
  );
  const encodeShapeText = codecFields.length === 0 ? '{}' : `{
        ${
    codecFields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${encodeOptional}(${field.encodeText})` : field.encodeText
      }`
    ).join(',\n')
  }
      }`;
  const hasIdentityEncodeProjection = codecFields.every((field) =>
    field.localName === field.wireName
  );
  return {
    decodeText: hasIdentityDecodeProjection ? `${decodeObject}(${decodeShapeText})` : `${decodeMap}(
      ${decodeObject}(${decodeShapeText}),
      (value) => ({
        ${
      codecFields.map((field) =>
        `${propertyKeyText(field.localName)}: ${propertyAccessText('value', field.wireName)}`
      ).join(',\n')
    }
      }),
    )`,
    encodeText: hasIdentityEncodeProjection
      ? `${encodeObject}(${encodeShapeText})`
      : `${encodeContramap}(
      ${encodeObject}(${encodeShapeText}),
      (value) => ({
        ${
        codecFields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${propertyAccessText('value', field.localName)}`
        ).join(',\n')
      }
      }),
    )`,
  };
}

function collectNestedDerivedFields(
  ctx: Parameters<MacroDefinition<typeof DERIVE_SIGNATURE>['expand']>[0],
  macroName: 'eq' | 'hash',
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  objectType: MacroObjectTypeSyntax,
): readonly DerivedField[] {
  return objectType.members
    .map((member) => fieldFromObjectMember(ctx, member, macroName, ownerTypeName, scopeNode))
    .filter((member): member is DerivedField => member !== null);
}

function nestedEqHelperText(
  ctx: Parameters<MacroDefinition<typeof DERIVE_SIGNATURE>['expand']>[0],
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  objectType: MacroObjectTypeSyntax,
): string {
  const fields = collectNestedDerivedFields(ctx, 'eq', ownerTypeName, scopeNode, objectType);
  const equalsBody = fields.length === 0
    ? 'true'
    : fields.map((field) => eqCheckText(field, 'left', 'right')).join(' && ');
  return `({
    equals(left, right) {
      return ${equalsBody};
    },
  })`;
}

function nestedHashHelperText(
  ctx: Parameters<MacroDefinition<typeof DERIVE_SIGNATURE>['expand']>[0],
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  objectType: MacroObjectTypeSyntax,
): string {
  const fields = collectNestedDerivedFields(ctx, 'hash', ownerTypeName, scopeNode, objectType);
  const fromHashEq = ctx.runtime.named('sts:hash', 'fromHashEq').text();
  const combineHashes = ctx.runtime.named('sts:hash', 'combineHashes').text();
  const hashArgs = fields.map((field) => hashExprText(field, 'value')).join(', ');
  const equalsBody = fields.length === 0
    ? 'true'
    : fields.map((field) => eqCheckText(field, 'left', 'right')).join(' && ');
  return `${fromHashEq}(
    (value) => ${combineHashes}(${hashArgs}),
    (left, right) => ${equalsBody},
  )`;
}

function nestedDecodeHelperText(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  objectType: MacroObjectTypeSyntax,
): string {
  const fields = objectType.members.map((member) =>
    fieldFromDecodeMember(ctx, member, ownerTypeName, scopeNode)
  );
  const decodeObject = ctx.runtime.named('sts:decode', 'object').text();
  const decodeMap = ctx.runtime.named('sts:decode', 'map').text();
  const decodeOptional = ctx.runtime.named('sts:decode', 'optional').text();
  const shapeText = fields.length === 0 ? '{}' : `{
        ${
    fields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${decodeOptional}(${field.decoderText})` : field.decoderText
      }`
    ).join(',\n')
  }
      }`;
  const isIdentityProjection = fields.every((field) => field.localName === field.wireName);
  if (isIdentityProjection) {
    return `${decodeObject}(${shapeText})`;
  }
  const projectionText = fields.length === 0 ? '{}' : `({
        ${
    fields.map((field) =>
      `${propertyKeyText(field.localName)}: ${propertyAccessText('value', field.wireName)}`
    ).join(',\n')
  }
      })`;
  return `${decodeMap}(
    ${decodeObject}(${shapeText}),
    (value) => ${projectionText},
  )`;
}

function nestedEncodeHelperText(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  objectType: MacroObjectTypeSyntax,
): string {
  const fields = objectType.members.map((member) =>
    fieldFromEncodeMember(ctx, member, ownerTypeName, scopeNode)
  );
  const encodeContramap = ctx.runtime.named('sts:encode', 'contramap').text();
  const encodeObject = ctx.runtime.named('sts:encode', 'object').text();
  const encodeOptional = ctx.runtime.named('sts:encode', 'optional').text();
  const shapeText = fields.length === 0 ? '{}' : `{
        ${
    fields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${encodeOptional}(${field.encoderText})` : field.encoderText
      }`
    ).join(',\n')
  }
      }`;
  const isIdentityProjection = fields.every((field) => field.localName === field.wireName);
  if (isIdentityProjection) {
    return `${encodeObject}(${shapeText})`;
  }
  const projectionText = fields.length === 0 ? '({})' : `({
        ${
    fields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${propertyAccessText('value', field.localName)}`
    ).join(',\n')
  }
      })`;
  return `${encodeContramap}(
    ${encodeObject}(${shapeText}),
    (value) => ${projectionText},
  )`;
}

function nestedCodecHelperTexts(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  objectType: MacroObjectTypeSyntax,
): { readonly decodeText: string; readonly encodeText: string } {
  const fields = objectType.members.map((member) =>
    fieldFromCodecMember(ctx, member, ownerTypeName, scopeNode)
  );
  const decodeObject = ctx.runtime.named('sts:decode', 'object').text();
  const decodeMap = ctx.runtime.named('sts:decode', 'map').text();
  const decodeOptional = ctx.runtime.named('sts:decode', 'optional').text();
  const encodeContramap = ctx.runtime.named('sts:encode', 'contramap').text();
  const encodeObject = ctx.runtime.named('sts:encode', 'object').text();
  const encodeOptional = ctx.runtime.named('sts:encode', 'optional').text();
  const decodeShapeText = fields.length === 0 ? '{}' : `{
        ${
    fields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${decodeOptional}(${field.decodeText})` : field.decodeText
      }`
    ).join(',\n')
  }
      }`;
  const hasIdentityDecodeProjection = fields.every((field) => field.localName === field.wireName);
  const encodeShapeText = fields.length === 0 ? '{}' : `{
        ${
    fields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${encodeOptional}(${field.encodeText})` : field.encodeText
      }`
    ).join(',\n')
  }
      }`;
  const hasIdentityEncodeProjection = fields.every((field) => field.localName === field.wireName);
  return {
    decodeText: hasIdentityDecodeProjection ? `${decodeObject}(${decodeShapeText})` : `${decodeMap}(
      ${decodeObject}(${decodeShapeText}),
      (value) => ({
        ${
      fields.map((field) =>
        `${propertyKeyText(field.localName)}: ${propertyAccessText('value', field.wireName)}`
      ).join(',\n')
    }
      }),
    )`,
    encodeText: hasIdentityEncodeProjection
      ? `${encodeObject}(${encodeShapeText})`
      : `${encodeContramap}(
      ${encodeObject}(${encodeShapeText}),
      (value) => ({
        ${
        fields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${propertyAccessText('value', field.localName)}`
        ).join(',\n')
      }
      }),
    )`,
  };
}

function capitalizeName(name: string): string {
  return name.length === 0 ? name : `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

function decapitalizeName(name: string): string {
  return name.length === 0 ? name : `${name[0]!.toLowerCase()}${name.slice(1)}`;
}

function annotationNamedStringArgument(
  annotation: MacroAnnotation,
  name: string,
): string | null {
  const argument = annotation.arguments?.find((entry) =>
    entry.kind === 'named' && entry.name === name
  );
  return argument?.value.kind === 'string' ? argument.value.value : null;
}

function taggedDiscriminantName(
  ctx: Parameters<MacroDefinition<typeof TAGGED_SIGNATURE>['expand']>[0],
  declaration: MacroTypeAliasDeclSyntax,
): string {
  const annotation = findAnnotation(ctx.syntax.annotations(declaration), 'tagged');
  if (!annotation) {
    return 'tag';
  }

  const discriminant = annotationNamedStringArgument(annotation, 'discriminant');
  if (discriminant !== null) {
    return discriminant;
  }

  if ((annotation.arguments?.length ?? 0) > 0) {
    ctx.error("tagged only supports #[tagged(discriminant: '...')] options in v1.", declaration);
  }

  return 'tag';
}

function taggedPayloadField(
  ctx: Parameters<MacroDefinition<typeof TAGGED_SIGNATURE>['expand']>[0],
  member: MacroObjectTypeMemberSyntax,
): TaggedVariantField {
  if (member.memberKind !== 'property_signature' || member.name === null) {
    ctx.error('tagged only supports property-style object members in v1.', member);
  }

  const explicitType = member.explicitType();
  if (!explicitType) {
    ctx.error('tagged currently requires explicit payload property types in v1.', member);
  }

  return {
    name: member.name,
    optional: member.isOptional(),
    typeText: explicitType.text(),
  };
}

function fieldFromDecodeMember(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  member: MacroObjectTypeMemberSyntax,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): DecodedField {
  if (member.memberKind !== 'property_signature' || member.name === null) {
    ctx.error('decode only supports property-style object members in v1.', member);
  }

  const viaAnnotation = findAnnotation(ctx.syntax.annotations(member), 'decode.via');
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error('decode.via(...) requires a helper identifier.', member);
  }

  const renameAnnotation = findAnnotation(ctx.syntax.annotations(member), 'decode.rename');
  const renamedWireName = renameAnnotation ? annotationStringArgument(renameAnnotation) : null;
  if (renameAnnotation && !renamedWireName) {
    ctx.error('decode.rename(...) requires a string field name.', member);
  }

  const explicitType = member.explicitType();
  if (!explicitType) {
    ctx.error(decodeLikeUnsupportedFieldMessage('decode'), member);
  }

  const decoderText = (() => {
    if (viaIdentifier) {
      return viaIdentifier;
    }

    const objectType = explicitType.asObjectLiteral();
    if (objectType) {
      return nestedDecodeHelperText(ctx, ownerTypeName, scopeNode, objectType);
    }

    const fieldType = parseSupportedDerivedType(explicitType.text());
    if (!fieldType) {
      ctx.error(decodeLikeUnsupportedFieldMessage('decode'), member);
    }
    assertNamedDerivedCompanionsInScope(ctx, 'decode', ownerTypeName, scopeNode, member, fieldType);

    return decodeHelperTextForType(ctx, fieldType);
  })();

  return {
    decoderText,
    localName: member.name,
    optional: member.isOptional(),
    wireName: renamedWireName ?? member.name,
  };
}

function fieldFromDecodeClassField(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  field: MacroClassFieldSyntax,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): DecodedField | null {
  if (
    field.hasModifier('private') || field.hasModifier('protected') || field.hasModifier('static') ||
    field.name === null
  ) {
    return null;
  }

  const viaAnnotation = findAnnotation(ctx.syntax.annotations(field), 'decode.via');
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error('decode.via(...) requires a helper identifier.', field);
  }

  const renameAnnotation = findAnnotation(ctx.syntax.annotations(field), 'decode.rename');
  const renamedWireName = renameAnnotation ? annotationStringArgument(renameAnnotation) : null;
  if (renameAnnotation && !renamedWireName) {
    ctx.error('decode.rename(...) requires a string field name.', field);
  }

  const explicitType = field.explicitType();
  if (!explicitType) {
    ctx.error(decodeLikeUnsupportedFieldMessage('decode'), field);
  }

  const decoderText = (() => {
    if (viaIdentifier) {
      return viaIdentifier;
    }

    const objectType = explicitType.asObjectLiteral();
    if (objectType) {
      return nestedDecodeHelperText(ctx, ownerTypeName, scopeNode, objectType);
    }

    const fieldType = parseSupportedDerivedType(explicitType.text());
    if (!fieldType) {
      ctx.error(decodeLikeUnsupportedFieldMessage('decode'), field);
    }
    assertNamedDerivedCompanionsInScope(ctx, 'decode', ownerTypeName, scopeNode, field, fieldType);

    return decodeHelperTextForType(ctx, fieldType);
  })();

  return {
    decoderText,
    localName: field.name,
    optional: field.isOptional(),
    wireName: renamedWireName ?? field.name,
  };
}

function classHasConstructorParameters(declaration: MacroClassDeclSyntax): boolean {
  return declaration.members().some((member) =>
    member.memberKind === 'constructor' && member.parameters.length > 0
  );
}

function classifySelfFactoryHelper(
  declaration: MacroClassDeclSyntax,
  typeName: string,
  factoryIdentifier: string,
): 'callable' | 'missing' | 'non-callable' | null {
  const segments = factoryIdentifier.split('.').map((segment) => segment.trim()).filter((segment) =>
    segment.length > 0
  );
  if (segments.length !== 2 || segments[0] !== typeName) {
    return null;
  }

  const member = declaration.member(segments[1]!);
  if (!member || !member.hasModifier('static')) {
    return 'missing';
  }

  return member.memberKind === 'method' ? 'callable' : 'non-callable';
}

function classDecodeInstantiateText(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  declaration: MacroClassDeclSyntax,
  macroName: 'codec' | 'decode',
  typeName: string,
): string {
  const factoryAnnotation = findAnnotation(
    ctx.syntax.annotations(declaration),
    `${macroName}.factory`,
  );
  if (factoryAnnotation) {
    const factoryIdentifier = annotationIdentifierArgument(factoryAnnotation);
    if (!factoryIdentifier) {
      ctx.error(
        `${macroName}.factory(...) requires a helper identifier.`,
        annotationDiagnosticNode(declaration, factoryAnnotation) ?? declaration,
      );
    }
    const selfFactoryClassification = classifySelfFactoryHelper(
      declaration,
      typeName,
      factoryIdentifier,
    );
    if (selfFactoryClassification === 'missing') {
      ctx.error(
        `${macroName}.factory(...) requires the helper value "${factoryIdentifier}" to be in scope.`,
        annotationDiagnosticNode(declaration, factoryAnnotation) ?? declaration,
      );
    }
    if (selfFactoryClassification === 'non-callable') {
      ctx.error(
        `${macroName}.factory(...) requires "${factoryIdentifier}" to be callable.`,
        annotationDiagnosticNode(declaration, factoryAnnotation) ?? declaration,
      );
    }
    if (selfFactoryClassification === 'callable') {
      return `${factoryIdentifier}(${CLASS_DECODE_VALUE_PLACEHOLDER})`;
    }
    if (!ctx.semantics.valueBindingInScope(factoryIdentifier)) {
      ctx.error(
        `${macroName}.factory(...) requires the helper value "${factoryIdentifier}" to be in scope.`,
        annotationDiagnosticNode(declaration, factoryAnnotation) ?? declaration,
      );
    }
    if (!ctx.semantics.valueBindingCallableInScope(factoryIdentifier)) {
      ctx.error(
        `${macroName}.factory(...) requires "${factoryIdentifier}" to be callable.`,
        annotationDiagnosticNode(declaration, factoryAnnotation) ?? declaration,
      );
    }
    return `${factoryIdentifier}(${CLASS_DECODE_VALUE_PLACEHOLDER})`;
  }

  if (classHasConstructorParameters(declaration)) {
    ctx.error(
      `${macroName} class support in v1 requires a constructor with no parameters.`,
      declaration,
    );
  }

  return `Object.assign(new ${typeName}(), ${CLASS_DECODE_VALUE_PLACEHOLDER})`;
}

function collectDecodeFields(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  decoded: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[1],
): {
  readonly fields: readonly DecodedField[];
  readonly instantiateText: string | null;
  readonly typeName: string;
} {
  const declaration = decoded.args.target;
  const shape = objectLikeDeclarationShape(ctx, declaration, 'decode');
  const typeName = shape.name ??
    ctx.error(
      `decode currently requires named ${shape.declarationKind} declarations.`,
      declaration,
    );
  return {
    fields: shape.fields.map((field) =>
      decodeFieldFromReflectedShape(ctx, field, typeName, declaration)
    ),
    instantiateText: decoded.caseName === 'class'
      ? classDecodeInstantiateText(ctx, declaration as MacroClassDeclSyntax, 'decode', typeName)
      : null,
    typeName,
  };
}

function fieldFromEncodeMember(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  member: MacroObjectTypeMemberSyntax,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): EncodedField {
  if (member.memberKind !== 'property_signature' || member.name === null) {
    ctx.error('encode only supports property-style object members in v1.', member);
  }

  const viaAnnotation = findAnnotation(ctx.syntax.annotations(member), 'encode.via');
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error('encode.via(...) requires a helper identifier.', member);
  }

  const renameAnnotation = findAnnotation(ctx.syntax.annotations(member), 'encode.rename');
  const renamedWireName = renameAnnotation ? annotationStringArgument(renameAnnotation) : null;
  if (renameAnnotation && !renamedWireName) {
    ctx.error('encode.rename(...) requires a string field name.', member);
  }

  const explicitType = member.explicitType();
  if (!explicitType) {
    ctx.error(decodeLikeUnsupportedFieldMessage('encode'), member);
  }

  const encoderText = (() => {
    if (viaIdentifier) {
      return viaIdentifier;
    }

    const objectType = explicitType.asObjectLiteral();
    if (objectType) {
      return nestedEncodeHelperText(ctx, ownerTypeName, scopeNode, objectType);
    }

    const fieldType = parseSupportedDerivedType(explicitType.text());
    if (!fieldType) {
      ctx.error(decodeLikeUnsupportedFieldMessage('encode'), member);
    }
    assertNamedDerivedCompanionsInScope(ctx, 'encode', ownerTypeName, scopeNode, member, fieldType);

    return encodeHelperTextForType(ctx, fieldType);
  })();

  return {
    encoderText,
    localName: member.name,
    optional: member.isOptional(),
    wireName: renamedWireName ?? member.name,
  };
}

function fieldFromEncodeClassField(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  field: MacroClassFieldSyntax,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): EncodedField | null {
  if (
    field.hasModifier('private') || field.hasModifier('protected') || field.hasModifier('static') ||
    field.name === null
  ) {
    return null;
  }

  const viaAnnotation = findAnnotation(ctx.syntax.annotations(field), 'encode.via');
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error('encode.via(...) requires a helper identifier.', field);
  }

  const renameAnnotation = findAnnotation(ctx.syntax.annotations(field), 'encode.rename');
  const renamedWireName = renameAnnotation ? annotationStringArgument(renameAnnotation) : null;
  if (renameAnnotation && !renamedWireName) {
    ctx.error('encode.rename(...) requires a string field name.', field);
  }

  const explicitType = field.explicitType();
  if (!explicitType) {
    ctx.error(decodeLikeUnsupportedFieldMessage('encode'), field);
  }

  const encoderText = (() => {
    if (viaIdentifier) {
      return viaIdentifier;
    }

    const objectType = explicitType.asObjectLiteral();
    if (objectType) {
      return nestedEncodeHelperText(ctx, ownerTypeName, scopeNode, objectType);
    }

    const fieldType = parseSupportedDerivedType(explicitType.text());
    if (!fieldType) {
      ctx.error(decodeLikeUnsupportedFieldMessage('encode'), field);
    }
    assertNamedDerivedCompanionsInScope(ctx, 'encode', ownerTypeName, scopeNode, field, fieldType);

    return encodeHelperTextForType(ctx, fieldType);
  })();

  return {
    encoderText,
    localName: field.name,
    optional: field.isOptional(),
    wireName: renamedWireName ?? field.name,
  };
}

function collectEncodeFields(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  decoded: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[1],
): { readonly fields: readonly EncodedField[]; readonly typeName: string } {
  const declaration = decoded.args.target;
  const shape = objectLikeDeclarationShape(ctx, declaration, 'encode');
  const typeName = shape.name ??
    ctx.error(
      `encode currently requires named ${shape.declarationKind} declarations.`,
      declaration,
    );
  return {
    fields: shape.fields.map((field) =>
      encodeFieldFromReflectedShape(ctx, field, typeName, declaration)
    ),
    typeName,
  };
}

function fieldFromCodecMember(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  member: MacroObjectTypeMemberSyntax,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): CodecField {
  if (member.memberKind !== 'property_signature' || member.name === null) {
    ctx.error('codec only supports property-style object members in v1.', member);
  }

  const viaAnnotation = findAnnotation(ctx.syntax.annotations(member), 'codec.via');
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error('codec.via(...) requires a helper identifier.', member);
  }

  const renameAnnotation = findAnnotation(ctx.syntax.annotations(member), 'codec.rename');
  const renamedWireName = renameAnnotation ? annotationStringArgument(renameAnnotation) : null;
  if (renameAnnotation && !renamedWireName) {
    ctx.error('codec.rename(...) requires a string field name.', member);
  }

  const explicitType = member.explicitType();
  if (!explicitType) {
    ctx.error(decodeLikeUnsupportedFieldMessage('codec'), member);
  }

  const helperTexts = (() => {
    if (viaIdentifier) {
      return { decodeText: viaIdentifier, encodeText: viaIdentifier };
    }

    const objectType = explicitType.asObjectLiteral();
    if (objectType) {
      return nestedCodecHelperTexts(ctx, ownerTypeName, scopeNode, objectType);
    }

    const fieldType = parseSupportedDerivedType(explicitType.text());
    if (!fieldType) {
      ctx.error(decodeLikeUnsupportedFieldMessage('codec'), member);
    }
    assertNamedDerivedCompanionsInScope(ctx, 'codec', ownerTypeName, scopeNode, member, fieldType);

    return codecHelperTextsForType(ctx, fieldType);
  })();

  return {
    decodeText: helperTexts.decodeText,
    encodeText: helperTexts.encodeText,
    localName: member.name,
    optional: member.isOptional(),
    wireName: renamedWireName ?? member.name,
  };
}

function fieldFromCodecClassField(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  field: MacroClassFieldSyntax,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): CodecField | null {
  if (
    field.hasModifier('private') || field.hasModifier('protected') || field.hasModifier('static') ||
    field.name === null
  ) {
    return null;
  }

  const viaAnnotation = findAnnotation(ctx.syntax.annotations(field), 'codec.via');
  const viaIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (viaAnnotation && !viaIdentifier) {
    ctx.error('codec.via(...) requires a helper identifier.', field);
  }

  const renameAnnotation = findAnnotation(ctx.syntax.annotations(field), 'codec.rename');
  const renamedWireName = renameAnnotation ? annotationStringArgument(renameAnnotation) : null;
  if (renameAnnotation && !renamedWireName) {
    ctx.error('codec.rename(...) requires a string field name.', field);
  }

  const explicitType = field.explicitType();
  if (!explicitType) {
    ctx.error(decodeLikeUnsupportedFieldMessage('codec'), field);
  }

  const helperTexts = (() => {
    if (viaIdentifier) {
      return { decodeText: viaIdentifier, encodeText: viaIdentifier };
    }

    const objectType = explicitType.asObjectLiteral();
    if (objectType) {
      return nestedCodecHelperTexts(ctx, ownerTypeName, scopeNode, objectType);
    }

    const fieldType = parseSupportedDerivedType(explicitType.text());
    if (!fieldType) {
      ctx.error(decodeLikeUnsupportedFieldMessage('codec'), field);
    }
    assertNamedDerivedCompanionsInScope(ctx, 'codec', ownerTypeName, scopeNode, field, fieldType);

    return codecHelperTextsForType(ctx, fieldType);
  })();

  return {
    decodeText: helperTexts.decodeText,
    encodeText: helperTexts.encodeText,
    localName: field.name,
    optional: field.isOptional(),
    wireName: renamedWireName ?? field.name,
  };
}

function collectCodecFields(
  ctx: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[0],
  decoded: Parameters<MacroDefinition<typeof DECODE_SIGNATURE>['expand']>[1],
): {
  readonly fields: readonly CodecField[];
  readonly instantiateText: string | null;
  readonly typeName: string;
} {
  const declaration = decoded.args.target;
  const shape = objectLikeDeclarationShape(ctx, declaration, 'codec');
  const typeName = shape.name ??
    ctx.error(`codec currently requires named ${shape.declarationKind} declarations.`, declaration);
  return {
    fields: shape.fields.map((field) =>
      codecFieldFromReflectedShape(ctx, field, typeName, declaration)
    ),
    instantiateText: decoded.caseName === 'class'
      ? classDecodeInstantiateText(ctx, declaration as MacroClassDeclSyntax, 'codec', typeName)
      : null,
    typeName,
  };
}

function validateTaggedUnionSyntaxForDiagnostics(
  ctx: DeriveContext,
  declaration: MacroTypeAliasDeclSyntax,
  macroName: 'codec' | 'decode' | 'encode' | 'eq' | 'hash' | 'tagged',
  discriminantName: string,
): never {
  const unionType = declaration.type.asUnion();
  if (!unionType) {
    if (macroName === 'tagged') {
      ctx.error(
        'tagged currently only supports type aliases declared as unions in v1.',
        declaration,
      );
    }
    ctx.error(`${macroName} currently only supports object-like type aliases.`, declaration);
  }

  for (const member of unionType.members) {
    const objectType = member.asObjectLiteral();
    if (!objectType) {
      ctx.error(
        macroName === 'tagged'
          ? 'tagged only supports unions of object-like variants in v1.'
          : `${macroName} only supports // #[tagged] unions of object-like variants in v1.`,
        declaration,
      );
    }

    let hasDiscriminant = false;
    for (const objectMember of objectType.members) {
      if (objectMember.memberKind !== 'property_signature' || objectMember.name === null) {
        ctx.error(
          macroName === 'tagged'
            ? 'tagged only supports property-style object members in v1.'
            : `${macroName} only supports property-style tagged union members in v1.`,
          objectMember,
        );
      }

      if (objectMember.name !== discriminantName) {
        continue;
      }

      const literalType = objectMember.explicitType()?.asLiteral();
      if (!literalType || literalType.literalKind !== 'string') {
        ctx.error(
          macroName === 'tagged'
            ? 'tagged requires each variant discriminant to be a string literal type in v1.'
            : `${macroName} requires each tagged union discriminant to be a string literal type in v1.`,
          objectMember,
        );
      }
      hasDiscriminant = true;
    }

    if (!hasDiscriminant) {
      ctx.error(
        macroName === 'tagged'
          ? `tagged requires each variant to declare the discriminant property "${discriminantName}".`
          : `${macroName} requires each tagged variant to declare the discriminant property "${discriminantName}".`,
        objectType,
      );
    }
  }

  ctx.error(
    macroName === 'tagged'
      ? 'tagged only supports unions of object-like variants in v1.'
      : `${macroName} only supports // #[tagged] unions of object-like variants in v1.`,
    declaration,
  );
}

function collectTaggedDerivedVariants<TField>(
  ctx: DeriveContext,
  declaration: MacroTypeAliasDeclSyntax,
  macroName: 'codec' | 'decode' | 'encode' | 'eq' | 'hash',
  collectField: (
    field: MacroReflectedFieldShape,
    ownerTypeName: string,
    scopeNode: MacroTypeAliasDeclSyntax,
  ) => TField | null,
): {
  readonly discriminantName: string;
  readonly typeName: string;
  readonly variants: readonly TaggedDerivedVariant<TField>[];
} {
  const discriminantName = taggedDiscriminantName(ctx, declaration);
  const shape = ctx.reflect.declarationShape(declaration);
  if (shape.kind !== 'discriminatedUnion') {
    return validateTaggedUnionSyntaxForDiagnostics(ctx, declaration, macroName, discriminantName);
  }
  const unionShape = shape;
  const typeName = unionShape.name ??
    ctx.error(`${macroName} currently requires named type aliases.`, declaration);

  const variants = unionShape.variants.map((variant) => {
    const discriminant = variant.discriminants.find((entry) => entry.name === discriminantName);
    if (!discriminant) {
      ctx.error(
        `${macroName} requires each tagged variant to declare the discriminant property "${discriminantName}".`,
        variant.node,
      );
    }
    const fields: TField[] = [];

    for (const reflectedField of variant.fields) {
      const field = collectField(reflectedField, typeName, declaration);
      if (field !== null) {
        fields.push(field);
      }
    }

    return {
      fields,
      tag: discriminant.tag,
    };
  });

  return { discriminantName, typeName, variants };
}

function taggedVariantTypeText(typeName: string, discriminantName: string, tag: string): string {
  return `Extract<${typeName}, { ${propertyKeyText(discriminantName)}: "${tag}" }>`;
}

function foldUnionText(helperText: string, expressions: readonly string[]): string {
  const [first, ...rest] = expressions;
  if (!first) {
    throw new Error('foldUnionText requires at least one expression.');
  }

  return rest.reduce((current, expression) => `${helperText}(${current}, ${expression})`, first);
}

function collectTaggedVariants(
  ctx: Parameters<MacroDefinition<typeof TAGGED_SIGNATURE>['expand']>[0],
  declaration: MacroTypeAliasDeclSyntax,
): {
  readonly discriminantName: string | null;
  readonly typeName: string;
  readonly variants: readonly TaggedVariant[];
} {
  const shape = ctx.reflect.declarationShape(declaration);
  if (shape.kind === 'discriminatedUnion') {
    const discriminantName = taggedDiscriminantName(ctx, declaration);
    const unionShape = shape;
    const typeName = unionShape.name ??
      ctx.error('tagged currently requires named type aliases.', declaration);

    const seenTags = new Set<string>();
    const variants = unionShape.variants.map((variant) => {
      const discriminant = variant.discriminants.find((entry) => entry.name === discriminantName);
      if (!discriminant) {
        ctx.error(
          `tagged requires each variant to declare the discriminant property "${discriminantName}".`,
          variant.node,
        );
      }

      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(discriminant.tag)) {
        ctx.error('tagged requires identifier-safe string literal tags in v1.', variant.node);
      }

      if (seenTags.has(discriminant.tag)) {
        ctx.error(`tagged requires unique "${discriminantName}" variant tags.`, variant.node);
      }
      seenTags.add(discriminant.tag);

      return {
        constructorName: discriminant.tag,
        constructorTypeParametersText: '',
        kind: 'object' as const,
        payloadFields: variant.fields.map((field) => {
          if (!field.type) {
            ctx.error(
              'tagged currently requires explicit payload property types in v1.',
              field.node,
            );
          }
          return {
            name: field.name,
            optional: field.optional,
            typeText: field.type.text,
          };
        }),
        predicateConditionText: `${
          propertyAccessText('value', discriminantName)
        } === '${discriminant.tag}'`,
        predicateName: `is${capitalizeName(discriminant.tag)}`,
        predicateNarrowTypeText: `Extract<${typeName}, { ${
          propertyKeyText(discriminantName)
        }: "${discriminant.tag}" }>`,
        predicateTypeParametersText: '',
        predicateValueTypeText: typeName,
        returnExpressionText: variant.fields.length === 0
          ? `{ ${propertyKeyText(discriminantName)}: '${discriminant.tag}' }`
          : `{ ${propertyKeyText(discriminantName)}: '${discriminant.tag}', ...payload }`,
      };
    });

    return { discriminantName, typeName, variants };
  }

  const unionType = declaration.type.asUnion();
  if (!unionType) {
    return validateTaggedUnionSyntaxForDiagnostics(
      ctx,
      declaration,
      'tagged',
      taggedDiscriminantName(ctx, declaration),
    );
  }
  if (unionType.members.every((member) => member.asObjectLiteral() !== null)) {
    return validateTaggedUnionSyntaxForDiagnostics(
      ctx,
      declaration,
      'tagged',
      taggedDiscriminantName(ctx, declaration),
    );
  }

  const hostDeclaration = getHostDeclaration(declaration);
  if (!ts.isTypeAliasDeclaration(hostDeclaration)) {
    return validateTaggedUnionSyntaxForDiagnostics(
      ctx,
      declaration,
      'tagged',
      taggedDiscriminantName(ctx, declaration),
    );
  }
  const sourceFile = hostDeclaration.getSourceFile();
  const hostUnionType = ts.isUnionTypeNode(hostDeclaration.type)
    ? hostDeclaration.type
    : undefined;
  if (!hostUnionType) {
    return validateTaggedUnionSyntaxForDiagnostics(
      ctx,
      declaration,
      'tagged',
      taggedDiscriminantName(ctx, declaration),
    );
  }
  const typeName = hostDeclaration.name?.text ??
    ctx.error('tagged currently requires named type aliases.', declaration);
  const aliasTypeParameters =
    hostDeclaration.typeParameters?.map((parameter) => parameter.getText(sourceFile)) ?? [];
  const aliasTypeParametersText = aliasTypeParameters.length === 0
    ? ''
    : `<${aliasTypeParameters.join(', ')}>`;
  const aliasAppliedTypeText = `${typeName}${aliasTypeParametersText}`;
  const variants = hostUnionType.types.map((hostMember: ts.TypeNode, index: number) => {
    if (!ts.isTypeReferenceNode(hostMember)) {
      ctx.error(
        'tagged only supports unions of object-like variants or named classes in the same module in v1.',
        declaration,
      );
    }
    const member = unionType.members[index];
    if (!member) {
      ctx.error(
        'tagged only supports unions of object-like variants or named classes in the same module in v1.',
        declaration,
      );
    }
    const classDeclaration = ctx.semantics.classDeclarationOfType(member);
    if (!classDeclaration || classDeclaration.span.fileName !== sourceFile.fileName) {
      ctx.error(
        'tagged only supports unions of object-like variants or named classes in the same module in v1.',
        declaration,
      );
    }
    const className = classDeclaration.name ??
      ctx.error(
        'tagged only supports unions of object-like variants or named classes in the same module in v1.',
        declaration,
      );
    const constructor = classDeclaration.members().find((classMember) =>
      classMember.memberKind === 'constructor'
    );
    const payloadFields = constructor
      ? constructor.parameters.map((parameter) => {
        const explicitType = parameter.explicitType();
        if (!parameter.name || !explicitType) {
          ctx.error(
            'tagged value-class variants require constructors with simple identifier parameters and explicit types in v1.',
            declaration,
          );
        }
        return {
          name: parameter.name,
          optional: false,
          typeText: explicitType.text(),
        };
      })
      : [];

    const variantTypeParameters = hostMember.typeArguments?.flatMap((typeArgument) =>
      ts.isTypeReferenceNode(typeArgument) && ts.isIdentifier(typeArgument.typeName) &&
        !typeArgument.typeArguments?.length
        ? [typeArgument.typeName.text]
        : []
    ) ?? [];
    const variantTypeParametersText = variantTypeParameters.length === 0
      ? ''
      : `<${variantTypeParameters.join(', ')}>`;

    return {
      constructorName: decapitalizeName(className),
      constructorTypeParametersText: variantTypeParametersText,
      kind: 'class' as const,
      payloadFields,
      predicateConditionText: `value instanceof ${className}`,
      predicateName: `is${className}`,
      predicateNarrowTypeText: hostMember.getText(sourceFile),
      predicateTypeParametersText: aliasTypeParametersText,
      predicateValueTypeText: aliasAppliedTypeText,
      returnExpressionText: payloadFields.length === 0
        ? `new ${className}()`
        : `new ${className}(${
          payloadFields.map((field) => field.name).join(', ')
        })`,
    };
  });

  return {
    discriminantName: null,
    typeName,
    variants,
  };
}

function taggedPayloadTypeText(fields: readonly TaggedVariantField[]): string {
  if (fields.length === 0) {
    return '{}';
  }
  return `{ ${
    fields.map((field) =>
      `${propertyKeyText(field.name)}${field.optional ? '?' : ''}: ${field.typeText}`
    ).join('; ')
  } }`;
}

function taggedConstructorText(
  discriminantName: string | null,
  typeName: string,
  variant: TaggedVariant,
): string {
  const returnType = variant.kind === 'class' ? variant.predicateNarrowTypeText : typeName;
  const parameterText = variant.payloadFields.length === 0
    ? ''
    : variant.kind === 'class'
    ? variant.payloadFields.map((field) => `${field.name}: ${field.typeText}`).join(', ')
    : `payload: ${taggedPayloadTypeText(variant.payloadFields)}`;
  const typeParametersText = variant.constructorTypeParametersText;

  if (parameterText.length === 0) {
    return `${variant.constructorName}${typeParametersText}(): ${returnType} {
      return ${variant.returnExpressionText};
    }`;
  }

  return `${variant.constructorName}${typeParametersText}(${parameterText}): ${returnType} {
    return ${variant.returnExpressionText};
  }`;
}

function taggedPredicateText(
  _discriminantName: string | null,
  _typeName: string,
  variant: TaggedVariant,
): string {
  return `${variant.predicateName}${variant.predicateTypeParametersText}(value: ${variant.predicateValueTypeText}): value is ${variant.predicateNarrowTypeText} {
    return ${variant.predicateConditionText};
  }`;
}

function taggedEqCaseText(
  discriminantName: string,
  typeName: string,
  variant: TaggedDerivedVariant<DerivedField>,
): string {
  const rightName = `right${capitalizeName(variant.tag)}`;
  const equalsBody = variant.fields.length === 0
    ? 'true'
    : variant.fields.map((field) => eqCheckText(field, 'left', rightName)).join(' && ');
  return `case '${variant.tag}': {
    const ${rightName} = right as ${taggedVariantTypeText(typeName, discriminantName, variant.tag)};
    return ${equalsBody};
  }`;
}

function taggedHashCaseText(
  discriminantName: string,
  typeName: string,
  variant: TaggedDerivedVariant<DerivedField>,
  stringHashText: string,
  combineHashesText: string,
): string {
  const rightName = `right${capitalizeName(variant.tag)}`;
  const payloadHashes = variant.fields.map((field) => hashExprText(field, 'value'));
  const hashExpr = `${combineHashesText}(${
    [
      `${stringHashText}.hash(${JSON.stringify(variant.tag)})`,
      ...payloadHashes,
    ].join(', ')
  })`;
  const equalsBody = variant.fields.length === 0
    ? 'true'
    : variant.fields.map((field) => eqCheckText(field, 'value', rightName)).join(' && ');
  return `case '${variant.tag}': {
    if (mode === 'hash') {
      return ${hashExpr};
    }
    const ${rightName} = right as ${taggedVariantTypeText(typeName, discriminantName, variant.tag)};
    return ${equalsBody};
  }`;
}

function taggedDecodeVariantText(
  discriminantName: string,
  variant: TaggedDerivedVariant<DecodedField>,
  decodeLiteralText: string,
  decodeMapText: string,
  decodeObjectText: string,
  decodeOptionalText: string,
): string {
  const shapeEntries = [
    `${propertyKeyText(discriminantName)}: ${decodeLiteralText}(${JSON.stringify(variant.tag)})`,
    ...variant.fields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${decodeOptionalText}(${field.decoderText})` : field.decoderText
      }`
    ),
  ];
  const projectionEntries = [
    `${propertyKeyText(discriminantName)}: ${JSON.stringify(variant.tag)}`,
    ...variant.fields.map((field) =>
      `${propertyKeyText(field.localName)}: ${propertyAccessText('value', field.wireName)}`
    ),
  ];
  return `${decodeMapText}(
    ${decodeObjectText}({
      ${shapeEntries.join(',\n')}
    }),
    (value) => ({
      ${projectionEntries.join(',\n')}
    }),
  )`;
}

function taggedEncodeVariantProjectionText(
  discriminantName: string,
  variant: TaggedDerivedVariant<EncodedField>,
  receiverName: string,
): string {
  return `({
    ${
    [
      `${propertyKeyText(discriminantName)}: ${JSON.stringify(variant.tag)}`,
      ...variant.fields.map((field) =>
        `${propertyKeyText(field.wireName)}: ${propertyAccessText(receiverName, field.localName)}`
      ),
    ].join(',\n')
  }
  })`;
}

function taggedEncodeVariantShapeText(
  discriminantName: string,
  variant: TaggedDerivedVariant<EncodedField>,
  encodeOptionalText: string,
  stringEncoderText: string,
): string {
  return `{
    ${
    [
      `${propertyKeyText(discriminantName)}: ${stringEncoderText}`,
      ...variant.fields.map((field) =>
        `${propertyKeyText(field.wireName)}: ${
          field.optional ? `${encodeOptionalText}(${field.encoderText})` : field.encoderText
        }`
      ),
    ].join(',\n')
  }
  }`;
}

function taggedCodecDecodeVariantText(
  discriminantName: string,
  variant: TaggedDerivedVariant<CodecField>,
  decodeLiteralText: string,
  decodeMapText: string,
  decodeObjectText: string,
  decodeOptionalText: string,
): string {
  const shapeEntries = [
    `${propertyKeyText(discriminantName)}: ${decodeLiteralText}(${JSON.stringify(variant.tag)})`,
    ...variant.fields.map((field) =>
      `${propertyKeyText(field.wireName)}: ${
        field.optional ? `${decodeOptionalText}(${field.decodeText})` : field.decodeText
      }`
    ),
  ];
  const projectionEntries = [
    `${propertyKeyText(discriminantName)}: ${JSON.stringify(variant.tag)}`,
    ...variant.fields.map((field) =>
      `${propertyKeyText(field.localName)}: ${propertyAccessText('value', field.wireName)}`
    ),
  ];
  return `${decodeMapText}(
    ${decodeObjectText}({
      ${shapeEntries.join(',\n')}
    }),
    (value) => ({
      ${projectionEntries.join(',\n')}
    }),
  )`;
}

function taggedCodecEncodeVariantShapeText(
  discriminantName: string,
  variant: TaggedDerivedVariant<CodecField>,
  encodeOptionalText: string,
  stringEncoderText: string,
): string {
  return `{
    ${
    [
      `${propertyKeyText(discriminantName)}: ${stringEncoderText}`,
      ...variant.fields.map((field) =>
        `${propertyKeyText(field.wireName)}: ${
          field.optional ? `${encodeOptionalText}(${field.encodeText})` : field.encodeText
        }`
      ),
    ].join(',\n')
  }
  }`;
}

function taggedCodecEncodeVariantProjectionText(
  discriminantName: string,
  variant: TaggedDerivedVariant<CodecField>,
  receiverName: string,
): string {
  return `({
    ${
    [
      `${propertyKeyText(discriminantName)}: ${JSON.stringify(variant.tag)}`,
      ...variant.fields.map((field) =>
        `${propertyKeyText(field.wireName)}: ${propertyAccessText(receiverName, field.localName)}`
      ),
    ].join(',\n')
  }
  })`;
}

// #[macro(decl)]
export function eq(): MacroDefinition<typeof DERIVE_SIGNATURE> {
  return {
    declarationKinds: ['class', 'interface', 'typeAlias'],
    expansionMode: 'augment',
    expand(ctx, decoded) {
      if (decoded.caseName === 'typeAlias') {
        const declaration = decoded.args.target as MacroTypeAliasDeclSyntax;
        if (!declaration.type.asObjectLiteral() && declaration.type.asUnion()) {
          const { discriminantName, typeName, variants } = collectTaggedDerivedVariants(
            ctx,
            declaration,
            'eq',
            (field, ownerTypeName, scopeNode) =>
              eqHashFieldFromReflectedShape(ctx, field, 'eq', ownerTypeName, scopeNode),
          );
          const switchCases = variants.map((variant) =>
            taggedEqCaseText(discriminantName, typeName, variant)
          ).join('\n');
          return ctx.output.stmt(
            ctx.quote.stmt`
              export const ${`${typeName}Eq`} = {
                equals(left: ${typeName}, right: ${typeName}) {
                  if (${propertyAccessText('left', discriminantName)} !== ${
              propertyAccessText('right', discriminantName)
            }) {
                    return false;
                  }
                  switch (${propertyAccessText('left', discriminantName)}) {
                    ${switchCases}
                    default:
                      return false;
                  }
                },
              };
            `,
          );
        }
      }

      const { fields, typeName } = collectFields(ctx, 'eq', decoded);
      const equalsBody = fields.length === 0
        ? 'true'
        : fields.map((field) => eqCheckText(field, 'left', 'right')).join(' && ');
      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${`${typeName}Eq`} = {
            equals(left: ${typeName}, right: ${typeName}) {
              return ${equalsBody};
            },
          };
        `,
      );
    },
    signature: DERIVE_SIGNATURE,
  };
}
attachDeriveFactory(eq);

// #[macro(decl)]
export function hash(): MacroDefinition<typeof DERIVE_SIGNATURE> {
  return {
    declarationKinds: ['class', 'interface', 'typeAlias'],
    expansionMode: 'augment',
    expand(ctx, decoded) {
      if (decoded.caseName === 'typeAlias') {
        const declaration = decoded.args.target as MacroTypeAliasDeclSyntax;
        if (!declaration.type.asObjectLiteral() && declaration.type.asUnion()) {
          const { discriminantName, typeName, variants } = collectTaggedDerivedVariants(
            ctx,
            declaration,
            'hash',
            (field, ownerTypeName, scopeNode) =>
              eqHashFieldFromReflectedShape(ctx, field, 'hash', ownerTypeName, scopeNode),
          );
          const fromHashEq = ctx.runtime.named('sts:hash', 'fromHashEq').text();
          const combineHashes = ctx.runtime.named('sts:hash', 'combineHashes').text();
          const stringHash = ctx.runtime.named('sts:hash', 'stringHash').text();
          const switchCases = variants.map((variant) =>
            taggedHashCaseText(discriminantName, typeName, variant, stringHash, combineHashes)
          ).join('\n');
          return ctx.output.stmt(
            ctx.quote.stmt`
              export const ${`${typeName}Hash`} = ${fromHashEq}<${typeName}>(
                (value) => {
                  const mode = 'hash' as const;
                  switch (${propertyAccessText('value', discriminantName)}) {
                    ${switchCases}
                    default:
                      return 0;
                  }
                },
                (value, right) => {
                  const mode = 'equals' as const;
                  if (${propertyAccessText('value', discriminantName)} !== ${
              propertyAccessText('right', discriminantName)
            }) {
                    return false;
                  }
                  switch (${propertyAccessText('value', discriminantName)}) {
                    ${switchCases}
                    default:
                      return false;
                  }
                },
              );
            `,
          );
        }
      }

      const { fields, typeName } = collectFields(ctx, 'hash', decoded);
      const fromHashEq = ctx.runtime.named('sts:hash', 'fromHashEq').text();
      const combineHashes = ctx.runtime.named('sts:hash', 'combineHashes').text();
      const hashArgs = fields.map((field) => hashExprText(field, 'value')).join(', ');
      const equalsBody = fields.length === 0
        ? 'true'
        : fields.map((field) => eqCheckText(field, 'left', 'right')).join(' && ');

      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${`${typeName}Hash`} = ${fromHashEq}<${typeName}>(
            (value) => ${combineHashes}(${hashArgs}),
            (left, right) => ${equalsBody},
          );
        `,
      );
    },
    signature: DERIVE_SIGNATURE,
  };
}
attachDeriveFactory(hash);

// #[macro(decl)]
export function tagged(): MacroDefinition<typeof TAGGED_SIGNATURE> {
  return {
    declarationKinds: ['typeAlias'],
    expansionMode: 'augment',
    expand(ctx, decoded) {
      const declaration = decoded.args.target;
      const { discriminantName, typeName, variants } = collectTaggedVariants(ctx, declaration);
      const companionMembers = variants.flatMap((variant) => [
        taggedConstructorText(discriminantName, typeName, variant),
        taggedPredicateText(discriminantName, typeName, variant),
      ]).join(',\n');

      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${`${typeName}Tagged`} = {
            ${companionMembers}
          };
        `,
      );
    },
    signature: TAGGED_SIGNATURE,
  };
}
attachDeriveFactory(tagged);

// #[macro(decl)]
export function decode(): MacroDefinition<typeof DECODE_SIGNATURE> {
  return {
    declarationKinds: ['class', 'interface', 'typeAlias'],
    expansionMode: 'augment',
    expand(ctx, decoded) {
      if (decoded.caseName === 'typeAlias') {
        const declaration = decoded.args.target as MacroTypeAliasDeclSyntax;
        if (!declaration.type.asObjectLiteral() && declaration.type.asUnion()) {
          const { discriminantName, typeName, variants } = collectTaggedDerivedVariants(
            ctx,
            declaration,
            'decode',
            (field, ownerTypeName, scopeNode) =>
              decodeFieldFromReflectedShape(ctx, field, ownerTypeName, scopeNode),
          );
          const decodeObject = ctx.runtime.named('sts:decode', 'object').text();
          const decodeMap = ctx.runtime.named('sts:decode', 'map').text();
          const decodeOptional = ctx.runtime.named('sts:decode', 'optional').text();
          const decodeLiteral = ctx.runtime.named('sts:decode', 'literal').text();
          const decodeUnion = ctx.runtime.named('sts:decode', 'union').text();
          const variantDecoders = variants.map((variant) =>
            taggedDecodeVariantText(
              discriminantName,
              variant,
              decodeLiteral,
              decodeMap,
              decodeObject,
              decodeOptional,
            )
          );
          const unionText = foldUnionText(decodeUnion, variantDecoders);
          return ctx.output.stmt(
            ctx.quote.stmt`
              export const ${`${typeName}Decoder`} = ${unionText};
            `,
          );
        }
      }

      const { fields, instantiateText, typeName } = collectDecodeFields(ctx, decoded);
      const object = ctx.runtime.named('sts:decode', 'object').text();
      const map = ctx.runtime.named('sts:decode', 'map').text();
      const optional = ctx.runtime.named('sts:decode', 'optional').text();
      const shapeText = fields.length === 0 ? '{}' : `{
            ${
        fields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${
            field.optional ? `${optional}(${field.decoderText})` : field.decoderText
          }`
        ).join(',\n')
      }
          }`;

      const projectionText = fields.length === 0 ? '{}' : `({
            ${
        fields.map((field) =>
          `${propertyKeyText(field.localName)}: ${propertyAccessText('value', field.wireName)}`
        ).join(',\n')
      }
          })`;
      const finalProjectionText = instantiateText === null
        ? projectionText
        : `(${instantiateText.replace(CLASS_DECODE_VALUE_PLACEHOLDER, projectionText)})`;

      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${`${typeName}Decoder`} = ${map}(
            ${object}(${shapeText}),
            (value) => ${finalProjectionText},
          );
        `,
      );
    },
    signature: DECODE_SIGNATURE,
  };
}
attachDeriveFactory(decode);

// #[macro(decl)]
export function encode(): MacroDefinition<typeof DECODE_SIGNATURE> {
  return {
    declarationKinds: ['class', 'interface', 'typeAlias'],
    expansionMode: 'augment',
    expand(ctx, decoded) {
      if (decoded.caseName === 'typeAlias') {
        const declaration = decoded.args.target as MacroTypeAliasDeclSyntax;
        if (!declaration.type.asObjectLiteral() && declaration.type.asUnion()) {
          const { discriminantName, typeName, variants } = collectTaggedDerivedVariants(
            ctx,
            declaration,
            'encode',
            (field, ownerTypeName, scopeNode) =>
              encodeFieldFromReflectedShape(ctx, field, ownerTypeName, scopeNode),
          );
          const encodeFromEncode = ctx.runtime.named('sts:encode', 'fromEncode').text();
          const encodeObject = ctx.runtime.named('sts:encode', 'object').text();
          const encodeOptional = ctx.runtime.named('sts:encode', 'optional').text();
          const stringEncoder = ctx.runtime.named('sts:encode', 'stringEncoder').text();
          const switchCases = variants.map((variant) => {
            const variantType = taggedVariantTypeText(typeName, discriminantName, variant.tag);
            const shapeText = taggedEncodeVariantShapeText(
              discriminantName,
              variant,
              encodeOptional,
              stringEncoder,
            );
            const projectionText = taggedEncodeVariantProjectionText(
              discriminantName,
              variant,
              `value as ${variantType}`,
            );
            return `case '${variant.tag}':
              return ${encodeObject}(${shapeText}).encode(${projectionText});`;
          }).join('\n');
          return ctx.output.stmt(
            ctx.quote.stmt`
              export const ${`${typeName}Encoder`} = ${encodeFromEncode}((value: ${typeName}) => {
                switch (${propertyAccessText('value', discriminantName)}) {
                  ${switchCases}
                  default:
                    throw new Error('unreachable tagged union encoder case');
                }
              });
            `,
          );
        }
      }

      const { fields, typeName } = collectEncodeFields(ctx, decoded);
      const contramap = ctx.runtime.named('sts:encode', 'contramap').text();
      const object = ctx.runtime.named('sts:encode', 'object').text();
      const optional = ctx.runtime.named('sts:encode', 'optional').text();
      const shapeText = fields.length === 0 ? '{}' : `{
            ${
        fields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${
            field.optional ? `${optional}(${field.encoderText})` : field.encoderText
          }`
        ).join(',\n')
      }
          }`;

      const projectionText = fields.length === 0 ? '({})' : `({
            ${
        fields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${propertyAccessText('value', field.localName)}`
        ).join(',\n')
      }
          })`;

      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${`${typeName}Encoder`} = ${contramap}(
            ${object}(${shapeText}),
            (value: ${typeName}) => ${projectionText},
          );
        `,
      );
    },
    signature: DECODE_SIGNATURE,
  };
}
attachDeriveFactory(encode);

// #[macro(decl)]
export function codec(): MacroDefinition<typeof DECODE_SIGNATURE> {
  return {
    declarationKinds: ['class', 'interface', 'typeAlias'],
    expansionMode: 'augment',
    expand(ctx, decoded) {
      if (decoded.caseName === 'typeAlias') {
        const declaration = decoded.args.target as MacroTypeAliasDeclSyntax;
        if (!declaration.type.asObjectLiteral() && declaration.type.asUnion()) {
          const { discriminantName, typeName, variants } = collectTaggedDerivedVariants(
            ctx,
            declaration,
            'codec',
            (field, ownerTypeName, scopeNode) =>
              codecFieldFromReflectedShape(ctx, field, ownerTypeName, scopeNode),
          );
          const createCodec = ctx.runtime.named('sts:codec', 'codec').text();
          const decodeObject = ctx.runtime.named('sts:decode', 'object').text();
          const decodeMap = ctx.runtime.named('sts:decode', 'map').text();
          const decodeOptional = ctx.runtime.named('sts:decode', 'optional').text();
          const decodeLiteral = ctx.runtime.named('sts:decode', 'literal').text();
          const decodeUnion = ctx.runtime.named('sts:decode', 'union').text();
          const encodeFromEncode = ctx.runtime.named('sts:encode', 'fromEncode').text();
          const encodeObject = ctx.runtime.named('sts:encode', 'object').text();
          const encodeOptional = ctx.runtime.named('sts:encode', 'optional').text();
          const stringEncoder = ctx.runtime.named('sts:encode', 'stringEncoder').text();
          const variantDecoders = variants.map((variant) =>
            taggedCodecDecodeVariantText(
              discriminantName,
              variant,
              decodeLiteral,
              decodeMap,
              decodeObject,
              decodeOptional,
            )
          );
          const unionText = foldUnionText(decodeUnion, variantDecoders);
          const switchCases = variants.map((variant) => {
            const variantType = taggedVariantTypeText(typeName, discriminantName, variant.tag);
            const shapeText = taggedCodecEncodeVariantShapeText(
              discriminantName,
              variant,
              encodeOptional,
              stringEncoder,
            );
            const projectionText = taggedCodecEncodeVariantProjectionText(
              discriminantName,
              variant,
              `value as ${variantType}`,
            );
            return `case '${variant.tag}':
              return ${encodeObject}(${shapeText}).encode(${projectionText});`;
          }).join('\n');
          return ctx.output.stmt(
            ctx.quote.stmt`
              export const ${`${typeName}Codec`} = ${createCodec}(
                ${unionText},
                ${encodeFromEncode}((value: ${typeName}) => {
                  switch (${propertyAccessText('value', discriminantName)}) {
                    ${switchCases}
                    default:
                      throw new Error('unreachable tagged union codec case');
                  }
                }),
              );
            `,
          );
        }
      }

      const { fields, instantiateText, typeName } = collectCodecFields(ctx, decoded);
      const codec = ctx.runtime.named('sts:codec', 'codec').text();
      const decodeObject = ctx.runtime.named('sts:decode', 'object').text();
      const decodeMap = ctx.runtime.named('sts:decode', 'map').text();
      const decodeOptional = ctx.runtime.named('sts:decode', 'optional').text();
      const encodeContramap = ctx.runtime.named('sts:encode', 'contramap').text();
      const encodeObject = ctx.runtime.named('sts:encode', 'object').text();
      const encodeOptional = ctx.runtime.named('sts:encode', 'optional').text();
      const decodeShapeText = fields.length === 0 ? '{}' : `{
            ${
        fields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${
            field.optional ? `${decodeOptional}(${field.decodeText})` : field.decodeText
          }`
        ).join(',\n')
      }
          }`;

      const decodeProjectionText = fields.length === 0 ? '{}' : `({
            ${
        fields.map((field) =>
          `${propertyKeyText(field.localName)}: ${propertyAccessText('value', field.wireName)}`
        ).join(',\n')
      }
          })`;
      const finalDecodeProjectionText = instantiateText === null
        ? decodeProjectionText
        : `(${instantiateText.replace(CLASS_DECODE_VALUE_PLACEHOLDER, decodeProjectionText)})`;

      const encodeShapeText = fields.length === 0 ? '{}' : `{
            ${
        fields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${
            field.optional ? `${encodeOptional}(${field.encodeText})` : field.encodeText
          }`
        ).join(',\n')
      }
          }`;

      const encodeProjectionText = fields.length === 0 ? '({})' : `({
            ${
        fields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${propertyAccessText('value', field.localName)}`
        ).join(',\n')
      }
          })`;

      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${`${typeName}Codec`} = ${codec}(
            ${decodeMap}(
              ${decodeObject}(${decodeShapeText}),
              (value) => ${finalDecodeProjectionText},
            ),
            ${encodeContramap}(
              ${encodeObject}(${encodeShapeText}),
              (value: ${typeName}) => ${encodeProjectionText},
            ),
          );
        `,
      );
    },
    signature: DECODE_SIGNATURE,
  };
}
attachDeriveFactory(codec);
