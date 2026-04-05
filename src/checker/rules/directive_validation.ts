import ts from 'typescript';

import { BUILTIN_DIRECTIVE_NAMES, type AnnotationLookup } from '../../annotation_syntax.ts';
import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type {
  AnalysisContext,
  ParsedAnnotation,
  ParsedAnnotationBlock,
  ParsedTypeScriptPragma,
} from '../engine/types.ts';
import type { SoundDiagnostic } from '../diagnostics.ts';

import { isInteropTargetNode } from './trust.ts';

function createDiagnostic(
  filePath: string,
  line: number,
  column: number,
  code:
    | typeof SOUND_DIAGNOSTIC_CODES.annotationArgumentsNotSupported
    | typeof SOUND_DIAGNOSTIC_CODES.bannedTypeScriptPragma
    | typeof SOUND_DIAGNOSTIC_CODES.duplicateAnnotation
    | typeof SOUND_DIAGNOSTIC_CODES.invalidAnnotationTarget
    | typeof SOUND_DIAGNOSTIC_CODES.malformedAnnotation
    | typeof SOUND_DIAGNOSTIC_CODES.unknownAnnotation,
  message: string,
  options?: {
    hint?: string;
    metadata?: SoundDiagnostic['metadata'];
    notes?: string[];
  },
): SoundDiagnostic {
  return {
    source: 'sound',
    code,
    category: 'error',
    message,
    metadata: options?.metadata,
    notes: options?.notes,
    hint: options?.hint,
    filePath,
    line,
    column,
  };
}

function isUnsafeTargetNode(targetNode: ts.Node): boolean {
  return !ts.isImportClause(targetNode) &&
    !ts.isImportDeclaration(targetNode) &&
    !ts.isImportEqualsDeclaration(targetNode);
}

function hasDeclareModifier(targetNode: ts.Node): boolean {
  return ts.canHaveModifiers(targetNode) &&
    ts.getModifiers(targetNode)?.some((modifier) =>
        modifier.kind === ts.SyntaxKind.DeclareKeyword
      ) === true;
}

function normalizeFileName(fileName: string): string {
  return fileName.replaceAll('\\', '/').toLowerCase();
}

function isStandardLibraryExternProofSourceFile(sourceFile: ts.SourceFile): boolean {
  const normalizedFileName = normalizeFileName(sourceFile.fileName);
  const baseName = normalizedFileName.split('/').at(-1) ?? normalizedFileName;
  return normalizedFileName.includes('/src/bundled/sound-libs/') ||
    (baseName.startsWith('lib.') &&
      (baseName.endsWith('.d.ts') || baseName.endsWith('.d.mts') || baseName.endsWith('.d.cts')));
}

function resolveReferencedTypeSymbol(
  context: AnalysisContext,
  typeNode:
    | ts.ExpressionWithTypeArguments
    | ts.ImportTypeNode
    | ts.TypeQueryNode
    | ts.TypeReferenceNode,
): ts.Symbol | undefined {
  const symbol = ts.isImportTypeNode(typeNode)
    ? typeNode.qualifier
      ? context.checker.getSymbolAtLocation(typeNode.qualifier)
      : undefined
    : ts.isTypeReferenceNode(typeNode)
    ? context.checker.getSymbolAtLocation(typeNode.typeName)
    : ts.isTypeQueryNode(typeNode)
    ? context.checker.getSymbolAtLocation(typeNode.exprName)
    : context.checker.getSymbolAtLocation(typeNode.expression);
  if (!symbol) {
    return undefined;
  }

  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? context.checker.getAliasedSymbol(symbol) : symbol;
}

function signatureCarriesProofOracle(
  context: AnalysisContext,
  declaration: ts.SignatureDeclaration,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const signature = context.checker.getSignatureFromDeclaration(declaration);
  return (signature !== undefined &&
      context.checker.getTypePredicateOfSignature(signature) !== undefined) ||
    (!!declaration.type &&
      typeNodeCarriesProofOracle(context, declaration.type, seenSymbols));
}

function symbolCarriesProofOracle(
  context: AnalysisContext,
  symbol: ts.Symbol,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  if (seenSymbols.has(symbol)) {
    return false;
  }
  seenSymbols.add(symbol);

  for (const declaration of symbol.getDeclarations() ?? []) {
    if (isStandardLibraryExternProofSourceFile(declaration.getSourceFile())) {
      continue;
    }

    if (ts.isTypeAliasDeclaration(declaration) &&
      typeNodeCarriesProofOracle(context, declaration.type, seenSymbols)) {
      return true;
    }

    if ((ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) &&
      declarationMembersCarryProofOracle(context, declaration.members, seenSymbols)) {
      return true;
    }

    if ((ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) &&
      declaration.heritageClauses?.some((clause) =>
        clause.types.some((type) => {
          const symbol = resolveReferencedTypeSymbol(context, type);
          return !!symbol && symbolCarriesProofOracle(context, symbol, seenSymbols);
        })
      )) {
      return true;
    }
  }

  return false;
}

function declarationMembersCarryProofOracle(
  context: AnalysisContext,
  members: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  return members.some((member) => {
    if (
      (ts.isMethodSignature(member) || ts.isMethodDeclaration(member) ||
        ts.isCallSignatureDeclaration(member) ||
        ts.isConstructSignatureDeclaration(member)) &&
      signatureCarriesProofOracle(context, member, seenSymbols)
    ) {
      return true;
    }

    if (
      (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member) ||
        ts.isIndexSignatureDeclaration(member) ||
        ts.isGetAccessorDeclaration(member)) &&
      member.type &&
      typeNodeCarriesProofOracle(context, member.type, seenSymbols)
    ) {
      return true;
    }

    return false;
  });
}

function typeNodeCarriesProofOracle(
  context: AnalysisContext,
  typeNode: ts.TypeNode,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  if (ts.isTypePredicateNode(typeNode)) {
    return true;
  }

  if (ts.isParenthesizedTypeNode(typeNode) || ts.isTypeOperatorNode(typeNode)) {
    return typeNodeCarriesProofOracle(context, typeNode.type, seenSymbols);
  }

  if (ts.isArrayTypeNode(typeNode)) {
    return typeNodeCarriesProofOracle(context, typeNode.elementType, seenSymbols);
  }

  if (ts.isTupleTypeNode(typeNode)) {
    return typeNode.elements.some((element) =>
      typeNodeCarriesProofOracle(
        context,
        ts.isNamedTupleMember(element) ? element.type : element,
        seenSymbols,
      )
    );
  }

  if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some((part) => typeNodeCarriesProofOracle(context, part, seenSymbols));
  }

  if (ts.isConditionalTypeNode(typeNode)) {
    return typeNodeCarriesProofOracle(context, typeNode.checkType, seenSymbols) ||
      typeNodeCarriesProofOracle(context, typeNode.extendsType, seenSymbols) ||
      typeNodeCarriesProofOracle(context, typeNode.trueType, seenSymbols) ||
      typeNodeCarriesProofOracle(context, typeNode.falseType, seenSymbols);
  }

  if (ts.isIndexedAccessTypeNode(typeNode)) {
    return typeNodeCarriesProofOracle(context, typeNode.objectType, seenSymbols) ||
      typeNodeCarriesProofOracle(context, typeNode.indexType, seenSymbols);
  }

  if (ts.isMappedTypeNode(typeNode)) {
    return !!typeNode.type && typeNodeCarriesProofOracle(context, typeNode.type, seenSymbols);
  }

  if (
    ts.isFunctionTypeNode(typeNode) || ts.isConstructorTypeNode(typeNode)
  ) {
    return signatureCarriesProofOracle(context, typeNode, seenSymbols);
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    return declarationMembersCarryProofOracle(context, typeNode.members, seenSymbols);
  }

  if (
    ts.isTypeReferenceNode(typeNode) || ts.isImportTypeNode(typeNode) || ts.isTypeQueryNode(typeNode)
  ) {
    const symbol = resolveReferencedTypeSymbol(context, typeNode);
    return !!symbol && symbolCarriesProofOracle(context, symbol, seenSymbols);
  }

  return false;
}

function variableStatementCarriesProofOracle(
  context: AnalysisContext,
  targetNode: ts.VariableStatement,
): boolean {
  return targetNode.declarationList.declarations.some((declaration) => {
    if (!ts.isIdentifier(declaration.name)) {
      return true;
    }

    return !!declaration.type &&
      typeNodeCarriesProofOracle(context, declaration.type, new Set<ts.Symbol>());
  });
}

function classDeclarationCarriesProofOracle(
  context: AnalysisContext,
  targetNode: ts.ClassDeclaration,
): boolean {
  return declarationMembersCarryProofOracle(context, targetNode.members, new Set<ts.Symbol>()) ||
    targetNode.heritageClauses?.some((clause) =>
      clause.types.some((type) => {
        const symbol = resolveReferencedTypeSymbol(context, type);
        return !!symbol && symbolCarriesProofOracle(context, symbol, new Set<ts.Symbol>());
      })
    ) === true;
}

function isExternTargetNode(
  context: AnalysisContext,
  targetNode: ts.Node,
): boolean {
  if (!hasDeclareModifier(targetNode)) {
    return false;
  }

  if (ts.isVariableStatement(targetNode)) {
    return !variableStatementCarriesProofOracle(context, targetNode);
  }

  if (ts.isFunctionDeclaration(targetNode)) {
    return !signatureCarriesProofOracle(context, targetNode, new Set<ts.Symbol>());
  }

  if (ts.isClassDeclaration(targetNode)) {
    return !classDeclarationCarriesProofOracle(context, targetNode);
  }

  return false;
}

function isVarianceTargetNode(targetNode: ts.Node): boolean {
  return (
    ts.isInterfaceDeclaration(targetNode) ||
    ts.isTypeAliasDeclaration(targetNode)
  ) && (targetNode.typeParameters?.length ?? 0) > 0;
}

function isValueTargetNode(targetNode: ts.Node): targetNode is ts.ClassDeclaration {
  return ts.isClassDeclaration(targetNode);
}

function isNewtypeTargetNode(targetNode: ts.Node): targetNode is ts.TypeAliasDeclaration {
  return ts.isTypeAliasDeclaration(targetNode);
}

function isUnionBackedNewtypeTarget(
  context: AnalysisContext,
  targetNode: ts.TypeAliasDeclaration,
): boolean {
  const representationType = context.checker.getTypeFromTypeNode(targetNode.type);
  return (representationType.flags & ts.TypeFlags.Union) !== 0;
}

function isKnownAnnotation(annotationName: string): boolean {
  return annotationName === 'extern' ||
    annotationName === 'interop' ||
    annotationName === 'newtype' ||
    annotationName === 'unsafe' ||
    annotationName === 'value' ||
    annotationName === 'variance';
}

function splitMacroOwnedAnnotationName(annotationName: string): { owner: string } | null {
  const dotIndex = annotationName.indexOf('.');
  if (dotIndex <= 0) {
    return null;
  }

  const owner = annotationName.slice(0, dotIndex);
  return BUILTIN_DIRECTIVE_NAMES.has(owner)
    ? null
    : {
      owner,
    };
}

function createUnknownAnnotationMessage(annotation: ParsedAnnotation): string {
  return `${SOUND_DIAGNOSTIC_MESSAGES.unknownAnnotation} \`#[${annotation.name}]\` is not registered.`;
}

function getRegisteredBuiltinAnnotationsText(): string {
  return 'extern, interop, newtype, unsafe, value, variance';
}

function createMalformedAnnotationDiagnostic(
  filePath: string,
  line: number,
  annotationText: string,
  parseError: string,
): SoundDiagnostic {
  const example =
    'Rewrite the comment as a complete annotation such as `// #[unsafe]`, or remove it if no directive is intended.';

  return createDiagnostic(
    filePath,
    line,
    1,
    SOUND_DIAGNOSTIC_CODES.malformedAnnotation,
    `${SOUND_DIAGNOSTIC_MESSAGES.malformedAnnotation} ${parseError}`,
    {
      metadata: {
        rule: 'malformed_annotation_comment',
        primarySymbol: annotationText,
        fixability: 'local_rewrite',
        invariant:
          'Only well-formed `// #[...]` comments participate in checked soundscript annotation semantics.',
        replacementFamily: 'well_formed_annotation_comment',
        evidence: [
          { label: 'annotationText', value: annotationText },
          { label: 'parseError', value: parseError },
        ],
        counterexample:
          'A malformed annotation comment looks like a checked directive, but it attaches to nothing and leaves the following code ordinary checked code.',
        example,
      },
      notes: [
        `\`${annotationText}\` did not parse as a complete soundscript annotation comment, so it does not attach to the following code.`,
        `Parser detail: ${parseError}`,
        `Example: ${example}`,
      ],
      hint:
        'Rewrite the malformed comment as a complete `// #[...]` annotation, or remove it.',
    },
  );
}

function createUnknownAnnotationDiagnostic(
  filePath: string,
  line: number,
  annotation: ParsedAnnotation,
): SoundDiagnostic {
  const label = `#[${annotation.name}]`;
  const registeredBuiltins = getRegisteredBuiltinAnnotationsText();
  const example =
    `Replace \`${label}\` with a registered builtin annotation such as \`#[extern]\`, or remove it until that directive exists.`;

  return createDiagnostic(
    filePath,
    line,
    1,
    SOUND_DIAGNOSTIC_CODES.unknownAnnotation,
    createUnknownAnnotationMessage(annotation),
    {
      metadata: {
        rule: 'unknown_annotation',
        primarySymbol: label,
        fixability: 'local_rewrite',
        invariant:
          'Only registered soundscript annotations carry builtin checked semantics in annotation position.',
        replacementFamily: 'registered_annotation_name',
        evidence: [
          { label: 'annotationName', value: annotation.name },
          { label: 'registeredBuiltins', value: registeredBuiltins },
        ],
        counterexample:
          'An unknown annotation can look like a checked contract even though soundscript gives it no semantics.',
        example,
      },
      notes: [
        `\`${label}\` is not a registered builtin soundscript annotation.`,
        'Registered builtin annotations in v1 are `#[extern]`, `#[interop]`, `#[newtype]`, `#[unsafe]`, `#[value]`, and `#[variance(...)]`.',
        `Example: ${example}`,
      ],
      hint:
        'Rename the annotation to a registered builtin, or remove it until that directive exists.',
    },
  );
}

function createDuplicateAnnotationDiagnostic(
  filePath: string,
  line: number,
  annotationName: string,
  occurrenceCount: number,
): SoundDiagnostic {
  const label = `#[${annotationName}]`;
  const example = `Keep one \`${label}\` entry in the block and remove the duplicate.`;

  return createDiagnostic(
    filePath,
    line,
    1,
    SOUND_DIAGNOSTIC_CODES.duplicateAnnotation,
    `${SOUND_DIAGNOSTIC_MESSAGES.duplicateAnnotation} \`${label}\` appears more than once in the same block.`,
    {
      metadata: {
        rule: 'duplicate_annotation',
        primarySymbol: label,
        fixability: 'local_rewrite',
        invariant:
          'Each attached annotation block may mention a given annotation name at most once.',
        replacementFamily: 'single_annotation_per_block',
        evidence: [
          { label: 'annotationName', value: annotationName },
          { label: 'occurrenceCount', value: String(occurrenceCount) },
        ],
        counterexample:
          'Duplicate entries make it ambiguous which single checked contract should govern the attached declaration.',
        example,
      },
      notes: [
        `\`${label}\` appears ${occurrenceCount} times in the same attached annotation block.`,
        `Example: ${example}`,
      ],
      hint:
        'Keep a single annotation entry for each name in the attached block.',
    },
  );
}

function createUnexpectedArgumentsMessage(annotation: ParsedAnnotation): string {
  if (annotation.name === 'value') {
    return `${SOUND_DIAGNOSTIC_MESSAGES.annotationArgumentsNotSupported} \`#[value]\` only supports the bare form or \`#[value(deep: true)]\`.`;
  }
  return `${SOUND_DIAGNOSTIC_MESSAGES.annotationArgumentsNotSupported} Remove the arguments from \`#[${annotation.text}]\`.`;
}

function describeSupportedAnnotationArguments(annotationName: string): string {
  return annotationName === 'value'
    ? 'bare form or `#[value(deep: true)]`'
    : 'bare form only';
}

function createAnnotationArgumentsNotSupportedDiagnostic(
  filePath: string,
  line: number,
  annotation: ParsedAnnotation,
): SoundDiagnostic {
  const label = `#[${annotation.name}]`;
  const argumentsText = annotation.argumentsText !== undefined ? `(${annotation.argumentsText})` : '()';
  const supportedForm = describeSupportedAnnotationArguments(annotation.name);
  const example = annotation.name === 'value'
    ? 'Use bare `#[value]` or `#[value(deep: true)]`.'
    : `Remove the arguments from \`#[${annotation.text}]\`.`;

  return createDiagnostic(
    filePath,
    line,
    1,
    SOUND_DIAGNOSTIC_CODES.annotationArgumentsNotSupported,
    createUnexpectedArgumentsMessage(annotation),
    {
      metadata: {
        rule: 'annotation_arguments_not_supported',
        primarySymbol: label,
        fixability: 'local_rewrite',
        invariant:
          'Builtin annotations only accept the argument forms that the language version defines explicitly.',
        replacementFamily: 'supported_annotation_arguments',
        evidence: [
          { label: 'annotationName', value: annotation.name },
          { label: 'argumentsText', value: argumentsText },
          { label: 'supportedForm', value: supportedForm },
        ],
        counterexample:
          'Unsupported annotation arguments can look like checked configuration even though v1 does not define any semantics for them.',
        example,
      },
      notes: [
        `\`${label}\` does not accept arguments in v1; this annotation uses \`${argumentsText}\`.`,
        `Example: ${example}`,
      ],
      hint:
        'Remove the unsupported annotation arguments, or rewrite the annotation to one of its supported forms.',
    },
  );
}

function createInvalidTargetMessage(annotation: ParsedAnnotation): string {
  if (annotation.name === 'interop') {
    return `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[interop]\` must attach to an import, \`require(...)\`, or \`import(...)\` boundary.`;
  }

  if (annotation.name === 'extern') {
    return `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[extern]\` must attach to a local ambient runtime declaration.`;
  }

  if (annotation.name === 'variance') {
    return `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[variance(...)]\` must attach to a generic interface or type alias declaration.`;
  }

  if (annotation.name === 'newtype') {
    return `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[newtype]\` must attach to a type alias declaration.`;
  }

  if (annotation.name === 'value') {
    return `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` must attach to a class declaration.`;
  }

  return `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[unsafe]\` must attach to a local proof-override declaration or statement.`;
}

function createBannedTypeScriptPragmaDiagnostic(
  filePath: string,
  pragma: ParsedTypeScriptPragma,
): SoundDiagnostic {
  const example =
    `Remove \`${pragma.text}\` and express the invariant with checked code, a validated boundary, or a real type fix.`;

  return createDiagnostic(
    filePath,
    pragma.line,
    1,
    SOUND_DIAGNOSTIC_CODES.bannedTypeScriptPragma,
    `${SOUND_DIAGNOSTIC_MESSAGES.bannedTypeScriptPragma} Remove \`${pragma.text}\` and express the invariant in checked code instead.`,
    {
      metadata: {
        rule: 'typescript_pragma_banned',
        primarySymbol: pragma.text,
        fixability: 'local_rewrite',
        invariant:
          'soundscript diagnostics must not depend on TypeScript suppression comments that hide upstream evidence.',
        replacementFamily: 'checked_code_without_suppression',
        evidence: [
          { label: 'pragmaText', value: pragma.text },
        ],
        counterexample:
          'TypeScript pragmas suppress upstream evidence and make soundscript checking depend on hidden unchecked assumptions.',
        example,
      },
      notes: [
        `\`${pragma.text}\` suppresses upstream diagnostics instead of expressing a checked soundscript boundary.`,
        `Example: ${example}`,
      ],
      hint: 'Delete the TypeScript pragma and make the code type-check without suppression.',
    },
  );
}

function isSupportedValueAnnotationArguments(annotation: ParsedAnnotation): boolean {
  const args = annotation.arguments ?? [];
  if (args.length === 0) {
    return true;
  }

  if (args.length !== 1) {
    return false;
  }

  const [arg] = args;
  return arg?.kind === 'named' &&
    arg.name === 'deep' &&
    arg.value.kind === 'boolean' &&
    arg.value.value === true;
}

function createInvalidNewtypeRepresentationMessage(): string {
  return `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[newtype]\` aliases must not resolve to a top-level union representation. Use the newtype at the leaves and compose unions at the use site instead.`;
}

function isSupportedMacroOwnedMemberTarget(targetNode: ts.Node): boolean {
  return ts.isPropertyDeclaration(targetNode) || ts.isPropertySignature(targetNode);
}

function findMacroOwnedAnnotationOwner(targetNode: ts.Node): ts.Node | undefined {
  if (!isSupportedMacroOwnedMemberTarget(targetNode)) {
    return targetNode;
  }

  let current: ts.Node | undefined = targetNode.parent;
  while (current) {
    if (
      ts.isClassDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isTypeAliasDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }

  return undefined;
}

function createInvalidMacroOwnedAnnotationTargetMessage(annotationName: string, ownerName: string): string {
  return `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[${annotationName}]\` must attach to a declaration annotated with \`#[${ownerName}]\` or to a supported member inside one.`;
}

function describeExpectedAnnotationTarget(annotationName: string, ownerName?: string): string {
  if (ownerName) {
    return `declaration annotated with #[${ownerName}] or supported member inside one`;
  }

  if (annotationName === 'interop') {
    return 'import, require(...), or import(...) boundary';
  }

  if (annotationName === 'extern') {
    return 'local ambient runtime declaration';
  }

  if (annotationName === 'variance') {
    return 'generic interface or type alias declaration';
  }

  if (annotationName === 'newtype') {
    return 'type alias declaration';
  }

  if (annotationName === 'value') {
    return 'class declaration';
  }

  return 'local proof-override declaration or statement';
}

function describeAnnotationTargetNode(targetNode: ts.Node | undefined): string {
  if (!targetNode) {
    return 'detached annotation block';
  }

  if (ts.isVariableStatement(targetNode) || ts.isVariableDeclaration(targetNode)) {
    return 'variable declaration';
  }

  if (ts.isImportDeclaration(targetNode) || ts.isImportClause(targetNode) ||
    ts.isImportEqualsDeclaration(targetNode)) {
    return 'import declaration';
  }

  if (ts.isFunctionDeclaration(targetNode)) {
    return 'function declaration';
  }

  if (ts.isClassDeclaration(targetNode)) {
    return 'class declaration';
  }

  if (ts.isInterfaceDeclaration(targetNode)) {
    return 'interface declaration';
  }

  if (ts.isTypeAliasDeclaration(targetNode)) {
    return 'type alias declaration';
  }

  if (ts.isMethodDeclaration(targetNode)) {
    return 'method declaration';
  }

  if (ts.isExpressionStatement(targetNode)) {
    return 'statement';
  }

  return ts.SyntaxKind[targetNode.kind].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function createInvalidAnnotationTargetDiagnostic(
  filePath: string,
  line: number,
  column: number,
  message: string,
  annotationName: string,
  targetNode: ts.Node | undefined,
  ownerName?: string,
): SoundDiagnostic {
  const expectedTarget = describeExpectedAnnotationTarget(annotationName, ownerName);
  const actualTarget = describeAnnotationTargetNode(targetNode);
  const label = `#[${annotationName}]`;
  const example = ownerName
    ? `Move \`${label}\` onto a declaration annotated with \`#[${ownerName}]\`, or remove it from this site.`
    : `Move \`${label}\` to a ${expectedTarget}, or remove it if this code is an ordinary implementation.`;

  return createDiagnostic(
    filePath,
    line,
    column,
    SOUND_DIAGNOSTIC_CODES.invalidAnnotationTarget,
    message,
    {
      metadata: {
        rule: 'invalid_annotation_target',
        primarySymbol: label,
        fixability: 'local_rewrite',
        invariant:
          'Each builtin annotation only has meaning on the specific syntax sites that define its checked semantics.',
        replacementFamily: 'supported_annotation_site',
        evidence: [
          { label: 'annotationName', value: annotationName },
          { label: 'expectedTarget', value: expectedTarget },
          { label: 'actualTarget', value: actualTarget },
        ],
        counterexample:
          'An annotation attached to the wrong syntax node can look like it blesses code even though that site does not support the annotation’s semantics.',
        example,
      },
      notes: [
        `\`${label}\` must attach to a ${expectedTarget}, but this annotation is attached to a ${actualTarget}.`,
        `Example: ${example}`,
      ],
      hint:
        'Move the annotation to a supported target, or remove it if this site should stay ordinary checked code.',
    },
  );
}

function validateAnnotationBlock(
  context: AnalysisContext,
  diagnostics: SoundDiagnostic[],
  filePath: string,
  annotationLookup: AnnotationLookup,
  block: ParsedAnnotationBlock,
): void {
  const seenAnnotations = new Set<string>();
  for (const annotation of block.annotations) {
    if (seenAnnotations.has(annotation.name)) {
      diagnostics.push(
        createDuplicateAnnotationDiagnostic(
          filePath,
          block.startLine,
          annotation.name,
          block.annotations.filter((candidate) => candidate.name === annotation.name).length,
        ),
      );
      continue;
    }
    seenAnnotations.add(annotation.name);

    const macroOwned = splitMacroOwnedAnnotationName(annotation.name);
    if (macroOwned) {
      if (!block.targetNode) {
        diagnostics.push(
          createInvalidAnnotationTargetDiagnostic(
            filePath,
            block.startLine,
            1,
            createInvalidMacroOwnedAnnotationTargetMessage(annotation.name, macroOwned.owner),
            annotation.name,
            undefined,
            macroOwned.owner,
          ),
        );
        continue;
      }

      const ownerNode = findMacroOwnedAnnotationOwner(block.targetNode);
      if (!ownerNode || !annotationLookup.hasAttachedAnnotation(ownerNode, macroOwned.owner)) {
        diagnostics.push(
          createInvalidAnnotationTargetDiagnostic(
            filePath,
            block.startLine,
            1,
            createInvalidMacroOwnedAnnotationTargetMessage(annotation.name, macroOwned.owner),
            annotation.name,
            block.targetNode,
            macroOwned.owner,
          ),
        );
      }
      continue;
    }

    if (!isKnownAnnotation(annotation.name)) {
      diagnostics.push(
        createUnknownAnnotationDiagnostic(
          filePath,
          block.startLine,
          annotation,
        ),
      );
      continue;
    }

    if (
      annotation.argumentsText !== undefined &&
      annotation.name !== 'variance' &&
      !(annotation.name === 'value' && isSupportedValueAnnotationArguments(annotation))
    ) {
      diagnostics.push(
        createAnnotationArgumentsNotSupportedDiagnostic(
          filePath,
          block.startLine,
          annotation,
        ),
      );
      continue;
    }

    if (!block.targetNode) {
      diagnostics.push(
        createInvalidAnnotationTargetDiagnostic(
          filePath,
          block.startLine,
          1,
          createInvalidTargetMessage(annotation),
          annotation.name,
          undefined,
        ),
      );
      continue;
    }

    const isValidTarget = annotation.name === 'interop'
      ? isInteropTargetNode(block.targetNode)
      : annotation.name === 'extern'
      ? isExternTargetNode(context, block.targetNode)
      : annotation.name === 'variance'
      ? isVarianceTargetNode(block.targetNode)
      : annotation.name === 'value'
      ? isValueTargetNode(block.targetNode)
      : annotation.name === 'newtype'
      ? isNewtypeTargetNode(block.targetNode)
      : isUnsafeTargetNode(block.targetNode);
    if (!isValidTarget) {
      diagnostics.push(
        createInvalidAnnotationTargetDiagnostic(
          filePath,
          block.startLine,
          1,
          createInvalidTargetMessage(annotation),
          annotation.name,
          block.targetNode,
        ),
      );
      continue;
    }

    if (
      annotation.name === 'newtype' &&
      isNewtypeTargetNode(block.targetNode) &&
      isUnionBackedNewtypeTarget(context, block.targetNode)
    ) {
      diagnostics.push(
        createDiagnostic(
          filePath,
          block.startLine,
          1,
          SOUND_DIAGNOSTIC_CODES.invalidAnnotationTarget,
          createInvalidNewtypeRepresentationMessage(),
        ),
      );
    }
  }
}

export function runAnnotationValidationRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    const annotationLookup = context.getAnnotationLookup(sourceFile);
    for (const entry of annotationLookup.getEntries()) {
      switch (entry.kind) {
        case 'annotation':
          break;
        case 'annotation-parse-error':
          diagnostics.push(
            createMalformedAnnotationDiagnostic(
              sourceFile.fileName,
              entry.line,
              entry.text,
              entry.message,
            ),
          );
          break;
        case 'banned-ts-pragma':
          diagnostics.push(
            createBannedTypeScriptPragmaDiagnostic(
              sourceFile.fileName,
              entry,
            ),
          );
          break;
        default: {
          const exhaustiveCheck: never = entry;
          return exhaustiveCheck;
        }
      }
    }

    for (const block of annotationLookup.getBlocks()) {
      validateAnnotationBlock(context, diagnostics, sourceFile.fileName, annotationLookup, block);
    }
  });

  return diagnostics;
}
