import ts from 'typescript';

import type { ParsedAnnotation } from '../../language/annotation_syntax.ts';
import {
  deepValueClassDeclarationIsValid,
  resolveAliasedSymbol,
  typeNodeIsDeepSafe,
} from '../../language/value_deep_safe.ts';
import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import type { SoundDiagnostic } from '../diagnostics.ts';

function createDiagnostic(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  message: string,
): SoundDiagnostic {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.invalidAnnotationTarget,
    category: 'error',
    message,
    filePath: sourceFile.fileName,
    line: line + 1,
    column: character + 1,
  };
}

function findValueAnnotation(
  context: AnalysisContext,
  declaration: ts.ClassDeclaration,
): ParsedAnnotation | undefined {
  return context.getAnnotationLookup(declaration.getSourceFile())
    .getAttachedAnnotations(declaration)
    .find((annotation) => annotation.name === 'value');
}

function isDeepValueAnnotation(annotation: ParsedAnnotation | undefined): boolean {
  const [argument] = annotation?.arguments ?? [];
  return argument?.kind === 'named' &&
    argument.name === 'deep' &&
    argument.value.kind === 'boolean' &&
    argument.value.value === true;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function symbolDeclaresValueClass(
  context: AnalysisContext,
  symbol: ts.Symbol,
): boolean {
  const resolved = resolveAliasedSymbol(context.checker, symbol);
  return resolved.getDeclarations()?.some((declaration) =>
    ts.isClassDeclaration(declaration) && !!findValueAnnotation(context, declaration)
  ) === true;
}

function declarationIsDeepValueClass(
  context: AnalysisContext,
  declaration: ts.ClassDeclaration,
): boolean {
  const annotation = findValueAnnotation(context, declaration);
  return !!annotation && isDeepValueAnnotation(annotation);
}

function declarationIsValidDeepValueClass(
  context: AnalysisContext,
  declaration: ts.ClassDeclaration,
): boolean {
  return deepValueClassDeclarationIsValid(declaration, {
    checker: context.checker,
    hasDeepValueAnnotation: (innerDeclaration) =>
      declarationIsDeepValueClass(context, innerDeclaration),
  });
}

function typeNodeExtendsValueClass(
  context: AnalysisContext,
  typeNode: ts.ExpressionWithTypeArguments,
): boolean {
  const baseType = context.checker.getTypeAtLocation(typeNode);
  const baseSymbol = baseType.aliasSymbol ?? baseType.getSymbol();
  return !!baseSymbol && symbolDeclaresValueClass(context, baseSymbol);
}

function validateConstructorShape(
  context: AnalysisContext,
  sourceFile: ts.SourceFile,
  declaration: ts.ClassDeclaration,
  fields: readonly ts.PropertyDeclaration[],
  deep: boolean,
  diagnostics: SoundDiagnostic[],
): void {
  const constructors = declaration.members.filter((member) => ts.isConstructorDeclaration(member));
  if (fields.length === 0) {
    if (constructors.length > 1) {
      diagnostics.push(
        createDiagnostic(
          sourceFile,
          declaration,
          `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` classes may declare at most one constructor.`,
        ),
      );
    }
  } else if (constructors.length !== 1) {
    diagnostics.push(
      createDiagnostic(
        sourceFile,
        declaration,
        `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` classes with fields must declare exactly one constructor.`,
      ),
    );
    return;
  }

  const [constructor] = constructors;
  if (!constructor) {
    return;
  }

  if (fields.length === 0) {
    if (constructor.parameters.length !== 0 || constructor.body?.statements.length) {
      diagnostics.push(
        createDiagnostic(
          sourceFile,
          constructor,
          `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} fieldless \`#[value]\` constructors must be empty.`,
        ),
      );
    }
    return;
  }

  if (constructor.parameters.length !== fields.length) {
    diagnostics.push(
      createDiagnostic(
        sourceFile,
        constructor,
        `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` constructor parameters must match declared fields 1:1.`,
      ),
    );
    return;
  }

  for (const parameter of constructor.parameters) {
    if (
      !ts.isIdentifier(parameter.name) ||
      parameter.dotDotDotToken ||
      parameter.initializer ||
      !parameter.type ||
      hasModifier(parameter, ts.SyntaxKind.PublicKeyword) ||
      hasModifier(parameter, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(parameter, ts.SyntaxKind.ProtectedKeyword) ||
      hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword)
    ) {
      diagnostics.push(
        createDiagnostic(
          sourceFile,
          parameter,
          `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` constructors only support plain identifier parameters with explicit types.`,
        ),
      );
    }
  }

  const statements = constructor.body?.statements ?? [];
  if (statements.length !== fields.length) {
    diagnostics.push(
      createDiagnostic(
        sourceFile,
        constructor,
        `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` constructors may only contain direct field assignments.`,
      ),
    );
    return;
  }

  for (const [index, field] of fields.entries()) {
    const parameter = constructor.parameters[index];
    const statement = statements[index];
    if (
      !parameter || !statement || !ts.isIdentifier(field.name) || !ts.isIdentifier(parameter.name)
    ) {
      continue;
    }

    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
      diagnostics.push(
        createDiagnostic(
          sourceFile,
          statement,
          `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` constructors may only contain direct \`this.field = param\` assignments.`,
        ),
      );
      continue;
    }

    const assignment = statement.expression;
    if (
      assignment.operatorToken.kind !== ts.SyntaxKind.FirstAssignment ||
      !ts.isPropertyAccessExpression(assignment.left) ||
      assignment.left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
      assignment.left.name.text !== field.name.text ||
      !ts.isIdentifier(assignment.right) ||
      assignment.right.text !== parameter.name.text
    ) {
      diagnostics.push(
        createDiagnostic(
          sourceFile,
          statement,
          `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` constructors must assign fields from same-name parameters in declaration order.`,
        ),
      );
    }
  }

  if (deep) {
    for (const field of fields) {
      if (
        field.type && !typeNodeIsDeepSafe(field.type, {
          checker: context.checker,
          isDeepValueClassDeclaration: (declaration) =>
            declarationIsValidDeepValueClass(context, declaration),
        })
      ) {
        diagnostics.push(
          createDiagnostic(
            sourceFile,
            field,
            `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value(deep: true)]\` fields must use recursively deep-safe types.`,
          ),
        );
      }
    }
  }
}

function validateValueClass(
  context: AnalysisContext,
  declaration: ts.ClassDeclaration,
  diagnostics: SoundDiagnostic[],
): void {
  const sourceFile = declaration.getSourceFile();
  const annotation = findValueAnnotation(context, declaration);
  if (!annotation) {
    return;
  }

  const deep = isDeepValueAnnotation(annotation);
  if (!declaration.name) {
    diagnostics.push(
      createDiagnostic(
        sourceFile,
        declaration,
        `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` classes must be named.`,
      ),
    );
  }
  if (!ts.isSourceFile(declaration.parent)) {
    diagnostics.push(
      createDiagnostic(
        sourceFile,
        declaration,
        `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` classes must be declared at module scope.`,
      ),
    );
  }
  if (
    declaration.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
  ) {
    diagnostics.push(
      createDiagnostic(
        sourceFile,
        declaration,
        `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` classes do not support inheritance in v1.`,
      ),
    );
  }
  if (deep && (declaration.typeParameters?.length ?? 0) > 0) {
    diagnostics.push(
      createDiagnostic(
        sourceFile,
        declaration,
        `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value(deep: true)]\` classes may not be generic in v1.`,
      ),
    );
  }

  const fields: ts.PropertyDeclaration[] = [];
  for (const member of declaration.members) {
    if (
      hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
    ) {
      diagnostics.push(
        createDiagnostic(
          sourceFile,
          member,
          `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` classes do not support private or protected members in v1.`,
        ),
      );
    }

    if (ts.isPropertyDeclaration(member)) {
      fields.push(member);
      if (
        !member.type ||
        !ts.isIdentifier(member.name) ||
        !!member.initializer ||
        !!member.questionToken ||
        hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
        !hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)
      ) {
        diagnostics.push(
          createDiagnostic(
            sourceFile,
            member,
            `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` fields must be public readonly instance properties with explicit types and no initializers.`,
          ),
        );
      }
      continue;
    }

    if (
      ts.isMethodDeclaration(member) ||
      ts.isConstructorDeclaration(member)
    ) {
      if (
        ts.isMethodDeclaration(member) &&
        (
          hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
          !ts.isIdentifier(member.name) ||
          !!member.questionToken ||
          !!member.asteriskToken ||
          !member.body
        )
      ) {
        diagnostics.push(
          createDiagnostic(
            sourceFile,
            member,
            `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` methods must be ordinary public instance methods with identifier names and concrete bodies.`,
          ),
        );
      }
      continue;
    }

    diagnostics.push(
      createDiagnostic(
        sourceFile,
        member,
        `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} \`#[value]\` classes only support readonly instance fields, constructors, and ordinary methods in v1.`,
      ),
    );
  }

  validateConstructorShape(context, sourceFile, declaration, fields, deep, diagnostics);
}

function validateValueBaseExtension(
  context: AnalysisContext,
  declaration: ts.ClassLikeDeclaration,
  diagnostics: SoundDiagnostic[],
): void {
  const sourceFile = declaration.getSourceFile();

  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }

    for (const type of clause.types) {
      if (!typeNodeExtendsValueClass(context, type)) {
        continue;
      }

      diagnostics.push(
        createDiagnostic(
          sourceFile,
          type,
          `${SOUND_DIAGNOSTIC_MESSAGES.invalidAnnotationTarget} classes may not extend \`#[value]\` classes in v1.`,
        ),
      );
    }
  }
}

export function runValueTypeRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        validateValueBaseExtension(context, node, diagnostics);
        if (ts.isClassDeclaration(node) && findValueAnnotation(context, node)) {
          validateValueClass(context, node, diagnostics);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  });

  return diagnostics;
}
