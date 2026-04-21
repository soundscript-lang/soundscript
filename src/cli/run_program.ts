import {
  formatDiagnostics,
  hasErrorDiagnostics,
  type MergedDiagnostic,
} from '../checker/diagnostics.ts';
import { analyzeProjectWithPersistentCache } from '../checker/checker_cache.ts';
import { measureCheckerTiming } from '../checker/timing.ts';
import { loadConfig, type RuntimeTarget } from '../project/config.ts';
import ts from 'typescript';

export interface RunProgramOptions {
  cacheDir?: string;
  checkReferences?: boolean;
  projectPath: string;
  target?: RuntimeTarget;
  useCache?: boolean;
  workingDirectory: string;
}

export interface RunProgramResult {
  diagnostics: MergedDiagnostic[];
  output: string;
  exitCode: number;
}

export function runProgram(options: RunProgramOptions): RunProgramResult {
  if (options.checkReferences) {
    return runProgramWithProjectReferences(options);
  }

  return runSingleProject(options);
}

interface ProjectReferenceWalkState {
  cycleKeys: Set<string>;
  diagnostics: MergedDiagnostic[];
  orderedProjectPaths: string[];
  stack: string[];
  visited: Set<string>;
  visiting: Set<string>;
}

function resolveProjectReferenceConfigPath(reference: ts.ProjectReference): string {
  return ts.sys.resolvePath(ts.resolveProjectReferencePath(reference));
}

function createProjectReferenceCycleDiagnostic(
  projectPath: string,
  stack: readonly string[],
): MergedDiagnostic {
  const cycleStart = stack.indexOf(projectPath);
  const cycle = [
    ...(cycleStart >= 0 ? stack.slice(cycleStart) : stack),
    projectPath,
  ];

  return {
    source: 'cli',
    code: 'SOUNDSCRIPT_PROJECT_REFERENCE_CYCLE',
    category: 'error',
    message: `Project reference cycle detected: ${cycle.join(' -> ')}`,
    filePath: projectPath,
    line: 1,
    column: 1,
  };
}

function collectProjectReferenceOrder(
  projectPath: string,
  options: Pick<RunProgramOptions, 'target'>,
  state: ProjectReferenceWalkState,
): void {
  const resolvedProjectPath = ts.sys.resolvePath(projectPath);
  if (state.visited.has(resolvedProjectPath)) {
    return;
  }
  if (state.visiting.has(resolvedProjectPath)) {
    const cycleStart = state.stack.indexOf(resolvedProjectPath);
    const cycleStack = cycleStart >= 0 ? state.stack.slice(cycleStart) : [...state.stack];
    const cycle = [
      ...cycleStack,
      resolvedProjectPath,
    ];
    const cycleKey = cycle.join('\u0000');
    if (!state.cycleKeys.has(cycleKey)) {
      state.cycleKeys.add(cycleKey);
      state.diagnostics.push(
        createProjectReferenceCycleDiagnostic(resolvedProjectPath, state.stack),
      );
    }
    return;
  }

  state.visiting.add(resolvedProjectPath);
  state.stack.push(resolvedProjectPath);

  const loadedConfig = loadConfig(resolvedProjectPath, { target: options.target });
  for (const reference of loadedConfig.commandLine.projectReferences ?? []) {
    collectProjectReferenceOrder(resolveProjectReferenceConfigPath(reference), options, state);
  }

  state.stack.pop();
  state.visiting.delete(resolvedProjectPath);
  state.visited.add(resolvedProjectPath);
  state.orderedProjectPaths.push(resolvedProjectPath);
}

function dedupeDiagnostics(diagnostics: readonly MergedDiagnostic[]): MergedDiagnostic[] {
  const seen = new Set<string>();
  const deduped: MergedDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([
      diagnostic.source,
      diagnostic.code,
      diagnostic.category,
      diagnostic.message,
      diagnostic.filePath ?? '',
      diagnostic.line ?? '',
      diagnostic.column ?? '',
      diagnostic.endLine ?? '',
      diagnostic.endColumn ?? '',
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(diagnostic);
  }
  return deduped;
}

function runProgramWithProjectReferences(options: RunProgramOptions): RunProgramResult {
  return measureCheckerTiming(
    'runProgram.references.total',
    {
      cacheDir: options.cacheDir,
      projectPath: options.projectPath,
      useCache: options.useCache ?? true,
    },
    () => {
      const referenceState: ProjectReferenceWalkState = {
        cycleKeys: new Set(),
        diagnostics: [],
        orderedProjectPaths: [],
        stack: [],
        visited: new Set(),
        visiting: new Set(),
      };
      collectProjectReferenceOrder(options.projectPath, options, referenceState);

      const diagnostics = [...referenceState.diagnostics];
      for (const projectPath of referenceState.orderedProjectPaths) {
        const result = runSingleProject({
          ...options,
          checkReferences: false,
          projectPath,
        });
        diagnostics.push(...result.diagnostics);
      }

      const mergedDiagnostics = dedupeDiagnostics(diagnostics);
      const output = measureCheckerTiming(
        'runProgram.references.formatDiagnostics',
        {
          diagnostics: mergedDiagnostics.length,
          projectPath: options.projectPath,
        },
        () => formatDiagnostics(mergedDiagnostics, options.workingDirectory),
        { always: true },
      );

      return {
        diagnostics: mergedDiagnostics,
        output,
        exitCode: hasErrorDiagnostics(mergedDiagnostics) ? 1 : 0,
      };
    },
    { always: true },
  );
}

function runSingleProject(options: RunProgramOptions): RunProgramResult {
  return measureCheckerTiming(
    'runProgram.total',
    {
      cacheDir: options.cacheDir,
      projectPath: options.projectPath,
      useCache: options.useCache ?? true,
    },
    () => {
      const analysis = measureCheckerTiming(
        'runProgram.analysis',
        {
          cacheDir: options.cacheDir,
          projectPath: options.projectPath,
          useCache: options.useCache ?? true,
        },
        () =>
          analyzeProjectWithPersistentCache({
            cacheDir: options.cacheDir,
            projectPath: options.projectPath,
            target: options.target,
            useCache: options.useCache,
            workingDirectory: options.workingDirectory,
          }),
        { always: true },
      );
      const output = measureCheckerTiming(
        'runProgram.formatDiagnostics',
        {
          diagnostics: analysis.diagnostics.length,
          projectPath: options.projectPath,
        },
        () => formatDiagnostics(analysis.diagnostics, options.workingDirectory),
        { always: true },
      );

      return {
        diagnostics: analysis.diagnostics,
        output,
        exitCode: hasErrorDiagnostics(analysis.diagnostics) ? 1 : 0,
      };
    },
    { always: true },
  );
}
