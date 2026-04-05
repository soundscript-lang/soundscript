import { toFileUrl } from '../platform/path.ts';

import type { MergedDiagnostic } from '../checker/diagnostics.ts';

import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from './protocol.ts';
import {
  analyzeOpenDocument,
  codeActionsOpenDocument,
  completeOpenDocument,
  definitionOpenDocument,
  documentSymbolsOpenDocument,
  formatOpenDocument,
  highlightOpenDocument,
  hoverOpenDocument,
  prepareRenameOpenDocument,
  referencesOpenDocument,
  renameOpenDocument,
  semanticTokensLegend,
  semanticTokensOpenDocument,
  showExpandedSourceOpenDocument,
  showMacroTraceOpenDocument,
  signatureHelpOpenDocument,
} from './project_service.ts';
import { SessionState } from './session.ts';
import { measureLspTimingAsync } from './timing.ts';
import type { MessageTransport } from './transport.ts';

export interface LspServer {
  start(): Promise<void>;
}

const INITIAL_DIAGNOSTIC_DELAY_MS = 0;
const CHANGED_DIAGNOSTIC_DELAY_MS = 75;

interface DidOpenTextDocumentParams {
  textDocument: {
    languageId: string;
    text: string;
    uri: string;
    version: number;
  };
}

interface DidChangeTextDocumentParams {
  contentChanges: Array<{
    text: string;
  }>;
  textDocument: {
    uri: string;
    version: number;
  };
}

interface DidCloseTextDocumentParams {
  textDocument: {
    uri: string;
  };
}

interface TextDocumentPositionParams {
  position: {
    character: number;
    line: number;
  };
  textDocument: {
    uri: string;
  };
}

interface DocumentFormattingParams {
  options: {
    insertSpaces: boolean;
    tabSize: number;
  };
  textDocument: {
    uri: string;
  };
}

interface ReferenceParams extends TextDocumentPositionParams {
  context?: {
    includeDeclaration?: boolean;
  };
}

interface RenameParams extends TextDocumentPositionParams {
  newName: string;
}

interface CodeActionParams {
  context?: {
    diagnostics?: Array<{
      code?: string;
      data?: {
        hint?: string;
        metadata?: MergedDiagnostic['metadata'];
        notes?: string[];
      };
      message?: string;
      range?: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
    }>;
  };
  textDocument: {
    uri: string;
  };
}

interface InitializeParams {
  initializationOptions?: {
    capabilityMode?: 'full' | 'editor-bridge';
  };
}

interface ExecuteCommandParams {
  arguments?: unknown[];
  command: string;
}

async function publishDiagnostics(
  transport: MessageTransport,
  session: SessionState,
  uri: string,
): Promise<void> {
  await measureLspTimingAsync('server.publishDiagnostics', { uri }, async () => {
    const analyzedDocument = analyzeOpenDocument(uri, session);
    await transport.write({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics: analyzedDocument.diagnostics.map(toLspDiagnostic),
      },
    });
  });
}

function createDiagnosticScheduler(
  transport: MessageTransport,
  session: SessionState,
) {
  const pendingTimeouts = new Map<string, number>();
  const scheduledVersions = new Map<string, number | undefined>();

  function cancel(uri: string): void {
    const timeout = pendingTimeouts.get(uri);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      pendingTimeouts.delete(uri);
    }
    scheduledVersions.delete(uri);
  }

  function schedule(uri: string, delayMs: number): void {
    cancel(uri);
    const scheduledVersion = session.get(uri)?.version;
    scheduledVersions.set(uri, scheduledVersion);
    const timeout = setTimeout(async () => {
      pendingTimeouts.delete(uri);
      const expectedVersion = scheduledVersions.get(uri);
      scheduledVersions.delete(uri);

      const currentVersion = session.get(uri)?.version;
      if (expectedVersion !== currentVersion) {
        return;
      }

      await publishDiagnostics(transport, session, uri);
    }, delayMs);
    pendingTimeouts.set(uri, timeout);
  }

  function dispose(): void {
    for (const timeout of pendingTimeouts.values()) {
      clearTimeout(timeout);
    }
    pendingTimeouts.clear();
    scheduledVersions.clear();
  }

  return { cancel, dispose, schedule };
}

function toLspDiagnostic(diagnostic: MergedDiagnostic): {
  code: string;
  data?: { hint?: string; metadata?: MergedDiagnostic['metadata']; notes?: string[] };
  message: string;
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
  relatedInformation?: Array<{
    location: {
      range: {
        end: { character: number; line: number };
        start: { character: number; line: number };
      };
      uri: string;
    };
    message: string;
  }>;
  severity: 1 | 2 | 3;
  source: string;
} {
  const startLine = Math.max((diagnostic.line ?? 1) - 1, 0);
  const startCharacter = Math.max((diagnostic.column ?? 1) - 1, 0);
  const endLine = Math.max((diagnostic.endLine ?? diagnostic.line ?? 1) - 1, startLine);
  const endCharacter = diagnostic.endColumn !== undefined
    ? Math.max(diagnostic.endColumn - 1, 0)
    : startLine === endLine
    ? startCharacter + 1
    : 0;
  const details: string[] = [];
  for (const note of diagnostic.notes ?? []) {
    details.push(`Note: ${note}`);
  }
  if (diagnostic.hint) {
    details.push(`Hint: ${diagnostic.hint}`);
  }

  return {
    code: diagnostic.code,
    data: diagnostic.notes || diagnostic.hint
      ? {
        notes: diagnostic.notes,
        hint: diagnostic.hint,
        metadata: diagnostic.metadata,
      }
      : diagnostic.metadata
      ? {
        metadata: diagnostic.metadata,
      }
      : undefined,
    message: [diagnostic.message, ...details].join('\n\n'),
    range: {
      start: { line: startLine, character: startCharacter },
      end: {
        line: endLine,
        character: endLine === startLine
          ? Math.max(endCharacter, startCharacter + 1)
          : endCharacter,
      },
    },
    relatedInformation: diagnostic.relatedInformation?.flatMap((relatedInformation) => {
      if (!relatedInformation.filePath) {
        return [];
      }

      const relatedStartLine = Math.max((relatedInformation.line ?? 1) - 1, 0);
      const relatedStartCharacter = Math.max((relatedInformation.column ?? 1) - 1, 0);
      const relatedEndLine = Math.max(
        (relatedInformation.endLine ?? relatedInformation.line ?? 1) - 1,
        relatedStartLine,
      );
      const relatedEndCharacter = relatedInformation.endColumn !== undefined
        ? Math.max(relatedInformation.endColumn - 1, 0)
        : relatedEndLine === relatedStartLine
        ? relatedStartCharacter + 1
        : 0;

      return [{
        location: {
          uri: toFileUrl(relatedInformation.filePath).href,
          range: {
            start: { line: relatedStartLine, character: relatedStartCharacter },
            end: {
              line: relatedEndLine,
              character: relatedEndLine === relatedStartLine
                ? Math.max(relatedEndCharacter, relatedStartCharacter + 1)
                : relatedEndCharacter,
            },
          },
        },
        message: relatedInformation.message,
      }];
    }),
    severity: diagnostic.category === 'error' ? 1 : diagnostic.category === 'warning' ? 2 : 3,
    source: diagnostic.source,
  };
}

function createResponse(request: JsonRpcRequest, result: unknown): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result,
  };
}

function resolveCapabilityMode(message: JsonRpcRequest): 'full' | 'editor-bridge' {
  const params = message.params as InitializeParams | undefined;
  return params?.initializationOptions?.capabilityMode === 'editor-bridge'
    ? 'editor-bridge'
    : 'full';
}

function createServerCapabilities(
  capabilityMode: 'full' | 'editor-bridge',
  semanticTokenLegend: ReturnType<typeof semanticTokensLegend>,
) {
  const sharedCapabilities = {
    codeActionProvider: {
      codeActionKinds: ['quickfix'],
    },
    documentFormattingProvider: true,
    executeCommandProvider: {
      commands: [
        'soundscript.showExpandedSource',
        'soundscript.showMacroTrace',
      ],
    },
    semanticTokensProvider: {
      full: true,
      legend: semanticTokenLegend,
    },
    textDocumentSync: {
      openClose: true,
      change: 1,
    },
  };

  if (capabilityMode === 'editor-bridge') {
    return {
      ...sharedCapabilities,
      completionProvider: {
        triggerCharacters: ['.'],
      },
      definitionProvider: true,
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
      },
    };
  }

  return {
    ...sharedCapabilities,
    completionProvider: {
      triggerCharacters: ['.'],
    },
    definitionProvider: true,
    documentHighlightProvider: true,
    documentSymbolProvider: true,
    hoverProvider: true,
    signatureHelpProvider: {
      triggerCharacters: ['(', ','],
    },
    renameProvider: {
      prepareProvider: true,
    },
    referencesProvider: true,
  };
}

export function createServer(transport: MessageTransport): LspServer {
  let exitRequested = false;
  let shutdownRequested = false;
  let capabilityMode: 'full' | 'editor-bridge' = 'full';
  const session = new SessionState();
  const diagnosticScheduler = createDiagnosticScheduler(transport, session);
  const semanticTokenLegend = semanticTokensLegend();

  return {
    async start(): Promise<void> {
      while (!exitRequested) {
        const message = await transport.read();
        if (message === null) {
          diagnosticScheduler.dispose();
          return;
        }

        if (isJsonRpcRequest(message)) {
          switch (message.method) {
            case 'initialize': {
              capabilityMode = resolveCapabilityMode(message);
              await transport.write(
                createResponse(message, {
                  capabilities: createServerCapabilities(capabilityMode, semanticTokenLegend),
                }),
              );
              break;
            }
            case 'textDocument/completion': {
              const params = message.params as TextDocumentPositionParams;
              await transport.write(
                createResponse(
                  message,
                  completeOpenDocument(
                    params.textDocument.uri,
                    params.position.line,
                    params.position.character,
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/codeAction': {
              const params = message.params as CodeActionParams;
              await transport.write(
                createResponse(
                  message,
                  codeActionsOpenDocument(
                    params.textDocument.uri,
                    params.context?.diagnostics ?? [],
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/definition': {
              const params = message.params as TextDocumentPositionParams;
              await transport.write(
                createResponse(
                  message,
                  definitionOpenDocument(
                    params.textDocument.uri,
                    params.position.line,
                    params.position.character,
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/documentHighlight': {
              const params = message.params as TextDocumentPositionParams;
              await transport.write(
                createResponse(
                  message,
                  highlightOpenDocument(
                    params.textDocument.uri,
                    params.position.line,
                    params.position.character,
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/documentSymbol': {
              const params = message.params as { textDocument: { uri: string } };
              await transport.write(
                createResponse(
                  message,
                  documentSymbolsOpenDocument(
                    params.textDocument.uri,
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/formatting': {
              const params = message.params as DocumentFormattingParams;
              await transport.write(
                createResponse(
                  message,
                  formatOpenDocument(
                    params.textDocument.uri,
                    params.options,
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/semanticTokens/full': {
              const params = message.params as { textDocument: { uri: string } };
              await transport.write(
                createResponse(
                  message,
                  semanticTokensOpenDocument(
                    params.textDocument.uri,
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/signatureHelp': {
              const params = message.params as TextDocumentPositionParams;
              await transport.write(
                createResponse(
                  message,
                  signatureHelpOpenDocument(
                    params.textDocument.uri,
                    params.position.line,
                    params.position.character,
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/prepareRename': {
              const params = message.params as TextDocumentPositionParams;
              await transport.write(
                createResponse(
                  message,
                  prepareRenameOpenDocument(
                    params.textDocument.uri,
                    params.position.line,
                    params.position.character,
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/references': {
              const params = message.params as ReferenceParams;
              await transport.write(
                createResponse(
                  message,
                  referencesOpenDocument(
                    params.textDocument.uri,
                    params.position.line,
                    params.position.character,
                    session,
                    params.context?.includeDeclaration ?? true,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/rename': {
              const params = message.params as RenameParams;
              await transport.write(
                createResponse(
                  message,
                  renameOpenDocument(
                    params.textDocument.uri,
                    params.position.line,
                    params.position.character,
                    params.newName,
                    session,
                  ),
                ),
              );
              break;
            }
            case 'textDocument/hover': {
              const params = message.params as TextDocumentPositionParams;
              await transport.write(
                createResponse(
                  message,
                  hoverOpenDocument(
                    params.textDocument.uri,
                    params.position.line,
                    params.position.character,
                    session,
                    capabilityMode,
                  ),
                ),
              );
              break;
            }
            case 'shutdown':
              shutdownRequested = true;
              await transport.write(createResponse(message, null));
              break;
            case 'workspace/executeCommand': {
              const params = message.params as ExecuteCommandParams;
              if (params.command === 'soundscript.showExpandedSource') {
                const [uri, stage] = params.arguments ?? [];
                await transport.write(
                  createResponse(
                    message,
                    typeof uri === 'string'
                      ? showExpandedSourceOpenDocument(
                        uri,
                        stage === 'rewrite' || stage === 'prepared' || stage === 'expanded' ||
                          stage === 'projected'
                          ? stage
                          : 'projected',
                        session,
                      )
                      : null,
                  ),
                );
                break;
              }
              if (params.command === 'soundscript.showMacroTrace') {
                const [uri] = params.arguments ?? [];
                await transport.write(
                  createResponse(
                    message,
                    typeof uri === 'string' ? showMacroTraceOpenDocument(uri, session) : null,
                  ),
                );
                break;
              }
              await transport.write(createResponse(message, null));
              break;
            }
            default:
              await transport.write(createResponse(message, null));
              break;
          }
          continue;
        }

        if (isJsonRpcNotification(message)) {
          switch (message.method) {
            case 'initialized':
              break;
            case 'textDocument/didOpen': {
              const params = message.params as DidOpenTextDocumentParams;
              session.open(params.textDocument);
              diagnosticScheduler.schedule(
                params.textDocument.uri,
                INITIAL_DIAGNOSTIC_DELAY_MS,
              );
              break;
            }
            case 'textDocument/didChange': {
              const params = message.params as DidChangeTextDocumentParams;
              const latestChange = params.contentChanges.at(-1);
              if (!latestChange) {
                break;
              }

              session.update(
                params.textDocument.uri,
                params.textDocument.version,
                latestChange.text,
              );
              diagnosticScheduler.schedule(
                params.textDocument.uri,
                CHANGED_DIAGNOSTIC_DELAY_MS,
              );
              break;
            }
            case 'textDocument/didClose': {
              const params = message.params as DidCloseTextDocumentParams;
              diagnosticScheduler.cancel(params.textDocument.uri);
              session.close(params.textDocument.uri);
              await transport.write({
                jsonrpc: '2.0',
                method: 'textDocument/publishDiagnostics',
                params: {
                  uri: params.textDocument.uri,
                  diagnostics: [],
                },
              });
              break;
            }
            case 'exit':
              diagnosticScheduler.dispose();
              exitRequested = true;
              break;
            default:
              if (shutdownRequested) {
                exitRequested = message.method === 'exit';
              }
              break;
          }
        }
      }
    },
  };
}
