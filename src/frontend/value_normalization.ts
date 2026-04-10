import ts from 'typescript';

import { createAnnotationLookup } from '../language/annotation_syntax.ts';
import {
  deepValueClassDeclarationIsValid,
  typeNodeIsDeepSafe,
} from '../language/value_deep_safe.ts';
import { buildRewriteStageFromTexts } from './error_normalization.ts';
import {
  isSoundscriptSourceFile,
  type PreparedRewriteStage,
  toSourceFileName,
} from './project_frontend.ts';

const VALUE_MODULE_SPECIFIER = 'sts:value';

export interface ValueNormalizedFile {
  rewriteStage: PreparedRewriteStage;
  sourceFile: ts.SourceFile;
}

export interface ValueNormalizedTextResult extends ValueNormalizedFile {
  rewrittenText: string;
}

export interface ValueNormalizedProgramResult {
  changedFiles: ReadonlyMap<string, ValueNormalizedFile>;
}

interface ValueFieldInfo {
  readonly name: string;
}

interface ValueClassInfo {
  readonly deep: boolean;
  readonly fields: readonly ValueFieldInfo[];
  readonly helperName: string;
}

interface ValueImportNames {
  readonly deepToken: string;
  readonly factory: string;
  readonly key: string;
  readonly readonly: string;
  readonly shallowToken: string;
}

function repairBuiltinMacroModuleSpecifiers(text: string): string {
  return text;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function collectTakenIdentifiers(sourceFile: ts.SourceFile): Set<string> {
  const taken = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      taken.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return taken;
}

function freshName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  let index = 1;
  while (taken.has(`${base}_${index}`)) {
    index += 1;
  }
  const name = `${base}_${index}`;
  taken.add(name);
  return name;
}

function hasDeepValueAnnotation(declaration: ts.ClassDeclaration): boolean {
  const annotation = createAnnotationLookup(declaration.getSourceFile())
    .getAttachedAnnotations(declaration)
    .find((entry) => entry.name === 'value');
  const [argument] = annotation?.arguments ?? [];
  return argument?.kind === 'named' &&
    argument.name === 'deep' &&
    argument.value.kind === 'boolean' &&
    argument.value.value === true;
}

function extractValueClassInfo(
  sourceFile: ts.SourceFile,
  declaration: ts.ClassDeclaration,
  helperName: string,
  checker?: ts.TypeChecker,
): ValueClassInfo | null {
  if (!declaration.name) {
    return null;
  }

  const deep = hasDeepValueAnnotation(declaration);
  if (
    declaration.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
  ) {
    return null;
  }
  if (deep && (declaration.typeParameters?.length ?? 0) > 0) {
    return null;
  }

  const isValidDeepValueClassDeclaration = (innerDeclaration: ts.ClassDeclaration): boolean =>
    deepValueClassDeclarationIsValid(innerDeclaration, {
      checker,
      hasDeepValueAnnotation,
    });

  const fields: ts.PropertyDeclaration[] = [];
  for (const member of declaration.members) {
    if (
      hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
      hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
    ) {
      return null;
    }

    if (ts.isPropertyDeclaration(member)) {
      fields.push(member);
      if (
        !ts.isIdentifier(member.name) ||
        !member.type ||
        !!member.initializer ||
        !!member.questionToken ||
        hasModifier(member, ts.SyntaxKind.StaticKeyword) ||
        !hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)
      ) {
        return null;
      }
      if (
        deep && !typeNodeIsDeepSafe(member.type, {
          checker,
          isDeepValueClassDeclaration: isValidDeepValueClassDeclaration,
        })
      ) {
        return null;
      }
      continue;
    }

    if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
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
        return null;
      }
      continue;
    }

    return null;
  }

  const constructors = declaration.members.filter((member): member is ts.ConstructorDeclaration =>
    ts.isConstructorDeclaration(member)
  );
  if (fields.length === 0) {
    if (constructors.length > 1) {
      return null;
    }
    const [constructor] = constructors;
    if (
      constructor &&
      (constructor.parameters.length !== 0 || (constructor.body?.statements.length ?? 0) !== 0)
    ) {
      return null;
    }
    return {
      deep,
      fields: [],
      helperName,
    };
  }

  if (constructors.length !== 1) {
    return null;
  }

  const [constructor] = constructors;
  if (!constructor || constructor.parameters.length !== fields.length) {
    return null;
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
      return null;
    }
  }

  const statements = constructor.body?.statements ?? [];
  if (statements.length !== fields.length) {
    return null;
  }

  for (const [index, field] of fields.entries()) {
    const parameter = constructor.parameters[index];
    const statement = statements[index];
    if (
      !parameter || !statement || !ts.isIdentifier(field.name) || !ts.isIdentifier(parameter.name)
    ) {
      return null;
    }

    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) {
      return null;
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
      return null;
    }
  }

  return {
    deep,
    fields: fields.map((field) => ({ name: (field.name as ts.Identifier).text })),
    helperName,
  };
}

function createValueImportDeclaration(
  names: ValueImportNames,
  includeDeepToken: boolean,
): ts.ImportDeclaration {
  const specifiers = [
    ts.factory.createImportSpecifier(
      false,
      ts.factory.createIdentifier('__valueFactory'),
      ts.factory.createIdentifier(names.factory),
    ),
    ts.factory.createImportSpecifier(
      false,
      ts.factory.createIdentifier('__valueKey'),
      ts.factory.createIdentifier(names.key),
    ),
    ts.factory.createImportSpecifier(
      false,
      ts.factory.createIdentifier('__valueReadonly'),
      ts.factory.createIdentifier(names.readonly),
    ),
    ts.factory.createImportSpecifier(
      false,
      ts.factory.createIdentifier('__valueShallowToken'),
      ts.factory.createIdentifier(names.shallowToken),
    ),
    ...(includeDeepToken
      ? [
        ts.factory.createImportSpecifier(
          false,
          ts.factory.createIdentifier('__valueDeepToken'),
          ts.factory.createIdentifier(names.deepToken),
        ),
      ]
      : []),
  ];

  return ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(
      false,
      undefined,
      ts.factory.createNamedImports(specifiers),
    ),
    ts.factory.createStringLiteral(VALUE_MODULE_SPECIFIER),
    undefined,
  );
}

function createHelperDeclaration(
  declaration: ts.ClassDeclaration,
  info: ValueClassInfo,
  imports: ValueImportNames,
): ts.VariableStatement {
  const className = declaration.name?.text ?? 'Value';
  const parameterDeclarations = info.fields.map((field) =>
    ts.factory.createParameterDeclaration(
      undefined,
      undefined,
      ts.factory.createIdentifier(field.name),
      undefined,
      undefined,
      undefined,
    )
  );
  const keyCall = ts.factory.createCallExpression(
    ts.factory.createIdentifier(imports.key),
    undefined,
    [
      ts.factory.createStringLiteral(className),
      ...info.fields.map((field) =>
        ts.factory.createCallExpression(
          ts.factory.createIdentifier(info.deep ? imports.deepToken : imports.shallowToken),
          undefined,
          [ts.factory.createIdentifier(field.name)],
        )
      ),
    ],
  );
  const allocateCall = ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(
      ts.factory.createIdentifier('Object'),
      ts.factory.createIdentifier('create'),
    ),
    undefined,
    [
      ts.factory.createPropertyAccessExpression(
        ts.factory.createIdentifier(className),
        ts.factory.createIdentifier('prototype'),
      ),
    ],
  );
  const initParameters = [
    ts.factory.createParameterDeclaration(
      undefined,
      undefined,
      ts.factory.createIdentifier('instance'),
      undefined,
      undefined,
      undefined,
    ),
    ...parameterDeclarations,
  ];
  const initStatements = info.fields.map((field) =>
    ts.factory.createExpressionStatement(
      ts.factory.createCallExpression(
        ts.factory.createIdentifier(imports.readonly),
        undefined,
        [
          ts.factory.createIdentifier('instance'),
          ts.factory.createStringLiteral(field.name),
          ts.factory.createIdentifier(field.name),
        ],
      ),
    )
  );

  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          ts.factory.createIdentifier(info.helperName),
          undefined,
          undefined,
          ts.factory.createCallExpression(
            ts.factory.createIdentifier(imports.factory),
            undefined,
            [
              ts.factory.createArrowFunction(
                undefined,
                undefined,
                parameterDeclarations,
                undefined,
                ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                keyCall,
              ),
              ts.factory.createArrowFunction(
                undefined,
                undefined,
                [],
                undefined,
                ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                allocateCall,
              ),
              ts.factory.createArrowFunction(
                undefined,
                undefined,
                initParameters,
                undefined,
                ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                ts.factory.createBlock(initStatements, true),
              ),
            ],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}

function rewriteConstructor(
  declaration: ts.ClassDeclaration,
  info: ValueClassInfo,
): ts.ClassDeclaration {
  const helperCallArguments = info.fields.map((field) => ts.factory.createIdentifier(field.name));
  const rewrittenMembers = declaration.members.map((member) => {
    if (!ts.isConstructorDeclaration(member)) {
      return member;
    }

    return ts.factory.updateConstructorDeclaration(
      member,
      member.modifiers,
      member.parameters,
      ts.factory.createBlock(
        [
          ts.factory.createReturnStatement(
            ts.factory.createCallExpression(
              ts.factory.createIdentifier(info.helperName),
              undefined,
              helperCallArguments,
            ),
          ),
        ],
        true,
      ),
    );
  });

  const hasConstructor = rewrittenMembers.some((member) => ts.isConstructorDeclaration(member));
  const nextMembers = hasConstructor ? rewrittenMembers : [
    ts.factory.createConstructorDeclaration(
      undefined,
      [],
      ts.factory.createBlock(
        [
          ts.factory.createReturnStatement(
            ts.factory.createCallExpression(
              ts.factory.createIdentifier(info.helperName),
              undefined,
              [],
            ),
          ),
        ],
        true,
      ),
    ),
    ...rewrittenMembers,
  ];

  return ts.factory.updateClassDeclaration(
    declaration,
    declaration.modifiers,
    declaration.name,
    declaration.typeParameters,
    declaration.heritageClauses,
    nextMembers,
  );
}

function normalizeSourceFile(
  sourceFile: ts.SourceFile,
  checker?: ts.TypeChecker,
): ValueNormalizedFile | undefined {
  const annotationLookup = createAnnotationLookup(sourceFile);
  const taken = collectTakenIdentifiers(sourceFile);
  const importNames: ValueImportNames = {
    deepToken: freshName('__sts_valueDeepToken', taken),
    factory: freshName('__sts_valueFactory', taken),
    key: freshName('__sts_valueKey', taken),
    readonly: freshName('__sts_valueReadonly', taken),
    shallowToken: freshName('__sts_valueShallowToken', taken),
  };

  let changed = false;
  let usesDeepToken = false;
  const rewrittenStatements: ts.Statement[] = [];

  for (const statement of sourceFile.statements) {
    if (
      ts.isClassDeclaration(statement) &&
      annotationLookup.hasAttachedAnnotation(statement, 'value')
    ) {
      const helperName = freshName(`__sts_value_make_${statement.name?.text ?? 'Value'}`, taken);
      const info = extractValueClassInfo(sourceFile, statement, helperName, checker);
      if (!info) {
        rewrittenStatements.push(statement);
        continue;
      }

      changed = true;
      usesDeepToken ||= info.deep;
      rewrittenStatements.push(createHelperDeclaration(statement, info, importNames));
      rewrittenStatements.push(rewriteConstructor(statement, info));
      continue;
    }

    rewrittenStatements.push(statement);
  }

  if (!changed) {
    return undefined;
  }

  const firstNonImportIndex = rewrittenStatements.findIndex((statement) =>
    !ts.isImportDeclaration(statement)
  );
  const importIndex = firstNonImportIndex === -1 ? rewrittenStatements.length : firstNonImportIndex;
  rewrittenStatements.splice(
    importIndex,
    0,
    createValueImportDeclaration(importNames, usesDeepToken),
  );

  const transformed = ts.factory.updateSourceFile(sourceFile, rewrittenStatements);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const rewrittenText = repairBuiltinMacroModuleSpecifiers(printer.printFile(transformed));
  return {
    rewriteStage: buildRewriteStageFromTexts(
      sourceFile.fileName,
      sourceFile.text,
      rewrittenText,
    ),
    sourceFile: ts.createSourceFile(
      sourceFile.fileName,
      rewrittenText,
      sourceFile.languageVersion,
      true,
    ),
  };
}

export function normalizeValueSemanticsInSourceText(
  fileName: string,
  sourceText: string,
): ValueNormalizedTextResult | undefined {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const normalized = normalizeSourceFile(sourceFile);
  if (!normalized) {
    return undefined;
  }

  return {
    ...normalized,
    rewrittenText: normalized.rewriteStage.rewrittenText,
  };
}

export function normalizeValueSemanticsInProgramForFile(
  program: ts.Program,
  fileName: string,
): ValueNormalizedFile | undefined {
  const normalizedFileName = toSourceFileName(fileName);
  const sourceFile = program.getSourceFile(fileName) ??
    program.getSourceFiles().find((candidate) =>
      toSourceFileName(candidate.fileName) === normalizedFileName
    );
  if (
    !sourceFile ||
    sourceFile.isDeclarationFile ||
    !isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))
  ) {
    return undefined;
  }

  return normalizeSourceFile(sourceFile, program.getTypeChecker());
}

export function normalizeValueSemanticsInProgram(
  program: ts.Program,
): ValueNormalizedProgramResult {
  const changedFiles = new Map<string, ValueNormalizedFile>();
  const checker = program.getTypeChecker();

  for (const sourceFile of program.getSourceFiles()) {
    if (
      sourceFile.isDeclarationFile ||
      !isSoundscriptSourceFile(toSourceFileName(sourceFile.fileName))
    ) {
      continue;
    }

    const normalized = normalizeSourceFile(sourceFile, checker);
    if (normalized) {
      changedFiles.set(sourceFile.fileName, normalized);
    }
  }

  return { changedFiles };
}
