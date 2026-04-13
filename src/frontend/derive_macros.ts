import ts from 'typescript';

import { createAnnotationLookup } from '../language/annotation_syntax.ts';
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
  TypeSyntax,
} from './macro_api.ts';
import { macroSignature } from './macro_api.ts';
import { attachMacroFactoryMetadata } from './macro_api_internal.ts';
import { inferDeriveHelperMode } from './derive_helper_mode.ts';
import { semanticLookupNodeForContext } from './macro_context_internal.ts';
import { getInternalChecker } from './macro_type_internal.ts';
import { getHostDeclaration, getHostNode } from './macro_syntax_internal.ts';
import {
  JSON_STDLIB_DECLARATION_FILE,
  resolveStdlibDeclarationRuntimePath,
} from './std_package_support.ts';
import { resolveAliasedSymbol } from './value_binding_internal.ts';

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
  readonly defaultText: string | null;
  readonly decoderText: string;
  readonly localName: string;
  readonly metadataEffectsText: string | null;
  readonly optional: boolean;
  readonly wireName: string;
}

interface EncodedField {
  readonly encoderText: string;
  readonly localName: string;
  readonly metadataEffectsText: string | null;
  readonly optional: boolean;
  readonly wireName: string;
}

interface CodecField {
  readonly decodeDefaultText: string | null;
  readonly decodeOptional: boolean;
  readonly decodeText: string;
  readonly encodeText: string;
  readonly localName: string;
  readonly metadataEffectsText: string | null;
  readonly optional: boolean;
  readonly wireName: string;
}

interface TaggedDerivedVariant<TField> {
  readonly fields: readonly TField[];
  readonly tag: string;
}

const CLASS_DECODE_VALUE_PLACEHOLDER = '__sts_decoded_value__';
const JSON_STDLIB_RUNTIME_FILE = resolveStdlibDeclarationRuntimePath(JSON_STDLIB_DECLARATION_FILE);

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

function declarationAnnotations(
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
): readonly MacroAnnotation[] {
  const hostDeclaration = getHostDeclaration(declaration);
  return createAnnotationLookup(hostDeclaration.getSourceFile()).getAttachedAnnotations(
    hostDeclaration,
  );
}

function resolvedDeclarationAnnotations(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
): readonly MacroAnnotation[] {
  const syntaxAnnotations = ctx.syntax.annotations(declaration);
  return syntaxAnnotations.length > 0 ? syntaxAnnotations : declarationAnnotations(declaration);
}

function annotationIdentifierArgument(annotation: MacroAnnotation): string | null {
  const [firstArgument] = annotation.arguments ?? [];
  if (!firstArgument) {
    return null;
  }
  return firstArgument.value.kind === 'identifier'
    ? firstArgument.value.name
    : firstArgument.value.kind === 'member'
    ? firstArgument.value.text
    : null;
}

function annotationStringArgument(annotation: MacroAnnotation): string | null {
  const [firstArgument] = annotation.arguments ?? [];
  return firstArgument?.value.kind === 'string' ? firstArgument.value.value : null;
}

function annotationNumberArgument(annotation: MacroAnnotation): number | null {
  const [firstArgument] = annotation.arguments ?? [];
  return firstArgument?.value.kind === 'number' ? firstArgument.value.value : null;
}

function annotationNumberishTextArgument(annotation: MacroAnnotation): string | null {
  const [firstArgument] = annotation.arguments ?? [];
  return firstArgument?.value.kind === 'number' || firstArgument?.value.kind === 'bigint'
    ? firstArgument.value.text
    : null;
}

function annotationRegexpArgument(annotation: MacroAnnotation): string | null {
  const [firstArgument] = annotation.arguments ?? [];
  return firstArgument?.value.kind === 'regexp' ? firstArgument.value.text : null;
}

function annotationValueText(annotation: MacroAnnotation): string | null {
  const [firstArgument] = annotation.arguments ?? [];
  return firstArgument?.value.text ?? null;
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

function declarationAnnotationDiagnosticNode(
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  annotation: MacroAnnotation,
): MacroSyntaxNode {
  return declaration.declarationKind === 'class'
    ? annotationDiagnosticNode(declaration, annotation) ?? declaration
    : declaration;
}

function asMacroDeclarationNode(
  node: MacroSyntaxNode,
): MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax | undefined {
  return 'declarationKind' in node
    ? node as MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax
    : undefined;
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

function decodeDefaultProjectionText(accessText: string, defaultText: string | null): string {
  return defaultText === null
    ? accessText
    : `${accessText} === undefined ? (${defaultText}) : ${accessText}`;
}

type ObjectProjectionField = {
  readonly keyName: string;
  readonly optional: boolean;
  readonly valueText: string;
};

function objectProjectionText(fields: readonly ObjectProjectionField[]): string {
  if (fields.length === 0) {
    return '({})';
  }
  return `({
    ${
    fields.map((field) =>
      field.optional
        ? `...(${field.valueText} === undefined ? {} : { ${propertyKeyText(field.keyName)}: ${field.valueText} })`
        : `${propertyKeyText(field.keyName)}: ${field.valueText}`
    ).join(',\n')
  }
  })`;
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

type StdlibJsonHelperKind = 'jsonArray' | 'jsonObject' | 'jsonValue';

function normalizeFileNameForComparison(fileName: string): string {
  return fileName.replace(/\\/gu, '/');
}

function isJsonStdlibFile(fileName: string): boolean {
  const normalized = normalizeFileNameForComparison(fileName);
  return normalized === normalizeFileNameForComparison(JSON_STDLIB_DECLARATION_FILE) ||
    normalized === normalizeFileNameForComparison(JSON_STDLIB_RUNTIME_FILE) ||
    /(?:^|\/)@soundscript\/soundscript\/json\.d\.ts$/u.test(normalized) ||
    /(?:^|\/)(?:src\/stdlib|stdlib)\/json(?:\.d)?\.ts$/u.test(normalized);
}

function stdlibJsonHelperKindForSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
): StdlibJsonHelperKind | null {
  const resolved = resolveAliasedSymbol(checker, symbol);
  if (
    !(resolved.declarations ?? []).some((declaration) =>
      isJsonStdlibFile(declaration.getSourceFile().fileName)
    )
  ) {
    return null;
  }

  switch (resolved.getName()) {
    case 'JsonArray':
      return 'jsonArray';
    case 'JsonObject':
      return 'jsonObject';
    case 'JsonValue':
      return 'jsonValue';
    default:
      return null;
  }
}

function stdlibJsonHelperKindByName(name: string): StdlibJsonHelperKind | null {
  switch (name) {
    case 'JsonArray':
      return 'jsonArray';
    case 'JsonObject':
      return 'jsonObject';
    case 'JsonValue':
      return 'jsonValue';
    default:
      return null;
  }
}

function stdlibJsonHelperKindFromImportTypeNode(
  typeNode: ts.TypeNode,
): StdlibJsonHelperKind | null {
  if (!ts.isImportTypeNode(typeNode)) {
    return null;
  }
  if (!ts.isLiteralTypeNode(typeNode.argument) || !ts.isStringLiteral(typeNode.argument.literal)) {
    return null;
  }
  if (typeNode.argument.literal.text !== 'sts:json' || !typeNode.qualifier) {
    return null;
  }
  return ts.isIdentifier(typeNode.qualifier)
    ? stdlibJsonHelperKindByName(typeNode.qualifier.text)
    : ts.isQualifiedName(typeNode.qualifier) && ts.isIdentifier(typeNode.qualifier.right)
    ? stdlibJsonHelperKindByName(typeNode.qualifier.right.text)
    : null;
}

function stdlibJsonHelperKindFromSourceImport(
  typeNode: ts.TypeNode,
  sourceFile: ts.SourceFile = typeNode.getSourceFile(),
): StdlibJsonHelperKind | null {
  const normalized = unwrapParenthesizedTypeNode(typeNode);
  if (!normalized) {
    return null;
  }
  const directImportType = stdlibJsonHelperKindFromImportTypeNode(normalized);
  if (directImportType) {
    return directImportType;
  }

  let localName: string | null = null;
  let namespaceName: string | null = null;
  let qualifiedName: string | null = null;
  if (ts.isTypeReferenceNode(normalized)) {
    if (ts.isIdentifier(normalized.typeName)) {
      localName = normalized.typeName.text;
    } else if (
      ts.isQualifiedName(normalized.typeName) &&
      ts.isIdentifier(normalized.typeName.left) &&
      ts.isIdentifier(normalized.typeName.right)
    ) {
      namespaceName = normalized.typeName.left.text;
      qualifiedName = normalized.typeName.right.text;
    }
  }
  if (!localName && !(namespaceName && qualifiedName)) {
    return null;
  }

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'sts:json'
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (!importClause) {
      continue;
    }
    if (
      namespaceName &&
      importClause.namedBindings &&
      ts.isNamespaceImport(importClause.namedBindings) &&
      importClause.namedBindings.name.text === namespaceName
    ) {
      return stdlibJsonHelperKindByName(qualifiedName!);
    }
    if (
      localName &&
      importClause.namedBindings &&
      ts.isNamedImports(importClause.namedBindings)
    ) {
      for (const element of importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (element.name.text === localName) {
          return stdlibJsonHelperKindByName(importedName);
        }
      }
    }
  }

  return null;
}

function stdlibJsonHelperKindFromTypeReferenceNode(
  typeNode: ts.TypeNode,
): StdlibJsonHelperKind | null {
  const normalized = unwrapParenthesizedTypeNode(typeNode);
  if (!normalized || !ts.isTypeReferenceNode(normalized)) {
    return null;
  }
  return ts.isIdentifier(normalized.typeName)
    ? stdlibJsonHelperKindByName(normalized.typeName.text)
    : null;
}

function hostTypeNode(node: MacroSyntaxNode | null | undefined): ts.TypeNode | null {
  if (!node) {
    return null;
  }
  const hostNode = getHostNode(node);
  return hostNode && ts.isTypeNode(hostNode) ? hostNode : null;
}

function explicitTypeNodeForSyntaxNode(node: MacroSyntaxNode): ts.TypeNode | null {
  const candidate = node as MacroSyntaxNode & { explicitType?: () => TypeSyntax | null };
  if (typeof candidate.explicitType === 'function') {
    const explicitTypeNode = hostTypeNode(candidate.explicitType());
    if (explicitTypeNode) {
      return explicitTypeNode;
    }
  }
  const hostNode = getHostNode(node);
  const typedHostNode = hostNode as (ts.Node & { type?: ts.TypeNode | undefined }) | null;
  return typedHostNode?.type && ts.isTypeNode(typedHostNode.type) ? typedHostNode.type : null;
}

function unwrapParenthesizedTypeNode(typeNode: ts.TypeNode | null | undefined): ts.TypeNode | null {
  let current = typeNode ?? null;
  while (current && ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

function getTypeReferenceTargetSymbol(
  checker: ts.TypeChecker,
  node: ts.TypeNode,
): ts.Symbol | null {
  if (ts.isTypeReferenceNode(node)) {
    return checker.getSymbolAtLocation(node.typeName) ?? null;
  }
  if (ts.isImportTypeNode(node) && node.qualifier) {
    return checker.getSymbolAtLocation(node.qualifier) ?? null;
  }
  return null;
}

function getTypeReferenceArgumentNodes(node: ts.TypeNode): readonly ts.TypeNode[] | undefined {
  if (ts.isTypeReferenceNode(node)) {
    return node.typeArguments;
  }
  if (ts.isImportTypeNode(node)) {
    return node.typeArguments;
  }
  return undefined;
}

function arrayElementTypeNode(typeNode: ts.TypeNode | null | undefined): ts.TypeNode | null {
  const normalized = unwrapParenthesizedTypeNode(typeNode);
  if (!normalized) {
    return null;
  }
  if (ts.isArrayTypeNode(normalized)) {
    return normalized.elementType;
  }
  if (
    ts.isTypeReferenceNode(normalized) &&
    ts.isIdentifier(normalized.typeName) &&
    (normalized.typeName.text === 'Array' || normalized.typeName.text === 'ReadonlyArray')
  ) {
    return normalized.typeArguments?.[0] ?? null;
  }
  return null;
}

function tupleElementTypeNodes(
  typeNode: ts.TypeNode | null | undefined,
): readonly ts.TypeNode[] | null {
  const normalized = unwrapParenthesizedTypeNode(typeNode);
  return normalized && ts.isTupleTypeNode(normalized) ? normalized.elements : null;
}

function typeArgumentNodeAt(
  typeNode: ts.TypeNode | null | undefined,
  index: number,
): ts.TypeNode | null {
  const normalized = unwrapParenthesizedTypeNode(typeNode);
  return normalized ? getTypeReferenceArgumentNodes(normalized)?.[index] ?? null : null;
}

function unionMemberTypeNodes(
  typeNode: ts.TypeNode | null | undefined,
): readonly ts.TypeNode[] | null {
  const normalized = unwrapParenthesizedTypeNode(typeNode);
  return normalized && ts.isUnionTypeNode(normalized) ? normalized.types : null;
}

function isNullTypeNode(typeNode: ts.TypeNode | null | undefined): boolean {
  const normalized = unwrapParenthesizedTypeNode(typeNode);
  return normalized
    ? ts.isLiteralTypeNode(normalized) && normalized.literal.kind === ts.SyntaxKind.NullKeyword
    : false;
}

function isUndefinedTypeNode(typeNode: ts.TypeNode | null | undefined): boolean {
  const normalized = unwrapParenthesizedTypeNode(typeNode);
  return normalized?.kind === ts.SyntaxKind.UndefinedKeyword;
}

function stdlibJsonHelperKindForTypeNode(
  ctx: DeriveContext,
  scopeNode: MacroSyntaxNode,
  typeNode: ts.TypeNode | null | undefined,
  visiting: Set<string> = new Set(),
): StdlibJsonHelperKind | null {
  const normalized = unwrapParenthesizedTypeNode(typeNode);
  if (!normalized) {
    return null;
  }
  const lookupSourceFile = semanticLookupNodeForContext(ctx, scopeNode)?.getSourceFile();
  const importedHelperKind = stdlibJsonHelperKindFromSourceImport(
    normalized,
    lookupSourceFile ?? normalized.getSourceFile(),
  );
  if (importedHelperKind) {
    return importedHelperKind;
  }

  const helperKindFromReference = stdlibJsonHelperKindFromTypeReferenceNode(normalized);
  if (helperKindFromReference) {
    return helperKindFromReference;
  }

  if (ts.isTypeReferenceNode(normalized) && ts.isIdentifier(normalized.typeName)) {
    const localName = normalized.typeName.text;
    if (visiting.has(localName)) {
      return null;
    }
    const localDeclaration = ctx.semantics.localDeclaration(localName, scopeNode)?.asTypeAlias();
    if (localDeclaration) {
      visiting.add(localName);
      const aliasTypeNode = hostTypeNode(localDeclaration.type);
      if (aliasTypeNode) {
        const aliasHelperKind = stdlibJsonHelperKindForTypeNode(
          ctx,
          localDeclaration,
          aliasTypeNode,
          visiting,
        );
        if (aliasHelperKind) {
          return aliasHelperKind;
        }
      }
      visiting.delete(localName);
    }
  }

  if (!ts.isTypeReferenceNode(normalized)) {
    return null;
  }

  try {
    const checker = getInternalChecker(ctx.semantics.undefinedType());
    const symbol = getTypeReferenceTargetSymbol(checker, normalized);
    return symbol ? stdlibJsonHelperKindForSymbol(checker, symbol) : null;
  } catch {
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
    case 'intersection':
    case 'literal':
    case 'null':
    case 'record':
    case 'union':
    case 'undefined':
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

function annotationNamesIncludeAny(
  annotations: readonly MacroAnnotation[],
  names: readonly string[],
): boolean {
  return annotations.some((annotation) => names.includes(annotation.name));
}

function shapeContainsNamedReference(
  shape: MacroReflectedTypeShape,
  typeName: string,
): boolean {
  switch (shape.kind) {
    case 'named':
      return shape.name === typeName;
    case 'array':
      return shapeContainsNamedReference(shape.element, typeName);
    case 'tuple':
      return shape.elements.some((element) => shapeContainsNamedReference(element, typeName));
    case 'option':
      return shapeContainsNamedReference(shape.value, typeName);
    case 'result':
      return shapeContainsNamedReference(shape.ok, typeName) ||
        shapeContainsNamedReference(shape.err, typeName);
    case 'record':
      return shapeContainsNamedReference(shape.key, typeName) ||
        shapeContainsNamedReference(shape.value, typeName);
    case 'object':
      return shape.fields.some((field) =>
        field.type && shapeContainsNamedReference(field.type, typeName)
      );
    case 'intersection':
    case 'union':
      return shape.members.some((member) => shapeContainsNamedReference(member, typeName));
    case 'primitive':
    case 'literal':
    case 'null':
    case 'undefined':
    case 'unsupported':
      return false;
  }
}

function localNamedReferenceNeedsTypedRecursivePath(
  ctx: DeriveContext,
  name: string,
  ownerTypeName: string,
  macroName: 'decode' | 'encode' | 'codec',
  scopeNode: MacroSyntaxNode,
): boolean {
  if (name === ownerTypeName) {
    return true;
  }
  const localDeclaration = localDeclarationForNamedReference(ctx, scopeNode, name);
  if (!localDeclaration) {
    return false;
  }
  const participatesInRecursiveCycle = localDeclarationReachesTypeName(
    ctx,
    localDeclaration,
    ownerTypeName,
    macroName,
  );
  if (!participatesInRecursiveCycle) {
    return false;
  }
  switch (macroName) {
    case 'decode':
      return ctx.semantics.localDeclarationHasAnnotation(name, 'decode', scopeNode);
    case 'encode':
      return ctx.semantics.localDeclarationHasAnnotation(name, 'encode', scopeNode);
    case 'codec': {
      if (ctx.semantics.localDeclarationHasAnnotation(name, 'codec', scopeNode)) {
        return true;
      }
      return ctx.semantics.localDeclarationHasAnnotation(name, 'decode', scopeNode) &&
        ctx.semantics.localDeclarationHasAnnotation(name, 'encode', scopeNode);
    }
  }
}

function localDeclarationReachesTypeName(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  targetTypeName: string,
  macroName: 'decode' | 'encode' | 'codec',
  visiting: Set<string> = new Set(),
): boolean {
  const declarationName = declarationTypeName(declaration);
  if (!visiting.add(declarationName)) {
    return false;
  }

  const declarationShape = ctx.reflect.declarationShape(declaration);
  if (declarationShape.kind !== 'objectLike') {
    return false;
  }
  const shape = declarationShape;
  const referencedNames = collectTypedRecursiveLocalReferenceNames(
    ctx,
    {
      kind: 'object',
      fields: shape.fields,
      text: shape.text,
    } satisfies MacroReflectedTypeShape,
    declarationName,
    macroName,
    declaration,
  );
  for (const referencedName of referencedNames) {
    if (referencedName === targetTypeName) {
      return true;
    }
    const localDeclaration = findLocalDeclarationByName(ctx, declaration, referencedName);
    if (
      localDeclaration &&
      localDeclarationReachesTypeName(ctx, localDeclaration, targetTypeName, macroName, visiting)
    ) {
      return true;
    }
  }

  return false;
}

function localNamedReferenceParticipatesInMacro(
  ctx: DeriveContext,
  name: string,
  macroName: 'decode' | 'encode' | 'codec',
  scopeNode: MacroSyntaxNode,
): boolean {
  switch (macroName) {
    case 'decode':
      return ctx.semantics.localDeclarationHasAnnotation(name, 'decode', scopeNode);
    case 'encode':
      return ctx.semantics.localDeclarationHasAnnotation(name, 'encode', scopeNode);
    case 'codec':
      return ctx.semantics.localDeclarationHasAnnotation(name, 'codec', scopeNode) ||
        (
          ctx.semantics.localDeclarationHasAnnotation(name, 'decode', scopeNode) &&
          ctx.semantics.localDeclarationHasAnnotation(name, 'encode', scopeNode)
        );
  }
}

function shapeContainsPlainRecursiveLocalReference(
  ctx: DeriveContext,
  shape: MacroReflectedTypeShape,
  ownerTypeName: string,
  macroName: 'decode' | 'encode' | 'codec',
  scopeNode: MacroSyntaxNode,
): boolean {
  switch (shape.kind) {
    case 'named':
      return localNamedReferenceNeedsTypedRecursivePath(
        ctx,
        shape.name,
        ownerTypeName,
        macroName,
        scopeNode,
      );
    case 'array':
      return shapeContainsPlainRecursiveLocalReference(
        ctx,
        shape.element,
        ownerTypeName,
        macroName,
        scopeNode,
      );
    case 'tuple':
      return shape.elements.some((element) =>
        shapeContainsPlainRecursiveLocalReference(ctx, element, ownerTypeName, macroName, scopeNode)
      );
    case 'option':
      return shapeContainsPlainRecursiveLocalReference(
        ctx,
        shape.value,
        ownerTypeName,
        macroName,
        scopeNode,
      );
    case 'result':
      return shapeContainsPlainRecursiveLocalReference(
        ctx,
        shape.ok,
        ownerTypeName,
        macroName,
        scopeNode,
      ) ||
        shapeContainsPlainRecursiveLocalReference(
          ctx,
          shape.err,
          ownerTypeName,
          macroName,
          scopeNode,
        );
    case 'record':
      return shapeContainsPlainRecursiveLocalReference(
        ctx,
        shape.key,
        ownerTypeName,
        macroName,
        scopeNode,
      ) ||
        shapeContainsPlainRecursiveLocalReference(
          ctx,
          shape.value,
          ownerTypeName,
          macroName,
          scopeNode,
        );
    case 'object':
      return shape.fields.some((field) =>
        field.type &&
        shapeContainsPlainRecursiveLocalReference(
          ctx,
          field.type,
          ownerTypeName,
          macroName,
          scopeNode,
        )
      );
    case 'intersection':
    case 'union':
      return shape.members.some((member) =>
        shapeContainsPlainRecursiveLocalReference(
          ctx,
          member,
          ownerTypeName,
          macroName,
          scopeNode,
        )
      );
    case 'primitive':
    case 'literal':
    case 'null':
    case 'undefined':
    case 'unsupported':
      return false;
  }
}

function isPlainStructuralRecursiveDeclaration(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  typeName: string,
  macroName: 'decode' | 'encode' | 'codec',
): boolean {
  const shape = objectLikeDeclarationShape(ctx, declaration, 'codec');
  return shape.fields.some((field) =>
    field.type &&
    shapeContainsPlainRecursiveLocalReference(
      ctx,
      field.type,
      typeName,
      macroName,
      field.node,
    )
  );
}

function declarationTypeName(
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
): string {
  const hostDeclaration = getHostDeclaration(declaration);
  if (!hostDeclaration.name) {
    throw new Error('Expected named declaration for derive macro.');
  }
  return hostDeclaration.name.text;
}

function findLocalDeclarationByName(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  name: string,
): MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax | null {
  const localDeclaration = ctx.semantics.localDeclaration(name, declaration);
  return localDeclaration?.asClass() ?? localDeclaration?.asInterface() ??
    localDeclaration?.asTypeAlias() ??
    null;
}

function collectTypedRecursiveLocalReferenceNames(
  ctx: DeriveContext,
  shape: MacroReflectedTypeShape,
  ownerTypeName: string,
  macroName: 'decode' | 'encode' | 'codec',
  scopeNode: MacroSyntaxNode,
  names: Set<string> = new Set(),
): readonly string[] {
  switch (shape.kind) {
    case 'named':
      if (
        shape.name !== ownerTypeName &&
        localNamedReferenceParticipatesInMacro(
          ctx,
          shape.name,
          macroName,
          scopeNode,
        )
      ) {
        names.add(shape.name);
      }
      break;
    case 'array':
      collectTypedRecursiveLocalReferenceNames(
        ctx,
        shape.element,
        ownerTypeName,
        macroName,
        scopeNode,
        names,
      );
      break;
    case 'tuple':
      for (const element of shape.elements) {
        collectTypedRecursiveLocalReferenceNames(
          ctx,
          element,
          ownerTypeName,
          macroName,
          scopeNode,
          names,
        );
      }
      break;
    case 'option':
      collectTypedRecursiveLocalReferenceNames(
        ctx,
        shape.value,
        ownerTypeName,
        macroName,
        scopeNode,
        names,
      );
      break;
    case 'result':
      collectTypedRecursiveLocalReferenceNames(
        ctx,
        shape.ok,
        ownerTypeName,
        macroName,
        scopeNode,
        names,
      );
      collectTypedRecursiveLocalReferenceNames(
        ctx,
        shape.err,
        ownerTypeName,
        macroName,
        scopeNode,
        names,
      );
      break;
    case 'record':
      collectTypedRecursiveLocalReferenceNames(
        ctx,
        shape.key,
        ownerTypeName,
        macroName,
        scopeNode,
        names,
      );
      collectTypedRecursiveLocalReferenceNames(
        ctx,
        shape.value,
        ownerTypeName,
        macroName,
        scopeNode,
        names,
      );
      break;
    case 'object':
      for (const field of shape.fields) {
        if (field.type) {
          collectTypedRecursiveLocalReferenceNames(
            ctx,
            field.type,
            ownerTypeName,
            macroName,
            scopeNode,
            names,
          );
        }
      }
      break;
    case 'intersection':
    case 'union':
      for (const member of shape.members) {
        collectTypedRecursiveLocalReferenceNames(
          ctx,
          member,
          ownerTypeName,
          macroName,
          scopeNode,
          names,
        );
      }
      break;
    case 'primitive':
    case 'literal':
    case 'null':
    case 'undefined':
    case 'unsupported':
      break;
  }
  return [...names];
}

function annotationIdentifierMayResolveAsync(
  ctx: DeriveContext,
  annotation: MacroAnnotation | null,
  scopeNode: MacroSyntaxNode,
): boolean {
  const helperIdentifier = annotation ? annotationIdentifierArgument(annotation) : null;
  return helperIdentifier !== null &&
    (
      ctx.semantics.valueBindingPromiseLikeInScope(helperIdentifier, scopeNode) ||
      ctx.semantics.valueBindingPromiseLikeInScope(helperIdentifier)
    );
}

function annotationIdentifierUsesAsyncHelperMode(
  ctx: DeriveContext,
  annotation: MacroAnnotation | null,
  scopeNode: MacroSyntaxNode,
  direction: 'decode' | 'encode',
): boolean {
  return annotationIdentifierHelperMode(ctx, annotation, scopeNode, direction) === 'async';
}

function annotationIdentifierHelperMode(
  ctx: DeriveContext,
  annotation: MacroAnnotation | null,
  scopeNode: MacroSyntaxNode,
  direction: 'decode' | 'encode',
): 'async' | 'sync' | null {
  return annotationIdentifierHelperModeInternal(ctx, annotation, scopeNode, direction, true);
}

function annotationIdentifierHelperModeWithoutDiagnostic(
  ctx: DeriveContext,
  annotation: MacroAnnotation | null,
  scopeNode: MacroSyntaxNode,
  direction: 'decode' | 'encode',
): 'async' | 'sync' | null {
  return annotationIdentifierHelperModeInternal(ctx, annotation, scopeNode, direction, false);
}

function annotationIdentifierHelperModeInternal(
  ctx: DeriveContext,
  annotation: MacroAnnotation | null,
  scopeNode: MacroSyntaxNode,
  direction: 'decode' | 'encode',
  reportOpaqueError: boolean,
): 'async' | 'sync' | null {
  const helperIdentifier = annotation ? annotationIdentifierArgument(annotation) : null;
  if (!helperIdentifier) {
    return null;
  }
  const annotationName = annotation?.name ?? `${direction}.via`;
  const scopedLookupNode = semanticLookupNodeForContext(ctx, scopeNode);
  const scopedType = ctx.semantics.valueBindingTypeInScope(helperIdentifier, scopeNode);
  if (scopedType) {
    const scopedMode = inferDeriveHelperMode(
      scopedType,
      helperIdentifier,
      direction,
      scopedLookupNode,
    );
    if (scopedMode !== null) {
      return scopedMode;
    }
  }
  const fallbackLookupNode = semanticLookupNodeForContext(ctx);
  const fallbackType = ctx.semantics.valueBindingTypeInScope(helperIdentifier);
  if (fallbackType) {
    const fallbackMode = inferDeriveHelperMode(
      fallbackType,
      helperIdentifier,
      direction,
      fallbackLookupNode,
    );
    if (fallbackMode !== null) {
      return fallbackMode;
    }
  }
  if (
    reportOpaqueError &&
    (
      ctx.semantics.valueBindingInScope(helperIdentifier, scopeNode) ||
      ctx.semantics.valueBindingInScope(helperIdentifier)
    )
  ) {
    const helperTypeText = direction === 'decode'
      ? `import('sts:decode').Decoder<...> or import('sts:codec').Codec<...>`
      : `import('sts:encode').Encoder<...> or import('sts:codec').Codec<...>`;
    ctx.error(
      `${annotationName}(...) helper "${helperIdentifier}" must have an explicit stdlib helper type annotation such as ${helperTypeText}, or a local implementation the macro can analyze, so its async/sync mode can be determined.`,
      scopeNode,
    );
  }
  return null;
}

function decodeAnnotationsMayResolveAsync(
  ctx: DeriveContext,
  annotations: readonly MacroAnnotation[],
  scopeNode: MacroSyntaxNode,
): boolean {
  return annotationIdentifierMayResolveAsync(
    ctx,
    findAnnotation(annotations, 'decode.default'),
    scopeNode,
  ) ||
    annotationIdentifierMayResolveAsync(
      ctx,
      findAnnotation(annotations, 'decode.preprocess'),
      scopeNode,
    ) ||
    annotationIdentifierMayResolveAsync(
      ctx,
      findAnnotation(annotations, 'decode.transform'),
      scopeNode,
    ) ||
    annotationIdentifierMayResolveAsync(
      ctx,
      findAnnotation(annotations, 'decode.refine'),
      scopeNode,
    );
}

function encodeAnnotationsMayResolveAsync(
  ctx: DeriveContext,
  annotations: readonly MacroAnnotation[],
  scopeNode: MacroSyntaxNode,
): boolean {
  return annotationIdentifierMayResolveAsync(
    ctx,
    findAnnotation(annotations, 'encode.transform'),
    scopeNode,
  ) ||
    annotationIdentifierMayResolveAsync(
      ctx,
      findAnnotation(annotations, 'encode.refine'),
      scopeNode,
    );
}

function fieldDecodeViaMayResolveAsync(
  ctx: DeriveContext,
  annotations: readonly MacroAnnotation[],
  scopeNode: MacroSyntaxNode,
  macroName: 'codec' | 'decode',
): boolean {
  const annotationName = macroName === 'codec' ? 'codec.via' : 'decode.via';
  return annotationIdentifierUsesAsyncHelperMode(
    ctx,
    findAnnotation(annotations, annotationName),
    scopeNode,
    'decode',
  );
}

function fieldEncodeViaMayResolveAsync(
  ctx: DeriveContext,
  annotations: readonly MacroAnnotation[],
  scopeNode: MacroSyntaxNode,
  macroName: 'codec' | 'encode',
): boolean {
  const annotationName = macroName === 'codec' ? 'codec.via' : 'encode.via';
  return annotationIdentifierUsesAsyncHelperMode(
    ctx,
    findAnnotation(annotations, annotationName),
    scopeNode,
    'encode',
  );
}

function declarationFactoryMayResolveAsync(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  macroName: 'codec' | 'decode',
): boolean {
  const factoryAnnotation = findAnnotation(
    resolvedDeclarationAnnotations(ctx, declaration),
    `${macroName}.factory`,
  );
  if (!factoryAnnotation) {
    return false;
  }
  if (declaration.declarationKind === 'class') {
    const hostDeclaration = getHostDeclaration(declaration);
    const typeName = hostDeclaration.name?.text;
    const factoryIdentifier = annotationIdentifierArgument(factoryAnnotation);
    if (typeName && factoryIdentifier) {
      const selfStaticAsync = selfStaticHelperMayResolveAsync(
        declaration,
        typeName,
        factoryIdentifier,
      );
      if (selfStaticAsync !== null) {
        return selfStaticAsync;
      }
    }
  }
  return annotationIdentifierMayResolveAsync(ctx, factoryAnnotation, declaration);
}

function declarationOwnDecodeMode(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  macroName: 'codec' | 'decode',
): 'async' | 'sync' {
  if (
    decodeAnnotationsMayResolveAsync(
      ctx,
      resolvedDeclarationAnnotations(ctx, declaration),
      declaration,
    )
  ) {
    return 'async';
  }
  if (
    declaration.declarationKind === 'class' &&
    declarationFactoryMayResolveAsync(ctx, declaration, macroName)
  ) {
    return 'async';
  }
  return objectLikeDeclarationShape(ctx, declaration, macroName).fields.some((field) =>
      decodeAnnotationsMayResolveAsync(ctx, field.annotations, field.node) ||
      fieldDecodeViaMayResolveAsync(ctx, field.annotations, field.node, macroName)
    )
    ? 'async'
    : 'sync';
}

function declarationOwnEncodeMode(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  macroName: 'codec' | 'encode',
): 'async' | 'sync' {
  if (
    encodeAnnotationsMayResolveAsync(
      ctx,
      resolvedDeclarationAnnotations(ctx, declaration),
      declaration,
    )
  ) {
    return 'async';
  }
  return objectLikeDeclarationShape(ctx, declaration, macroName === 'codec' ? 'codec' : 'encode')
      .fields.some((field) =>
        encodeAnnotationsMayResolveAsync(ctx, field.annotations, field.node) ||
        fieldEncodeViaMayResolveAsync(ctx, field.annotations, field.node, macroName)
      )
    ? 'async'
    : 'sync';
}

function recursiveDeclarationDecodeModeInternal(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  macroName: 'codec' | 'decode',
  memo: Map<string, 'async' | 'sync'>,
  visiting: Set<string>,
): 'async' | 'sync' {
  const typeName = declarationTypeName(declaration);
  const cacheKey = `${macroName}:decode:${typeName}`;
  const cached = memo.get(cacheKey);
  if (cached) {
    return cached;
  }

  const ownMode = declarationOwnDecodeMode(ctx, declaration, macroName);
  if (ownMode === 'async') {
    memo.set(cacheKey, 'async');
    return 'async';
  }

  if (visiting.has(cacheKey)) {
    return 'sync';
  }
  visiting.add(cacheKey);

  const shape = objectLikeDeclarationShape(ctx, declaration, macroName);
  const referencedNames = collectTypedRecursiveLocalReferenceNames(
    ctx,
    {
      kind: 'object',
      fields: shape.fields,
      text: shape.text,
    } satisfies MacroReflectedTypeShape,
    typeName,
    macroName,
    declaration,
  );
  for (const referencedName of referencedNames) {
    const localDeclaration = findLocalDeclarationByName(ctx, declaration, referencedName);
    if (!localDeclaration) {
      continue;
    }
    if (
      recursiveDeclarationDecodeModeInternal(
        ctx,
        localDeclaration,
        macroName,
        memo,
        visiting,
      ) === 'async'
    ) {
      visiting.delete(cacheKey);
      memo.set(cacheKey, 'async');
      return 'async';
    }
  }

  visiting.delete(cacheKey);
  memo.set(cacheKey, 'sync');
  return 'sync';
}

function recursiveDeclarationEncodeModeInternal(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  macroName: 'codec' | 'encode',
  memo: Map<string, 'async' | 'sync'>,
  visiting: Set<string>,
): 'async' | 'sync' {
  const typeName = declarationTypeName(declaration);
  const cacheKey = `${macroName}:encode:${typeName}`;
  const cached = memo.get(cacheKey);
  if (cached) {
    return cached;
  }

  const ownMode = declarationOwnEncodeMode(ctx, declaration, macroName);
  if (ownMode === 'async') {
    memo.set(cacheKey, 'async');
    return 'async';
  }

  if (visiting.has(cacheKey)) {
    return 'sync';
  }
  visiting.add(cacheKey);

  const shape = objectLikeDeclarationShape(
    ctx,
    declaration,
    macroName === 'codec' ? 'codec' : 'encode',
  );
  for (
    const referencedName of collectTypedRecursiveLocalReferenceNames(
      ctx,
      {
        kind: 'object',
        fields: shape.fields,
        text: shape.text,
      } satisfies MacroReflectedTypeShape,
      typeName,
      macroName,
      declaration,
    )
  ) {
    const localDeclaration = findLocalDeclarationByName(ctx, declaration, referencedName);
    if (!localDeclaration) {
      continue;
    }
    if (
      recursiveDeclarationEncodeModeInternal(
        ctx,
        localDeclaration,
        macroName,
        memo,
        visiting,
      ) === 'async'
    ) {
      visiting.delete(cacheKey);
      memo.set(cacheKey, 'async');
      return 'async';
    }
  }

  visiting.delete(cacheKey);
  memo.set(cacheKey, 'sync');
  return 'sync';
}

function recursiveDeclarationDecodeMode(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  macroName: 'codec' | 'decode',
): 'async' | 'sync' {
  return recursiveDeclarationDecodeModeInternal(ctx, declaration, macroName, new Map(), new Set());
}

function recursiveDeclarationEncodeMode(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  macroName: 'codec' | 'encode' = 'encode',
): 'async' | 'sync' {
  return recursiveDeclarationEncodeModeInternal(ctx, declaration, macroName, new Map(), new Set());
}

function localDeclarationForNamedReference(
  ctx: DeriveContext,
  scopeNode: MacroSyntaxNode,
  name: string,
): MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax | null {
  const localDeclaration = ctx.semantics.localDeclaration(name, scopeNode);
  return localDeclaration?.asClass() ?? localDeclaration?.asInterface() ??
    localDeclaration?.asTypeAlias() ??
    null;
}

function localStructuralAliasForNamedReference(
  ctx: DeriveContext,
  name: string,
  scopeNode: MacroSyntaxNode,
  macroName: 'decode' | 'encode' | 'codec',
): { readonly shape: MacroReflectedTypeShape; readonly typeNode: ts.TypeNode | null } | null {
  const localDeclaration = localDeclarationForNamedReference(ctx, scopeNode, name)?.asTypeAlias();
  if (!localDeclaration || localDeclaration.typeParameters.length > 0) {
    return null;
  }
  const relevantAnnotationNames = macroName === 'decode'
    ? ['decode', 'codec']
    : macroName === 'encode'
    ? ['encode', 'codec']
    : ['codec', 'decode', 'encode'];
  if (
    relevantAnnotationNames.some((annotationName) =>
      ctx.semantics.localDeclarationHasAnnotation(name, annotationName, scopeNode)
    )
  ) {
    return null;
  }
  return {
    shape: ctx.reflect.typeShape(localDeclaration.type),
    typeNode: hostTypeNode(localDeclaration.type),
  };
}

function localNamedDecodeCallbackTypeText(
  ctx: DeriveContext,
  name: string,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  macroName: 'codec' | 'decode',
): string | null {
  if (!localNamedReferenceNeedsTypedRecursivePath(ctx, name, ownerTypeName, macroName, scopeNode)) {
    return null;
  }
  const localDeclaration = localDeclarationForNamedReference(ctx, scopeNode, name);
  if (!localDeclaration) {
    return null;
  }
  if (ctx.reflect.declarationShape(localDeclaration).kind !== 'objectLike') {
    return null;
  }
  const mode = recursiveDeclarationDecodeMode(ctx, localDeclaration, macroName);
  return mode === 'async' ? `import('sts:decode').Decoder<${name}, unknown, "async">` : null;
}

function localNamedEncodeCallbackTypeText(
  ctx: DeriveContext,
  name: string,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  macroName: 'codec' | 'encode',
): string | null {
  if (!localNamedReferenceNeedsTypedRecursivePath(ctx, name, ownerTypeName, macroName, scopeNode)) {
    return null;
  }
  const localDeclaration = localDeclarationForNamedReference(ctx, scopeNode, name);
  if (!localDeclaration) {
    return null;
  }
  if (ctx.reflect.declarationShape(localDeclaration).kind !== 'objectLike') {
    return null;
  }
  const mode = recursiveDeclarationEncodeMode(ctx, localDeclaration, macroName);
  return mode === 'async'
    ? `import('sts:encode').Encoder<${name}, import('sts:json').JsonLikeValue, unknown, "async">`
    : null;
}

function selfNamedDecodeCallbackTypeText(
  ctx: DeriveContext,
  name: string,
  scopeNode: MacroSyntaxNode,
  macroName: 'codec' | 'decode',
): string {
  const localDeclaration = localDeclarationForNamedReference(ctx, scopeNode, name);
  if (!localDeclaration || ctx.reflect.declarationShape(localDeclaration).kind !== 'objectLike') {
    return `import('sts:decode').Decoder<${name}>`;
  }
  const mode = recursiveDeclarationDecodeMode(ctx, localDeclaration, macroName);
  return mode === 'async'
    ? `import('sts:decode').Decoder<${name}, unknown, "async">`
    : `import('sts:decode').Decoder<${name}>`;
}

function selfNamedEncodeCallbackTypeText(
  ctx: DeriveContext,
  name: string,
  scopeNode: MacroSyntaxNode,
  macroName: 'codec' | 'encode',
): string {
  const localDeclaration = localDeclarationForNamedReference(ctx, scopeNode, name);
  if (!localDeclaration || ctx.reflect.declarationShape(localDeclaration).kind !== 'objectLike') {
    return `import('sts:encode').Encoder<${name}, import('sts:json').JsonLikeValue>`;
  }
  const mode = recursiveDeclarationEncodeMode(ctx, localDeclaration, macroName);
  return mode === 'async'
    ? `import('sts:encode').Encoder<${name}, import('sts:json').JsonLikeValue, unknown, "async">`
    : `import('sts:encode').Encoder<${name}, import('sts:json').JsonLikeValue>`;
}

function recursiveEncodedFieldWireName(
  field: MacroReflectedFieldShape,
  macroName: 'encode' | 'codec',
): string {
  const renameAnnotation = findAnnotation(field.annotations, `${macroName}.rename`);
  return renameAnnotation ? annotationStringArgument(renameAnnotation) ?? field.name : field.name;
}

function recursiveEncodedTypeTextFromShape(
  shape: MacroReflectedTypeShape,
  ownerTypeName: string,
  selfAliasName: string,
): string | null {
  switch (shape.kind) {
    case 'primitive':
      return shape.primitiveKind;
    case 'literal':
      return JSON.stringify(shape.value);
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'named':
      return shape.name === ownerTypeName ? selfAliasName : 'any';
    case 'array': {
      const element = recursiveEncodedTypeTextFromShape(
        shape.element,
        ownerTypeName,
        selfAliasName,
      );
      return element ? `${shape.readonly ? 'readonly ' : ''}${element}[]` : null;
    }
    case 'tuple': {
      const elements = shape.elements.map((element) =>
        recursiveEncodedTypeTextFromShape(element, ownerTypeName, selfAliasName)
      );
      return elements.every((element) => element !== null)
        ? `${shape.readonly ? 'readonly ' : ''}[${(elements as readonly string[]).join(', ')}]`
        : null;
    }
    case 'option': {
      const value = recursiveEncodedTypeTextFromShape(shape.value, ownerTypeName, selfAliasName);
      return value
        ? `{ readonly tag: "none" } | { readonly tag: "some"; readonly value: ${value} }`
        : null;
    }
    case 'result': {
      const ok = recursiveEncodedTypeTextFromShape(shape.ok, ownerTypeName, selfAliasName);
      const err = recursiveEncodedTypeTextFromShape(shape.err, ownerTypeName, selfAliasName);
      return ok && err
        ? `{ readonly tag: "ok"; readonly value: ${ok} } | { readonly tag: "err"; readonly error: ${err} }`
        : null;
    }
    case 'record': {
      if (shape.key.kind !== 'primitive' || shape.key.primitiveKind !== 'string') {
        return null;
      }
      const value = recursiveEncodedTypeTextFromShape(shape.value, ownerTypeName, selfAliasName);
      return value ? `Readonly<Record<string, ${value}>>` : null;
    }
    case 'object':
    case 'intersection': {
      const fields = flattenObjectLikeTypeFields(shape);
      if (!fields) {
        return null;
      }
      const fieldTexts = fields.map((field) => {
        if (!field.type) {
          return null;
        }
        const fieldType = recursiveEncodedTypeTextFromShape(
          field.type,
          ownerTypeName,
          selfAliasName,
        );
        if (!fieldType) {
          return null;
        }
        return `${propertyKeyText(field.name)}${field.optional ? '?' : ''}: ${fieldType}`;
      });
      return fieldTexts.every((fieldText) => fieldText !== null)
        ? `{ readonly ${(fieldTexts as readonly string[]).join('; readonly ')} }`
        : null;
    }
    case 'union': {
      const nullishUnion = decomposeNullishUnion(shape);
      if (!nullishUnion) {
        return null;
      }
      let text = nullishUnion.base
        ? recursiveEncodedTypeTextFromShape(nullishUnion.base, ownerTypeName, selfAliasName)
        : nullishUnion.includesNull
        ? 'null'
        : 'undefined';
      if (!text) {
        return null;
      }
      if (nullishUnion.includesNull && nullishUnion.base) {
        text = `${text} | null`;
      }
      if (nullishUnion.includesUndefined) {
        text = `${text} | undefined`;
      }
      return text;
    }
    case 'unsupported':
      return null;
  }
}

function recursiveEncodedObjectTypeAliasText(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  typeName: string,
  macroName: 'encode' | 'codec',
  aliasName: string,
): string | null {
  const shape = objectLikeDeclarationShape(ctx, declaration, macroName);
  const fieldTexts = shape.fields.map((field) => {
    if (!field.type) {
      return null;
    }
    const fieldType = recursiveEncodedTypeTextFromShape(field.type, typeName, aliasName);
    if (!fieldType) {
      return null;
    }
    const wireName = recursiveEncodedFieldWireName(field, macroName);
    return `${propertyKeyText(wireName)}${field.optional ? '?' : ''}: ${fieldType}`;
  });
  return fieldTexts.every((fieldText) => fieldText !== null)
    ? `{ readonly ${(fieldTexts as readonly string[]).join('; readonly ')} }`
    : null;
}

function rewriteRecursiveSelfReference(
  text: string,
  searchText: string,
  replacementText: string,
): string {
  return text.includes(searchText) ? text.replaceAll(searchText, replacementText) : text;
}

function escapeRegExpText(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteRecursiveLazyInvocation(
  text: string,
  _callbackTypeText: string,
  _callbackValueText: string,
  _lazyTypeArgumentsText: string,
): string {
  return text;
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

function flattenObjectLikeTypeFields(
  shape: MacroReflectedTypeShape,
): readonly MacroReflectedFieldShape[] | null {
  switch (shape.kind) {
    case 'object':
      return shape.fields;
    case 'intersection': {
      const fields: MacroReflectedFieldShape[] = [];
      for (const member of shape.members) {
        const memberFields = flattenObjectLikeTypeFields(member);
        if (!memberFields) {
          return null;
        }
        fields.push(...memberFields);
      }
      return fields;
    }
    default:
      return null;
  }
}

function decomposeNullishUnion(
  shape: MacroReflectedTypeShape,
): {
  readonly base: MacroReflectedTypeShape | null;
  readonly includesNull: boolean;
  readonly includesUndefined: boolean;
} | null {
  if (shape.kind !== 'union') {
    return null;
  }

  let includesNull = false;
  let includesUndefined = false;
  const baseMembers: MacroReflectedTypeShape[] = [];

  for (const member of shape.members) {
    if (member.kind === 'null') {
      includesNull = true;
      continue;
    }
    if (member.kind === 'undefined') {
      includesUndefined = true;
      continue;
    }
    baseMembers.push(member);
  }

  if ((!includesNull && !includesUndefined) || baseMembers.length > 1) {
    return null;
  }

  return {
    base: baseMembers[0] ?? null,
    includesNull,
    includesUndefined,
  };
}

function literalUnionMembers(
  shape: MacroReflectedTypeShape,
): readonly Extract<MacroReflectedTypeShape, { readonly kind: 'literal' }>[] | null {
  return shape.kind === 'union' &&
      shape.members.length > 0 &&
      shape.members.every((member) => member.kind === 'literal')
    ? shape.members as readonly Extract<MacroReflectedTypeShape, { readonly kind: 'literal' }>[]
    : null;
}

function decodeHelperTextFromShape(
  ctx: DeriveContext,
  shape: MacroReflectedTypeShape,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  errorNode: MacroSyntaxNode,
  typeNode?: ts.TypeNode | null,
  aliasVisiting: Set<string> = new Set(),
): string | null {
  switch (shape.kind) {
    case 'primitive':
      return ctx.runtime.named('sts:decode', decodeHelperName(shape.primitiveKind)).text();
    case 'literal':
      return `${ctx.runtime.named('sts:decode', 'literal').text()}(${JSON.stringify(shape.value)})`;
    case 'null':
      return `${ctx.runtime.named('sts:decode', 'literal').text()}(null)`;
    case 'undefined':
      return ctx.runtime.named('sts:decode', 'undefinedValue').text();
    case 'named': {
      if (!aliasVisiting.has(shape.name)) {
        const localAlias = localStructuralAliasForNamedReference(
          ctx,
          shape.name,
          scopeNode,
          'decode',
        );
        if (localAlias) {
          aliasVisiting.add(shape.name);
          const helperText = decodeHelperTextFromShape(
            ctx,
            localAlias.shape,
            ownerTypeName,
            scopeNode,
            errorNode,
            localAlias.typeNode,
            aliasVisiting,
          );
          aliasVisiting.delete(shape.name);
          if (helperText) {
            return helperText;
          }
        }
      }
      const stdlibJsonHelperKind = stdlibJsonHelperKindForTypeNode(ctx, scopeNode, typeNode);
      if (stdlibJsonHelperKind) {
        return ctx.runtime.named('sts:decode', stdlibJsonHelperKind).text();
      }
      if (shape.typeArguments.length > 0 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(shape.name)) {
        return null;
      }
      assertNamedDerivedCompanionsInScope(
        ctx,
        'decode',
        ownerTypeName,
        scopeNode,
        errorNode,
        { kind: 'named', typeName: shape.name },
      );
      if (shape.name === ownerTypeName) {
        return `${ctx.runtime.named('sts:decode', 'lazy').text()}((): ${
          selfNamedDecodeCallbackTypeText(ctx, shape.name, scopeNode, 'decode')
        } => ${shape.name}Decoder)`;
      }
      const localCallbackTypeText = localNamedDecodeCallbackTypeText(
        ctx,
        shape.name,
        ownerTypeName,
        scopeNode,
        'decode',
      );
      return localCallbackTypeText
        ? `${
          ctx.runtime.named('sts:decode', 'lazy').text()
        }((): ${localCallbackTypeText} => ${shape.name}Decoder)`
        : `${ctx.runtime.named('sts:decode', 'lazy').text()}(() => ${shape.name}Decoder)`;
    }
    case 'array': {
      const element = decodeHelperTextFromShape(
        ctx,
        shape.element,
        ownerTypeName,
        scopeNode,
        errorNode,
        arrayElementTypeNode(typeNode),
        aliasVisiting,
      );
      return element ? `${ctx.runtime.named('sts:decode', 'array').text()}(${element})` : null;
    }
    case 'tuple': {
      const elementTypeNodes = tupleElementTypeNodes(typeNode);
      const elements = shape.elements.map((element, index) =>
        decodeHelperTextFromShape(
          ctx,
          element,
          ownerTypeName,
          scopeNode,
          errorNode,
          elementTypeNodes?.[index] ?? null,
          aliasVisiting,
        )
      );
      return elements.every((element) => element !== null)
        ? `${ctx.runtime.named('sts:decode', 'tuple').text()}(${
          (elements as readonly string[]).join(', ')
        })`
        : null;
    }
    case 'option': {
      const value = decodeHelperTextFromShape(
        ctx,
        shape.value,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 0),
        aliasVisiting,
      );
      return value ? `${ctx.runtime.named('sts:decode', 'option').text()}(${value})` : null;
    }
    case 'result': {
      const okType = decodeHelperTextFromShape(
        ctx,
        shape.ok,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 0),
        aliasVisiting,
      );
      const errType = decodeHelperTextFromShape(
        ctx,
        shape.err,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 1),
        aliasVisiting,
      );
      return okType && errType
        ? `${ctx.runtime.named('sts:decode', 'result').text()}(${okType}, ${errType})`
        : null;
    }
    case 'record': {
      if (shape.key.kind !== 'primitive' || shape.key.primitiveKind !== 'string') {
        return null;
      }
      const value = decodeHelperTextFromShape(
        ctx,
        shape.value,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 1),
        aliasVisiting,
      );
      return value ? `${ctx.runtime.named('sts:decode', 'readonlyRecord').text()}(${value})` : null;
    }
    case 'object':
    case 'intersection': {
      const fields = flattenObjectLikeTypeFields(shape);
      return fields
        ? nestedDecodeHelperTextFromFields(ctx, ownerTypeName, scopeNode, fields)
        : null;
    }
    case 'union': {
      const literalMembers = literalUnionMembers(shape);
      if (literalMembers) {
        const members = literalMembers.map((member) =>
          decodeHelperTextFromShape(
            ctx,
            member,
            ownerTypeName,
            scopeNode,
            errorNode,
            null,
            aliasVisiting,
          )
        );
        return members.every((member) => member !== null)
          ? foldUnionText(
            ctx.runtime.named('sts:decode', 'union').text(),
            members as readonly string[],
          )
          : null;
      }
      const nullishUnion = decomposeNullishUnion(shape);
      if (!nullishUnion) {
        return null;
      }
      let text = nullishUnion.base
        ? decodeHelperTextFromShape(
          ctx,
          nullishUnion.base,
          ownerTypeName,
          scopeNode,
          errorNode,
          unionMemberTypeNodes(typeNode)?.find((member) =>
            !isNullTypeNode(member) && !isUndefinedTypeNode(member)
          ) ?? null,
          aliasVisiting,
        )
        : nullishUnion.includesNull
        ? `${ctx.runtime.named('sts:decode', 'literal').text()}(null)`
        : ctx.runtime.named('sts:decode', 'undefinedValue').text();
      if (!text) {
        return null;
      }
      if (nullishUnion.includesNull && nullishUnion.base) {
        text = `${ctx.runtime.named('sts:decode', 'nullable').text()}(${text})`;
      }
      if (nullishUnion.includesUndefined) {
        text = `${ctx.runtime.named('sts:decode', 'undefinedable').text()}(${text})`;
      }
      return text;
    }
    case 'unsupported':
      return null;
  }
}

function encodeHelperTextFromShape(
  ctx: DeriveContext,
  shape: MacroReflectedTypeShape,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  errorNode: MacroSyntaxNode,
  typeNode?: ts.TypeNode | null,
  aliasVisiting: Set<string> = new Set(),
): string | null {
  switch (shape.kind) {
    case 'primitive':
      return ctx.runtime.named('sts:encode', encodeHelperName(shape.primitiveKind)).text();
    case 'literal':
      return `${ctx.runtime.named('sts:encode', 'literal').text()}(${JSON.stringify(shape.value)})`;
    case 'null':
      return `${ctx.runtime.named('sts:encode', 'literal').text()}(null)`;
    case 'undefined':
      return ctx.runtime.named('sts:encode', 'undefinedEncoder').text();
    case 'named': {
      if (!aliasVisiting.has(shape.name)) {
        const localAlias = localStructuralAliasForNamedReference(
          ctx,
          shape.name,
          scopeNode,
          'encode',
        );
        if (localAlias) {
          aliasVisiting.add(shape.name);
          const helperText = encodeHelperTextFromShape(
            ctx,
            localAlias.shape,
            ownerTypeName,
            scopeNode,
            errorNode,
            localAlias.typeNode,
            aliasVisiting,
          );
          aliasVisiting.delete(shape.name);
          if (helperText) {
            return helperText;
          }
        }
      }
      const stdlibJsonHelperKind = stdlibJsonHelperKindForTypeNode(ctx, scopeNode, typeNode);
      if (stdlibJsonHelperKind) {
        return ctx.runtime.named('sts:encode', stdlibJsonHelperKind).text();
      }
      if (shape.typeArguments.length > 0 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(shape.name)) {
        return null;
      }
      assertNamedDerivedCompanionsInScope(
        ctx,
        'encode',
        ownerTypeName,
        scopeNode,
        errorNode,
        { kind: 'named', typeName: shape.name },
      );
      if (shape.name === ownerTypeName) {
        return `${ctx.runtime.named('sts:encode', 'lazy').text()}((): ${
          selfNamedEncodeCallbackTypeText(ctx, shape.name, scopeNode, 'encode')
        } => ${shape.name}Encoder)`;
      }
      const localCallbackTypeText = localNamedEncodeCallbackTypeText(
        ctx,
        shape.name,
        ownerTypeName,
        scopeNode,
        'encode',
      );
      return localCallbackTypeText
        ? `${
          ctx.runtime.named('sts:encode', 'lazy').text()
        }((): ${localCallbackTypeText} => ${shape.name}Encoder)`
        : `${ctx.runtime.named('sts:encode', 'lazy').text()}(() => ${shape.name}Encoder)`;
    }
    case 'array': {
      const element = encodeHelperTextFromShape(
        ctx,
        shape.element,
        ownerTypeName,
        scopeNode,
        errorNode,
        arrayElementTypeNode(typeNode),
        aliasVisiting,
      );
      return element ? `${ctx.runtime.named('sts:encode', 'array').text()}(${element})` : null;
    }
    case 'tuple': {
      const elementTypeNodes = tupleElementTypeNodes(typeNode);
      const elements = shape.elements.map((element, index) =>
        encodeHelperTextFromShape(
          ctx,
          element,
          ownerTypeName,
          scopeNode,
          errorNode,
          elementTypeNodes?.[index] ?? null,
          aliasVisiting,
        )
      );
      return elements.every((element) => element !== null)
        ? `${ctx.runtime.named('sts:encode', 'tuple').text()}(${
          (elements as readonly string[]).join(', ')
        })`
        : null;
    }
    case 'option': {
      const value = encodeHelperTextFromShape(
        ctx,
        shape.value,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 0),
        aliasVisiting,
      );
      return value ? `${ctx.runtime.named('sts:encode', 'option').text()}(${value})` : null;
    }
    case 'result': {
      const okType = encodeHelperTextFromShape(
        ctx,
        shape.ok,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 0),
        aliasVisiting,
      );
      const errType = encodeHelperTextFromShape(
        ctx,
        shape.err,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 1),
        aliasVisiting,
      );
      return okType && errType
        ? `${ctx.runtime.named('sts:encode', 'result').text()}(${okType}, ${errType})`
        : null;
    }
    case 'record': {
      if (shape.key.kind !== 'primitive' || shape.key.primitiveKind !== 'string') {
        return null;
      }
      const value = encodeHelperTextFromShape(
        ctx,
        shape.value,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 1),
        aliasVisiting,
      );
      return value ? `${ctx.runtime.named('sts:encode', 'record').text()}(${value})` : null;
    }
    case 'object':
    case 'intersection': {
      const fields = flattenObjectLikeTypeFields(shape);
      return fields
        ? nestedEncodeHelperTextFromFields(ctx, ownerTypeName, scopeNode, fields)
        : null;
    }
    case 'union': {
      const literalMembers = literalUnionMembers(shape);
      if (literalMembers) {
        return `${ctx.runtime.named('sts:encode', 'fromEncode').text()}((value: ${shape.text}) => ${
          ctx.runtime.named('sts:result', 'ok').text()
        }(value))`;
      }
      const nullishUnion = decomposeNullishUnion(shape);
      if (!nullishUnion) {
        return null;
      }
      let text = nullishUnion.base
        ? encodeHelperTextFromShape(
          ctx,
          nullishUnion.base,
          ownerTypeName,
          scopeNode,
          errorNode,
          unionMemberTypeNodes(typeNode)?.find((member) =>
            !isNullTypeNode(member) && !isUndefinedTypeNode(member)
          ) ?? null,
          aliasVisiting,
        )
        : nullishUnion.includesNull
        ? `${ctx.runtime.named('sts:encode', 'literal').text()}(null)`
        : ctx.runtime.named('sts:encode', 'undefinedEncoder').text();
      if (!text) {
        return null;
      }
      if (nullishUnion.includesNull && nullishUnion.base) {
        text = `${ctx.runtime.named('sts:encode', 'nullable').text()}(${text})`;
      }
      if (nullishUnion.includesUndefined) {
        text = `${ctx.runtime.named('sts:encode', 'undefinedable').text()}(${text})`;
      }
      return text;
    }
    case 'unsupported':
      return null;
  }
}

function codecHelperTextsFromShape(
  ctx: DeriveContext,
  shape: MacroReflectedTypeShape,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  errorNode: MacroSyntaxNode,
  typeNode?: ts.TypeNode | null,
  aliasVisiting: Set<string> = new Set(),
): { readonly decodeText: string; readonly encodeText: string } | null {
  switch (shape.kind) {
    case 'primitive':
      return {
        decodeText: ctx.runtime.named('sts:decode', decodeHelperName(shape.primitiveKind)).text(),
        encodeText: ctx.runtime.named('sts:encode', encodeHelperName(shape.primitiveKind)).text(),
      };
    case 'literal':
      return {
        decodeText: `${ctx.runtime.named('sts:decode', 'literal').text()}(${
          JSON.stringify(shape.value)
        })`,
        encodeText: `${ctx.runtime.named('sts:encode', 'literal').text()}(${
          JSON.stringify(shape.value)
        })`,
      };
    case 'null':
      return {
        decodeText: `${ctx.runtime.named('sts:decode', 'literal').text()}(null)`,
        encodeText: `${ctx.runtime.named('sts:encode', 'literal').text()}(null)`,
      };
    case 'undefined':
      return {
        decodeText: ctx.runtime.named('sts:decode', 'undefinedValue').text(),
        encodeText: ctx.runtime.named('sts:encode', 'undefinedEncoder').text(),
      };
    case 'named': {
      if (!aliasVisiting.has(shape.name)) {
        const localAlias = localStructuralAliasForNamedReference(
          ctx,
          shape.name,
          scopeNode,
          'codec',
        );
        if (localAlias) {
          aliasVisiting.add(shape.name);
          const helperTexts = codecHelperTextsFromShape(
            ctx,
            localAlias.shape,
            ownerTypeName,
            scopeNode,
            errorNode,
            localAlias.typeNode,
            aliasVisiting,
          );
          aliasVisiting.delete(shape.name);
          if (helperTexts) {
            return helperTexts;
          }
        }
      }
      const stdlibJsonHelperKind = stdlibJsonHelperKindForTypeNode(ctx, scopeNode, typeNode);
      if (stdlibJsonHelperKind) {
        return {
          decodeText: ctx.runtime.named('sts:decode', stdlibJsonHelperKind).text(),
          encodeText: ctx.runtime.named('sts:encode', stdlibJsonHelperKind).text(),
        };
      }
      if (shape.typeArguments.length > 0 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(shape.name)) {
        return null;
      }
      assertNamedDerivedCompanionsInScope(
        ctx,
        'codec',
        ownerTypeName,
        scopeNode,
        errorNode,
        { kind: 'named', typeName: shape.name },
      );
      const sideCompanions = codecNamedSideCompanions(ctx, shape.name, ownerTypeName, scopeNode);
      if (sideCompanions) {
        const localDecodeCallbackTypeText = localNamedDecodeCallbackTypeText(
          ctx,
          shape.name,
          ownerTypeName,
          scopeNode,
          'decode',
        );
        const localEncodeCallbackTypeText = localNamedEncodeCallbackTypeText(
          ctx,
          shape.name,
          ownerTypeName,
          scopeNode,
          'encode',
        );
        return {
          decodeText: shape.name === ownerTypeName
            ? `${ctx.runtime.named('sts:decode', 'lazy').text()}((): ${
              selfNamedDecodeCallbackTypeText(ctx, shape.name, scopeNode, 'codec')
            } => ${sideCompanions.decodeCompanionName})`
            : localDecodeCallbackTypeText
            ? `${
              ctx.runtime.named('sts:decode', 'lazy').text()
            }((): ${localDecodeCallbackTypeText} => ${sideCompanions.decodeCompanionName})`
            : `${
              ctx.runtime.named('sts:decode', 'lazy').text()
            }(() => ${sideCompanions.decodeCompanionName})`,
          encodeText: shape.name === ownerTypeName
            ? `${ctx.runtime.named('sts:encode', 'lazy').text()}((): ${
              selfNamedEncodeCallbackTypeText(ctx, shape.name, scopeNode, 'codec')
            } => ${sideCompanions.encodeCompanionName})`
            : localEncodeCallbackTypeText
            ? `${
              ctx.runtime.named('sts:encode', 'lazy').text()
            }((): ${localEncodeCallbackTypeText} => ${sideCompanions.encodeCompanionName})`
            : `${
              ctx.runtime.named('sts:encode', 'lazy').text()
            }(() => ${sideCompanions.encodeCompanionName})`,
        };
      }
      const localDecodeCallbackTypeText = localNamedDecodeCallbackTypeText(
        ctx,
        shape.name,
        ownerTypeName,
        scopeNode,
        'codec',
      );
      const localEncodeCallbackTypeText = localNamedEncodeCallbackTypeText(
        ctx,
        shape.name,
        ownerTypeName,
        scopeNode,
        'codec',
      );
      return {
        decodeText: shape.name === ownerTypeName
          ? `${ctx.runtime.named('sts:decode', 'lazy').text()}((): ${
            selfNamedDecodeCallbackTypeText(ctx, shape.name, scopeNode, 'codec')
          } => ${shape.name}Codec)`
          : localDecodeCallbackTypeText
          ? `${
            ctx.runtime.named('sts:decode', 'lazy').text()
          }((): ${localDecodeCallbackTypeText} => ${shape.name}Codec)`
          : `${ctx.runtime.named('sts:decode', 'lazy').text()}(() => ${shape.name}Codec)`,
        encodeText: shape.name === ownerTypeName
          ? `${ctx.runtime.named('sts:encode', 'lazy').text()}((): ${
            selfNamedEncodeCallbackTypeText(ctx, shape.name, scopeNode, 'codec')
          } => ${shape.name}Codec)`
          : localEncodeCallbackTypeText
          ? `${
            ctx.runtime.named('sts:encode', 'lazy').text()
          }((): ${localEncodeCallbackTypeText} => ${shape.name}Codec)`
          : `${ctx.runtime.named('sts:encode', 'lazy').text()}(() => ${shape.name}Codec)`,
      };
    }
    case 'array': {
      const element = codecHelperTextsFromShape(
        ctx,
        shape.element,
        ownerTypeName,
        scopeNode,
        errorNode,
        arrayElementTypeNode(typeNode),
        aliasVisiting,
      );
      return element
        ? {
          decodeText: `${ctx.runtime.named('sts:decode', 'array').text()}(${element.decodeText})`,
          encodeText: `${ctx.runtime.named('sts:encode', 'array').text()}(${element.encodeText})`,
        }
        : null;
    }
    case 'tuple': {
      const elementTypeNodes = tupleElementTypeNodes(typeNode);
      const elements = shape.elements.map((element, index) =>
        codecHelperTextsFromShape(
          ctx,
          element,
          ownerTypeName,
          scopeNode,
          errorNode,
          elementTypeNodes?.[index] ?? null,
          aliasVisiting,
        )
      );
      if (!elements.every((element) => element !== null)) {
        return null;
      }
      const resolved = elements as readonly {
        readonly decodeText: string;
        readonly encodeText: string;
      }[];
      return {
        decodeText: `${ctx.runtime.named('sts:decode', 'tuple').text()}(${
          resolved.map((element) => element.decodeText).join(', ')
        })`,
        encodeText: `${ctx.runtime.named('sts:encode', 'tuple').text()}(${
          resolved.map((element) => element.encodeText).join(', ')
        })`,
      };
    }
    case 'option': {
      const value = codecHelperTextsFromShape(
        ctx,
        shape.value,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 0),
        aliasVisiting,
      );
      return value
        ? {
          decodeText: `${ctx.runtime.named('sts:decode', 'option').text()}(${value.decodeText})`,
          encodeText: `${ctx.runtime.named('sts:encode', 'option').text()}(${value.encodeText})`,
        }
        : null;
    }
    case 'result': {
      const okType = codecHelperTextsFromShape(
        ctx,
        shape.ok,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 0),
        aliasVisiting,
      );
      const errType = codecHelperTextsFromShape(
        ctx,
        shape.err,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 1),
        aliasVisiting,
      );
      return okType && errType
        ? {
          decodeText: `${
            ctx.runtime.named('sts:decode', 'result').text()
          }(${okType.decodeText}, ${errType.decodeText})`,
          encodeText: `${
            ctx.runtime.named('sts:encode', 'result').text()
          }(${okType.encodeText}, ${errType.encodeText})`,
        }
        : null;
    }
    case 'record': {
      if (shape.key.kind !== 'primitive' || shape.key.primitiveKind !== 'string') {
        return null;
      }
      const value = codecHelperTextsFromShape(
        ctx,
        shape.value,
        ownerTypeName,
        scopeNode,
        errorNode,
        typeArgumentNodeAt(typeNode, 1),
        aliasVisiting,
      );
      return value
        ? {
          decodeText: `${
            ctx.runtime.named('sts:decode', 'readonlyRecord').text()
          }(${value.decodeText})`,
          encodeText: `${ctx.runtime.named('sts:encode', 'record').text()}(${value.encodeText})`,
        }
        : null;
    }
    case 'object':
    case 'intersection': {
      const fields = flattenObjectLikeTypeFields(shape);
      return fields
        ? nestedCodecHelperTextsFromFields(ctx, ownerTypeName, scopeNode, fields)
        : null;
    }
    case 'union': {
      const literalMembers = literalUnionMembers(shape);
      if (literalMembers) {
        const members = literalMembers.map((member) =>
          codecHelperTextsFromShape(
            ctx,
            member,
            ownerTypeName,
            scopeNode,
            errorNode,
            null,
            aliasVisiting,
          )
        );
        if (!members.every((member) => member !== null)) {
          return null;
        }
        const resolved = members as readonly {
          readonly decodeText: string;
          readonly encodeText: string;
        }[];
        return {
          decodeText: foldUnionText(
            ctx.runtime.named('sts:decode', 'union').text(),
            resolved.map((member) => member.decodeText),
          ),
          encodeText: `${
            ctx.runtime.named('sts:encode', 'fromEncode').text()
          }((value: ${shape.text}) => ${ctx.runtime.named('sts:result', 'ok').text()}(value))`,
        };
      }
      const nullishUnion = decomposeNullishUnion(shape);
      if (!nullishUnion) {
        return null;
      }
      let texts = nullishUnion.base
        ? codecHelperTextsFromShape(
          ctx,
          nullishUnion.base,
          ownerTypeName,
          scopeNode,
          errorNode,
          unionMemberTypeNodes(typeNode)?.find((member) =>
            !isNullTypeNode(member) && !isUndefinedTypeNode(member)
          ) ?? null,
          aliasVisiting,
        )
        : nullishUnion.includesNull
        ? {
          decodeText: `${ctx.runtime.named('sts:decode', 'literal').text()}(null)`,
          encodeText: `${ctx.runtime.named('sts:encode', 'literal').text()}(null)`,
        }
        : {
          decodeText: ctx.runtime.named('sts:decode', 'undefinedValue').text(),
          encodeText: ctx.runtime.named('sts:encode', 'undefinedEncoder').text(),
        };
      if (!texts) {
        return null;
      }
      if (nullishUnion.includesNull && nullishUnion.base) {
        texts = {
          decodeText: `${ctx.runtime.named('sts:decode', 'nullable').text()}(${texts.decodeText})`,
          encodeText: `${ctx.runtime.named('sts:encode', 'nullable').text()}(${texts.encodeText})`,
        };
      }
      if (nullishUnion.includesUndefined) {
        texts = {
          decodeText: `${
            ctx.runtime.named('sts:decode', 'undefinedable').text()
          }(${texts.decodeText})`,
          encodeText: `${
            ctx.runtime.named('sts:encode', 'undefinedable').text()
          }(${texts.encodeText})`,
        };
      }
      return texts;
    }
    case 'unsupported':
      return null;
  }
}

function wrapDecodeViaHelperText(
  ctx: DeriveContext,
  shape: MacroReflectedTypeShape,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  errorNode: MacroSyntaxNode,
  helperText: string,
  typeNode?: ts.TypeNode | null,
  aliasVisiting: Set<string> = new Set(),
): string {
  if (shape.kind === 'named' && !aliasVisiting.has(shape.name)) {
    const localAlias = localStructuralAliasForNamedReference(
      ctx,
      shape.name,
      scopeNode,
      'decode',
    );
    if (localAlias) {
      aliasVisiting.add(shape.name);
      const wrapped = wrapDecodeViaHelperText(
        ctx,
        localAlias.shape,
        ownerTypeName,
        scopeNode,
        errorNode,
        helperText,
        localAlias.typeNode,
        aliasVisiting,
      );
      aliasVisiting.delete(shape.name);
      return wrapped;
    }
  }
  if (shape.kind !== 'union') {
    return helperText;
  }
  const nullishUnion = decomposeNullishUnion(shape);
  if (!nullishUnion) {
    return helperText;
  }
  let text = helperText;
  if (nullishUnion.includesNull && nullishUnion.base) {
    text = `${ctx.runtime.named('sts:decode', 'nullable').text()}(${text})`;
  }
  if (nullishUnion.includesUndefined) {
    text = `${ctx.runtime.named('sts:decode', 'undefinedable').text()}(${text})`;
  }
  return text;
}

function wrapEncodeViaHelperText(
  ctx: DeriveContext,
  shape: MacroReflectedTypeShape,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  errorNode: MacroSyntaxNode,
  helperText: string,
  typeNode?: ts.TypeNode | null,
  aliasVisiting: Set<string> = new Set(),
): string {
  if (shape.kind === 'named' && !aliasVisiting.has(shape.name)) {
    const localAlias = localStructuralAliasForNamedReference(
      ctx,
      shape.name,
      scopeNode,
      'encode',
    );
    if (localAlias) {
      aliasVisiting.add(shape.name);
      const wrapped = wrapEncodeViaHelperText(
        ctx,
        localAlias.shape,
        ownerTypeName,
        scopeNode,
        errorNode,
        helperText,
        localAlias.typeNode,
        aliasVisiting,
      );
      aliasVisiting.delete(shape.name);
      return wrapped;
    }
  }
  if (shape.kind !== 'union') {
    return helperText;
  }
  const nullishUnion = decomposeNullishUnion(shape);
  if (!nullishUnion) {
    return helperText;
  }
  let text = helperText;
  if (nullishUnion.includesNull && nullishUnion.base) {
    text = `${ctx.runtime.named('sts:encode', 'nullable').text()}(${text})`;
  }
  if (nullishUnion.includesUndefined) {
    text = `${ctx.runtime.named('sts:encode', 'undefinedable').text()}(${text})`;
  }
  return text;
}

function wrapCodecViaHelperTexts(
  ctx: DeriveContext,
  shape: MacroReflectedTypeShape,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
  errorNode: MacroSyntaxNode,
  helperTexts: { readonly decodeText: string; readonly encodeText: string },
  typeNode?: ts.TypeNode | null,
  aliasVisiting: Set<string> = new Set(),
): { readonly decodeText: string; readonly encodeText: string } {
  if (shape.kind === 'named' && !aliasVisiting.has(shape.name)) {
    const localAlias = localStructuralAliasForNamedReference(
      ctx,
      shape.name,
      scopeNode,
      'codec',
    );
    if (localAlias) {
      aliasVisiting.add(shape.name);
      const wrapped = wrapCodecViaHelperTexts(
        ctx,
        localAlias.shape,
        ownerTypeName,
        scopeNode,
        errorNode,
        helperTexts,
        localAlias.typeNode,
        aliasVisiting,
      );
      aliasVisiting.delete(shape.name);
      return wrapped;
    }
  }
  if (shape.kind !== 'union') {
    return helperTexts;
  }
  const nullishUnion = decomposeNullishUnion(shape);
  if (!nullishUnion) {
    return helperTexts;
  }
  let decodeText = helperTexts.decodeText;
  let encodeText = helperTexts.encodeText;
  if (nullishUnion.includesNull && nullishUnion.base) {
    decodeText = `${ctx.runtime.named('sts:decode', 'nullable').text()}(${decodeText})`;
    encodeText = `${ctx.runtime.named('sts:encode', 'nullable').text()}(${encodeText})`;
  }
  if (nullishUnion.includesUndefined) {
    decodeText = `${ctx.runtime.named('sts:decode', 'undefinedable').text()}(${decodeText})`;
    encodeText = `${ctx.runtime.named('sts:encode', 'undefinedable').text()}(${encodeText})`;
  }
  return { decodeText, encodeText };
}

function decodeDefaultExpressionText(
  ctx: DeriveContext,
  annotations: readonly MacroAnnotation[],
  node: MacroSyntaxNode,
): string | null {
  const defaultAnnotation = findAnnotation(annotations, 'decode.default');
  if (!defaultAnnotation) {
    return null;
  }
  const valueText = annotationValueText(defaultAnnotation);
  if (!valueText) {
    ctx.error('decode.default(...) requires a value or helper expression.', node);
  }
  return valueText;
}

function decodeUnknownKeysPolicyText(
  ctx: DeriveContext,
  annotations: readonly MacroAnnotation[],
  node: MacroSyntaxNode,
): '"passthrough"' | '"strict"' | null {
  const unknownKeysAnnotation = findAnnotation(annotations, 'decode.unknownKeys');
  if (!unknownKeysAnnotation) {
    return null;
  }
  const policy = annotationStringArgument(unknownKeysAnnotation);
  if (policy !== 'strip' && policy !== 'strict' && policy !== 'passthrough') {
    ctx.error(`decode.unknownKeys(...) requires "strip", "strict", or "passthrough".`, node);
  }
  return policy === 'strip' ? null : JSON.stringify(policy) as '"passthrough"' | '"strict"';
}

function wrapDecodeConstraintText(
  ctx: DeriveContext,
  baseText: string,
  annotations: readonly MacroAnnotation[],
  node: MacroSyntaxNode,
): string {
  let text = baseText;

  const minAnnotation = findAnnotation(annotations, 'decode.min');
  if (minAnnotation) {
    const minimum = annotationNumberishTextArgument(minAnnotation);
    if (minimum === null) {
      ctx.error('decode.min(...) requires a numeric or bigint literal.', node);
    }
    text = `${ctx.runtime.named('sts:decode', 'min').text()}(${text}, ${minimum})`;
  }

  const maxAnnotation = findAnnotation(annotations, 'decode.max');
  if (maxAnnotation) {
    const maximum = annotationNumberishTextArgument(maxAnnotation);
    if (maximum === null) {
      ctx.error('decode.max(...) requires a numeric or bigint literal.', node);
    }
    text = `${ctx.runtime.named('sts:decode', 'max').text()}(${text}, ${maximum})`;
  }

  const minLengthAnnotation = findAnnotation(annotations, 'decode.minLength');
  if (minLengthAnnotation) {
    const minimum = annotationNumberArgument(minLengthAnnotation);
    if (minimum === null) {
      ctx.error('decode.minLength(...) requires a numeric literal.', node);
    }
    text = `${ctx.runtime.named('sts:decode', 'minLength').text()}(${text}, ${minimum})`;
  }

  const maxLengthAnnotation = findAnnotation(annotations, 'decode.maxLength');
  if (maxLengthAnnotation) {
    const maximum = annotationNumberArgument(maxLengthAnnotation);
    if (maximum === null) {
      ctx.error('decode.maxLength(...) requires a numeric literal.', node);
    }
    text = `${ctx.runtime.named('sts:decode', 'maxLength').text()}(${text}, ${maximum})`;
  }

  const startsWithAnnotation = findAnnotation(annotations, 'decode.startsWith');
  if (startsWithAnnotation) {
    const prefix = annotationStringArgument(startsWithAnnotation);
    if (prefix === null) {
      ctx.error('decode.startsWith(...) requires a string literal.', node);
    }
    text = `${ctx.runtime.named('sts:decode', 'startsWith').text()}(${text}, ${
      JSON.stringify(prefix)
    })`;
  }

  const endsWithAnnotation = findAnnotation(annotations, 'decode.endsWith');
  if (endsWithAnnotation) {
    const suffix = annotationStringArgument(endsWithAnnotation);
    if (suffix === null) {
      ctx.error('decode.endsWith(...) requires a string literal.', node);
    }
    text = `${ctx.runtime.named('sts:decode', 'endsWith').text()}(${text}, ${
      JSON.stringify(suffix)
    })`;
  }

  const patternAnnotation = findAnnotation(annotations, 'decode.pattern');
  if (patternAnnotation) {
    const patternText = annotationRegexpArgument(patternAnnotation);
    if (patternText === null) {
      ctx.error('decode.pattern(...) requires a regular expression literal.', node);
    }
    text = `${ctx.runtime.named('sts:decode', 'pattern').text()}(${text}, ${patternText})`;
  }

  const multipleOfAnnotation = findAnnotation(annotations, 'decode.multipleOf');
  if (multipleOfAnnotation) {
    const factor = annotationNumberishTextArgument(multipleOfAnnotation);
    if (factor === null) {
      ctx.error('decode.multipleOf(...) requires a numeric or bigint literal.', node);
    }
    text = `${ctx.runtime.named('sts:decode', 'multipleOf').text()}(${text}, ${factor})`;
  }

  if (findAnnotation(annotations, 'decode.integer')) {
    text = `${ctx.runtime.named('sts:decode', 'integer').text()}(${text})`;
  }

  const formatAnnotation = findAnnotation(annotations, 'decode.format');
  if (formatAnnotation) {
    const formatName = annotationStringArgument(formatAnnotation);
    if (
      formatName !== 'email' && formatName !== 'uuid' && formatName !== 'url' &&
      formatName !== 'iso-datetime'
    ) {
      ctx.error(`decode.format(...) requires "email", "uuid", "url", or "iso-datetime".`, node);
    }
    text = `${ctx.runtime.named('sts:decode', 'format').text()}(${text}, ${
      JSON.stringify(formatName)
    })`;
  }

  return text;
}

function wrapDecodeDefaultFieldText(
  ctx: DeriveContext,
  baseText: string,
  defaultText: string | null,
): string {
  if (defaultText === null) {
    return baseText;
  }
  const decodeDefaulted = ctx.runtime.named('sts:decode', 'defaulted').text();
  const decodeOptional = ctx.runtime.named('sts:decode', 'optional').text();
  return `${decodeDefaulted}(${decodeOptional}(${baseText}), ${defaultText})`;
}

function wrapDecodeFieldText(
  ctx: DeriveContext,
  baseText: string,
  annotations: readonly MacroAnnotation[],
  node: MacroSyntaxNode,
  localName: string,
  ownerDeclaration?: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  ownerTypeName?: string,
): string {
  const preprocessAnnotation = findAnnotation(annotations, 'decode.preprocess');
  const preprocessIdentifier = preprocessAnnotation
    ? annotationIdentifierArgument(preprocessAnnotation)
    : null;
  if (preprocessAnnotation && !preprocessIdentifier) {
    ctx.error('decode.preprocess(...) requires a helper identifier.', node);
  }
  if (preprocessAnnotation && preprocessIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      node,
      ownerDeclaration,
      ownerTypeName,
      preprocessIdentifier,
      'decode.preprocess',
    );
  }

  const transformAnnotation = findAnnotation(annotations, 'decode.transform');
  const transformIdentifier = transformAnnotation
    ? annotationIdentifierArgument(transformAnnotation)
    : null;
  if (transformAnnotation && !transformIdentifier) {
    ctx.error('decode.transform(...) requires a helper identifier.', node);
  }
  if (transformAnnotation && transformIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      node,
      ownerDeclaration,
      ownerTypeName,
      transformIdentifier,
      'decode.transform',
    );
  }

  const refineAnnotation = findAnnotation(annotations, 'decode.refine');
  const refineIdentifier = refineAnnotation ? annotationIdentifierArgument(refineAnnotation) : null;
  if (refineAnnotation && !refineIdentifier) {
    ctx.error('decode.refine(...) requires a helper identifier.', node);
  }
  if (refineAnnotation && refineIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      node,
      ownerDeclaration,
      ownerTypeName,
      refineIdentifier,
      'decode.refine',
    );
  }

  const decodeMap = ctx.runtime.named('sts:decode', 'map').text();
  const decodePreprocess = ctx.runtime.named('sts:decode', 'preprocess').text();
  const decodeRefine = ctx.runtime.named('sts:decode', 'refine').text();
  let text = baseText;
  if (preprocessIdentifier) {
    text = `${decodePreprocess}(${text}, ${preprocessIdentifier})`;
  }
  text = wrapDecodeConstraintText(ctx, text, annotations, node);
  if (transformIdentifier) {
    text = `${decodeMap}(${text}, ${transformIdentifier})`;
  }
  if (refineIdentifier) {
    text = `${decodeRefine}(${text}, ${refineIdentifier}, ${
      JSON.stringify(`Expected field "${localName}" to satisfy decode.refine(...).`)
    })`;
  }
  return text;
}

function wrapEncodeFieldText(
  ctx: DeriveContext,
  baseText: string,
  annotations: readonly MacroAnnotation[],
  node: MacroSyntaxNode,
  localName: string,
  ownerDeclaration?: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  ownerTypeName?: string,
): string {
  const transformAnnotation = findAnnotation(annotations, 'encode.transform');
  const transformIdentifier = transformAnnotation
    ? annotationIdentifierArgument(transformAnnotation)
    : null;
  if (transformAnnotation && !transformIdentifier) {
    ctx.error('encode.transform(...) requires a helper identifier.', node);
  }
  if (transformAnnotation && transformIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      node,
      ownerDeclaration,
      ownerTypeName,
      transformIdentifier,
      'encode.transform',
    );
  }

  const refineAnnotation = findAnnotation(annotations, 'encode.refine');
  const refineIdentifier = refineAnnotation ? annotationIdentifierArgument(refineAnnotation) : null;
  if (refineAnnotation && !refineIdentifier) {
    ctx.error('encode.refine(...) requires a helper identifier.', node);
  }
  if (refineAnnotation && refineIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      node,
      ownerDeclaration,
      ownerTypeName,
      refineIdentifier,
      'encode.refine',
    );
  }

  const encodeContramap = ctx.runtime.named('sts:encode', 'contramap').text();
  const encodeRefine = ctx.runtime.named('sts:encode', 'refine').text();
  let text = baseText;
  if (transformIdentifier) {
    text = `${encodeContramap}(${text}, ${transformIdentifier})`;
  }
  if (refineIdentifier) {
    text = `${encodeRefine}(${text}, ${refineIdentifier}, ${
      JSON.stringify(`Expected field "${localName}" to satisfy encode.refine(...).`)
    })`;
  }
  return text;
}

function assertAnnotationHelperCallableInScope(
  ctx: DeriveContext,
  diagnosticNode: MacroSyntaxNode,
  declaration:
    | MacroClassDeclSyntax
    | MacroInterfaceDeclSyntax
    | MacroTypeAliasDeclSyntax
    | undefined,
  typeName: string | undefined,
  helperIdentifier: string,
  annotationName:
    | 'decode.preprocess'
    | 'decode.refine'
    | 'decode.transform'
    | 'encode.refine'
    | 'encode.transform',
): void {
  if (declaration?.declarationKind === 'class' && typeName) {
    const selfHelperClassification = classifySelfStaticHelper(
      declaration,
      typeName,
      helperIdentifier,
    );
    if (selfHelperClassification === 'callable') {
      return;
    }
    if (selfHelperClassification === 'non-callable') {
      ctx.error(
        `${annotationName}(...) requires "${helperIdentifier}" to be callable.`,
        diagnosticNode,
      );
    }
  }
  if (!ctx.semantics.valueBindingInScope(helperIdentifier)) {
    ctx.error(
      `${annotationName}(...) requires the helper value "${helperIdentifier}" to be in scope.`,
      diagnosticNode,
    );
  }
  if (!ctx.semantics.valueBindingCallableInScope(helperIdentifier)) {
    ctx.error(
      `${annotationName}(...) requires "${helperIdentifier}" to be callable.`,
      diagnosticNode,
    );
  }
}

function wrapDecodeDeclarationText(
  ctx: DeriveContext,
  baseText: string,
  annotations: readonly MacroAnnotation[],
  node: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  typeName: string,
): string {
  const preprocessAnnotation = findAnnotation(annotations, 'decode.preprocess');
  const preprocessIdentifier = preprocessAnnotation
    ? annotationIdentifierArgument(preprocessAnnotation)
    : null;
  if (preprocessAnnotation && !preprocessIdentifier) {
    ctx.error('decode.preprocess(...) requires a helper identifier.', node);
  }
  if (preprocessAnnotation && preprocessIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      declarationAnnotationDiagnosticNode(node, preprocessAnnotation),
      node,
      typeName,
      preprocessIdentifier,
      'decode.preprocess',
    );
  }

  const transformAnnotation = findAnnotation(annotations, 'decode.transform');
  const transformIdentifier = transformAnnotation
    ? annotationIdentifierArgument(transformAnnotation)
    : null;
  if (transformAnnotation && !transformIdentifier) {
    ctx.error('decode.transform(...) requires a helper identifier.', node);
  }
  if (transformAnnotation && transformIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      declarationAnnotationDiagnosticNode(node, transformAnnotation),
      node,
      typeName,
      transformIdentifier,
      'decode.transform',
    );
  }

  const refineAnnotation = findAnnotation(annotations, 'decode.refine');
  const refineIdentifier = refineAnnotation ? annotationIdentifierArgument(refineAnnotation) : null;
  if (refineAnnotation && !refineIdentifier) {
    ctx.error('decode.refine(...) requires a helper identifier.', node);
  }
  if (refineAnnotation && refineIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      declarationAnnotationDiagnosticNode(node, refineAnnotation),
      node,
      typeName,
      refineIdentifier,
      'decode.refine',
    );
  }
  const decodeMap = ctx.runtime.named('sts:decode', 'map').text();
  const decodePreprocess = ctx.runtime.named('sts:decode', 'preprocess').text();
  const decodeRefine = ctx.runtime.named('sts:decode', 'refine').text();
  let text = baseText;
  if (preprocessIdentifier) {
    text = `${decodePreprocess}(${text}, ${preprocessIdentifier})`;
  }
  text = wrapDecodeConstraintText(ctx, text, annotations, node);
  if (transformIdentifier) {
    text = `${decodeMap}(${text}, ${transformIdentifier})`;
  }
  if (refineIdentifier) {
    text = `${decodeRefine}(${text}, ${refineIdentifier}, ${
      JSON.stringify(`Expected ${typeName} to satisfy decode.refine(...).`)
    })`;
  }
  return text;
}

function wrapEncodeDeclarationText(
  ctx: DeriveContext,
  baseText: string,
  annotations: readonly MacroAnnotation[],
  node: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  typeName: string,
): string {
  const transformAnnotation = findAnnotation(annotations, 'encode.transform');
  const transformIdentifier = transformAnnotation
    ? annotationIdentifierArgument(transformAnnotation)
    : null;
  if (transformAnnotation && !transformIdentifier) {
    ctx.error('encode.transform(...) requires a helper identifier.', node);
  }
  if (transformAnnotation && transformIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      declarationAnnotationDiagnosticNode(node, transformAnnotation),
      node,
      typeName,
      transformIdentifier,
      'encode.transform',
    );
  }

  const refineAnnotation = findAnnotation(annotations, 'encode.refine');
  const refineIdentifier = refineAnnotation ? annotationIdentifierArgument(refineAnnotation) : null;
  if (refineAnnotation && !refineIdentifier) {
    ctx.error('encode.refine(...) requires a helper identifier.', node);
  }
  if (refineAnnotation && refineIdentifier) {
    assertAnnotationHelperCallableInScope(
      ctx,
      declarationAnnotationDiagnosticNode(node, refineAnnotation),
      node,
      typeName,
      refineIdentifier,
      'encode.refine',
    );
  }
  const encodeContramap = ctx.runtime.named('sts:encode', 'contramap').text();
  const encodeRefine = ctx.runtime.named('sts:encode', 'refine').text();
  let text = baseText;
  if (transformIdentifier) {
    text = `${encodeContramap}(${text}, ${transformIdentifier})`;
  }
  if (refineIdentifier) {
    text = `${encodeRefine}(${text}, ${refineIdentifier}, ${
      JSON.stringify(`Expected ${typeName} to satisfy encode.refine(...).`)
    })`;
  }
  return text;
}

function metadataHelperNameText(helperIdentifier: string): string | null {
  const segments = helperIdentifier.split('.').map((segment) => segment.trim()).filter((segment) =>
    segment.length > 0
  );
  return segments.at(-1) ?? null;
}

function metadataOpaqueEffectText(
  effect: 'factory' | 'via',
  helperIdentifier: string,
  isAsync: boolean,
  helperText: string = helperIdentifier,
): string {
  const helperName = metadataHelperNameText(helperIdentifier);
  return `{
    kind: 'opaque',
    effect: '${effect}',
    async: ${isAsync ? 'true' : 'false'},
    ${helperName === null ? 'helperName: null,' : `helperName: ${JSON.stringify(helperName)},`}
    helperText: ${JSON.stringify(helperText)},
  }`;
}

function decodeFieldMetadataEffectsText(
  ctx: DeriveContext,
  annotations: readonly MacroAnnotation[],
  scopeNode: MacroSyntaxNode,
  macroName: 'codec' | 'decode',
): string | null {
  const annotationName = macroName === 'codec' ? 'codec.via' : 'decode.via';
  const viaAnnotation = findAnnotation(annotations, annotationName);
  const helperIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (!helperIdentifier) {
    return null;
  }
  const mode = annotationIdentifierHelperModeWithoutDiagnostic(
    ctx,
    viaAnnotation,
    scopeNode,
    'decode',
  );
  return `[${metadataOpaqueEffectText('via', helperIdentifier, mode === 'async')}]`;
}

function encodeFieldMetadataEffectsText(
  ctx: DeriveContext,
  annotations: readonly MacroAnnotation[],
  scopeNode: MacroSyntaxNode,
  macroName: 'codec' | 'encode',
): string | null {
  const annotationName = macroName === 'codec' ? 'codec.via' : 'encode.via';
  const viaAnnotation = findAnnotation(annotations, annotationName);
  const helperIdentifier = viaAnnotation ? annotationIdentifierArgument(viaAnnotation) : null;
  if (!helperIdentifier) {
    return null;
  }
  const mode = annotationIdentifierHelperModeWithoutDiagnostic(
    ctx,
    viaAnnotation,
    scopeNode,
    'encode',
  );
  return `[${metadataOpaqueEffectText('via', helperIdentifier, mode === 'async')}]`;
}

function classFactoryMetadataEffectText(
  ctx: DeriveContext,
  declaration: MacroClassDeclSyntax,
  macroName: 'codec' | 'decode',
  typeName: string,
): string {
  const annotation = findAnnotation(
    resolvedDeclarationAnnotations(ctx, declaration),
    `${macroName}.factory`,
  );
  if (!annotation) {
    return `{
      kind: 'opaque',
      effect: 'factory',
      async: false,
      helperName: ${JSON.stringify(typeName)},
      helperText: ${JSON.stringify(`Object.assign(new ${typeName}(), value)`)},
    }`;
  }
  const helperIdentifier = annotationIdentifierArgument(annotation);
  if (!helperIdentifier) {
    ctx.error(
      `${macroName}.factory(...) requires a helper identifier.`,
      declarationAnnotationDiagnosticNode(declaration, annotation),
    );
  }
  return metadataOpaqueEffectText(
    'factory',
    helperIdentifier,
    declarationFactoryMayResolveAsync(ctx, declaration, macroName),
  );
}

function metadataDirectionFallbackText(mode: 'async' | 'sync'): string {
  return `{
    mode: ${JSON.stringify(mode)},
    root: 'root',
    nodes: {
      root: { kind: 'opaque' },
    },
  }`;
}

function metadataFieldPatchArrayText(
  rootName: string,
  fields: readonly {
    readonly localName: string;
    readonly metadataEffectsText: string | null;
    readonly optional: boolean;
    readonly wireName: string;
  }[],
): string {
  return `[
    ${
    fields.map((field, index) =>
      `{
      ...${rootName}.fields[${index}]!,
      localName: ${JSON.stringify(field.localName)},
      optional: ${field.optional ? 'true' : 'false'},
      wireName: ${JSON.stringify(field.wireName)}${
        field.metadataEffectsText
          ? `,
      effects: ${field.metadataEffectsText}`
          : ''
      },
    }`
    ).join(',\n')
  }
  ]`;
}

function stripAnonymousProjectionEffectText(
  rootName: string,
  extraEffectsTexts: readonly string[] = [],
): string {
  return `(() => {
    const effects = [...(${rootName}.effects ?? [])];
    const anonymousProjectionIndex = effects.findIndex((effect) =>
      effect.kind === 'opaque' &&
      effect.effect === 'transform' &&
      (effect.helperName ?? null) === null &&
      (effect.helperText ?? null) === null
    );
    if (anonymousProjectionIndex >= 0) {
      effects.splice(anonymousProjectionIndex, 1);
    }
    ${extraEffectsTexts.map((effectText) => `effects.push(${effectText});`).join('\n')}
    return effects;
  })()`;
}

function withDecodeObjectMetadataText(
  ctx: DeriveContext,
  baseText: string,
  fields: readonly DecodedField[] | readonly CodecField[],
  options: {
    readonly factoryEffectText?: string;
  } = {},
): string {
  const metadataOf = ctx.runtime.named('sts:metadata', 'metadataOf').text();
  const attachMetadata = ctx.runtime.named('sts:metadata', 'attachMetadata').text();
  const rootEffectsText = stripAnonymousProjectionEffectText(
    '__sts_root',
    options.factoryEffectText ? [options.factoryEffectText] : [],
  );
  const fieldArrayText = metadataFieldPatchArrayText('__sts_root', fields);
  return `(() => {
    const __sts_base = ${baseText};
    const __sts_metadata = ${metadataOf}(__sts_base);
    if (__sts_metadata === null || !__sts_metadata.decode) {
      return __sts_base;
    }
    const __sts_decode = __sts_metadata.decode;
    const __sts_root = __sts_decode.nodes[__sts_decode.root];
    if (!__sts_root || __sts_root.kind !== 'object') {
      return __sts_base;
    }
    const __sts_effects = ${rootEffectsText};
    return ${attachMetadata}(__sts_base, {
      ...__sts_metadata,
      decode: {
        ...__sts_decode,
        nodes: {
          ...__sts_decode.nodes,
          [__sts_decode.root]: {
            ...__sts_root,
            ...(__sts_effects.length > 0 ? { effects: __sts_effects } : {}),
            fields: ${fieldArrayText},
          },
        },
      },
    });
  })()`;
}

function withEncodeObjectMetadataText(
  ctx: DeriveContext,
  baseText: string,
  fields: readonly EncodedField[] | readonly CodecField[],
): string {
  const metadataOf = ctx.runtime.named('sts:metadata', 'metadataOf').text();
  const attachMetadata = ctx.runtime.named('sts:metadata', 'attachMetadata').text();
  const rootEffectsText = stripAnonymousProjectionEffectText('__sts_root');
  const fieldArrayText = metadataFieldPatchArrayText('__sts_root', fields);
  return `(() => {
    const __sts_base = ${baseText};
    const __sts_metadata = ${metadataOf}(__sts_base);
    if (__sts_metadata === null || !__sts_metadata.encode) {
      return __sts_base;
    }
    const __sts_encode = __sts_metadata.encode;
    const __sts_root = __sts_encode.nodes[__sts_encode.root];
    if (!__sts_root || __sts_root.kind !== 'object') {
      return __sts_base;
    }
    const __sts_effects = ${rootEffectsText};
    return ${attachMetadata}(__sts_base, {
      ...__sts_metadata,
      encode: {
        ...__sts_encode,
        nodes: {
          ...__sts_encode.nodes,
          [__sts_encode.root]: {
            ...__sts_root,
            ...(__sts_effects.length > 0 ? { effects: __sts_effects } : {}),
            fields: ${fieldArrayText},
          },
        },
      },
    });
  })()`;
}

function withNamedMetadataText(
  ctx: DeriveContext,
  baseText: string,
  typeName: string,
  modes: {
    readonly decode?: 'async' | 'sync';
    readonly encode?: 'async' | 'sync';
  },
): string {
  const metadataOf = ctx.runtime.named('sts:metadata', 'metadataOf').text();
  const attachMetadata = ctx.runtime.named('sts:metadata', 'attachMetadata').text();
  const decodeFallbackText = modes.decode ? metadataDirectionFallbackText(modes.decode) : null;
  const encodeFallbackText = modes.encode ? metadataDirectionFallbackText(modes.encode) : null;
  return `(() => {
    const __sts_base = ${baseText};
    const __sts_metadata = ${metadataOf}(__sts_base);
    return ${attachMetadata}(__sts_base, __sts_metadata === null ? {
      name: ${JSON.stringify(typeName)}${
    decodeFallbackText
      ? `,
      decode: ${decodeFallbackText}`
      : ''
  }${
    encodeFallbackText
      ? `,
      encode: ${encodeFallbackText}`
      : ''
  }
    } : {
      ...__sts_metadata,
      name: ${JSON.stringify(typeName)}${
    modes.decode
      ? `,
      decode: __sts_metadata.decode
        ? { ...__sts_metadata.decode, mode: ${JSON.stringify(modes.decode)} }
        : ${decodeFallbackText}`
      : ''
  }${
    modes.encode
      ? `,
      encode: __sts_metadata.encode
        ? { ...__sts_metadata.encode, mode: ${JSON.stringify(modes.encode)} }
        : ${encodeFallbackText}`
      : ''
  }
    });
  })()`;
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

function declarationHasDeriveAnnotation(
  ctx: DeriveContext,
  node: MacroSyntaxNode,
  macroName: DerivedMacroName,
): boolean {
  return findAnnotation(ctx.syntax.annotations(node), macroName) !== null;
}

function codecNamedSideCompanions(
  ctx: DeriveContext,
  typeName: string,
  ownerTypeName: string,
  scopeNode: MacroSyntaxNode,
): { readonly decodeCompanionName: string; readonly encodeCompanionName: string } | null {
  const decodeCompanionName = expectedCompanionName(typeName, 'decode');
  const encodeCompanionName = expectedCompanionName(typeName, 'encode');
  const hasDecodeCompanion = typeName === ownerTypeName
    ? declarationHasDeriveAnnotation(ctx, scopeNode, 'decode')
    : ctx.semantics.valueBindingInScope(decodeCompanionName) ||
      ctx.semantics.localDeclarationHasAnnotation(typeName, 'decode');
  const hasEncodeCompanion = typeName === ownerTypeName
    ? declarationHasDeriveAnnotation(ctx, scopeNode, 'encode')
    : ctx.semantics.valueBindingInScope(encodeCompanionName) ||
      ctx.semantics.localDeclarationHasAnnotation(typeName, 'encode');

  return hasDecodeCompanion && hasEncodeCompanion
    ? { decodeCompanionName, encodeCompanionName }
    : null;
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
      return wrapDecodeViaHelperText(
        ctx,
        field.type,
        ownerTypeName,
        scopeNode,
        field.node,
        viaIdentifier,
        explicitTypeNodeForSyntaxNode(field.node),
      );
    }
    const typeNode = explicitTypeNodeForSyntaxNode(field.node);
    const helperText = decodeHelperTextFromShape(
      ctx,
      field.type,
      ownerTypeName,
      scopeNode,
      field.node,
      typeNode,
    );
    if (!helperText) {
      ctx.error(decodeLikeUnsupportedFieldMessage('decode'), field.node);
    }
    return helperText;
  })();
  const defaultText = decodeDefaultExpressionText(ctx, field.annotations, field.node);
  const fieldDecoderText = wrapDecodeFieldText(
    ctx,
    decoderText,
    field.annotations,
    field.node,
    field.name,
    asMacroDeclarationNode(scopeNode),
    ownerTypeName,
  );

  return {
    decoderText: wrapDecodeDefaultFieldText(ctx, fieldDecoderText, defaultText),
    defaultText: null,
    localName: field.name,
    metadataEffectsText: decodeFieldMetadataEffectsText(
      ctx,
      field.annotations,
      field.node,
      'decode',
    ),
    optional: field.optional && defaultText === null,
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
      return wrapEncodeViaHelperText(
        ctx,
        field.type,
        ownerTypeName,
        scopeNode,
        field.node,
        viaIdentifier,
        explicitTypeNodeForSyntaxNode(field.node),
      );
    }
    const helperText = encodeHelperTextFromShape(
      ctx,
      field.type,
      ownerTypeName,
      scopeNode,
      field.node,
      explicitTypeNodeForSyntaxNode(field.node),
    );
    if (!helperText) {
      ctx.error(decodeLikeUnsupportedFieldMessage('encode'), field.node);
    }
    return helperText;
  })();

  return {
    encoderText: wrapEncodeFieldText(
      ctx,
      encoderText,
      field.annotations,
      field.node,
      field.name,
      asMacroDeclarationNode(scopeNode),
      ownerTypeName,
    ),
    localName: field.name,
    metadataEffectsText: encodeFieldMetadataEffectsText(
      ctx,
      field.annotations,
      field.node,
      'encode',
    ),
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
      return wrapCodecViaHelperTexts(
        ctx,
        field.type,
        ownerTypeName,
        scopeNode,
        field.node,
        { decodeText: viaIdentifier, encodeText: viaIdentifier },
        explicitTypeNodeForSyntaxNode(field.node),
      );
    }
    const helperTexts = codecHelperTextsFromShape(
      ctx,
      field.type,
      ownerTypeName,
      scopeNode,
      field.node,
      explicitTypeNodeForSyntaxNode(field.node),
    );
    if (!helperTexts) {
      ctx.error(decodeLikeUnsupportedFieldMessage('codec'), field.node);
    }
    return helperTexts;
  })();
  const decodeDefaultText = decodeDefaultExpressionText(ctx, field.annotations, field.node);
  const decodeFieldText = wrapDecodeFieldText(
    ctx,
    helperTexts.decodeText,
    field.annotations,
    field.node,
    field.name,
    asMacroDeclarationNode(scopeNode),
    ownerTypeName,
  );

  return {
    decodeDefaultText: null,
    decodeOptional: field.optional && decodeDefaultText === null,
    decodeText: wrapDecodeDefaultFieldText(ctx, decodeFieldText, decodeDefaultText),
    encodeText: wrapEncodeFieldText(
      ctx,
      helperTexts.encodeText,
      field.annotations,
      field.node,
      field.name,
      asMacroDeclarationNode(scopeNode),
      ownerTypeName,
    ),
    localName: field.name,
    metadataEffectsText: decodeFieldMetadataEffectsText(
      ctx,
      field.annotations,
      field.node,
      'codec',
    ),
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
  const isIdentityProjection = decodedFields.every((field) =>
    field.localName === field.wireName && field.defaultText === null
  );
  const projectionText = objectProjectionText(decodedFields.map((field) => ({
    keyName: field.localName,
    optional: field.optional,
    valueText: decodeDefaultProjectionText(propertyAccessText('value', field.wireName), field.defaultText),
  })));
  const helperText = isIdentityProjection
    ? `${decodeObject}(${shapeText})`
    : `${decodeMap}(
    ${decodeObject}(${shapeText}),
    (value) => ${projectionText},
  )`;
  return withDecodeObjectMetadataText(ctx, helperText, decodedFields);
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
  const projectionText = objectProjectionText(encodedFields.map((field) => ({
    keyName: field.wireName,
    optional: field.optional,
    valueText: propertyAccessText('value', field.localName),
  })));
  const helperText = isIdentityProjection
    ? `${encodeObject}(${shapeText})`
    : `${encodeContramap}(
    ${encodeObject}(${shapeText}),
    (value) => ${projectionText},
  )`;
  return withEncodeObjectMetadataText(ctx, helperText, encodedFields);
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
        field.decodeOptional ? `${decodeOptional}(${field.decodeText})` : field.decodeText
      }`
    ).join(',\n')
  }
      }`;
  const hasIdentityDecodeProjection = codecFields.every((field) =>
    field.localName === field.wireName && field.decodeDefaultText === null
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
  const decodeHelperText = hasIdentityDecodeProjection
    ? `${decodeObject}(${decodeShapeText})`
    : `${decodeMap}(
      ${decodeObject}(${decodeShapeText}),
      (value) => ${
      objectProjectionText(codecFields.map((field) => ({
        keyName: field.localName,
        optional: field.decodeOptional,
        valueText: decodeDefaultProjectionText(
          propertyAccessText('value', field.wireName),
          field.decodeDefaultText,
        ),
      })))
    },
    )`;
  const encodeHelperText = hasIdentityEncodeProjection
    ? `${encodeObject}(${encodeShapeText})`
    : `${encodeContramap}(
      ${encodeObject}(${encodeShapeText}),
      (value) => ${
      objectProjectionText(codecFields.map((field) => ({
        keyName: field.wireName,
        optional: field.optional,
        valueText: propertyAccessText('value', field.localName),
      })))
    },
    )`;
  return {
    decodeText: withDecodeObjectMetadataText(ctx, decodeHelperText, codecFields),
    encodeText: withEncodeObjectMetadataText(ctx, encodeHelperText, codecFields),
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
  const isIdentityProjection = fields.every((field) =>
    field.localName === field.wireName && field.defaultText === null
  );
  const projectionText = objectProjectionText(fields.map((field) => ({
    keyName: field.localName,
    optional: field.optional,
    valueText: decodeDefaultProjectionText(propertyAccessText('value', field.wireName), field.defaultText),
  })));
  const helperText = isIdentityProjection ? `${decodeObject}(${shapeText})` : `${decodeMap}(
    ${decodeObject}(${shapeText}),
    (value) => ${projectionText},
  )`;
  return withDecodeObjectMetadataText(ctx, helperText, fields);
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
  const projectionText = objectProjectionText(fields.map((field) => ({
    keyName: field.wireName,
    optional: field.optional,
    valueText: propertyAccessText('value', field.localName),
  })));
  const helperText = isIdentityProjection ? `${encodeObject}(${shapeText})` : `${encodeContramap}(
    ${encodeObject}(${shapeText}),
    (value) => ${projectionText},
  )`;
  return withEncodeObjectMetadataText(ctx, helperText, fields);
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
  const decodeHelperText = hasIdentityDecodeProjection
    ? `${decodeObject}(${decodeShapeText})`
    : `${decodeMap}(
      ${decodeObject}(${decodeShapeText}),
      (value) => ${
      objectProjectionText(fields.map((field) => ({
        keyName: field.localName,
        optional: field.optional,
        valueText: propertyAccessText('value', field.wireName),
      })))
    },
    )`;
  const encodeHelperText = hasIdentityEncodeProjection
    ? `${encodeObject}(${encodeShapeText})`
    : `${encodeContramap}(
      ${encodeObject}(${encodeShapeText}),
      (value) => ${
      objectProjectionText(fields.map((field) => ({
        keyName: field.wireName,
        optional: field.optional,
        valueText: propertyAccessText('value', field.localName),
      })))
    },
    )`;
  return {
    decodeText: withDecodeObjectMetadataText(ctx, decodeHelperText, fields),
    encodeText: withEncodeObjectMetadataText(ctx, encodeHelperText, fields),
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
  const reflectedType = ctx.reflect.typeShape(explicitType);

  const decoderText = (() => {
    if (viaIdentifier) {
      return wrapDecodeViaHelperText(
        ctx,
        reflectedType,
        ownerTypeName,
        scopeNode,
        member,
        viaIdentifier,
        hostTypeNode(explicitType),
      );
    }

    const helperText = decodeHelperTextFromShape(
      ctx,
      reflectedType,
      ownerTypeName,
      scopeNode,
      member,
      hostTypeNode(explicitType),
    );
    if (!helperText) {
      ctx.error(decodeLikeUnsupportedFieldMessage('decode'), member);
    }
    return helperText;
  })();
  const annotations = ctx.syntax.annotations(member);
  const defaultText = decodeDefaultExpressionText(ctx, annotations, member);
  const fieldDecoderText = wrapDecodeFieldText(
    ctx,
    decoderText,
    annotations,
    member,
    member.name,
    asMacroDeclarationNode(scopeNode),
    ownerTypeName,
  );

  return {
    decoderText: wrapDecodeDefaultFieldText(ctx, fieldDecoderText, defaultText),
    defaultText: null,
    localName: member.name,
    metadataEffectsText: decodeFieldMetadataEffectsText(ctx, annotations, member, 'decode'),
    optional: member.isOptional() && defaultText === null,
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
  const reflectedType = ctx.reflect.typeShape(explicitType);

  const decoderText = (() => {
    if (viaIdentifier) {
      return wrapDecodeViaHelperText(
        ctx,
        reflectedType,
        ownerTypeName,
        scopeNode,
        field,
        viaIdentifier,
        hostTypeNode(explicitType),
      );
    }

    const helperText = decodeHelperTextFromShape(
      ctx,
      reflectedType,
      ownerTypeName,
      scopeNode,
      field,
      hostTypeNode(explicitType),
    );
    if (!helperText) {
      ctx.error(decodeLikeUnsupportedFieldMessage('decode'), field);
    }
    return helperText;
  })();
  const annotations = ctx.syntax.annotations(field);
  const defaultText = decodeDefaultExpressionText(ctx, annotations, field);
  const fieldDecoderText = wrapDecodeFieldText(
    ctx,
    decoderText,
    annotations,
    field,
    field.name,
    asMacroDeclarationNode(scopeNode),
    ownerTypeName,
  );

  return {
    decoderText: wrapDecodeDefaultFieldText(ctx, fieldDecoderText, defaultText),
    defaultText: null,
    localName: field.name,
    metadataEffectsText: decodeFieldMetadataEffectsText(ctx, annotations, field, 'decode'),
    optional: field.isOptional() && defaultText === null,
    wireName: renamedWireName ?? field.name,
  };
}

function classHasConstructorParameters(declaration: MacroClassDeclSyntax): boolean {
  return declaration.members().some((member) =>
    member.memberKind === 'constructor' && member.parameters.length > 0
  );
}

function classifySelfStaticHelper(
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

function hostDeclarationNameText(
  name: ts.PropertyName | ts.DeclarationName | undefined,
): string | null {
  if (!name) {
    return null;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function hostTypeNodeMayResolveAsync(typeNode: ts.TypeNode | undefined): boolean {
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return false;
  }
  const typeName = ts.isIdentifier(typeNode.typeName)
    ? typeNode.typeName.text
    : ts.isQualifiedName(typeNode.typeName)
    ? typeNode.typeName.right.text
    : null;
  return typeName === 'Promise' || typeName === 'PromiseLike';
}

function selfStaticHelperMayResolveAsync(
  declaration: MacroClassDeclSyntax,
  typeName: string,
  factoryIdentifier: string,
): boolean | null {
  const segments = factoryIdentifier.split('.').map((segment) => segment.trim()).filter((segment) =>
    segment.length > 0
  );
  if (segments.length !== 2 || segments[0] !== typeName) {
    return null;
  }

  const hostDeclaration = getHostDeclaration(declaration);
  if (!ts.isClassDeclaration(hostDeclaration)) {
    return false;
  }
  const hostMember = hostDeclaration.members.find((member) =>
    ts.canHaveModifiers(member) &&
    ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ===
      true &&
    hostDeclarationNameText(member.name) === segments[1]
  );
  if (!hostMember) {
    return false;
  }
  if (ts.isMethodDeclaration(hostMember)) {
    return hostTypeNodeMayResolveAsync(hostMember.type) ||
      (ts.canHaveModifiers(hostMember) &&
        ts.getModifiers(hostMember)?.some((modifier) =>
            modifier.kind === ts.SyntaxKind.AsyncKeyword
          ) === true);
  }
  return false;
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
    const selfFactoryClassification = classifySelfStaticHelper(
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
  const reflectedType = ctx.reflect.typeShape(explicitType);

  const encoderText = (() => {
    if (viaIdentifier) {
      return wrapEncodeViaHelperText(
        ctx,
        reflectedType,
        ownerTypeName,
        scopeNode,
        member,
        viaIdentifier,
        hostTypeNode(explicitType),
      );
    }

    const helperText = encodeHelperTextFromShape(
      ctx,
      reflectedType,
      ownerTypeName,
      scopeNode,
      member,
      hostTypeNode(explicitType),
    );
    if (!helperText) {
      ctx.error(decodeLikeUnsupportedFieldMessage('encode'), member);
    }
    return helperText;
  })();
  const annotations = ctx.syntax.annotations(member);

  return {
    encoderText: wrapEncodeFieldText(
      ctx,
      encoderText,
      annotations,
      member,
      member.name,
      asMacroDeclarationNode(scopeNode),
      ownerTypeName,
    ),
    localName: member.name,
    metadataEffectsText: encodeFieldMetadataEffectsText(ctx, annotations, member, 'encode'),
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
  const reflectedType = ctx.reflect.typeShape(explicitType);

  const encoderText = (() => {
    if (viaIdentifier) {
      return wrapEncodeViaHelperText(
        ctx,
        reflectedType,
        ownerTypeName,
        scopeNode,
        field,
        viaIdentifier,
        hostTypeNode(explicitType),
      );
    }

    const helperText = encodeHelperTextFromShape(
      ctx,
      reflectedType,
      ownerTypeName,
      scopeNode,
      field,
      hostTypeNode(explicitType),
    );
    if (!helperText) {
      ctx.error(decodeLikeUnsupportedFieldMessage('encode'), field);
    }
    return helperText;
  })();
  const annotations = ctx.syntax.annotations(field);

  return {
    encoderText: wrapEncodeFieldText(
      ctx,
      encoderText,
      annotations,
      field,
      field.name,
      asMacroDeclarationNode(scopeNode),
      ownerTypeName,
    ),
    localName: field.name,
    metadataEffectsText: encodeFieldMetadataEffectsText(ctx, annotations, field, 'encode'),
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
  const reflectedType = ctx.reflect.typeShape(explicitType);

  const helperTexts = (() => {
    if (viaIdentifier) {
      return wrapCodecViaHelperTexts(
        ctx,
        reflectedType,
        ownerTypeName,
        scopeNode,
        member,
        { decodeText: viaIdentifier, encodeText: viaIdentifier },
        hostTypeNode(explicitType),
      );
    }

    const helperTexts = codecHelperTextsFromShape(
      ctx,
      reflectedType,
      ownerTypeName,
      scopeNode,
      member,
      hostTypeNode(explicitType),
    );
    if (!helperTexts) {
      ctx.error(decodeLikeUnsupportedFieldMessage('codec'), member);
    }
    return helperTexts;
  })();
  const annotations = ctx.syntax.annotations(member);
  const decodeDefaultText = decodeDefaultExpressionText(ctx, annotations, member);
  const decodeFieldText = wrapDecodeFieldText(
    ctx,
    helperTexts.decodeText,
    annotations,
    member,
    member.name,
    asMacroDeclarationNode(scopeNode),
    ownerTypeName,
  );

  return {
    decodeDefaultText: null,
    decodeOptional: member.isOptional() && decodeDefaultText === null,
    decodeText: wrapDecodeDefaultFieldText(ctx, decodeFieldText, decodeDefaultText),
    encodeText: wrapEncodeFieldText(
      ctx,
      helperTexts.encodeText,
      annotations,
      member,
      member.name,
      asMacroDeclarationNode(scopeNode),
      ownerTypeName,
    ),
    localName: member.name,
    metadataEffectsText: decodeFieldMetadataEffectsText(ctx, annotations, member, 'codec'),
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
  const reflectedType = ctx.reflect.typeShape(explicitType);

  const helperTexts = (() => {
    if (viaIdentifier) {
      return wrapCodecViaHelperTexts(
        ctx,
        reflectedType,
        ownerTypeName,
        scopeNode,
        field,
        { decodeText: viaIdentifier, encodeText: viaIdentifier },
        hostTypeNode(explicitType),
      );
    }

    const helperTexts = codecHelperTextsFromShape(
      ctx,
      reflectedType,
      ownerTypeName,
      scopeNode,
      field,
      hostTypeNode(explicitType),
    );
    if (!helperTexts) {
      ctx.error(decodeLikeUnsupportedFieldMessage('codec'), field);
    }
    return helperTexts;
  })();
  const annotations = ctx.syntax.annotations(field);
  const decodeDefaultText = decodeDefaultExpressionText(ctx, annotations, field);
  const decodeFieldText = wrapDecodeFieldText(
    ctx,
    helperTexts.decodeText,
    annotations,
    field,
    field.name,
    asMacroDeclarationNode(scopeNode),
    ownerTypeName,
  );

  return {
    decodeDefaultText: null,
    decodeOptional: field.isOptional() && decodeDefaultText === null,
    decodeText: wrapDecodeDefaultFieldText(ctx, decodeFieldText, decodeDefaultText),
    encodeText: wrapEncodeFieldText(
      ctx,
      helperTexts.encodeText,
      annotations,
      field,
      field.name,
      asMacroDeclarationNode(scopeNode),
      ownerTypeName,
    ),
    localName: field.name,
    metadataEffectsText: decodeFieldMetadataEffectsText(ctx, annotations, field, 'codec'),
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
  const hostUnionType = ts.isUnionTypeNode(hostDeclaration.type) ? hostDeclaration.type : undefined;
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
  return `${decodeMapText}(
    ${decodeObjectText}({
      ${shapeEntries.join(',\n')}
    }),
    (value) => ${
    objectProjectionText([
      {
        keyName: discriminantName,
        optional: false,
        valueText: JSON.stringify(variant.tag),
      },
      ...variant.fields.map((field) => ({
        keyName: field.localName,
        optional: field.optional,
        valueText: propertyAccessText('value', field.wireName),
      })),
    ])
  },
  )`;
}

function taggedEncodeVariantProjectionText(
  discriminantName: string,
  variant: TaggedDerivedVariant<EncodedField>,
  receiverName: string,
): string {
  return objectProjectionText([
    {
      keyName: discriminantName,
      optional: false,
      valueText: JSON.stringify(variant.tag),
    },
    ...variant.fields.map((field) => ({
      keyName: field.wireName,
      optional: field.optional,
      valueText: propertyAccessText(receiverName, field.localName),
    })),
  ]);
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
  return `${decodeMapText}(
    ${decodeObjectText}({
      ${shapeEntries.join(',\n')}
    }),
    (value) => ${
    objectProjectionText([
      {
        keyName: discriminantName,
        optional: false,
        valueText: JSON.stringify(variant.tag),
      },
      ...variant.fields.map((field) => ({
        keyName: field.localName,
        optional: field.decodeOptional,
        valueText: propertyAccessText('value', field.wireName),
      })),
    ])
  },
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
  return objectProjectionText([
    {
      keyName: discriminantName,
      optional: false,
      valueText: JSON.stringify(variant.tag),
    },
    ...variant.fields.map((field) => ({
      keyName: field.wireName,
      optional: field.optional,
      valueText: propertyAccessText(receiverName, field.localName),
    })),
  ]);
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
      const declarationAnnotations = ctx.syntax.annotations(decoded.args.target);
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
          const unionText = wrapDecodeDeclarationText(
            ctx,
            foldUnionText(decodeUnion, variantDecoders),
            declarationAnnotations,
            declaration,
            typeName,
          );
          const companionName = `${typeName}Decoder`;
          return ctx.output.stmt(
            ctx.quote.stmt`
              export const ${companionName} = ${
              withNamedMetadataText(ctx, unionText, typeName, {})
            };
            `,
          );
        }
        if (!declaration.type.asObjectLiteral()) {
          const typeName = declarationTypeName(declaration);
          const helperText = decodeHelperTextFromShape(
            ctx,
            ctx.reflect.typeShape(declaration.type),
            typeName,
            declaration,
            declaration,
            hostTypeNode(declaration.type),
          );
          if (helperText) {
            const decoderText = wrapDecodeDeclarationText(
              ctx,
              helperText,
              declarationAnnotations,
              declaration,
              typeName,
            );
            const companionName = `${typeName}Decoder`;
            return ctx.output.stmt(
              ctx.quote.stmt`
                export const ${companionName} = ${
                withNamedMetadataText(ctx, decoderText, typeName, {})
              };
              `,
            );
          }
        }
      }

      const { fields, instantiateText, typeName } = collectDecodeFields(ctx, decoded);
      const object = ctx.runtime.named('sts:decode', 'object').text();
      const map = ctx.runtime.named('sts:decode', 'map').text();
      const optional = ctx.runtime.named('sts:decode', 'optional').text();
      const objectPolicyText = decodeUnknownKeysPolicyText(
        ctx,
        declarationAnnotations,
        decoded.args.target,
      );
      const shapeText = fields.length === 0 ? '{}' : `{
            ${
        fields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${
            field.optional ? `${optional}(${field.decoderText})` : field.decoderText
          }`
        ).join(',\n')
      }
          }`;

      const projectionText = objectProjectionText(fields.map((field) => ({
        keyName: field.localName,
        optional: field.optional,
        valueText: decodeDefaultProjectionText(
          propertyAccessText('value', field.wireName),
          field.defaultText,
        ),
      })));
      const finalProjectionText = instantiateText === null
        ? projectionText
        : `(${instantiateText.replace(CLASS_DECODE_VALUE_PLACEHOLDER, projectionText)})`;
      const objectCallText = `${object}(${shapeText}${
        objectPolicyText ? `, { unknownKeys: ${objectPolicyText} }` : ''
      })`;
      const baseDecoderText = withDecodeObjectMetadataText(
        ctx,
        `${map}(
            ${objectCallText},
            (value) => ${finalProjectionText},
          )`,
        fields,
        decoded.caseName === 'class'
          ? {
            factoryEffectText: classFactoryMetadataEffectText(
              ctx,
              decoded.args.target as MacroClassDeclSyntax,
              'decode',
              typeName,
            ),
          }
          : {},
      );

      const decoderText = wrapDecodeDeclarationText(
        ctx,
        baseDecoderText,
        declarationAnnotations,
        decoded.args.target,
        typeName,
      );
      const companionName = `${typeName}Decoder`;
      const namedDecoderText = withNamedMetadataText(ctx, decoderText, typeName, {});
      const recursiveDecoderTypeAliasName = `__sts_${typeName}DecoderType`;
      const useRecursiveStructuralTyping = isPlainStructuralRecursiveDeclaration(
        ctx,
        decoded.args.target,
        typeName,
        'decode',
      );
      if (useRecursiveStructuralTyping) {
        const decodeMode = recursiveDeclarationDecodeMode(ctx, decoded.args.target, 'decode');
        const selfName = '__sts_self';
        const recursiveDecoderTypeAliasText = decodeMode === 'sync'
          ? `type ${recursiveDecoderTypeAliasName} = import('sts:decode').Decoder<${typeName}>;`
          : `type ${recursiveDecoderTypeAliasName} = import('sts:decode').Decoder<${typeName}, unknown, "async">;`;
        let recursiveDecoderText = rewriteRecursiveSelfReference(
          namedDecoderText,
          `(): import('sts:decode').Decoder<${typeName}> => ${companionName}`,
          `(): ${recursiveDecoderTypeAliasName} => ${selfName}`,
        );
        recursiveDecoderText = rewriteRecursiveLazyInvocation(
          recursiveDecoderText,
          recursiveDecoderTypeAliasName,
          selfName,
          decodeMode === 'sync'
            ? `${typeName}, import('sts:decode').DecodeFailure, "sync"`
            : `${typeName}, unknown, "async"`,
        );
        if (decoded.caseName !== 'class') {
          recursiveDecoderText = rewriteRecursiveSelfReference(
            recursiveDecoderText,
            '(value) =>',
            `(value): ${typeName} =>`,
          );
        }
        return ctx.output.stmts(
          ctx.quote.stmts`
            ${recursiveDecoderTypeAliasText}
            export const ${companionName}: ${recursiveDecoderTypeAliasName} = (() => {
              let ${selfName}!: ${recursiveDecoderTypeAliasName};
              ${selfName} = ${recursiveDecoderText} as unknown as ${recursiveDecoderTypeAliasName};
              return ${selfName};
            })();
          `,
        );
      }
      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${companionName} = ${namedDecoderText};
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
      const declarationAnnotations = ctx.syntax.annotations(decoded.args.target);
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
          const encoderText = wrapEncodeDeclarationText(
            ctx,
            `${encodeFromEncode}((value: ${typeName}): import('sts:result').Result<import('sts:json').JsonLikeValue, import('sts:encode').EncodeFailure> | Promise<import('sts:result').Result<import('sts:json').JsonLikeValue, import('sts:encode').EncodeFailure>> => {
                switch (${propertyAccessText('value', discriminantName)}) {
                  ${switchCases}
                  default:
                    throw new Error('unreachable tagged union encoder case');
                }
              })`,
            declarationAnnotations,
            declaration,
            typeName,
          );
          const companionName = `${typeName}Encoder`;
          return ctx.output.stmt(
            ctx.quote.stmt`
              export const ${companionName} = ${
              withNamedMetadataText(ctx, encoderText, typeName, {})
            };
            `,
          );
        }
        if (!declaration.type.asObjectLiteral()) {
          const typeName = declarationTypeName(declaration);
          const helperText = encodeHelperTextFromShape(
            ctx,
            ctx.reflect.typeShape(declaration.type),
            typeName,
            declaration,
            declaration,
            hostTypeNode(declaration.type),
          );
          if (helperText) {
            const encoderText = wrapEncodeDeclarationText(
              ctx,
              helperText,
              declarationAnnotations,
              declaration,
              typeName,
            );
            const companionName = `${typeName}Encoder`;
            return ctx.output.stmt(
              ctx.quote.stmt`
                export const ${companionName} = ${
                withNamedMetadataText(ctx, encoderText, typeName, {})
              };
              `,
            );
          }
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

      const projectionText = objectProjectionText(fields.map((field) => ({
        keyName: field.wireName,
        optional: field.optional,
        valueText: propertyAccessText('value', field.localName),
      })));
      const baseEncoderText = withEncodeObjectMetadataText(
        ctx,
        `${contramap}(
            ${object}(${shapeText}),
            (value: ${typeName}) => ${projectionText},
          )`,
        fields,
      );

      const encoderText = wrapEncodeDeclarationText(
        ctx,
        baseEncoderText,
        declarationAnnotations,
        decoded.args.target,
        typeName,
      );
      const companionName = `${typeName}Encoder`;
      const namedEncoderText = withNamedMetadataText(ctx, encoderText, typeName, {});
      const recursiveEncodedAliasName = `__sts_${typeName}EncodedForEncode`;
      const recursiveEncoderTypeAliasName = `__sts_${typeName}EncoderType`;
      const recursiveEncodedAliasText = isPlainStructuralRecursiveDeclaration(
          ctx,
          decoded.args.target,
          typeName,
          'encode',
        )
        ? recursiveEncodedObjectTypeAliasText(
          ctx,
          decoded.args.target,
          typeName,
          'encode',
          recursiveEncodedAliasName,
        )
        : null;
      if (recursiveEncodedAliasText) {
        const encodeMode = recursiveDeclarationEncodeMode(ctx, decoded.args.target, 'encode');
        const selfName = '__sts_self';
        const recursiveEncoderTypeAliasText = encodeMode === 'sync'
          ? `type ${recursiveEncoderTypeAliasName} = import('sts:encode').Encoder<${typeName}, ${recursiveEncodedAliasName}>;`
          : `type ${recursiveEncoderTypeAliasName} = import('sts:encode').Encoder<${typeName}, ${recursiveEncodedAliasName}, unknown, "async">;`;
        let recursiveEncoderText = rewriteRecursiveSelfReference(
          namedEncoderText,
          `(): import('sts:encode').Encoder<${typeName}, import('sts:json').JsonLikeValue> => ${companionName}`,
          `(): ${recursiveEncoderTypeAliasName} => ${selfName}`,
        );
        recursiveEncoderText = rewriteRecursiveLazyInvocation(
          recursiveEncoderText,
          recursiveEncoderTypeAliasName,
          selfName,
          encodeMode === 'sync'
            ? `${typeName}, ${recursiveEncodedAliasName}, import('sts:encode').EncodeFailure, "sync"`
            : `${typeName}, ${recursiveEncodedAliasName}, unknown, "async"`,
        );
        if (decoded.caseName !== 'class') {
          recursiveEncoderText = rewriteRecursiveSelfReference(
            recursiveEncoderText,
            `(value: ${typeName}) =>`,
            `(value: ${typeName}): ${typeName} =>`,
          );
        }
        return ctx.output.stmts(
          ctx.quote.stmts`
            type ${recursiveEncodedAliasName} = ${recursiveEncodedAliasText};
            ${recursiveEncoderTypeAliasText}
            export const ${companionName}: ${recursiveEncoderTypeAliasName} = (() => {
              let ${selfName}!: ${recursiveEncoderTypeAliasName};
              ${selfName} = ${recursiveEncoderText} as unknown as ${recursiveEncoderTypeAliasName};
              return ${selfName};
            })();
          `,
        );
      }
      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${companionName} = ${namedEncoderText};
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
      const declarationAnnotations = ctx.syntax.annotations(decoded.args.target);
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
          const unionText = wrapDecodeDeclarationText(
            ctx,
            foldUnionText(decodeUnion, variantDecoders),
            declarationAnnotations,
            declaration,
            typeName,
          );
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
          const encoderText = wrapEncodeDeclarationText(
            ctx,
            `${encodeFromEncode}((value: ${typeName}): import('sts:result').Result<import('sts:json').JsonLikeValue, import('sts:encode').EncodeFailure> | Promise<import('sts:result').Result<import('sts:json').JsonLikeValue, import('sts:encode').EncodeFailure>> => {
                  switch (${propertyAccessText('value', discriminantName)}) {
                    ${switchCases}
                    default:
                      throw new Error('unreachable tagged union codec case');
                  }
                })`,
            declarationAnnotations,
            declaration,
            typeName,
          );
          const companionName = `${typeName}Codec`;
          return ctx.output.stmt(
            ctx.quote.stmt`
              export const ${companionName} = ${
              withNamedMetadataText(
                ctx,
                `${createCodec}(
                  ${unionText},
                  ${encoderText},
                )`,
                typeName,
                {},
              )
            };
            `,
          );
        }
        if (!declaration.type.asObjectLiteral()) {
          const typeName = declarationTypeName(declaration);
          const helperTexts = codecHelperTextsFromShape(
            ctx,
            ctx.reflect.typeShape(declaration.type),
            typeName,
            declaration,
            declaration,
            hostTypeNode(declaration.type),
          );
          if (helperTexts) {
            const createCodec = ctx.runtime.named('sts:codec', 'codec').text();
            const decoderText = wrapDecodeDeclarationText(
              ctx,
              helperTexts.decodeText,
              declarationAnnotations,
              declaration,
              typeName,
            );
            const encoderText = wrapEncodeDeclarationText(
              ctx,
              helperTexts.encodeText,
              declarationAnnotations,
              declaration,
              typeName,
            );
            const companionName = `${typeName}Codec`;
            return ctx.output.stmt(
              ctx.quote.stmt`
                export const ${companionName} = ${
                withNamedMetadataText(
                  ctx,
                  `${createCodec}(
                    ${decoderText},
                    ${encoderText},
                  )`,
                  typeName,
                  {},
                )
              };
              `,
            );
          }
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
      const objectPolicyText = decodeUnknownKeysPolicyText(
        ctx,
        declarationAnnotations,
        decoded.args.target,
      );
      const decodeShapeText = fields.length === 0 ? '{}' : `{
            ${
        fields.map((field) =>
          `${propertyKeyText(field.wireName)}: ${
            field.decodeOptional ? `${decodeOptional}(${field.decodeText})` : field.decodeText
          }`
        ).join(',\n')
      }
          }`;

      const decodeProjectionText = objectProjectionText(fields.map((field) => ({
        keyName: field.localName,
        optional: field.decodeOptional,
        valueText: decodeDefaultProjectionText(
          propertyAccessText('value', field.wireName),
          field.decodeDefaultText,
        ),
      })));
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

      const encodeProjectionText = objectProjectionText(fields.map((field) => ({
        keyName: field.wireName,
        optional: field.optional,
        valueText: propertyAccessText('value', field.localName),
      })));
      const decodeObjectCallText = `${decodeObject}(${decodeShapeText}${
        objectPolicyText ? `, { unknownKeys: ${objectPolicyText} }` : ''
      })`;
      const encodeObjectCallText = `${encodeObject}(${encodeShapeText}${
        objectPolicyText ? `, { unknownKeys: ${objectPolicyText} }` : ''
      })`;
      const baseDecoderText = withDecodeObjectMetadataText(
        ctx,
        `${decodeMap}(
              ${decodeObjectCallText},
              (value) => ${finalDecodeProjectionText},
            )`,
        fields,
        decoded.caseName === 'class'
          ? {
            factoryEffectText: classFactoryMetadataEffectText(
              ctx,
              decoded.args.target as MacroClassDeclSyntax,
              'codec',
              typeName,
            ),
          }
          : {},
      );
      const baseEncoderText = withEncodeObjectMetadataText(
        ctx,
        `${encodeContramap}(
              ${encodeObjectCallText},
              (value: ${typeName}) => ${encodeProjectionText},
            )`,
        fields,
      );

      const decoderText = wrapDecodeDeclarationText(
        ctx,
        baseDecoderText,
        declarationAnnotations,
        decoded.args.target,
        typeName,
      );
      const encoderText = wrapEncodeDeclarationText(
        ctx,
        baseEncoderText,
        declarationAnnotations,
        decoded.args.target,
        typeName,
      );
      const companionName = `${typeName}Codec`;
      const namedCodecText = withNamedMetadataText(
        ctx,
        `${codec}(
            ${decoderText},
            ${encoderText},
          )`,
        typeName,
        {},
      );
      const recursiveEncodedAliasName = `__sts_${typeName}EncodedForCodec`;
      const recursiveCodecTypeAliasName = `__sts_${typeName}CodecType`;
      const recursiveEncodedAliasText = isPlainStructuralRecursiveDeclaration(
          ctx,
          decoded.args.target,
          typeName,
          'codec',
        )
        ? recursiveEncodedObjectTypeAliasText(
          ctx,
          decoded.args.target,
          typeName,
          'codec',
          recursiveEncodedAliasName,
        )
        : null;
      if (recursiveEncodedAliasText) {
        const decodeMode = recursiveDeclarationDecodeMode(ctx, decoded.args.target, 'codec');
        const encodeMode = recursiveDeclarationEncodeMode(ctx, decoded.args.target, 'codec');
        const selfName = '__sts_self';
        const recursiveCodecDecodeCallbackTypeText = decodeMode === 'sync'
          ? `import('sts:decode').Decoder<${typeName}>`
          : `import('sts:decode').Decoder<${typeName}, unknown, "async">`;
        const recursiveCodecEncodeCallbackTypeText = encodeMode === 'sync'
          ? `import('sts:encode').Encoder<${typeName}, import('sts:json').JsonLikeValue>`
          : `import('sts:encode').Encoder<${typeName}, import('sts:json').JsonLikeValue, unknown, "async">`;
        const recursiveCodecDecodeErrorTypeText = decodeMode === 'sync'
          ? `import('sts:decode').DecodeFailure`
          : 'unknown';
        const recursiveCodecEncodeErrorTypeText = encodeMode === 'sync'
          ? `import('sts:encode').EncodeFailure`
          : 'unknown';
        const recursiveCodecTypeAliasText = decodeMode === 'sync' && encodeMode === 'sync'
          ? `type ${recursiveCodecTypeAliasName} = import('sts:codec').Codec<${typeName}, ${recursiveEncodedAliasName}>;`
          : `type ${recursiveCodecTypeAliasName} = import('sts:codec').Codec<${typeName}, ${recursiveEncodedAliasName}, ${recursiveCodecDecodeErrorTypeText}, ${recursiveCodecEncodeErrorTypeText}, "${decodeMode}", "${encodeMode}">;`;
        const recursiveCodecText = rewriteRecursiveSelfReference(
          namedCodecText,
          `(): import('sts:decode').Decoder<${typeName}> => ${companionName}`,
          `(): ${recursiveCodecDecodeCallbackTypeText} => ${selfName}`,
        );
        let recursiveCodecTextWithEncode = rewriteRecursiveSelfReference(
          recursiveCodecText,
          `(): import('sts:encode').Encoder<${typeName}, import('sts:json').JsonLikeValue> => ${companionName}`,
          `(): ${recursiveCodecEncodeCallbackTypeText} => ${selfName}`,
        );
        recursiveCodecTextWithEncode = rewriteRecursiveLazyInvocation(
          recursiveCodecTextWithEncode,
          recursiveCodecDecodeCallbackTypeText,
          selfName,
          decodeMode === 'sync'
            ? `${typeName}, import('sts:decode').DecodeFailure, "sync"`
            : `${typeName}, unknown, "async"`,
        );
        recursiveCodecTextWithEncode = rewriteRecursiveLazyInvocation(
          recursiveCodecTextWithEncode,
          recursiveCodecEncodeCallbackTypeText,
          selfName,
          encodeMode === 'sync'
            ? `${typeName}, import('sts:json').JsonLikeValue, import('sts:encode').EncodeFailure, "sync"`
            : `${typeName}, import('sts:json').JsonLikeValue, unknown, "async"`,
        );
        recursiveCodecTextWithEncode = rewriteRecursiveLazyInvocation(
          recursiveCodecTextWithEncode,
          `import('sts:decode').Decoder<${typeName}>`,
          `${typeName}Decoder`,
          decodeMode === 'sync'
            ? `${typeName}, import('sts:decode').DecodeFailure, "sync"`
            : `${typeName}, unknown, "async"`,
        );
        recursiveCodecTextWithEncode = rewriteRecursiveLazyInvocation(
          recursiveCodecTextWithEncode,
          `import('sts:encode').Encoder<${typeName}, import('sts:json').JsonLikeValue>`,
          `${typeName}Encoder`,
          encodeMode === 'sync'
            ? `${typeName}, import('sts:json').JsonLikeValue, import('sts:encode').EncodeFailure, "sync"`
            : `${typeName}, import('sts:json').JsonLikeValue, unknown, "async"`,
        );
        return ctx.output.stmts(
          ctx.quote.stmts`
            type ${recursiveEncodedAliasName} = ${recursiveEncodedAliasText};
            ${recursiveCodecTypeAliasText}
            export const ${companionName}: ${recursiveCodecTypeAliasName} = (() => {
              let ${selfName}!: ${recursiveCodecTypeAliasName};
              ${selfName} = ${recursiveCodecTextWithEncode} as unknown as ${recursiveCodecTypeAliasName};
              return ${selfName};
            })();
          `,
        );
      }
      return ctx.output.stmt(
        ctx.quote.stmt`
          export const ${companionName} = ${namedCodecText};
        `,
      );
    },
    signature: DECODE_SIGNATURE,
  };
}
attachDeriveFactory(codec);
