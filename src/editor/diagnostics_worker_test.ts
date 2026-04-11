import { assert, assertEquals } from '@std/assert';
import { dirname, join } from '@std/path';

import { analyzeProject, filterAnalyzedDiagnosticsForFile } from '../checker/analyze_project.ts';
import type { MergedDiagnostic } from '../checker/diagnostics.ts';
import { runEditorDiagnosticsWorker } from './diagnostics_worker.ts';
import {
  maybeNormalizeTsconfigForInstalledStdlib,
  writeInstalledStdlibPackage,
} from '../../tests/support/test_installed_stdlib.ts';

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

interface WorkerResponse {
  error?: string;
  id?: number;
  result?: {
    diagnostics: SerializedWorkerDiagnostic[];
  };
}

async function createTempProject(files: Readonly<Record<string, string>>): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-editor-worker-' });

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(tempDirectory, relativePath);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(
      absolutePath,
      maybeNormalizeTsconfigForInstalledStdlib(relativePath, contents),
    );
  }

  await writeInstalledStdlibPackage(tempDirectory);
  return tempDirectory;
}

function serializeExpectedDiagnostic(diagnostic: MergedDiagnostic): SerializedWorkerDiagnostic {
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

function normalizeSerializedDiagnostics(
  diagnostics: readonly SerializedWorkerDiagnostic[],
): SerializedWorkerDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const leftKey = [
      left.code,
      left.range.start.line,
      left.range.start.character,
      left.message,
    ].join('\u0000');
    const rightKey = [
      right.code,
      right.range.start.line,
      right.range.start.character,
      right.message,
    ].join('\u0000');
    return leftKey.localeCompare(rightKey);
  });
}

async function collectExpectedDiagnostics(
  projectPath: string,
  workingDirectory: string,
  filePath: string,
  fileOverrides?: ReadonlyMap<string, string>,
): Promise<SerializedWorkerDiagnostic[]> {
  const analysis = await analyzeProject({
    fileOverrides,
    projectPath,
    workingDirectory,
  });
  return normalizeSerializedDiagnostics(
    filterAnalyzedDiagnosticsForFile(analysis.diagnostics, filePath).map(
      serializeExpectedDiagnostic,
    ),
  );
}

async function startWorkerHarness(): Promise<{
  close(): Promise<void>;
  request(method: string, params?: Record<string, unknown>): Promise<WorkerResponse>;
}> {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const workerPromise = runEditorDiagnosticsWorker({
    readable: input.readable,
    writable: output.writable,
  });
  const writer = input.writable.getWriter();
  const reader = output.readable.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let nextId = 1;
  let buffer = '';

  return {
    async request(method: string, params?: Record<string, unknown>): Promise<WorkerResponse> {
      const id = nextId;
      nextId += 1;
      await writer.write(encoder.encode(`${JSON.stringify({ id, method, params })}\n`));

      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length === 0) {
            continue;
          }
          const response = JSON.parse(line) as WorkerResponse;
          if (response.id === id) {
            return response;
          }
          throw new Error(`Expected response ${id}, received ${response.id ?? '<missing>'}`);
        }

        const { done, value } = await reader.read();
        if (done) {
          throw new Error(`Worker closed before responding to ${method}`);
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close(): Promise<void> {
      await writer.close();
      await workerPromise;
      reader.releaseLock();
      writer.releaseLock();
    },
  };
}

Deno.test('editor diagnostics worker matches CLI diagnostics for an overridden file', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/index.sts': 'export const value = 1;\n',
  });

  const projectPath = join(tempDirectory, 'tsconfig.json');
  const filePath = join(tempDirectory, 'src/index.sts');
  const overriddenText = [
    'const dict = Object.create(null);',
    'const plain: object = dict;',
    'export const value = plain;',
    '',
  ].join('\n');
  const worker = await startWorkerHarness();

  try {
    const initializeResponse = await worker.request('initialize');
    assertEquals(initializeResponse.error, undefined);

    const syncResponse = await worker.request('syncDocument', {
      filePath,
      text: overriddenText,
      version: 1,
    });
    assertEquals(syncResponse.error, undefined);

    const diagnosticsResponse = await worker.request('diagnostics', {
      filePath,
      projectPath,
    });
    assertEquals(diagnosticsResponse.error, undefined);

    const expectedDiagnostics = await collectExpectedDiagnostics(
      projectPath,
      tempDirectory,
      filePath,
      new Map([[filePath, overriddenText]]),
    );
    assertEquals(
      normalizeSerializedDiagnostics(diagnosticsResponse.result?.diagnostics ?? []),
      expectedDiagnostics,
    );
  } finally {
    await worker.close();
  }
});

Deno.test('editor diagnostics worker mirrors CLI diagnostics for a barrel file with sibling errors', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/services.sts': [
      "import { broken } from './services/dispatch.sts';",
      'export const service = broken;',
      '',
    ].join('\n'),
    'src/services/dispatch.sts': [
      'const broken: string = 1;',
      'export { broken };',
      '',
    ].join('\n'),
  });

  const projectPath = join(tempDirectory, 'tsconfig.json');
  const barrelFilePath = join(tempDirectory, 'src/services.sts');
  const siblingFilePath = join(tempDirectory, 'src/services/dispatch.sts');
  const worker = await startWorkerHarness();

  try {
    const initializeResponse = await worker.request('initialize');
    assertEquals(initializeResponse.error, undefined);

    const siblingDiagnosticsResponse = await worker.request('diagnostics', {
      filePath: siblingFilePath,
      projectPath,
    });
    assertEquals(siblingDiagnosticsResponse.error, undefined);
    assert((siblingDiagnosticsResponse.result?.diagnostics.length ?? 0) > 0);

    const barrelDiagnosticsResponse = await worker.request('diagnostics', {
      filePath: barrelFilePath,
      projectPath,
    });
    assertEquals(barrelDiagnosticsResponse.error, undefined);

    const expectedDiagnostics = await collectExpectedDiagnostics(
      projectPath,
      tempDirectory,
      barrelFilePath,
    );
    assertEquals(
      normalizeSerializedDiagnostics(barrelDiagnosticsResponse.result?.diagnostics ?? []),
      expectedDiagnostics,
    );
  } finally {
    await worker.close();
  }
});
