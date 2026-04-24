import { dirname } from '../platform/path.ts';
import { runtimeStdinReadable, runtimeStdoutWritable } from '../platform/host.ts';

import {
  filterAnalyzedDiagnosticsForFile,
  IncrementalProjectSession,
} from '../checker/analyze_project.ts';
import type { MergedDiagnostic } from '../checker/diagnostics.ts';
import { loadConfig, type LoadedConfig } from '../project/config.ts';

interface JsonRpcLikeRequest {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

interface SyncedDocument {
  text: string;
  version: number;
}

interface WorkerProjectState {
  analysisSession: IncrementalProjectSession;
}

interface WorkerContext {
  documents: Map<string, SyncedDocument>;
  loadedConfigs: Map<string, LoadedConfig>;
  projects: Map<string, WorkerProjectState>;
}

interface DiagnosticsWorkerOptions {
  readable?: ReadableStream<Uint8Array>;
  writable?: WritableStream<Uint8Array>;
}

interface SerializedWorkerDiagnostic {
  code: string;
  message: string;
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
  severity: number;
  source: string;
}

function createWorkerContext(): WorkerContext {
  return {
    documents: new Map(),
    loadedConfigs: new Map(),
    projects: new Map(),
  };
}

function loadedConfigForProject(
  context: WorkerContext,
  projectPath: string,
): LoadedConfig {
  const cached = context.loadedConfigs.get(projectPath);
  if (cached) {
    return cached;
  }

  const loadedConfig = loadConfig(projectPath);
  context.loadedConfigs.set(projectPath, loadedConfig);
  return loadedConfig;
}

function serializeDiagnostic(diagnostic: MergedDiagnostic): SerializedWorkerDiagnostic {
  const startLine = Math.max((diagnostic.line ?? 1) - 1, 0);
  const startCharacter = Math.max((diagnostic.column ?? 1) - 1, 0);
  const endLine = Math.max((diagnostic.endLine ?? diagnostic.line ?? 1) - 1, startLine);
  const endCharacter = diagnostic.endColumn !== undefined
    ? Math.max(diagnostic.endColumn - 1, 0)
    : endLine === startLine
    ? startCharacter + 1
    : 0;
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    range: {
      start: {
        line: startLine,
        character: startCharacter,
      },
      end: {
        line: endLine,
        character: endLine === startLine
          ? Math.max(endCharacter, startCharacter + 1)
          : endCharacter,
      },
    },
    severity: diagnostic.category === 'warning' ? 2 : diagnostic.category === 'message' ? 3 : 1,
    source: diagnostic.source,
  };
}

async function writeResponse(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  payload: unknown,
): Promise<void> {
  await writer.write(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
}

function fileOverridesForProject(
  context: WorkerContext,
  projectPath: string,
): ReadonlyMap<string, string> {
  const projectDirectory = dirname(projectPath);
  const overrides = new Map<string, string>();
  for (const [filePath, document] of context.documents.entries()) {
    if (!filePath.startsWith(projectDirectory)) {
      continue;
    }
    overrides.set(filePath, document.text);
  }
  return overrides;
}

function additionalRootNamesForProject(
  context: WorkerContext,
  projectPath: string,
): readonly string[] {
  const projectDirectory = dirname(projectPath);
  const loadedConfig = loadedConfigForProject(context, projectPath);
  return [...context.documents.keys()]
    .filter((filePath) =>
      filePath.startsWith(projectDirectory) && loadedConfig.isSoundscriptSourceFile(filePath)
    )
    .sort();
}

function handleRequest(
  context: WorkerContext,
  request: JsonRpcLikeRequest,
): unknown {
  switch (request.method) {
    case 'initialize':
      return { ok: true };
    case 'syncDocument': {
      const filePath = typeof request.params?.filePath === 'string'
        ? request.params.filePath
        : undefined;
      const text = typeof request.params?.text === 'string' ? request.params.text : undefined;
      const version = typeof request.params?.version === 'number'
        ? request.params.version
        : undefined;
      if (!filePath || text === undefined || version === undefined) {
        throw new Error('syncDocument requires filePath, text, and version.');
      }
      context.documents.set(filePath, { text, version });
      return { ok: true };
    }
    case 'closeDocument': {
      const filePath = typeof request.params?.filePath === 'string'
        ? request.params.filePath
        : undefined;
      if (!filePath) {
        throw new Error('closeDocument requires filePath.');
      }
      context.documents.delete(filePath);
      return { ok: true };
    }
    case 'diagnostics': {
      const filePath = typeof request.params?.filePath === 'string'
        ? request.params.filePath
        : undefined;
      const projectPath = typeof request.params?.projectPath === 'string'
        ? request.params.projectPath
        : undefined;
      if (!filePath || !projectPath) {
        throw new Error('diagnostics requires filePath and projectPath.');
      }

      const loadedConfig = loadedConfigForProject(context, projectPath);
      const fileOverrides = fileOverridesForProject(context, projectPath);
      const additionalRootNames = additionalRootNamesForProject(context, projectPath);
      const cachedProject = context.projects.get(projectPath) ?? {
        analysisSession: new IncrementalProjectSession(),
      };
      cachedProject.analysisSession.prepare(
        {
          additionalRootNames,
          fileOverrides,
          projectPath,
          workingDirectory: dirname(projectPath),
        },
        { deferTypescriptView: loadedConfig.isSoundscriptSourceFile(filePath) },
      );
      const analyzedProject = cachedProject.analysisSession.analyzeFile(filePath);
      context.projects.set(projectPath, cachedProject);
      return {
        diagnostics: filterAnalyzedDiagnosticsForFile(analyzedProject.diagnostics, filePath)
          .map((diagnostic) => serializeDiagnostic(diagnostic)),
      };
    }
    default:
      throw new Error(`Unknown editor worker method: ${request.method ?? '<missing>'}`);
  }
}

export async function runEditorDiagnosticsWorker(
  options: DiagnosticsWorkerOptions = {},
): Promise<void> {
  const readable = options.readable ?? runtimeStdinReadable();
  const writable = options.writable ?? runtimeStdoutWritable();
  const reader = readable.getReader();
  const writer = writable.getWriter();
  const context = createWorkerContext();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) {
          continue;
        }

        let request: JsonRpcLikeRequest;
        try {
          request = JSON.parse(line) as JsonRpcLikeRequest;
        } catch (error) {
          await writeResponse(writer, {
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        try {
          const result = handleRequest(context, request);
          await writeResponse(writer, {
            id: request.id,
            result,
          });
        } catch (error) {
          await writeResponse(writer, {
            id: request.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  } finally {
    for (const projectState of context.projects.values()) {
      projectState.analysisSession.dispose();
    }
    reader.releaseLock();
    writer.releaseLock();
  }
}
