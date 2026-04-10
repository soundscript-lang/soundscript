import ts from 'typescript';

import { SOUND_DIAGNOSTIC_CODES, SOUND_DIAGNOSTIC_MESSAGES } from '../engine/diagnostic_codes.ts';
import type { AnalysisContext } from '../engine/types.ts';
import { getNodeDiagnosticRange, type SoundDiagnostic } from '../diagnostics.ts';

type MemberLikeDeclaration =
  | ts.MethodDeclaration
  | ts.MethodSignature;

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;

  while ((current.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(current);
    if (aliased === current) {
      break;
    }
    current = aliased;
  }

  return current;
}

function hasStaticModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ===
      true;
}

function isReceiverSensitiveMethodDeclaration(
  declaration: ts.Declaration,
): declaration is MemberLikeDeclaration {
  return ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration);
}

function hasNonDeclarationReceiverSensitiveMethodSymbol(
  context: AnalysisContext,
  symbol: ts.Symbol | undefined,
): boolean {
  if (!symbol) {
    return false;
  }

  const declarations = resolveAliasedSymbol(context.checker, symbol).declarations ?? [];
  return declarations.some((declaration) =>
    !declaration.getSourceFile().isDeclarationFile &&
    isReceiverSensitiveMethodDeclaration(declaration) &&
    !hasStaticModifier(declaration)
  );
}

function getSignatureThisParameter(signature: ts.Signature): ts.Symbol | undefined {
  return signature.thisParameter;
}

function hasReceiverSensitiveCallSignature(context: AnalysisContext, type: ts.Type): boolean {
  return [...type.getCallSignatures(), ...type.getConstructSignatures()].some((signature) => {
    const thisParameter = getSignatureThisParameter(signature);
    if (!thisParameter) {
      return false;
    }

    const declarations = thisParameter.declarations ?? [];
    return declarations.some((declaration) => !declaration.getSourceFile().isDeclarationFile);
  });
}

function getMemberName(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }

  const argument = expression.argumentExpression;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function getReceiverSensitiveCallText(
  expression: ts.Expression,
): { memberName?: string; receiverCall?: string; receiverText?: string } | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return {
      memberName: expression.name.text,
      receiverText: expression.expression.getText(),
      receiverCall: `${expression.expression.getText()}.${expression.name.text}()`,
    };
  }

  if (ts.isElementAccessExpression(expression)) {
    const memberName = getMemberName(expression);
    const receiverText = expression.expression.getText();
    const accessText = memberName !== undefined
      ? `${receiverText}[${JSON.stringify(memberName)}]`
      : expression.getText();
    return {
      memberName,
      receiverText,
      receiverCall: `${accessText}()`,
    };
  }

  return undefined;
}

function getReceiverSensitiveExampleText(expression: ts.Expression): string {
  const callInfo = getReceiverSensitiveCallText(expression);
  const memberCall = callInfo?.receiverCall ?? `${expression.getText()}(/* ... */)`;

  const parent = expression.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    ts.isIdentifier(parent.name)
  ) {
    return `Write \`const ${parent.name.text} = () => ${memberCall};\` or keep the call as \`${memberCall}\`.`;
  }

  return `Write \`() => ${memberCall}\` or keep the call as \`${memberCall}\`.`;
}

function getReceiverSensitiveNodeInfo(
  node: ts.Node,
): { memberName?: string; receiverText?: string } | undefined {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const callInfo = getReceiverSensitiveCallText(node);
    return {
      memberName: callInfo?.memberName,
      receiverText: callInfo?.receiverText,
    };
  }

  if (ts.isBindingElement(node)) {
    const declaration = node.parent.parent;
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer
    ) {
      return {
        memberName: getBindingElementPropertyName(node),
        receiverText: declaration.initializer.getText(),
      };
    }
  }

  if (ts.isExportSpecifier(node)) {
    return {
      memberName: (node.propertyName ?? node.name).text,
    };
  }

  return undefined;
}

function createDiagnostic(context: AnalysisContext, node: ts.Node): SoundDiagnostic {
  const callInfo = ts.isExpression(node) ? getReceiverSensitiveCallText(node) : undefined;
  const nodeInfo = getReceiverSensitiveNodeInfo(node);
  const example = ts.isExpression(node)
    ? getReceiverSensitiveExampleText(node)
    : 'Keep the callable in member-call form, or wrap it in a lambda that preserves the original receiver.';
  const evidence = [
    ...(nodeInfo?.receiverText
      ? [{
        label: 'receiverType',
        value: context.checker.typeToString(context.checker.getTypeAtLocation(
          ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
            ? node.expression
            : ts.isBindingElement(node) &&
                ts.isVariableDeclaration(node.parent.parent) &&
                node.parent.parent.initializer
            ? node.parent.parent.initializer
            : node,
        )),
      }]
      : []),
    ...(nodeInfo?.memberName ? [{ label: 'memberName', value: nodeInfo.memberName }] : []),
  ];

  return {
    source: 'sound',
    code: SOUND_DIAGNOSTIC_CODES.receiverSensitiveCallableValue,
    category: 'error',
    message: SOUND_DIAGNOSTIC_MESSAGES.receiverSensitiveCallableValue,
    metadata: {
      rule: 'receiver_sensitive_callable_value',
      primarySymbol: nodeInfo?.memberName,
      fixability: 'local_rewrite',
      invariant: 'Receiver-sensitive callables must stay in receiver-preserving member-call form.',
      replacementFamily: 'receiver_preserving_wrapper',
      evidence: evidence.length > 0 ? evidence : undefined,
      counterexample:
        'Extracted method references can be called later with the wrong `this` value or with no receiver at all.',
      example,
    },
    notes: [
      'This callable depends on its original receiver and cannot safely become a standalone value.',
      `Example: ${example}`,
    ],
    hint:
      'Keep the call in member form like `box.read()`, or wrap it in a lambda that preserves the receiver.',
    ...getNodeDiagnosticRange(node),
  };
}

function getReceiverSensitiveMemberSymbol(
  context: AnalysisContext,
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): ts.Symbol | undefined {
  const memberName = getMemberName(expression);
  if (!memberName) {
    return undefined;
  }

  const receiverType = context.checker.getTypeAtLocation(expression.expression);
  return receiverType.getProperty(memberName);
}

function isReceiverSensitiveCallableExpression(
  context: AnalysisContext,
  expression: ts.Expression,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return isReceiverSensitiveCallableExpression(context, expression.expression);
  }

  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const memberSymbol = getReceiverSensitiveMemberSymbol(context, expression);
    if (hasNonDeclarationReceiverSensitiveMethodSymbol(context, memberSymbol)) {
      return true;
    }

    return hasReceiverSensitiveCallSignature(
      context,
      context.checker.getTypeAtLocation(expression),
    );
  }

  if (ts.isIdentifier(expression)) {
    const symbol = context.checker.getSymbolAtLocation(expression);
    if (hasNonDeclarationReceiverSensitiveMethodSymbol(context, symbol)) {
      return true;
    }

    return hasReceiverSensitiveCallSignature(
      context,
      context.checker.getTypeAtLocation(expression),
    );
  }

  return false;
}

function hasDeclarationName(node: ts.Node): node is ts.Node & { name: ts.DeclarationName } {
  return 'name' in node;
}

function isDeclarationNameExpression(node: ts.Expression): boolean {
  if (
    hasDeclarationName(node.parent) &&
    node.parent.name === node
  ) {
    return true;
  }

  return ts.isComputedPropertyName(node.parent) &&
    hasDeclarationName(node.parent.parent) &&
    node.parent.parent.name === node.parent;
}

function isAllowedReceiverSensitiveUse(expression: ts.Expression): boolean {
  const parent = expression.parent;
  return (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
    parent.expression === expression;
}

function getBindingElementPropertyName(element: ts.BindingElement): string | undefined {
  const propertyName = element.propertyName ?? element.name;
  if (
    ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName) ||
    ts.isNumericLiteral(propertyName)
  ) {
    return propertyName.text;
  }

  return undefined;
}

function isReceiverSensitiveBindingElement(
  context: AnalysisContext,
  element: ts.BindingElement,
): boolean {
  const bindingPattern = element.parent;
  if (!ts.isObjectBindingPattern(bindingPattern)) {
    return false;
  }

  const declaration = bindingPattern.parent;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return false;
  }

  const propertyName = getBindingElementPropertyName(element);
  if (!propertyName) {
    return false;
  }

  const initializerType = context.checker.getTypeAtLocation(declaration.initializer);
  const memberSymbol = initializerType.getProperty(propertyName);
  return hasNonDeclarationReceiverSensitiveMethodSymbol(context, memberSymbol);
}

function isReceiverSensitiveExportSpecifier(
  context: AnalysisContext,
  specifier: ts.ExportSpecifier,
): boolean {
  const symbol = context.checker.getSymbolAtLocation(specifier.propertyName ?? specifier.name);
  if (!symbol) {
    return false;
  }

  if (hasNonDeclarationReceiverSensitiveMethodSymbol(context, symbol)) {
    return true;
  }

  const type = context.checker.getTypeOfSymbolAtLocation(symbol, specifier.name);
  return hasReceiverSensitiveCallSignature(context, type);
}

export function runReceiverDisciplineRules(context: AnalysisContext): SoundDiagnostic[] {
  const diagnostics: SoundDiagnostic[] = [];
  const seen = new Set<string>();

  function push(node: ts.Node): void {
    const range = getNodeDiagnosticRange(node);
    const key =
      `${range.filePath}:${range.line}:${range.column}:${range.endLine}:${range.endColumn}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    diagnostics.push(createDiagnostic(context, node));
  }

  context.forEachSourceFile((sourceFile) => {
    context.traverse(sourceFile, (node) => {
      if (
        ts.isExpression(node) &&
        !isDeclarationNameExpression(node) &&
        isReceiverSensitiveCallableExpression(context, node) &&
        !isAllowedReceiverSensitiveUse(node)
      ) {
        push(node);
        return;
      }

      if (ts.isBindingElement(node) && isReceiverSensitiveBindingElement(context, node)) {
        push(node);
        return;
      }

      if (ts.isExportSpecifier(node) && isReceiverSensitiveExportSpecifier(context, node)) {
        push(node);
      }
    });
  });

  return diagnostics;
}
