import { assertEquals } from '@std/assert';
import { dirname, fromFileUrl, join } from '../../src/platform/path.ts';
import ts from 'typescript';

import { createSoundStdlibCompilerHost } from '../../src/bundled/sound_stdlib.ts';
import { compileProject } from '../../src/compiler/compile_project.ts';
import type {
  CompilerRuntimeAdaptObjectValueIR,
  CompilerRuntimeAllocateFallbackObjectIR,
  CompilerRuntimeAllocateSpecializedObjectIR,
  CompilerRuntimeGetFallbackObjectPropertyIR,
  CompilerRuntimeGetSpecializedObjectFieldIR,
  CompilerRuntimeSetFallbackObjectPropertyIR,
  CompilerRuntimeSpecializedObjectRepresentationIR,
} from '../../src/compiler/runtime_ir.ts';
import { loadConfig } from '../../src/project/config.ts';
import { instantiateSoundscriptWasmModule } from '../../src/compiler/wasm_js_host_runtime.ts';

export interface TempProjectFile {
  path: string;
  contents: string;
}

const REPO_ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
const SOUNDSCRIPT_ISOLATED_TESTS = 'SOUNDSCRIPT_ISOLATED_TESTS';
const SOUNDSCRIPT_ISOLATED_TEST_BATCH_SIZE = 'SOUNDSCRIPT_ISOLATED_TEST_BATCH_SIZE';
const DEFAULT_ISOLATED_TEST_BATCH_SIZE = 8;

let cachedCliTestFilterEnabled: boolean | undefined;

function getConfiguredIsolatedTestBatchSize(): number {
  const rawValue = Deno.env.get(SOUNDSCRIPT_ISOLATED_TEST_BATCH_SIZE);
  if (rawValue === undefined) {
    return DEFAULT_ISOLATED_TEST_BATCH_SIZE;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ISOLATED_TEST_BATCH_SIZE;
}

function getCliTestFilterEnabled(): boolean {
  if (cachedCliTestFilterEnabled !== undefined) {
    return cachedCliTestFilterEnabled;
  }

  const result = new Deno.Command('ps', {
    args: ['-p', String(Deno.pid), '-o', 'command='],
    stderr: 'piped',
    stdout: 'piped',
  }).outputSync();

  if (!result.success) {
    cachedCliTestFilterEnabled = true;
    return cachedCliTestFilterEnabled;
  }

  const commandLine = new TextDecoder().decode(result.stdout);
  cachedCliTestFilterEnabled = /(?:^|\s)(?:--filter|-f)(?:=|\s|$)/.test(commandLine);
  return cachedCliTestFilterEnabled;
}

export function createIsolatedTestRegistrar(fileUrl: string) {
  const isolatedTestNamesValue = Deno.env.get(SOUNDSCRIPT_ISOLATED_TESTS);
  const isolatedTestNames = isolatedTestNamesValue === undefined
    ? undefined
    : JSON.parse(isolatedTestNamesValue) as string[];
  const isolatedTestNameSet = isolatedTestNames === undefined
    ? undefined
    : new Set(isolatedTestNames);
  const filePath = fromFileUrl(fileUrl);
  const registeredTestNames: string[] = [];
  const batchRuns = new Map<number, { ownerName: string; promise: Promise<void> }>();
  const batchSize = isolatedTestNameSet === undefined && !getCliTestFilterEnabled()
    ? getConfiguredIsolatedTestBatchSize()
    : 1;

  const runIsolatedTests = async (testNames: string[]) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        'test',
        '--no-check',
        '--allow-env',
        '--allow-read',
        '--allow-write',
        '--allow-run',
        filePath,
      ],
      cwd: REPO_ROOT,
      env: {
        ...Deno.env.toObject(),
        [SOUNDSCRIPT_ISOLATED_TESTS]: JSON.stringify(testNames),
      },
      stderr: 'piped',
      stdout: 'piped',
    });
    const result = await command.output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    assertEquals(
      result.success,
      true,
      [
        `isolated compiler test batch failed: ${testNames.join(', ')}`,
        `stdout:\n${stdout}`,
        `stderr:\n${stderr}`,
      ].join('\n\n'),
    );
  };

  return (name: string, fn: () => Promise<void> | void): void => {
    const testIndex = registeredTestNames.length;
    registeredTestNames.push(name);

    if (isolatedTestNameSet !== undefined && !isolatedTestNameSet.has(name)) {
      return;
    }

    Deno.test({
      name,
      sanitizeOps: false,
      sanitizeResources: false,
      async fn() {
        if (isolatedTestNameSet !== undefined) {
          await fn();
          return;
        }

        const batchId = Math.floor(testIndex / batchSize);
        const existingBatchRun = batchRuns.get(batchId);
        if (existingBatchRun !== undefined) {
          if (existingBatchRun.ownerName !== name) {
            try {
              await existingBatchRun.promise;
            } catch {
              // Let the owner test report the batch failure once.
            }
          } else {
            await existingBatchRun.promise;
          }
          return;
        }

        const batchStart = batchId * batchSize;
        const batchEnd = batchStart + batchSize;
        const batchTestNames = registeredTestNames.slice(batchStart, batchEnd);
        const batchPromise = runIsolatedTests(batchTestNames);
        batchRuns.set(batchId, { ownerName: name, promise: batchPromise });
        await batchPromise;
      },
    });
  };
}

export async function createTempProject(files: TempProjectFile[]): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-tsc-compiler-' });

  for (const file of files) {
    const absolutePath = join(tempDirectory, file.path);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(absolutePath, file.contents);
  }

  return tempDirectory;
}

export function getOutputDirectory(tempDirectory: string): string {
  return join(tempDirectory, 'soundscript-out');
}

export function getWatPath(tempDirectory: string): string {
  return join(getOutputDirectory(tempDirectory), 'module.wat');
}

export function getWrapperPath(tempDirectory: string): string {
  return join(getOutputDirectory(tempDirectory), 'module.js');
}

export async function readWatArtifact(tempDirectory: string): Promise<string> {
  return await Deno.readTextFile(getWatPath(tempDirectory));
}

export async function readCompiledWasmBytes(tempDirectory: string): Promise<Uint8Array> {
  const watPath = getWatPath(tempDirectory);
  const wasmPath = join(getOutputDirectory(tempDirectory), 'module.test.wasm');
  const command = new Deno.Command('wasm-tools', {
    args: ['parse', watPath, '-o', wasmPath],
    stderr: 'piped',
    stdout: 'piped',
  });
  const result = await command.output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }

  return await Deno.readFile(wasmPath);
}

export async function instantiateCompiledModuleInJs(
  tempDirectory: string,
  options?: {
    hostFunctions?: Record<string, (...args: unknown[]) => unknown>;
    imports?: WebAssembly.Imports;
    modules?: Record<string, Record<string, unknown>>;
  },
): Promise<{
  exports: WebAssembly.Exports;
  instance: WebAssembly.Instance;
}> {
  const wrapperPath = getWrapperPath(tempDirectory);
  try {
    const wrapperStat = await Deno.stat(wrapperPath);
    if (wrapperStat.isFile) {
      const wrapperModule = await import(`file://${wrapperPath}?cacheBust=${crypto.randomUUID()}`);
      if (typeof wrapperModule.instantiate !== 'function') {
        throw new Error(`Expected packaged wrapper "${wrapperPath}" to export instantiate().`);
      }
      return await wrapperModule.instantiate({
        hostFunctions: options?.hostFunctions,
        imports: options?.imports,
        modules: options?.modules,
      });
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  const wasmBytes = await readCompiledWasmBytes(tempDirectory);
  const instance = await instantiateSoundscriptWasmModule(wasmBytes, {
    hostFunctions: options?.hostFunctions,
    imports: options?.imports,
  });
  return {
    exports: instance.exports,
    instance,
  };
}

export async function readWatArtifactForProject(projectDirectory: string): Promise<string> {
  return await Deno.readTextFile(join(projectDirectory, 'soundscript-out', 'module.wat'));
}

export async function resolveQualifiedExportName(
  tempDirectory: string,
  entry: string,
): Promise<string> {
  const wat = await readWatArtifact(tempDirectory);
  const exportNames = [...wat.matchAll(/\(export "([^"]+)"\)/g)].map((match) => match[1]);

  if (exportNames.includes(entry)) {
    return entry;
  }

  const qualifiedMatches = exportNames.filter((name) => name.endsWith(`:${entry}`));
  if (qualifiedMatches.length === 1) {
    return qualifiedMatches[0];
  }
  if (qualifiedMatches.length > 1) {
    throw new Error(`Ambiguous exported function "${entry}".`);
  }

  throw new Error(`Expected exported function "${entry}".`);
}

export async function invokeCompiledEntry(
  tempDirectory: string,
  entry: string,
  args: number[],
): Promise<number> {
  const exportName = await resolveQualifiedExportName(tempDirectory, entry);
  const instance = await instantiateCompiledModuleInJs(tempDirectory);
  const exported = instance.exports[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`Expected exported function "${exportName}".`);
  }
  const result = exported(...args);
  const value = Number(result);
  if (Number.isNaN(value)) {
    throw new Error(`Expected numeric export result, received "${String(result)}".`);
  }
  return value;
}

export function createCompilerProgram(projectPath: string): ts.Program {
  const loadedConfig = loadConfig(projectPath);
  const host = createSoundStdlibCompilerHost(loadedConfig.commandLine.options);
  return ts.createProgram({
    host,
    rootNames: loadedConfig.commandLine.fileNames,
    options: loadedConfig.commandLine.options,
    projectReferences: loadedConfig.commandLine.projectReferences,
    configFileParsingDiagnostics: loadedConfig.diagnostics,
  });
}

export function compileCheckedInProject(relativeProjectDirectory: string) {
  const projectDirectory = join(REPO_ROOT, relativeProjectDirectory);
  return {
    projectDirectory,
    result: compileProject({
      projectPath: join(projectDirectory, 'tsconfig.json'),
      workingDirectory: projectDirectory,
    }),
  };
}

export function nullishSingleElementArrayOrThrowIfNotNull<T extends Array<unknown>>(
  value: T | undefined | null,
): NonNullable<T> | undefined {
  const result = value ?? undefined;
  if (result && result.length === 0) return undefined;
  if (result && result.length === 1) return result as NonNullable<T>;
  if (result && result.length > 1) throw new Error('Expected zero or one elements.');
  return undefined;
}
