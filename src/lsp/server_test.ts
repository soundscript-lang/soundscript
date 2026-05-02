import { assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert';
import { dirname, join } from '@std/path';

import { createServer } from './server.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../../tests/support/test_installed_stdlib.ts';
import { createMemoryTransportPair } from './transport.ts';

const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'keyword',
  'class',
  'enum',
  'interface',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'function',
  'method',
] as const;

const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration',
  'readonly',
] as const;

async function createWorkspace(): Promise<string> {
  const workspace = await Deno.makeTempDir({ prefix: 'soundscript-lsp-' });
  await Deno.mkdir(join(workspace, 'src'), { recursive: true });
  await Deno.writeTextFile(
    join(workspace, 'tsconfig.json'),
    maybeNormalizeTsconfigForInstalledStdlib(
      'tsconfig.json',
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
        },
        null,
        2,
      ),
    ),
  );
  await Deno.writeTextFile(join(workspace, 'src/index.ts'), "export const value = 'ok';\n");
  await writeInstalledStdlibPackage(workspace);
  return workspace;
}

async function writeWorkspaceFiles(
  workspace: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [relativePath, text] of Object.entries(files)) {
    const filePath = join(workspace, relativePath);
    await Deno.mkdir(dirname(filePath), { recursive: true });
    await Deno.writeTextFile(
      filePath,
      maybeNormalizeTsconfigForInstalledStdlib(relativePath, text),
    );
  }
}

async function createPackageExportedMacroDriftWorkspace(): Promise<string> {
  const workspace = await Deno.makeTempDir({
    prefix: 'soundscript-lsp-package-exported-macro-drift-',
  });
  await Deno.mkdir(join(workspace, 'src'), { recursive: true });
  await writeInstalledStdlibPackage(workspace);
  await writeWorkspaceFiles(workspace, {
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/consumer.sts': [
      'import { Foo } from "sound-pkg/api";',
      'export const value: number = Foo();',
      '',
    ].join('\n'),
    'src/other.sts': ['export const shadow = 1;', ''].join('\n'),
    'node_modules/sound-pkg/package.json': JSON.stringify(
      {
        name: 'sound-pkg',
        version: '1.0.0',
        type: 'module',
        exports: {
          './api': {
            types: './dist/api.d.ts',
            import: './dist/api.js',
          },
        },
        soundscript: {
          version: 1,
          exports: {
            './api': {
              source: './src/api.sts',
            },
          },
        },
      },
      null,
      2,
    ),
    'node_modules/sound-pkg/dist/api.d.ts': 'export declare function Foo(): number;\n',
    'node_modules/sound-pkg/src/api.sts': 'export { Foo } from "./macros.macro.sts";\n',
    'node_modules/sound-pkg/src/macros.macro.sts': [
      "import 'sts:macros';",
      "import { helperExpression } from './helper.macro.sts';",
      '',
      '// #[macro(call)]',
      'export function Foo() {',
      '  return {',
      '    expand(ctx: any) {',
      '      return ctx.output.expr(ctx.quote.expr`${helperExpression}`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
    'node_modules/sound-pkg/src/helper.macro.sts': 'export const helperExpression = "1";\n',
  });
  return workspace;
}

async function createFunctionAdapterForwardingWorkspace(): Promise<string> {
  const workspace = await Deno.makeTempDir({
    prefix: 'soundscript-lsp-function-adapter-forwarding-',
  });
  await Deno.mkdir(join(workspace, 'src'), { recursive: true });
  await writeInstalledStdlibPackage(workspace);
  await writeWorkspaceFiles(workspace, {
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': [
      'import { auditedApply, auditedBind, auditedCall, pureCallback } from "./effects";',
      '',
      '// #[effects(forbid: [host])]',
      'export function runBind(): number {',
      '  return auditedBind(pureCallback, 1);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'export function runCall(): number {',
      '  return auditedCall(pureCallback, 1);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'export function runApply(): number {',
      '  return auditedApply(pureCallback, 1);',
      '}',
      '',
    ].join('\n'),
    'src/effects.sts': createFunctionAdapterForwardingEffectsSource(false),
  });
  return workspace;
}

function createFunctionAdapterForwardingEffectsSource(useFunctionAdapters: boolean): string {
  return [
    'export function pureCallback(value: number): number {',
    '  return value + 1;',
    '}',
    '',
    'export function auditedBind(callback: (value: number) => number, value: number): number {',
    ...(useFunctionAdapters
      ? [
        '  const invoke = callback.bind(undefined);',
        '  return invoke(value);',
      ]
      : [
        '  return callback(value);',
      ]),
    '}',
    '',
    'export function auditedCall(callback: (value: number) => number, value: number): number {',
    useFunctionAdapters ? '  return callback.call(undefined, value);' : '  return callback(value);',
    '}',
    '',
    'export function auditedApply(callback: (value: number) => number, value: number): number {',
    useFunctionAdapters
      ? '  return callback.apply(undefined, [value]);'
      : '  return callback(value);',
    '}',
    '',
  ].join('\n');
}

function createUserDefinedTwiceMacroText(): string {
  return [
    "import { macroSignature, type InvocationSyntax } from 'sts:macros';",
    '',
    '// #[macro(call)]',
    'export function Twice() {',
    '  return {',
    '    signature: macroSignature.of(macroSignature.expr("value")),',
    '    parse(ctx: any) {',
    '      return ctx.syntax.root();',
    '    },',
    '    hover() {',
    "      return { contents: ['**Doubles** the operand and yields the computed value.', '', '- Returns the computed result.'].join('\\n') };",
    '    },',
    '    semanticTokens(ctx: any) {',
    '      const invocation = ctx.node as InvocationSyntax;',
    '      const arg = invocation.args[0];',
    '      if (arg === undefined) {',
    "        throw new Error('expected arg');",
    '      }',
    "      return [{ span: arg.span, type: 'parameter' as const }];",
    '    },',
    '    format(ctx: any) {',
    '      const invocation = ctx.node as InvocationSyntax;',
    '      const arg = invocation.args[0];',
    '      if (arg === undefined) {',
    "        throw new Error('expected arg');",
    '      }',
    '      return `Twice(${ctx.formatExpression(arg.text())})`;',
    '    },',
    '    expand(ctx: any, signature: any) {',
    '      if (!signature) {',
    "        throw new Error('expected signature');",
    '      }',
    '      return ctx.output.expr(ctx.quote.expr`(${signature.args.value}) * 2`);',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

function createUserDefinedDeriveMacroText(): string {
  return [
    "import { macroSignature } from 'sts:macros';",
    '',
    '// #[macro(decl)]',
    'export function derive() {',
    '  return {',
    '    declarationKinds: ["class"] as const,',
    '    signature: macroSignature.of(macroSignature.decl("target")),',
    '    hover() {',
    "      return { contents: ['**Derives** sibling declarations from the annotated declaration.', '', '- Applies in declaration position.'].join('\\n') };",
    '    },',
    '    expand(ctx: any) {',
    '      return ctx.output.stmts([ctx.syntax.declaration()]);',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

function createUserDefinedAugmentMacroText(): string {
  return [
    "import { macroSignature } from 'sts:macros';",
    '',
    '// #[macro(decl)]',
    'export function augment() {',
    '  return {',
    '    declarationKinds: ["class"] as const,',
    "    expansionMode: 'augment' as const,",
    '    signature: macroSignature.of(macroSignature.decl("target")),',
    '    expand(ctx: any) {',
    '      const name = ctx.syntax.declaration().name ?? ctx.error("expected named declaration");',
    '      return ctx.output.stmt(',
    '        ctx.quote.stmt`export const ${`${name}Registry`} = ${name};`,',
    '      );',
    '    },',
    '  };',
    '}',
    '',
  ].join('\n');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function initializeServer(
  workspace: string,
  initializationOptions?: {
    capabilityMode?: 'full' | 'editor-bridge';
  },
) {
  const { client, server } = createMemoryTransportPair();
  const lsp = createServer(server);
  const startPromise = lsp.start();

  await client.sendRequest('initialize', {
    processId: null,
    rootUri: `file://${workspace}`,
    capabilities: {},
    initializationOptions,
  });
  await client.readResponse(1);

  return { client, startPromise };
}

async function shutdownServer(
  client: Awaited<ReturnType<typeof initializeServer>>['client'],
  startPromise: Promise<void>,
): Promise<void> {
  const shutdownRequestId = await client.sendRequest('shutdown', null);
  await client.readResponse(shutdownRequestId);
  await client.sendNotification('exit', null);
  await startPromise;
}

async function openDocumentAndAwaitDiagnostics(
  client: Awaited<ReturnType<typeof initializeServer>>['client'],
  {
    languageId,
    text,
    uri,
  }: {
    languageId: string;
    text: string;
    uri: string;
  },
  timeoutMessage: string,
): Promise<void> {
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId,
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    timeoutMessage,
  );
}

async function requestCodeActions(
  client: Awaited<ReturnType<typeof initializeServer>>['client'],
  uri: string,
  diagnostics: Array<{
    code?: string;
    data?: unknown;
    message?: string;
    range: {
      end: { character: number; line: number };
      start: { character: number; line: number };
    };
  }>,
  timeoutMessage: string,
): Promise<
  Array<{
    edit?: {
      changes?: Record<
        string,
        Array<{
          newText: string;
          range?: {
            end: { character: number; line: number };
            start: { character: number; line: number };
          };
        }>
      >;
    };
    kind?: string;
    title: string;
  }> | null
> {
  const codeActionRequestId = await client.sendRequest('textDocument/codeAction', {
    textDocument: { uri },
    range: diagnostics[0]?.range,
    context: {
      diagnostics,
    },
  });
  const codeActionResponse = await withTimeout(
    client.readResponse(codeActionRequestId),
    250,
    timeoutMessage,
  );
  return codeActionResponse.result as
    | Array<{
      edit?: {
        changes?: Record<
          string,
          Array<{
            newText: string;
            range?: {
              end: { character: number; line: number };
              start: { character: number; line: number };
            };
          }>
        >;
      };
      kind?: string;
      title: string;
    }>
    | null;
}

async function requestResult<TResult>(
  client: Awaited<ReturnType<typeof initializeServer>>['client'],
  method: string,
  params: unknown,
  timeoutMessage: string,
): Promise<TResult> {
  const requestId = await client.sendRequest(method, params);
  const response = await withTimeout(
    client.readResponse(requestId),
    250,
    timeoutMessage,
  );
  return response.result as TResult;
}

function decodeSemanticTokens(
  data: number[],
  text: string,
): Array<{
  lexeme: string;
  line: number;
  modifiers: string[];
  startCharacter: number;
  type: string;
}> {
  const tokens: Array<{
    lexeme: string;
    line: number;
    modifiers: string[];
    startCharacter: number;
    type: string;
  }> = [];
  let line = 0;
  let startCharacter = 0;

  for (let index = 0; index < data.length; index += 5) {
    line += data[index]!;
    startCharacter = data[index]! === 0 ? startCharacter + data[index + 1]! : data[index + 1]!;
    const length = data[index + 2]!;
    const type = SEMANTIC_TOKEN_TYPES[data[index + 3]!] ?? `unknown:${data[index + 3]}`;
    const modifierMask = data[index + 4]!;
    const modifiers = SEMANTIC_TOKEN_MODIFIERS.filter((_, modifierIndex) =>
      (modifierMask & (1 << modifierIndex)) !== 0
    );
    const lines = text.split('\n');
    const lexeme = lines[line]?.slice(startCharacter, startCharacter + length) ?? '';

    tokens.push({
      lexeme,
      line,
      modifiers,
      startCharacter,
      type,
    });
  }

  return tokens;
}

Deno.test('LSP server responds to initialize', async () => {
  const { client, server } = createMemoryTransportPair();
  const lsp = createServer(server);

  const startPromise = lsp.start();

  await client.sendRequest('initialize', {
    processId: null,
    rootUri: 'file:///workspace',
    capabilities: {},
  });

  const response = await client.readResponse(1);
  const initializeResult = response.result as {
    capabilities: {
      completionProvider?: {
        triggerCharacters?: string[];
      };
      definitionProvider?: boolean;
      documentHighlightProvider?: boolean;
      documentSymbolProvider?: boolean;
      codeActionProvider?: boolean | {
        codeActionKinds?: string[];
      };
      documentFormattingProvider?: boolean;
      executeCommandProvider?: {
        commands?: string[];
      };
      hoverProvider?: boolean;
      semanticTokensProvider?: {
        full?: boolean;
        legend?: {
          tokenModifiers?: string[];
          tokenTypes?: string[];
        };
      };
      signatureHelpProvider?: {
        triggerCharacters?: string[];
      };
      renameProvider?: {
        prepareProvider?: boolean;
      };
      referencesProvider?: boolean;
      textDocumentSync:
        | number
        | {
          change: number;
          openClose: boolean;
        };
    };
  };
  assertEquals(initializeResult.capabilities.textDocumentSync, {
    openClose: true,
    change: 1,
  });
  assertEquals(initializeResult.capabilities.completionProvider?.triggerCharacters, ['.']);
  assertEquals(initializeResult.capabilities.definitionProvider, true);
  assertEquals(initializeResult.capabilities.documentHighlightProvider, true);
  assertEquals(initializeResult.capabilities.documentSymbolProvider, true);
  assertEquals(initializeResult.capabilities.codeActionProvider, {
    codeActionKinds: ['quickfix'],
  });
  assertEquals(initializeResult.capabilities.documentFormattingProvider, true);
  assertEquals(initializeResult.capabilities.executeCommandProvider?.commands, [
    'soundscript.showExpandedSource',
    'soundscript.showMacroTrace',
  ]);
  assertEquals(initializeResult.capabilities.hoverProvider, true);
  assertEquals(initializeResult.capabilities.semanticTokensProvider?.full, true);
  assertEquals(initializeResult.capabilities.semanticTokensProvider?.legend?.tokenTypes, [
    ...SEMANTIC_TOKEN_TYPES,
  ]);
  assertEquals(
    initializeResult.capabilities.semanticTokensProvider?.legend?.tokenModifiers,
    [...SEMANTIC_TOKEN_MODIFIERS],
  );
  assertEquals(initializeResult.capabilities.signatureHelpProvider?.triggerCharacters, ['(', ',']);
  assertEquals(initializeResult.capabilities.renameProvider?.prepareProvider, true);
  assertEquals(initializeResult.capabilities.referencesProvider, true);

  await client.sendRequest('shutdown', null);
  await client.readResponse(2);
  await client.sendNotification('exit', null);
  await startPromise;
});

Deno.test('LSP server responds to initialize with reduced bridge capabilities', async () => {
  const { client, server } = createMemoryTransportPair();
  const lsp = createServer(server);

  const startPromise = lsp.start();

  await client.sendRequest('initialize', {
    processId: null,
    rootUri: 'file:///workspace',
    capabilities: {},
    initializationOptions: {
      capabilityMode: 'editor-bridge',
    },
  });

  const response = await client.readResponse(1);
  const initializeResult = response.result as {
    capabilities: {
      completionProvider?: {
        triggerCharacters?: string[];
      };
      definitionProvider?: boolean;
      documentHighlightProvider?: boolean;
      documentSymbolProvider?: boolean;
      codeActionProvider?: boolean | {
        codeActionKinds?: string[];
      };
      documentFormattingProvider?: boolean;
      executeCommandProvider?: {
        commands?: string[];
      };
      hoverProvider?: boolean;
      semanticTokensProvider?: {
        full?: boolean;
        legend?: {
          tokenModifiers?: string[];
          tokenTypes?: string[];
        };
      };
      signatureHelpProvider?: {
        triggerCharacters?: string[];
      };
      renameProvider?: {
        prepareProvider?: boolean;
      };
      referencesProvider?: boolean;
      textDocumentSync:
        | number
        | {
          change: number;
          openClose: boolean;
        };
    };
  };
  assertEquals(initializeResult.capabilities.textDocumentSync, {
    openClose: true,
    change: 1,
  });
  assertEquals(initializeResult.capabilities.documentFormattingProvider, true);
  assertEquals(initializeResult.capabilities.executeCommandProvider?.commands, [
    'soundscript.showExpandedSource',
    'soundscript.showMacroTrace',
  ]);
  assertEquals(initializeResult.capabilities.semanticTokensProvider?.full, true);
  assertEquals(initializeResult.capabilities.semanticTokensProvider?.legend?.tokenTypes, [
    ...SEMANTIC_TOKEN_TYPES,
  ]);
  assertEquals(
    initializeResult.capabilities.semanticTokensProvider?.legend?.tokenModifiers,
    [...SEMANTIC_TOKEN_MODIFIERS],
  );
  assertEquals(initializeResult.capabilities.codeActionProvider, {
    codeActionKinds: ['quickfix'],
  });
  assertEquals(initializeResult.capabilities.hoverProvider, true);
  assertEquals(initializeResult.capabilities.completionProvider?.triggerCharacters, ['.']);
  assertEquals(initializeResult.capabilities.definitionProvider, true);
  assertEquals(initializeResult.capabilities.documentHighlightProvider, undefined);
  assertEquals(initializeResult.capabilities.documentSymbolProvider, undefined);
  assertEquals(initializeResult.capabilities.signatureHelpProvider?.triggerCharacters, ['(', ',']);
  assertEquals(initializeResult.capabilities.renameProvider, undefined);
  assertEquals(initializeResult.capabilities.referencesProvider, undefined);

  await client.sendRequest('shutdown', null);
  await client.readResponse(2);
  await client.sendNotification('exit', null);
  await startPromise;
});

Deno.test('LSP server exposes expanded-source and macro-trace execute commands', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/macros.macro.sts': createUserDefinedTwiceMacroText(),
    'src/demo.sts': [
      "import { Twice } from './macros.macro';",
      'const value = 1;',
      'export const doubled = Twice(value);',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${join(workspace, 'src/demo.sts')}`;
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      languageId: 'soundscript',
      text: await Deno.readTextFile(join(workspace, 'src/demo.sts')),
      uri,
    },
    'Timed out waiting for diagnostics before macro debug commands.',
  );

  const expanded = await requestResult<{
    filePath: string;
    stage: string;
    text: string;
  }>(
    client,
    'workspace/executeCommand',
    {
      command: 'soundscript.showExpandedSource',
      arguments: [uri, 'expanded'],
    },
    'Timed out waiting for expanded-source command response.',
  );
  assertEquals(expanded.stage, 'expanded');
  assertStringIncludes(expanded.text, 'export const doubled =');
  assertStringIncludes(expanded.text, '* 2');

  const trace = await requestResult<{
    filePath: string;
    traces: Array<{ macroName: string; macroForm: string }>;
  }>(
    client,
    'workspace/executeCommand',
    {
      command: 'soundscript.showMacroTrace',
      arguments: [uri],
    },
    'Timed out waiting for macro-trace command response.',
  );
  assertEquals(trace.traces.length, 1);
  assertEquals(trace.traces[0]?.macroName, 'Twice');
  assertEquals(trace.traces[0]?.macroForm, 'call');

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server responds to hover using ordinary TypeScript types for .ts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const text = [
    'const dict = Object.create(null);',
    'void dict;',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before hover.',
  );

  const dictCharacter = text.indexOf('dict');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 0, character: dictCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('const dict: BareObject'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides scope completions for .ts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const lines = [
    'const localValue = 1;',
    'loc',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before completion.',
  );

  const completionRequestId = await client.sendRequest('textDocument/completion', {
    textDocument: { uri },
    position: { line: 1, character: lines[1]!.length },
  });
  const response = await withTimeout(
    client.readResponse(completionRequestId),
    250,
    'Timed out waiting for .ts completion response.',
  );
  const result = response.result as
    | Array<{
      detail?: string;
      kind?: number;
      label: string;
    }>
    | null;

  assertEquals(result?.some((entry) => entry.label === 'localValue'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides member completions for .ts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const lines = [
    'const obj = { alpha: 1, beta: 2 };',
    'obj.',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before member completion.',
  );

  const completionRequestId = await client.sendRequest('textDocument/completion', {
    textDocument: { uri },
    position: { line: 1, character: lines[1]!.length },
  });
  const response = await withTimeout(
    client.readResponse(completionRequestId),
    250,
    'Timed out waiting for .ts member completion response.',
  );
  const result = response.result as
    | Array<{
      label: string;
    }>
    | null;

  assertEquals(result?.some((entry) => entry.label === 'alpha'), true);
  assertEquals(result?.some((entry) => entry.label === 'beta'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides signature help for .ts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const lines = [
    'declare function pair(left: number, right: string): void;',
    'pair(1, "ok");',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before signatureHelp.',
  );

  const signatureHelpRequestId = await client.sendRequest('textDocument/signatureHelp', {
    textDocument: { uri },
    position: { line: 1, character: lines[1]!.indexOf('"ok"') + 1 },
  });
  const signatureHelpResponse = await withTimeout(
    client.readResponse(signatureHelpRequestId),
    250,
    'Timed out waiting for .ts signatureHelp response.',
  );
  const signatureHelpResult = signatureHelpResponse.result as {
    activeParameter?: number;
    activeSignature?: number;
    signatures?: Array<{
      label: string;
      parameters?: Array<{ label: string }>;
    }>;
  } | null;

  assertEquals(signatureHelpResult?.activeSignature, 0);
  assertEquals(signatureHelpResult?.activeParameter, 1);
  assertEquals(
    signatureHelpResult?.signatures?.[0]?.label.includes('pair(left: number, right: string): void'),
    true,
  );
  assertEquals(signatureHelpResult?.signatures?.[0]?.parameters?.[1]?.label, 'right: string');

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides document symbols for .ts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const text = [
    'export const value = 1;',
    'export function greet(name: string) {',
    '  return name;',
    '}',
    'export class Box {',
    '  size = 1;',
    '  open(): void {}',
    '}',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before documentSymbol.',
  );

  const documentSymbolRequestId = await client.sendRequest('textDocument/documentSymbol', {
    textDocument: { uri },
  });
  const documentSymbolResponse = await withTimeout(
    client.readResponse(documentSymbolRequestId),
    250,
    'Timed out waiting for .ts documentSymbol response.',
  );
  const documentSymbolResult = documentSymbolResponse.result as
    | Array<{
      children?: Array<{ kind: number; name: string }>;
      kind: number;
      name: string;
    }>
    | null;

  assertEquals(documentSymbolResult?.map((symbol) => [symbol.name, symbol.kind]), [
    ['value', 14],
    ['greet', 12],
    ['Box', 5],
  ]);
  assertEquals(documentSymbolResult?.[2]?.children?.map((symbol) => [symbol.name, symbol.kind]), [
    ['size', 8],
    ['open', 6],
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides semantic tokens for .ts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const text = [
    'export const value = 1;',
    'export function greet(name: string) {',
    '  return name;',
    '}',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before semanticTokens.',
  );

  const semanticTokensRequestId = await client.sendRequest('textDocument/semanticTokens/full', {
    textDocument: { uri },
  });
  const semanticTokensResponse = await withTimeout(
    client.readResponse(semanticTokensRequestId),
    250,
    'Timed out waiting for .ts semanticTokens response.',
  );
  const semanticTokensResult = semanticTokensResponse.result as {
    data?: number[];
  } | null;
  const tokens = decodeSemanticTokens(semanticTokensResult?.data ?? [], text);

  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'value' &&
      token.type === 'variable' &&
      token.modifiers.includes('declaration') &&
      token.modifiers.includes('readonly')
    ),
    true,
  );
  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'greet' && token.type === 'function' &&
      token.modifiers.includes('declaration')
    ),
    true,
  );
  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'name' && token.type === 'parameter' && token.line === 1
    ),
    true,
  );
  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'name' && token.type === 'parameter' && token.line === 2
    ),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition for plain .ts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const lines = [
    'const value = 1;',
    'void value;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 1, character: lines[1]!.indexOf('value') },
  });
  const response = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for .ts definition response.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.uri, uri);
  assertEquals(result?.[0]?.range.start.line, 0);
  assertEquals(result?.[0]?.range.start.character, lines[0]!.indexOf('value'));
  assertEquals(result?.[0]?.range.end.character, lines[0]!.indexOf('value') + 'value'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides references for plain .ts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const lines = [
    'const value = 1;',
    'void value;',
    'value;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before references.',
  );

  const referencesRequestId = await client.sendRequest('textDocument/references', {
    textDocument: { uri },
    position: { line: 1, character: lines[1]!.indexOf('value') },
    context: { includeDeclaration: true },
  });
  const response = await withTimeout(
    client.readResponse(referencesRequestId),
    250,
    'Timed out waiting for .ts references response.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 3);
  assertEquals(result?.every((entry) => entry.uri === uri), true);
  assertEquals(result?.map((entry) => entry.range.start.line), [0, 1, 2]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server highlights symbols in plain .ts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const lines = [
    'const value = 1;',
    'void value;',
    'value;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before documentHighlight.',
  );

  const highlightRequestId = await client.sendRequest('textDocument/documentHighlight', {
    textDocument: { uri },
    position: { line: 1, character: lines[1]!.indexOf('value') },
  });
  const highlightResponse = await withTimeout(
    client.readResponse(highlightRequestId),
    250,
    'Timed out waiting for .ts documentHighlight response.',
  );
  const highlightResult = highlightResponse.result as
    | Array<{
      kind?: number;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(highlightResult?.length, 3);
  assertEquals(highlightResult?.[0]?.kind, 3);
  assertEquals(highlightResult?.slice(1).every((highlight) => highlight.kind === 2), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server renames plain .ts symbols', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const lines = [
    'const value = 1;',
    'void value;',
    'value;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before rename.',
  );

  const prepareRequestId = await client.sendRequest('textDocument/prepareRename', {
    textDocument: { uri },
    position: { line: 1, character: lines[1]!.indexOf('value') },
  });
  const prepareResponse = await withTimeout(
    client.readResponse(prepareRequestId),
    250,
    'Timed out waiting for .ts prepareRename response.',
  );
  const prepareResult = prepareResponse.result as {
    placeholder?: string;
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  } | null;

  assertEquals(prepareResult?.placeholder, 'value');
  assertEquals(prepareResult?.range?.start.line, 1);

  const renameRequestId = await client.sendRequest('textDocument/rename', {
    textDocument: { uri },
    position: { line: 1, character: lines[1]!.indexOf('value') },
    newName: 'renamedValue',
  });
  const renameResponse = await withTimeout(
    client.readResponse(renameRequestId),
    250,
    'Timed out waiting for .ts rename response.',
  );
  const renameResult = renameResponse.result as {
    changes?: Record<string, Array<{ newText: string }>>;
  } | null;

  assertEquals(renameResult?.changes?.[uri]?.length, 3);
  assertEquals(
    renameResult?.changes?.[uri]?.every((edit) => edit.newText === 'renamedValue'),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server renames plain .ts symbols across project files', async () => {
  const workspace = await createWorkspace();
  await Deno.writeTextFile(
    join(workspace, 'src/other.ts'),
    [
      "import { sharedValue } from './index';",
      'void sharedValue;',
      '',
    ].join('\n'),
  );
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  const otherUri = `file://${workspace}/src/other.ts`;
  const lines = [
    'export const sharedValue = 1;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics before cross-file rename.',
  );

  const renameRequestId = await client.sendRequest('textDocument/rename', {
    textDocument: { uri },
    position: { line: 0, character: lines[0]!.indexOf('sharedValue') },
    newName: 'renamedValue',
  });
  const renameResponse = await withTimeout(
    client.readResponse(renameRequestId),
    250,
    'Timed out waiting for cross-file .ts rename response.',
  );
  const renameResult = renameResponse.result as {
    changes?: Record<string, Array<{ newText: string }>>;
  } | null;

  assertEquals(renameResult?.changes?.[uri]?.length, 1);
  assertEquals(renameResult?.changes?.[otherUri]?.length, 2);
  assertEquals(
    renameResult?.changes?.[uri]?.every((edit) => edit.newText === 'renamedValue'),
    true,
  );
  assertEquals(
    renameResult?.changes?.[otherUri]?.every((edit) => edit.newText === 'renamedValue'),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server analyzes open .sts files through virtual TypeScript companions', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: 'const count: number = "oops";\n',
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics for .sts file.',
  );
  const params = notification.params as {
    diagnostics: Array<{ code: string }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);

  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 0, character: 'const '.length },
  });
  const hoverResponse = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for .sts hover response.',
  );
  const hover = hoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('```ts'), true);
  assertEquals(hover?.contents?.value.includes('const count: number'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition for .sts declarations after macro rewrites', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'const ignored = Foo(1); const dict = Object.create(null);',
    'void dict;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial .sts publishDiagnostics before definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.indexOf('dict') },
  });
  const response = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for .sts definition response after macro rewrite.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.uri, uri);
  assertEquals(result?.[0]?.range.start.line, 1);
  assertEquals(result?.[0]?.range.start.character, lines[1]!.indexOf('dict'));
  assertEquals(result?.[0]?.range.end.character, lines[1]!.indexOf('dict') + 'dict'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server responds to hover using soundscript-aware types for .sts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    'const dict = Object.create(null);',
    'void dict;',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial .sts publishDiagnostics before hover.',
  );

  const dictCharacter = text.indexOf('dict');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 0, character: dictCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for .sts hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('const dict: BareObject'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows soundscript-aware ordinary .sts hover in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    'const dict = Object.create(null);',
    'void dict;',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before hover.',
  );

  const dictCharacter = text.indexOf('dict');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 0, character: dictCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for reduced-bridge .sts hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('const dict: BareObject'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows normalized catch binding hover in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    'try {',
    '  throw new Error("boom");',
    '} catch (err) {',
    '  void err;',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before catch hover.',
  );

  const errCharacter = lines[2]!.indexOf('err');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: errCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for reduced-bridge catch hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('err: Error'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server preserves type-only imports from local .ts modules in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/types.ts': 'export interface Environment { mode: "dev" | "prd"; }\n',
  });

  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    '// #[interop]',
    'import type { Environment } from "./types.ts";',
    'function readMode(env: Environment): "dev" | "prd" {',
    '  return env.mode;',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before foreign type hover.',
  );

  const envCharacter = lines[3]!.indexOf('env');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 3, character: envCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for reduced-bridge foreign type hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('env: Environment'), true);
  assertEquals(result?.contents?.value.includes('unknown'), false);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows resolved type-only import binding hovers from local .ts modules in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/types.ts': 'export interface Environment { mode: "dev" | "prd"; }\n',
  });

  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    '// #[interop]',
    'import type { Environment } from "./types.ts";',
    'void 0;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before foreign type import hover.',
  );

  const envCharacter = lines[1]!.indexOf('Environment');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 1, character: envCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for reduced-bridge foreign type import hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('interface Environment'), true);
  assertEquals(result?.contents?.value.includes('unknown'), false);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server projects imported any values from local .ts modules to unknown in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/types.ts': 'export const value: any = 1;\n',
  });

  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    '// #[interop]',
    'import { value } from "./types.ts";',
    'void value;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before foreign value hover.',
  );

  const valueCharacter = lines[2]!.indexOf('value');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: valueCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for reduced-bridge foreign value hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('const value: unknown'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server preserves trusted value imports from local .ts modules in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/types.ts': 'export const value: number = 1;\n',
  });

  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    '// #[interop]',
    'import { value } from "./types.ts";',
    'void value;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before trusted foreign value hover.',
  );

  const valueCharacter = lines[2]!.indexOf('value');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: valueCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for reduced-bridge trusted foreign value hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('const value: number'), true);
  assertEquals(result?.contents?.value.includes('unknown'), false);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server projects mixed value imports from local .ts modules to unknown at use sites in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/types.ts':
      'export interface Environment {}\nexport const literalSchema: any = {};\nexport const a: any = 1;\n',
  });

  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    '// #[interop]',
    'import { type Environment, literalSchema, a } from "./types.ts";',
    'console.log(a);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before mixed foreign value hover.',
  );

  const useSiteCharacter = lines[2]!.indexOf('a');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: useSiteCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for reduced-bridge mixed foreign value hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('const a: unknown'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server does not report stray any diagnostics for projected local .ts value imports in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/types.ts': 'export const literalSchema: any = {};\nexport const a: any = 1;\n',
  });

  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    '// #[interop]',
    'import { literalSchema, a } from "./types.ts";',
    'console.log(literalSchema);',
    'console.log(a);',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before projected local .ts value diagnostics.',
  );
  const diagnostics =
    (notification.params as { diagnostics?: Array<{ code?: string }> }).diagnostics ?? [];
  assertEquals(diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1001'), false);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server projects value import bindings from local .ts modules to unknown in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/types.ts': 'export const value: any = 1;\n',
  });

  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    '// #[interop]',
    'import { value } from "./types.ts";',
    'void 0;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before foreign value import hover.',
  );

  const valueCharacter = lines[1]!.indexOf('value');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 1, character: valueCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for reduced-bridge foreign value import hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('const value: unknown'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server projects mixed value import bindings from local .ts modules to unknown in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/types.ts':
      'export interface Environment {}\nexport const literalSchema: any = {};\nexport const a: any = 1;\n',
  });

  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    '// #[interop]',
    'import { type Environment, literalSchema, a } from "./types.ts";',
    'void 0;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for reduced-bridge .sts publishDiagnostics before mixed value import binding hover.',
  );

  const schemaCharacter = lines[1]!.indexOf('literalSchema');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 1, character: schemaCharacter },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for reduced-bridge mixed value import binding hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('const literalSchema: unknown'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows narrowed use-site types inside ordinary .sts if blocks', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    'function matchTest(value: unknown): boolean {',
    '  if (value instanceof Error) {',
    '    console.log(value);',
    '    return true;',
    '  }',
    '',
    '  return false;',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial .sts publishDiagnostics before narrowed hover.',
  );

  const valueHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.indexOf('value') },
  });
  const valueHoverResponse = await withTimeout(
    client.readResponse(valueHoverRequestId),
    250,
    'Timed out waiting for narrowed .sts hover response.',
  );
  const valueHover = valueHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(valueHover?.contents?.kind, 'markdown');
  assertEquals(valueHover?.contents?.value.includes('value: Error'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server refreshes narrowed use-site hovers after didChange in .sts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const initialText = [
    'function matchTest(value: unknown): boolean {',
    '  console.log(value);',
    '  return false;',
    '}',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: initialText,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial .sts publishDiagnostics before didChange hover.',
  );

  const updatedLines = [
    'function matchTest(value: unknown): boolean {',
    '  if (value instanceof Error) {',
    '    console.log(value);',
    '    return true;',
    '  }',
    '',
    '  return false;',
    '}',
    '',
  ];
  const updatedText = updatedLines.join('\n');
  await client.sendNotification('textDocument/didChange', {
    textDocument: {
      uri,
      version: 2,
    },
    contentChanges: [{ text: updatedText }],
  });

  const valueHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: updatedLines[2]!.indexOf('value') },
  });
  const valueHoverResponse = await withTimeout(
    client.readResponse(valueHoverRequestId),
    250,
    'Timed out waiting for refreshed narrowed .sts hover response.',
  );
  const valueHover = valueHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(valueHover?.contents?.kind, 'markdown');
  assertEquals(valueHover?.contents?.value.includes('value: Error'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows narrowed use-site types inside .sts JSON.stringify calls', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    'function ifTest(value: unknown): boolean {',
    '  if (value instanceof Error) {',
    '    JSON.stringify(value);',
    '    return true;',
    '  }',
    '',
    '  return false;',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial .sts publishDiagnostics before JSON.stringify hover.',
  );

  const valueHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.indexOf('value') },
  });
  const valueHoverResponse = await withTimeout(
    client.readResponse(valueHoverRequestId),
    250,
    'Timed out waiting for JSON.stringify narrowed .sts hover response.',
  );
  const valueHover = valueHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(valueHover?.contents?.kind, 'markdown');
  assertEquals(valueHover?.contents?.value.includes('value: Error'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server keeps narrowed ordinary hovers correct after earlier Match rewrites in the same file', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match } from 'sts:prelude';",
    'function matchTest(value: unknown): boolean {',
    '  return Match(value, [',
    '    (err: Error) => true,',
    '    (_) => false,',
    '  ]);',
    '}',
    '',
    'function ifTest(value: unknown): boolean {',
    '  if (value instanceof Error) {',
    '    JSON.stringify(value);',
    '    return true;',
    '  }',
    '',
    '  return false;',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial .sts publishDiagnostics before mixed hover.',
  );

  const valueHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 10, character: lines[10]!.indexOf('value') },
  });
  const valueHoverResponse = await withTimeout(
    client.readResponse(valueHoverRequestId),
    250,
    'Timed out waiting for mixed-file narrowed hover response.',
  );
  const valueHover = valueHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(valueHover?.contents?.kind, 'markdown');
  assertEquals(valueHover?.contents?.value.includes('value: Error'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server maps hover positions after .sts macro rewrites back into the virtual program', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Foo } from 'macros/test';",
    'const ignored = Foo(1); const dict = Object.create(null);',
    'void dict;',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial .sts publishDiagnostics before mapped hover.',
  );

  const dictCharacter = text.indexOf('dict =');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 1, character: dictCharacter - text.lastIndexOf('\n', dictCharacter) - 1 },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for mapped .sts hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
    range?: {
      start: { character: number; line: number };
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('const dict: BareObject'), true);
  assertEquals(result?.range?.start.line, 1);
  assertEquals(
    result?.range?.start.character,
    dictCharacter - text.lastIndexOf('\n', dictCharacter) - 1,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides operand hover inside .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Foo } from 'macros/test';",
    'const source: number = 1; const value = Foo(source);',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before macro hover.',
  );

  const macroOperandCharacter = text.lastIndexOf('source');
  await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: {
      line: 1,
      character: macroOperandCharacter - text.lastIndexOf('\n', macroOperandCharacter) - 1,
    },
  });

  const response = await withTimeout(
    client.readResponse(2),
    250,
    'Timed out waiting for .sts macro hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
    range?: {
      start: { character: number; line: number };
      end: { character: number; line: number };
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('number'), true);
  assertEquals(result?.range?.start.line, 1);
  assertEquals(
    result?.range?.start.character,
    macroOperandCharacter - text.lastIndexOf('\n', macroOperandCharacter) - 1,
  );
  assertEquals(
    result?.range?.end.character,
    macroOperandCharacter - text.lastIndexOf('\n', macroOperandCharacter) - 1 + 'source'.length,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows semantic macro docs for Try hovers', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { type Result, Try } from 'sts:prelude';",
    'declare function div(dividend: number, divisor: number): Result<number, Error>;',
    'function main(): Result<number, Error> {',
    '  const result = Try(div(10, 0));',
    '  return result;',
    '}',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Try summary hover.',
  );

  const tryCharacter = text.lastIndexOf('Try');
  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: {
      line: 3,
      character: tryCharacter - text.lastIndexOf('\n', tryCharacter) - 1,
    },
  });
  const hoverResponse = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for Try summary hover response.',
  );
  const hover = hoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**macro** `Try`'), true);
  assertEquals(
    hover?.contents?.value.includes(
      'Unwraps a direct `Result<Ok, Err>`, `Option<T>`, or nullish carrier.',
    ),
    true,
  );
  assertEquals(hover?.contents?.value.includes('operand: `Result<number, Error>`'), true);
  assertEquals(hover?.contents?.value.includes('yields: `number`'), true);
  assertEquals(hover?.contents?.value.includes('dividend: number'), false);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows macro-defined docs for log hovers', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { log } from 'sts:experimental/debug';",
    'declare function __sts_log<T>(source: string, value: T): T;',
    'const result = log(1 + 2);',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before log summary hover.',
  );

  const logCharacter = text.lastIndexOf('log');
  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: {
      line: 2,
      character: logCharacter - text.lastIndexOf('\n', logCharacter) - 1,
    },
  });
  const hoverResponse = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for log summary hover response.',
  );
  const hover = hoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**macro** `log`'), true);
  assertEquals(
    hover?.contents?.value.includes(
      'Evaluates the operand, logs its source text and value, then yields the original value unchanged.',
    ),
    true,
  );
  assertEquals(hover?.contents?.value.includes('number'), false);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows macro-defined docs for imported user-defined macros', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/twice.macro.sts': createUserDefinedTwiceMacroText(),
  });
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Twice } from './macros/twice.macro';",
    'const sourceValue = 1;',
    'const result = Twice(sourceValue);',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before user-macro hover.',
  );

  const macroCharacter = lines[2]!.indexOf('Twice');
  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 2, character: macroCharacter },
    },
    'Timed out waiting for user-defined macro hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**macro** `Twice`'), true);
  assertEquals(hover?.contents?.value.includes('Accepted forms:'), true);
  assertEquals(hover?.contents?.value.includes('Twice(<value>)'), true);
  assertEquals(
    hover?.contents?.value.includes('**Doubles** the operand and yields the computed value.'),
    true,
  );
  assertEquals(hover?.contents?.value.includes('- Returns the computed result.'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server still shows macro-defined docs in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/twice.macro.sts': createUserDefinedTwiceMacroText(),
  });
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Twice } from './macros/twice.macro';",
    'const sourceValue = 1;',
    'const value = Twice(sourceValue);',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for reduced-bridge .sts diagnostics before user-macro hover.',
  );

  const macroCharacter = lines[2]!.indexOf('Twice');
  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 2, character: macroCharacter },
    },
    'Timed out waiting for reduced-bridge user-defined macro hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**macro** `Twice`'), true);
  assertEquals(hover?.contents?.value.includes('Accepted forms:'), true);
  assertEquals(hover?.contents?.value.includes('Twice(<value>)'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows builtin annotation hover docs', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/types.ts': 'export type Environment = "dev" | "prd";\n',
  });
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    '// #[interop]',
    "import type { Environment } from './types.ts';",
    'export type Current = Environment;',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before builtin annotation hover.',
  );

  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 0, character: lines[0]!.indexOf('interop') },
    },
    'Timed out waiting for builtin annotation hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**annotation** `interop`'), true);
  assertEquals(hover?.contents?.value.includes('```ts'), true);
  assertEquals(hover?.contents?.value.includes('unsound foreign values enter soundscript'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows imported declaration macro docs on annotation hovers', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/derive.macro.sts': createUserDefinedDeriveMacroText(),
  });
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { derive } from './macros/derive.macro';",
    '// #[derive]',
    'export class User { id: string; }',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before declaration annotation hover.',
  );

  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 1, character: lines[1]!.indexOf('derive') },
    },
    'Timed out waiting for declaration annotation hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**macro** `derive`'), true);
  assertEquals(hover?.contents?.value.includes('**Derives** sibling declarations'), true);
  assertEquals(hover?.contents?.value.includes('// #[derive] <declaration>'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows macro summary hover for imported macro bindings', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/twice.macro.sts': createUserDefinedTwiceMacroText(),
  });
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Twice } from './macros/twice.macro';",
    'const sourceValue = 1;',
    'const result = Twice(sourceValue);',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before imported-macro binding hover.',
  );

  const importCharacter = lines[0]!.indexOf('Twice');
  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 0, character: importCharacter },
    },
    'Timed out waiting for imported macro binding hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**macro** `Twice`'), true);
  assertEquals(
    hover?.contents?.value.includes('**Doubles** the operand and yields the computed value.'),
    true,
  );
  assertEquals(hover?.contents?.value.includes('Accepted forms:'), true);
  assertEquals(hover?.contents?.value.includes('```ts'), true);
  assertEquals(hover?.contents?.value.includes('Twice(<value>)'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows rich builtin macro docs for imported macro bindings', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match } from 'sts:prelude';",
    'declare const value: unknown;',
    'const result = Match(value, [(_) => 0]);',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before imported builtin macro hover.',
  );

  const importCharacter = lines[0]!.indexOf('Match');
  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 0, character: importCharacter },
    },
    'Timed out waiting for imported builtin macro binding hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**macro** `Match`'), true);
  assertEquals(
    hover?.contents?.value.includes(
      'Evaluates the scrutinee once and returns the first matching arm.',
    ),
    true,
  );
  assertEquals(hover?.contents?.value.includes('Accepted forms:'), true);
  assertEquals(hover?.contents?.value.includes('```ts'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows rich parse-dependent builtin macro docs for imported Try bindings', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Try, type Result } from 'sts:prelude';",
    'declare function div(): Result<number, Error>;',
    'function run(): Result<number, Error> {',
    '  const result = Try(div());',
    '  return result;',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before imported parse-dependent builtin macro hover.',
  );

  const importCharacter = lines[0]!.indexOf('Try');
  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 0, character: importCharacter },
    },
    'Timed out waiting for imported parse-dependent builtin macro binding hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**macro** `Try`'), true);
  assertEquals(
    hover?.contents?.value.includes(
      'Unwraps `Result<Ok, Err>`. If the operand is `err`, the enclosing function returns that error immediately.',
    ),
    true,
  );
  assertEquals(hover?.contents?.value.includes('Accepted forms:'), true);
  assertEquals(hover?.contents?.value.includes('```ts'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides symbol hover inside Match arm expressions', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match } from 'sts:prelude';",
    'function wrap(payload: number): string {',
    '  return String(payload);',
    '}',
    'declare const value: { tag: "ok"; payload: number } | { tag: "err"; error: string };',
    'const result = Match(value, [',
    '  (({ payload }: { tag: "ok"; payload: number }) => wrap(payload)),',
    '  (({ error }: { tag: "err"; error: string }) => error),',
    ']);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Match arm hover.',
  );

  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 6, character: lines[6]!.indexOf('wrap') },
  });
  const hoverResponse = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for Match arm hover response.',
  );
  const hover = hoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('wrap(payload: number): string'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows analysis-backed types for Match pattern bindings inside branch bodies', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match, ok, err, where, type Result } from 'sts:prelude';",
    '',
    'function safeDivide(dividend: number, divisor: number): Result<number, string> {',
    '  if (divisor === 0) {',
    "    return err('divide_by_zero');",
    '  }',
    '',
    '  return ok(dividend / divisor);',
    '}',
    '',
    'export function describeDivision(dividend: number, divisor: number): string {',
    '  return Match(safeDivide(dividend, divisor), [',
    '    (({ value }: { tag: "ok"; value: number }) => value === 4 ? "ok:4" : "ok"),',
    '    (({ error }: { tag: "err"; error: string }) => error === "divide_by_zero" ? "err:divide_by_zero" : "err"),',
    '  ]);',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Match binding-type hover.',
  );

  const valueHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 12, character: lines[12]!.indexOf('value ===') },
  });
  const valueHoverResponse = await withTimeout(
    client.readResponse(valueHoverRequestId),
    250,
    'Timed out waiting for Match value binding hover response.',
  );
  const valueHover = valueHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(valueHover?.contents?.kind, 'markdown');
  assertEquals(valueHover?.contents?.value.includes('```ts\nnumber\n```'), true);

  const errorHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 13, character: lines[13]!.indexOf('error ===') },
  });
  const errorHoverResponse = await withTimeout(
    client.readResponse(errorHoverRequestId),
    250,
    'Timed out waiting for Match error binding hover response.',
  );
  const errorHover = errorHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(errorHover?.contents?.kind, 'markdown');
  assertEquals(errorHover?.contents?.value.includes('```ts\nstring\n```'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows analysis-backed types for nested, typeof, and instanceof Match bindings', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match } from 'sts:prelude';",
    'class NetworkFailure {',
    '  url: string = "";',
    '}',
    '',
    'declare const key: "payload";',
    'declare const value:',
    '  | { tag: "ok"; payload: { id: number; name: string } }',
    '  | NetworkFailure',
    '  | string;',
    '',
    'function compute(): string {',
    '  return Match(value, [',
    '    (({ payload: { id: userId } }: { tag: "ok"; payload: { id: number; name: string } }) => userId.toFixed(0)),',
    '    ((text: string) => text.toUpperCase()),',
    '    ((error: NetworkFailure) => error.url),',
    '    ((_) => "fallback"),',
    '  ]);',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before nested Match binding-type hover.',
  );

  const userIdHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 13, character: lines[13]!.indexOf('userId.toFixed') },
  });
  const userIdHoverResponse = await withTimeout(
    client.readResponse(userIdHoverRequestId),
    250,
    'Timed out waiting for nested Match userId binding hover response.',
  );
  const userIdHover = userIdHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(userIdHover?.contents?.kind, 'markdown');
  assertEquals(userIdHover?.contents?.value.includes('```ts\nnumber\n```'), true);

  const textHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 14, character: lines[14]!.indexOf('text.toUpperCase') },
  });
  const textHoverResponse = await withTimeout(
    client.readResponse(textHoverRequestId),
    250,
    'Timed out waiting for Match typeof binding hover response.',
  );
  const textHover = textHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(textHover?.contents?.kind, 'markdown');
  assertEquals(textHover?.contents?.value.includes('text: string'), true);

  const errorHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 15, character: lines[15]!.indexOf('error.url') },
  });
  const errorHoverResponse = await withTimeout(
    client.readResponse(errorHoverRequestId),
    250,
    'Timed out waiting for Match instanceof binding hover response.',
  );
  const errorHover = errorHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(errorHover?.contents?.kind, 'markdown');
  assertEquals(errorHover?.contents?.value.includes('error: NetworkFailure'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows analysis-backed types for Match bindings inside guards', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match, where } from 'sts:prelude';",
    'declare const value: number | string;',
    'const result = Match(value, [',
    '  where(((numeric: number) => "ok"), ((numeric) => numeric > 0)),',
    '  ((_) => "other"),',
    ']);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Match guard binding hover.',
  );

  const valueHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 3, character: lines[3]!.lastIndexOf('numeric >') },
  });
  const valueHoverResponse = await withTimeout(
    client.readResponse(valueHoverRequestId),
    250,
    'Timed out waiting for Match guard binding hover response.',
  );
  const valueHover = valueHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(valueHover?.contents?.kind, 'markdown');
  assertEquals(valueHover?.contents?.value.includes('numeric: number'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows analysis-backed types for instanceof Match bindings inside guards', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match, where } from 'sts:prelude';",
    'function matchTest(value: unknown): boolean {',
    '  return Match(value, [',
    '    where(((err: Error) => true), ((err) => "code" in err)),',
    '    ((_) => false),',
    '  ]);',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before instanceof Match guard hover.',
  ).then((notification) => {
    const params = notification.params as {
      diagnostics: Array<{ code: string }>;
    };
    assertEquals(params.diagnostics, []);
  });

  const errHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 3, character: lines[3]!.lastIndexOf('err') },
  });
  const errHoverResponse = await withTimeout(
    client.readResponse(errHoverRequestId),
    250,
    'Timed out waiting for instanceof Match guard hover response.',
  );
  const errHover = errHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(errHover?.contents?.kind, 'markdown');
  assertEquals(errHover?.contents?.value.includes('err: Error'), true);

  const guardParamCharacter = lines[3]!.lastIndexOf('(err') + 1;
  const guardParamHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 3, character: guardParamCharacter },
  });
  const guardParamHoverResponse = await withTimeout(
    client.readResponse(guardParamHoverRequestId),
    250,
    'Timed out waiting for instanceof Match guard-parameter hover response.',
  );
  const guardParamHover = guardParamHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(guardParamHover?.contents?.kind, 'markdown');
  assertEquals(guardParamHover?.contents?.value.includes('err: Error'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows analysis-backed types for exact where-predicate Match binding shapes', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match, where } from 'sts:prelude';",
    'function matchTest(value: unknown): boolean {',
    '  return Match(value, [',
    "    where((x: Error) => true, (x) => 'code' in x),",
    '    (_) => false',
    '  ]);',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before exact where-predicate Match hover.',
  ).then((notification) => {
    const params = notification.params as {
      diagnostics: Array<{ code: string }>;
    };
    assertEquals(params.diagnostics, []);
  });

  const bodyHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 3, character: lines[3]!.lastIndexOf('x') },
  });
  const bodyHoverResponse = await withTimeout(
    client.readResponse(bodyHoverRequestId),
    250,
    'Timed out waiting for exact where-predicate body binding hover response.',
  );
  const bodyHover = bodyHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(bodyHover?.contents?.kind, 'markdown');
  assertEquals(bodyHover?.contents?.value.includes('x: Error'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows scrutinee-backed hover types for untyped Match catch-all bindings', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match, where } from 'sts:prelude';",
    'function matchTest(value: unknown): boolean {',
    '  return Match(value, [',
    '    where(((err: Error) => true), ((err) => "code" in err)),',
    '    ((_) => false),',
    '  ]);',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Match catch-all binding hover.',
  ).then((notification) => {
    const params = notification.params as {
      diagnostics: Array<{ code: string }>;
    };
    assertEquals(params.diagnostics, []);
  });

  const bindingHoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 4, character: lines[4]!.indexOf('_') },
  });
  const bindingHoverResponse = await withTimeout(
    client.readResponse(bindingHoverRequestId),
    250,
    'Timed out waiting for Match catch-all binding hover response.',
  );
  const bindingHover = bindingHoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(bindingHover?.contents?.kind, 'markdown');
  assertEquals(bindingHover?.contents?.value.includes('```ts\n_: unknown\n```'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server does not show macro hovers on punctuation inside macro invocations', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match, where } from 'sts:prelude';",
    'function matchTest(value: unknown): boolean {',
    '  return Match(value, [',
    "    where((x: Error) => true, (x) => 'code' in x),",
    '    (_) => false',
    '  ]);',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before punctuation hover.',
  );

  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('[') },
    },
    'Timed out waiting for punctuation hover response.',
  );

  assertEquals(hover, null);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server does not show fallback any hovers on return keywords near macro invocations', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match, where } from 'sts:prelude';",
    'function matchTest(value: unknown): boolean {',
    '  return Match(value, [',
    "    where((x: Error) => true, (x) => 'code' in x),",
    '    (_) => false',
    '  ]);',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before return-keyword hover.',
  );

  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('return') },
    },
    'Timed out waiting for return-keyword hover response.',
  );

  assertEquals(hover, null);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides member completions inside Match guards', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match, where } from 'sts:prelude';",
    'declare const value: number | string;',
    'const result = Match(value, [',
    '  where(((numeric: number) => numeric), ((numeric) => numeric.to)),',
    '  ((_) => 0),',
    ']);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Match guard member completion.',
  );

  const completionRequestId = await client.sendRequest('textDocument/completion', {
    textDocument: { uri },
    position: { line: 3, character: lines[3]!.indexOf('numeric.to') + 'numeric.to'.length },
  });
  const completionResponse = await withTimeout(
    client.readResponse(completionRequestId),
    250,
    'Timed out waiting for Match guard member completion response.',
  );
  const completions = completionResponse.result as
    | Array<{
      detail?: string;
      label: string;
    }>
    | null;

  assertEquals(completions?.some((item) => item.label === 'toFixed'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server keeps direct-source hovers stable in .sts files with builtin macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Try, err, ok, type Result } from 'sts:prelude';",
    '',
    'export function safeDivide(dividend: number, divisor: number): Result<number, string> {',
    '  if (divisor === 0) {',
    "    return err('divide_by_zero');",
    '  }',
    '',
    '  return ok(dividend / divisor);',
    '}',
    '',
    'export function divideThreeWays(left: number, middle: number, right: number): Result<number, string> {',
    '  const first = Try(safeDivide(left, middle));',
    '  const second = Try(safeDivide(first, right));',
    '  return ok(second);',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before builtin-macro hover.',
  );

  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.indexOf('safeDivide') },
  });
  const hoverResponse = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for builtin-macro hover response.',
  );
  const hover = hoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
    range?: {
      start: { character: number; line: number };
      end: { character: number; line: number };
    };
  } | null;

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(
    hover?.contents?.value.includes(
      'function safeDivide(dividend: number, divisor: number): Result<number, string>',
    ),
    true,
  );
  assertEquals(hover?.range?.start.line, 2);
  assertEquals(hover?.range?.start.character, lines[2]!.indexOf('safeDivide'));
  assertEquals(hover?.range?.end.character, lines[2]!.indexOf('safeDivide') + 'safeDivide'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows declared signature hover for macros without custom hover text', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Defer } from 'sts:prelude';",
    'function run(cleanup: () => void) {',
    '  Defer(() => {',
    '    cleanup();',
    '  });',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before signature hover.',
  );

  const macroCharacter = lines[2]!.indexOf('Defer');
  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: macroCharacter },
  });
  const hoverResponse = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for signature hover response.',
  );
  const hover = hoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
    range?: {
      start: { character: number; line: number };
      end: { character: number; line: number };
    };
  } | null;

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('**macro** `Defer`'), true);
  assertEquals(hover?.range?.start.line, 2);
  assertEquals(hover?.range?.start.character, macroCharacter);
  assertEquals(hover?.range?.end.character, macroCharacter + 'Defer'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server shows analysis-backed types for bindings introduced by builtin macro statements', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Try, err, ok, type Result } from 'sts:prelude';",
    '',
    'export function safeDivide(dividend: number, divisor: number): Result<number, string> {',
    '  if (divisor === 0) {',
    "    return err('divide_by_zero');",
    '  }',
    '',
    '  return ok(dividend / divisor);',
    '}',
    '',
    'export function divideThreeWays(left: number, middle: number, right: number): Result<number, string> {',
    '  const first = Try(safeDivide(left, middle));',
    '  const second = Try(safeDivide(first, right));',
    '  return ok(second);',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before builtin-macro binding hover.',
  );

  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 11, character: lines[11]!.indexOf('first') },
  });
  const hoverResponse = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for builtin-macro binding hover response.',
  );
  const hover = hoverResponse.result as {
    contents?: {
      kind: string;
      value: string;
    };
  } | null;

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('const first: number'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides scope completions inside .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'const sourceValue = 1;',
    'const value = Foo(sou',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before macro completion.',
  );

  const completionRequestId = await client.sendRequest('textDocument/completion', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.length },
  });
  const response = await withTimeout(
    client.readResponse(completionRequestId),
    250,
    'Timed out waiting for .sts macro completion response.',
  );
  const result = response.result as
    | Array<{
      label: string;
    }>
    | null;

  assertEquals(result?.some((entry) => entry.label === 'sourceValue'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides member completions inside .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'const obj = { alpha: 1, beta: 2 };',
    'const value = Foo(obj.',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before macro member completion.',
  );

  const completionRequestId = await client.sendRequest('textDocument/completion', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.length },
  });
  const response = await withTimeout(
    client.readResponse(completionRequestId),
    250,
    'Timed out waiting for .sts macro member completion response.',
  );
  const result = response.result as
    | Array<{
      label: string;
    }>
    | null;

  assertEquals(result?.some((entry) => entry.label === 'alpha'), true);
  assertEquals(result?.some((entry) => entry.label === 'beta'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides sql completions in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { sql } from 'sts:experimental/sql';",
    'declare const userId: number;',
    'const query = sql`select *',
    'from users',
    'where id = ${userId}`;',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    { uri, languageId: 'soundscript', text: lines.join('\n') },
    'Timed out waiting for reduced-bridge .sts diagnostics before sql completion.',
  );

  const completions = await requestResult<
    Array<{
      detail?: string;
      label: string;
    }> | null
  >(
    client,
    'textDocument/completion',
    {
      textDocument: { uri },
      position: { line: 4, character: lines[4]!.indexOf('where') + 2 },
    },
    'Timed out waiting for reduced-bridge sql completion response.',
  );

  assertEquals(completions?.some((item) => item.label === 'WHERE'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides ordinary .sts expression macro completions in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'const sourceValue = 1;',
    'const value = Foo(sou',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text: lines.join('\n'),
    },
    'Timed out waiting for reduced-bridge .sts diagnostics before ordinary macro completion.',
  );

  const completions = await requestResult<
    Array<{
      label: string;
    }> | null
  >(
    client,
    'textDocument/completion',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.length },
    },
    'Timed out waiting for reduced-bridge ordinary macro completion response.',
  );

  assertEquals(completions?.some((item) => item.label === 'sourceValue'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides declared macro signature help for trailing macro operands', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match } from 'sts:prelude';",
    'declare const value: string | number;',
    'const result = Match(value, [',
    '  (x: string) => x.length,',
    '  (_) => 0,',
    ']);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before macro declared signatureHelp.',
  );

  const signatureHelpRequestId = await client.sendRequest('textDocument/signatureHelp', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.indexOf('[') + 1 },
  });
  const signatureHelpResponse = await withTimeout(
    client.readResponse(signatureHelpRequestId),
    250,
    'Timed out waiting for macro declared signatureHelp response.',
  );
  const signatureHelpResult = signatureHelpResponse.result as {
    activeParameter?: number;
    activeSignature?: number;
    signatures?: Array<{
      label: string;
      parameters?: Array<{ label: string }>;
    }>;
  } | null;

  assertEquals(signatureHelpResult?.activeParameter, 1);
  assertEquals(signatureHelpResult?.activeSignature, 0);
  assertEquals(signatureHelpResult?.signatures?.[0]?.label, 'Match(<value>, [ ... ])');
  assertEquals(signatureHelpResult?.signatures?.[0]?.parameters?.[0]?.label, 'value: <value>');
  assertEquals(signatureHelpResult?.signatures?.[0]?.parameters?.[1]?.label, 'arms: [ ... ]');

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides declared macro signature help in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match } from 'sts:prelude';",
    'declare const value: string | number;',
    'const result = Match(value, [',
    '  (x: string) => x.length,',
    '  (_) => 0,',
    ']);',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text: lines.join('\n'),
    },
    'Timed out waiting for reduced-bridge .sts diagnostics before macro signatureHelp.',
  );

  const signatureHelp = await requestResult<
    {
      activeParameter?: number;
      activeSignature?: number;
      signatures?: Array<{
        label: string;
        parameters?: Array<{ label: string }>;
      }>;
    } | null
  >(
    client,
    'textDocument/signatureHelp',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('[') + 1 },
    },
    'Timed out waiting for reduced-bridge macro signatureHelp response.',
  );

  assertEquals(signatureHelp?.activeParameter, 1);
  assertEquals(signatureHelp?.activeSignature, 0);
  assertEquals(signatureHelp?.signatures?.[0]?.label, 'Match(<value>, [ ... ])');
  assertEquals(signatureHelp?.signatures?.[0]?.parameters?.[0]?.label, 'value: <value>');
  assertEquals(signatureHelp?.signatures?.[0]?.parameters?.[1]?.label, 'arms: [ ... ]');

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides declared signature help for imported user-defined macros', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/twice.macro.sts': createUserDefinedTwiceMacroText(),
  });
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Twice } from './macros/twice.macro';",
    'const sourceValue = 1;',
    'const value = Twice(sourceValue);',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text: lines.join('\n'),
    },
    'Timed out waiting for .sts diagnostics before user-defined macro signatureHelp.',
  );

  const signatureHelp = await requestResult<
    {
      activeParameter?: number;
      activeSignature?: number;
      signatures?: Array<{
        label: string;
        parameters?: Array<{ label: string }>;
      }>;
    } | null
  >(
    client,
    'textDocument/signatureHelp',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('sourceValue') + 'sourceValue'.length },
    },
    'Timed out waiting for user-defined macro signatureHelp response.',
  );

  assertEquals(signatureHelp?.activeParameter, 0);
  assertEquals(signatureHelp?.activeSignature, 0);
  assertEquals(signatureHelp?.signatures?.[0]?.label, 'Twice(<value>)');
  assertEquals(signatureHelp?.signatures?.[0]?.parameters?.[0]?.label, 'value: <value>');

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides signature help inside .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'declare function pair(left: number, right: string): void;',
    'const source: number = 1;',
    'const value = Foo(pair(source, "ok"));',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before macro signatureHelp.',
  );

  const signatureHelpRequestId = await client.sendRequest('textDocument/signatureHelp', {
    textDocument: { uri },
    position: { line: 3, character: lines[3]!.indexOf('"ok"') + 1 },
  });
  const signatureHelpResponse = await withTimeout(
    client.readResponse(signatureHelpRequestId),
    250,
    'Timed out waiting for .sts signatureHelp response.',
  );
  const signatureHelpResult = signatureHelpResponse.result as {
    activeParameter?: number;
    signatures?: Array<{
      label: string;
      parameters?: Array<{ label: string }>;
    }>;
  } | null;

  assertEquals(signatureHelpResult?.activeParameter, 1);
  assertEquals(
    signatureHelpResult?.signatures?.[0]?.label.includes('pair(left: number, right: string): void'),
    true,
  );
  assertEquals(signatureHelpResult?.signatures?.[0]?.parameters?.[0]?.label, 'left: number');

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides ordinary .sts signature help in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    'declare function pair(left: number, right: string): void;',
    'pair(1, "ok");',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text: lines.join('\n'),
    },
    'Timed out waiting for reduced-bridge .sts diagnostics before ordinary signatureHelp.',
  );

  const signatureHelp = await requestResult<
    {
      activeParameter?: number;
      activeSignature?: number;
      signatures?: Array<{
        label: string;
        parameters?: Array<{ label: string }>;
      }>;
    } | null
  >(
    client,
    'textDocument/signatureHelp',
    {
      textDocument: { uri },
      position: { line: 1, character: lines[1]!.indexOf('"ok"') + 1 },
    },
    'Timed out waiting for reduced-bridge ordinary signatureHelp response.',
  );

  assertEquals(signatureHelp?.activeParameter, 1);
  assertEquals(signatureHelp?.activeSignature, 0);
  assertEquals(
    signatureHelp?.signatures?.[0]?.label.includes('pair(left: number, right: string): void'),
    true,
  );
  assertEquals(signatureHelp?.signatures?.[0]?.parameters?.[1]?.label, 'right: string');

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides document symbols for .sts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Foo } from 'macros/test';",
    'export const source = 1;',
    'export const value = Foo(source);',
    'export function greet(name: string) {',
    '  return name;',
    '}',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before documentSymbol.',
  );

  const documentSymbolRequestId = await client.sendRequest('textDocument/documentSymbol', {
    textDocument: { uri },
  });
  const documentSymbolResponse = await withTimeout(
    client.readResponse(documentSymbolRequestId),
    250,
    'Timed out waiting for .sts documentSymbol response.',
  );
  const documentSymbolResult = documentSymbolResponse.result as
    | Array<{
      kind: number;
      name: string;
    }>
    | null;

  assertEquals(documentSymbolResult?.map((symbol) => [symbol.name, symbol.kind]), [
    ['source', 14],
    ['value', 14],
    ['greet', 12],
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server returns .sts document symbols with selection ranges contained in full ranges', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Foo } from 'macros/test';",
    'export const source = 1;',
    'export const value = Foo(source);',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before documentSymbol containment test.',
  );

  const documentSymbolRequestId = await client.sendRequest('textDocument/documentSymbol', {
    textDocument: { uri },
  });
  const documentSymbolResponse = await withTimeout(
    client.readResponse(documentSymbolRequestId),
    250,
    'Timed out waiting for .sts documentSymbol containment response.',
  );
  const documentSymbolResult = documentSymbolResponse.result as
    | Array<{
      kind: number;
      name: string;
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
      selectionRange: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>
    | null;

  const valueSymbol = documentSymbolResult?.find((symbol) => symbol.name === 'value');
  assertEquals(valueSymbol?.kind, 14);
  assertEquals(valueSymbol?.range.start.line, 2);
  assertEquals(valueSymbol?.range.start.character, 13);
  assertEquals(valueSymbol?.selectionRange.start.line, 2);
  assertEquals(valueSymbol?.selectionRange.start.character, 13);
  assertEquals(valueSymbol?.selectionRange.end.line, 2);
  assertEquals(valueSymbol?.selectionRange.end.character, 18);
  assertEquals(valueSymbol?.range.end.line, 2);
  assertEquals(
    (valueSymbol?.range.end.character ?? 0) > (valueSymbol?.selectionRange.end.character ?? 0),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides semantic tokens for .sts files', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Foo } from 'macros/test';",
    'export const source = 1;',
    'export const value = Foo(source);',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before semanticTokens.',
  );

  const semanticTokensRequestId = await client.sendRequest('textDocument/semanticTokens/full', {
    textDocument: { uri },
  });
  const semanticTokensResponse = await withTimeout(
    client.readResponse(semanticTokensRequestId),
    250,
    'Timed out waiting for .sts semanticTokens response.',
  );
  const semanticTokensResult = semanticTokensResponse.result as {
    data?: number[];
  } | null;
  const tokens = decodeSemanticTokens(semanticTokensResult?.data ?? [], text);

  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'source' && token.type === 'variable' &&
      token.modifiers.includes('declaration')
    ),
    true,
  );
  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'value' && token.type === 'variable' &&
      token.modifiers.includes('declaration')
    ),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides semantic tokens for Match array-arm bindings', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Match } from 'sts:prelude';",
    'class NetworkFailure {}',
    'const value: NetworkFailure | string = new NetworkFailure();',
    'const result = Match(value, [',
    '  ((err: NetworkFailure) => err),',
    '  ((other: string) => other),',
    ']);',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before syntax-macro semanticTokens.',
  );

  const semanticTokensRequestId = await client.sendRequest('textDocument/semanticTokens/full', {
    textDocument: { uri },
  });
  const semanticTokensResponse = await withTimeout(
    client.readResponse(semanticTokensRequestId),
    250,
    'Timed out waiting for syntax-macro semanticTokens response.',
  );
  const semanticTokensResult = semanticTokensResponse.result as {
    data?: number[];
  } | null;
  const tokens = decodeSemanticTokens(semanticTokensResult?.data ?? [], text);

  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'Match' && token.type === 'variable' &&
      token.modifiers.includes('readonly')
    ),
    true,
  );
  assertEquals(
    tokens.some((token) => token.lexeme === 'NetworkFailure' && token.type === 'class'),
    true,
  );
  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'err' && token.type === 'parameter' &&
      token.modifiers.includes('declaration')
    ),
    true,
  );
  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'other' && token.type === 'parameter' &&
      token.modifiers.includes('declaration')
    ),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server keeps semantic tokens stable in .sts files with builtin macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Try, err, ok, type Result } from 'sts:prelude';",
    '',
    'export function safeDivide(dividend: number, divisor: number): Result<number, string> {',
    '  if (divisor === 0) {',
    "    return err('divide_by_zero');",
    '  }',
    '',
    '  return ok(dividend / divisor);',
    '}',
    '',
    'export function divideThreeWays(left: number, middle: number, right: number): Result<number, string> {',
    '  const first = Try(safeDivide(left, middle));',
    '  const second = Try(safeDivide(first, right));',
    '  return ok(second);',
    '}',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before builtin-macro semanticTokens.',
  );

  const semanticTokensRequestId = await client.sendRequest('textDocument/semanticTokens/full', {
    textDocument: { uri },
  });
  const semanticTokensResponse = await withTimeout(
    client.readResponse(semanticTokensRequestId),
    250,
    'Timed out waiting for builtin-macro semanticTokens response.',
  );
  const semanticTokensResult = semanticTokensResponse.result as {
    data?: number[];
  } | null;
  const tokens = decodeSemanticTokens(semanticTokensResult?.data ?? [], text);

  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'safeDivide' && token.type === 'function' && token.line === 2 &&
      token.startCharacter === 16
    ),
    true,
  );
  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'divideThreeWays' && token.type === 'function' && token.line === 10
    ),
    true,
  );
  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'Try' && token.type === 'variable' &&
      token.modifiers.includes('readonly') && token.line === 0 && token.startCharacter === 9
    ),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server includes semantic tokens from imported user-defined macros', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/twice.macro.sts': createUserDefinedTwiceMacroText(),
  });
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Twice } from './macros/twice.macro';",
    'const sourceValue = 1;',
    'const result = Twice(sourceValue);',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before user-defined macro semanticTokens.',
  );

  const semanticTokens = await requestResult<{ data: number[] } | null>(
    client,
    'textDocument/semanticTokens/full',
    { textDocument: { uri } },
    'Timed out waiting for user-defined macro semanticTokens response.',
  );
  const decoded = decodeSemanticTokens(semanticTokens?.data ?? [], text);

  assertEquals(
    decoded.some((token) => token.lexeme === 'sourceValue' && token.type === 'parameter'),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides semantic tokens for Match destructured bindings', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Match } from 'sts:prelude';",
    'declare const value: { tag: "ok"; payload: number } | { tag: "err"; error: string };',
    'const result = Match(value, [',
    '  (({ payload }: { tag: "ok"; payload: number }) => payload),',
    '  (({ error }: { tag: "err"; error: string }) => error.length),',
    ']);',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Match destructured semanticTokens.',
  );

  const semanticTokensRequestId = await client.sendRequest('textDocument/semanticTokens/full', {
    textDocument: { uri },
  });
  const semanticTokensResponse = await withTimeout(
    client.readResponse(semanticTokensRequestId),
    250,
    'Timed out waiting for Match destructured semanticTokens response.',
  );
  const semanticTokensResult = semanticTokensResponse.result as {
    data?: number[];
  } | null;
  const tokens = decodeSemanticTokens(semanticTokensResult?.data ?? [], text);

  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'payload' && token.type === 'parameter' &&
      token.modifiers.includes('declaration')
    ),
    true,
  );
  assertEquals(
    tokens.some((token) =>
      token.lexeme === 'error' && token.type === 'parameter' &&
      token.modifiers.includes('declaration')
    ),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides hover and completions inside sql embedded fragments', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { sql } from 'sts:experimental/sql';",
    'declare const userId: number;',
    'const query = sql`select *',
    'from users',
    'where id = ${userId}`;',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    { uri, languageId: 'soundscript', text },
    'Timed out waiting for .sts diagnostics before sql hover/completion.',
  );

  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('select') },
    },
    'Timed out waiting for sql hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('SQL keyword `SELECT`.'), true);

  const completions = await requestResult<
    Array<{
      detail?: string;
      label: string;
    }> | null
  >(
    client,
    'textDocument/completion',
    {
      textDocument: { uri },
      position: { line: 4, character: lines[4]!.indexOf('where') + 2 },
    },
    'Timed out waiting for sql completion response.',
  );

  assertEquals(completions?.some((item) => item.label === 'WHERE'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides hover and completions inside css embedded fragments', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { css } from 'sts:experimental/css';",
    'declare const primaryColor: string;',
    'const style = css`button { color: ${primaryColor}; bac }`;',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    { uri, languageId: 'soundscript', text },
    'Timed out waiting for .sts diagnostics before css hover/completion.',
  );

  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('color') + 1 },
    },
    'Timed out waiting for css hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('CSS property `color`.'), true);

  const completions = await requestResult<
    Array<{
      detail?: string;
      label: string;
    }> | null
  >(
    client,
    'textDocument/completion',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('bac') + 3 },
    },
    'Timed out waiting for css completion response.',
  );

  assertEquals(completions?.some((item) => item.label === 'background'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides hover and completions inside graphql embedded fragments', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { graphql } from 'sts:experimental/graphql';",
    'declare const userId: string;',
    'const operation = graphql`query User { que }`;',
    '',
  ];
  const text = lines.join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    { uri, languageId: 'soundscript', text },
    'Timed out waiting for .sts diagnostics before graphql hover/completion.',
  );

  const hover = await requestResult<
    {
      contents?: {
        kind: string;
        value: string;
      };
    } | null
  >(
    client,
    'textDocument/hover',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('query') + 1 },
    },
    'Timed out waiting for graphql hover response.',
  );

  assertEquals(hover?.contents?.kind, 'markdown');
  assertEquals(hover?.contents?.value.includes('GraphQL keyword `query`.'), true);

  const completions = await requestResult<
    Array<{
      detail?: string;
      label: string;
    }> | null
  >(
    client,
    'textDocument/completion',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('que') + 3 },
    },
    'Timed out waiting for graphql completion response.',
  );

  assertEquals(completions?.some((item) => item.label === 'query'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides semantic tokens for sql, css, and graphql embedded fragments', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { css } from 'sts:experimental/css';",
    "import { graphql } from 'sts:experimental/graphql';",
    "import { sql } from 'sts:experimental/sql';",
    'declare const userId: number;',
    'declare const primaryColor: string;',
    'declare const backgroundCss: string;',
    'const query = sql`select *',
    'from users',
    'where id = ${userId}`;',
    'const style = css`button { color: ${primaryColor}; background: ${css.raw(backgroundCss)}; }`;',
    'const operation = graphql`query User { user(id: ${userId}) { name } }`;',
    '',
  ].join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    { uri, languageId: 'soundscript', text },
    'Timed out waiting for .sts diagnostics before embedded-fragment semanticTokens.',
  );

  const semanticTokensResult = await requestResult<
    {
      data?: number[];
    } | null
  >(
    client,
    'textDocument/semanticTokens/full',
    {
      textDocument: { uri },
    },
    'Timed out waiting for embedded-fragment semanticTokens response.',
  );
  const tokens = decodeSemanticTokens(semanticTokensResult?.data ?? [], text);
  assertEquals(tokens.some((token) => token.lexeme === 'select' && token.type === 'keyword'), true);
  assertEquals(tokens.some((token) => token.lexeme === 'from' && token.type === 'keyword'), true);
  assertEquals(tokens.some((token) => token.lexeme === 'where' && token.type === 'keyword'), true);
  assertEquals(tokens.some((token) => token.lexeme === 'color' && token.type === 'property'), true);
  assertEquals(
    tokens.some((token) => token.lexeme === 'background' && token.type === 'property'),
    true,
  );
  assertEquals(tokens.some((token) => token.lexeme === 'query' && token.type === 'keyword'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server resolves Match pattern bindings for definition, references, and rename', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match } from 'sts:prelude';",
    'class NetworkFailure {}',
    'const value: NetworkFailure | string = new NetworkFailure();',
    'const result = Match(value, [',
    '  ((err: NetworkFailure) => err),',
    '  ((other: string) => other),',
    ']);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Match binding tests.',
  );

  const declarationCharacter = lines[4]!.indexOf('err');
  const referenceCharacter = lines[4]!.lastIndexOf('err');

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 4, character: referenceCharacter },
  });
  const definitionResponse = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for Match binding definition response.',
  );
  const definitionResult = definitionResponse.result as
    | Array<{
      uri: string;
      range: { start: { line: number; character: number } };
    }>
    | null;

  assertEquals(definitionResult?.length, 1);
  assertEquals(definitionResult?.[0]?.uri, uri);
  assertEquals(definitionResult?.[0]?.range.start.line, 4);
  assertEquals(definitionResult?.[0]?.range.start.character, declarationCharacter);

  const referencesRequestId = await client.sendRequest('textDocument/references', {
    textDocument: { uri },
    position: { line: 4, character: referenceCharacter },
    context: { includeDeclaration: true },
  });
  const referencesResponse = await withTimeout(
    client.readResponse(referencesRequestId),
    250,
    'Timed out waiting for Match binding references response.',
  );
  const referencesResult = referencesResponse.result as
    | Array<{
      uri: string;
      range: { start: { line: number; character: number } };
    }>
    | null;

  assertEquals(referencesResult?.length, 2);
  assertEquals(referencesResult?.every((entry) => entry.uri === uri), true);
  assertEquals(
    referencesResult?.map((entry) => entry.range.start.character),
    [declarationCharacter, referenceCharacter],
  );

  const prepareRequestId = await client.sendRequest('textDocument/prepareRename', {
    textDocument: { uri },
    position: { line: 4, character: declarationCharacter },
  });
  const prepareResponse = await withTimeout(
    client.readResponse(prepareRequestId),
    250,
    'Timed out waiting for Match binding prepareRename response.',
  );
  const prepareResult = prepareResponse.result as {
    placeholder?: string;
  } | null;
  assertEquals(prepareResult?.placeholder, 'err');

  const renameRequestId = await client.sendRequest('textDocument/rename', {
    textDocument: { uri },
    position: { line: 4, character: declarationCharacter },
    newName: 'failure',
  });
  const renameResponse = await withTimeout(
    client.readResponse(renameRequestId),
    250,
    'Timed out waiting for Match binding rename response.',
  );
  const renameResult = renameResponse.result as {
    changes?: Record<string, Array<{ newText: string }>>;
  } | null;

  assertEquals(renameResult?.changes?.[uri]?.length, 2);
  assertEquals(renameResult?.changes?.[uri]?.every((edit) => edit.newText === 'failure'), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server highlights Match pattern bindings through generic macro bindings', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match } from 'sts:prelude';",
    'class NetworkFailure {}',
    'const value: NetworkFailure | string = new NetworkFailure();',
    'const result = Match(value, [',
    '  ((err: NetworkFailure) => err),',
    '  ((other: string) => other),',
    ']);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Match binding highlights.',
  );

  const referenceCharacter = lines[4]!.lastIndexOf('err');
  const highlightRequestId = await client.sendRequest('textDocument/documentHighlight', {
    textDocument: { uri },
    position: { line: 4, character: referenceCharacter },
  });
  const highlightResponse = await withTimeout(
    client.readResponse(highlightRequestId),
    250,
    'Timed out waiting for Match binding documentHighlight response.',
  );
  const highlightResult = highlightResponse.result as
    | Array<{
      kind?: number;
      range: {
        start: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(highlightResult?.length, 2);
  assertEquals(highlightResult?.[0]?.kind, 3);
  assertEquals(highlightResult?.[1]?.kind, 2);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server resolves where-predicate bindings inside Match guards', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Match, where } from 'sts:prelude';",
    'declare const value: string;',
    'const result = Match(value, [',
    '  where(((valueText: string) => valueText.length), ((guardText) => guardText.length > 0)),',
    '  ((_) => 0),',
    ']);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before Match where binding tests.',
  );

  const declarationCharacter = lines[3]!.indexOf('guardText');
  const referenceCharacter = lines[3]!.lastIndexOf('guardText.length');

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 3, character: referenceCharacter },
  });
  const definitionResponse = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for Match where binding definition response.',
  );
  const definitionResult = definitionResponse.result as
    | Array<{
      uri: string;
      range: { start: { line: number; character: number } };
    }>
    | null;

  assertEquals(definitionResult?.length, 1);
  assertEquals(definitionResult?.[0]?.uri, uri);
  assertEquals(definitionResult?.[0]?.range.start.line, 3);
  assertEquals(definitionResult?.[0]?.range.start.character, declarationCharacter);

  const referencesRequestId = await client.sendRequest('textDocument/references', {
    textDocument: { uri },
    position: { line: 3, character: referenceCharacter },
    context: { includeDeclaration: true },
  });
  const referencesResponse = await withTimeout(
    client.readResponse(referencesRequestId),
    250,
    'Timed out waiting for Match where binding references response.',
  );
  const referencesResult = referencesResponse.result as
    | Array<{
      uri: string;
      range: { start: { line: number; character: number } };
    }>
    | null;

  assertEquals(referencesResult?.length, 2);
  assertEquals(referencesResult?.every((entry) => entry.uri === uri), true);
  assertEquals(
    referencesResult?.map((entry) => entry.range.start.character),
    [declarationCharacter, referenceCharacter],
  );

  const prepareRequestId = await client.sendRequest('textDocument/prepareRename', {
    textDocument: { uri },
    position: { line: 3, character: declarationCharacter },
  });
  const prepareResponse = await withTimeout(
    client.readResponse(prepareRequestId),
    250,
    'Timed out waiting for Match where binding prepareRename response.',
  );
  const prepareResult = prepareResponse.result as {
    placeholder?: string;
  } | null;
  assertEquals(prepareResult?.placeholder, 'guardText');

  const renameRequestId = await client.sendRequest('textDocument/rename', {
    textDocument: { uri },
    position: { line: 3, character: declarationCharacter },
    newName: 'text',
  });
  const renameResponse = await withTimeout(
    client.readResponse(renameRequestId),
    250,
    'Timed out waiting for Match where binding rename response.',
  );
  const renameResult = renameResponse.result as {
    changes?: Record<string, Array<{ newText: string }>>;
  } | null;

  assertEquals(renameResult?.changes?.[uri]?.length, 2);
  assertEquals(renameResult?.changes?.[uri]?.every((edit) => edit.newText === 'text'), true);

  const highlightRequestId = await client.sendRequest('textDocument/documentHighlight', {
    textDocument: { uri },
    position: { line: 3, character: referenceCharacter },
  });
  const highlightResponse = await withTimeout(
    client.readResponse(highlightRequestId),
    250,
    'Timed out waiting for Match where binding documentHighlight response.',
  );
  const highlightResult = highlightResponse.result as
    | Array<{
      kind?: number;
      range: {
        start: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(highlightResult?.length, 2);
  assertEquals(highlightResult?.[0]?.kind, 3);
  assertEquals(highlightResult?.[1]?.kind, 2);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition inside .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'const source: number = 1;',
    'const value = Foo(source);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before macro definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.lastIndexOf('source') },
  });
  const response = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for .sts expression macro definition response.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.uri, uri);
  assertEquals(result?.[0]?.range.start.line, 1);
  assertEquals(result?.[0]?.range.start.character, lines[1]!.indexOf('source'));
  assertEquals(result?.[0]?.range.end.character, lines[1]!.indexOf('source') + 'source'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition inside .sts expression macros in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'const source: number = 1;',
    'const value = Foo(source);',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text: lines.join('\n'),
    },
    'Timed out waiting for reduced-bridge .sts diagnostics before macro definition.',
  );

  const result = await requestResult<
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null
  >(
    client,
    'textDocument/definition',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.lastIndexOf('source') },
    },
    'Timed out waiting for reduced-bridge .sts expression macro definition response.',
  );

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.uri, uri);
  assertEquals(result?.[0]?.range.start.line, 1);
  assertEquals(result?.[0]?.range.start.character, lines[1]!.indexOf('source'));
  assertEquals(result?.[0]?.range.end.character, lines[1]!.indexOf('source') + 'source'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides ordinary .sts definitions in reduced bridge mode', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace, {
    capabilityMode: 'editor-bridge',
  });

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    'const value = 1;',
    'void value;',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text: lines.join('\n'),
    },
    'Timed out waiting for reduced-bridge .sts diagnostics before ordinary definition.',
  );

  const result = await requestResult<
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null
  >(
    client,
    'textDocument/definition',
    {
      textDocument: { uri },
      position: { line: 1, character: lines[1]!.indexOf('value') },
    },
    'Timed out waiting for reduced-bridge ordinary definition response.',
  );

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.uri, uri);
  assertEquals(result?.[0]?.range.start.line, 0);
  assertEquals(result?.[0]?.range.start.character, lines[0]!.indexOf('value'));
  assertEquals(result?.[0]?.range.end.character, lines[0]!.indexOf('value') + 'value'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition for preserved declarations from augment macros', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/augment.macro.sts': createUserDefinedAugmentMacroText(),
  });
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { augment } from './macros/augment.macro';",
    '// #[augment]',
    'export class User {',
    '  id = "";',
    '}',
    'const current = new User();',
    'void current;',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text: lines.join('\n'),
    },
    'Timed out waiting for .sts diagnostics before augment declaration definition.',
  );

  const result = await requestResult<
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null
  >(
    client,
    'textDocument/definition',
    {
      textDocument: { uri },
      position: { line: 5, character: lines[5]!.lastIndexOf('User') },
    },
    'Timed out waiting for augment declaration definition response.',
  );

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.uri, uri);
  assertEquals(result?.[0]?.range.start.line, 2);
  assertEquals(result?.[0]?.range.start.character, lines[2]!.indexOf('User'));
  assertEquals(result?.[0]?.range.end.character, lines[2]!.indexOf('User') + 'User'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides references inside .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'const source: number = 1;',
    'const value = Foo(source);',
    'void source;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before macro references.',
  );

  const referencesRequestId = await client.sendRequest('textDocument/references', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.lastIndexOf('source') },
    context: { includeDeclaration: true },
  });
  const response = await withTimeout(
    client.readResponse(referencesRequestId),
    250,
    'Timed out waiting for .sts expression macro references response.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 3);
  assertEquals(result?.every((entry) => entry.uri === uri), true);
  assertEquals(result?.map((entry) => entry.range.start.line), [1, 2, 3]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server highlights symbols inside .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'const source: number = 1;',
    'const value = Foo(source);',
    'void source;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before macro documentHighlight.',
  );

  const highlightRequestId = await client.sendRequest('textDocument/documentHighlight', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.lastIndexOf('source') },
  });
  const highlightResponse = await withTimeout(
    client.readResponse(highlightRequestId),
    250,
    'Timed out waiting for .sts documentHighlight response.',
  );
  const highlightResult = highlightResponse.result as
    | Array<{
      kind?: number;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(highlightResult?.length, 3);
  assertEquals(highlightResult?.[0]?.kind, 3);
  assertEquals(highlightResult?.slice(1).every((highlight) => highlight.kind === 2), true);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server renames symbols inside .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'const source: number = 1;',
    'const value = Foo(source);',
    'void source;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before macro rename.',
  );

  const prepareRequestId = await client.sendRequest('textDocument/prepareRename', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.lastIndexOf('source') },
  });
  const prepareResponse = await withTimeout(
    client.readResponse(prepareRequestId),
    250,
    'Timed out waiting for .sts prepareRename response.',
  );
  const prepareResult = prepareResponse.result as {
    placeholder?: string;
  } | null;

  assertEquals(prepareResult?.placeholder, 'source');

  const renameRequestId = await client.sendRequest('textDocument/rename', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.lastIndexOf('source') },
    newName: 'renamedSource',
  });
  const renameResponse = await withTimeout(
    client.readResponse(renameRequestId),
    250,
    'Timed out waiting for .sts macro rename response.',
  );
  const renameResult = renameResponse.result as {
    changes?: Record<string, Array<{ newText: string }>>;
  } | null;

  assertEquals(renameResult?.changes?.[uri]?.length, 3);
  assertEquals(
    renameResult?.changes?.[uri]?.every((edit) => edit.newText === 'renamedSource'),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server renames preserved declarations across files from augment macros', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/augment.macro.sts': createUserDefinedAugmentMacroText(),
    'src/consumer.sts': [
      "import { User } from './index';",
      'const other = new User();',
      'void other;',
      '',
    ].join('\n'),
  });
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const consumerUri = `file://${workspace}/src/consumer.sts`;
  const lines = [
    "import { augment } from './macros/augment.macro';",
    '// #[augment]',
    'export class User {',
    '  id = "";',
    '}',
    'const current = new User();',
    'void current;',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri: consumerUri,
      languageId: 'soundscript',
      text: await Deno.readTextFile(join(workspace, 'src/consumer.sts')),
    },
    'Timed out waiting for consumer diagnostics before augment declaration rename.',
  );
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text: lines.join('\n'),
    },
    'Timed out waiting for .sts diagnostics before augment declaration rename.',
  );

  const prepareResult = await requestResult<{ placeholder?: string } | null>(
    client,
    'textDocument/prepareRename',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('User') },
    },
    'Timed out waiting for augment declaration prepareRename response.',
  );

  assertEquals(prepareResult?.placeholder, 'User');

  const renameResult = await requestResult<
    {
      changes?: Record<
        string,
        Array<{
          newText: string;
          range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
          };
        }>
      >;
    } | null
  >(
    client,
    'textDocument/rename',
    {
      textDocument: { uri },
      position: { line: 2, character: lines[2]!.indexOf('User') },
      newName: 'Account',
    },
    'Timed out waiting for augment declaration rename response.',
  );

  assertEquals(renameResult?.changes?.[uri]?.length, 2);
  assertEquals(renameResult?.changes?.[consumerUri]?.length, 2);
  assertEquals(
    renameResult?.changes?.[uri]?.map((edit) => edit.range.start.line),
    [2, 5],
  );
  assertEquals(
    renameResult?.changes?.[consumerUri]?.map((edit) => edit.range.start.line),
    [0, 1],
  );
  assertEquals(renameResult?.changes?.[uri]?.every((edit) => edit.newText === 'Account'), true);
  assertEquals(
    renameResult?.changes?.[consumerUri]?.every((edit) => edit.newText === 'Account'),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides references for preserved declarations from augment macro use sites', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/augment.macro.sts': createUserDefinedAugmentMacroText(),
    'src/consumer.sts': [
      "import { User } from './index';",
      'const other = new User();',
      'void other;',
      '',
    ].join('\n'),
  });
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const consumerUri = `file://${workspace}/src/consumer.sts`;
  const lines = [
    "import { augment } from './macros/augment.macro';",
    '// #[augment]',
    'export class User {',
    '  id = "";',
    '}',
    'const current = new User();',
    'void current;',
    '',
  ];
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri: consumerUri,
      languageId: 'soundscript',
      text: await Deno.readTextFile(join(workspace, 'src/consumer.sts')),
    },
    'Timed out waiting for consumer diagnostics before augment declaration references.',
  );
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text: lines.join('\n'),
    },
    'Timed out waiting for .sts diagnostics before augment declaration references.',
  );

  const references = await requestResult<
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null
  >(
    client,
    'textDocument/references',
    {
      textDocument: { uri },
      position: { line: 5, character: lines[5]!.lastIndexOf('User') },
      context: { includeDeclaration: true },
    },
    'Timed out waiting for augment declaration references response.',
  );

  assertEquals(
    references?.map((reference) => [reference.uri, reference.range.start.line]),
    [
      [consumerUri, 0],
      [consumerUri, 1],
      [uri, 2],
      [uri, 5],
    ],
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server renames .sts symbols across project files and macro operands', async () => {
  const workspace = await createWorkspace();
  const consumerLines = [
    "import { Foo } from 'macros/test';",
    "import { source } from './index';",
    'const value = Foo(source);',
    'void source;',
    '',
  ];
  const consumerText = consumerLines.join('\n');
  await Deno.writeTextFile(
    join(workspace, 'src/consumer.sts'),
    consumerText,
  );
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const consumerUri = `file://${workspace}/src/consumer.sts`;
  const lines = [
    'export const source: number = 1;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: consumerUri,
      languageId: 'soundscript',
      version: 1,
      text: consumerText,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for consumer .sts diagnostics before cross-file macro rename.',
  );
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before cross-file macro rename.',
  );

  const renameRequestId = await client.sendRequest('textDocument/rename', {
    textDocument: { uri },
    position: { line: 0, character: lines[0]!.indexOf('source') },
    newName: 'renamedSource',
  });
  const renameResponse = await withTimeout(
    client.readResponse(renameRequestId),
    250,
    'Timed out waiting for cross-file .sts rename response.',
  );
  const renameResult = renameResponse.result as {
    changes?: Record<string, Array<{ newText: string }>>;
  } | null;

  assertEquals(renameResult?.changes?.[uri]?.length, 1);
  assertEquals(renameResult?.changes?.[consumerUri]?.length, 3);
  assertEquals(
    renameResult?.changes?.[uri]?.every((edit) => edit.newText === 'renamedSource'),
    true,
  );
  assertEquals(
    renameResult?.changes?.[consumerUri]?.every((edit) => edit.newText === 'renamedSource'),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides cross-file definitions from .sts macro operands', async () => {
  const workspace = await createWorkspace();
  const indexText = [
    'export const source: number = 1;',
    '',
  ].join('\n');
  await Deno.writeTextFile(
    join(workspace, 'src/index.sts'),
    indexText,
  );
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/consumer.sts`;
  const definitionUri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    "import { source } from './index';",
    'const value = Foo(source);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: definitionUri,
      languageId: 'soundscript',
      version: 1,
      text: indexText,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for target .sts diagnostics before cross-file macro definition.',
  );
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before cross-file macro definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.lastIndexOf('source') },
  });
  const definitionResponse = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for cross-file .sts definition response.',
  );
  const definitionResult = definitionResponse.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(definitionResult?.length, 1);
  assertEquals(definitionResult?.[0]?.uri, definitionUri);
  assertEquals(definitionResult?.[0]?.range.start.line, 0);
  assertEquals(definitionResult?.[0]?.range.start.character, 'export const '.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides cross-file references from .sts declarations into macro operands', async () => {
  const workspace = await createWorkspace();
  const consumerLines = [
    "import { Foo } from 'macros/test';",
    "import { source } from './index';",
    'const value = Foo(source);',
    'void source;',
    '',
  ];
  const consumerText = consumerLines.join('\n');
  await Deno.writeTextFile(
    join(workspace, 'src/consumer.sts'),
    consumerText,
  );
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const consumerUri = `file://${workspace}/src/consumer.sts`;
  const lines = [
    'export const source: number = 1;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: consumerUri,
      languageId: 'soundscript',
      version: 1,
      text: consumerText,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for consumer .sts diagnostics before cross-file macro references.',
  );
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before cross-file macro references.',
  );

  const referencesRequestId = await client.sendRequest('textDocument/references', {
    textDocument: { uri },
    position: { line: 0, character: lines[0]!.indexOf('source') },
    context: { includeDeclaration: true },
  });
  const referencesResponse = await withTimeout(
    client.readResponse(referencesRequestId),
    250,
    'Timed out waiting for cross-file .sts references response.',
  );
  const referencesResult = referencesResponse.result as
    | Array<{
      uri: string;
    }>
    | null;

  assertEquals(referencesResult?.length, 4);
  assertEquals(referencesResult?.filter((location) => location.uri === uri).length, 1);
  assertEquals(referencesResult?.filter((location) => location.uri === consumerUri).length, 3);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definitions from .sts macro operands into .ts declarations', async () => {
  const workspace = await createWorkspace();
  await Deno.writeTextFile(
    join(workspace, 'src/index.ts'),
    [
      'export const source = 1;',
      '',
    ].join('\n'),
  );
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/consumer.sts`;
  const definitionUri = `file://${workspace}/src/index.ts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    "import { source } from './index';",
    'const value = Foo(source);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for mixed-project diagnostics before definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.lastIndexOf('source') },
  });
  const definitionResponse = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for mixed-project definition response.',
  );
  const definitionResult = definitionResponse.result as
    | Array<{
      uri: string;
    }>
    | null;

  assertEquals(definitionResult?.length, 1);
  assertEquals(definitionResult?.[0]?.uri, definitionUri);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server renames .sts declarations referenced from .ts files', async () => {
  const workspace = await createWorkspace();
  const consumerText = [
    "import { source } from './index';",
    'void source;',
    '',
  ].join('\n');
  await Deno.writeTextFile(
    join(workspace, 'src/consumer.ts'),
    consumerText,
  );
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const consumerUri = `file://${workspace}/src/consumer.ts`;
  const lines = [
    'export const source: number = 1;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri: consumerUri,
      languageId: 'typescript',
      version: 1,
      text: consumerText,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for mixed-project consumer diagnostics before rename.',
  );
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for mixed-project diagnostics before rename.',
  );

  const renameRequestId = await client.sendRequest('textDocument/rename', {
    textDocument: { uri },
    position: { line: 0, character: lines[0]!.indexOf('source') },
    newName: 'renamedSource',
  });
  const renameResponse = await withTimeout(
    client.readResponse(renameRequestId),
    250,
    'Timed out waiting for mixed-project rename response.',
  );
  const renameResult = renameResponse.result as {
    changes?: Record<string, Array<{ newText: string }>>;
  } | null;

  assertEquals(renameResult?.changes?.[uri]?.length, 1);
  assertEquals(renameResult?.changes?.[consumerUri]?.length, 2);
  assertEquals(
    renameResult?.changes?.[uri]?.every((edit) => edit.newText === 'renamedSource'),
    true,
  );
  assertEquals(
    renameResult?.changes?.[consumerUri]?.every((edit) => edit.newText === 'renamedSource'),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition from .ts imports into .sts source', async () => {
  const workspace = await createWorkspace();
  const consumerText = [
    "import { source } from './index';",
    'void source;',
    '',
  ].join('\n');
  await Deno.writeTextFile(
    join(workspace, 'src/index.sts'),
    [
      'export const source: number = 1;',
      '',
    ].join('\n'),
  );
  await Deno.writeTextFile(
    join(workspace, 'src/consumer.ts'),
    consumerText,
  );
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/consumer.ts`;
  const definitionUri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: consumerText,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for mixed-project .ts diagnostics before definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 1, character: 'void '.length },
  });
  const definitionResponse = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for mixed-project .ts to .sts definition response.',
  );
  const definitionResult = definitionResponse.result as
    | Array<{
      uri: string;
    }>
    | null;

  assertEquals(definitionResult?.length, 1);
  assertEquals(definitionResult?.[0]?.uri, definitionUri);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition from an imported binding in .ts into .sts source', async () => {
  const workspace = await createWorkspace();
  const consumerText = [
    "import { source } from './index';",
    'void source;',
    '',
  ].join('\n');
  await Deno.writeTextFile(
    join(workspace, 'src/index.sts'),
    [
      'export const source: number = 1;',
      '',
    ].join('\n'),
  );
  await Deno.writeTextFile(
    join(workspace, 'src/consumer.ts'),
    consumerText,
  );
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/consumer.ts`;
  const definitionUri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: consumerText,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for mixed-project .ts diagnostics before import definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 0, character: 'import { '.length },
  });
  const definitionResponse = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for mixed-project imported binding definition response.',
  );
  const definitionResult = definitionResponse.result as
    | Array<{
      uri: string;
    }>
    | null;

  assertEquals(definitionResult?.length, 1);
  assertEquals(definitionResult?.[0]?.uri, definitionUri);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition from .ts imports into source-published package .sts source', async () => {
  const workspace = await createWorkspace();
  await Deno.writeTextFile(
    join(workspace, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );
  await Deno.mkdir(join(workspace, 'node_modules/sound-pkg/dist'), { recursive: true });
  await Deno.mkdir(join(workspace, 'node_modules/sound-pkg/src'), { recursive: true });
  await Deno.writeTextFile(
    join(workspace, 'node_modules/sound-pkg/package.json'),
    JSON.stringify(
      {
        name: 'sound-pkg',
        version: '1.0.0',
        type: 'module',
        types: './dist/index.d.ts',
        soundscript: {
          source: './src/index.sts',
        },
      },
      null,
      2,
    ),
  );
  await Deno.writeTextFile(
    join(workspace, 'node_modules/sound-pkg/dist/index.d.ts'),
    'export declare const source: number;\n',
  );
  await Deno.writeTextFile(
    join(workspace, 'node_modules/sound-pkg/src/index.sts'),
    'export const source: number = 1;\n',
  );

  const consumerText = [
    'import { source } from "sound-pkg";',
    'void source;',
    '',
  ].join('\n');
  await Deno.writeTextFile(
    join(workspace, 'src/consumer.ts'),
    consumerText,
  );

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/consumer.ts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: consumerText,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for package-backed .ts diagnostics before definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 1, character: 'void '.length },
  });
  const definitionResponse = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for package-backed .ts to .sts definition response.',
  );
  const definitionResult = definitionResponse.result as
    | Array<{
      uri: string;
    }>
    | null;

  assertEquals(definitionResult?.length, 1);
  assertEquals(
    definitionResult?.[0]?.uri?.endsWith('/node_modules/sound-pkg/src/index.sts'),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides operand hover inside .sts arglist macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'declare const left: number;',
    'declare const right: string;',
    'const value = Foo(left, right);',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before arglist macro hover.',
  );

  const rightCharacter = lines[3]!.indexOf('right');
  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 3, character: rightCharacter },
  });

  const response = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for .sts arglist macro hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
    range?: {
      start: { character: number; line: number };
      end: { character: number; line: number };
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('string'), true);
  assertEquals(result?.range?.start.line, 3);
  assertEquals(result?.range?.start.character, rightCharacter);
  assertEquals(result?.range?.end.character, rightCharacter + 'right'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides hover inside .sts block macro bodies', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'declare const source: number;',
    'function wrap(): void {',
    '  Foo(() => {',
    '    const value = source;',
    '    void value;',
    '  });',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before block macro hover.',
  );

  const sourceCharacter = lines[4]!.indexOf('source');
  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 4, character: sourceCharacter },
  });

  const response = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for .sts block macro hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
    range?: {
      start: { character: number; line: number };
      end: { character: number; line: number };
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('number'), true);
  assertEquals(result?.range?.start.line, 4);
  assertEquals(result?.range?.start.character, sourceCharacter);
  assertEquals(result?.range?.end.character, sourceCharacter + 'source'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides precise local definitions inside .sts block macro bodies', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'function wrap(): void {',
    '  Foo(() => {',
    '    const value = 1;',
    '    void value;',
    '  });',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before block macro definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 4, character: lines[4]!.indexOf('value') },
  });
  const response = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for .sts block macro definition response.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.uri, uri);
  assertEquals(result?.[0]?.range.start.line, 3);
  assertEquals(result?.[0]?.range.start.character, 10);
  assertEquals(result?.[0]?.range.end.character, 15);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides local references inside .sts block macro bodies', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Foo } from 'macros/test';",
    'function wrap(): void {',
    '  Foo(() => {',
    '    const value = 1;',
    '    void value;',
    '    value;',
    '  });',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before block macro references.',
  );

  const referencesRequestId = await client.sendRequest('textDocument/references', {
    textDocument: { uri },
    position: { line: 4, character: lines[4]!.indexOf('value') },
    context: { includeDeclaration: true },
  });
  const response = await withTimeout(
    client.readResponse(referencesRequestId),
    250,
    'Timed out waiting for .sts block macro references response.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 3);
  assertEquals(result?.every((entry) => entry.uri === uri), true);
  assertEquals(result?.map((entry) => entry.range.start.line), [3, 4, 5]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides hover inside nested .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Inner, Outer } from 'macros/test';",
    'declare const source: number;',
    'const value = Outer(Inner(source));',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before nested expression macro hover.',
  );

  const sourceCharacter = lines[2]!.lastIndexOf('source');
  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 2, character: sourceCharacter },
  });

  const response = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for nested .sts expression macro hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
    range?: {
      start: { character: number; line: number };
      end: { character: number; line: number };
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('number'), true);
  assertEquals(result?.range?.start.line, 2);
  assertEquals(result?.range?.start.character, sourceCharacter);
  assertEquals(result?.range?.end.character, sourceCharacter + 'source'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition inside nested .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Inner, Outer } from 'macros/test';",
    'declare const source: number;',
    'const value = Outer(Inner(source));',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before nested expression macro definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.lastIndexOf('source') },
  });
  const response = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for nested .sts expression macro definition response.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.uri, uri);
  assertEquals(result?.[0]?.range.start.line, 1);
  assertEquals(result?.[0]?.range.start.character, lines[1]!.indexOf('source'));
  assertEquals(result?.[0]?.range.end.character, lines[1]!.indexOf('source') + 'source'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides references inside nested .sts expression macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Inner, Outer } from 'macros/test';",
    'declare const source: number;',
    'const value = Outer(Inner(source));',
    'void source;',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before nested expression macro references.',
  );

  const referencesRequestId = await client.sendRequest('textDocument/references', {
    textDocument: { uri },
    position: { line: 2, character: lines[2]!.lastIndexOf('source') },
    context: { includeDeclaration: true },
  });
  const response = await withTimeout(
    client.readResponse(referencesRequestId),
    250,
    'Timed out waiting for nested .sts expression macro references response.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 3);
  assertEquals(result?.every((entry) => entry.uri === uri), true);
  assertEquals(result?.map((entry) => entry.range.start.line), [1, 2, 3]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides hover inside nested .sts block macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Inner, Outer } from 'macros/test';",
    'declare const source: number;',
    'function wrap(): void {',
    '  Outer(() => {',
    '    const value = Inner(source);',
    '    void value;',
    '  });',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before nested block macro hover.',
  );

  const sourceCharacter = lines[4]!.lastIndexOf('source');
  const hoverRequestId = await client.sendRequest('textDocument/hover', {
    textDocument: { uri },
    position: { line: 4, character: sourceCharacter },
  });

  const response = await withTimeout(
    client.readResponse(hoverRequestId),
    250,
    'Timed out waiting for nested .sts block macro hover response.',
  );
  const result = response.result as {
    contents?: {
      kind: string;
      value: string;
    };
    range?: {
      start: { character: number; line: number };
      end: { character: number; line: number };
    };
  } | null;

  assertEquals(result?.contents?.kind, 'markdown');
  assertEquals(result?.contents?.value.includes('```ts'), true);
  assertEquals(result?.contents?.value.includes('number'), true);
  assertEquals(result?.range?.start.line, 4);
  assertEquals(result?.range?.start.character, sourceCharacter);
  assertEquals(result?.range?.end.character, sourceCharacter + 'source'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server provides definition inside nested .sts block macros', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const lines = [
    "import { Inner, Outer } from 'macros/test';",
    'declare const source: number;',
    'function wrap(): void {',
    '  Outer(() => {',
    '    const value = Inner(source);',
    '    void value;',
    '  });',
    '}',
    '',
  ];
  const text = lines.join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before nested block macro definition.',
  );

  const definitionRequestId = await client.sendRequest('textDocument/definition', {
    textDocument: { uri },
    position: { line: 4, character: lines[4]!.lastIndexOf('source') },
  });
  const response = await withTimeout(
    client.readResponse(definitionRequestId),
    250,
    'Timed out waiting for nested .sts block macro definition response.',
  );
  const result = response.result as
    | Array<{
      uri: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.uri, uri);
  assertEquals(result?.[0]?.range.start.line, 1);
  assertEquals(result?.[0]?.range.start.character, lines[1]!.indexOf('source'));
  assertEquals(result?.[0]?.range.end.character, lines[1]!.indexOf('source') + 'source'.length);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server remaps .sts diagnostic ranges after macro rewrites', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { log } from 'sts:experimental/debug';",
    'declare function __sts_log<T>(source: string, value: T): T;',
    'const ignored = log(1);',
    'const count: number = "oops";',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for remapped .sts diagnostics.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      range: {
        start: { character: number; line: number };
        end: { character: number; line: number };
      };
    }>;
  };

  assertEquals(params.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);
  assertEquals(params.diagnostics[0]?.range.start.line, 3);
  assertEquals(params.diagnostics[0]?.range.start.character, 'const '.length);
  assertNotEquals(params.diagnostics[0]?.range.start.character, 42);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server remaps ordinary TypeScript diagnostics after earlier macro rewrites to the original token span', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Try, err, Match, ok, type Err, type Ok, type Result, where } from 'sts:prelude';",
    '',
    'export function safeDivide(dividend: number, divisor: number): Result<number, string> {',
    '  if (divisor === 0) {',
    "    return err('divide_by_zero');",
    '  }',
    '',
    '  return ok(dividend / divisor);',
    '}',
    '',
    'export function divideThreeWays(',
    '  left: number,',
    '  middle: number,',
    '  right: number,',
    '): Result<number, string> {',
    '  const first = Try(safeDivide(left, middle));',
    '  const second = Try(safeDivide(first, right));',
    '  return ok(second);',
    '}',
    '',
    'export function describeDivision(dividend: number, divisor: number): string {',
    '  return Match(safeDivide(dividend, divisor), [',
    "    ({ value }: Ok<number>) => value === 4 ? 'ok:4' : 'ok',",
    "    ({ error }: Err<string>) => error === 'divide_by_zero' ? 'err:divide_by_zero' : 'err',",
    '  ]);',
    '}',
    '',
    'function matchTest(value: unknown): boolean {',
    '  return Match(value, [',
    "    where((x: Error) => true, (x) => 'code' in x),",
    '    (_) => false,',
    '  ]);',
    '}',
    '',
    'interface Animal { name: string; }',
    'interface Dog extends Animal { breed: string; }',
    '',
    'const dogs: readonly Dog[] = [];',
    'const animals: readonly Animal[] = dogs;',
    '',
    'animals.push({ name: "Whiskers" });',
    '',
  ].join('\n');
  const lines = text.split('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for remapped mixed macro/TS diagnostics.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      range: {
        start: { character: number; line: number };
        end: { character: number; line: number };
      };
    }>;
  };

  assertEquals(params.diagnostics.map((diagnostic) => diagnostic.code), ['TS2339']);
  assertEquals(params.diagnostics[0]?.range.start.line, 40);
  assertEquals(params.diagnostics[0]?.range.start.character, lines[40]!.indexOf('push'));
  assertEquals(params.diagnostics[0]?.range.end.line, 40);
  assertEquals(
    params.diagnostics[0]?.range.end.character,
    lines[40]!.indexOf('push') + 'push'.length,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server formats .sts documents without erasing macro syntax', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Bar, Foo } from 'macros/test';",
    '',
    'function wrap(){',
    'Foo(() => {',
    'const value=Bar(source)',
    'void value',
    '})',
    '}',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before formatting.',
  );

  const formattingRequestId = await client.sendRequest('textDocument/formatting', {
    textDocument: { uri },
    options: {
      insertSpaces: true,
      tabSize: 2,
    },
  });
  const response = await withTimeout(
    client.readResponse(formattingRequestId),
    250,
    'Timed out waiting for .sts formatting response.',
  );
  const result = response.result as
    | Array<{
      newText: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 1);
  assertEquals(result?.[0]?.range.start.line, 0);
  assertEquals(
    result?.[0]?.newText,
    [
      "import { Bar, Foo } from 'macros/test';",
      '',
      'function wrap() {',
      '  Foo(() => {',
      '    const value = Bar(source);',
      '    void value;',
      '  })',
      '}',
      '',
    ].join('\n'),
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server formats syntax macros through generic macro format hooks', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Match } from 'sts:match'",
    "const result=Match(value,[(ok:'ok')=> compute( left,right ),(_)=>fallback(value)])",
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before syntax-macro formatting.',
  );

  const formattingRequestId = await client.sendRequest('textDocument/formatting', {
    textDocument: { uri },
    options: {
      insertSpaces: true,
      tabSize: 2,
    },
  });
  const response = await withTimeout(
    client.readResponse(formattingRequestId),
    250,
    'Timed out waiting for syntax-macro formatting response.',
  );
  const result = response.result as
    | Array<{
      newText: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 1);
  assertEquals(
    result?.[0]?.newText,
    [
      "import { Match } from 'sts:match'",
      "const result = Match(value, [(ok: 'ok') => compute(left, right), (_) => fallback(value)])",
      '',
    ].join('\n'),
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server formats imported user-defined macros through public format hooks', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/macros/twice.macro.sts': createUserDefinedTwiceMacroText(),
  });
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { Twice } from './macros/twice.macro';",
    'const sourceValue = 1;',
    'const result=Twice( 1+ sourceValue );',
    '',
  ].join('\n');
  await openDocumentAndAwaitDiagnostics(
    client,
    {
      uri,
      languageId: 'soundscript',
      text,
    },
    'Timed out waiting for .sts diagnostics before user-defined macro formatting.',
  );

  const edits = await requestResult<
    Array<{
      newText: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }> | null
  >(
    client,
    'textDocument/formatting',
    {
      textDocument: { uri },
      options: {
        insertSpaces: true,
        tabSize: 2,
      },
    },
    'Timed out waiting for user-defined macro formatting response.',
  );

  assertEquals(edits?.length, 1);
  assertEquals(
    edits?.[0]?.newText,
    [
      "import { Twice } from './macros/twice.macro';",
      'const sourceValue = 1;',
      'const result = Twice(1 + sourceValue);',
      '',
    ].join('\n'),
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server formats embedded sql fragments through fragment formatting hooks', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  const text = [
    "import { sql } from 'sts:experimental/sql'",
    'const query=sql`select *',
    'from users',
    'where id = ${ userId }`',
    '',
  ].join('\n');
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text,
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for .sts diagnostics before sql formatting.',
  );

  const formattingRequestId = await client.sendRequest('textDocument/formatting', {
    textDocument: { uri },
    options: {
      insertSpaces: true,
      tabSize: 2,
    },
  });
  const response = await withTimeout(
    client.readResponse(formattingRequestId),
    250,
    'Timed out waiting for sql formatting response.',
  );
  const result = response.result as
    | Array<{
      newText: string;
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
    }>
    | null;

  assertEquals(result?.length, 1);
  assertEquals(
    result?.[0]?.newText,
    [
      "import { sql } from 'sts:experimental/sql'",
      'const query = sql`SELECT *',
      '  FROM users',
      '  WHERE id = ${userId}`',
      '',
    ].join('\n'),
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes diagnostics on didOpen using in-memory text', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: "const coerced = JSON.parse('1') as number;\n",
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1002');
  assertEquals(params.diagnostics[0]?.range.start.line, 0);
  if (
    params.diagnostics[0] &&
    params.diagnostics[0].range.end.character <= params.diagnostics[0].range.start.character + 1
  ) {
    throw new Error('Expected a multi-character diagnostic range for the sound assertion span.');
  }

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server preserves notes and hints in published diagnostics', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'interface Animal {',
        '  name: string;',
        '}',
        '',
        'interface Dog extends Animal {',
        '  breed: string;',
        '}',
        '',
        'const dogs: Dog[] = [{ name: "Rex", breed: "Lab" }];',
        'const animals: Animal[] = dogs;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics with notes/hint.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      message: string;
      relatedInformation?: unknown[];
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1019');
  assertEquals(
    params.diagnostics[0]?.message.includes('Mutable arrays are invariant in soundscript.'),
    true,
  );
  assertEquals(
    params.diagnostics[0]?.message.includes('Make the array readonly, copy into a fresh array'),
    true,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes structured diagnostic metadata in data', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/lib.ts': 'export const value = 1;\n',
  });
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'import { value } from "./lib";',
        'const exact: number = value;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics with structured metadata.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      data?: {
        hint?: string;
        metadata?: {
          fixability?: string;
          replacementFamily?: string;
          rule?: string;
        };
        notes?: string[];
      };
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1005');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'unsound_import_boundary');
  assertEquals(params.diagnostics[0]?.data?.metadata?.replacementFamily, 'interop_boundary');
  assertEquals(params.diagnostics[0]?.data?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    params.diagnostics[0]?.data?.hint,
    'Add `// #[interop]` immediately above the import boundary and validate the imported value before it flows deeper into soundscript.',
  );
  assertEquals(params.diagnostics[0]?.data?.notes, [
    'Values imported from ordinary `.ts`, JavaScript, or declaration-only modules remain outside checked soundscript code until an explicit interop boundary acknowledges the trust boundary.',
    'Example: // #[interop]\nimport { value } from "./lib";',
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes flow invalidation metadata and related information', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'function mutate(box: { value: string | null }): void { box.value = null; }',
        '',
        '',
        'function use(box: { value: string | null }) {',
        '  if (box.value !== null) {',
        '    mutate(box);',
        '    const value: string = box.value;',
        '    return value;',
        '  }',
        '  return "";',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics with flow invalidation metadata.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      data?: {
        metadata?: {
          evidence?: Array<{ label?: string; value?: string }>;
          fixability?: string;
          primarySymbol?: string;
          replacementFamily?: string;
          rule?: string;
          secondarySymbol?: string;
        };
      };
      relatedInformation?: Array<{
        location?: {
          uri?: string;
          range?: {
            start?: { line?: number; character?: number };
            end?: { line?: number; character?: number };
          };
        };
        message?: string;
      }>;
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1020');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'flow_narrowing_invalidation');
  assertEquals(params.diagnostics[0]?.data?.metadata?.replacementFamily, 'recheck_after_boundary');
  assertEquals(params.diagnostics[0]?.data?.metadata?.fixability, 'local_rewrite');
  assertEquals(params.diagnostics[0]?.data?.metadata?.primarySymbol, 'box.value');
  assertEquals(params.diagnostics[0]?.data?.metadata?.secondarySymbol, 'call');
  assertEquals(params.diagnostics[0]?.data?.metadata?.evidence, [
    { label: 'narrowedValue', value: 'box.value' },
    { label: 'boundaryKind', value: 'call' },
    { label: 'invalidatingBoundary', value: 'mutate(box)' },
    { label: 'earlierProof', value: 'box.value !== null' },
  ]);
  assertEquals(params.diagnostics[0]?.relatedInformation, [
    {
      location: {
        uri,
        range: {
          start: { line: 4, character: 6 },
          end: { line: 4, character: 24 },
        },
      },
      message: 'Earlier narrowing established here.',
    },
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes receiver-sensitive diagnostic metadata in data', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'class Box {',
        '  read(): number {',
        '    return 1;',
        '  }',
        '}',
        '',
        'const box = new Box();',
        'const extracted = box.read;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics with receiver-sensitive metadata.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      data?: {
        hint?: string;
        metadata?: {
          fixability?: string;
          primarySymbol?: string;
          replacementFamily?: string;
          rule?: string;
        };
        notes?: string[];
      };
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1035');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'receiver_sensitive_callable_value');
  assertEquals(params.diagnostics[0]?.data?.metadata?.primarySymbol, 'read');
  assertEquals(
    params.diagnostics[0]?.data?.metadata?.replacementFamily,
    'receiver_preserving_wrapper',
  );
  assertEquals(params.diagnostics[0]?.data?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    params.diagnostics[0]?.data?.hint,
    'Keep the call in member form like `box.read()`, or wrap it in a lambda that preserves the receiver.',
  );
  assertEquals(params.diagnostics[0]?.data?.notes, [
    'This callable depends on its original receiver and cannot safely become a standalone value.',
    'Example: Write `const extracted = () => box.read();` or keep the call as `box.read()`.',
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes type-assertion diagnostic metadata in data', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        "const coerced = JSON.parse('1') as number;",
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics with type-assertion metadata.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      data?: {
        hint?: string;
        metadata?: {
          fixability?: string;
          replacementFamily?: string;
          rule?: string;
        };
        notes?: string[];
      };
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1002');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'unchecked_type_assertion');
  assertEquals(
    params.diagnostics[0]?.data?.metadata?.replacementFamily,
    'control_flow_narrowing_or_boundary_validation',
  );
  assertEquals(params.diagnostics[0]?.data?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    params.diagnostics[0]?.data?.hint,
    'Use narrowing, validation, or an interop boundary instead of asserting the target type.',
  );
  assertEquals(params.diagnostics[0]?.data?.notes, [
    "This assertion changes the type from 'JsonValue' to 'number' without a checked proof.",
    'Example: Replace the assertion with a real runtime check, a validated interop boundary, or a helper that already returns the target type honestly.',
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes overload diagnostic metadata in data', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'function format(value: string): string;',
        'function format(value: number): number;',
        'function format(value: string | number): string | number {',
        '  return String(value);',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics with overload metadata.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      data?: {
        hint?: string;
        metadata?: {
          fixability?: string;
          primarySymbol?: string;
          replacementFamily?: string;
          rule?: string;
        };
        notes?: string[];
      };
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1018');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'overload_implementation_mismatch');
  assertEquals(params.diagnostics[0]?.data?.metadata?.primarySymbol, 'format');
  assertEquals(params.diagnostics[0]?.data?.metadata?.replacementFamily, 'honest_overload_surface');
  assertEquals(params.diagnostics[0]?.data?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    params.diagnostics[0]?.data?.hint,
    'Make the implementation satisfy every overload signature honestly, or remove overloads the body does not really implement.',
  );
  assertEquals(params.diagnostics[0]?.data?.notes, [
    "The implementation returns 'string', but the overload `format(value: number): number` promises a different result.",
    'Example: Return a `number` on the numeric path, or narrow the overload list so every declared overload matches the implementation.',
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes ambient extern diagnostic metadata in data', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'declare const envName: string;',
        'void envName;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics with ambient extern metadata.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      data?: {
        hint?: string;
        metadata?: {
          fixability?: string;
          primarySymbol?: string;
          replacementFamily?: string;
          rule?: string;
        };
        notes?: string[];
      };
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1029');
  assertEquals(
    params.diagnostics[0]?.data?.metadata?.rule,
    'ambient_runtime_requires_import_boundary',
  );
  assertEquals(params.diagnostics[0]?.data?.metadata?.primarySymbol, 'envName');
  assertEquals(
    params.diagnostics[0]?.data?.metadata?.replacementFamily,
    'extern_import_boundary',
  );
  assertEquals(params.diagnostics[0]?.data?.metadata?.fixability, 'boundary_annotation');
  assertEquals(
    params.diagnostics[0]?.data?.hint,
    'Move the ambient declaration to `.d.ts` and import the value through `extern:*`, or replace it with a real implementation.',
  );
  assertEquals(params.diagnostics[0]?.data?.notes, [
    'This local ambient runtime declaration introduces `envName` without an explicit import boundary.',
    [
      'Example: // #[interop]',
      "import { __APP_CONFIG__ as config } from 'extern:globalThis';",
    ].join('\n'),
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes exported ambient diagnostic metadata in data', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'export declare const envName: string;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics with exported ambient metadata.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      data?: {
        hint?: string;
        metadata?: {
          fixability?: string;
          primarySymbol?: string;
          replacementFamily?: string;
          rule?: string;
        };
        notes?: string[];
      };
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1030');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'ambient_runtime_export_forbidden');
  assertEquals(params.diagnostics[0]?.data?.metadata?.primarySymbol, 'envName');
  assertEquals(
    params.diagnostics[0]?.data?.metadata?.replacementFamily,
    'ambient_surface_split_or_real_implementation',
  );
  assertEquals(params.diagnostics[0]?.data?.metadata?.fixability, 'api_redesign');
  assertEquals(
    params.diagnostics[0]?.data?.hint,
    "Move exported declaration-only surfaces to '.d.ts' or provide a real implementation.",
  );
  assertEquals(params.diagnostics[0]?.data?.notes, [
    'This ambient runtime declaration exports `envName` from a soundscript module even though there is no local implementation.',
    "Example: Move the declaration to '.d.ts' and expose values through explicit imports, or replace it with a real implementation.",
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes construction-lifecycle diagnostic metadata in data', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'class Box {',
        '  value = 1;',
        '  read(): number {',
        '    return this.value;',
        '  }',
        '',
        '  constructor() {',
        '    this.read();',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics with construction-lifecycle metadata.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      data?: {
        hint?: string;
        metadata?: {
          fixability?: string;
          primarySymbol?: string;
          replacementFamily?: string;
          rule?: string;
        };
        notes?: string[];
      };
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUND1036');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'construction_lifecycle_violation');
  assertEquals(params.diagnostics[0]?.data?.metadata?.primarySymbol, 'read');
  assertEquals(
    params.diagnostics[0]?.data?.metadata?.replacementFamily,
    'finish_initialization_before_dispatch',
  );
  assertEquals(params.diagnostics[0]?.data?.metadata?.fixability, 'local_rewrite');
  assertEquals(
    params.diagnostics[0]?.data?.hint,
    'Finish initialization before calling instance members or letting `this` escape.',
  );
  assertEquals(params.diagnostics[0]?.data?.notes, [
    'This constructor dispatches through `this.read` before construction completes.',
    'Example: Write fields directly during construction, then call `read` from a post-construction method or factory step instead of from the constructor.',
  ]);

  await shutdownServer(client, startPromise);
});

Deno.test(
  'LSP server preserves nominal class diagnostic spans after interop import projection',
  async () => {
    const workspace = await createWorkspace();
    await writeWorkspaceFiles(workspace, {
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            allowImportingTsExtensions: true,
          },
          include: ['src/**/*.ts', 'src/**/*.sts'],
        },
        null,
        2,
      ),
      'src/types.ts': [
        'export interface Environment {}',
        'export const literalSchema: any = {};',
        'export const a: any = 1;',
        '',
      ].join('\n'),
    });

    const { client, startPromise } = await initializeServer(workspace);

    const uri = `file://${workspace}/src/index.sts`;
    const text = [
      '',
      '// #[interop]',
      'import { type Environment, literalSchema, a } from "./types.ts";',
      '',
      '',
      '// import { type Result, ok, err, type Ok, type Err, Match, Try } from "soundscript:prelude";',
      '',
      '// function safeDivide(divisor: number, denominator: number): Result<number, string> {',
      '//     if (denominator == 0) {',
      '//         return err("divid_by_zero");',
      '//     }',
      '',
      '//     return ok(divisor / denominator);',
      '// }',
      '',
      '// function matchDivision() {',
      '//     return Match (safeDivide(10, 0), [',
      '//         ({ value }: Ok<number>) => true,',
      '//         ({ err }: Err<string>) => false',
      '//     ]);',
      '// }',
      '',
      '// function tryDivision() {',
      '//     const value = Try (safeDivide(10, 0));',
      '',
      '//     return value;',
      '// }',
      '',
      'console.log(literalSchema)',
      '',
      'console.log(a)',
      '',
      'class B {',
      '    type: string;',
      '',
      '    constructor() {',
      '        this.type = "b";',
      '    }',
      '}',
      '',
      'class C {',
      '    type: string;',
      '',
      '    constructor() {',
      '        this.type = "c";',
      '    }',
      '}',
      '',
      'const b = new B();',
      'const c: C = b;',
      '',
    ].join('\n');

    await client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'soundscript',
        version: 1,
        text,
      },
    });

    const notification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      250,
      'Timed out waiting for publishDiagnostics for nominal class diagnostic span test.',
    );
    const params = notification.params as {
      diagnostics: Array<{
        code: string;
        range: {
          start: { character: number; line: number };
          end: { character: number; line: number };
        };
      }>;
      uri: string;
    };

    assertEquals(params.uri, uri);
    assertEquals(params.diagnostics.length, 1);
    assertEquals(params.diagnostics[0]?.code, 'SOUND1019');
    assertEquals(params.diagnostics[0]?.range.start.line, 49);
    assertEquals(params.diagnostics[0]?.range.start.character, 'const c: C = '.length);
    assertEquals(params.diagnostics[0]?.range.end.line, 49);
    assertEquals(params.diagnostics[0]?.range.end.character, 'const c: C = b'.length);

    await shutdownServer(client, startPromise);
  },
);

Deno.test('LSP server publishes diagnostics for files opened through a symlinked workspace path', async () => {
  const workspace = await createWorkspace();
  const symlinkParent = await Deno.makeTempDir({ prefix: 'soundscript-lsp-link-' });
  const symlinkWorkspace = join(symlinkParent, 'workspace-link');
  await Deno.symlink(workspace, symlinkWorkspace);

  const { client, startPromise } = await initializeServer(symlinkWorkspace);

  const uri = `file://${symlinkWorkspace}/src/index.ts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: 'const count: number = "oops";\n',
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for publishDiagnostics for symlinked workspace file.',
  );
  const params = notification.params as {
    diagnostics: Array<{ code: string }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server preserves current-file diagnostics when imported TypeScript files have macro parse errors', async () => {
  const workspace = await Deno.makeTempDir({ prefix: 'soundscript-lsp-imported-frontend-error-' });
  await Deno.mkdir(join(workspace, 'src'), { recursive: true });
  await Deno.writeTextFile(
    join(workspace, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
  );
  await Deno.writeTextFile(join(workspace, 'src/helper.ts'), 'export const bad = #foo(a,,b);\n');
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'import { bad } from "./helper.ts";',
        'const n3 = 3;',
        'const n4: string = n3;',
        'void bad;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for diagnostics when imported TypeScript files have macro parse errors.',
  );
  const params = notification.params as {
    diagnostics: Array<{ code: string }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics.map((diagnostic) => diagnostic.code), ['TS2322']);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server surfaces a visible diagnostic when no tsconfig is found', async () => {
  const workspace = await Deno.makeTempDir({ prefix: 'soundscript-lsp-no-project-' });
  await Deno.mkdir(join(workspace, 'src'), { recursive: true });
  const { client, server } = createMemoryTransportPair();
  const lsp = createServer(server);
  const startPromise = lsp.start();

  await client.sendRequest('initialize', {
    processId: null,
    rootUri: `file://${workspace}`,
    capabilities: {},
  });
  await client.readResponse(1);

  const uri = `file://${workspace}/src/index.ts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: 'export const value = 1;\n',
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for no-project publishDiagnostics.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      message: string;
      severity: number;
    }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics[0]?.code, 'SOUNDSCRIPT_NO_PROJECT');
  assertEquals(params.diagnostics[0]?.severity, 2);
  assertEquals(params.diagnostics[0]?.message.includes('No tsconfig.json was found'), true);

  await client.sendRequest('shutdown', null);
  await client.readResponse(2);
  await client.sendNotification('exit', null);
  await startPromise;
});

Deno.test('LSP server offers a quick fix to create tsconfig.json when no project is found', async () => {
  const workspace = await Deno.makeTempDir({ prefix: 'soundscript-lsp-no-project-action-' });
  await Deno.mkdir(join(workspace, 'src'), { recursive: true });
  const { client, server } = createMemoryTransportPair();
  const lsp = createServer(server);
  const startPromise = lsp.start();

  await client.sendRequest('initialize', {
    processId: null,
    rootUri: `file://${workspace}`,
    capabilities: {},
  });
  await client.readResponse(1);

  const uri = `file://${workspace}/src/index.ts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: 'export const value = 1;\n',
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for no-project publishDiagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code: string;
      message: string;
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
      severity: number;
    }>;
    uri: string;
  };

  const codeActionRequestId = await client.sendRequest('textDocument/codeAction', {
    textDocument: { uri },
    range: params.diagnostics[0]?.range,
    context: {
      diagnostics: params.diagnostics,
    },
  });
  const codeActionResponse = await withTimeout(
    client.readResponse(codeActionRequestId),
    250,
    'Timed out waiting for no-project codeAction response.',
  );
  const codeActionResult = codeActionResponse.result as
    | Array<{
      edit?: {
        changes?: Record<string, Array<{ newText: string }>>;
      };
      kind?: string;
      title: string;
    }>
    | null;
  const tsconfigUri = `file://${workspace}/tsconfig.json`;

  assertEquals(codeActionResult?.[0]?.title, 'Create tsconfig.json for soundscript');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[tsconfigUri]?.[0]?.newText.includes(
      '"include": [\n    "src/**/*.ts",\n    "src/**/*.sts"\n  ]',
    ),
    true,
  );

  await client.sendRequest('shutdown', null);
  await client.readResponse(3);
  await client.sendNotification('exit', null);
  await startPromise;
});

Deno.test(
  'LSP server offers a quick fix to create tsconfig.json in reduced bridge mode',
  async () => {
    const workspace = await Deno.makeTempDir({ prefix: 'soundscript-lsp-no-project-bridge-' });
    await Deno.mkdir(join(workspace, 'src'), { recursive: true });
    const { client, server } = createMemoryTransportPair();
    const lsp = createServer(server);
    const startPromise = lsp.start();

    await client.sendRequest('initialize', {
      processId: null,
      rootUri: `file://${workspace}`,
      capabilities: {},
      initializationOptions: {
        capabilityMode: 'editor-bridge',
      },
    });
    await client.readResponse(1);

    const uri = `file://${workspace}/src/index.sts`;
    await client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'soundscript',
        version: 1,
        text: 'export const value = 1;\n',
      },
    });

    const notification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      250,
      'Timed out waiting for reduced-bridge no-project publishDiagnostics before codeAction.',
    );
    const params = notification.params as {
      diagnostics: Array<{
        code: string;
        range: {
          end: { character: number; line: number };
          start: { character: number; line: number };
        };
      }>;
      uri: string;
    };

    const codeActionRequestId = await client.sendRequest('textDocument/codeAction', {
      textDocument: { uri },
      range: params.diagnostics[0]?.range,
      context: {
        diagnostics: params.diagnostics,
      },
    });
    const codeActionResponse = await withTimeout(
      client.readResponse(codeActionRequestId),
      250,
      'Timed out waiting for reduced-bridge no-project codeAction response.',
    );
    const codeActionResult = codeActionResponse.result as
      | Array<{
        edit?: {
          changes?: Record<string, Array<{ newText: string }>>;
        };
        kind?: string;
        title: string;
      }>
      | null;
    const tsconfigUri = `file://${workspace}/tsconfig.json`;

    assertEquals(codeActionResult?.[0]?.title, 'Create tsconfig.json for soundscript');
    assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
    assertEquals(
      codeActionResult?.[0]?.edit?.changes?.[tsconfigUri]?.[0]?.newText.includes(
        '"include": [\n    "src/**/*.ts",\n    "src/**/*.sts"\n  ]',
      ),
      true,
    );

    await client.sendRequest('shutdown', null);
    await client.readResponse(3);
    await client.sendNotification('exit', null);
    await startPromise;
  },
);

Deno.test('LSP server does not offer a same-file extern quick fix for ambient runtime declarations', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'declare const envName: string;',
      'void envName;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'declare const envName: string;',
        'void envName;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for ambient-extern diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(params.diagnostics[0]?.code, 'SOUND1029');
  assertEquals(
    params.diagnostics[0]?.data?.metadata?.rule,
    'ambient_runtime_requires_import_boundary',
  );

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    params.diagnostics,
    'Timed out waiting for ambient-extern codeAction response.',
  );

  assertEquals(
    codeActionResult?.some((action) => action.title.includes('#[extern]')) ?? false,
    false,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to add #[interop] for unsound imports', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/lib.ts': 'export const value = 1;\n',
    'src/index.sts': [
      'import { value } from "./lib";',
      'const exact: number = value;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'import { value } from "./lib";',
        'const exact: number = value;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for interop-boundary diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(params.diagnostics[0]?.code, 'SOUND1005');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'unsound_import_boundary');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    params.diagnostics,
    'Timed out waiting for interop-boundary codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Add #[interop] boundary');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '// #[interop]\n',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server adds #[interop] at the import boundary when requested from a use-site diagnostic', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/lib.ts': 'export const value = 1;\n',
    'src/index.sts': [
      'import { value } from "./lib";',
      'const exact: number = value;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'import { value } from "./lib";',
        'const exact: number = value;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for use-site interop diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const useSiteDiagnostic = params.diagnostics.find((diagnostic) =>
    diagnostic.code === 'SOUND1005' && diagnostic.range.start.line === 1
  );
  assertEquals(useSiteDiagnostic?.data?.metadata?.rule, 'unsound_import_boundary');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    useSiteDiagnostic ? [useSiteDiagnostic] : [],
    'Timed out waiting for use-site interop codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Add #[interop] boundary');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '// #[interop]\n',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server adds #[interop] at dynamic import boundaries from use-site diagnostics', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/lib.ts': 'export const value = 1;\n',
    'src/index.sts': [
      'async function load() {',
      '  const lib = await import("./lib");',
      '  const exact: number = lib.value;',
      '}',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'async function load() {',
        '  const lib = await import("./lib");',
        '  const exact: number = lib.value;',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for dynamic-import diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const useSiteDiagnostic = params.diagnostics.find((diagnostic) =>
    diagnostic.code === 'SOUND1005' && diagnostic.range.start.line === 2
  );
  assertEquals(useSiteDiagnostic?.data?.metadata?.rule, 'unsound_import_boundary');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    useSiteDiagnostic ? [useSiteDiagnostic] : [],
    'Timed out waiting for dynamic-import codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Add #[interop] boundary');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '  // #[interop]\n',
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server adds #[interop] at namespace import boundaries from use-site diagnostics', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/lib.ts': 'export const value = 1;\n',
    'src/index.sts': [
      'import * as lib from "./lib";',
      'const exact: number = lib.value;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'import * as lib from "./lib";',
        'const exact: number = lib.value;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for namespace-import diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const useSiteDiagnostic = params.diagnostics.find((diagnostic) =>
    diagnostic.code === 'SOUND1005' && diagnostic.range.start.line === 1
  );
  assertEquals(useSiteDiagnostic?.data?.metadata?.rule, 'unsound_import_boundary');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    useSiteDiagnostic ? [useSiteDiagnostic] : [],
    'Timed out waiting for namespace-import codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Add #[interop] boundary');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '// #[interop]\n',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server adds #[interop] at destructured dynamic import boundaries from use-site diagnostics', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/lib.ts': 'export const value = 1;\n',
    'src/index.sts': [
      'async function load() {',
      '  const { value } = await import("./lib");',
      '  const exact: number = value;',
      '}',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'async function load() {',
        '  const { value } = await import("./lib");',
        '  const exact: number = value;',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for destructured dynamic-import diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const useSiteDiagnostic = params.diagnostics.find((diagnostic) =>
    diagnostic.code === 'SOUND1005' && diagnostic.range.start.line === 2
  );
  assertEquals(useSiteDiagnostic?.data?.metadata?.rule, 'unsound_import_boundary');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    useSiteDiagnostic ? [useSiteDiagnostic] : [],
    'Timed out waiting for destructured dynamic-import codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Add #[interop] boundary');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '  // #[interop]\n',
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server does not offer #[interop] for rejected import-equals syntax', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/lib.ts': 'export const value = 1;\n',
    'src/index.sts': [
      'import lib = require("./lib");',
      'const exact: number = lib.value;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'import lib = require("./lib");',
        'const exact: number = lib.value;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for import-equals diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(
    params.diagnostics.map((diagnostic) => diagnostic.code),
    ['TS1202', 'TS1294'],
  );

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    params.diagnostics,
    'Timed out waiting for import-equals codeAction response.',
  );

  assertEquals(
    codeActionResult?.some((action) => action.title === 'Add #[interop] boundary') ?? false,
    false,
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to replace `var` with `let`', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'var count = 1;',
      'void count;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'var count = 1;',
        'void count;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for `var` diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.varDeclaration'
  );
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.varDeclaration');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for `var` codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Replace `var` with `let`');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'let',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to replace loose equality with strict equality', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'const left: unknown = 1;',
      'const right: unknown = "1";',
      'const equal = left == right;',
      'void equal;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'const left: unknown = 1;',
        'const right: unknown = "1";',
        'const equal = left == right;',
        'void equal;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for loose-equality diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.looseEquality'
  );
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.looseEquality');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for loose-equality codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Replace `==` with `===`');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '===',
      range: {
        start: { line: 2, character: 19 },
        end: { line: 2, character: 21 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to replace loose inequality with strict inequality', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'const left: unknown = 1;',
      'const right: unknown = "1";',
      'const different = left != right;',
      'void different;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'const left: unknown = 1;',
        'const right: unknown = "1";',
        'const different = left != right;',
        'void different;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for loose-inequality diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.looseEquality'
  );
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.looseEquality');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for loose-inequality codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Replace `!=` with `!==`');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '!==',
      range: {
        start: { line: 2, character: 23 },
        end: { line: 2, character: 25 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to replace `void 0` with `undefined`', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'const absent = void 0;',
      'void absent;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'const absent = void 0;',
        'void absent;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for `void 0` diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.voidZero'
  );
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.voidZero');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for `void 0` codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Replace `void 0` with `undefined`');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'undefined',
      range: {
        start: { line: 0, character: 15 },
        end: { line: 0, character: 21 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to rewrite legacy octal literals', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'const mask = 0755;',
      'void mask;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'const mask = 0755;',
        'void mask;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for legacy-octal diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.legacyOctalLiteral'
  );
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.legacyOctalLiteral');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for legacy-octal codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Rewrite `0755` as `0o755`');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '0o755',
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 17 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to remove unchecked type assertions', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: "const coerced = JSON.parse('1') as number;\n",
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for type-assertion diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) => entry.code === 'SOUND1002');
  assertEquals(diagnostic?.data?.metadata?.rule, 'unchecked_type_assertion');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for type-assertion codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Remove unchecked type assertion');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: "JSON.parse('1')",
      range: {
        start: { line: 0, character: 16 },
        end: { line: 0, character: 41 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to remove non-null assertions', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'const maybe: string | undefined = undefined;',
      '',
      'const value = maybe!;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'const maybe: string | undefined = undefined;',
        '',
        'const value = maybe!;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for non-null diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) => entry.code === 'SOUND1003');
  assertEquals(diagnostic?.data?.metadata?.rule, 'unchecked_non_null_assertion');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for non-null codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Remove non-null assertion');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'maybe',
      range: {
        start: { line: 2, character: 14 },
        end: { line: 2, character: 20 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to replace `any` with `unknown`', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: 'const payload: any = 1;\n',
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for `any` diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) => entry.code === 'SOUND1001');
  assertEquals(diagnostic?.data?.metadata?.rule, 'any_type');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for `any` codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Replace `any` with `unknown`');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'unknown',
      range: {
        start: { line: 0, character: 15 },
        end: { line: 0, character: 18 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to remove exports from ambient runtime declarations', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'export declare const envName: string;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'export declare const envName: string;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for ambient-export diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) => entry.code === 'SOUND1030');
  assertEquals(diagnostic?.data?.metadata?.rule, 'ambient_runtime_export_forbidden');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for ambient-export codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Remove `export` from ambient runtime declaration');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 7 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to remove invalid annotation comments', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      '// #[extern]',
      'const local = 1;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        '// #[extern]',
        'const local = 1;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for invalid-annotation-target diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          primarySymbol?: string;
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) => entry.code === 'SOUND1007');
  assertEquals(diagnostic?.data?.metadata?.rule, 'extern_annotation_removed');
  assertEquals(diagnostic?.data?.metadata?.primarySymbol, '#[extern]');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for invalid-annotation-target codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Remove unknown annotation comment');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to wrap non-Error throws', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'function fail() {',
      '  throw "boom";',
      '}',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'function fail() {',
        '  throw "boom";',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for throw-non-error diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) => entry.code === 'SOUND1025');
  assertEquals(diagnostic?.data?.metadata?.rule, 'throw_non_error');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for throw-non-error codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Wrap thrown value in `new Error(...)`');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'new Error(String("boom"))',
      range: {
        start: { line: 1, character: 8 },
        end: { line: 1, character: 14 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to bind receiver-sensitive extracted methods', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'class Box {',
      '  value = 1;',
      '  read(): number {',
      '    return this.value;',
      '  }',
      '}',
      '',
      'const box = new Box();',
      'const extracted = box.read;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'class Box {',
        '  value = 1;',
        '  read(): number {',
        '    return this.value;',
        '  }',
        '}',
        '',
        'const box = new Box();',
        'const extracted = box.read;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for receiver-sensitive diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          primarySymbol?: string;
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) => entry.code === 'SOUND1035');
  assertEquals(diagnostic?.data?.metadata?.rule, 'receiver_sensitive_callable_value');
  assertEquals(diagnostic?.data?.metadata?.primarySymbol, 'read');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for receiver-sensitive codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Bind the receiver for the extracted method');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'box.read.bind(box)',
      range: {
        start: { line: 8, character: 18 },
        end: { line: 8, character: 26 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to replace nullable-object truthiness checks', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'type Box = { value: number };',
      'const maybeBox: Box | null = Math.random() > 0.5 ? { value: 1 } : null;',
      'if (maybeBox) {',
      '  void maybeBox.value;',
      '}',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'type Box = { value: number };',
        'const maybeBox: Box | null = Math.random() > 0.5 ? { value: 1 } : null;',
        'if (maybeBox) {',
        '  void maybeBox.value;',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for nullable-object truthiness diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.nonBooleanCondition'
  );
  assertEquals(diagnostic?.data?.metadata?.rule, 'unsupported_feature');
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.nonBooleanCondition');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for nullable-object truthiness codeAction response.',
  );

  assertEquals(
    codeActionResult?.[0]?.title,
    'Replace truthiness check with `maybeBox !== null`',
  );
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'maybeBox !== null',
      range: {
        start: { line: 2, character: 4 },
        end: { line: 2, character: 12 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to replace undefined-object truthiness checks', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'type Box = { value: number };',
      'const maybeBox: Box | undefined = Math.random() > 0.5 ? { value: 1 } : undefined;',
      'if (maybeBox) {',
      '  void maybeBox.value;',
      '}',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'type Box = { value: number };',
        'const maybeBox: Box | undefined = Math.random() > 0.5 ? { value: 1 } : undefined;',
        'if (maybeBox) {',
        '  void maybeBox.value;',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for undefined-object truthiness diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.nonBooleanCondition'
  );
  assertEquals(diagnostic?.data?.metadata?.rule, 'unsupported_feature');
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.nonBooleanCondition');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for undefined-object truthiness codeAction response.',
  );

  assertEquals(
    codeActionResult?.[0]?.title,
    'Replace truthiness check with `maybeBox !== undefined`',
  );
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'maybeBox !== undefined',
      range: {
        start: { line: 2, character: 4 },
        end: { line: 2, character: 12 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server does not offer a nullish rewrite for ambiguous truthiness checks', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'const maybeText: string | undefined = Math.random() > 0.5 ? "x" : undefined;',
      'if (maybeText) {',
      '  void maybeText;',
      '}',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'const maybeText: string | undefined = Math.random() > 0.5 ? "x" : undefined;',
        'if (maybeText) {',
        '  void maybeText;',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for ambiguous truthiness diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.nonBooleanCondition'
  );
  assertEquals(diagnostic?.data?.metadata?.rule, 'unsupported_feature');
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.nonBooleanCondition');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for ambiguous truthiness codeAction response.',
  );

  assertEquals(codeActionResult, null);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to make left logical operands explicitly boolean', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'type Box = { value: number };',
      'const maybeBox: Box | null = Math.random() > 0.5 ? { value: 1 } : null;',
      'const ready = true;',
      'const shouldUse = maybeBox && ready;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'type Box = { value: number };',
        'const maybeBox: Box | null = Math.random() > 0.5 ? { value: 1 } : null;',
        'const ready = true;',
        'const shouldUse = maybeBox && ready;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for logical-operator diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.nonBooleanLogicalOperator'
  );
  assertEquals(diagnostic?.data?.metadata?.rule, 'unsupported_feature');
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.nonBooleanLogicalOperator');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for left logical-operand codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Make `&&` operands explicitly boolean');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'maybeBox !== null && ready',
      range: {
        start: { line: 3, character: 18 },
        end: { line: 3, character: 35 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to make right logical operands explicitly boolean', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'type Box = { value: number };',
      'const maybeBox: Box | undefined = Math.random() > 0.5 ? { value: 1 } : undefined;',
      'const ready = true;',
      'const shouldUse = ready && maybeBox;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'type Box = { value: number };',
        'const maybeBox: Box | undefined = Math.random() > 0.5 ? { value: 1 } : undefined;',
        'const ready = true;',
        'const shouldUse = ready && maybeBox;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for right logical-operand diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.nonBooleanLogicalOperator'
  );
  assertEquals(diagnostic?.data?.metadata?.rule, 'unsupported_feature');
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.nonBooleanLogicalOperator');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for right logical-operand codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Make `&&` operands explicitly boolean');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'ready && maybeBox !== undefined',
      range: {
        start: { line: 3, character: 18 },
        end: { line: 3, character: 35 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to make `||` operands explicitly boolean', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'type Box = { value: number };',
      'const maybeBox: Box | null = Math.random() > 0.5 ? { value: 1 } : null;',
      'const ready = false;',
      'const shouldUse = maybeBox || ready;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'type Box = { value: number };',
        'const maybeBox: Box | null = Math.random() > 0.5 ? { value: 1 } : null;',
        'const ready = false;',
        'const shouldUse = maybeBox || ready;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for `||` logical-operator diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.nonBooleanLogicalOperator'
  );
  assertEquals(diagnostic?.data?.metadata?.rule, 'unsupported_feature');
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.nonBooleanLogicalOperator');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for `||` logical-operator codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Make `||` operands explicitly boolean');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: 'maybeBox !== null || ready',
      range: {
        start: { line: 3, character: 18 },
        end: { line: 3, character: 35 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server does not offer boolean rewrites for ambiguous logical operands', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      'const maybeText: string | undefined = Math.random() > 0.5 ? "x" : undefined;',
      'const ready = true;',
      'const shouldUse = maybeText && ready;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        'const maybeText: string | undefined = Math.random() > 0.5 ? "x" : undefined;',
        'const ready = true;',
        'const shouldUse = maybeText && ready;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for ambiguous logical-operand diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          featureId?: string;
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) =>
    entry.code === 'SOUND1022' &&
    entry.data?.metadata?.featureId === 'unsupported.nonBooleanLogicalOperator'
  );
  assertEquals(diagnostic?.data?.metadata?.rule, 'unsupported_feature');
  assertEquals(diagnostic?.data?.metadata?.featureId, 'unsupported.nonBooleanLogicalOperator');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for ambiguous logical-operand codeAction response.',
  );

  assertEquals(codeActionResult, null);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to remove TypeScript pragma comments', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      '// @ts-ignore',
      "const value: number = 'nope';",
      'void value;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        '// @ts-ignore',
        "const value: number = 'nope';",
        'void value;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for TypeScript pragma diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  const diagnostic = params.diagnostics.find((entry) => entry.code === 'SOUND1023');
  assertEquals(diagnostic?.data?.metadata?.rule, 'typescript_pragma_banned');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    diagnostic ? [diagnostic] : [],
    'Timed out waiting for TypeScript pragma codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Remove TypeScript pragma comment');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to remove malformed annotation comments', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      '// #[unsafe(',
      'const value = 1;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        '// #[unsafe(',
        'const value = 1;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for malformed-annotation diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(params.diagnostics[0]?.code, 'SOUND1006');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'malformed_annotation_comment');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    params.diagnostics,
    'Timed out waiting for malformed-annotation codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Remove malformed annotation comment');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to remove duplicate annotations in a block', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      '// #[unsafe]',
      '// #[unsafe]',
      'const envName = "dev";',
      'void envName;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        '// #[unsafe]',
        '// #[unsafe]',
        'const envName = "dev";',
        'void envName;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for duplicate-annotation diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(params.diagnostics[0]?.code, 'SOUND1026');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'duplicate_annotation');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    params.diagnostics,
    'Timed out waiting for duplicate-annotation codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Remove duplicate annotation entries');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '',
      range: {
        start: { line: 1, character: 0 },
        end: { line: 2, character: 0 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server publishes diagnostics for unknown annotation namespaces', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      '// #[trusted]',
      'const value = 1;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        '// #[trusted]',
        'const value = 1;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for diagnostics after opening a file with unknown annotations.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(params.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1007']);
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'unknown_annotation');

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to remove unsupported annotation arguments', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      '// #[unsafe(foo)]',
      'const envName = "dev";',
      'void envName;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        '// #[unsafe(foo)]',
        'const envName = "dev";',
        'void envName;',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for annotation-arguments diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(params.diagnostics[0]?.code, 'SOUND1028');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'annotation_arguments_not_supported');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    params.diagnostics,
    'Timed out waiting for annotation-arguments codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Remove unsupported annotation arguments');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '// #[unsafe]',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 17 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to alias imported annotation macros that shadow builtins', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      "import { unsafe } from 'macros/test';",
      '',
      '// #[unsafe]',
      'const envName = "dev";',
      'void envName;',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        "import { unsafe } from 'macros/test';",
        '',
        '// #[unsafe]',
        'const envName = "dev";',
        'void envName;',
        '',
      ].join('\n'),
    },
  });

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    [{
      code: 'SOUND1033',
      data: {
        metadata: {
          rule: 'reserved_annotation_name_conflict',
          evidence: [
            { label: 'annotationName', value: 'unsafe' },
            { label: 'importSpecifier', value: 'macros/test' },
            { label: 'importedBinding', value: 'unsafe' },
          ],
        },
      },
      message:
        'Builtin annotation names take precedence in annotation position; imported annotation macros must use distinct bindings.',
      range: {
        start: { line: 2, character: 0 },
        end: { line: 2, character: 12 },
      },
    }],
    'Timed out waiting for reserved-annotation codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Alias imported annotation macro');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri],
    [
      {
        newText: 'unsafe as macroUnsafe',
        range: {
          start: { line: 0, character: 9 },
          end: { line: 0, character: 15 },
        },
      },
      {
        newText: '// #[macroUnsafe]',
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: 12 },
        },
      },
    ],
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to rewrite invalid checked variance contracts', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      '// #[variance(T: out)]',
      'type Pair<T, U> = [T, U];',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        '// #[variance(T: out)]',
        'type Pair<T, U> = [T, U];',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for invalid-variance diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
          secondarySymbol?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(params.diagnostics[0]?.code, 'SOUND1031');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'invalid_variance_annotation');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    params.diagnostics,
    'Timed out waiting for invalid-variance codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Rewrite checked variance contract');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '// #[variance(T: inout, U: inout)]',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 22 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server offers a quick fix to align checked variance contracts with the proven surface', async () => {
  const workspace = await createWorkspace();
  await writeWorkspaceFiles(workspace, {
    'src/index.sts': [
      '// #[variance(T: out)]',
      'export interface Sink<T> {',
      '  push(value: T): void;',
      '}',
      '',
    ].join('\n'),
  });

  const { client, startPromise } = await initializeServer(workspace);
  const uri = `file://${workspace}/src/index.sts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'soundscript',
      version: 1,
      text: [
        '// #[variance(T: out)]',
        'export interface Sink<T> {',
        '  push(value: T): void;',
        '}',
        '',
      ].join('\n'),
    },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for variance-mismatch diagnostics before codeAction.',
  );
  const params = notification.params as {
    diagnostics: Array<{
      code?: string;
      data?: {
        metadata?: {
          rule?: string;
          secondarySymbol?: string;
        };
      };
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
    uri: string;
  };

  assertEquals(params.diagnostics[0]?.code, 'SOUND1032');
  assertEquals(params.diagnostics[0]?.data?.metadata?.rule, 'variance_annotation_mismatch');

  const codeActionResult = await requestCodeActions(
    client,
    uri,
    params.diagnostics,
    'Timed out waiting for variance-mismatch codeAction response.',
  );

  assertEquals(codeActionResult?.[0]?.title, 'Align checked variance contract');
  assertEquals(codeActionResult?.[0]?.kind, 'quickfix');
  assertEquals(
    codeActionResult?.[0]?.edit?.changes?.[uri]?.[0],
    {
      newText: '// #[variance(T: in)]',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 22 },
      },
    },
  );

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server republishes diagnostics on didChange', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: "const coerced = JSON.parse('1') as number;\n",
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics.',
  );

  await client.sendNotification('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: "export const value = 'ok';\n" }],
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for changed publishDiagnostics.',
  );
  const params = notification.params as {
    diagnostics: Array<{ code: string }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics.length, 0);

  await shutdownServer(client, startPromise);
});

Deno.test(
  'LSP server publishes package-exported macro helper drift diagnostics across mixed open documents',
  async () => {
    const workspace = await createPackageExportedMacroDriftWorkspace();
    const { client, startPromise } = await initializeServer(workspace);

    const consumerUri = `file://${workspace}/src/consumer.sts`;
    const otherUri = `file://${workspace}/src/other.sts`;
    const consumerText = [
      'import { Foo } from "sound-pkg/api";',
      'export const value: number = Foo();',
      '',
    ].join('\n');
    const otherText = ['export const shadow = 1;', ''].join('\n');
    const otherChangedText = ['export const shadow = 2;', ''].join('\n');

    await client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: consumerUri,
        languageId: 'soundscript',
        version: 1,
        text: consumerText,
      },
    });
    const initialConsumerNotification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      250,
      'Timed out waiting for initial consumer publishDiagnostics.',
    );
    const initialConsumerParams = initialConsumerNotification.params as {
      diagnostics: Array<{ code: string }>;
      uri: string;
    };

    assertEquals(initialConsumerParams.uri, consumerUri);
    assertEquals(initialConsumerParams.diagnostics, []);

    await client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: otherUri,
        languageId: 'soundscript',
        version: 1,
        text: otherText,
      },
    });
    const initialOtherNotification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      250,
      'Timed out waiting for initial other publishDiagnostics.',
    );
    const initialOtherParams = initialOtherNotification.params as {
      diagnostics: Array<{ code: string }>;
      uri: string;
    };

    assertEquals(initialOtherParams.uri, otherUri);
    assertEquals(initialOtherParams.diagnostics, []);

    await Deno.writeTextFile(
      join(workspace, 'node_modules/sound-pkg/src/helper.macro.sts'),
      'export const helperExpression = \'"wrong"\';\n',
    );

    await client.sendNotification('textDocument/didChange', {
      textDocument: { uri: otherUri, version: 2 },
      contentChanges: [{ text: otherChangedText }],
    });
    const changedOtherNotification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      250,
      'Timed out waiting for changed other publishDiagnostics.',
    );
    const changedOtherParams = changedOtherNotification.params as {
      diagnostics: Array<{ code: string }>;
      uri: string;
    };

    assertEquals(changedOtherParams.uri, otherUri);
    assertEquals(changedOtherParams.diagnostics, []);

    // The server only republishes diagnostics for the URI that changed, so we
    // trigger a no-op consumer didChange to surface the package-backed drift.
    await client.sendNotification('textDocument/didChange', {
      textDocument: { uri: consumerUri, version: 2 },
      contentChanges: [{ text: consumerText }],
    });
    const consumerNotification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      250,
      'Timed out waiting for consumer publishDiagnostics after helper drift.',
    );
    const consumerParams = consumerNotification.params as {
      diagnostics: Array<{ code: string }>;
      uri: string;
    };

    assertEquals(consumerParams.uri, consumerUri);
    assertEquals(consumerParams.diagnostics.map((diagnostic) => diagnostic.code), [
      'TS2322',
    ]);

    await shutdownServer(client, startPromise);
  },
);

Deno.test(
  'LSP server refreshes package-exported macro helper drift from watched file changes',
  async () => {
    const workspace = await createPackageExportedMacroDriftWorkspace();
    const { client, startPromise } = await initializeServer(workspace);

    const consumerUri = `file://${workspace}/src/consumer.sts`;
    const helperUri = `file://${workspace}/node_modules/sound-pkg/src/helper.macro.sts`;
    const consumerText = [
      'import { Foo } from "sound-pkg/api";',
      'export const value: number = Foo();',
      '',
    ].join('\n');

    await client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: consumerUri,
        languageId: 'soundscript',
        version: 1,
        text: consumerText,
      },
    });
    const initialConsumerNotification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      250,
      'Timed out waiting for initial watched-file consumer publishDiagnostics.',
    );
    const initialConsumerParams = initialConsumerNotification.params as {
      diagnostics: Array<{ code: string }>;
      uri: string;
    };

    assertEquals(initialConsumerParams.uri, consumerUri);
    assertEquals(initialConsumerParams.diagnostics, []);

    await Deno.writeTextFile(
      join(workspace, 'node_modules/sound-pkg/src/helper.macro.sts'),
      'export const helperExpression = \'"wrong"\';\n',
    );

    await client.sendNotification('workspace/didChangeWatchedFiles', {
      changes: [{ uri: helperUri, type: 2 }],
    });
    const consumerNotification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      500,
      'Timed out waiting for watched-file consumer publishDiagnostics after helper drift.',
    );
    const consumerParams = consumerNotification.params as {
      diagnostics: Array<{ code: string }>;
      uri: string;
    };

    assertEquals(consumerParams.uri, consumerUri);
    assertEquals(consumerParams.diagnostics.map((diagnostic) => diagnostic.code), [
      'TS2322',
    ]);

    await shutdownServer(client, startPromise);
  },
);

Deno.test(
  'LSP server refreshes Function adapter forwarding diagnostics from watched file changes',
  async () => {
    const workspace = await createFunctionAdapterForwardingWorkspace();
    const { client, startPromise } = await initializeServer(workspace);

    const indexUri = `file://${workspace}/src/index.sts`;
    const effectsUri = `file://${workspace}/src/effects.sts`;
    const indexText = [
      'import { auditedApply, auditedBind, auditedCall, pureCallback } from "./effects";',
      '',
      '// #[effects(forbid: [host])]',
      'export function runBind(): number {',
      '  return auditedBind(pureCallback, 1);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'export function runCall(): number {',
      '  return auditedCall(pureCallback, 1);',
      '}',
      '',
      '// #[effects(forbid: [host])]',
      'export function runApply(): number {',
      '  return auditedApply(pureCallback, 1);',
      '}',
      '',
    ].join('\n');

    await client.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: indexUri,
        languageId: 'soundscript',
        version: 1,
        text: indexText,
      },
    });
    const initialNotification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      250,
      'Timed out waiting for initial Function adapter publishDiagnostics.',
    );
    const initialParams = initialNotification.params as {
      diagnostics: Array<{ code: string }>;
      uri: string;
    };

    assertEquals(initialParams.uri, indexUri);
    assertEquals(initialParams.diagnostics, []);

    await Deno.writeTextFile(
      join(workspace, 'src/effects.sts'),
      createFunctionAdapterForwardingEffectsSource(true),
    );

    await client.sendNotification('workspace/didChangeWatchedFiles', {
      changes: [{ uri: effectsUri, type: 2 }],
    });
    const changedNotification = await withTimeout(
      client.readNotification('textDocument/publishDiagnostics'),
      500,
      'Timed out waiting for watched-file Function adapter diagnostics.',
    );
    const changedParams = changedNotification.params as {
      diagnostics: Array<{ code: string; data?: { metadata?: { primarySymbol?: string } } }>;
      uri: string;
    };

    assertEquals(changedParams.uri, indexUri);
    assertEquals(changedParams.diagnostics.map((diagnostic) => diagnostic.code), [
      'SOUND1041',
      'SOUND1041',
      'SOUND1041',
    ]);
    assertEquals(
      changedParams.diagnostics.map((diagnostic) => diagnostic.data?.metadata?.primarySymbol),
      ['runBind', 'runCall', 'runApply'],
    );

    await shutdownServer(client, startPromise);
  },
);

Deno.test('LSP server coalesces rapid didChange diagnostics to the latest document version', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: 'const value: number = 1;\n',
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics.',
  );

  await client.sendNotification('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: 'const value: number = "oops";\n' }],
  });
  await client.sendNotification('textDocument/didChange', {
    textDocument: { uri, version: 3 },
    contentChanges: [{ text: 'const value: number = 2;\n' }],
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    500,
    'Timed out waiting for coalesced publishDiagnostics.',
  );
  const params = notification.params as {
    diagnostics: Array<{ code: string }>;
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics, []);

  await shutdownServer(client, startPromise);
});

Deno.test('LSP server clears diagnostics on didClose', async () => {
  const workspace = await createWorkspace();
  const { client, startPromise } = await initializeServer(workspace);

  const uri = `file://${workspace}/src/index.ts`;
  await client.sendNotification('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: 'typescript',
      version: 1,
      text: "const coerced = JSON.parse('1') as number;\n",
    },
  });
  await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for initial publishDiagnostics.',
  );

  await client.sendNotification('textDocument/didClose', {
    textDocument: { uri },
  });

  const notification = await withTimeout(
    client.readNotification('textDocument/publishDiagnostics'),
    250,
    'Timed out waiting for close publishDiagnostics.',
  );
  const params = notification.params as {
    diagnostics: unknown[];
    uri: string;
  };

  assertEquals(params.uri, uri);
  assertEquals(params.diagnostics, []);

  await shutdownServer(client, startPromise);
});
