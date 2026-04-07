import ts from 'typescript';

export interface EffectComposition {
  effects: readonly import('../engine/types.ts').EffectNameFact[];
  mask: number;
  unknown: boolean;
  unknownReasons: readonly import('../engine/types.ts').EffectUnknownReasonFact[];
}

export interface BuiltinForwardedArgumentBehavior {
  argumentIndex: number;
  handledEffects?: readonly import('../engine/types.ts').EffectNameFact[];
  failureBoundary: import('../engine/types.ts').EffectFailureBoundary;
  memberPath?: readonly string[];
  memberName?: string;
  rewrites?: readonly import('../engine/types.ts').EffectRewriteFact[];
}

export interface BuiltinCallBehavior {
  directEffects?: readonly import('../engine/types.ts').EffectNameFact[];
  directMask: number;
  forwardedArguments: readonly BuiltinForwardedArgumentBehavior[];
  unknownDirectReasons?: readonly import('../engine/types.ts').EffectUnknownReasonFact[];
}

export type EffectCallableDeclaration =
  | ts.ArrowFunction
  | ts.CallSignatureDeclaration
  | ts.ConstructorDeclaration
  | ts.ConstructSignatureDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration
  | ts.MethodSignature;

export function isCallableDeclarationNode(node: ts.Node): node is EffectCallableDeclaration {
  return ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node);
}

export function isCallableBodyDeclaration(
  node: EffectCallableDeclaration,
): node is
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration {
  return 'body' in node && node.body !== undefined;
}
