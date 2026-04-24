import ts from 'typescript';

// Internal TypeScript host parsing and synthesis helpers.
// Macro authors should depend on macro_api.ts instead of this module.

const SOUNDSCRIPT_ANNOTATION_COMMENT_PATTERN = /^\/\/\s*#\[/u;

function getFragmentScriptKind(fileName: string): ts.ScriptKind {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.sts') || lowered.endsWith('.tsx') || lowered.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lowered.endsWith('.js') || lowered.endsWith('.mjs') || lowered.endsWith('.cjs')) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function createFragmentSourceFile(
  hostFileName: string,
  suffix: string,
  text: string,
): ts.SourceFile {
  const match = /(\.[^.]+)$/u.exec(hostFileName);
  const extension = match ? match[1] : '.ts';
  const fragmentFileName = `/virtual/${suffix}${extension === '.sts' ? '.tsx' : extension}`;
  return ts.createSourceFile(
    fragmentFileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    getFragmentScriptKind(hostFileName),
  );
}

function sourceTextForNode(node: ts.Node): string | undefined {
  try {
    return node.getSourceFile?.().text;
  } catch {
    return undefined;
  }
}

function preserveLeadingAnnotationComments(node: ts.Node): void {
  if (node.kind <= ts.SyntaxKind.LastToken) {
    return;
  }
  if (node.pos < 0) {
    return;
  }

  const sourceText = sourceTextForNode(node);
  if (sourceText === undefined) {
    return;
  }

  for (const comment of ts.getLeadingCommentRanges(sourceText, node.pos) ?? []) {
    if (comment.kind !== ts.SyntaxKind.SingleLineCommentTrivia) {
      continue;
    }

    const commentText = sourceText.slice(comment.pos, comment.end);
    if (!SOUNDSCRIPT_ANNOTATION_COMMENT_PATTERN.test(commentText)) {
      continue;
    }

    ts.addSyntheticLeadingComment(
      node,
      ts.SyntaxKind.SingleLineCommentTrivia,
      commentText.slice('//'.length),
      true,
    );
  }
}

export function synthesizeHostNode<T extends ts.Node>(node: T): T {
  preserveLeadingAnnotationComments(node);
  ts.setTextRange(node, { pos: -1, end: -1 });
  ts.setOriginalNode(node, undefined);
  ts.forEachChild(node, (child) => {
    synthesizeHostNode(child);
  });
  return node;
}

function ensureNoParseDiagnostics(sourceFile: ts.SourceFile, message: string): void {
  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    throw new Error(message);
  }
}

export function parseHostExpression(
  hostFileName: string,
  code: string,
  message: string,
): ts.Expression {
  const sourceFile = createFragmentSourceFile(
    hostFileName,
    'macro_expr',
    `const __macro_expr = (${code});`,
  );
  ensureNoParseDiagnostics(sourceFile, message);
  if (sourceFile.statements.length !== 1) {
    throw new Error(message);
  }

  const [statement] = sourceFile.statements;
  if (
    !statement ||
    !ts.isVariableStatement(statement) ||
    statement.declarationList.declarations.length !== 1
  ) {
    throw new Error(message);
  }

  const [declaration] = statement.declarationList.declarations;
  if (
    !declaration?.initializer ||
    !ts.isParenthesizedExpression(declaration.initializer)
  ) {
    throw new Error(message);
  }

  return declaration.initializer.expression;
}

export function parseHostStatements(
  hostFileName: string,
  suffix: string,
  code: string,
  message: string,
): readonly ts.Statement[] {
  const sourceFile = createFragmentSourceFile(hostFileName, suffix, code);
  ensureNoParseDiagnostics(sourceFile, message);
  return [...sourceFile.statements];
}

export function parseSingleHostStatement(
  hostFileName: string,
  suffix: string,
  code: string,
  message: string,
): ts.Statement {
  const statements = parseHostStatements(hostFileName, suffix, code, message);
  if (statements.length !== 1) {
    throw new Error(message);
  }
  return statements[0]!;
}
