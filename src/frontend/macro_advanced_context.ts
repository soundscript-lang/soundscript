import ts from 'typescript';

import { createAnnotationLookup } from '../annotation_syntax.ts';
import { createMacroContext } from './macro_context.ts';
import type {
  BlockSyntax,
  DeclSyntax,
  ExprSyntax,
  MacroAnnotation,
  MacroClassDeclSyntax,
  MacroClassFieldSyntax,
  MacroContext,
  MacroHostAccess,
  MacroInterfaceDeclSyntax,
  MacroObjectTypeMemberSyntax,
  MacroObjectTypeSyntax,
  MacroParameterSyntax,
  MacroPlacement,
  MacroReflectedDeclarationShape,
  MacroReflectedDiscriminant,
  MacroReflectedDiscriminatedUnionVariant,
  MacroReflectedFieldShape,
  MacroSerializableDeclarationShape,
  MacroSerializableDiscriminatedUnionVariant,
  MacroSerializableFieldShape,
  MacroSerializableTypeShape,
  MacroReflectedTypeShape,
  MacroSyntaxNode,
  MacroTypeAliasDeclSyntax,
  MacroUnionTypeSyntax,
  StmtSyntax,
  TypeSyntax,
} from './macro_api.ts';
import type { NestedMacroRegistries } from './macro_advanced_backend_adapter.ts';
import { createMacroError } from './macro_errors.ts';
import {
  resolveExprArgumentOperand,
  resolvePrimaryExprOperand,
} from './macro_operand_semantics.ts';
import { createMacroSemantics } from './macro_semantics.ts';
import { attachSemanticLookupNodeResolver } from './macro_context_internal.ts';
import type { ResolvedMacroPlaceholder } from './macro_resolver.ts';
import { createMacroScopeExitOutput, createMacroValueRewriteOutput } from './macro_output.ts';
import { scanMacroCandidates } from './macro_scanner.ts';
import {
  createDeclSyntaxFromNode,
  createExprSyntaxFromNode,
  createStmtListSyntaxFromCode,
  getHostBlock,
  getHostExpression,
  getHostNode,
  getHostStatement,
} from './macro_syntax_internal.ts';
import { synthesizeHostNode } from './macro_host_ast_internal.ts';
import type { PreparedProgram } from './project_frontend.ts';
import type { MacroRuntimeImportResolver } from './macro_runtime_support.ts';

function sanitizeBindingHint(hint: string): string {
  const sanitized = hint.replace(/[^A-Za-z0-9_$]/g, '_');
  return sanitized.length > 0 ? sanitized : '__sts_macro_tmp';
}

function classifyPlacement(
  resolved: ResolvedMacroPlaceholder,
): MacroPlacement {
  const callExpression = resolved.callExpression;
  let current: ts.Node = callExpression;
  let parent: ts.Node | undefined = callExpression.parent;

  while (parent && !ts.isStatement(parent) && !ts.isSourceFile(parent)) {
    if (
      ts.isFunctionLike(parent) &&
      parent.kind !== ts.SyntaxKind.Constructor &&
      !(ts.isArrowFunction(parent) && parent.body === current && !ts.isBlock(parent.body))
    ) {
      return { kind: 'unsupported', reason: 'unsupported-site' };
    }

    if (ts.isVariableDeclarationList(parent) && parent.declarations.length !== 1) {
      return { kind: 'unsupported', reason: 'multi-declaration' };
    }

    if (
      ts.isCallExpression(parent) &&
      parent.arguments.some((argument) => argument === current)
    ) {
      const isOptionalCall = !!parent.questionDotToken ||
        (ts.isPropertyAccessExpression(parent.expression) &&
          !!parent.expression.questionDotToken) ||
        (ts.isElementAccessExpression(parent.expression) && !!parent.expression.questionDotToken);
      if (isOptionalCall) {
        current = parent;
        parent = parent.parent;
        continue;
      }
    }

    if (
      ts.isElementAccessExpression(parent) &&
      parent.questionDotToken &&
      parent.argumentExpression === current
    ) {
      current = parent;
      parent = parent.parent;
      continue;
    }

    if ('questionDotToken' in parent && parent.questionDotToken) {
      if ('expression' in parent && parent.expression === current) {
        current = parent;
        parent = parent.parent;
        continue;
      }
      return { kind: 'unsupported', reason: 'unsupported-site' };
    }

    current = parent;
    parent = parent.parent;
  }

  if (!parent || ts.isSourceFile(parent)) {
    return { kind: 'unsupported', reason: 'unsupported-site' };
  }

  if (ts.isVariableStatement(parent)) {
    const declarationList = parent.declarationList;
    if (declarationList.declarations.length !== 1) {
      return { kind: 'unsupported', reason: 'multi-declaration' };
    }
    return { kind: 'statement-region' };
  }

  if (ts.isExpressionStatement(parent)) {
    return { kind: 'statement-region' };
  }

  if (ts.isReturnStatement(parent) || ts.isThrowStatement(parent)) {
    return parent.expression === current
      ? { kind: 'statement-region' }
      : { kind: 'unsupported', reason: 'unsupported-site' };
  }

  if (
    (ts.isIfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent) ||
      ts.isSwitchStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent)) &&
    parent.expression === current
  ) {
    return { kind: 'statement-region' };
  }

  if (
    ts.isForStatement(parent) &&
    (
      parent.initializer === current ||
      parent.condition === current ||
      parent.incrementor === current
    )
  ) {
    return { kind: 'statement-region' };
  }

  return { kind: 'unsupported', reason: 'unsupported-site' };
}

export function createAdvancedMacroContext(
  preparedProgram: PreparedProgram,
  resolved: ResolvedMacroPlaceholder,
  nestedRegistries: NestedMacroRegistries = { advanced: new Map(), rewrite: new Map() },
  runtimeResolver: MacroRuntimeImportResolver | null = null,
  hostAccess?: MacroHostAccess,
): MacroContext {
  const baseContext = createMacroContext(
    resolved,
    runtimeResolver,
    hostAccess,
    preparedProgram.runtime,
  );
  const hostSemantics = createMacroSemantics(preparedProgram.program);
  let freshCounter = 0;
  let primaryExprOperand = undefined as ReturnType<typeof resolvePrimaryExprOperand> | undefined;
  const originalSourceFileCache = new Map<string, ts.SourceFile>();
  const originalAnnotationLookupCache = new Map<
    string,
    ReturnType<typeof createAnnotationLookup>
  >();
  const exprArgumentOperands = new Map<
    number,
    ReturnType<typeof resolveExprArgumentOperand> | null
  >();

  function scriptKindForFileName(fileName: string): ts.ScriptKind {
    const lowered = fileName.toLowerCase();
    if (lowered.endsWith('.sts') || lowered.endsWith('.tsx') || lowered.endsWith('.jsx')) {
      return ts.ScriptKind.TSX;
    }
    if (lowered.endsWith('.js') || lowered.endsWith('.mjs') || lowered.endsWith('.cjs')) {
      return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
  }

  function originalSourceFileForNode(node: ts.Node): ts.SourceFile {
    const programFileName = node.getSourceFile().fileName;
    const sourceFileName = preparedProgram.toSourceFileName(programFileName);
    const cached = originalSourceFileCache.get(sourceFileName);
    if (cached) {
      return cached;
    }

    const preparedSource = preparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
    const sourceText = preparedSource?.originalText ?? node.getSourceFile().text;
    const sourceFile = ts.createSourceFile(
      sourceFileName,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForFileName(sourceFileName),
    );
    originalSourceFileCache.set(sourceFileName, sourceFile);
    return sourceFile;
  }

  function originalAnnotationLookupForNode(node: ts.Node) {
    const sourceFile = originalSourceFileForNode(node);
    const cached = originalAnnotationLookupCache.get(sourceFile.fileName);
    if (cached) {
      return cached;
    }

    const lookup = createAnnotationLookup(sourceFile);
    originalAnnotationLookupCache.set(sourceFile.fileName, lookup);
    return lookup;
  }

  function originalClassDeclarationForTypeNode(node: ts.TypeNode): ts.ClassDeclaration | null {
    if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) {
      return null;
    }
    const sourceFile = originalSourceFileForNode(node);
    const className = node.typeName.text;
    let found: ts.ClassDeclaration | null = null;
    const visit = (current: ts.Node): void => {
      if (found) {
        return;
      }
      if (ts.isClassDeclaration(current) && current.name?.text === className) {
        found = current;
        return;
      }
      ts.forEachChild(current, visit);
    };
    visit(sourceFile);
    return found;
  }

  function getPrimaryExprOperand() {
    if (primaryExprOperand === undefined) {
      primaryExprOperand = resolvePrimaryExprOperand(
        preparedProgram,
        resolved,
        nestedRegistries,
      );
    }

    return primaryExprOperand;
  }

  function getExprArgumentOperand(index: number) {
    if (!exprArgumentOperands.has(index)) {
      exprArgumentOperands.set(
        index,
        resolveExprArgumentOperand(preparedProgram, resolved, index, nestedRegistries),
      );
    }

    return exprArgumentOperands.get(index) ?? null;
  }

  function exprArgumentIndexForSyntax(expr: ExprSyntax): number | null {
    const match = baseContext.invocation.args.find((argument) =>
      argument.span.fileName === expr.span.fileName &&
      argument.span.start === expr.span.start &&
      argument.span.end === expr.span.end
    );
    return match?.index ?? null;
  }

  function findOriginalNodeForSyntaxNode(node: MacroSyntaxNode): ts.Node | null {
    const hostNode = getHostNode(node);
    if (!hostNode) {
      return null;
    }

    const sourceFile = originalSourceFileForNode(hostNode);
    let match: ts.Node | null = null;

    const visit = (current: ts.Node) => {
      if (match) {
        return;
      }

      if (
        current.getStart(sourceFile, false) === node.span.start &&
        current.end === node.span.end
      ) {
        match = current;
        return;
      }

      ts.forEachChild(current, visit);
    };

    visit(sourceFile);
    return match;
  }

  function annotationsForNode(node: MacroSyntaxNode): readonly MacroAnnotation[] {
    const originalNode = findOriginalNodeForSyntaxNode(node);
    return originalNode
      ? originalAnnotationLookupForNode(originalNode).getAttachedAnnotations(originalNode)
      : baseContext.syntax.annotations(node);
  }

  function semanticLookupNode(node?: MacroSyntaxNode): ts.Node | null {
    const directHostNode = node ? getHostNode(node) : null;
    const directHostSourceFile = directHostNode?.getSourceFile() ?? null;
    const originalNode = node ? findOriginalNodeForSyntaxNode(node) : null;
    return node
      ? originalNode ??
        directHostNode ??
        directHostSourceFile ??
        resolved.callExpression.getSourceFile() ??
        resolved.callExpression
      : resolved.callExpression;
  }

  function reflectedSyntaxNode(node: ts.Node, kind = 'reflected_syntax'): MacroSyntaxNode {
    const sourceFile = node.getSourceFile();
    return {
      kind,
      span: {
        fileName: sourceFile.fileName,
        start: node.getStart(sourceFile, false),
        end: node.end,
      },
    };
  }

  function propertyNameText(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return null;
  }

  function simpleTypeReferenceName(typeName: ts.EntityName): string {
    return ts.isIdentifier(typeName) ? typeName.text : typeName.right.text;
  }

  function reflectedTypeText(node: ts.TypeNode): string {
    return node.getText(node.getSourceFile());
  }

  function buildReflectedFieldFromTypeMember(
    member: ts.TypeElement,
    originKind: 'typeLiteralProperty' | 'interfaceProperty',
  ): MacroReflectedFieldShape | null {
    if (!ts.isPropertySignature(member) || !member.name) {
      return null;
    }

    const name = propertyNameText(member.name);
    if (name === null) {
      return null;
    }

    return {
      annotations: originalAnnotationLookupForNode(member).getAttachedAnnotations(member),
      name,
      node: reflectedSyntaxNode(member, 'type_member'),
      optional: !!member.questionToken,
      originKind,
      text: member.getText(member.getSourceFile()),
      type: member.type ? buildTypeShapeFromTypeNode(member.type) : null,
    };
  }

  function buildReflectedFieldFromObjectMember(
    member: MacroObjectTypeMemberSyntax,
    originKind: 'interfaceProperty' | 'typeLiteralProperty',
  ): MacroReflectedFieldShape | null {
    if (member.memberKind !== 'property_signature' || member.name === null) {
      return null;
    }

    const explicitType = member.explicitType();
    return {
      annotations: annotationsForNode(member),
      name: member.name,
      node: member,
      optional: member.isOptional(),
      originKind,
      text: member.text(),
      type: explicitType ? reflectTypeShape(explicitType) : null,
    };
  }

  function buildReflectedFieldFromClassField(
    field: MacroClassFieldSyntax,
  ): MacroReflectedFieldShape | null {
    if (
      field.name === null || field.hasModifier('private') || field.hasModifier('protected') ||
      field.hasModifier('static')
    ) {
      return null;
    }

    const explicitType = field.explicitType();
    return {
      annotations: annotationsForNode(field),
      name: field.name,
      node: field,
      optional: field.isOptional(),
      originKind: 'classField',
      text: field.text(),
      type: explicitType ? reflectTypeShape(explicitType) : null,
    };
  }

  function buildObjectFieldShapesFromTypeLiteral(
    node: ts.TypeLiteralNode,
  ): readonly MacroReflectedFieldShape[] | null {
    const fields = node.members.map((member) =>
      buildReflectedFieldFromTypeMember(member, 'typeLiteralProperty')
    );
    return fields.every((field) => field !== null)
      ? fields as readonly MacroReflectedFieldShape[]
      : null;
  }

  function buildRecordShapeFromTypeLiteral(node: ts.TypeLiteralNode): MacroReflectedTypeShape | null {
    if (node.members.length !== 1) {
      return null;
    }

    const [member] = node.members;
    if (!member || !ts.isIndexSignatureDeclaration(member) || member.parameters.length !== 1) {
      return null;
    }

    const [parameter] = member.parameters;
    if (!parameter?.type || !member.type) {
      return null;
    }

    return {
      key: buildTypeShapeFromTypeNode(parameter.type),
      kind: 'record',
      text: reflectedTypeText(node),
      value: buildTypeShapeFromTypeNode(member.type),
    };
  }

  function buildTypeShapeFromTypeNode(node: ts.TypeNode): MacroReflectedTypeShape {
    if (ts.isParenthesizedTypeNode(node)) {
      return buildTypeShapeFromTypeNode(node.type);
    }

    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      if (ts.isArrayTypeNode(node.type)) {
        return {
          element: buildTypeShapeFromTypeNode(node.type.elementType),
          kind: 'array',
          readonly: true,
          text: reflectedTypeText(node),
        };
      }
      if (ts.isTupleTypeNode(node.type)) {
        return {
          elements: node.type.elements.map((element) => buildTypeShapeFromTypeNode(element)),
          kind: 'tuple',
          readonly: true,
          text: reflectedTypeText(node),
        };
      }
    }

    if (ts.isArrayTypeNode(node)) {
      return {
        element: buildTypeShapeFromTypeNode(node.elementType),
        kind: 'array',
        readonly: false,
        text: reflectedTypeText(node),
      };
    }

    if (ts.isTupleTypeNode(node)) {
      return {
        elements: node.elements.map((element) => buildTypeShapeFromTypeNode(element)),
        kind: 'tuple',
        readonly: false,
        text: reflectedTypeText(node),
      };
    }

    if (ts.isTypeLiteralNode(node)) {
      const recordShape = buildRecordShapeFromTypeLiteral(node);
      if (recordShape) {
        return recordShape;
      }
      const fields = buildObjectFieldShapesFromTypeLiteral(node);
      return fields
        ? {
          fields,
          kind: 'object',
          text: reflectedTypeText(node),
        }
        : { kind: 'unsupported', text: reflectedTypeText(node) };
    }

    if (ts.isUnionTypeNode(node)) {
      return {
        kind: 'union',
        members: node.types.map((member) => buildTypeShapeFromTypeNode(member)),
        text: reflectedTypeText(node),
      };
    }

    if (ts.isIntersectionTypeNode(node)) {
      return {
        kind: 'intersection',
        members: node.types.map((member) => buildTypeShapeFromTypeNode(member)),
        text: reflectedTypeText(node),
      };
    }

    if (ts.isLiteralTypeNode(node)) {
      if (node.literal.kind === ts.SyntaxKind.NullKeyword) {
        return {
          kind: 'null',
          text: reflectedTypeText(node),
        };
      }
      if (ts.isStringLiteral(node.literal)) {
        return {
          kind: 'literal',
          literalKind: 'string',
          text: reflectedTypeText(node),
          value: node.literal.text,
        };
      }
      if (ts.isNumericLiteral(node.literal)) {
        return {
          kind: 'literal',
          literalKind: 'number',
          text: reflectedTypeText(node),
          value: Number(node.literal.text),
        };
      }
      if (node.literal.kind === ts.SyntaxKind.TrueKeyword) {
        return {
          kind: 'literal',
          literalKind: 'boolean',
          text: reflectedTypeText(node),
          value: true,
        };
      }
      if (node.literal.kind === ts.SyntaxKind.FalseKeyword) {
        return {
          kind: 'literal',
          literalKind: 'boolean',
          text: reflectedTypeText(node),
          value: false,
        };
      }
      return { kind: 'unsupported', text: reflectedTypeText(node) };
    }

    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword:
        return {
          kind: 'primitive',
          primitiveKind: 'string',
          text: reflectedTypeText(node),
        };
      case ts.SyntaxKind.NumberKeyword:
        return {
          kind: 'primitive',
          primitiveKind: 'number',
          text: reflectedTypeText(node),
        };
      case ts.SyntaxKind.BooleanKeyword:
        return {
          kind: 'primitive',
          primitiveKind: 'boolean',
          text: reflectedTypeText(node),
        };
      case ts.SyntaxKind.BigIntKeyword:
        return {
          kind: 'primitive',
          primitiveKind: 'bigint',
          text: reflectedTypeText(node),
        };
      case ts.SyntaxKind.UndefinedKeyword:
        return {
          kind: 'undefined',
          text: reflectedTypeText(node),
        };
    }

    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(node.getSourceFile());
      const simpleName = simpleTypeReferenceName(node.typeName);
      const typeArguments = (node.typeArguments ?? []).map((argument) =>
        buildTypeShapeFromTypeNode(argument)
      );
      if (simpleName === 'Option' && typeArguments.length === 1) {
        return {
          kind: 'option',
          text: reflectedTypeText(node),
          value: typeArguments[0]!,
        };
      }
      if (simpleName === 'Result' && typeArguments.length === 2) {
        return {
          err: typeArguments[1]!,
          kind: 'result',
          ok: typeArguments[0]!,
          text: reflectedTypeText(node),
        };
      }
      if (simpleName === 'Array' && typeArguments.length === 1) {
        return {
          element: typeArguments[0]!,
          kind: 'array',
          readonly: false,
          text: reflectedTypeText(node),
        };
      }
      if (simpleName === 'ReadonlyArray' && typeArguments.length === 1) {
        return {
          element: typeArguments[0]!,
          kind: 'array',
          readonly: true,
          text: reflectedTypeText(node),
        };
      }
      if (simpleName === 'Record' && typeArguments.length === 2) {
        return {
          key: typeArguments[0]!,
          kind: 'record',
          text: reflectedTypeText(node),
          value: typeArguments[1]!,
        };
      }
      return {
        kind: 'named',
        name,
        text: reflectedTypeText(node),
        typeArguments,
      };
    }

    return { kind: 'unsupported', text: reflectedTypeText(node) };
  }

  function reflectTypeShape(type: TypeSyntax): MacroReflectedTypeShape {
    const originalNode = findOriginalNodeForSyntaxNode(type);
    if (originalNode && ts.isTypeNode(originalNode)) {
      return buildTypeShapeFromTypeNode(originalNode);
    }

    const hostNode = getHostNode(type);
    if (hostNode && ts.isTypeNode(hostNode)) {
      return buildTypeShapeFromTypeNode(hostNode);
    }

    return { kind: 'unsupported', text: type.text() };
  }

  function serializeReflectedFieldShape(
    field: MacroReflectedFieldShape,
  ): MacroSerializableFieldShape {
    return {
      annotations: field.annotations,
      name: field.name,
      optional: field.optional,
      originKind: field.originKind,
      text: field.text,
      type: field.type ? serializeReflectedTypeShape(field.type) : null,
    };
  }

  function serializeReflectedTypeShape(
    shape: MacroReflectedTypeShape,
  ): MacroSerializableTypeShape {
    switch (shape.kind) {
      case 'array':
        return {
          element: serializeReflectedTypeShape(shape.element),
          kind: 'array',
          readonly: shape.readonly,
          text: shape.text,
        };
      case 'intersection':
        return {
          kind: 'intersection',
          members: shape.members.map((member) => serializeReflectedTypeShape(member)),
          text: shape.text,
        };
      case 'object':
        return {
          fields: shape.fields.map((field) => serializeReflectedFieldShape(field)),
          kind: 'object',
          text: shape.text,
        };
      case 'result':
        return {
          err: serializeReflectedTypeShape(shape.err),
          kind: 'result',
          ok: serializeReflectedTypeShape(shape.ok),
          text: shape.text,
        };
      case 'option':
        return {
          kind: 'option',
          text: shape.text,
          value: serializeReflectedTypeShape(shape.value),
        };
      case 'primitive':
      case 'literal':
      case 'null':
      case 'undefined':
      case 'unsupported':
        return shape;
      case 'named':
        return {
          kind: 'named',
          name: shape.name,
          text: shape.text,
          typeArguments: shape.typeArguments.map((member) => serializeReflectedTypeShape(member)),
        };
      case 'record':
        return {
          key: serializeReflectedTypeShape(shape.key),
          kind: 'record',
          text: shape.text,
          value: serializeReflectedTypeShape(shape.value),
        };
      case 'tuple':
        return {
          elements: shape.elements.map((member) => serializeReflectedTypeShape(member)),
          kind: 'tuple',
          readonly: shape.readonly,
          text: shape.text,
        };
      case 'union':
        return {
          kind: 'union',
          members: shape.members.map((member) => serializeReflectedTypeShape(member)),
          text: shape.text,
        };
    }
  }

  function serializeDiscriminatedUnionVariant(
    variant: MacroReflectedDiscriminatedUnionVariant,
  ): MacroSerializableDiscriminatedUnionVariant {
    return {
      discriminants: variant.discriminants,
      fields: variant.fields.map((field) => serializeReflectedFieldShape(field)),
      text: variant.text,
    };
  }

  function serializeReflectedDeclarationShape(
    shape: MacroReflectedDeclarationShape,
  ): MacroSerializableDeclarationShape {
    switch (shape.kind) {
      case 'objectLike':
        return {
          declarationKind: shape.declarationKind,
          fields: shape.fields.map((field) => serializeReflectedFieldShape(field)),
          kind: 'objectLike',
          name: shape.name,
          text: shape.text,
        };
      case 'discriminatedUnion':
        return {
          commonDiscriminantNames: shape.commonDiscriminantNames,
          kind: 'discriminatedUnion',
          name: shape.name,
          text: shape.text,
          variants: shape.variants.map((variant) => serializeDiscriminatedUnionVariant(variant)),
        };
      case 'unsupported':
        return {
          kind: 'unsupported',
          reason: shape.reason,
          text: shape.text,
        };
    }
  }

  function reflectObjectLikeDeclarationShape(
    declaration: MacroClassDeclSyntax | MacroInterfaceDeclSyntax | MacroTypeAliasDeclSyntax,
  ): MacroReflectedDeclarationShape {
    if (declaration.declarationKind === 'class') {
      const fields = declaration.members()
        .filter((member): member is MacroClassFieldSyntax => member.memberKind === 'field')
        .map((member) => buildReflectedFieldFromClassField(member))
        .filter((field): field is MacroReflectedFieldShape => field !== null);
      return {
        declarationKind: 'class',
        fields,
        kind: 'objectLike',
        name: declaration.name,
        node: declaration,
        text: declaration.text(),
      };
    }

    if (declaration.declarationKind === 'interface') {
      const fields = declaration.members.map((member) =>
        buildReflectedFieldFromObjectMember(member, 'interfaceProperty')
      );
      if (!fields.every((field) => field !== null)) {
        return {
          kind: 'unsupported',
          node: declaration,
          reason: 'notObjectLike',
          text: declaration.text(),
        };
      }
      return {
        declarationKind: 'interface',
        fields: fields as readonly MacroReflectedFieldShape[],
        kind: 'objectLike',
        name: declaration.name,
        node: declaration,
        text: declaration.text(),
      };
    }

    const objectType = declaration.type.asObjectLiteral();
    if (!objectType) {
      return {
        kind: 'unsupported',
        node: declaration,
        reason: 'notObjectLike',
        text: declaration.text(),
      };
    }

    const fields = objectType.members.map((member) =>
      buildReflectedFieldFromObjectMember(member, 'typeLiteralProperty')
    );
    if (!fields.every((field) => field !== null)) {
      return {
        kind: 'unsupported',
        node: declaration,
        reason: 'notObjectLike',
        text: declaration.text(),
      };
    }
    return {
      declarationKind: 'typeAlias',
      fields: fields as readonly MacroReflectedFieldShape[],
      kind: 'objectLike',
      name: declaration.name,
      node: declaration,
      text: declaration.text(),
    };
  }

  function discriminantsForVariantObjectType(
    objectType: MacroObjectTypeSyntax,
  ): {
    readonly discriminants: readonly MacroReflectedDiscriminant[];
    readonly fields: readonly MacroReflectedFieldShape[];
  } | null {
    const discriminants: MacroReflectedDiscriminant[] = [];
    const fields: MacroReflectedFieldShape[] = [];

    for (const member of objectType.members) {
      const reflectedField = buildReflectedFieldFromObjectMember(member, 'typeLiteralProperty');
      if (!reflectedField) {
        return null;
      }

      const explicitType = member.explicitType();
      const literal = explicitType?.asLiteral();
      if (literal?.literalKind === 'string') {
        discriminants.push({
          name: reflectedField.name,
          tag: String(literal.value),
        });
        continue;
      }

      fields.push(reflectedField);
    }

    return discriminants.length === 0 ? null : { discriminants, fields };
  }

  function reflectDeclarationShape(declaration: DeclSyntax): MacroReflectedDeclarationShape {
    const classDecl = declaration.asClass();
    if (classDecl) {
      return reflectObjectLikeDeclarationShape(classDecl);
    }

    const interfaceDecl = declaration.asInterface();
    if (interfaceDecl) {
      return reflectObjectLikeDeclarationShape(interfaceDecl);
    }

    const typeAliasDecl = declaration.asTypeAlias();
    if (!typeAliasDecl) {
      return {
        kind: 'unsupported',
        node: declaration,
        reason: 'unsupportedDeclarationKind',
        text: declaration.text(),
      };
    }

    const objectLike = reflectObjectLikeDeclarationShape(typeAliasDecl);
    if (objectLike.kind === 'objectLike') {
      return objectLike;
    }

    const unionType = typeAliasDecl.type.asUnion();
    if (!unionType) {
      return objectLike;
    }

    const variants: MacroReflectedDiscriminatedUnionVariant[] = [];
    for (const member of unionType.members) {
      const objectType = member.asObjectLiteral();
      if (!objectType) {
        return {
          kind: 'unsupported',
          node: declaration,
          reason: 'notDiscriminatedUnion',
          text: declaration.text(),
        };
      }

      const variant = discriminantsForVariantObjectType(objectType);
      if (!variant) {
        return {
          kind: 'unsupported',
          node: declaration,
          reason: 'notDiscriminatedUnion',
          text: declaration.text(),
        };
      }

      variants.push({
        discriminants: variant.discriminants,
        fields: variant.fields,
        node: member,
        text: member.text(),
      });
    }

    const commonDiscriminantNames = variants
      .map((variant) => new Set(variant.discriminants.map((discriminant) => discriminant.name)))
      .reduce<Set<string> | null>((current, names) => {
        if (current === null) {
          return new Set(names);
        }
        return new Set([...current].filter((name) => names.has(name)));
      }, null);

    if (!commonDiscriminantNames || commonDiscriminantNames.size === 0) {
      return {
        kind: 'unsupported',
        node: declaration,
        reason: 'notDiscriminatedUnion',
        text: declaration.text(),
      };
    }

    return {
      commonDiscriminantNames: [...commonDiscriminantNames],
      kind: 'discriminatedUnion',
      name: typeAliasDecl.name,
      node: typeAliasDecl,
      text: typeAliasDecl.text(),
      variants,
    };
  }

  const context: MacroContext = {
    ...baseContext,
    controlFlow: {
      deferCleanup(cleanup) {
        const statements = Array.isArray(cleanup)
          ? cleanup.map((statement) => synthesizeHostNode(getHostStatement(statement)))
          : getHostBlock(cleanup as BlockSyntax).statements.map((statement) =>
            synthesizeHostNode(statement)
          );
        return createMacroScopeExitOutput(
          statements,
          baseContext.runtimeImports(),
        );
      },
      freshBinding(hint: string): string {
        freshCounter += 1;
        return `${sanitizeBindingHint(hint)}_${resolved.placeholder.id}_${freshCounter}`;
      },

      placement(): MacroPlacement {
        return classifyPlacement(resolved);
      },

      rewriteWithValue(preludeStatements: readonly StmtSyntax[], replacementExpr: ExprSyntax) {
        const placement = classifyPlacement(resolved);
        if (placement.kind === 'unsupported') {
          const message = placement.reason === 'multi-declaration'
            ? 'Semantic control-flow rewrites currently only support declarations with a single variable declarator.'
            : 'Semantic control-flow rewrites currently only support expression sites that can be hoisted through the nearest enclosing statement.';
          throw createMacroError(resolved, message);
        }

        return createMacroValueRewriteOutput(
          preludeStatements.map((statement) => synthesizeHostNode(getHostStatement(statement))),
          synthesizeHostNode(getHostExpression(replacementExpr)),
          baseContext.runtimeImports(),
        );
      },
    },
    syntax: {
      ...baseContext.syntax,
      annotations(node: MacroSyntaxNode) {
        return annotationsForNode(node);
      },
    },
    reflect: {
      declarationShape(declaration: DeclSyntax) {
        return reflectDeclarationShape(declaration);
      },
      declarationShapeData(declaration: DeclSyntax) {
        return serializeReflectedDeclarationShape(reflectDeclarationShape(declaration));
      },
      typeShape(type: TypeSyntax) {
        return reflectTypeShape(type);
      },
      typeShapeData(type: TypeSyntax) {
        return serializeReflectedTypeShape(reflectTypeShape(type));
      },
    },
    semantics: {
      argExpanded(index) {
        const operand = getExprArgumentOperand(index);
        return operand
          ? createExprSyntaxFromNode(
            operand.node,
            operand.sourceFile,
            baseContext.invocation.args[index]?.span ?? baseContext.invocationSpan(),
            operand.expandedText,
          )
          : null;
      },

      argType(index) {
        const operand = getExprArgumentOperand(index);
        return operand ? operand.semantics.typeOfNode(operand.node) : null;
      },

      awaitedType(type) {
        return hostSemantics.awaitedType(type);
      },

      classDeclarationOfType(type) {
        const hostNode = getHostNode(type);
        if (!hostNode || !ts.isTypeNode(hostNode)) {
          return null;
        }
        const classDeclaration = hostSemantics.classDeclarationOfTypeNode(hostNode) ??
          originalClassDeclarationForTypeNode(hostNode);
        if (!classDeclaration) {
          return null;
        }
        const sourceFile = classDeclaration.getSourceFile();
        return createDeclSyntaxFromNode(
          classDeclaration,
          sourceFile,
          {
            fileName: sourceFile.fileName,
            start: classDeclaration.getStart(sourceFile),
            end: classDeclaration.getEnd(),
          },
        ).asClass();
      },

      classifyCanonicalFailureType(type) {
        return hostSemantics.classifyCanonicalFailureType(type);
      },

      classifyCanonicalResultType(type) {
        return hostSemantics.classifyCanonicalResultType(type);
      },

      classifyTryCarrierType(type) {
        return hostSemantics.classifyTryCarrierType(type);
      },

      exprType(expr) {
        const hostNode = getHostNode(expr);
        if (hostNode) {
          return hostSemantics.typeOfNode(hostNode);
        }

        const index = exprArgumentIndexForSyntax(expr);
        return index === null ? null : this.argType(index);
      },

      classifyCanonicalResultCarrierType(type) {
        return hostSemantics.classifyCanonicalResultCarrierType(type);
      },

      enclosingFunction() {
        return hostSemantics.enclosingFunctionOfNode(resolved.callExpression) ?? null;
      },

      enclosingFunctionCanonicalResult() {
        return hostSemantics.canonicalResultOfEnclosingFunctionNode(resolved.callExpression) ??
          null;
      },

      finiteCases(type) {
        return hostSemantics.finiteCases(type);
      },

      isAssignable(from, to) {
        return hostSemantics.isAssignable(from, to);
      },

      localDeclaration(name, node) {
        const hostNode = node
          ? findOriginalNodeForSyntaxNode(node) ??
            getHostNode(node)?.getSourceFile() ??
            resolved.callExpression
          : resolved.callExpression;
        if (!hostNode) {
          return null;
        }

        const sourceFile = originalSourceFileForNode(hostNode);
        for (const statement of sourceFile.statements) {
          if (
            (
              ts.isClassDeclaration(statement) ||
              ts.isFunctionDeclaration(statement) ||
              ts.isInterfaceDeclaration(statement) ||
              ts.isTypeAliasDeclaration(statement)
            ) &&
            statement.name?.text === name
          ) {
            return createDeclSyntaxFromNode(statement, sourceFile, {
              fileName: sourceFile.fileName,
              start: statement.getStart(sourceFile, false),
              end: statement.end,
            });
          }
        }
        return null;
      },

      localDeclarationHasAnnotation(name, annotationName, node) {
        const hostNode = node
          ? findOriginalNodeForSyntaxNode(node) ??
            getHostNode(node)?.getSourceFile() ??
            resolved.callExpression
          : resolved.callExpression;
        if (!hostNode) {
          return false;
        }

        const sourceFile = originalSourceFileForNode(hostNode);
        const annotationLookup = originalAnnotationLookupForNode(hostNode);
        return sourceFile.statements.some((statement) => {
          if (
            !(
              ts.isClassDeclaration(statement) ||
              ts.isFunctionDeclaration(statement) ||
              ts.isInterfaceDeclaration(statement) ||
              ts.isTypeAliasDeclaration(statement)
            )
          ) {
            return false;
          }

          return statement.name?.text === name &&
            annotationLookup.hasAttachedAnnotation(statement, annotationName);
        });
      },

      nullType() {
        return hostSemantics.nullType();
      },

      parameterType(parameter: MacroParameterSyntax) {
        const node = getHostNode(parameter);
        return node ? hostSemantics.typeOfNode(node) : null;
      },

      primaryExprEnclosingFunction() {
        const operand = getPrimaryExprOperand();
        return operand ? operand.semantics.enclosingFunctionOfNode(operand.node) ?? null : null;
      },

      primaryExprEnclosingFunctionCanonicalResult() {
        const operand = getPrimaryExprOperand();
        return operand
          ? operand.semantics.canonicalResultOfEnclosingFunctionNode(operand.node) ?? null
          : null;
      },

      primaryExprExpanded() {
        const operand = getPrimaryExprOperand();
        return operand
          ? createExprSyntaxFromNode(
            operand.node,
            operand.sourceFile,
            baseContext.syntax.primaryExpr().span,
            operand.expandedText,
          )
          : null;
      },

      primaryExprPrelude() {
        const operand = getPrimaryExprOperand();
        return operand
          ? operand.preludeTexts.flatMap((statementText, index) =>
            createStmtListSyntaxFromCode(
              resolved.callExpression.getSourceFile().fileName,
              `macro_primary_expr_prelude_${index}`,
              statementText,
            )
          )
          : null;
      },

      primaryExprCanonicalResultCarrier() {
        const operand = getPrimaryExprOperand();
        return operand
          ? operand.semantics.classifyCanonicalResultCarrierType(
            operand.semantics.typeOfNode(operand.node),
          )
          : null;
      },

      primaryExprCanonicalResult() {
        const operand = getPrimaryExprOperand();
        return operand
          ? operand.semantics.classifyCanonicalResultType(
            operand.semantics.typeOfNode(operand.node),
          )
          : null;
      },

      primaryExprContainsMacroInvocations() {
        if (
          baseContext.invocation.form !== 'arglist' || baseContext.invocation.args.length !== 1 ||
          baseContext.hasBlock() || resolved.placeholder.invocation.declarationSpan
        ) {
          return false;
        }

        return scanMacroCandidates(
          resolved.placeholder.invocation.fileName,
          baseContext.syntax.primaryExpr().text(),
        ).hashes.some((hash) => hash.kind === 'macro-start');
      },

      primaryExprTryCarrier() {
        const operand = getPrimaryExprOperand();
        return operand
          ? operand.semantics.classifyTryCarrierType(
            operand.semantics.typeOfNode(operand.node),
          )
          : null;
      },

      primaryExprType() {
        const operand = getPrimaryExprOperand();
        return operand ? operand.semantics.typeOfNode(operand.node) : null;
      },

      readSet(node) {
        const hostNode = getHostNode(node);
        return hostNode
          ? hostSemantics.readSetOfNode(hostNode)
          : { dependencies: [], unknown: false };
      },

      undefinedType() {
        return hostSemantics.undefinedType();
      },

      valueBindingPromiseLikeInScope(name, node) {
        const hostNode = semanticLookupNode(node);
        return hostNode ? hostSemantics.valueBindingPromiseLikeInScope(name, hostNode) : false;
      },

      valueBindingCallableInScope(name, node) {
        const hostNode = semanticLookupNode(node);
        return hostNode ? hostSemantics.valueBindingCallableInScope(name, hostNode) : false;
      },

      valueBindingTypeInScope(name, node) {
        const hostNode = semanticLookupNode(node);
        return hostNode ? hostSemantics.valueBindingTypeInScope(name, hostNode) : null;
      },

      valueBindingInScope(name, node) {
        const hostNode = semanticLookupNode(node);
        return hostNode ? hostSemantics.valueBindingInScope(name, hostNode) : false;
      },

      writeSet(node) {
        const hostNode = getHostNode(node);
        return hostNode
          ? hostSemantics.writeSetOfNode(hostNode)
          : { dependencies: [], unknown: false };
      },
    },
  };

  return attachSemanticLookupNodeResolver(context, semanticLookupNode);
}
