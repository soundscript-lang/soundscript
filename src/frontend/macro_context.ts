import ts from 'typescript';

import { createAnnotationLookup } from '../annotation_syntax.ts';
import { normalizeRuntimeContext, type RuntimeContext } from '../config.ts';
import { pathExistsSync, readBytesSync, readTextFileSync, runtimeEnv } from '../platform/host.ts';
import { dirname, isAbsolute, join, normalize } from '../platform/path.ts';
import type {
  BlockSyntax,
  DeclSyntax,
  ExprSyntax,
  MacroAnnotation,
  MacroArgumentView,
  MacroBuildFactory,
  MacroContext,
  MacroFresh,
  MacroHostAccess,
  MacroInvocationForm,
  MacroInvocationView,
  MacroOutputFactory,
  MacroQuoteFactory,
  MacroRuntimeAccess,
  MacroSyntaxAccess,
  MacroSyntaxNode,
  MacroTemplateOperand,
  StmtSyntax,
} from './macro_api.ts';
import { createMacroError } from './macro_errors.ts';
import {
  parseHostStatements,
  parseSingleHostStatement,
  synthesizeHostNode,
} from './macro_host_ast_internal.ts';
import {
  buildArrowFunctionExprSyntax,
  buildAssignmentExprSyntax,
  buildBinaryExprSyntax,
  buildBlockSyntax,
  buildBooleanLiteralExprSyntax,
  buildCallExprSyntax,
  buildClassFieldSyntax,
  buildClassGetterSyntax,
  buildClassMethodSyntax,
  buildClassSetterSyntax,
  buildConstDeclStmtSyntax,
  buildElementAccessExprSyntax,
  buildExprStmtSyntax,
  buildForStmtSyntax,
  buildFunctionDeclSyntax,
  buildIdentifierExprSyntax,
  buildIfStmtSyntax,
  buildLetDeclStmtSyntax,
  buildNewExprSyntax,
  buildNullLiteralExprSyntax,
  buildNumberLiteralExprSyntax,
  buildObjectLiteralExprSyntax,
  buildOptionalMethodCallExprSyntax,
  buildPropertyAccessExprSyntax,
  buildReturnStmtSyntax,
  buildStringLiteralExprSyntax,
  buildThisExprSyntax,
  buildThrowStmtSyntax,
  buildUnaryExprSyntax,
  createArgumentSyntaxFromText,
  createBareArgumentSyntax,
  createBlockSyntaxFromText,
  createClassMemberSyntaxListFromCode,
  createDeclSyntaxFromText,
  createExprSyntaxFromText,
  createInvocationSyntax,
  createStmtListSyntaxFromCode,
  createStmtSyntaxFromNode,
  createTemplateSyntaxFromPieces,
  getHostBlock,
  getHostDeclaration,
  getHostExpression,
  getHostNode,
  getHostStatement,
  quoteText,
  updateClassSyntax,
} from './macro_syntax_internal.ts';
import {
  createMacroExprOutput,
  createMacroStmtListOutput,
  createMacroStmtOutput,
  type MacroRuntimeImportRequest,
} from './macro_output.ts';
import type { ResolvedMacroPlaceholder } from './macro_resolver.ts';
import { parseTemplateOperand } from './macro_templates.ts';
import type { ParsedMacroInvocation, SourceSpan } from './macro_types.ts';
import type { MacroRuntimeImportResolver } from './macro_runtime_support.ts';

export interface BaseMacroContext {
  readonly build: MacroBuildFactory;
  readonly fresh: MacroFresh;
  readonly host: MacroHostAccess;
  readonly invocation: MacroInvocationView;
  readonly kind: 'expr' | 'stmt';
  readonly name: string;
  readonly output: MacroOutputFactory;
  readonly quote: MacroQuoteFactory;
  readonly runtime: MacroRuntimeAccess;
  readonly syntax: MacroSyntaxAccess;
  blockSpan(): SourceSpan | null;
  declarationSpan(): SourceSpan | null;
  error(message: string, node?: MacroSyntaxNode): never;
  hasBlock(): boolean;
  invocationSpan(): SourceSpan;
  location(): { readonly column: number; readonly filePath: string; readonly line: number };
  parsedSyntax(): MacroSyntaxNode | null;
  runtimeImports(): readonly MacroRuntimeImportRequest[];
  sourceText(): string;
}

const DEFAULT_MACRO_RUNTIME_CONTEXT = normalizeRuntimeContext({
  externs: [],
  target: 'js-node',
});

function sanitizeBindingHint(hint: string): string {
  const sanitized = hint.replace(/[^A-Za-z0-9_$]/g, '_');
  return sanitized.length > 0 ? sanitized : '__sts_macro_tmp';
}

function createFreshBindingFactory(seed: string): MacroFresh {
  let counter = 0;
  return {
    binding(hint: string): string {
      counter += 1;
      return `${sanitizeBindingHint(hint)}_${seed}_${counter}`;
    },
  };
}

interface MacroRuntimeTracker {
  readonly access: MacroRuntimeAccess;
  snapshot(): readonly MacroRuntimeImportRequest[];
}

interface MacroEnvGlobal {
  __STS_MACRO_ENV__?: Readonly<Record<string, string>>;
}

function createUnsupportedHostAccess(reason: string): MacroHostAccess {
  const fail = () => {
    throw new Error(reason);
  };
  return {
    env: {
      get() {
        return fail();
      },
      require() {
        return fail();
      },
    },
    fs: {
      exists() {
        return fail();
      },
      readBytes() {
        return fail();
      },
      readText() {
        return fail();
      },
    },
  };
}

function resolveHostPath(
  path: string,
  options: { readonly macroFileName: string; readonly projectDirectory: string },
  base: 'macro' | 'project' = 'macro',
): string {
  if (isAbsolute(path)) {
    throw new Error(
      `Macro host path "${path}" must be relative to the macro module or project root. Absolute host paths are not supported.`,
    );
  }
  const root = base === 'project' ? options.projectDirectory : dirname(options.macroFileName);
  return normalize(join(root, path));
}

export function createHostAccess(
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly readBytes?: (path: string) => Uint8Array | undefined;
    readonly fileExists?: (path: string) => boolean;
    readonly macroFileName: string;
    readonly projectDirectory: string;
    readonly readFile?: (path: string) => string | undefined;
  },
): MacroHostAccess {
  const textEncoder = new TextEncoder();
  const envSnapshot = options.env ??
    (globalThis as typeof globalThis & MacroEnvGlobal).__STS_MACRO_ENV__;

  return {
    env: {
      get(name: string) {
        return envSnapshot ? envSnapshot[name] : runtimeEnv(name);
      },
      require(name: string) {
        const value = envSnapshot ? envSnapshot[name] : runtimeEnv(name);
        if (value === undefined) {
          throw new Error(`Macro host environment variable "${name}" is not set.`);
        }
        return value;
      },
    },
    fs: {
      exists(path: string, pathOptions = {}) {
        const resolvedPath = resolveHostPath(path, options, pathOptions.base);
        if (options.fileExists) {
          return options.fileExists(resolvedPath);
        }
        return pathExistsSync(resolvedPath);
      },
      readBytes(path: string, pathOptions = {}) {
        const resolvedPath = resolveHostPath(path, options, pathOptions.base);
        const bytes = options.readBytes?.(resolvedPath);
        if (bytes !== undefined) {
          return bytes;
        }
        const text = options.readFile?.(resolvedPath);
        if (text !== undefined) {
          return textEncoder.encode(text);
        }
        return readBytesSync(resolvedPath);
      },
      readText(path: string, pathOptions = {}) {
        const resolvedPath = resolveHostPath(path, options, pathOptions.base);
        const text = options.readFile?.(resolvedPath);
        if (text !== undefined) {
          return text;
        }
        return readTextFileSync(resolvedPath);
      },
    },
  };
}

function createUnsupportedRuntimeAccess(
  reason: string,
  runtimeContext: RuntimeContext,
): MacroRuntimeAccess {
  return {
    backend: runtimeContext.backend,
    default() {
      throw new Error(reason);
    },
    externs() {
      return [...runtimeContext.externs];
    },
    host: runtimeContext.host,
    named() {
      throw new Error(reason);
    },
    namespace() {
      throw new Error(reason);
    },
    target: runtimeContext.target,
  };
}

function createRuntimeTracker(
  build: MacroBuildFactory,
  runtimeResolver: MacroRuntimeImportResolver | null,
  runtimeContext: RuntimeContext,
): MacroRuntimeTracker {
  if (!runtimeResolver) {
    return {
      access: createUnsupportedRuntimeAccess(
        'This macro requires runtime import resolution, but no prepared program or macro module metadata was available.',
        runtimeContext,
      ),
      snapshot() {
        return [];
      },
    };
  }

  const activeRuntimeResolver = runtimeResolver;

  const byKey = new Map<string, MacroRuntimeImportRequest>();
  function record(
    kind: MacroRuntimeImportRequest['kind'],
    specifier: string,
    exportName?: string,
  ): ExprSyntax {
    const resolved = activeRuntimeResolver.resolve({ exportName, kind, specifier });
    byKey.set(
      `${resolved.kind}\u0000${resolved.specifier}\u0000${resolved.exportName ?? ''}`,
      resolved,
    );
    return build.identifier(resolved.localName);
  }

  return {
    access: {
      backend: runtimeContext.backend,
      default(specifier: string) {
        return record('default', specifier);
      },
      externs() {
        return [...runtimeContext.externs];
      },
      host: runtimeContext.host,
      named(specifier: string, exportName: string) {
        return record('named', specifier, exportName);
      },
      namespace(specifier: string) {
        return record('namespace', specifier);
      },
      target: runtimeContext.target,
    },
    snapshot() {
      return [...byKey.values()];
    },
  };
}

function sliceSpan(text: string, span: SourceSpan): string {
  return text.slice(span.start, span.end);
}

function getLineAndColumn(text: string, position: number): { column: number; line: number } {
  let line = 1;
  let column = 1;

  for (let index = 0; index < position; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { column, line };
}

function scriptKindForOriginalFile(fileName: string): ts.ScriptKind {
  const lowerFileName = fileName.toLowerCase();
  if (lowerFileName.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lowerFileName.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  if (
    lowerFileName.endsWith('.js') || lowerFileName.endsWith('.mjs') ||
    lowerFileName.endsWith('.cjs')
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createAttachedAnnotationReader(
  originalText: string,
): (node: MacroSyntaxNode) => readonly MacroAnnotation[] {
  let originalSourceFile: ts.SourceFile | null = null;
  let originalLookup: ReturnType<typeof createAnnotationLookup> | null = null;

  const sourceFileForNode = (node: MacroSyntaxNode): ts.SourceFile => {
    if (originalSourceFile) {
      return originalSourceFile;
    }
    originalSourceFile = ts.createSourceFile(
      node.span.fileName,
      originalText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForOriginalFile(node.span.fileName),
    );
    return originalSourceFile;
  };

  const lookupForNode = (node: MacroSyntaxNode) => {
    if (originalLookup) {
      return originalLookup;
    }
    originalLookup = createAnnotationLookup(sourceFileForNode(node));
    return originalLookup;
  };

  const findOriginalNodeForSyntaxNode = (node: MacroSyntaxNode): ts.Node | null => {
    const sourceFile = sourceFileForNode(node);
    let match: ts.Node | null = null;

    const visit = (current: ts.Node): void => {
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
  };

  return (node: MacroSyntaxNode) => {
    const originalNode = findOriginalNodeForSyntaxNode(node);
    if (originalNode) {
      return lookupForNode(node).getAttachedAnnotations(originalNode);
    }
    const hostNode = getHostNode(node);
    return hostNode
      ? createAnnotationLookup(hostNode.getSourceFile()).getAttachedAnnotations(hostNode)
      : [];
  };
}

function toInvocationForm(invocation: ParsedMacroInvocation): MacroInvocationForm {
  switch (invocation.invocationKind) {
    case 'block':
      return 'block';
    case 'arglist':
      return 'arglist';
    case 'arglist+block':
      return 'arglist';
    case 'decl':
      return 'decl';
    case 'arglist+decl':
      return 'arglist_decl';
  }
}

function getPrimaryExprSpan(invocation: ParsedMacroInvocation): SourceSpan | undefined {
  if (getBlockSpan(invocation) || getDeclarationSpan(invocation)) {
    return undefined;
  }

  const expressionArguments = invocation.argumentSpans.filter((argument) =>
    argument.kind === 'ExprArg'
  );
  if (
    expressionArguments.length !== 1 ||
    expressionArguments.length !== invocation.argumentSpans.length
  ) {
    return undefined;
  }

  return expressionArguments[0]?.span;
}

function getBlockSpan(invocation: ParsedMacroInvocation): SourceSpan | undefined {
  if (invocation.trailingBlockSpan) {
    return invocation.trailingBlockSpan;
  }

  if (invocation.invocationKind === 'block') {
    const [firstArgument] = invocation.argumentSpans;
    if (firstArgument?.kind === 'BlockArg') {
      return firstArgument.span;
    }
  }

  return undefined;
}

function getDeclarationSpan(invocation: ParsedMacroInvocation): SourceSpan | undefined {
  return invocation.declarationSpan;
}

function createInvocationView(
  invocation: ParsedMacroInvocation,
  originalText: string,
): MacroInvocationView {
  const normalizedArguments = invocation.argumentSpans.filter((argument) =>
    argument.kind === 'ExprArg'
  );
  const args: MacroArgumentView[] = normalizedArguments.map((argument, index) =>
    createBareArgumentSyntax(index, argument.span, sliceSpan(originalText, argument.span))
  );

  return {
    args,
    form: toInvocationForm(invocation),
    hasBlock: getBlockSpan(invocation) !== undefined,
    name: invocation.nameText,
  };
}

function createQuoteFactory(fileName: string): MacroQuoteFactory {
  function interpolate(strings: TemplateStringsArray, values: readonly unknown[]): string {
    let output = '';
    for (let index = 0; index < strings.length; index += 1) {
      output += strings[index] ?? '';
      if (index < values.length) {
        output += quoteText(values[index]);
      }
    }
    return output;
  }

  return {
    block(strings, ...values) {
      const code = interpolate(strings, values);
      return createBlockSyntaxFromText(
        fileName,
        { fileName, start: 0, end: code.length },
        code,
      );
    },
    classMembers(strings, ...values) {
      const code = interpolate(strings, values);
      return createClassMemberSyntaxListFromCode(fileName, code);
    },
    decl(strings, ...values) {
      const code = interpolate(strings, values);
      return createDeclSyntaxFromText(
        fileName,
        { fileName, start: 0, end: code.length },
        code,
      );
    },
    expr(strings, ...values) {
      const code = interpolate(strings, values);
      return createExprSyntaxFromText(
        fileName,
        { fileName, start: 0, end: code.length },
        code,
      );
    },
    stmt(strings, ...values) {
      const code = interpolate(strings, values);
      const statement = parseSingleHostStatement(
        fileName,
        'macro_quote_stmt',
        code,
        'Quoted macro statements must parse as exactly one host-language statement.',
      );
      return createStmtSyntaxFromNode(
        statement,
        statement.getSourceFile(),
        { fileName, start: 0, end: code.length },
      );
    },
    stmts(strings, ...values) {
      const code = interpolate(strings, values);
      return createStmtListSyntaxFromCode(fileName, 'macro_quote_stmt_list', code);
    },
  };
}

function createBuildFactory(fileName: string): MacroBuildFactory {
  return {
    assign(target, value) {
      return buildAssignmentExprSyntax(fileName, target, value);
    },
    arrowFunction(parameters, body) {
      return buildArrowFunctionExprSyntax(fileName, parameters, body);
    },
    binary(left, operator, right) {
      return buildBinaryExprSyntax(fileName, left, operator, right);
    },
    block(statements) {
      return buildBlockSyntax(fileName, statements);
    },
    booleanLiteral(value) {
      return buildBooleanLiteralExprSyntax(fileName, value);
    },
    call(callee, args) {
      return buildCallExprSyntax(fileName, callee, args);
    },
    constDecl(name, initializer) {
      return buildConstDeclStmtSyntax(fileName, name, initializer);
    },
    element(object, index) {
      return buildElementAccessExprSyntax(fileName, object, index);
    },
    exprStmt(expression) {
      return buildExprStmtSyntax(fileName, expression);
    },
    field(options) {
      return buildClassFieldSyntax(fileName, options);
    },
    forStmt(options) {
      return buildForStmtSyntax(fileName, options);
    },
    identifier(name) {
      return buildIdentifierExprSyntax(fileName, name);
    },
    ifStmt(options) {
      return buildIfStmtSyntax(fileName, options);
    },
    functionDecl(options) {
      return buildFunctionDeclSyntax(fileName, options);
    },
    getter(options) {
      return buildClassGetterSyntax(fileName, options);
    },
    letDecl(name, initializer) {
      return buildLetDeclStmtSyntax(fileName, name, initializer);
    },
    method(options) {
      return buildClassMethodSyntax(fileName, options);
    },
    newExpr(callee, args) {
      return buildNewExprSyntax(fileName, callee, args);
    },
    nullLiteral() {
      return buildNullLiteralExprSyntax(fileName);
    },
    numberLiteral(value) {
      return buildNumberLiteralExprSyntax(fileName, value);
    },
    objectLiteral(members) {
      return buildObjectLiteralExprSyntax(fileName, members);
    },
    optionalMethodCall(receiver, name, args) {
      return buildOptionalMethodCallExprSyntax(fileName, receiver, name, args);
    },
    property(object, name) {
      return buildPropertyAccessExprSyntax(fileName, object, name);
    },
    returnStmt(expression) {
      return buildReturnStmtSyntax(fileName, expression);
    },
    setter(options) {
      return buildClassSetterSyntax(fileName, options);
    },
    stringLiteral(value) {
      return buildStringLiteralExprSyntax(fileName, value);
    },
    thisExpr() {
      return buildThisExprSyntax(fileName);
    },
    throwStmt(expression) {
      return buildThrowStmtSyntax(fileName, expression);
    },
    unary(operator, value) {
      return buildUnaryExprSyntax(fileName, operator, value);
    },
    updateClass(base, members) {
      return updateClassSyntax(base, members);
    },
  };
}

function createOutputFactory(runtimeTracker: MacroRuntimeTracker): MacroOutputFactory {
  return {
    expr(node: ExprSyntax) {
      return createMacroExprOutput(
        synthesizeHostNode(getHostExpression(node)),
        runtimeTracker.snapshot(),
      );
    },
    stmt(node: StmtSyntax | DeclSyntax) {
      return createMacroStmtOutput(
        synthesizeHostNode(getHostStatement(node)),
        runtimeTracker.snapshot(),
      );
    },
    stmts(nodes: readonly (StmtSyntax | DeclSyntax)[]) {
      return createMacroStmtListOutput(
        nodes.map((node) => synthesizeHostNode(getHostStatement(node))),
        runtimeTracker.snapshot(),
      );
    },
  };
}

export function createMacroContext(
  resolved: ResolvedMacroPlaceholder,
  runtimeResolver: MacroRuntimeImportResolver | null = null,
  hostAccess: MacroHostAccess = createUnsupportedHostAccess(
    'This macro requires compile-time host access, but no prepared program or macro module metadata was available.',
  ),
  runtimeContext: RuntimeContext = DEFAULT_MACRO_RUNTIME_CONTEXT,
): BaseMacroContext {
  const invocation = resolved.placeholder.invocation;
  const originalText = resolved.placeholder.preparedFile.originalText;
  const attachedAnnotationsForNode = createAttachedAnnotationReader(originalText);
  const invocationView = createInvocationView(invocation, originalText);
  const parsedTemplateArgs = new Map<number, MacroTemplateOperand | null>();
  const parsedExprArgs = new Map<number, MacroArgumentView>();
  let parsedBlockSyntax: BlockSyntax | null | undefined;
  let parsedDeclarationSyntax: DeclSyntax | null | undefined;
  let parsedInvocationSyntax: ReturnType<typeof createInvocationSyntax> | null = null;
  const fresh = createFreshBindingFactory(String(resolved.placeholder.id));
  const build = createBuildFactory(invocation.span.fileName);
  const quote = createQuoteFactory(invocation.span.fileName);
  const runtimeTracker = createRuntimeTracker(build, runtimeResolver, runtimeContext);
  const output = createOutputFactory(runtimeTracker);

  const parseTemplateArgForContext = (index: number): MacroTemplateOperand | null => {
    if (parsedTemplateArgs.has(index)) {
      return parsedTemplateArgs.get(index) ?? null;
    }

    const argument = invocationView.args[index];
    const parsed = argument ? parseTemplateOperand(argument.span, argument.text()) : null;
    parsedTemplateArgs.set(index, parsed);
    return parsed;
  };

  const parseExprArgForContext = (index: number): MacroArgumentView => {
    const existing = parsedExprArgs.get(index);
    if (existing) {
      return existing;
    }

    const argument = invocationView.args[index];
    if (!argument) {
      throw new Error(`Macro "${invocation.nameText}" argument ${index} is out of range.`);
    }

    const syntax = createArgumentSyntaxFromText(
      index,
      invocation.span.fileName,
      argument.span,
      argument.text(),
    );
    parsedExprArgs.set(index, syntax);
    return syntax;
  };

  const parseBlockSyntaxForContext = (): BlockSyntax => {
    if (parsedBlockSyntax !== undefined) {
      if (parsedBlockSyntax === null) {
        throw new Error(`Macro "${invocation.nameText}" does not have a block argument.`);
      }
      return parsedBlockSyntax;
    }

    const blockSpan = getBlockSpan(invocation);
    if (!blockSpan) {
      parsedBlockSyntax = null;
      throw new Error(`Macro "${invocation.nameText}" does not have a block argument.`);
    }

    parsedBlockSyntax = createBlockSyntaxFromText(
      invocation.span.fileName,
      blockSpan,
      sliceSpan(originalText, blockSpan),
    );
    return parsedBlockSyntax;
  };

  const parseDeclarationSyntaxForContext = (): DeclSyntax => {
    if (parsedDeclarationSyntax !== undefined) {
      if (parsedDeclarationSyntax === null) {
        throw new Error(`Macro "${invocation.nameText}" does not have a declaration argument.`);
      }
      return parsedDeclarationSyntax;
    }

    const declarationSpan = getDeclarationSpan(invocation);
    if (!declarationSpan) {
      parsedDeclarationSyntax = null;
      throw new Error(`Macro "${invocation.nameText}" does not have a declaration argument.`);
    }

    parsedDeclarationSyntax = createDeclSyntaxFromText(
      invocation.span.fileName,
      declarationSpan,
      sliceSpan(originalText, declarationSpan),
    );
    return parsedDeclarationSyntax;
  };

  const parseInvocationSyntaxForContext = () => {
    if (parsedInvocationSyntax) {
      return parsedInvocationSyntax;
    }

    parsedInvocationSyntax = createInvocationSyntax({
      args: invocationView.args.map((_, index) => parseExprArgForContext(index)),
      block: getBlockSpan(invocation) ? parseBlockSyntaxForContext() : null,
      declaration: getDeclarationSpan(invocation) ? parseDeclarationSyntaxForContext() : null,
      form: invocationView.form,
      hasBlock: invocationView.hasBlock,
      name: invocation.nameText,
      span: invocation.span,
      text: sliceSpan(originalText, invocation.span),
    });
    return parsedInvocationSyntax;
  };

  return {
    build,
    fresh,
    host: hostAccess,
    invocation: invocationView,
    kind: invocation.rewriteKind,
    name: invocation.nameText,
    output,
    quote,
    runtime: runtimeTracker.access,
    syntax: {
      annotations(node: MacroSyntaxNode) {
        return attachedAnnotationsForNode(node);
      },
      arg(index: number) {
        return parseExprArgForContext(index);
      },
      args() {
        return invocationView.args.map((_, index) => parseExprArgForContext(index));
      },
      block() {
        return parseBlockSyntaxForContext();
      },
      declaration() {
        return parseDeclarationSyntaxForContext();
      },
      primaryExpr() {
        const exprSpan = getPrimaryExprSpan(invocation);
        if (!exprSpan) {
          throw new Error(
            `Macro "${invocation.nameText}" does not have a primary expression argument.`,
          );
        }
        return parseExprArgForContext(0);
      },
      root() {
        return parseInvocationSyntaxForContext();
      },
      template(index: number) {
        return parseTemplateArgForContext(index);
      },
    },
    blockSpan(): SourceSpan | null {
      return getBlockSpan(invocation) ?? null;
    },
    declarationSpan(): SourceSpan | null {
      return getDeclarationSpan(invocation) ?? null;
    },
    error(message: string, node?: MacroSyntaxNode): never {
      throw createMacroError(resolved, message, node?.span);
    },
    hasBlock(): boolean {
      return invocationView.hasBlock;
    },
    invocationSpan(): SourceSpan {
      return invocation.span;
    },
    location() {
      const start = getLineAndColumn(originalText, invocation.span.start);
      return {
        column: start.column,
        filePath: invocation.span.fileName,
        line: start.line,
      };
    },
    parsedSyntax() {
      return parseInvocationSyntaxForContext();
    },
    runtimeImports() {
      return runtimeTracker.snapshot();
    },
    sourceText(): string {
      return sliceSpan(originalText, invocation.span);
    },
  };
}

export function createSyntaxOnlyMacroContext(
  invocation: ParsedMacroInvocation,
  originalText: string,
  runtimeContext: RuntimeContext = DEFAULT_MACRO_RUNTIME_CONTEXT,
): MacroContext {
  const base = (() => {
    const attachedAnnotationsForNode = createAttachedAnnotationReader(originalText);
    const invocationView = createInvocationView(invocation, originalText);
    const parsedTemplateArgs = new Map<number, MacroTemplateOperand | null>();
    const parsedExprArgs = new Map<number, MacroArgumentView>();
    let parsedBlockSyntax: BlockSyntax | null | undefined;
    let parsedDeclarationSyntax: DeclSyntax | null | undefined;
    let parsedInvocationSyntax: ReturnType<typeof createInvocationSyntax> | null = null;
    const fresh = createFreshBindingFactory(`${invocation.span.start}_${invocation.span.end}`);
    const build = createBuildFactory(invocation.span.fileName);
    const quote = createQuoteFactory(invocation.span.fileName);
    const runtimeTracker = createRuntimeTracker(build, null, runtimeContext);
    const output = createOutputFactory(runtimeTracker);

    const parseTemplateArgForContext = (index: number): MacroTemplateOperand | null => {
      if (parsedTemplateArgs.has(index)) {
        return parsedTemplateArgs.get(index) ?? null;
      }

      const argument = invocationView.args[index];
      const parsed = argument ? parseTemplateOperand(argument.span, argument.text()) : null;
      parsedTemplateArgs.set(index, parsed);
      return parsed;
    };

    const parseExprArgForContext = (index: number): MacroArgumentView => {
      const existing = parsedExprArgs.get(index);
      if (existing) {
        return existing;
      }

      const argument = invocationView.args[index];
      if (!argument) {
        throw new Error(`Macro "${invocation.nameText}" argument ${index} is out of range.`);
      }

      const syntax = createArgumentSyntaxFromText(
        index,
        invocation.span.fileName,
        argument.span,
        argument.text(),
      );
      parsedExprArgs.set(index, syntax);
      return syntax;
    };

    const parseBlockSyntaxForContext = (): BlockSyntax => {
      if (parsedBlockSyntax !== undefined) {
        if (parsedBlockSyntax === null) {
          throw new Error(`Macro "${invocation.nameText}" does not have a block argument.`);
        }
        return parsedBlockSyntax;
      }

      const blockSpan = getBlockSpan(invocation);
      if (!blockSpan) {
        parsedBlockSyntax = null;
        throw new Error(`Macro "${invocation.nameText}" does not have a block argument.`);
      }

      parsedBlockSyntax = createBlockSyntaxFromText(
        invocation.span.fileName,
        blockSpan,
        sliceSpan(originalText, blockSpan),
      );
      return parsedBlockSyntax;
    };

    const parseDeclarationSyntaxForContext = (): DeclSyntax => {
      if (parsedDeclarationSyntax !== undefined) {
        if (parsedDeclarationSyntax === null) {
          throw new Error(`Macro "${invocation.nameText}" does not have a declaration argument.`);
        }
        return parsedDeclarationSyntax;
      }

      const declarationSpan = getDeclarationSpan(invocation);
      if (!declarationSpan) {
        parsedDeclarationSyntax = null;
        throw new Error(`Macro "${invocation.nameText}" does not have a declaration argument.`);
      }

      parsedDeclarationSyntax = createDeclSyntaxFromText(
        invocation.span.fileName,
        declarationSpan,
        sliceSpan(originalText, declarationSpan),
      );
      return parsedDeclarationSyntax;
    };

    const parseInvocationSyntaxForContext = () => {
      if (parsedInvocationSyntax) {
        return parsedInvocationSyntax;
      }

      parsedInvocationSyntax = createInvocationSyntax({
        args: invocationView.args.map((_, index) => parseExprArgForContext(index)),
        block: getBlockSpan(invocation) ? parseBlockSyntaxForContext() : null,
        declaration: getDeclarationSpan(invocation) ? parseDeclarationSyntaxForContext() : null,
        form: invocationView.form,
        hasBlock: invocationView.hasBlock,
        name: invocation.nameText,
        span: invocation.span,
        text: sliceSpan(originalText, invocation.span),
      });
      return parsedInvocationSyntax;
    };

    return {
      build,
      fresh,
      host: createUnsupportedHostAccess(
        'This macro requires compile-time host access, but only syntax-only context was available.',
      ),
      invocation: invocationView,
      kind: invocation.rewriteKind,
      name: invocation.nameText,
      output,
      quote,
      runtime: runtimeTracker.access,
      syntax: {
        annotations(node: MacroSyntaxNode) {
          return attachedAnnotationsForNode(node);
        },
        arg(index: number) {
          return parseExprArgForContext(index);
        },
        args() {
          return invocationView.args.map((_, index) => parseExprArgForContext(index));
        },
        block() {
          return parseBlockSyntaxForContext();
        },
        declaration() {
          return parseDeclarationSyntaxForContext();
        },
        primaryExpr() {
          const exprSpan = getPrimaryExprSpan(invocation);
          if (!exprSpan) {
            throw new Error(
              `Macro "${invocation.nameText}" does not have a primary expression argument.`,
            );
          }
          return parseExprArgForContext(0);
        },
        root() {
          return parseInvocationSyntaxForContext();
        },
        template(index: number) {
          return parseTemplateArgForContext(index);
        },
      },
      blockSpan(): SourceSpan | null {
        return getBlockSpan(invocation) ?? null;
      },
      declarationSpan(): SourceSpan | null {
        return getDeclarationSpan(invocation) ?? null;
      },
      error(message: string, _node?: MacroSyntaxNode): never {
        throw new Error(message);
      },
      hasBlock(): boolean {
        return invocationView.hasBlock;
      },
      invocationSpan(): SourceSpan {
        return invocation.span;
      },
      location() {
        const start = getLineAndColumn(originalText, invocation.span.start);
        return {
          column: start.column,
          filePath: invocation.span.fileName,
          line: start.line,
        };
      },
      parsedSyntax() {
        return parseInvocationSyntaxForContext();
      },
      runtimeImports() {
        return runtimeTracker.snapshot();
      },
      sourceText(): string {
        return sliceSpan(originalText, invocation.span);
      },
    } satisfies BaseMacroContext;
  })();

  const unsupported = (capability: string): never => {
    throw new Error(
      `Macro "${invocation.nameText}" cannot use ${capability} in syntax-only formatting contexts.`,
    );
  };

  return {
    ...base,
    controlFlow: {
      deferCleanup() {
        return unsupported('controlFlow.deferCleanup');
      },
      freshBinding() {
        return unsupported('controlFlow.freshBinding');
      },
      placement() {
        return unsupported('controlFlow.placement');
      },
      rewriteWithValue() {
        return unsupported('controlFlow.rewriteWithValue');
      },
    },
    reflect: {
      declarationShape() {
        return unsupported('reflect.declarationShape');
      },
      typeShape() {
        return unsupported('reflect.typeShape');
      },
    },
    semantics: {
      argExpanded() {
        return unsupported('semantics.argExpanded');
      },
      argType() {
        return unsupported('semantics.argType');
      },
      awaitedType() {
        return unsupported('semantics.awaitedType');
      },
      classDeclarationOfType() {
        return unsupported('semantics.classDeclarationOfType');
      },
      classifyCanonicalFailureType() {
        return unsupported('semantics.classifyCanonicalFailureType');
      },
      classifyCanonicalResultCarrierType() {
        return unsupported('semantics.classifyCanonicalResultCarrierType');
      },
      classifyCanonicalResultType() {
        return unsupported('semantics.classifyCanonicalResultType');
      },
      classifyTryCarrierType() {
        return unsupported('semantics.classifyTryCarrierType');
      },
      exprType() {
        return unsupported('semantics.exprType');
      },
      enclosingFunction() {
        return unsupported('semantics.enclosingFunction');
      },
      enclosingFunctionCanonicalResult() {
        return unsupported('semantics.enclosingFunctionCanonicalResult');
      },
      finiteCases() {
        return unsupported('semantics.finiteCases');
      },
      isAssignable() {
        return unsupported('semantics.isAssignable');
      },
      localDeclaration() {
        return unsupported('semantics.localDeclaration');
      },
      localDeclarationHasAnnotation() {
        return unsupported('semantics.localDeclarationHasAnnotation');
      },
      nullType() {
        return unsupported('semantics.nullType');
      },
      parameterType() {
        return unsupported('semantics.parameterType');
      },
      primaryExprEnclosingFunction() {
        return unsupported('semantics.primaryExprEnclosingFunction');
      },
      primaryExprEnclosingFunctionCanonicalResult() {
        return unsupported('semantics.primaryExprEnclosingFunctionCanonicalResult');
      },
      primaryExprExpanded() {
        return unsupported('semantics.primaryExprExpanded');
      },
      primaryExprPrelude() {
        return unsupported('semantics.primaryExprPrelude');
      },
      primaryExprCanonicalResultCarrier() {
        return unsupported('semantics.primaryExprCanonicalResultCarrier');
      },
      primaryExprCanonicalResult() {
        return unsupported('semantics.primaryExprCanonicalResult');
      },
      primaryExprContainsMacroInvocations() {
        return unsupported('semantics.primaryExprContainsMacroInvocations');
      },
      primaryExprTryCarrier() {
        return unsupported('semantics.primaryExprTryCarrier');
      },
      primaryExprType() {
        return unsupported('semantics.primaryExprType');
      },
      readSet() {
        return unsupported('semantics.readSet');
      },
      undefinedType() {
        return unsupported('semantics.undefinedType');
      },
      valueBindingPromiseLikeInScope() {
        return unsupported('semantics.valueBindingPromiseLikeInScope');
      },
      valueBindingCallableInScope() {
        return unsupported('semantics.valueBindingCallableInScope');
      },
      valueBindingHelperModeInScope() {
        return unsupported('semantics.valueBindingHelperModeInScope');
      },
      valueBindingTypeInScope() {
        return unsupported('semantics.valueBindingTypeInScope');
      },
      valueBindingInScope() {
        return unsupported('semantics.valueBindingInScope');
      },
      writeSet() {
        return unsupported('semantics.writeSet');
      },
    },
  };
}
