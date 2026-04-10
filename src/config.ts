import ts from 'typescript';

import { dirname, isAbsolute, join } from './platform/path.ts';

export type OutputFormat = 'json' | 'ndjson' | 'text';
export type InitMode = 'existing' | 'new';
export type ExpandStage = 'expanded' | 'prepared' | 'projected' | 'rewrite';
export type RuntimeTarget =
  | 'js-browser'
  | 'js-node'
  | 'wasm-browser'
  | 'wasm-node'
  | 'wasm-wasi';
export type RuntimeBackend = 'js' | 'wasm';
export type RuntimeHost = 'browser' | 'node' | 'wasi';

export interface SoundscriptConfig {
  target: RuntimeTarget;
}

export interface RuntimeContext {
  backend: RuntimeBackend;
  host: RuntimeHost;
  target: RuntimeTarget;
}

export interface RuntimeConfigOverrides {
  target?: RuntimeTarget;
}

export interface HelpCommand {
  kind: 'help';
}

export interface InvalidCommand {
  kind: 'invalid';
  message: string;
}

export interface CheckCommand {
  kind: 'check';
  format: OutputFormat;
  projectPath: string;
  target?: RuntimeTarget;
  workingDirectory: string;
}

export interface CompileCommand {
  kind: 'compile';
  format: OutputFormat;
  projectPath: string;
  target?: RuntimeTarget;
  workingDirectory: string;
}

export interface ExpandCommand {
  filePath?: string;
  kind: 'expand';
  format: OutputFormat;
  outDir: string;
  projectPath: string;
  stage: ExpandStage;
  target?: RuntimeTarget;
  trace: boolean;
  workingDirectory: string;
}

export interface BuildCommand {
  kind: 'build';
  format: OutputFormat;
  outDir: string;
  projectPath: string;
  target?: RuntimeTarget;
  watch: boolean;
  workingDirectory: string;
}

export interface NodeCommand {
  kind: 'node';
  entryPath: string;
  nodeArgs: string[];
  forwardedArgs: string[];
  workingDirectory: string;
}

export interface DenoCommand {
  denoSubcommand: 'run' | 'test';
  forwardedArgs: string[];
  kind: 'deno';
  workingDirectory: string;
}

export interface InitCommand {
  kind: 'init';
  mode: InitMode;
  workingDirectory: string;
}

export interface LspCommand {
  kind: 'lsp';
  workingDirectory: string;
}

export interface EditorProjectCommand {
  filePath: string;
  kind: 'editor-project';
  projectPath: string;
  useStdin: boolean;
  workingDirectory: string;
}

export interface EditorWorkerCommand {
  kind: 'editor-worker';
  workingDirectory: string;
}

export interface VersionCommand {
  kind: 'version';
}

export interface ExplainCommand {
  kind: 'explain';
  code: string;
  format: OutputFormat;
}

export type ParsedCommand =
  | HelpCommand
  | InvalidCommand
  | BuildCommand
  | CheckCommand
  | CompileCommand
  | DenoCommand
  | EditorProjectCommand
  | EditorWorkerCommand
  | ExpandCommand
  | ExplainCommand
  | InitCommand
  | LspCommand
  | NodeCommand
  | VersionCommand;

export interface LoadedConfig {
  commandLine: ts.ParsedCommandLine;
  diagnostics: ts.Diagnostic[];
  runtime: RuntimeContext;
  soundscript: SoundscriptConfig;
}

interface FileSystemEntries {
  directories: readonly string[];
  files: readonly string[];
}

interface SoundscriptMatchFilesApi {
  matchFiles(
    path: string,
    extensions: readonly string[],
    excludes: readonly string[] | undefined,
    includes: readonly string[],
    useCaseSensitiveFileNames: boolean,
    currentDirectory: string,
    depth: number | undefined,
    getFileSystemEntries: (path: string) => FileSystemEntries,
    realpath: (path: string) => string,
  ): string[];
}

interface SoundscriptSystemApi extends ts.System {
  getAccessibleFileSystemEntries(path: string): FileSystemEntries;
}

export function normalizeSoundCompilerOptions(
  options: ts.CompilerOptions,
): ts.CompilerOptions {
  return {
    ...options,
    allowImportingTsExtensions: true,
    emitDecoratorMetadata: false,
    erasableSyntaxOnly: true,
    exactOptionalPropertyTypes: true,
    experimentalDecorators: false,
    jsx: ts.JsxEmit.ReactJSX,
    noEmit: true,
    noFallthroughCasesInSwitch: true,
    noImplicitOverride: true,
    noPropertyAccessFromIndexSignature: true,
    noUncheckedIndexedAccess: true,
    strict: true,
  };
}

const DEFAULT_RUNTIME_TARGET: RuntimeTarget = 'js-node';
const DEFAULT_SOUNDSCRIPT_CONFIG: SoundscriptConfig = {
  target: DEFAULT_RUNTIME_TARGET,
};
const DEFAULT_CORE_LIBS = ['lib.es2024.d.ts'] as const;
const DEFAULT_NODE_TYPES = ['node'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === 'json' || value === 'ndjson' || value === 'text';
}

function isInitMode(value: string): value is InitMode {
  return value === 'existing' || value === 'new';
}

function isExpandStage(value: string): value is ExpandStage {
  return value === 'expanded' || value === 'prepared' || value === 'projected' ||
    value === 'rewrite';
}

function isRuntimeTarget(value: string): value is RuntimeTarget {
  return value === 'js-browser' ||
    value === 'js-node' ||
    value === 'wasm-browser' ||
    value === 'wasm-node' ||
    value === 'wasm-wasi';
}

const NODE_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-C',
  '-e',
  '-p',
  '-r',
  '--build-snapshot-config',
  '--conditions',
  '--cpu-prof-dir',
  '--cpu-prof-interval',
  '--cpu-prof-name',
  '--debug-port',
  '--diagnostic-dir',
  '--disable-proto',
  '--disable-warning',
  '--dns-result-order',
  '--env-file',
  '--env-file-if-exists',
  '--eval',
  '--experimental-config-file',
  '--experimental-loader',
  '--experimental-sea-config',
  '--heap-prof-dir',
  '--heap-prof-interval',
  '--heap-prof-name',
  '--heapsnapshot-near-heap-limit',
  '--heapsnapshot-signal',
  '--icu-data-dir',
  '--import',
  '--input-type',
  '--inspect-publish-uid',
  '--localstorage-file',
  '--loader',
  '--max-http-header-size',
  '--max-old-space-size-percentage',
  '--network-family-autoselection-attempt-timeout',
  '--openssl-config',
  '--redirect-warnings',
  '--report-dir',
  '--report-directory',
  '--report-filename',
  '--report-signal',
  '--require',
  '--run',
  '--secure-heap',
  '--secure-heap-min',
  '--snapshot-blob',
  '--test-concurrency',
  '--test-coverage-branches',
  '--test-coverage-exclude',
  '--test-coverage-functions',
  '--test-coverage-include',
  '--test-coverage-lines',
  '--test-global-setup',
  '--test-isolation',
  '--test-name-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-rerun-failures',
  '--test-shard',
  '--test-skip-pattern',
  '--test-timeout',
  '--title',
  '--tls-cipher-list',
  '--tls-keylog',
  '--trace-event-categories',
  '--trace-event-file-pattern',
  '--trace-require-module',
  '--unhandled-rejections',
  '--use-largepages',
  '--v8-pool-size',
  '--watch-kill-signal',
  '--watch-path',
]);

function nodeOptionConsumesNextArg(argument: string): boolean {
  return !argument.includes('=') && NODE_OPTIONS_WITH_VALUE.has(argument);
}

function parseNodeCommandArgs(
  args: readonly string[],
  workingDirectory: string,
): NodeCommand | InvalidCommand {
  const nodeArgs: string[] = [];
  let consumeNextAsNodeOptionValue = false;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (consumeNextAsNodeOptionValue) {
      nodeArgs.push(argument);
      consumeNextAsNodeOptionValue = false;
      continue;
    }

    if (argument === '--') {
      const entryArgument = args[index + 1];
      if (!entryArgument || entryArgument.startsWith('-')) {
        return {
          kind: 'invalid',
          message: 'Missing entry file for node.',
        };
      }

      return {
        kind: 'node',
        entryPath: ts.sys.resolvePath(
          isAbsolute(entryArgument) ? entryArgument : join(workingDirectory, entryArgument),
        ),
        nodeArgs,
        forwardedArgs: [...args.slice(index + 2)],
        workingDirectory,
      };
    }

    if (argument.startsWith('-')) {
      nodeArgs.push(argument);
      consumeNextAsNodeOptionValue = nodeOptionConsumesNextArg(argument);
      continue;
    }

    return {
      kind: 'node',
      entryPath: ts.sys.resolvePath(
        isAbsolute(argument) ? argument : join(workingDirectory, argument),
      ),
      nodeArgs,
      forwardedArgs: [...args.slice(index + 1)],
      workingDirectory,
    };
  }

  return {
    kind: 'invalid',
    message: 'Missing entry file for node.',
  };
}

function createRemovedExternsDiagnostic(projectPath: string): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 80001,
    file: undefined,
    length: undefined,
    messageText:
      '`soundscript.externs` is no longer supported. Use `compilerOptions.lib` and `compilerOptions.types` for host declaration visibility.',
    start: undefined,
    source: projectPath,
  };
}

function collectSoundscriptConfigDiagnostics(
  rawConfig: unknown,
  projectPath: string,
): ts.Diagnostic[] {
  const soundscriptSection = isRecord(rawConfig) && isRecord(rawConfig.soundscript)
    ? rawConfig.soundscript
    : undefined;
  return soundscriptSection && 'externs' in soundscriptSection
    ? [createRemovedExternsDiagnostic(projectPath)]
    : [];
}

function parseSoundscriptConfig(rawConfig: unknown): SoundscriptConfig {
  const soundscriptSection = isRecord(rawConfig) && isRecord(rawConfig.soundscript)
    ? rawConfig.soundscript
    : undefined;
  const configuredTarget = typeof soundscriptSection?.target === 'string' &&
      isRuntimeTarget(soundscriptSection.target)
    ? soundscriptSection.target
    : DEFAULT_RUNTIME_TARGET;
  return {
    target: configuredTarget,
  };
}

function applyRuntimeConfigOverrides(
  soundscript: SoundscriptConfig,
  overrides: RuntimeConfigOverrides = {},
): SoundscriptConfig {
  return {
    target: overrides.target ?? soundscript.target,
  };
}

function hasExplicitCompilerLibs(rawConfig: unknown): boolean {
  return isRecord(rawConfig) &&
    isRecord(rawConfig.compilerOptions) &&
    Array.isArray(rawConfig.compilerOptions.lib);
}

function hasExplicitCompilerTypes(rawConfig: unknown): boolean {
  return isRecord(rawConfig) &&
    isRecord(rawConfig.compilerOptions) &&
    Array.isArray(rawConfig.compilerOptions.types);
}

function applyDefaultRuntimeLibs(
  commandLine: ts.ParsedCommandLine,
  runtime: RuntimeContext,
  rawConfig: unknown,
): ts.ParsedCommandLine {
  void runtime;
  if (hasExplicitCompilerLibs(rawConfig)) {
    return commandLine;
  }

  return {
    ...commandLine,
    options: {
      ...commandLine.options,
      lib: [...DEFAULT_CORE_LIBS],
    },
  };
}

function runtimeDefaultTypes(runtime: RuntimeContext): readonly string[] | undefined {
  return runtime.host === 'node' ? DEFAULT_NODE_TYPES : undefined;
}

function applyDefaultRuntimeTypes(
  commandLine: ts.ParsedCommandLine,
  runtime: RuntimeContext,
  rawConfig: unknown,
): ts.ParsedCommandLine {
  if (hasExplicitCompilerTypes(rawConfig)) {
    return commandLine;
  }

  const defaultTypes = runtimeDefaultTypes(runtime);
  if (!defaultTypes) {
    return commandLine;
  }

  return {
    ...commandLine,
    options: {
      ...commandLine.options,
      types: [...defaultTypes],
    },
  };
}

function isSoundCompilerOptionRootName(fileName: string): boolean {
  return fileName.endsWith('.sts') || fileName.endsWith('.sts.ts');
}

function applySoundCompilerOptionBaseline(
  commandLine: ts.ParsedCommandLine,
): ts.ParsedCommandLine {
  return {
    ...commandLine,
    options: normalizeSoundCompilerOptions(commandLine.options),
  };
}

function shouldApplySoundCompilerOptionBaseline(
  projectPath: string,
  commandLine: ts.ParsedCommandLine,
  additionalRootNames: readonly string[] = [],
): boolean {
  return [
    ...commandLine.fileNames,
    ...collectConfiguredSoundscriptRootNames(projectPath, commandLine),
    ...additionalRootNames,
  ].some(isSoundCompilerOptionRootName);
}

export function normalizeRuntimeContext(
  soundscript: SoundscriptConfig,
  overrides: RuntimeConfigOverrides = {},
): RuntimeContext {
  const resolved = applyRuntimeConfigOverrides(soundscript, overrides);
  switch (resolved.target) {
    case 'js-browser':
      return { backend: 'js', host: 'browser', target: resolved.target };
    case 'js-node':
      return { backend: 'js', host: 'node', target: resolved.target };
    case 'wasm-browser':
      return {
        backend: 'wasm',
        host: 'browser',
        target: resolved.target,
      };
    case 'wasm-node':
      return { backend: 'wasm', host: 'node', target: resolved.target };
    case 'wasm-wasi':
      return { backend: 'wasm', host: 'wasi', target: resolved.target };
  }
}

export function resolveExpansionEnabled(
  requestedExpansionEnabled: boolean | undefined,
  soundscript: SoundscriptConfig,
): boolean {
  void soundscript;
  return requestedExpansionEnabled ?? true;
}

function collectConfiguredSoundscriptRootNames(
  projectPath: string,
  commandLine: ts.ParsedCommandLine,
): string[] {
  const matchFilesApi = ts as typeof ts & SoundscriptMatchFilesApi;
  const systemApi = ts.sys as SoundscriptSystemApi;
  const basePath = dirname(projectPath);
  const realpath = ts.sys.realpath?.bind(ts.sys) ?? ((path: string) => path);
  const rawConfig = commandLine.raw as {
    exclude?: readonly string[];
    files?: readonly string[];
    include?: readonly string[];
  } | undefined;
  const explicitSoundscriptFiles = (rawConfig?.files ?? [])
    .map((fileName) => isAbsolute(fileName) ? fileName : join(basePath, fileName))
    .map((fileName) => ts.sys.resolvePath(fileName))
    .filter((fileName) => fileName.endsWith('.sts'));
  const includePatterns = rawConfig?.include
    ? [...rawConfig.include]
    : rawConfig?.files
    ? []
    : ['**/*'];
  const excludePatterns = rawConfig?.exclude
    ? [...rawConfig.exclude]
    : ['node_modules', 'bower_components', 'jspm_packages', '.git'];
  const matchedSoundscriptFiles = includePatterns.length > 0
    ? matchFilesApi.matchFiles(
      basePath,
      ['.sts'],
      excludePatterns,
      includePatterns,
      ts.sys.useCaseSensitiveFileNames,
      basePath,
      undefined,
      systemApi.getAccessibleFileSystemEntries.bind(ts.sys),
      realpath,
    )
    : [];

  return [...new Set([...explicitSoundscriptFiles, ...matchedSoundscriptFiles])].sort();
}

export function collectSoundscriptRootNames(
  projectPath: string,
  loadedConfig: LoadedConfig,
): string[] {
  return collectConfiguredSoundscriptRootNames(projectPath, loadedConfig.commandLine);
}

export function getConfigFileParsingDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  additionalRootNames: readonly string[] = [],
): readonly ts.Diagnostic[] {
  if (additionalRootNames.length === 0) {
    return diagnostics;
  }

  return diagnostics.filter((diagnostic) => diagnostic.code !== 18003);
}

export function parseCommand(args: readonly string[], workingDirectory: string): ParsedCommand {
  if (args.length === 0) {
    return { kind: 'help' };
  }

  const subcommand = args[0];
  if (subcommand === '--help' || subcommand === '-h') {
    return { kind: 'help' };
  }
  if (subcommand === '--version' || subcommand === '-v') {
    return { kind: 'version' };
  }
  if (
    subcommand !== 'build' && subcommand !== 'check' && subcommand !== 'compile' &&
    subcommand !== 'deno' &&
    subcommand !== 'editor-project' &&
    subcommand !== 'editor-worker' &&
    subcommand !== 'expand' &&
    subcommand !== 'explain' &&
    subcommand !== 'init' &&
    subcommand !== 'lsp' &&
    subcommand !== 'node'
  ) {
    return {
      kind: 'invalid',
      message: subcommand.startsWith('-')
        ? 'A subcommand is required before command options.'
        : `Unknown subcommand: ${subcommand}`,
    };
  }

  if (subcommand === 'node') {
    return parseNodeCommandArgs(args, workingDirectory);
  }

  if (subcommand === 'deno') {
    const denoSubcommand = args[1];
    if (denoSubcommand !== 'run' && denoSubcommand !== 'test') {
      return {
        kind: 'invalid',
        message: "Deno wrapper requires 'run' or 'test'.",
      };
    }

    return {
      kind: 'deno',
      denoSubcommand,
      forwardedArgs: [...args.slice(2)],
      workingDirectory,
    };
  }

  let format: OutputFormat = 'text';
  let expandFilePath: string | undefined;
  let expandStage: ExpandStage = 'expanded';
  let expandTrace = false;
  let editorProjectUseStdin = false;
  let mode: InitMode = 'new';
  let outDir: string | undefined;
  let explainCode: string | undefined;
  let projectPath: string | undefined;
  let runtimeTarget: RuntimeTarget | undefined;
  let watch = false;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];

    switch (argument) {
      case '--help':
      case '-h':
        return { kind: 'help' };
      case '--version':
      case '-v':
        return { kind: 'version' };
      case '--project':
      case '-p': {
        if (
          subcommand === 'init' || subcommand === 'lsp' || subcommand === 'editor-worker' ||
          subcommand === 'explain'
        ) {
          return {
            kind: 'invalid',
            message: `${argument} is not supported for ${subcommand}.`,
          };
        }

        const nextArgument = args[index + 1];
        if (!nextArgument || nextArgument.startsWith('-')) {
          return {
            kind: 'invalid',
            message: `Missing value for ${argument}.`,
          };
        }

        projectPath = ts.sys.resolvePath(
          isAbsolute(nextArgument) ? nextArgument : join(workingDirectory, nextArgument),
        );
        index += 1;
        break;
      }
      case '--format': {
        if (subcommand === 'init' || subcommand === 'lsp') {
          return {
            kind: 'invalid',
            message: `--format is not supported for ${subcommand}.`,
          };
        }

        const nextArgument = args[index + 1];
        if (!nextArgument || nextArgument.startsWith('-')) {
          return {
            kind: 'invalid',
            message: 'Missing value for --format.',
          };
        }
        if (!isOutputFormat(nextArgument)) {
          return {
            kind: 'invalid',
            message: `Unknown output format: ${nextArgument}`,
          };
        }

        format = nextArgument;
        index += 1;
        break;
      }
      case '--target': {
        if (
          subcommand !== 'build' && subcommand !== 'check' && subcommand !== 'compile' &&
          subcommand !== 'expand'
        ) {
          return {
            kind: 'invalid',
            message: `--target is not supported for ${subcommand}.`,
          };
        }

        const nextArgument = args[index + 1];
        if (!nextArgument || nextArgument.startsWith('-')) {
          return {
            kind: 'invalid',
            message: 'Missing value for --target.',
          };
        }
        if (!isRuntimeTarget(nextArgument)) {
          return {
            kind: 'invalid',
            message: `Unknown runtime target: ${nextArgument}`,
          };
        }

        runtimeTarget = nextArgument;
        index += 1;
        break;
      }
      case '--out-dir': {
        if (subcommand !== 'build' && subcommand !== 'expand') {
          return {
            kind: 'invalid',
            message: '--out-dir is only supported for build or expand.',
          };
        }

        const nextArgument = args[index + 1];
        if (!nextArgument || nextArgument.startsWith('-')) {
          return {
            kind: 'invalid',
            message: 'Missing value for --out-dir.',
          };
        }

        outDir = ts.sys.resolvePath(
          isAbsolute(nextArgument) ? nextArgument : join(workingDirectory, nextArgument),
        );
        index += 1;
        break;
      }
      case '--file': {
        if (subcommand !== 'expand' && subcommand !== 'editor-project') {
          return {
            kind: 'invalid',
            message: '--file is only supported for expand or editor-project.',
          };
        }

        const nextArgument = args[index + 1];
        if (!nextArgument || nextArgument.startsWith('-')) {
          return {
            kind: 'invalid',
            message: 'Missing value for --file.',
          };
        }

        expandFilePath = ts.sys.resolvePath(
          isAbsolute(nextArgument) ? nextArgument : join(workingDirectory, nextArgument),
        );
        index += 1;
        break;
      }
      case '--stdin-file': {
        if (subcommand !== 'editor-project') {
          return {
            kind: 'invalid',
            message: '--stdin-file is only supported for editor-project.',
          };
        }

        editorProjectUseStdin = true;
        break;
      }
      case '--stage': {
        if (subcommand !== 'expand') {
          return {
            kind: 'invalid',
            message: '--stage is only supported for expand.',
          };
        }

        const nextArgument = args[index + 1];
        if (!nextArgument || nextArgument.startsWith('-')) {
          return {
            kind: 'invalid',
            message: 'Missing value for --stage.',
          };
        }
        if (!isExpandStage(nextArgument)) {
          return {
            kind: 'invalid',
            message: `Unknown expand stage: ${nextArgument}`,
          };
        }

        expandStage = nextArgument;
        index += 1;
        break;
      }
      case '--trace': {
        if (subcommand !== 'expand') {
          return {
            kind: 'invalid',
            message: '--trace is only supported for expand.',
          };
        }

        expandTrace = true;
        break;
      }
      case '--watch': {
        if (subcommand !== 'build') {
          return {
            kind: 'invalid',
            message: '--watch is only supported for build.',
          };
        }

        watch = true;
        break;
      }
      case '--mode': {
        if (subcommand !== 'init') {
          return {
            kind: 'invalid',
            message: '--mode is only supported for init.',
          };
        }

        const nextArgument = args[index + 1];
        if (!nextArgument || nextArgument.startsWith('-')) {
          return {
            kind: 'invalid',
            message: 'Missing value for --mode.',
          };
        }
        if (!isInitMode(nextArgument)) {
          return {
            kind: 'invalid',
            message: `Unknown init mode: ${nextArgument}`,
          };
        }

        mode = nextArgument;
        index += 1;
        break;
      }
      default:
        if (subcommand === 'explain' && !argument.startsWith('-')) {
          if (explainCode) {
            return {
              kind: 'invalid',
              message: `Unexpected extra argument for explain: ${argument}`,
            };
          }

          explainCode = argument.toUpperCase();
          break;
        }

        return {
          kind: 'invalid',
          message: `Unknown option: ${argument}`,
        };
    }
  }

  if (subcommand === 'explain') {
    if (!explainCode) {
      return {
        kind: 'invalid',
        message: 'Missing diagnostic code for explain.',
      };
    }

    return {
      kind: 'explain',
      code: explainCode,
      format,
    };
  }

  if (subcommand === 'init') {
    return {
      kind: 'init',
      mode,
      workingDirectory,
    };
  }

  if (subcommand === 'lsp') {
    return {
      kind: 'lsp',
      workingDirectory,
    };
  }

  if (subcommand === 'editor-worker') {
    return {
      kind: 'editor-worker',
      workingDirectory,
    };
  }

  if (subcommand === 'editor-project') {
    if (!projectPath) {
      projectPath = ts.sys.resolvePath(join(workingDirectory, 'tsconfig.json'));
    }
    if (!expandFilePath) {
      return {
        kind: 'invalid',
        message: 'Missing --file for editor-project.',
      };
    }
    return {
      kind: 'editor-project',
      filePath: expandFilePath,
      projectPath,
      useStdin: editorProjectUseStdin,
      workingDirectory,
    };
  }

  if (subcommand === 'expand') {
    return {
      filePath: expandFilePath,
      kind: 'expand',
      format,
      outDir: outDir ?? join(workingDirectory, 'soundscript-expanded'),
      projectPath: projectPath ?? join(workingDirectory, 'tsconfig.json'),
      stage: expandStage,
      target: runtimeTarget,
      trace: expandTrace,
      workingDirectory,
    };
  }

  if (subcommand === 'build') {
    return {
      kind: 'build',
      format,
      outDir: outDir ?? join(workingDirectory, 'dist'),
      projectPath: projectPath ?? join(workingDirectory, 'tsconfig.json'),
      target: runtimeTarget,
      watch,
      workingDirectory,
    };
  }

  if (subcommand === 'check') {
    return {
      kind: 'check',
      format,
      projectPath: projectPath ?? join(workingDirectory, 'tsconfig.json'),
      target: runtimeTarget,
      workingDirectory,
    };
  }

  return {
    kind: 'compile',
    format,
    projectPath: projectPath ?? join(workingDirectory, 'tsconfig.json'),
    target: runtimeTarget,
    workingDirectory,
  };
}

export function loadConfig(
  projectPath: string,
  runtimeOverrides: RuntimeConfigOverrides = {},
  additionalRootNames: readonly string[] = [],
): LoadedConfig {
  const configFile = ts.readConfigFile(projectPath, ts.sys.readFile);
  const basePath = dirname(projectPath);

  if (configFile.error) {
    const soundscript = applyRuntimeConfigOverrides(DEFAULT_SOUNDSCRIPT_CONFIG, runtimeOverrides);
    const runtime = normalizeRuntimeContext(soundscript);
    const commandLine = ts.parseJsonConfigFileContent(
      {},
      ts.sys,
      basePath,
      {},
      projectPath,
    );
    const normalizedCommandLine = applyDefaultRuntimeTypes(
      applyDefaultRuntimeLibs(commandLine, runtime, {}),
      runtime,
      {},
    );
    return {
      commandLine: shouldApplySoundCompilerOptionBaseline(
          projectPath,
          normalizedCommandLine,
          additionalRootNames,
        )
        ? applySoundCompilerOptionBaseline(normalizedCommandLine)
        : normalizedCommandLine,
      diagnostics: [configFile.error],
      runtime,
      soundscript,
    };
  }

  const commandLine = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    basePath,
    {},
    projectPath,
  );

  const soundscript = applyRuntimeConfigOverrides(
    parseSoundscriptConfig(configFile.config),
    runtimeOverrides,
  );
  const runtime = normalizeRuntimeContext(soundscript);
  const normalizedCommandLine = applyDefaultRuntimeTypes(
    applyDefaultRuntimeLibs(commandLine, runtime, configFile.config),
    runtime,
    configFile.config,
  );
  const configDiagnostics = collectSoundscriptConfigDiagnostics(configFile.config, projectPath);
  return {
    commandLine: shouldApplySoundCompilerOptionBaseline(
        projectPath,
        normalizedCommandLine,
        additionalRootNames,
      )
      ? applySoundCompilerOptionBaseline(normalizedCommandLine)
      : normalizedCommandLine,
    diagnostics: [...commandLine.errors, ...configDiagnostics],
    runtime,
    soundscript,
  };
}
