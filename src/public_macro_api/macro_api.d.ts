import type {
  CanonicalFailureInfo,
  MacroDependencySet,
  CanonicalResultCarrierInfo,
  CanonicalResultInfo,
  MacroFiniteCase,
  MacroFunctionContext,
  MacroTryCarrierInfo,
  MacroType,
} from './macro_semantic_types.d.ts';
import type { SourceSpan } from './macro_types.d.ts';
/**
 * Public macro authoring surface.
 *
 * Macro authors should depend on this module, not on frontend implementation modules such as
 * `macro_syntax_internal.ts` or `macro_host_ast_internal.ts`.
 */
export type MacroInvocationForm = 'block' | 'arglist' | 'decl' | 'arglist_decl';
/**
 * Declaration-position macros may currently target only module-scope declarations of these kinds.
 */
export type MacroDeclarationKind = 'class' | 'function' | 'interface' | 'typeAlias';
/**
 * `replace` fully replaces the annotated declaration.
 *
 * `augment` preserves the original declaration unchanged and appends generated sibling statements
 * immediately after it.
 */
export type MacroDeclarationExpansionMode = 'augment' | 'replace';
export type MacroBinaryOperator = '&' | '<' | '+' | '=' | '!==' | '===' | '|';
export type MacroUnaryOperator = '!';
export type MacroModifierName =
  | 'async'
  | 'default'
  | 'export'
  | 'private'
  | 'protected'
  | 'public'
  | 'readonly'
  | 'static';
/**
 * Macro expansion results are intentionally opaque at the public API layer.
 *
 * Macro authors can construct these through `ctx.output` / `ctx.controlFlow`, but they should not
 * depend on backend-specific payload details.
 */
export interface MacroExprOutput {
  readonly kind: 'expr';
}
export interface MacroStmtOutput {
  readonly kind: 'stmt';
}
export type MacroStmtListOutput = MacroStmtOutput;
export interface MacroValueRewriteOutput {
  readonly kind: 'value_rewrite';
}
export interface MacroScopeExitOutput {
  readonly kind: 'scope_exit';
}
export type MacroOutput =
  | MacroExprOutput
  | MacroStmtOutput
  | MacroValueRewriteOutput
  | MacroScopeExitOutput;
export interface MacroArgumentView extends ExprSyntax {
  readonly index: number;
}
export interface MacroInvocationView {
  /**
   * Normalized invocation shape.
   *
   * Expression operands are always exposed through `args`, regardless of whether they were written
   * as `#foo value`, `#foo(value)`, or `#foo(a) b`.
   *
   * Trailing statement blocks and declaration operands are kept separate from `args`, so an
   * invocation can be modeled as:
   * - `args`
   * - optional trailing `block`
   * - optional trailing `declaration`
   */
  readonly args: readonly MacroArgumentView[];
  readonly form: MacroInvocationForm;
  readonly hasBlock: boolean;
  readonly name: string;
}
export type MacroAnnotationValue = {
  readonly kind: 'array';
  readonly text: string;
  readonly elements: readonly MacroAnnotationValue[];
} | {
  readonly kind: 'bigint';
  readonly text: string;
  readonly value: string;
} | {
  readonly kind: 'boolean';
  readonly text: string;
  readonly value: boolean;
} | {
  readonly kind: 'identifier';
  readonly text: string;
  readonly name: string;
} | {
  readonly kind: 'member';
  readonly path: readonly string[];
  readonly text: string;
} | {
  readonly kind: 'null';
  readonly text: string;
} | {
  readonly kind: 'number';
  readonly text: string;
  readonly value: number;
} | {
  readonly kind: 'object';
  readonly text: string;
  readonly properties: readonly {
    readonly name: string;
    readonly text: string;
  readonly value: MacroAnnotationValue;
  }[];
} | {
  readonly flags: string;
  readonly kind: 'regexp';
  readonly pattern: string;
  readonly text: string;
} | {
  readonly kind: 'string';
  readonly text: string;
  readonly value: string;
} | {
  readonly kind: 'undefined';
  readonly text: string;
};
export type MacroAnnotationArgument = {
  readonly kind: 'named';
  readonly name: string;
  readonly text: string;
  readonly value: MacroAnnotationValue;
} | {
  readonly kind: 'positional';
  readonly text: string;
  readonly value: MacroAnnotationValue;
};
export interface MacroAnnotation {
  readonly arguments?: readonly MacroAnnotationArgument[];
  readonly argumentsText?: string;
  readonly name: string;
  readonly path: readonly string[];
  readonly text: string;
}
export interface ExprSyntax extends MacroSyntaxNode {
  asArrayLiteral(): MacroArrayLiteralExprSyntax | null;
  asBinary(): MacroBinaryExprPattern | null;
  asCall(): MacroCallExprPattern | null;
  asConditional(): MacroConditionalExprPattern | null;
  asFunction(): MacroFunctionExprSyntax | null;
  asIdentifier(): string | null;
  asInvocation(): InvocationSyntax | null;
  asJsxElement(): MacroJsxElementSyntax | null;
  asJsxFragment(): MacroJsxFragmentSyntax | null;
  asPropertyAccess(): MacroPropertyAccessPattern | null;
  containsCallNamed(name: string): boolean;
  isBooleanLiteral(value: boolean): boolean;
  isNullLiteral(): boolean;
  readonly kind: 'expr';
  replaceThis(replacement: ExprSyntax): ExprSyntax;
  rewrite(options: MacroSyntaxRewriteOptions): ExprSyntax;
  text(): string;
  thisMemberReferences(): readonly string[];
  unparenthesized(): ExprSyntax;
}
export interface MacroIdentifierExprSyntax extends ExprSyntax {
  asIdentifier(): string;
}
export interface MacroCallExprSyntax extends ExprSyntax {
  asCall(): MacroCallExprPattern;
}
export interface MacroArrayLiteralElementSyntax extends MacroSyntaxNode {
  expression(): ExprSyntax | null;
  readonly isSpread: boolean;
  readonly kind: 'array_element' | 'array_elision';
  text(): string;
}
export interface MacroArrayLiteralExprSyntax extends ExprSyntax {
  asArrayLiteral(): MacroArrayLiteralExprSyntax;
  readonly elements: readonly MacroArrayLiteralElementSyntax[];
}
export interface StmtSyntax extends MacroSyntaxNode {
  readonly kind: 'stmt';
  text(): string;
}
export interface BlockSyntax extends MacroSyntaxNode {
  containsCallNamed(name: string): boolean;
  readonly kind: 'block';
  replaceThis(replacement: ExprSyntax): BlockSyntax;
  rewrite(options: MacroSyntaxRewriteOptions): BlockSyntax;
  readonly statements: readonly StmtSyntax[];
  text(): string;
  thisMemberReferences(): readonly string[];
}
export interface MacroSyntaxRewriteOptions {
  readonly replaceCallNamed?: Readonly<Record<string, ExprSyntax>>;
  readonly replaceThisMemberWriteNamed?: Readonly<Record<string, ExprSyntax>>;
  readonly replaceThisWith?: ExprSyntax;
}
export interface DeclSyntax extends MacroSyntaxNode {
  readonly declarationKind: MacroDeclarationKind;
  readonly kind: 'decl';
  readonly name: string | null;
  asClass(): MacroClassDeclSyntax | null;
  asFunction(): MacroFunctionDeclSyntax | null;
  asInterface(): MacroInterfaceDeclSyntax | null;
  asTypeAlias(): MacroTypeAliasDeclSyntax | null;
  text(): string;
}
export interface JsxSyntax extends MacroSyntaxNode {
  text(): string;
}
export interface MacroParameterSyntax extends MacroSyntaxNode {
  bindingIdentifiers(): readonly MacroBindingIdentifierSyntax[];
  explicitType(): TypeSyntax | null;
  hasDefault(): boolean;
  hasExplicitType(): boolean;
  isRest(): boolean;
  readonly kind: 'parameter';
  readonly name: string | null;
  text(): string;
}
export interface TypeSyntax extends MacroSyntaxNode {
  asLiteral(): MacroLiteralTypeSyntax | null;
  asObjectLiteral(): MacroObjectTypeSyntax | null;
  asUnion(): MacroUnionTypeSyntax | null;
  readonly kind: 'type';
  text(): string;
}
export interface MacroLiteralTypeSyntax extends TypeSyntax {
  asLiteral(): MacroLiteralTypeSyntax;
  readonly literalKind: 'boolean' | 'number' | 'string';
  readonly value: boolean | number | string;
}
export interface MacroObjectTypeMemberSyntax extends MacroSyntaxNode {
  explicitType(): TypeSyntax | null;
  hasExplicitType(): boolean;
  isOptional(): boolean;
  readonly kind: 'type_member';
  readonly memberKind:
    | 'call_signature'
    | 'construct_signature'
    | 'index_signature'
    | 'method_signature'
    | 'property_signature';
  readonly name: string | null;
  text(): string;
}
export interface MacroObjectTypeSyntax extends TypeSyntax {
  asObjectLiteral(): MacroObjectTypeSyntax;
  readonly members: readonly MacroObjectTypeMemberSyntax[];
}
export interface MacroUnionTypeSyntax extends TypeSyntax {
  asUnion(): MacroUnionTypeSyntax;
  readonly members: readonly TypeSyntax[];
}
export interface MacroTypeParameterSyntax extends MacroSyntaxNode {
  constraint(): TypeSyntax | null;
  defaultType(): TypeSyntax | null;
  readonly kind: 'type_parameter';
  readonly name: string;
  text(): string;
}
export interface MacroBindingIdentifierSyntax extends MacroSyntaxNode {
  readonly kind: 'binding_identifier';
  readonly name: string;
}
export interface MacroClassMemberSyntax extends MacroSyntaxNode {
  readonly kind: 'class_member';
  readonly memberKind: 'constructor' | 'field' | 'getter' | 'method' | 'setter';
  readonly name: string | null;
  hasModifier(name: MacroModifierName): boolean;
  text(): string;
}
export interface MacroClassFieldSyntax extends MacroClassMemberSyntax {
  explicitType(): TypeSyntax | null;
  hasExplicitType(): boolean;
  isOptional(): boolean;
  readonly memberKind: 'field';
  initializer(): ExprSyntax | null;
  withInitializer(initializer: ExprSyntax | null): MacroClassFieldSyntax;
}
export interface MacroClassMethodSyntax extends MacroClassMemberSyntax {
  readonly memberKind: 'getter' | 'method' | 'setter';
  readonly parameters: readonly MacroParameterSyntax[];
  body(): BlockSyntax | null;
  returnedExpr(): ExprSyntax | null;
  returnedJsx(): MacroJsxElementSyntax | null;
  withBody(body: BlockSyntax): MacroClassMethodSyntax;
}
export interface MacroClassConstructorSyntax extends MacroClassMemberSyntax {
  readonly memberKind: 'constructor';
  readonly parameters: readonly MacroParameterSyntax[];
  body(): BlockSyntax | null;
  withBody(body: BlockSyntax): MacroClassConstructorSyntax;
}
export type MacroAnyClassMemberSyntax =
  | MacroClassConstructorSyntax
  | MacroClassFieldSyntax
  | MacroClassMethodSyntax;
export interface MacroClassDeclSyntax extends DeclSyntax {
  readonly declarationKind: 'class';
  hasModifier(name: MacroModifierName): boolean;
  member(name: string): MacroAnyClassMemberSyntax | null;
  members(): readonly MacroAnyClassMemberSyntax[];
  resolveThisDependencies(
    node: ExprSyntax | BlockSyntax,
    rootMemberNames: readonly string[],
  ): readonly string[];
}
export interface MacroFunctionDeclSyntax extends DeclSyntax {
  readonly declarationKind: 'function';
  hasModifier(name: MacroModifierName): boolean;
  readonly parameters: readonly MacroParameterSyntax[];
  body(): BlockSyntax | null;
  returnedExpr(): ExprSyntax | null;
  returnedJsx(): MacroJsxElementSyntax | null;
}
export interface MacroInterfaceDeclSyntax extends DeclSyntax {
  readonly declarationKind: 'interface';
  readonly extendsTypes: readonly TypeSyntax[];
  hasModifier(name: MacroModifierName): boolean;
  readonly members: readonly MacroObjectTypeMemberSyntax[];
  readonly typeParameters: readonly MacroTypeParameterSyntax[];
}
export interface MacroTypeAliasDeclSyntax extends DeclSyntax {
  readonly declarationKind: 'typeAlias';
  hasModifier(name: MacroModifierName): boolean;
  readonly type: TypeSyntax;
  readonly typeParameters: readonly MacroTypeParameterSyntax[];
}
export interface MacroPropertyAccessPattern {
  readonly name: string;
  readonly object: ExprSyntax;
}
export interface MacroCallExprPattern {
  readonly args: readonly ExprSyntax[];
  readonly callee: ExprSyntax;
}
export interface MacroBinaryExprPattern {
  readonly left: ExprSyntax;
  readonly operator: string;
  readonly right: ExprSyntax;
}
export interface MacroConditionalExprPattern {
  readonly condition: ExprSyntax;
  readonly whenFalse: ExprSyntax;
  readonly whenTrue: ExprSyntax;
}
export interface MacroFunctionExprSyntax extends ExprSyntax {
  readonly functionKind: 'arrow' | 'function';
  hasAsyncModifier(): boolean;
  readonly parameters: readonly MacroParameterSyntax[];
  body(): BlockSyntax | null;
  returnedExpr(): ExprSyntax | null;
  returnedJsx(): MacroJsxElementSyntax | null;
  typeParameterCount(): number;
}
export interface MacroJsxAttributeSyntax extends MacroSyntaxNode {
  readonly kind: 'jsx_attribute';
  readonly name: string;
  expression(): ExprSyntax | null;
  stringValue(): string | null;
  text(): string;
}
export interface MacroJsxSpreadAttributeSyntax extends MacroSyntaxNode {
  readonly kind: 'jsx_spread_attribute';
  expression(): ExprSyntax;
  text(): string;
}
export type MacroAnyJsxAttributeSyntax = MacroJsxAttributeSyntax | MacroJsxSpreadAttributeSyntax;
export interface MacroJsxTextSyntax extends JsxSyntax {
  readonly kind: 'jsx_text';
  readonly value: string;
}
export interface MacroJsxExpressionSyntax extends JsxSyntax {
  readonly kind: 'jsx_expr';
  expression(): ExprSyntax | null;
}
export interface MacroJsxElementSyntax extends JsxSyntax {
  readonly kind: 'jsx_element';
  readonly selfClosing: boolean;
  readonly tagName: string | null;
  attribute(name: string): MacroAnyJsxAttributeSyntax | null;
  attributes(): readonly MacroAnyJsxAttributeSyntax[];
  children(): readonly MacroAnyJsxChildSyntax[];
}
export interface MacroJsxFragmentSyntax extends JsxSyntax {
  readonly kind: 'jsx_fragment';
  children(): readonly MacroAnyJsxChildSyntax[];
}
export type MacroAnyJsxChildSyntax =
  | MacroJsxElementSyntax
  | MacroJsxFragmentSyntax
  | MacroJsxExpressionSyntax
  | MacroJsxTextSyntax;
export interface InvocationSyntax extends MacroSyntaxNode {
  readonly args: readonly MacroArgumentView[];
  readonly block: BlockSyntax | null;
  readonly declaration: DeclSyntax | null;
  readonly form: MacroInvocationForm;
  readonly hasBlock: boolean;
  readonly kind: 'invocation';
  readonly name: string;
  text(): string;
}
export interface MacroAnalysisRegion {
  readonly prefixText: string;
  readonly sourceSpan: SourceSpan;
  readonly suffixText: string;
}
export interface MacroTemplateQuasi {
  readonly span: SourceSpan;
  readonly text: string;
}
export type MacroTemplateExpression = ExprSyntax;
export interface MacroTemplateOperand extends MacroSyntaxNode {
  readonly expressions: readonly MacroTemplateExpression[];
  readonly kind: 'template';
  readonly quasis: readonly MacroTemplateQuasi[];
  readonly span: SourceSpan;
  text(): string;
}
export type MacroSignatureOperandKind = 'expr' | 'template' | 'block' | 'decl';
export type MacroSignatureOperandRefinementKind =
  | 'array_literal'
  | 'call'
  | 'class_decl'
  | 'function'
  | 'function_decl'
  | 'interface_decl'
  | 'type_alias_decl'
  | 'identifier';
export interface MacroSignatureOperandRefinement {
  readonly displayText: string;
  readonly kind: MacroSignatureOperandRefinementKind;
}
export type MacroSignatureRefinedValue<Kind extends MacroSignatureOperandRefinementKind> =
  Kind extends 'array_literal' ? MacroArrayLiteralExprSyntax
    : Kind extends 'call' ? MacroCallExprSyntax
    : Kind extends 'class_decl' ? MacroClassDeclSyntax
    : Kind extends 'function' ? MacroFunctionExprSyntax
    : Kind extends 'function_decl' ? MacroFunctionDeclSyntax
    : Kind extends 'interface_decl' ? MacroInterfaceDeclSyntax
    : Kind extends 'type_alias_decl' ? MacroTypeAliasDeclSyntax
    : MacroIdentifierExprSyntax;
export type MacroSignatureOperandBaseValue<Kind extends MacroSignatureOperandKind> = Kind extends
  'expr' ? ExprSyntax
  : Kind extends 'template' ? MacroTemplateOperand
  : Kind extends 'block' ? BlockSyntax
  : DeclSyntax;
export interface MacroSignatureOperand<
  Kind extends MacroSignatureOperandKind = MacroSignatureOperandKind,
  Name extends string = string,
  Optional extends boolean = boolean,
  Value extends MacroDecodedSignatureValue = MacroSignatureOperandBaseValue<Kind>,
> {
  readonly description?: string;
  readonly kind: Kind;
  readonly name: Name;
  readonly optional: Optional;
  readonly refinement?: MacroSignatureOperandRefinement;
}
export interface MacroSignatureCase<
  CaseName extends string | null = string | null,
  Operands extends readonly MacroSignatureOperand[] = readonly MacroSignatureOperand[],
> {
  readonly caseName: CaseName;
  readonly operands: Operands;
}
export interface MacroSignature<
  Cases extends readonly MacroSignatureCase[] = readonly MacroSignatureCase[],
> {
  readonly cases: Cases;
  readonly validators?: readonly MacroSignatureValidator[];
}
export type MacroDecodedSignatureValue =
  | BlockSyntax
  | DeclSyntax
  | ExprSyntax
  | MacroTemplateOperand
  | null;
type MacroSignatureOperandDecodedValue<Operand extends MacroSignatureOperand> = Operand extends
  MacroSignatureOperand<any, any, infer Optional, infer Value>
  ? Optional extends true ? Value | null : Value
  : never;
type MacroSignatureArgsFromOperands<Operands extends readonly MacroSignatureOperand[]> = Readonly<
  {
    [Operand in Operands[number] as Operand['name']]: MacroSignatureOperandDecodedValue<Operand>;
  }
>;
export interface MacroDecodedSignatureCase<Case extends MacroSignatureCase = MacroSignatureCase> {
  readonly args: MacroSignatureArgsFromOperands<Case['operands']>;
  readonly caseName: Case['caseName'];
  readonly signatureCase: Case;
}
export type MacroDecodedSignature<Signature extends MacroSignature> = MacroDecodedSignatureCase<
  Signature['cases'][number]
>;
export type MacroSignatureValidator<Signature extends MacroSignature = MacroSignature> = (
  ctx: MacroContext,
  signature: MacroDecodedSignature<Signature>,
) => void;
export interface MacroSyntaxAccess {
  annotations(node: MacroSyntaxNode): readonly MacroAnnotation[];
  arg(index: number): ExprSyntax;
  args(): readonly MacroArgumentView[];
  block(): BlockSyntax;
  declaration(): DeclSyntax;
  primaryExpr(): ExprSyntax;
  root(): InvocationSyntax;
  template(index: number): MacroTemplateOperand | null;
}
export interface MacroQuoteFactory {
  readonly block: (
    strings: TemplateStringsArray,
    ...values: readonly MacroQuoteValue[]
  ) => BlockSyntax;
  readonly classMembers: (
    strings: TemplateStringsArray,
    ...values: readonly MacroQuoteValue[]
  ) => readonly MacroAnyClassMemberSyntax[];
  readonly decl: (
    strings: TemplateStringsArray,
    ...values: readonly MacroQuoteValue[]
  ) => DeclSyntax;
  readonly expr: (
    strings: TemplateStringsArray,
    ...values: readonly MacroQuoteValue[]
  ) => ExprSyntax;
  readonly stmt: (
    strings: TemplateStringsArray,
    ...values: readonly MacroQuoteValue[]
  ) => StmtSyntax;
  readonly stmts: (
    strings: TemplateStringsArray,
    ...values: readonly MacroQuoteValue[]
  ) => readonly StmtSyntax[];
}
export interface MacroFieldBuildOptions {
  readonly initializer?: ExprSyntax | null;
  readonly modifiers?: readonly MacroModifierName[];
  readonly name: string;
  readonly type?: string;
}
export interface MacroParameterBuildOptions {
  readonly name: string;
  readonly type?: string;
}
export interface MacroMethodBuildOptions {
  readonly body: BlockSyntax;
  readonly modifiers?: readonly MacroModifierName[];
  readonly name: string;
  readonly parameters?: readonly (string | MacroParameterBuildOptions)[];
  readonly returnType?: string;
}
export interface MacroSetterBuildOptions {
  readonly body: BlockSyntax;
  readonly modifiers?: readonly MacroModifierName[];
  readonly name: string;
  readonly parameter: string | MacroParameterBuildOptions;
}
export interface MacroFunctionBuildOptions {
  readonly body: BlockSyntax;
  readonly modifiers?: readonly MacroModifierName[];
  readonly name: string;
  readonly parameters?: readonly (string | MacroParameterBuildOptions)[];
  readonly returnType?: string;
}
export interface MacroIfBuildOptions {
  readonly condition: ExprSyntax;
  readonly elseStatements?: readonly StmtSyntax[];
  readonly thenStatements: readonly StmtSyntax[];
}
export interface MacroForInitializerBuildOptions {
  readonly kind: 'const' | 'let';
  readonly name: string;
  readonly value: ExprSyntax;
}
export interface MacroForBuildOptions {
  readonly condition?: ExprSyntax;
  readonly increment?: ExprSyntax;
  readonly initializer?: ExprSyntax | MacroForInitializerBuildOptions;
  readonly statements: readonly StmtSyntax[];
}
export interface MacroObjectPropertyBuildOptions {
  readonly kind: 'property';
  readonly name: string;
  readonly value: ExprSyntax;
}
export interface MacroObjectMethodBuildOptions {
  readonly body: BlockSyntax;
  readonly kind: 'method';
  readonly name: string;
  readonly parameters?: readonly (string | MacroParameterBuildOptions)[];
  readonly returnType?: string;
}
export type MacroObjectMemberBuildOptions =
  | MacroObjectMethodBuildOptions
  | MacroObjectPropertyBuildOptions;
export interface MacroBuildFactory {
  assign(target: ExprSyntax, value: ExprSyntax): ExprSyntax;
  arrowFunction(
    parameters: readonly (string | MacroParameterBuildOptions)[],
    body: BlockSyntax | ExprSyntax,
  ): ExprSyntax;
  binary(left: ExprSyntax, operator: MacroBinaryOperator, right: ExprSyntax): ExprSyntax;
  block(statements: readonly StmtSyntax[]): BlockSyntax;
  booleanLiteral(value: boolean): ExprSyntax;
  call(callee: ExprSyntax, args: readonly ExprSyntax[]): ExprSyntax;
  constDecl(name: string, initializer: ExprSyntax): StmtSyntax;
  element(object: ExprSyntax, index: ExprSyntax): ExprSyntax;
  exprStmt(expression: ExprSyntax): StmtSyntax;
  field(options: MacroFieldBuildOptions): MacroClassFieldSyntax;
  forStmt(options: MacroForBuildOptions): StmtSyntax;
  identifier(name: string): ExprSyntax;
  ifStmt(options: MacroIfBuildOptions): StmtSyntax;
  functionDecl(options: MacroFunctionBuildOptions): MacroFunctionDeclSyntax;
  getter(options: Omit<MacroMethodBuildOptions, 'parameters'>): MacroClassMethodSyntax;
  letDecl(name: string, initializer: ExprSyntax): StmtSyntax;
  method(options: MacroMethodBuildOptions): MacroClassMethodSyntax;
  newExpr(callee: ExprSyntax, args: readonly ExprSyntax[]): ExprSyntax;
  nullLiteral(): ExprSyntax;
  numberLiteral(value: number): ExprSyntax;
  objectLiteral(members: readonly MacroObjectMemberBuildOptions[]): ExprSyntax;
  optionalMethodCall(receiver: ExprSyntax, name: string, args: readonly ExprSyntax[]): ExprSyntax;
  property(object: ExprSyntax, name: string): ExprSyntax;
  returnStmt(expression?: ExprSyntax): StmtSyntax;
  setter(options: MacroSetterBuildOptions): MacroClassMethodSyntax;
  stringLiteral(value: string): ExprSyntax;
  thisExpr(): ExprSyntax;
  throwStmt(expression: ExprSyntax): StmtSyntax;
  unary(operator: MacroUnaryOperator, value: ExprSyntax): ExprSyntax;
  updateClass(
    base: MacroClassDeclSyntax,
    members: readonly MacroAnyClassMemberSyntax[],
  ): MacroClassDeclSyntax;
}
export interface MacroOutputFactory {
  expr(node: ExprSyntax): MacroExprOutput;
  stmt(node: StmtSyntax | DeclSyntax): MacroStmtOutput;
  stmts(nodes: readonly (StmtSyntax | DeclSyntax)[]): MacroStmtListOutput;
}
export interface MacroRuntimeAccess {
  default(specifier: string): ExprSyntax;
  named(specifier: string, exportName: string): ExprSyntax;
  namespace(specifier: string): ExprSyntax;
}
export interface MacroHostPathOptions {
  readonly base?: 'macro' | 'project';
}
export interface MacroHostEnvAccess {
  get(name: string): string | undefined;
  require(name: string): string;
}
export interface MacroHostFsAccess {
  exists(path: string, options?: MacroHostPathOptions): boolean;
  readBytes(path: string, options?: MacroHostPathOptions): Uint8Array;
  readText(path: string, options?: MacroHostPathOptions): string;
}
export interface MacroHostAccess {
  readonly env: MacroHostEnvAccess;
  readonly fs: MacroHostFsAccess;
}
export type MacroReflectedFieldOriginKind =
  | 'classField'
  | 'interfaceProperty'
  | 'typeLiteralProperty';
export type MacroReflectedPrimitiveKind = 'bigint' | 'boolean' | 'number' | 'string';
export type MacroReflectedTypeShape =
  | {
    readonly element: MacroReflectedTypeShape;
    readonly kind: 'array';
    readonly readonly: boolean;
    readonly text: string;
  }
  | {
    readonly kind: 'intersection';
    readonly members: readonly MacroReflectedTypeShape[];
    readonly text: string;
  }
  | {
    readonly fields: readonly MacroReflectedFieldShape[];
    readonly kind: 'object';
    readonly text: string;
  }
  | {
    readonly err: MacroReflectedTypeShape;
    readonly kind: 'result';
    readonly ok: MacroReflectedTypeShape;
    readonly text: string;
  }
  | {
    readonly kind: 'option';
    readonly text: string;
    readonly value: MacroReflectedTypeShape;
  }
  | {
    readonly kind: 'primitive';
    readonly primitiveKind: MacroReflectedPrimitiveKind;
    readonly text: string;
  }
  | {
    readonly kind: 'literal';
    readonly literalKind: 'boolean' | 'number' | 'string';
    readonly text: string;
    readonly value: boolean | number | string;
  }
  | {
    readonly kind: 'null';
    readonly text: string;
  }
  | {
    readonly kind: 'named';
    readonly name: string;
    readonly text: string;
    readonly typeArguments: readonly MacroReflectedTypeShape[];
  }
  | {
    readonly key: MacroReflectedTypeShape;
    readonly kind: 'record';
    readonly text: string;
    readonly value: MacroReflectedTypeShape;
  }
  | {
    readonly elements: readonly MacroReflectedTypeShape[];
    readonly kind: 'tuple';
    readonly readonly: boolean;
    readonly text: string;
  }
  | {
    readonly kind: 'union';
    readonly members: readonly MacroReflectedTypeShape[];
    readonly text: string;
  }
  | {
    readonly kind: 'undefined';
    readonly text: string;
  }
  | {
    readonly kind: 'unsupported';
    readonly text: string;
  };
export interface MacroReflectedFieldShape {
  readonly annotations: readonly MacroAnnotation[];
  readonly name: string;
  readonly node: MacroSyntaxNode;
  readonly optional: boolean;
  readonly originKind: MacroReflectedFieldOriginKind;
  readonly text: string;
  readonly type: MacroReflectedTypeShape | null;
}
export interface MacroReflectedDiscriminant {
  readonly name: string;
  readonly tag: string;
}
export interface MacroReflectedDiscriminatedUnionVariant {
  readonly discriminants: readonly MacroReflectedDiscriminant[];
  readonly fields: readonly MacroReflectedFieldShape[];
  readonly node: MacroSyntaxNode;
  readonly text: string;
}
export type MacroReflectedDeclarationShape =
  | {
    readonly declarationKind: 'class' | 'interface' | 'typeAlias';
    readonly fields: readonly MacroReflectedFieldShape[];
    readonly kind: 'objectLike';
    readonly name: string | null;
    readonly node: DeclSyntax;
    readonly text: string;
  }
  | {
    readonly commonDiscriminantNames: readonly string[];
    readonly kind: 'discriminatedUnion';
    readonly name: string | null;
    readonly node: MacroTypeAliasDeclSyntax;
    readonly text: string;
    readonly variants: readonly MacroReflectedDiscriminatedUnionVariant[];
  }
  | {
    readonly kind: 'unsupported';
    readonly node: DeclSyntax;
    readonly reason: 'notDiscriminatedUnion' | 'notObjectLike' | 'unsupportedDeclarationKind';
    readonly text: string;
  };
export interface MacroReflectionAccess {
  declarationShape(declaration: DeclSyntax): MacroReflectedDeclarationShape;
  typeShape(type: TypeSyntax): MacroReflectedTypeShape;
}
export interface MacroContext {
  readonly build: MacroBuildFactory;
  readonly controlFlow: MacroControlFlow;
  readonly fresh: MacroFresh;
  readonly host: MacroHostAccess;
  readonly invocation: MacroInvocationView;
  readonly kind: 'expr' | 'stmt';
  readonly name: string;
  readonly output: MacroOutputFactory;
  readonly quote: MacroQuoteFactory;
  readonly reflect: MacroReflectionAccess;
  readonly runtime: MacroRuntimeAccess;
  readonly semantics: MacroSemanticsView;
  readonly syntax: MacroSyntaxAccess;
  blockSpan(): SourceSpan | null;
  declarationSpan(): SourceSpan | null;
  error(message: string): never;
  hasBlock(): boolean;
  invocationSpan(): SourceSpan;
  location(): {
    readonly column: number;
    readonly filePath: string;
    readonly line: number;
  };
  parsedSyntax(): MacroSyntaxNode | null;
  sourceText(): string;
}
export interface MacroSemanticsView {
  argExpanded(index: number): ExprSyntax | null;
  argType(index: number): MacroType | null;
  awaitedType(type: MacroType): MacroType;
  classifyCanonicalFailureType(type: MacroType): CanonicalFailureInfo | null;
  classifyCanonicalResultCarrierType(type: MacroType): CanonicalResultCarrierInfo | null;
  classifyCanonicalResultType(type: MacroType): CanonicalResultInfo | null;
  classifyTryCarrierType(type: MacroType): MacroTryCarrierInfo | null;
  exprType(expr: ExprSyntax): MacroType | null;
  enclosingFunction(): MacroFunctionContext | null;
  finiteCases(type: MacroType): readonly MacroFiniteCase[] | null;
  isAssignable(from: MacroType, to: MacroType): boolean;
  localDeclaration(name: string, node?: MacroSyntaxNode): DeclSyntax | null;
  localDeclarationHasAnnotation(name: string, annotationName: string, node?: MacroSyntaxNode): boolean;
  nullType(): MacroType;
  parameterType(parameter: MacroParameterSyntax): MacroType | null;
  primaryExprEnclosingFunction(): MacroFunctionContext | null;
  primaryExprExpanded(): ExprSyntax | null;
  primaryExprPrelude(): readonly StmtSyntax[] | null;
  primaryExprCanonicalResultCarrier(): CanonicalResultCarrierInfo | null;
  primaryExprCanonicalResult(): CanonicalResultInfo | null;
  primaryExprContainsMacroInvocations(): boolean;
  primaryExprTryCarrier(): MacroTryCarrierInfo | null;
  primaryExprType(): MacroType | null;
  readSet(node: ExprSyntax | BlockSyntax): MacroDependencySet;
  undefinedType(): MacroType;
  valueBindingPromiseLikeInScope(name: string, node?: MacroSyntaxNode): boolean;
  valueBindingCallableInScope(name: string, node?: MacroSyntaxNode): boolean;
  valueBindingTypeInScope(name: string, node?: MacroSyntaxNode): MacroType | null;
  valueBindingInScope(name: string, node?: MacroSyntaxNode): boolean;
  writeSet(node: ExprSyntax | BlockSyntax): MacroDependencySet;
}
export type MacroPlacement = {
  readonly kind: 'statement-region';
} | {
  readonly kind: 'unsupported';
  readonly reason: 'multi-declaration' | 'unsupported-site';
};
export interface MacroFresh {
  binding(hint: string): string;
}
export interface MacroControlFlow {
  deferCleanup(cleanup: BlockSyntax | readonly StmtSyntax[]): MacroScopeExitOutput;
  freshBinding(hint: string): string;
  placement(): MacroPlacement;
  rewriteWithValue(
    preludeStatements: readonly StmtSyntax[],
    replacementExpr: ExprSyntax,
  ): MacroValueRewriteOutput;
}
export type MacroExpand<Signature extends MacroSignature | undefined = undefined> = (
  ctx: MacroContext,
  signature: Signature extends MacroSignature ? MacroDecodedSignature<Signature> : null,
) => MacroOutput;
export interface MacroSyntaxNode {
  readonly data?: unknown;
  readonly kind: string;
  readonly span: SourceSpan;
}
export type MacroQuoteValue =
  | MacroSyntaxNode
  | readonly MacroSyntaxNode[]
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined;
export interface MacroFormatContext {
  formatBlock(text: string): string;
  formatExpression(text: string): string;
  readonly node: MacroSyntaxNode;
}
export interface MacroHoverContext {
  readonly node: MacroSyntaxNode;
  readonly offset: number;
}
export interface MacroPositionHoverContext {
  readonly macro: MacroContext;
  readonly node: MacroSyntaxNode;
  readonly offset: number;
}
export interface MacroAnalysisContext {
  readonly macro: MacroContext;
  readonly node: MacroSyntaxNode;
  readonly offset: number;
}
export interface MacroHoverResult {
  readonly contents: string;
}
export interface MacroCompletionContext {
  readonly node: MacroSyntaxNode;
  readonly offset: number;
}
export interface MacroCompletionItem {
  readonly detail?: string;
  readonly label: string;
}
export interface MacroBindingOccurrence {
  readonly bindingId: string;
  readonly kind: 'declaration' | 'reference';
  readonly name: string;
  readonly span: SourceSpan;
}
export interface MacroBindingsContext {
  readonly node: MacroSyntaxNode;
}
export interface MacroSemanticToken {
  readonly modifiers?: readonly string[];
  readonly span: SourceSpan;
  readonly type: string;
}
export interface MacroSemanticTokensContext {
  readonly node: MacroSyntaxNode;
}
export interface MacroEmbeddedFragment {
  readonly bindings?: readonly MacroBindingOccurrence[];
  readonly completions?: (sourcePosition: number) => readonly MacroCompletionItem[];
  readonly format?: (ctx: Pick<MacroFormatContext, 'formatBlock' | 'formatExpression'>) => string;
  readonly hover?: (sourcePosition: number) => MacroHoverResult | null;
  readonly language: string;
  readonly semanticTokens?: readonly MacroSemanticToken[];
  readonly span: SourceSpan;
}
export interface MacroDefinitionCapabilities<
  Signature extends MacroSignature | undefined = MacroSignature | undefined,
> {
  readonly analysisRegion?: (ctx: MacroAnalysisContext) => MacroAnalysisRegion | null;
  readonly bindings?: (ctx: MacroBindingsContext) => readonly MacroBindingOccurrence[];
  readonly completions?: (ctx: MacroCompletionContext) => readonly MacroCompletionItem[];
  /** Narrows which module-scope declaration kinds a `// #[macro(decl)]` factory accepts. */
  readonly declarationKinds?: readonly MacroDeclarationKind[];
  /** Controls whether a declaration macro replaces the declaration or preserves it and appends siblings. */
  readonly expansionMode?: MacroDeclarationExpansionMode;
  readonly expand: MacroExpand<Signature>;
  readonly format?: (ctx: MacroFormatContext) => string;
  readonly fragments?: (ctx: MacroContext) => readonly MacroEmbeddedFragment[];
  readonly hover?: (ctx: MacroHoverContext) => MacroHoverResult | null;
  readonly positionHover?: (ctx: MacroPositionHoverContext) => MacroHoverResult | null;
  readonly parse?: (ctx: MacroContext) => MacroSyntaxNode;
  readonly semanticTokens?: (ctx: MacroSemanticTokensContext) => readonly MacroSemanticToken[];
  readonly signature?: Signature;
}
export interface MacroDefinition<
  Signature extends MacroSignature | undefined = MacroSignature | undefined,
> {
  readonly analysisRegion?: MacroDefinitionCapabilities<Signature>['analysisRegion'];
  readonly bindings?: MacroDefinitionCapabilities<Signature>['bindings'];
  readonly completions?: MacroDefinitionCapabilities<Signature>['completions'];
  /** Narrows which module-scope declaration kinds a `// #[macro(decl)]` factory accepts. */
  readonly declarationKinds?: MacroDefinitionCapabilities<Signature>['declarationKinds'];
  /** Controls whether a declaration macro replaces the declaration or preserves it and appends siblings. */
  readonly expansionMode?: MacroDefinitionCapabilities<Signature>['expansionMode'];
  readonly expand: MacroExpand<Signature>;
  readonly format?: MacroDefinitionCapabilities<Signature>['format'];
  readonly fragments?: MacroDefinitionCapabilities<Signature>['fragments'];
  readonly hover?: MacroDefinitionCapabilities<Signature>['hover'];
  readonly positionHover?: MacroDefinitionCapabilities<Signature>['positionHover'];
  readonly parse?: MacroDefinitionCapabilities<Signature>['parse'];
  readonly semanticTokens?: MacroDefinitionCapabilities<Signature>['semanticTokens'];
  readonly signature?: MacroDefinitionCapabilities<Signature>['signature'];
}
type MacroSignatureCaseCandidates = MacroSignature | MacroSignatureCase;
type MacroSignatureCasesForCandidate<Candidate> = Candidate extends MacroSignature<infer Cases>
  ? Cases
  : Candidate extends MacroSignatureCase ? readonly [Candidate]
  : never;
type NormalizeMacroSignatureCases<Candidates extends readonly unknown[]> = Candidates extends
  readonly [infer First, ...infer Rest]
  ? [...MacroSignatureCasesForCandidate<First>, ...NormalizeMacroSignatureCases<Rest>]
  : [];
export declare function formatMacroSignatureExamples(
  signature: MacroSignature,
  macroName: string,
): readonly string[];
export declare function formatMacroSignature(signature: MacroSignature, macroName: string): string;
export declare function tryReadMacroSignature<const Signature extends MacroSignature>(
  signature: Signature,
  ctx: Pick<MacroContext, 'declarationSpan' | 'hasBlock' | 'invocation' | 'syntax'>,
): MacroDecodedSignature<Signature> | null;
export declare function readMacroSignature<const Signature extends MacroSignature>(
  signature: Signature,
  ctx: Pick<
    MacroContext,
    'declarationSpan' | 'error' | 'hasBlock' | 'invocation' | 'name' | 'syntax'
  >,
): MacroDecodedSignature<Signature>;
declare function macroSignatureBlock<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'block', Name, false, BlockSyntax>;
declare function macroSignatureCase<const Operands extends readonly MacroSignatureOperand[]>(
  ...operands: Operands
): MacroSignatureCase<null, Operands>;
declare function macroSignatureCase<
  const CaseName extends string,
  const Operands extends readonly MacroSignatureOperand[],
>(caseName: CaseName, ...operands: Operands): MacroSignatureCase<CaseName, Operands>;
declare function macroSignatureDecl<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'decl', Name, false, DeclSyntax>;
declare function macroSignatureExpr<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'expr', Name, false, ExprSyntax>;
declare function macroSignatureArrayLiteral<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'expr', Name, false, MacroArrayLiteralExprSyntax>;
declare function macroSignatureCall<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'expr', Name, false, MacroCallExprSyntax>;
declare function macroSignatureFunctionExpr<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'expr', Name, false, MacroFunctionExprSyntax>;
declare function macroSignatureIdentifier<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'expr', Name, false, MacroIdentifierExprSyntax>;
declare function macroSignatureOf<const Operands extends readonly MacroSignatureOperand[]>(
  ...operands: Operands
): MacroSignature<readonly [MacroSignatureCase<null, Operands>]>;
declare function macroSignatureOneOf<const Cases extends readonly MacroSignatureCaseCandidates[]>(
  ...cases: Cases
): MacroSignature<NormalizeMacroSignatureCases<Cases>>;
declare function macroSignatureOptional<const Operand extends MacroSignatureOperand>(
  operand: Operand,
): MacroSignatureOperand<
  Operand['kind'],
  Operand['name'],
  true,
  MacroSignatureOperandDecodedValue<Operand> extends infer Value
    ? Exclude<Value, null> & MacroDecodedSignatureValue
    : never
>;
declare function macroSignatureSignature<const Operands extends readonly MacroSignatureOperand[]>(
  ...operands: Operands
): MacroSignature<readonly [MacroSignatureCase<null, Operands>]>;
declare function macroSignatureTemplate<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'template', Name, false, MacroTemplateOperand>;
declare function macroSignatureClassDecl<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'decl', Name, false, MacroClassDeclSyntax>;
declare function macroSignatureFunctionDecl<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'decl', Name, false, MacroFunctionDeclSyntax>;
declare function macroSignatureInterfaceDecl<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'decl', Name, false, MacroInterfaceDeclSyntax>;
declare function macroSignatureTypeAliasDecl<const Name extends string>(name: Name, options?: {
  description?: string;
}): MacroSignatureOperand<'decl', Name, false, MacroTypeAliasDeclSyntax>;
declare function macroSignatureRefine<const Signature extends MacroSignature>(
  signature: Signature,
  validator: MacroSignatureValidator<Signature>,
): Signature;
export declare const macroSignature: {
  readonly arrayLiteral: typeof macroSignatureArrayLiteral;
  readonly block: typeof macroSignatureBlock;
  readonly case: typeof macroSignatureCase;
  readonly call: typeof macroSignatureCall;
  readonly classDecl: typeof macroSignatureClassDecl;
  readonly decl: typeof macroSignatureDecl;
  readonly expr: typeof macroSignatureExpr;
  readonly functionDecl: typeof macroSignatureFunctionDecl;
  readonly functionExpr: typeof macroSignatureFunctionExpr;
  readonly identifier: typeof macroSignatureIdentifier;
  readonly interfaceDecl: typeof macroSignatureInterfaceDecl;
  readonly of: typeof macroSignatureOf;
  readonly oneOf: typeof macroSignatureOneOf;
  readonly optional: typeof macroSignatureOptional;
  readonly refine: typeof macroSignatureRefine;
  readonly signature: typeof macroSignatureSignature;
  readonly template: typeof macroSignatureTemplate;
  readonly typeAliasDecl: typeof macroSignatureTypeAliasDecl;
};
export {};
