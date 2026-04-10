import { basename, dirname, join } from './platform/path.ts';
import ts from 'typescript';

import {
  buildProject,
  type BuildProjectArtifacts,
  type BuildProjectOptions,
  type BuildProjectResult,
} from './build_package.ts';
import { formatDiagnostics, type MergedDiagnostic } from './checker/diagnostics.ts';
import {
  type CompileArtifacts,
  compileProject,
  type CompileProjectOptions,
  type CompileProjectResult,
} from './compiler/compile_project.ts';
import {
  expandProject,
  type ExpandProjectArtifacts,
  type ExpandProjectOptions,
  type ExpandProjectResult,
} from './frontend/expand_project.ts';
import {
  type BuildCommand,
  type DenoCommand,
  type EditorProjectCommand,
  type InitCommand,
  type NodeCommand,
  type OutputFormat,
  parseCommand,
} from './config.ts';
import {
  getDiagnosticDocsUrl,
  type MachineDiagnostic,
  toMachineDiagnostic,
} from './diagnostic_metadata.ts';
import {
  type DiagnosticRepairExample,
  type DiagnosticSuggestion,
  getDiagnosticReference,
} from './diagnostic_reference.ts';
import {
  createTempDirectory,
  fileExistsSync,
  type HostFileSystemWatchEvent,
  makeDirectory,
  readStdinText,
  removePath,
  runCommand,
  runtimeCwd,
  watchFileSystem,
  writeStdout,
  writeTextFile,
} from './platform/host.ts';
import {
  materializeRuntimeGraph,
  type MaterializeRuntimeGraphArtifacts,
} from './runtime/materialize.ts';
import { runProgram, type RunProgramOptions, type RunProgramResult } from './run_program.ts';
import { projectEditorFile } from './editor_projection.ts';

export const VERSION = '0.1.23';
const FINDINGS_EXIT_CODE = 1;
const CLI_FAILURE_EXIT_CODE = 2;

export interface CliResult {
  exitCode: number;
  output: string;
  diagnostics: MergedDiagnostic[];
  projectPath: string;
  workingDirectory: string;
}

export interface CliDependencies {
  buildProject?: (options: BuildProjectOptions) => Promise<BuildProjectResult>;
  compileProject?: (options: CompileProjectOptions) => CompileProjectResult;
  expandProject?: (options: ExpandProjectOptions) => Promise<ExpandProjectResult>;
  runSubprocess?: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ exitCode: number; output: string }>;
  runProgram?: (options: RunProgramOptions) => RunProgramResult;
  watchFileSystem?: (path: string) => AsyncIterable<HostFileSystemWatchEvent>;
}

type MachineReadableCommand = 'build' | 'check' | 'cli' | 'compile' | 'expand' | 'explain';

interface JsonSummary {
  total: number;
  errors: number;
  warnings: number;
  messages: number;
}

interface JsonCliOutput {
  schemaVersion: 1;
  toolVersion: string;
  command: MachineReadableCommand;
  projectPath: string;
  workingDirectory: string;
  exitCode: number;
  summary: JsonSummary;
  diagnostics: MachineDiagnostic[];
  artifacts?: BuildProjectArtifacts | CompileArtifacts | ExpandProjectArtifacts;
}

interface NdjsonRunEvent {
  event: 'run';
  schemaVersion: 1;
  toolVersion: string;
  command: MachineReadableCommand;
  projectPath: string;
  workingDirectory: string;
}

interface NdjsonDiagnosticEvent {
  event: 'diagnostic';
  diagnostic: MachineDiagnostic;
}

interface NdjsonSummaryEvent {
  event: 'summary';
  schemaVersion: 1;
  toolVersion: string;
  command: MachineReadableCommand;
  projectPath: string;
  workingDirectory: string;
  exitCode: number;
  summary: JsonSummary;
  artifacts?: BuildProjectArtifacts | CompileArtifacts | ExpandProjectArtifacts;
}

interface JsonExplainOutput {
  schemaVersion: 1;
  toolVersion: string;
  command: 'explain';
  code: string;
  title: string;
  summary: string;
  details: string[];
  docsUrl?: string;
  examples?: DiagnosticRepairExample[];
  repairHeuristic?: string;
  suggestions: DiagnosticSuggestion[];
}

interface JsonEditorProjectOutput {
  schemaVersion: 1;
  toolVersion: string;
  command: 'editor-project';
  filePath: string;
  projectPath: string;
  originalText: string;
  postRewriteStage?: ReturnType<typeof projectEditorFile>['postRewriteStage'];
  projectedText: string;
  rewriteStage: ReturnType<typeof projectEditorFile>['rewriteStage'];
  virtualModules: ReturnType<typeof projectEditorFile>['virtualModules'];
}

function createCliDiagnostic(
  code: string,
  message: string,
  filePath?: string,
  details?: Pick<MergedDiagnostic, 'hint' | 'notes'>,
): MergedDiagnostic {
  return {
    source: 'cli',
    code,
    category: 'error',
    message,
    notes: details?.notes,
    hint: details?.hint,
    filePath,
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function isOutputFormatValue(value: string | undefined): value is OutputFormat {
  return value === 'json' || value === 'ndjson' || value === 'text';
}

function detectRequestedOutputFormat(args: readonly string[]): OutputFormat {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--format') {
      continue;
    }

    const value = args[index + 1];
    if (isOutputFormatValue(value)) {
      return value;
    }
  }

  return 'text';
}

function detectRequestedCommand(args: readonly string[]): MachineReadableCommand {
  const subcommand = args[0];
  if (
    subcommand === 'build' || subcommand === 'check' || subcommand === 'compile' ||
    subcommand === 'expand' ||
    subcommand === 'explain'
  ) {
    return subcommand;
  }

  return 'cli';
}

function pathExists(path: string): boolean {
  return fileExistsSync(path);
}

function toSoundscriptIncludePattern(pattern: string): string | undefined {
  if (pattern.includes('.sts') || pattern.endsWith('.d.ts')) {
    return undefined;
  }

  if (pattern.endsWith('.ts')) {
    return `${pattern.slice(0, -3)}.sts`;
  }

  if (pattern.endsWith('.tsx')) {
    return `${pattern.slice(0, -4)}.sts`;
  }

  return undefined;
}

function toSoundscriptIncludePatternForFile(filePath: string): string | undefined {
  if (filePath.endsWith('.d.ts') || filePath.endsWith('.sts')) {
    return undefined;
  }

  if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) {
    return undefined;
  }

  const directory = dirname(filePath);
  return directory === '.' ? '*.sts' : join(directory, '**', '*.sts');
}

function deriveExistingProjectInclude(baseProjectPath: string): readonly string[] | undefined {
  const configFile = ts.readConfigFile(baseProjectPath, ts.sys.readFile);
  if (configFile.error) {
    return undefined;
  }

  const rawConfig = configFile.config as {
    files?: readonly string[];
    include?: readonly string[];
  } | undefined;

  if (rawConfig?.include) {
    const include = [...rawConfig.include];
    const augmentedInclude = new Set(include);
    for (const pattern of rawConfig.include) {
      const soundscriptPattern = toSoundscriptIncludePattern(pattern);
      if (soundscriptPattern) {
        augmentedInclude.add(soundscriptPattern);
      }
    }

    return augmentedInclude.size === include.length ? undefined : [...augmentedInclude];
  }

  if (!rawConfig?.files) {
    return undefined;
  }

  const include = new Set<string>();
  for (const filePath of rawConfig.files) {
    const soundscriptPattern = toSoundscriptIncludePatternForFile(filePath);
    if (soundscriptPattern) {
      include.add(soundscriptPattern);
    }
  }

  return include.size === 0 ? undefined : [...include];
}

async function runEditorProjectCommand(command: EditorProjectCommand): Promise<CliResult> {
  const fileOverrides = command.useStdin
    ? new Map([[command.filePath, await readStdinText()]])
    : new Map<string, string>();
  const projection = projectEditorFile({
    fileOverrides,
    filePath: command.filePath,
    projectPath: command.projectPath,
  });
  const payload: JsonEditorProjectOutput = {
    schemaVersion: 1,
    toolVersion: VERSION,
    command: 'editor-project',
    filePath: projection.filePath,
    originalText: projection.originalText,
    postRewriteStage: projection.postRewriteStage,
    projectedText: projection.projectedText,
    projectPath: projection.projectPath,
    rewriteStage: projection.rewriteStage,
    virtualModules: projection.virtualModules,
  };
  return {
    exitCode: 0,
    output: `${JSON.stringify(payload, null, 2)}\n`,
    diagnostics: [],
    projectPath: command.projectPath,
    workingDirectory: command.workingDirectory,
  };
}

function renderHelp(): string {
  return [
    'soundscript',
    '',
    'Usage:',
    '  soundscript init [--mode <new|existing>]',
    '  soundscript build [--project <path>] [--target <js-browser|js-node|wasm-browser|wasm-node|wasm-wasi>] [--out-dir <path>] [--watch] [--format <text|json|ndjson>]',
    '  soundscript check [--project <path>] [--target <js-browser|js-node|wasm-browser|wasm-node|wasm-wasi>] [--format <text|json|ndjson>]',
    '  soundscript compile [--project <path>] [--target <js-browser|js-node|wasm-browser|wasm-node|wasm-wasi>] [--format <text|json|ndjson>]',
    '  soundscript deno <run|test> [...]',
    '  soundscript expand [--project <path>] [--target <js-browser|js-node|wasm-browser|wasm-node|wasm-wasi>] [--out-dir <path>] [--format <text|json|ndjson>]',
    '  soundscript expand [--project <path>] [--target <js-browser|js-node|wasm-browser|wasm-node|wasm-wasi>] --file <path> [--stage <rewrite|prepared|expanded|projected>] [--trace]',
    '  soundscript explain <code> [--format <text|json|ndjson>]',
    '  soundscript lsp',
    '  soundscript node [node-options...] <entry> [-- <args...>]',
    '  soundscript [--help] [--version]',
    '',
    'Commands:',
    '  init          Create a new soundscript project or adoption config.',
    '  build         Build a publishable soundscript package.',
    '  check         Analyze a project with the checker.',
    '  compile       Experimental compiler entrypoint.',
    '  deno          Run Deno against a temporary transformed graph.',
    '  expand        Expand macros and emit base TypeScript files.',
    '  explain       Explain a soundscript diagnostic code.',
    '  lsp           Start the language server over stdio.',
    '  node          Run Node against a temporary transformed graph.',
    '',
    'Command options:',
    '  --mode         Init mode: new (default) or existing.',
    '  -p, --project  Path to a tsconfig.json file for build, check, compile, or expand.',
    '  --target       Experimental runtime target override: js-node (default), js-browser, wasm-browser, wasm-node, or wasm-wasi.',
    '  --format       Output format for build, check, compile, expand, or explain: text (default), json, or ndjson.',
    '  --file         Print one expanded file instead of writing an output directory for expand.',
    '  --out-dir      Output directory for build (default: dist) or expand (default: soundscript-expanded).',
    '  --stage        Expansion stage for expand --file: rewrite, prepared, expanded, or projected (default: expanded).',
    '  --trace        Include structured macro trace data with expand --file.',
    '  --watch        Rebuild on file changes for build.',
    '',
    'Experimental:',
    '  soundscript compile and runtime target overrides, especially Wasm targets, are not part of stable v1.',
    '  soundscript node and soundscript deno require @soundscript/soundscript in the current project or an ancestor workspace.',
    '',
    'Examples:',
    '  soundscript init',
    '  soundscript init --mode existing',
    '  soundscript build',
    '  soundscript build --out-dir dist',
    '  soundscript check',
    '  soundscript check --project tsconfig.soundscript.json --format json',
    '  soundscript check --project tsconfig.soundscript.json --format ndjson',
    '  soundscript expand --file src/main.sts --stage expanded',
    '  soundscript deno run src/main.sts',
    '  soundscript explain SOUND1002',
    '  soundscript lsp',
    '  soundscript node src/main.sts',
    '  soundscript node --inspect src/main.sts',
    '',
    'Global options:',
    '  -h, --help     Show this help text.',
    '  -v, --version  Show the current version.',
  ].join('\n');
}

function renderInvalidCommand(message: string): string {
  return `${message}\n\n${renderHelp()}\n`;
}

function summarizeDiagnostics(diagnostics: readonly MergedDiagnostic[]): JsonSummary {
  return {
    total: diagnostics.length,
    errors: diagnostics.filter((diagnostic) => diagnostic.category === 'error').length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.category === 'warning').length,
    messages: diagnostics.filter((diagnostic) => diagnostic.category === 'message').length,
  };
}

function renderJsonOutput(
  command: MachineReadableCommand,
  projectPath: string,
  workingDirectory: string,
  exitCode: number,
  diagnostics: readonly MergedDiagnostic[],
  artifacts?: BuildProjectArtifacts | CompileArtifacts | ExpandProjectArtifacts,
): string {
  const machineDiagnostics = diagnostics.map((diagnostic) =>
    toMachineDiagnostic(diagnostic, workingDirectory)
  );
  const payload: JsonCliOutput = {
    schemaVersion: 1,
    toolVersion: VERSION,
    command,
    projectPath,
    workingDirectory,
    exitCode,
    summary: summarizeDiagnostics(diagnostics),
    diagnostics: machineDiagnostics,
    ...(artifacts ? { artifacts } : {}),
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderDiagnosticsOutput(
  format: OutputFormat,
  command: MachineReadableCommand,
  projectPath: string,
  workingDirectory: string,
  exitCode: number,
  diagnostics: readonly MergedDiagnostic[],
  artifacts?: BuildProjectArtifacts | CompileArtifacts | ExpandProjectArtifacts,
): string {
  if (format === 'json') {
    return renderJsonOutput(
      command,
      projectPath,
      workingDirectory,
      exitCode,
      diagnostics,
      artifacts,
    );
  }

  if (format === 'ndjson') {
    return renderNdjsonOutput(
      command,
      projectPath,
      workingDirectory,
      exitCode,
      diagnostics,
      artifacts,
    );
  }

  return formatDiagnostics(diagnostics, workingDirectory);
}

function renderNdjsonOutput(
  command: MachineReadableCommand,
  projectPath: string,
  workingDirectory: string,
  exitCode: number,
  diagnostics: readonly MergedDiagnostic[],
  artifacts?: BuildProjectArtifacts | CompileArtifacts | ExpandProjectArtifacts,
): string {
  const machineDiagnostics = diagnostics.map((diagnostic) =>
    toMachineDiagnostic(diagnostic, workingDirectory)
  );
  const runEvent: NdjsonRunEvent = {
    event: 'run',
    schemaVersion: 1,
    toolVersion: VERSION,
    command,
    projectPath,
    workingDirectory,
  };
  const diagnosticEvents: NdjsonDiagnosticEvent[] = machineDiagnostics.map((diagnostic) => ({
    event: 'diagnostic',
    diagnostic,
  }));
  const summaryEvent: NdjsonSummaryEvent = {
    event: 'summary',
    schemaVersion: 1,
    toolVersion: VERSION,
    command,
    projectPath,
    workingDirectory,
    exitCode,
    summary: summarizeDiagnostics(diagnostics),
    ...(artifacts ? { artifacts } : {}),
  };

  return [
    JSON.stringify(runEvent),
    ...diagnosticEvents.map((event) => JSON.stringify(event)),
    JSON.stringify(summaryEvent),
    '',
  ].join('\n');
}

function renderExplainTextOutput(code: string): string {
  const reference = getDiagnosticReference(code);
  if (!reference) {
    return [
      `No built-in explanation is available for diagnostic code ${code}.`,
      '',
      'soundscript explain currently covers built-in soundscript diagnostic codes.',
      '',
    ].join('\n');
  }

  const lines = [
    `${reference.code}: ${reference.title}`,
    '',
    reference.summary,
  ];

  if (reference.repairHeuristic) {
    lines.push('', 'Repair heuristic:', reference.repairHeuristic);
  }

  if (reference.details.length > 0) {
    lines.push('', 'Details:');
    for (const detail of reference.details) {
      lines.push(`- ${detail}`);
    }
  }

  if ((reference.examples?.length ?? 0) > 0) {
    lines.push('', 'Examples:');
    reference.examples?.forEach((example, index) => {
      lines.push('', `Example ${index + 1}:`, 'Before:', '```ts', example.bad, '```');
      lines.push('After:', '```ts', example.good, '```');
    });
  }

  if (reference.suggestions.length > 0) {
    lines.push('', 'Suggestions:');
    for (const suggestion of reference.suggestions) {
      lines.push(`- ${suggestion.title}: ${suggestion.message}`);
    }
  }

  lines.push(
    '',
    `Docs: ${getDiagnosticDocsUrl(reference.code)}`,
    '',
  );

  return lines.join('\n');
}

function renderExplainJsonOutput(code: string): string {
  const reference = getDiagnosticReference(code);
  if (!reference) {
    return `${
      JSON.stringify(
        {
          schemaVersion: 1,
          toolVersion: VERSION,
          command: 'explain',
          code,
          found: false,
          message: `No built-in explanation is available for diagnostic code ${code}.`,
        },
        null,
        2,
      )
    }\n`;
  }

  const payload: JsonExplainOutput = {
    schemaVersion: 1,
    toolVersion: VERSION,
    command: 'explain',
    code: reference.code,
    title: reference.title,
    summary: reference.summary,
    details: [...reference.details],
    repairHeuristic: reference.repairHeuristic,
    examples: reference.examples ? [...reference.examples] : undefined,
    docsUrl: getDiagnosticDocsUrl(reference.code),
    suggestions: reference.suggestions.map((suggestion) => ({
      ...suggestion,
      source: 'reference',
    })),
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderExplainNdjsonOutput(code: string): string {
  const reference = getDiagnosticReference(code);
  if (!reference) {
    return `${
      JSON.stringify({
        event: 'explain',
        schemaVersion: 1,
        toolVersion: VERSION,
        code,
        found: false,
        message: `No built-in explanation is available for diagnostic code ${code}.`,
      })
    }\n`;
  }

  return `${
    JSON.stringify({
      event: 'explain',
      schemaVersion: 1,
      toolVersion: VERSION,
      code: reference.code,
      title: reference.title,
      summary: reference.summary,
      details: reference.details,
      repairHeuristic: reference.repairHeuristic,
      examples: reference.examples,
      docsUrl: getDiagnosticDocsUrl(reference.code),
      suggestions: reference.suggestions.map((suggestion) => ({
        ...suggestion,
        source: 'reference',
      })),
    })
  }\n`;
}

function renderExplainOutput(code: string, format: OutputFormat): string {
  if (format === 'json') {
    return renderExplainJsonOutput(code);
  }

  if (format === 'ndjson') {
    return renderExplainNdjsonOutput(code);
  }

  return renderExplainTextOutput(code);
}

function detectSuggestedProjectPath(workingDirectory: string): string | undefined {
  const soundscriptProjectPath = join(workingDirectory, 'tsconfig.soundscript.json');
  return pathExists(soundscriptProjectPath) ? soundscriptProjectPath : undefined;
}

function createMissingProjectResult(
  format: OutputFormat,
  command: 'build' | 'check' | 'compile' | 'expand',
  projectPath: string,
  workingDirectory: string,
): CliResult {
  const requestedProjectName = basename(projectPath);
  const suggestedProjectPath = requestedProjectName === 'tsconfig.json'
    ? detectSuggestedProjectPath(workingDirectory)
    : undefined;
  const diagnostics = [
    createCliDiagnostic(
      'SOUNDSCRIPT_NO_PROJECT',
      'No tsconfig.json was found for this command.',
      projectPath,
      {
        notes: suggestedProjectPath
          ? [
            `Found '${
              basename(suggestedProjectPath)
            }' in this directory instead of 'tsconfig.json'.`,
          ]
          : undefined,
        hint: suggestedProjectPath
          ? `Try 'soundscript ${command} --project ${basename(suggestedProjectPath)}'.`
          : "Run 'soundscript init' to create a new project, or pass --project to an existing tsconfig.",
      },
    ),
  ];

  return {
    exitCode: CLI_FAILURE_EXIT_CODE,
    output: renderDiagnosticsOutput(
      format,
      command,
      projectPath,
      workingDirectory,
      CLI_FAILURE_EXIT_CODE,
      diagnostics,
    ),
    diagnostics,
    projectPath,
    workingDirectory,
  };
}

function createCliFailureResult(
  format: OutputFormat,
  command: MachineReadableCommand,
  workingDirectory: string,
  details: {
    code: string;
    hint?: string;
    message: string;
    notes?: string[];
    projectPath?: string;
  },
): CliResult {
  const projectPath = details.projectPath ?? '';
  const diagnostics = [
    createCliDiagnostic(
      details.code,
      details.message,
      details.projectPath ?? workingDirectory,
      {
        hint: details.hint,
        notes: details.notes,
      },
    ),
  ];

  return {
    exitCode: CLI_FAILURE_EXIT_CODE,
    output: renderDiagnosticsOutput(
      format,
      command,
      projectPath,
      workingDirectory,
      CLI_FAILURE_EXIT_CODE,
      diagnostics,
    ),
    diagnostics,
    projectPath,
    workingDirectory,
  };
}

function describeUnexpectedError(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error === undefined || error === null) {
    return undefined;
  }

  return String(error);
}

function createInternalErrorResult(
  format: OutputFormat,
  command: 'build' | 'check' | 'compile' | 'expand',
  projectPath: string,
  workingDirectory: string,
  error?: unknown,
  commandOutput?: string,
): CliResult {
  const notes: string[] = [];
  const errorMessage = describeUnexpectedError(error);
  if (errorMessage) {
    notes.push(`Internal error: ${errorMessage}`);
  }
  if (commandOutput && commandOutput.trim().length > 0 && commandOutput !== errorMessage) {
    notes.push(`Command output: ${commandOutput}`);
  }

  return createCliFailureResult(format, command, workingDirectory, {
    code: 'SOUNDSCRIPT_INTERNAL_ERROR',
    message: `soundscript hit an unexpected internal error while running '${command}'.`,
    notes: notes.length > 0 ? notes : undefined,
    hint:
      'Retry with the smallest reproduction you can share. If it still fails, file an issue with the command and input that triggered it.',
    projectPath,
  });
}

async function initializeProject(
  command: InitCommand,
  workingDirectory: string,
): Promise<CliResult> {
  if (command.mode === 'new') {
    const projectPath = join(workingDirectory, 'tsconfig.json');
    const entryPath = join(workingDirectory, 'src/main.sts');
    if (pathExists(projectPath) || pathExists(entryPath)) {
      const diagnostics = [
        createCliDiagnostic(
          'SOUNDSCRIPT_INIT_CONFLICT',
          'Cannot initialize a new project because soundscript files already exist.',
          pathExists(projectPath) ? projectPath : entryPath,
          {
            hint:
              "Remove the existing files first, or run 'soundscript init --mode existing' in an existing TypeScript project.",
          },
        ),
      ];
      return {
        exitCode: CLI_FAILURE_EXIT_CODE,
        output: formatDiagnostics(diagnostics, workingDirectory),
        diagnostics,
        projectPath,
        workingDirectory,
      };
    }

    await makeDirectory(join(workingDirectory, 'src'));
    await writeTextFile(
      projectPath,
      `${
        JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'Bundler',
            },
            include: ['src/**/*.ts', 'src/**/*.sts'],
          },
          null,
          2,
        )
      }\n`,
    );
    await writeTextFile(
      entryPath,
      [
        "console.log('Hello from soundscript');",
        '',
      ].join('\n'),
    );

    return {
      exitCode: 0,
      output: [
        `Initialized a new soundscript project in ${workingDirectory}.`,
        '',
        'Next steps:',
        '  1. Edit src/main.sts',
        '  2. Run soundscript check',
        '',
      ].join('\n'),
      diagnostics: [],
      projectPath,
      workingDirectory,
    };
  }

  const baseProjectPath = join(workingDirectory, 'tsconfig.json');
  const projectPath = join(workingDirectory, 'tsconfig.soundscript.json');
  if (!pathExists(baseProjectPath)) {
    const diagnostics = [
      createCliDiagnostic(
        'SOUNDSCRIPT_INIT_BASE_PROJECT_MISSING',
        'Cannot initialize existing-project mode without a tsconfig.json.',
        baseProjectPath,
        {
          hint:
            "Create a base tsconfig.json first, or run 'soundscript init' to create a fresh soundscript project.",
        },
      ),
    ];
    return {
      exitCode: CLI_FAILURE_EXIT_CODE,
      output: formatDiagnostics(diagnostics, workingDirectory),
      diagnostics,
      projectPath,
      workingDirectory,
    };
  }
  if (pathExists(projectPath)) {
    const diagnostics = [
      createCliDiagnostic(
        'SOUNDSCRIPT_INIT_CONFLICT',
        'Cannot initialize existing-project mode because tsconfig.soundscript.json already exists.',
        projectPath,
        {
          hint: `Use 'soundscript check --project ${
            basename(projectPath)
          }' with the existing config, or delete it before re-running init.`,
        },
      ),
    ];
    return {
      exitCode: CLI_FAILURE_EXIT_CODE,
      output: formatDiagnostics(diagnostics, workingDirectory),
      diagnostics,
      projectPath,
      workingDirectory,
    };
  }

  const include = deriveExistingProjectInclude(baseProjectPath);

  await writeTextFile(
    projectPath,
    `${
      JSON.stringify(
        {
          extends: './tsconfig.json',
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
          },
          ...(include ? { include } : {}),
        },
        null,
        2,
      )
    }\n`,
  );

  return {
    exitCode: 0,
    output: [
      'Initialized soundscript for an existing TypeScript project.',
      '',
      `Use: soundscript check --project ${basename(projectPath)}`,
      '',
    ].join('\n'),
    diagnostics: [],
    projectPath,
    workingDirectory,
  };
}

async function runBuildWatch(
  command: BuildCommand,
  buildProjectFn: (options: BuildProjectOptions) => Promise<BuildProjectResult>,
  watchFileSystemFn: (path: string) => AsyncIterable<HostFileSystemWatchEvent>,
): Promise<never> {
  const watcher = watchFileSystemFn(dirname(command.projectPath));
  let building = false;
  let pending = false;

  const rebuild = async (): Promise<void> => {
    if (building) {
      pending = true;
      return;
    }

    building = true;
    try {
      const result = await buildProjectFn(command);
      writeStdout(result.output);
    } finally {
      building = false;
      if (pending) {
        pending = false;
        await rebuild();
      }
    }
  };

  await rebuild();
  for await (const event of watcher) {
    if (event.kind === 'other') {
      continue;
    }
    await rebuild();
  }

  throw new Error('soundscript build watch ended unexpectedly.');
}

function maybeResolveLocalCliPath(argument: string, workingDirectory: string): string | undefined {
  if (argument.startsWith('-')) {
    return undefined;
  }

  const resolved = argument.startsWith('/') ? argument : join(workingDirectory, argument);
  return pathExists(resolved) ? resolved : undefined;
}

function ensureNodeSourceMapsFlag(nodeArgs: readonly string[]): string[] {
  return nodeArgs.includes('--enable-source-maps')
    ? [...nodeArgs]
    : [...nodeArgs, '--enable-source-maps'];
}

async function runSubprocess(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  return await runCommand(command, args, cwd);
}

async function runNodeCommand(
  command: NodeCommand,
  runSubprocessFn: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ exitCode: number; output: string }>,
): Promise<CliResult> {
  const tempDirectory = await createTempDirectory('soundscript-node-');
  try {
    const materialized = await materializeRuntimeGraph({
      entryPaths: [command.entryPath],
      outDir: tempDirectory,
      workingDirectory: command.workingDirectory,
    });
    if (materialized.exitCode !== 0 || !materialized.artifacts) {
      return {
        exitCode: materialized.exitCode,
        output: materialized.output,
        diagnostics: materialized.diagnostics,
        projectPath: command.entryPath,
        workingDirectory: command.workingDirectory,
      };
    }

    const entryOutputPath = materialized.artifacts.entryOutputPaths[0];
    if (!entryOutputPath) {
      return createCliFailureResult('text', 'cli', command.workingDirectory, {
        code: 'SOUNDSCRIPT_RUNTIME_NO_ENTRY',
        message: 'Runtime materialization did not produce an entry output.',
        projectPath: materialized.artifacts.projectPath,
      });
    }

    const subprocess = await runSubprocessFn(
      'node',
      [...ensureNodeSourceMapsFlag(command.nodeArgs), entryOutputPath, ...command.forwardedArgs],
      command.workingDirectory,
    );
    return {
      exitCode: subprocess.exitCode,
      output: subprocess.output,
      diagnostics: [],
      projectPath: materialized.artifacts.projectPath,
      workingDirectory: command.workingDirectory,
    };
  } finally {
    await removePath(tempDirectory).catch(() => undefined);
  }
}

function replaceLocalDenoEntryArgs(
  denoSubcommand: DenoCommand['denoSubcommand'],
  forwardedArgs: readonly string[],
  materialized: MaterializeRuntimeGraphArtifacts,
  workingDirectory: string,
): string[] {
  const rewrittenArgs = [...forwardedArgs];

  if (denoSubcommand === 'run') {
    for (let index = 0; index < rewrittenArgs.length; index += 1) {
      const candidate = maybeResolveLocalCliPath(rewrittenArgs[index]!, workingDirectory);
      if (!candidate) {
        continue;
      }

      rewrittenArgs[index] = materialized.entryOutputPaths[0]!;
      break;
    }
    return rewrittenArgs;
  }

  let materializedIndex = 0;
  for (let index = 0; index < rewrittenArgs.length; index += 1) {
    const candidate = maybeResolveLocalCliPath(rewrittenArgs[index]!, workingDirectory);
    if (!candidate) {
      continue;
    }

    const mapped = materialized.entryOutputPaths[materializedIndex];
    if (mapped) {
      rewrittenArgs[index] = mapped;
      materializedIndex += 1;
    }
  }
  return rewrittenArgs;
}

async function runDenoCommand(
  command: DenoCommand,
  runSubprocessFn: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Promise<{ exitCode: number; output: string }>,
): Promise<CliResult> {
  const tempDirectory = await createTempDirectory('soundscript-deno-');
  try {
    const localEntryPaths = command.denoSubcommand === 'run'
      ? (() => {
        for (const argument of command.forwardedArgs) {
          const candidate = maybeResolveLocalCliPath(argument, command.workingDirectory);
          if (candidate) {
            return [candidate];
          }
        }
        return [];
      })()
      : command.forwardedArgs
        .map((argument) => maybeResolveLocalCliPath(argument, command.workingDirectory))
        .filter((path): path is string => path !== undefined);

    const materialized = localEntryPaths.length > 0
      ? await materializeRuntimeGraph({
        entryPaths: localEntryPaths,
        outDir: tempDirectory,
        workingDirectory: command.workingDirectory,
      })
      : {
        artifacts: {
          emittedFiles: [],
          entryOutputPaths: [],
          outDir: tempDirectory,
          projectPath: '',
        },
        diagnostics: [],
        exitCode: 0,
        output: '',
      };

    if (materialized.exitCode !== 0 || !materialized.artifacts) {
      return {
        exitCode: materialized.exitCode,
        output: materialized.output,
        diagnostics: materialized.diagnostics,
        projectPath: localEntryPaths[0] ?? '',
        workingDirectory: command.workingDirectory,
      };
    }

    const rewrittenArgs = replaceLocalDenoEntryArgs(
      command.denoSubcommand,
      command.forwardedArgs,
      materialized.artifacts,
      command.workingDirectory,
    );
    const subprocess = await runSubprocessFn(
      'deno',
      [command.denoSubcommand, ...rewrittenArgs],
      command.workingDirectory,
    );
    return {
      exitCode: subprocess.exitCode,
      output: subprocess.output,
      diagnostics: [],
      projectPath: materialized.artifacts.projectPath,
      workingDirectory: command.workingDirectory,
    };
  } finally {
    await removePath(tempDirectory).catch(() => undefined);
  }
}

export function runCli(
  args: readonly string[],
  workingDirectory = runtimeCwd(),
  dependencies: CliDependencies = {},
): Promise<CliResult> {
  const command = parseCommand(args, workingDirectory);
  const buildProjectFn = dependencies.buildProject ?? buildProject;
  const compileProjectFn = dependencies.compileProject ?? compileProject;
  const expandProjectFn = dependencies.expandProject ?? expandProject;
  const runSubprocessFn = dependencies.runSubprocess ?? runSubprocess;
  const runProgramFn = dependencies.runProgram ?? runProgram;
  const watchFileSystemFn = dependencies.watchFileSystem ?? watchFileSystem;

  switch (command.kind) {
    case 'help':
      return Promise.resolve({
        exitCode: 0,
        output: `${renderHelp()}\n`,
        diagnostics: [],
        projectPath: '',
        workingDirectory,
      });
    case 'invalid':
      if (detectRequestedOutputFormat(args) !== 'text') {
        return Promise.resolve(
          createCliFailureResult(
            detectRequestedOutputFormat(args),
            detectRequestedCommand(args),
            workingDirectory,
            {
              code: 'SOUNDSCRIPT_INVALID_COMMAND',
              message: command.message,
              hint: "Run 'soundscript --help' for the supported subcommands and options.",
            },
          ),
        );
      }

      return Promise.resolve({
        exitCode: CLI_FAILURE_EXIT_CODE,
        output: renderInvalidCommand(command.message),
        diagnostics: [
          createCliDiagnostic(
            'SOUNDSCRIPT_INVALID_COMMAND',
            command.message,
            workingDirectory,
            {
              hint: "Run 'soundscript --help' for the supported subcommands and options.",
            },
          ),
        ],
        projectPath: '',
        workingDirectory,
      });
    case 'version':
      return Promise.resolve({
        exitCode: 0,
        output: `${VERSION}\n`,
        diagnostics: [],
        projectPath: '',
        workingDirectory,
      });
    case 'init':
      return initializeProject(command, workingDirectory);
    case 'node':
      return runNodeCommand(command, runSubprocessFn);
    case 'deno':
      return runDenoCommand(command, runSubprocessFn);
    case 'explain': {
      const found = getDiagnosticReference(command.code) !== undefined;
      return Promise.resolve({
        exitCode: found ? 0 : FINDINGS_EXIT_CODE,
        output: renderExplainOutput(command.code, command.format),
        diagnostics: [],
        projectPath: '',
        workingDirectory,
      });
    }
    case 'lsp':
      return Promise.resolve({
        exitCode: CLI_FAILURE_EXIT_CODE,
        output:
          "The 'lsp' subcommand is meant to be launched from the main executable entrypoint.\n",
        diagnostics: [],
        projectPath: '',
        workingDirectory,
      });
    case 'editor-worker':
      return Promise.resolve({
        exitCode: CLI_FAILURE_EXIT_CODE,
        output:
          "The 'editor-worker' subcommand is meant to be launched from the main executable entrypoint.\n",
        diagnostics: [],
        projectPath: '',
        workingDirectory,
      });
    case 'editor-project':
      return runEditorProjectCommand(command).catch((error) =>
        createInternalErrorResult(
          'json',
          'expand',
          command.projectPath,
          command.workingDirectory,
          error,
        )
      );
    case 'build': {
      if (!pathExists(command.projectPath)) {
        return Promise.resolve(
          createMissingProjectResult(
            command.format,
            'build',
            command.projectPath,
            command.workingDirectory,
          ),
        );
      }

      if (command.watch) {
        return runBuildWatch(command, buildProjectFn, watchFileSystemFn).then(() => ({
          exitCode: 0,
          output: '',
          diagnostics: [],
          projectPath: command.projectPath,
          workingDirectory: command.workingDirectory,
        }));
      }

      return buildProjectFn(command)
        .then((result) => {
          if (result.exitCode !== 0 && result.diagnostics.length === 0) {
            return createInternalErrorResult(
              command.format,
              'build',
              command.projectPath,
              command.workingDirectory,
              undefined,
              result.output,
            );
          }

          return {
            ...result,
            output: command.format === 'text' ? result.output : renderDiagnosticsOutput(
              command.format,
              'build',
              command.projectPath,
              command.workingDirectory,
              result.exitCode,
              result.diagnostics,
              result.artifacts,
            ),
            projectPath: command.projectPath,
            workingDirectory: command.workingDirectory,
          };
        })
        .catch((error) =>
          createInternalErrorResult(
            command.format,
            'build',
            command.projectPath,
            command.workingDirectory,
            error,
          )
        );
    }
    case 'check': {
      if (!pathExists(command.projectPath)) {
        return Promise.resolve(
          createMissingProjectResult(
            command.format,
            'check',
            command.projectPath,
            command.workingDirectory,
          ),
        );
      }

      let result: RunProgramResult;
      try {
        result = runProgramFn(command);
      } catch (error) {
        return Promise.resolve(
          createInternalErrorResult(
            command.format,
            'check',
            command.projectPath,
            command.workingDirectory,
            error,
          ),
        );
      }
      if (result.exitCode !== 0 && result.diagnostics.length === 0) {
        return Promise.resolve(
          createInternalErrorResult(
            command.format,
            'check',
            command.projectPath,
            command.workingDirectory,
            undefined,
            result.output,
          ),
        );
      }

      return Promise.resolve({
        ...result,
        output: command.format === 'text' ? result.output : renderDiagnosticsOutput(
          command.format,
          'check',
          command.projectPath,
          command.workingDirectory,
          result.exitCode,
          result.diagnostics,
        ),
        projectPath: command.projectPath,
        workingDirectory: command.workingDirectory,
      });
    }
    case 'compile': {
      if (!pathExists(command.projectPath)) {
        return Promise.resolve(
          createMissingProjectResult(
            command.format,
            'compile',
            command.projectPath,
            command.workingDirectory,
          ),
        );
      }

      let result: CompileProjectResult;
      try {
        result = compileProjectFn(command);
      } catch (error) {
        return Promise.resolve(
          createInternalErrorResult(
            command.format,
            'compile',
            command.projectPath,
            command.workingDirectory,
            error,
          ),
        );
      }
      if (result.exitCode !== 0 && result.diagnostics.length === 0) {
        return Promise.resolve(
          createInternalErrorResult(
            command.format,
            'compile',
            command.projectPath,
            command.workingDirectory,
            undefined,
            result.output,
          ),
        );
      }

      return Promise.resolve({
        ...result,
        output: command.format === 'text' ? result.output : renderDiagnosticsOutput(
          command.format,
          'compile',
          command.projectPath,
          command.workingDirectory,
          result.exitCode,
          result.diagnostics,
          result.artifacts,
        ),
        projectPath: command.projectPath,
        workingDirectory: command.workingDirectory,
      });
    }
    case 'expand': {
      if (!pathExists(command.projectPath)) {
        return Promise.resolve(
          createMissingProjectResult(
            command.format,
            'expand',
            command.projectPath,
            command.workingDirectory,
          ),
        );
      }

      return expandProjectFn(command)
        .then((result) => {
          if (result.exitCode !== 0 && result.diagnostics.length === 0) {
            return createInternalErrorResult(
              command.format,
              'expand',
              command.projectPath,
              command.workingDirectory,
              undefined,
              result.output,
            );
          }

          if (command.filePath && result.exitCode === 0) {
            return {
              ...result,
              projectPath: command.projectPath,
              workingDirectory: command.workingDirectory,
            };
          }

          return {
            ...result,
            output: command.format === 'text' ? result.output : renderDiagnosticsOutput(
              command.format,
              'expand',
              command.projectPath,
              command.workingDirectory,
              result.exitCode,
              result.diagnostics,
              result.artifacts,
            ),
            projectPath: command.projectPath,
            workingDirectory: command.workingDirectory,
          };
        })
        .catch((error) =>
          createInternalErrorResult(
            command.format,
            'expand',
            command.projectPath,
            command.workingDirectory,
            error,
          )
        );
    }
    default: {
      const exhaustiveCheck: never = command;
      return exhaustiveCheck;
    }
  }
}
