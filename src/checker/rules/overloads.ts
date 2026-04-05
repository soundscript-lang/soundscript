import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';

import { hasDirectAnnotation } from './trust.ts';

type OverloadImplementationDeclaration = ts.FunctionDeclaration | ts.MethodDeclaration;

interface OverloadCase {
  declaration: OverloadImplementationDeclaration;
  parameterTypes: readonly string[];
  returnType: ts.Type;
  returnTypeText: string;
  signatureText: string;
}

function getDeclarationName(
  declaration: OverloadImplementationDeclaration,
): string | undefined {
  return declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

function getParameterName(name: ts.BindingName, index: number): string {
  return ts.isIdentifier(name) ? name.text : `arg${index + 1}`;
}

function formatOverloadSignature(
  declaration: OverloadImplementationDeclaration,
  parameterTypes: readonly string[],
  returnTypeText: string,
): string {
  const name = getDeclarationName(declaration) ?? '<anonymous>';
  const parameters = declaration.parameters.map((parameter, index) =>
    `${getParameterName(parameter.name, index)}: ${parameterTypes[index] ?? 'unknown'}`
  );
  return `${name}(${parameters.join(', ')}): ${returnTypeText}`;
}

function createDiagnostic(
  declaration: OverloadImplementationDeclaration,
  overload: OverloadCase,
  implementationReturnType: string,
): SoundDiagnostic {
  const example =
    'Return a `number` on the numeric path, or narrow the overload list so every declared overload matches the implementation.';

  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.overloadImplementationMismatch,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.overloadImplementationMismatch,
    metadata: {
      rule: 'overload_implementation_mismatch',
      primarySymbol: getDeclarationName(declaration),
      fixability: 'local_rewrite',
      invariant:
        'Each overload signature must describe behavior the shared implementation actually provides.',
      replacementFamily: 'honest_overload_surface',
      evidence: [
        { label: 'overloadSignature', value: overload.signatureText },
        { label: 'implementationReturnType', value: implementationReturnType },
      ],
      counterexample:
        `A caller selecting the \`${overload.returnTypeText}\` overload could receive a '${implementationReturnType}' value that the signature never promised.`,
      example,
    },
    notes: [
      `The implementation returns '${implementationReturnType}', but the overload \`${overload.signatureText}\` promises a different result.`,
      `Example: ${example}`,
    ],
    hint:
      'Make the implementation satisfy every overload signature honestly, or remove overloads the body does not really implement.',
    ...getNodeDiagnosticRange(declaration.name ?? declaration),
  };
}

function getOverloadCases(
  context: AnalysisContext,
  declaration: OverloadImplementationDeclaration,
): readonly OverloadCase[] {
  if (!declaration.name || !ts.isIdentifier(declaration.name)) {
    return [];
  }

  const symbol = context.checker.getSymbolAtLocation(declaration.name);
  if (!symbol) {
    return [];
  }

  const overloads: OverloadCase[] = [];

  for (const candidate of symbol.declarations ?? []) {
    if (
      (!ts.isFunctionDeclaration(candidate) && !ts.isMethodDeclaration(candidate)) ||
      candidate === declaration ||
      candidate.body
    ) {
      continue;
    }

    const signature = context.checker.getSignatureFromDeclaration(candidate);
    if (!signature) {
      continue;
    }

    overloads.push({
      declaration: candidate,
      parameterTypes: candidate.parameters.map((parameter) =>
        context.checker.typeToString(context.checker.getTypeAtLocation(parameter))
      ),
      returnType: context.checker.getReturnTypeOfSignature(signature),
      returnTypeText: context.checker.typeToString(context.checker.getReturnTypeOfSignature(signature)),
      signatureText: formatOverloadSignature(
        candidate,
        candidate.parameters.map((parameter) =>
          context.checker.typeToString(context.checker.getTypeAtLocation(parameter))
        ),
        context.checker.typeToString(context.checker.getReturnTypeOfSignature(signature)),
      ),
    });
  }

  return overloads;
}

function normalizeTypeText(typeText: string): string {
  return typeText.replace(/\s+/g, ' ').trim();
}

function parsePrimitiveOptions(typeText: string): readonly string[] {
  return normalizeTypeText(typeText).split(' | ');
}

function filterOverloadsByCondition(
  overloads: readonly OverloadCase[],
  expression: ts.Expression,
  branch: 'false' | 'true',
  declaration: OverloadImplementationDeclaration,
): readonly OverloadCase[] {
  if (
    !ts.isBinaryExpression(expression) ||
    !ts.isTypeOfExpression(expression.left) ||
    !ts.isIdentifier(expression.left.expression) ||
    !ts.isStringLiteral(expression.right) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return overloads;
  }

  const typeofExpression = expression.left;
  const typeLiteral = expression.right;
  const parameterReference = typeofExpression.expression;
  if (!ts.isIdentifier(parameterReference)) {
    return overloads;
  }

  const parameterIndex = declaration.parameters.findIndex((parameter) =>
    ts.isIdentifier(parameter.name) && parameter.name.text === parameterReference.text
  );
  if (parameterIndex === -1) {
    return overloads;
  }

  return overloads.filter((overload) => {
    const parameterType = overload.parameterTypes[parameterIndex];
    if (!parameterType) {
      return true;
    }

    const options = parsePrimitiveOptions(parameterType);
    const matchesBranch = options.includes(typeLiteral.text);
    return branch === 'true' ? matchesBranch : !matchesBranch;
  });
}

function unionOverloads(
  left: readonly OverloadCase[],
  right: readonly OverloadCase[],
): readonly OverloadCase[] {
  const merged = new Map<OverloadImplementationDeclaration, OverloadCase>();

  for (const overload of [...left, ...right]) {
    merged.set(overload.declaration, overload);
  }

  return [...merged.values()];
}

function collectReturnDiagnostics(
  context: AnalysisContext,
  declaration: OverloadImplementationDeclaration,
  statements: readonly ts.Statement[],
  overloads: readonly OverloadCase[],
  diagnostics: SoundDiagnostic[],
): readonly OverloadCase[] {
  let activeOverloads = overloads;

  for (const statement of statements) {
    if (context.isGeneratedNode(statement)) {
      continue;
    }

    if (activeOverloads.length === 0) {
      return activeOverloads;
    }

    if (ts.isReturnStatement(statement)) {
      if (!statement.expression) {
        return [];
      }

      const returnType = context.checker.getTypeAtLocation(statement.expression);
      const mismatchedOverload = activeOverloads.find((overload) =>
        !context.checker.isTypeAssignableTo(returnType, overload.returnType)
      );
      if (mismatchedOverload) {
        diagnostics.push(
          createDiagnostic(
            declaration,
            mismatchedOverload,
            context.checker.typeToString(returnType),
          ),
        );
      }

      return [];
    }

    if (ts.isIfStatement(statement)) {
      const trueOverloads = filterOverloadsByCondition(
        activeOverloads,
        statement.expression,
        'true',
        declaration,
      );
      const falseOverloads = filterOverloadsByCondition(
        activeOverloads,
        statement.expression,
        'false',
        declaration,
      );
      const thenStatements = ts.isBlock(statement.thenStatement)
        ? [...statement.thenStatement.statements]
        : [statement.thenStatement];
      const elseStatements = statement.elseStatement
        ? ts.isBlock(statement.elseStatement)
          ? [...statement.elseStatement.statements]
          : [statement.elseStatement]
        : [];
      const thenFallthrough = collectReturnDiagnostics(
        context,
        declaration,
        thenStatements,
        trueOverloads,
        diagnostics,
      );
      const elseFallthrough = statement.elseStatement
        ? collectReturnDiagnostics(
          context,
          declaration,
          elseStatements,
          falseOverloads,
          diagnostics,
        )
        : falseOverloads;

      activeOverloads = unionOverloads(thenFallthrough, elseFallthrough);
      continue;
    }

    if (ts.isFunctionLike(statement)) {
      continue;
    }
  }

  return activeOverloads;
}

export function runOverloadRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];

  context.forEachSourceFile((sourceFile) => {
    context.traverse(sourceFile, (node) => {
      if (
        (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) ||
        !node.body ||
        !node.name ||
        !ts.isIdentifier(node.name) ||
        hasDirectAnnotation(context, node, 'unsafe')
      ) {
        return;
      }

      const overloads = getOverloadCases(context, node);
      if (overloads.length === 0) {
        return;
      }

      const collectedDiagnostics: SoundDiagnostic[] = [];
      collectReturnDiagnostics(
        context,
        node,
        node.body.statements,
        overloads,
        collectedDiagnostics,
      );

      if (collectedDiagnostics.length > 0) {
        diagnostics.push(collectedDiagnostics[0]);
      }
    });
  });

  return diagnostics;
}
