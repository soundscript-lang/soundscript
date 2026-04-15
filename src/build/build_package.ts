import { createHash } from 'node:crypto';

import { dirname, extname, join, relative } from '../platform/path.ts';
import ts from 'typescript';

import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import {
  formatDiagnostics,
  hasErrorDiagnostics,
  type MergedDiagnostic,
  toMergedDiagnostic,
} from '../checker/diagnostics.ts';
import {
  analyzePreparedProjectWithArtifacts,
  capturePersistentPreparedAnalysisProjectReuseSnapshots,
  collectPreparedAnalysisProjectTrackedFilePaths,
  createPreparedAnalysisProjectFromBuiltinExpandedProgram,
  disposePreparedAnalysisProject,
  type PersistentPreparedAnalysisProjectReuseSnapshots,
  prepareProjectAnalysis,
} from '../checker/analyze_project.ts';
import {
  analyzeProjectWithPersistentCacheForReuse,
  resolveCheckerCacheDirectory,
  writePreparedProjectToPersistentCheckerCache,
} from '../checker/checker_cache.ts';
import { logCheckerTiming, measureCheckerTiming } from '../checker/timing.ts';
import {
  collectSoundscriptRootNames,
  getConfigFileParsingDiagnostics,
  loadConfig,
  type RuntimeTarget,
} from '../project/config.ts';
import {
  type BuiltinEmitProgram,
  createBuiltinEmitProgram,
} from '../frontend/builtin_macro_support.ts';
import { MacroError } from '../frontend/macro_errors.ts';
import {
  emitProjectedDeclarations,
  hydratePersistentPreparedCompilerHostReuseSnapshot,
  isSoundscriptSourceFile,
  type PersistentPreparedCompilerHostReuseSnapshot,
  toSourceFileName,
} from '../frontend/project_frontend.ts';
import { hydratePersistentProjectMacroEnvironmentReuseSnapshot } from '../frontend/project_macro_support.ts';
import { captureTypeScriptDeclarationOutputs } from '../frontend/typescript_effect_declarations.ts';
import {
  loadSoundScriptPackageInfo,
  type SoundScriptPackageInfo,
} from '../project/soundscript_packages.ts';
import {
  copyFile,
  fileExistsSync,
  makeDirectory,
  makeDirectorySync,
  readTextFileSync,
  removePath,
  removePathSync,
  renamePathSync,
  writeTextFile,
  writeTextFileSync,
} from '../platform/host.ts';
import {
  rewriteModuleSpecifiersForEmit,
  transpilePreparedSoundscriptModuleToEsm,
  transpileTypeScriptModuleToEsm,
} from '../runtime/transform.ts';
import { SOUNDSCRIPT_RUNTIME_PACKAGE_NAME } from '../project/soundscript_runtime_specifiers.ts';
import { getSoundscriptToolFingerprint } from '../version.ts';

const DECLARATION_CAPTURE_OUT_DIR = '/__soundscript_build_types__';
const BUILD_CACHE_SCHEMA_VERSION = 2;
const BUILD_CACHE_MANIFEST_FILE_NAME = 'build-manifest.json';
const CHECKER_CACHE_MANIFEST_FILE_NAME = 'manifest.json';
const CHECKER_CACHE_BUILD_INFO_SUBDIRECTORY = 'buildinfo';

interface BuildCacheHeader {
  configDiagnosticsSignature: string;
  configSignature: string;
  projectFileHash: string;
  projectPath: string;
  rootNames: readonly string[];
  runtimeTarget: RuntimeTarget;
  soundscriptRootDiscoverySignature: string;
  targetOverride?: RuntimeTarget;
  toolFingerprint: string;
}

interface BuildCacheManifest {
  cachedAt: string;
  header: BuildCacheHeader;
  prepareArtifacts?: PersistentPreparedAnalysisProjectReuseSnapshots;
  schemaVersion: number;
  trackedFiles: Readonly<Record<string, string>>;
}

interface BuildCacheReadResult {
  prepareArtifacts?: PersistentPreparedAnalysisProjectReuseSnapshots;
  status: 'checker-fallback' | 'hit' | 'miss';
}

export interface BuildProjectOptions {
  outDir: string;
  projectPath: string;
  target?: RuntimeTarget;
  verbose?: boolean;
  workingDirectory: string;
}

export interface BuildProjectArtifacts {
  emittedFiles: string[];
  outDir: string;
  packageJsonPath: string;
}

export interface BuildProjectResult {
  artifacts?: BuildProjectArtifacts;
  diagnostics: MergedDiagnostic[];
  exitCode: number;
  output: string;
}

interface PackageJsonRecord extends Record<string, unknown> {
  bugs?: unknown;
  homepage?: unknown;
  license?: unknown;
  name?: unknown;
  repository?: unknown;
  version?: unknown;
}

interface SoundscriptMetadataRecord extends Record<string, unknown> {
  exports?: unknown;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const recordValue = value as Record<string, unknown>;
  const entries = Object.keys(recordValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(recordValue[key])}`);
  return `{${entries.join(',')}}`;
}

function hashText(text: string): string {
  return ts.sys.createHash?.(text) ?? createHash('sha256').update(text).digest('hex');
}

function createBuildCacheProjectDirectory(projectPath: string): string {
  return resolveCheckerCacheDirectory(projectPath);
}

function createBuildCacheManifestPath(projectPath: string): string {
  return join(createBuildCacheProjectDirectory(projectPath), BUILD_CACHE_MANIFEST_FILE_NAME);
}

function createCheckerCacheManifestPath(projectPath: string): string {
  return join(createBuildCacheProjectDirectory(projectPath), CHECKER_CACHE_MANIFEST_FILE_NAME);
}

function createBuildCacheBuildInfoDirectory(projectPath: string): string {
  return join(
    createBuildCacheProjectDirectory(projectPath),
    CHECKER_CACHE_BUILD_INFO_SUBDIRECTORY,
  );
}

function createBuildPersistentBuildInfoPath(
  projectPath: string,
  kind: 'declarations' | 'semantic',
): string {
  return join(createBuildCacheBuildInfoDirectory(projectPath), `build-package.${kind}.tsbuildinfo`);
}

function createSoundscriptRootDiscoverySignature(
  projectPath: string,
  loadedConfig: ReturnType<typeof loadConfig>,
): string {
  const basePath = dirname(projectPath);
  const rawConfig = loadedConfig.commandLine.raw as {
    exclude?: readonly string[];
    files?: readonly string[];
    include?: readonly string[];
  } | undefined;
  const explicitFiles = (rawConfig?.files ?? [])
    .map((fileName) => fileName.startsWith('/') ? fileName : join(basePath, fileName))
    .map((fileName) => ts.sys.resolvePath(fileName))
    .filter(loadedConfig.isSoundscriptSourceFile)
    .sort()
    .join('\u0000');
  const includePatterns = rawConfig?.include
    ? [...rawConfig.include]
    : rawConfig?.files
    ? []
    : ['**/*'];
  const excludePatterns = rawConfig?.exclude
    ? [...rawConfig.exclude]
    : ['node_modules', 'bower_components', 'jspm_packages', '.git'];

  return [
    basePath,
    explicitFiles,
    includePatterns.join('\u0001'),
    excludePatterns.join('\u0001'),
    (loadedConfig.soundscript.include ?? []).join('\u0001'),
  ].join('\u0002');
}

function createTrackedFileHashes(trackedFilePaths: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(
    trackedFilePaths.map((filePath) => [filePath, hashText(ts.sys.readFile(filePath) ?? '')]),
  );
}

function collectChangedTrackedFilePaths(
  trackedFiles: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.entries(trackedFiles)
    .filter(([filePath, hash]) => hashText(ts.sys.readFile(filePath) ?? '') !== hash)
    .map(([filePath]) => filePath);
}

function createConfigDiagnosticsSignature(
  loadedConfig: ReturnType<typeof loadConfig>,
): string {
  return loadedConfig.diagnostics.map((diagnostic: ts.Diagnostic) =>
    [
      diagnostic.code,
      String(diagnostic.category),
      diagnostic.file?.fileName ?? '',
      diagnostic.start ?? '',
      diagnostic.length ?? '',
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    ].join('\u0001')
  ).join('\u0002');
}

function createBuildCacheHeader(options: BuildProjectOptions): BuildCacheHeader {
  const projectPath = ts.sys.resolvePath(options.projectPath);
  const loadedConfig = loadConfig(projectPath, { target: options.target });
  const rootNames = [
    ...new Set([
      ...loadedConfig.commandLine.fileNames,
      ...collectSoundscriptRootNames(projectPath, loadedConfig),
    ]),
  ].sort();
  return {
    configDiagnosticsSignature: createConfigDiagnosticsSignature(loadedConfig),
    configSignature: stableStringify({
      commandLineOptions: loadedConfig.commandLine.options,
      frontierCommandLineOptions: loadedConfig.frontierCommandLine.options,
      frontierProjectReferences: loadedConfig.frontierCommandLine.projectReferences ?? [],
      projectReferences: loadedConfig.commandLine.projectReferences ?? [],
      raw: loadedConfig.commandLine.raw,
      runtime: loadedConfig.runtime,
    }),
    projectFileHash: hashText(ts.sys.readFile(projectPath) ?? ''),
    projectPath,
    rootNames,
    runtimeTarget: loadedConfig.runtime.target,
    soundscriptRootDiscoverySignature: createSoundscriptRootDiscoverySignature(
      projectPath,
      loadedConfig,
    ),
    targetOverride: options.target,
    toolFingerprint: getSoundscriptToolFingerprint(),
  };
}

function buildCacheHeadersEqual(left: BuildCacheHeader, right: BuildCacheHeader): boolean {
  return left.projectPath === right.projectPath &&
    left.targetOverride === right.targetOverride &&
    left.runtimeTarget === right.runtimeTarget &&
    left.toolFingerprint === right.toolFingerprint &&
    left.projectFileHash === right.projectFileHash &&
    left.configSignature === right.configSignature &&
    left.configDiagnosticsSignature === right.configDiagnosticsSignature &&
    left.soundscriptRootDiscoverySignature === right.soundscriptRootDiscoverySignature &&
    left.rootNames.length === right.rootNames.length &&
    left.rootNames.every((rootName, index) => rootName === right.rootNames[index]);
}

function readBuildCacheManifest(
  manifestPath: string,
): BuildCacheManifest | undefined {
  if (!fileExistsSync(manifestPath)) {
    return undefined;
  }

  try {
    const manifest = JSON.parse(readTextFileSync(manifestPath)) as BuildCacheManifest;
    return manifest.schemaVersion === BUILD_CACHE_SCHEMA_VERSION ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function readCheckerPrepareArtifacts(
  manifestPath: string,
  header: BuildCacheHeader,
): PersistentPreparedAnalysisProjectReuseSnapshots | undefined {
  if (!fileExistsSync(manifestPath)) {
    return undefined;
  }

  try {
    const manifest = JSON.parse(readTextFileSync(manifestPath)) as {
      header?: BuildCacheHeader;
      prepareArtifacts?: PersistentPreparedAnalysisProjectReuseSnapshots;
    };
    return manifest.header && buildCacheHeadersEqual(manifest.header, header)
      ? manifest.prepareArtifacts
      : undefined;
  } catch {
    return undefined;
  }
}

function readBuildCacheResult(
  options: BuildProjectOptions,
  header: BuildCacheHeader,
): BuildCacheReadResult {
  const buildManifest = readBuildCacheManifest(createBuildCacheManifestPath(options.projectPath));
  if (
    buildManifest &&
    buildCacheHeadersEqual(buildManifest.header, header) &&
    collectChangedTrackedFilePaths(buildManifest.trackedFiles).length === 0
  ) {
    return {
      prepareArtifacts: buildManifest.prepareArtifacts,
      status: 'hit',
    };
  }

  const checkerPrepareArtifacts = readCheckerPrepareArtifacts(
    createCheckerCacheManifestPath(options.projectPath),
    header,
  );
  if (checkerPrepareArtifacts) {
    return {
      prepareArtifacts: checkerPrepareArtifacts,
      status: 'checker-fallback',
    };
  }

  return { status: 'miss' };
}

function writeBuildCacheManifest(
  projectPath: string,
  manifest: BuildCacheManifest,
): void {
  const cacheProjectDirectory = createBuildCacheProjectDirectory(projectPath);
  makeDirectorySync(cacheProjectDirectory);
  const manifestPath = createBuildCacheManifestPath(projectPath);
  const temporaryPath = join(
    cacheProjectDirectory,
    `${BUILD_CACHE_MANIFEST_FILE_NAME}.tmp-${process.pid}-${Date.now()}`,
  );
  writeTextFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    renamePathSync(temporaryPath, manifestPath);
  } catch (error) {
    removePathSync(temporaryPath);
    throw error;
  }
}

function mergePersistentPreparedCompilerHostReuseSnapshotEntries<T>(
  ...entryGroups: readonly (readonly (readonly [string, T])[])[]
): readonly (readonly [string, T])[] {
  return [...new Map(entryGroups.flatMap((entries) => entries)).entries()];
}

function mergePersistentPreparedCompilerHostReuseSnapshots(
  base: PersistentPreparedCompilerHostReuseSnapshot,
  overlay: PersistentPreparedCompilerHostReuseSnapshot,
): PersistentPreparedCompilerHostReuseSnapshot {
  return {
    builtinAnnotatedSourceFiles: mergePersistentPreparedCompilerHostReuseSnapshotEntries(
      base.builtinAnnotatedSourceFiles,
      overlay.builtinAnnotatedSourceFiles,
    ),
    builtinFinalSourceFiles: mergePersistentPreparedCompilerHostReuseSnapshotEntries(
      base.builtinFinalSourceFiles,
      overlay.builtinFinalSourceFiles,
    ),
    expandedMacroSourceFiles: mergePersistentPreparedCompilerHostReuseSnapshotEntries(
      base.expandedMacroSourceFiles,
      overlay.expandedMacroSourceFiles,
    ),
    preparedSourceFiles: mergePersistentPreparedCompilerHostReuseSnapshotEntries(
      base.preparedSourceFiles,
      overlay.preparedSourceFiles,
    ),
    projectedDeclarationOptionSignature: overlay.projectedDeclarationOptionSignature ||
      base.projectedDeclarationOptionSignature,
    projectedDeclarationOutputs: overlay.projectedDeclarationOutputs ??
      base.projectedDeclarationOutputs,
    projectedDeclarationRootNamesSignature: overlay.projectedDeclarationRootNamesSignature ||
      base.projectedDeclarationRootNamesSignature,
    projectedDeclarationSourceFiles: mergePersistentPreparedCompilerHostReuseSnapshotEntries(
      base.projectedDeclarationSourceFiles,
      overlay.projectedDeclarationSourceFiles,
    ),
    resolvedModulesByKey: mergePersistentPreparedCompilerHostReuseSnapshotEntries(
      base.resolvedModulesByKey,
      overlay.resolvedModulesByKey,
    ),
    rewrittenSourceFiles: mergePersistentPreparedCompilerHostReuseSnapshotEntries(
      base.rewrittenSourceFiles,
      overlay.rewrittenSourceFiles,
    ),
  };
}

function createPackageBuildReuseState(
  prepareArtifacts: PersistentPreparedAnalysisProjectReuseSnapshots | undefined,
  currentDirectory: string,
) {
  const compilerHostSnapshots = [
    prepareArtifacts?.sts?.compilerHost,
    prepareArtifacts?.ts?.compilerHost,
    prepareArtifacts?.packageSourcePolicy?.compilerHost,
  ].filter((snapshot): snapshot is PersistentPreparedCompilerHostReuseSnapshot =>
    snapshot !== undefined
  );
  if (compilerHostSnapshots.length === 0) {
    return undefined;
  }

  let mergedCompilerHostSnapshot = compilerHostSnapshots[0];
  for (const compilerHostSnapshot of compilerHostSnapshots.slice(1)) {
    mergedCompilerHostSnapshot = mergePersistentPreparedCompilerHostReuseSnapshots(
      mergedCompilerHostSnapshot,
      compilerHostSnapshot,
    );
  }

  const reuseState = hydratePersistentPreparedCompilerHostReuseSnapshot(
    mergedCompilerHostSnapshot,
    currentDirectory,
  );
  const macroEnvironmentSnapshot = prepareArtifacts?.sts?.macroEnvironment ??
    prepareArtifacts?.packageSourcePolicy?.macroEnvironment;
  if (macroEnvironmentSnapshot) {
    hydratePersistentProjectMacroEnvironmentReuseSnapshot(reuseState, macroEnvironmentSnapshot);
  }
  return reuseState;
}

function createMacroDiagnostic(error: MacroError): MergedDiagnostic {
  return {
    source: 'cli',
    code: error.code,
    category: 'error',
    message: error.message,
    filePath: error.filePath,
    line: error.line,
    column: error.column,
    endLine: error.endLine,
    endColumn: error.endColumn,
  };
}

function isPackageLocalSourceFile(fileName: string, packageRoot: string): boolean {
  return fileName.startsWith(`${packageRoot}/`) &&
    !fileName.endsWith('.d.ts') &&
    !fileName.includes('/node_modules/');
}

function toJsRelativePath(relativePath: string): string {
  const extension = extname(relativePath);
  return extension.length > 0
    ? `${relativePath.slice(0, -extension.length)}.js`
    : `${relativePath}.js`;
}

function toDeclarationRelativePath(relativePath: string): string {
  const extension = extname(relativePath);
  return extension.length > 0
    ? `${relativePath.slice(0, -extension.length)}.d.ts`
    : `${relativePath}.d.ts`;
}

function toEntryWrapperRelativePath(exportKey: string): string {
  return exportKey === '.' ? 'index' : exportKey.slice(2);
}

function renderBuildOutput(
  artifacts: BuildProjectArtifacts,
  projectPath: string,
  verbose = false,
): string {
  const artifactBaseDirectory = dirname(projectPath);
  const relativeOutDir = relative(artifactBaseDirectory, artifacts.outDir);
  if (!verbose) {
    return [
      `Built package: ${relativeOutDir} (${artifacts.emittedFiles.length} files)`,
      '',
    ].join('\n');
  }
  const renderedFiles = artifacts.emittedFiles
    .map((filePath) => `  ${relative(artifactBaseDirectory, filePath)}`)
    .join('\n');

  return [
    `Built package: ${relativeOutDir}`,
    renderedFiles,
    '',
  ].join('\n');
}

function findNearestPackageJson(startDirectory: string): string | undefined {
  let currentDirectory = startDirectory;
  while (true) {
    const candidate = join(currentDirectory, 'package.json');
    if (fileExistsSync(candidate)) {
      return candidate;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

async function emptyDirectory(path: string): Promise<void> {
  await removePath(path).catch(() => undefined);
  await makeDirectory(path);
}

async function copyFileIfPresent(sourcePath: string, destinationPath: string): Promise<boolean> {
  if (!fileExistsSync(sourcePath)) {
    return false;
  }

  await makeDirectory(dirname(destinationPath));
  await copyFile(sourcePath, destinationPath);
  return true;
}

function relativeImportSpecifier(fromFilePath: string, toFilePath: string): string {
  const relativePath = relative(dirname(fromFilePath), toFilePath).replaceAll('\\', '/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function relativeTypeImportSpecifier(fromFilePath: string, toDeclarationPath: string): string {
  const specifier = relativeImportSpecifier(fromFilePath, toDeclarationPath);
  return specifier.endsWith('.d.ts') ? specifier.slice(0, -5) : specifier;
}

function moduleHasDefaultExport(program: ts.Program, programFileName: string): boolean {
  const sourceFile = program.getSourceFile(programFileName);
  if (!sourceFile) {
    return false;
  }

  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(sourceFile);
  if (!symbol) {
    return false;
  }

  return checker.getExportsOfModule(symbol).some((exportSymbol) => exportSymbol.name === 'default');
}

function createEntryWrapperText(importSpecifier: string, hasDefaultExport: boolean): string {
  const lines = [`export * from '${importSpecifier}';`];
  if (hasDefaultExport) {
    lines.push(`export { default } from '${importSpecifier}';`);
  }
  lines.push('');
  return lines.join('\n');
}

function createPackageBuildProgramWithLoadedConfig(
  options: BuildProjectOptions,
  loadedConfig: ReturnType<typeof loadConfig>,
  prepareArtifacts?: PersistentPreparedAnalysisProjectReuseSnapshots,
): BuiltinEmitProgram {
  const soundscriptRootNames = collectSoundscriptRootNames(options.projectPath, loadedConfig);
  return createBuiltinEmitProgram({
    baseHost: createSoundStdlibCompilerHost(
      loadedConfig.frontierCommandLine.options,
      dirname(options.projectPath),
    ),
    configFileParsingDiagnostics: getConfigFileParsingDiagnostics(
      loadedConfig.diagnostics,
      soundscriptRootNames,
    ),
    configuredSoundscriptFileNames: loadedConfig.soundscriptConfiguredFileNames,
    options: {
      ...loadedConfig.frontierCommandLine.options,
      declaration: true,
      emitDeclarationOnly: true,
      noEmit: false,
      outDir: DECLARATION_CAPTURE_OUT_DIR,
      sourceMap: true,
    },
    persistentProjectedDeclarationBuildInfoPath: createBuildPersistentBuildInfoPath(
      options.projectPath,
      'declarations',
    ),
    persistentSemanticDiagnosticsBuildInfoPath: createBuildPersistentBuildInfoPath(
      options.projectPath,
      'semantic',
    ),
    projectReferences: loadedConfig.frontierCommandLine.projectReferences,
    reusableCompilerHostState: createPackageBuildReuseState(
      prepareArtifacts,
      dirname(options.projectPath),
    ),
    runtime: loadedConfig.runtime,
    rootNames: [...new Set([...loadedConfig.commandLine.fileNames, ...soundscriptRootNames])],
  });
}

function createPackageBuildProgram(
  options: BuildProjectOptions,
  prepareArtifacts?: PersistentPreparedAnalysisProjectReuseSnapshots,
): {
  readonly builtProgram: BuiltinEmitProgram;
  readonly loadedConfig: ReturnType<typeof loadConfig>;
} {
  const loadedConfig = loadConfig(options.projectPath, { target: options.target });
  return {
    builtProgram: createPackageBuildProgramWithLoadedConfig(options, loadedConfig, prepareArtifacts),
    loadedConfig,
  };
}

async function emitPackageBuildOutputs(
  options: BuildProjectOptions,
  packageJson: PackageJsonRecord,
  packageInfo: SoundScriptPackageInfo,
  builtProgram: BuiltinEmitProgram,
  {
    validateDiagnostics = true,
  }: {
    validateDiagnostics?: boolean;
  } = {},
): Promise<BuildProjectResult> {
  if (validateDiagnostics) {
    const diagnostics: MergedDiagnostic[] = [
      ...builtProgram.frontendDiagnostics(),
      ...ts.getPreEmitDiagnostics(builtProgram.program).map(toMergedDiagnostic),
    ];
    if (hasErrorDiagnostics(diagnostics)) {
      return {
        diagnostics,
        exitCode: 1,
        output: formatDiagnostics(diagnostics, options.workingDirectory),
      };
    }

    try {
      void builtProgram.program.getTypeChecker();
    } catch (error) {
      const merged = error instanceof MacroError ? [createMacroDiagnostic(error)] : [];
      return {
        diagnostics: merged,
        exitCode: 1,
        output: error instanceof MacroError
          ? formatDiagnostics(merged, options.workingDirectory)
          : String(error),
      };
    }
  }

  const emptyOutDirStart = performance.now();
  await emptyDirectory(options.outDir);
  logCheckerTiming(
    'project.build.emptyOutDir',
    performance.now() - emptyOutDirStart,
    {
      outDir: options.outDir,
    },
    { always: true },
  );
  const emittedFiles: string[] = [];
  const typeOutputs = measureCheckerTiming(
    'project.build.captureTypeOutputs',
    {
      projectPath: options.projectPath,
    },
    () => captureTypeScriptDeclarationOutputs(builtProgram.program),
    { always: true },
  );
  const projectedDeclarations = emitProjectedDeclarations(builtProgram.analysisPreparedProgram);
  const packageRoot = packageInfo.packageRoot;

  const esmEmitMetadata: Record<string, number | string> = {
    files: 0,
    soundscriptFiles: 0,
    transpileMs: 0,
    typescriptFiles: 0,
    writeMs: 0,
  };
  const esmEmitStart = performance.now();
  for (const sourceFile of builtProgram.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }

    const sourceFileName = toSourceFileName(sourceFile.fileName);
    if (!isPackageLocalSourceFile(sourceFileName, packageRoot)) {
      continue;
    }

    const relativeSourcePath = relative(packageRoot, sourceFileName).replaceAll('\\', '/');
    const outputJsRelativePath = toJsRelativePath(relativeSourcePath);
    const outputJsPath = join(options.outDir, 'esm', outputJsRelativePath);
    const outputMapPath = `${outputJsPath}.map`;
    const sourceMapComment = `//# sourceMappingURL=${
      relative(dirname(outputJsPath), outputMapPath).replaceAll('\\', '/')
    }`;

    const transpileStart = performance.now();
    const isSoundscriptFile = builtProgram.preparedProgram.isSoundscriptSourceFile(sourceFileName);
    const artifact = isSoundscriptFile
      ? (() => {
        const preparedFile = builtProgram.diagnosticPreparedFiles.get(sourceFileName) ??
          builtProgram.analysisPreparedProgram.preparedHost.getPreparedSourceFile(sourceFileName);
        if (!preparedFile) {
          throw new Error(`Missing prepared source file for ${sourceFileName}.`);
        }
        return transpilePreparedSoundscriptModuleToEsm(
          sourceFileName,
          outputJsPath,
          preparedFile,
          {
            module: ts.ModuleKind.ES2022,
            target: ts.ScriptTarget.ES2022,
            valueProgram: builtProgram.program,
          },
        );
      })()
      : transpileTypeScriptModuleToEsm(
        sourceFileName,
        outputJsPath,
        sourceFile.text,
        {
          module: ts.ModuleKind.ES2022,
          target: ts.ScriptTarget.ES2022,
        },
      );
    esmEmitMetadata.transpileMs = Number(
      ((esmEmitMetadata.transpileMs as number) + (performance.now() - transpileStart)).toFixed(1),
    );
    esmEmitMetadata.files = (esmEmitMetadata.files as number) + 1;
    if (isSoundscriptFile) {
      esmEmitMetadata.soundscriptFiles = (esmEmitMetadata.soundscriptFiles as number) + 1;
    } else {
      esmEmitMetadata.typescriptFiles = (esmEmitMetadata.typescriptFiles as number) + 1;
    }

    const writeStart = performance.now();
    await writeGeneratedFile(
      outputJsPath,
      `${artifact.code}\n${sourceMapComment}\n`,
      emittedFiles,
    );
    await writeGeneratedFile(outputMapPath, artifact.mapText, emittedFiles);
    esmEmitMetadata.writeMs = Number(
      ((esmEmitMetadata.writeMs as number) + (performance.now() - writeStart)).toFixed(1),
    );
  }
  logCheckerTiming(
    'project.build.emitEsmModules',
    performance.now() - esmEmitStart,
    esmEmitMetadata,
    { always: true },
  );

  const projectedDeclarationWriteMetadata: Record<string, number> = {
    declarations: 0,
    rewriteMs: 0,
    writeMs: 0,
  };
  const projectedDeclarationWriteStart = performance.now();
  for (const [sourceFileName, declarationText] of projectedDeclarations.entries()) {
    if (!isPackageLocalSourceFile(sourceFileName, packageRoot)) {
      continue;
    }

    const relativeSourcePath = relative(packageRoot, sourceFileName).replaceAll('\\', '/');
    const declarationPath = join(
      options.outDir,
      'types',
      toDeclarationRelativePath(relativeSourcePath),
    );
    const rewriteStart = performance.now();
    const rewrittenText = rewriteModuleSpecifiersForEmit(declarationText, declarationPath);
    projectedDeclarationWriteMetadata.rewriteMs = Number(
      (projectedDeclarationWriteMetadata.rewriteMs + (performance.now() - rewriteStart)).toFixed(1),
    );
    const writeStart = performance.now();
    await writeGeneratedFile(declarationPath, rewrittenText, emittedFiles);
    projectedDeclarationWriteMetadata.writeMs = Number(
      (projectedDeclarationWriteMetadata.writeMs + (performance.now() - writeStart)).toFixed(1),
    );
    projectedDeclarationWriteMetadata.declarations += 1;
  }
  logCheckerTiming(
    'project.build.writeProjectedDeclarations',
    performance.now() - projectedDeclarationWriteStart,
    projectedDeclarationWriteMetadata,
    { always: true },
  );

  const capturedDeclarationWriteMetadata: Record<string, number> = {
    declarations: 0,
    rewriteMs: 0,
    writeMs: 0,
  };
  const capturedDeclarationWriteStart = performance.now();
  for (const [outputPath, declarationText] of typeOutputs.entries()) {
    if (
      !outputPath.startsWith(`${DECLARATION_CAPTURE_OUT_DIR}/`) ||
      outputPath.endsWith('.sts.d.ts')
    ) {
      continue;
    }

    const relativeOutputPath = relative(DECLARATION_CAPTURE_OUT_DIR, outputPath).replaceAll(
      '\\',
      '/',
    );
    const destinationPath = join(options.outDir, 'types', relativeOutputPath);
    const rewriteStart = performance.now();
    const rewrittenText = rewriteModuleSpecifiersForEmit(declarationText, destinationPath);
    capturedDeclarationWriteMetadata.rewriteMs = Number(
      (capturedDeclarationWriteMetadata.rewriteMs + (performance.now() - rewriteStart)).toFixed(1),
    );
    const writeStart = performance.now();
    await writeGeneratedFile(destinationPath, rewrittenText, emittedFiles);
    capturedDeclarationWriteMetadata.writeMs = Number(
      (capturedDeclarationWriteMetadata.writeMs + (performance.now() - writeStart)).toFixed(1),
    );
    capturedDeclarationWriteMetadata.declarations += 1;
  }
  logCheckerTiming(
    'project.build.writeCapturedTypeOutputs',
    performance.now() - capturedDeclarationWriteStart,
    capturedDeclarationWriteMetadata,
    { always: true },
  );

  const copiedSourceFiles = new Set<string>();
  const copySourcesMetadata: Record<string, number> = {
    copiedFiles: 0,
    copyMs: 0,
  };
  const copySourcesStart = performance.now();
  for (const sourceFile of builtProgram.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }

    const sourceFileName = toSourceFileName(sourceFile.fileName);
    if (
      !isPackageLocalSourceFile(sourceFileName, packageRoot) ||
      copiedSourceFiles.has(sourceFileName)
    ) {
      continue;
    }
    copiedSourceFiles.add(sourceFileName);

    const relativeSourcePath = relative(packageRoot, sourceFileName).replaceAll('\\', '/');
    const destinationPath = join(options.outDir, 'soundscript', relativeSourcePath);
    const copyStart = performance.now();
    await makeDirectory(dirname(destinationPath));
    await copyFile(sourceFileName, destinationPath);
    copySourcesMetadata.copyMs = Number(
      (copySourcesMetadata.copyMs + (performance.now() - copyStart)).toFixed(1),
    );
    copySourcesMetadata.copiedFiles += 1;
    emittedFiles.push(destinationPath);
  }
  logCheckerTiming(
    'project.build.copySources',
    performance.now() - copySourcesStart,
    copySourcesMetadata,
    { always: true },
  );

  const sourceEntries = packageInfo.exports.size > 0
    ? [...packageInfo.exports.entries()]
    : packageInfo.legacySourceEntryPath
    ? [['.', packageInfo.legacySourceEntryPath] as const]
    : [];
  const entryWrapperMetadata: Record<string, number> = {
    wrapperFiles: 0,
    writeMs: 0,
  };
  const entryWrapperStart = performance.now();
  for (const [exportKey, sourceEntryPath] of sourceEntries) {
    const relativeSourcePath = relative(packageRoot, sourceEntryPath).replaceAll('\\', '/');
    const wrapperRelativePath = toEntryWrapperRelativePath(exportKey);
    const sourceJsPath = join(options.outDir, 'esm', toJsRelativePath(relativeSourcePath));
    const wrapperJsPath = join(options.outDir, 'esm', `${wrapperRelativePath}.js`);
    const wrapperTypesPath = join(options.outDir, 'types', `${wrapperRelativePath}.d.ts`);
    const programFileName = isSoundscriptSourceFile(sourceEntryPath)
      ? builtProgram.preparedProgram.toProgramFileName(sourceEntryPath)
      : sourceEntryPath;
    const hasDefaultExport = moduleHasDefaultExport(builtProgram.program, programFileName);
    const jsImportSpecifier = relativeImportSpecifier(wrapperJsPath, sourceJsPath);
    const typesImportSpecifier = relativeTypeImportSpecifier(
      wrapperTypesPath,
      join(options.outDir, 'types', toDeclarationRelativePath(relativeSourcePath)),
    );
    const writeStart = performance.now();
    await writeGeneratedFile(
      wrapperJsPath,
      createEntryWrapperText(jsImportSpecifier, hasDefaultExport),
      emittedFiles,
    );
    await writeGeneratedFile(
      wrapperTypesPath,
      createEntryWrapperText(typesImportSpecifier, hasDefaultExport),
      emittedFiles,
    );
    entryWrapperMetadata.writeMs = Number(
      (entryWrapperMetadata.writeMs + (performance.now() - writeStart)).toFixed(1),
    );
    entryWrapperMetadata.wrapperFiles += 2;
  }
  logCheckerTiming(
    'project.build.writeEntryWrappers',
    performance.now() - entryWrapperStart,
    entryWrapperMetadata,
    { always: true },
  );

  const copyMetadataStart = performance.now();
  await copyFileIfPresent(join(packageRoot, 'README.md'), join(options.outDir, 'README.md'));
  await copyFileIfPresent(join(packageRoot, 'LICENSE'), join(options.outDir, 'LICENSE'));
  logCheckerTiming(
    'project.build.copyMetadataFiles',
    performance.now() - copyMetadataStart,
    {
      projectPath: options.projectPath,
    },
    { always: true },
  );

  const distPackageJson = buildDistPackageJson(packageJson, packageInfo);
  const distPackageJsonPath = join(options.outDir, 'package.json');
  const writePackageJsonStart = performance.now();
  await writeGeneratedFile(
    distPackageJsonPath,
    `${JSON.stringify(distPackageJson, null, 2)}\n`,
    emittedFiles,
  );
  logCheckerTiming(
    'project.build.writePackageJson',
    performance.now() - writePackageJsonStart,
    {
      projectPath: options.projectPath,
    },
    { always: true },
  );

  return {
    artifacts: {
      emittedFiles,
      outDir: options.outDir,
      packageJsonPath: distPackageJsonPath,
    },
    diagnostics: [],
    exitCode: 0,
        output: renderBuildOutput(
          {
            emittedFiles,
            outDir: options.outDir,
            packageJsonPath: distPackageJsonPath,
          },
          options.projectPath,
          options.verbose,
        ),
      };
}

async function writeGeneratedFile(
  filePath: string,
  text: string,
  emittedFiles: string[],
): Promise<void> {
  await makeDirectory(dirname(filePath));
  await writeTextFile(filePath, text);
  emittedFiles.push(filePath);
}

function parsePackageJsonRecord(packageJsonPath: string): PackageJsonRecord {
  return JSON.parse(readTextFileSync(packageJsonPath)) as PackageJsonRecord;
}

function collectInvalidSoundscriptExportDiagnostics(
  packageJsonPath: string,
  packageJson: PackageJsonRecord,
  packageInfo: SoundScriptPackageInfo | undefined,
): MergedDiagnostic[] {
  const soundscript = packageJson.soundscript;
  if (!soundscript || typeof soundscript !== 'object' || Array.isArray(soundscript)) {
    return [];
  }

  const metadata = soundscript as SoundscriptMetadataRecord;
  if (
    !metadata.exports || typeof metadata.exports !== 'object' || Array.isArray(metadata.exports)
  ) {
    return [];
  }

  const diagnostics: MergedDiagnostic[] = [];
  const declaredExports = metadata.exports as Record<string, unknown>;
  for (const [exportKey, rawEntry] of Object.entries(declaredExports)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      diagnostics.push({
        source: 'cli',
        code: 'SOUNDSCRIPT_BUILD_INVALID_EXPORT',
        category: 'error',
        message:
          `soundscript.exports["${exportKey}"] must be an object with a valid "source" path.`,
        hint:
          'Use an object with a `source` field that points at an existing `.sts` file in the published package surface.',
        filePath: packageJsonPath,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
      });
      continue;
    }

    const source = (rawEntry as Record<string, unknown>).source;
    if (typeof source !== 'string' || source.length === 0) {
      diagnostics.push({
        source: 'cli',
        code: 'SOUNDSCRIPT_BUILD_INVALID_EXPORT',
        category: 'error',
        message: `soundscript.exports["${exportKey}"] must provide a string "source" path.`,
        hint:
          'Use an object with a `source` field that points at an existing `.sts` file in the published package surface.',
        filePath: packageJsonPath,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
      });
      continue;
    }

    if (!packageInfo?.exports.has(exportKey)) {
      diagnostics.push({
        source: 'cli',
        code: 'SOUNDSCRIPT_BUILD_INVALID_EXPORT',
        category: 'error',
        message: `soundscript.exports["${exportKey}"] points to a missing source file: ${source}`,
        hint:
          'Point each `soundscript.exports` entry at an existing `.sts` file that belongs to the published package surface.',
        filePath: packageJsonPath,
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 1,
      });
    }
  }

  return diagnostics;
}

function buildDistPackageJson(
  originalPackageJson: PackageJsonRecord,
  packageInfo: SoundScriptPackageInfo,
): Record<string, unknown> {
  const exportsRecord: Record<string, unknown> = {};
  const soundscriptExports: Record<string, unknown> = {};

  for (const [exportKey, sourceEntryPath] of packageInfo.exports.entries()) {
    const relativeSourcePath = relative(packageInfo.packageRoot, sourceEntryPath).replaceAll(
      '\\',
      '/',
    );
    const wrapperRelativePath = toEntryWrapperRelativePath(exportKey);
    exportsRecord[exportKey] = {
      import: `./esm/${wrapperRelativePath}.js`,
      types: `./types/${wrapperRelativePath}.d.ts`,
    };
    soundscriptExports[exportKey] = {
      source: `./soundscript/${relativeSourcePath}`,
    };
  }

  if (packageInfo.legacySourceEntryPath && !packageInfo.exports.has('.')) {
    const relativeSourcePath = relative(packageInfo.packageRoot, packageInfo.legacySourceEntryPath)
      .replaceAll('\\', '/');
    exportsRecord['.'] = {
      import: './esm/index.js',
      types: './types/index.d.ts',
    };
    soundscriptExports['.'] = {
      source: `./soundscript/${relativeSourcePath}`,
    };
  }

  const files = ['esm/**', 'types/**', 'soundscript/**'];
  if (fileExistsSync(join(dirname(packageInfo.packageJsonPath), 'README.md'))) {
    files.unshift('README.md');
  }
  if (fileExistsSync(join(dirname(packageInfo.packageJsonPath), 'LICENSE'))) {
    files.unshift('LICENSE');
  }

  return {
    ...(typeof originalPackageJson.name === 'string' ? { name: originalPackageJson.name } : {}),
    ...(typeof originalPackageJson.version === 'string'
      ? { version: originalPackageJson.version }
      : {}),
    ...(typeof originalPackageJson.license === 'string'
      ? { license: originalPackageJson.license }
      : {}),
    type: 'module',
    ...(typeof originalPackageJson.repository === 'object'
      ? { repository: originalPackageJson.repository }
      : {}),
    ...(typeof originalPackageJson.homepage === 'string'
      ? { homepage: originalPackageJson.homepage }
      : {}),
    ...(typeof originalPackageJson.bugs === 'object' ? { bugs: originalPackageJson.bugs } : {}),
    ...(exportsRecord['.'] ? { types: './types/index.d.ts' } : {}),
    exports: exportsRecord,
    files,
    ...(packageInfo.name === SOUNDSCRIPT_RUNTIME_PACKAGE_NAME ? {} : packageInfo.toolchain
      ? {
        peerDependencies: {
          [SOUNDSCRIPT_RUNTIME_PACKAGE_NAME]: packageInfo.toolchain,
        },
      }
      : {}),
    soundscript: {
      ...(packageInfo.version !== undefined ? { version: packageInfo.version } : {}),
      ...(packageInfo.toolchain ? { toolchain: packageInfo.toolchain } : {}),
      exports: soundscriptExports,
    },
  };
}

export async function buildProject(options: BuildProjectOptions): Promise<BuildProjectResult> {
  const packageJsonPath = findNearestPackageJson(dirname(options.projectPath));
  if (!packageJsonPath) {
    const diagnostics: MergedDiagnostic[] = [{
      source: 'cli',
      code: 'SOUNDSCRIPT_BUILD_NO_PACKAGE_JSON',
      category: 'error',
      message: 'Could not find a package.json for soundscript build.',
      hint:
        'Add a package.json in the package root before running `soundscript build`, or use `soundscript check` for local app-only workflows.',
      filePath: options.projectPath,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
    }];
    return {
      diagnostics,
      exitCode: 1,
      output: formatDiagnostics(diagnostics, options.workingDirectory),
    };
  }

  const packageJson = parsePackageJsonRecord(packageJsonPath);
  const packageInfo = loadSoundScriptPackageInfo(packageJsonPath, ts.sys);
  const invalidExportDiagnostics = collectInvalidSoundscriptExportDiagnostics(
    packageJsonPath,
    packageJson,
    packageInfo,
  );
  if (invalidExportDiagnostics.length > 0) {
    return {
      diagnostics: invalidExportDiagnostics,
      exitCode: 1,
      output: formatDiagnostics(invalidExportDiagnostics, options.workingDirectory),
    };
  }
  if (!packageInfo || (packageInfo.exports.size === 0 && !packageInfo.legacySourceEntryPath)) {
    const diagnostics: MergedDiagnostic[] = [{
      source: 'cli',
      code: 'SOUNDSCRIPT_BUILD_NO_EXPORTS',
      category: 'error',
      message: 'package.json is missing soundscript.exports metadata for soundscript build.',
      hint:
        'Add `package.json#soundscript.exports` entries for the published `.sts` surface, or use `soundscript check` / runtime wrappers for local app workflows.',
      filePath: packageJsonPath,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
    }];
    return {
      diagnostics,
      exitCode: 1,
      output: formatDiagnostics(diagnostics, options.workingDirectory),
    };
  }

  const buildCacheProjectDirectory = createBuildCacheProjectDirectory(options.projectPath);
  const buildCacheHeader = measureCheckerTiming(
    'project.build.cache.preflight',
    {
      cacheDir: buildCacheProjectDirectory,
      projectPath: options.projectPath,
    },
    () => createBuildCacheHeader(options),
    { always: true },
  );
  const buildCacheReadMetadata: Record<string, string> = {
    cacheDir: buildCacheProjectDirectory,
    projectPath: options.projectPath,
    status: 'miss',
  };
  const buildCacheReadResult = measureCheckerTiming(
    'project.build.cache.read',
    buildCacheReadMetadata,
    () => {
      const result = readBuildCacheResult(options, buildCacheHeader);
      buildCacheReadMetadata.status = result.status;
      return result;
    },
    { always: true },
  );
  if (buildCacheReadResult.status === 'hit') {
    const { builtProgram } = createPackageBuildProgram(options, buildCacheReadResult.prepareArtifacts);
    try {
      return await emitPackageBuildOutputs(options, packageJson, packageInfo, builtProgram, {
        validateDiagnostics: false,
      });
    } finally {
      builtProgram.dispose();
    }
  }
  if (buildCacheReadResult.status === 'miss') {
    const { builtProgram, loadedConfig } = createPackageBuildProgram(options);
    const preparedProject = createPreparedAnalysisProjectFromBuiltinExpandedProgram(
      {
        projectPath: options.projectPath,
        target: options.target,
        workingDirectory: options.workingDirectory,
      },
      loadedConfig,
      builtProgram,
    );
    try {
      const analysis = measureCheckerTiming(
        'project.build.analysis',
        {
          cache: 'persistent',
          path: 'shared-built-program',
          projectPath: options.projectPath,
        },
        () => analyzePreparedProjectWithArtifacts(preparedProject),
        { always: true },
      );
      if (hasErrorDiagnostics(analysis.result.diagnostics)) {
        return {
          diagnostics: analysis.result.diagnostics,
          exitCode: 1,
          output: formatDiagnostics(analysis.result.diagnostics, options.workingDirectory),
        };
      }

      const preparedProjectReuseSnapshots = measureCheckerTiming(
        'project.build.cache.prepareArtifacts',
        {
          projectPath: options.projectPath,
        },
        () => capturePersistentPreparedAnalysisProjectReuseSnapshots(preparedProject),
        { always: true },
      );
      const trackedFiles = measureCheckerTiming(
        'project.build.cache.trackedFiles',
        {
          projectPath: options.projectPath,
        },
        () => createTrackedFileHashes(collectPreparedAnalysisProjectTrackedFilePaths(preparedProject)),
        { always: true },
      );
      try {
        measureCheckerTiming(
          'project.build.cache.write',
          {
            cacheDir: buildCacheProjectDirectory,
            projectPath: options.projectPath,
          },
          () =>
            writeBuildCacheManifest(options.projectPath, {
              cachedAt: new Date().toISOString(),
              header: buildCacheHeader,
              prepareArtifacts: preparedProjectReuseSnapshots,
              schemaVersion: BUILD_CACHE_SCHEMA_VERSION,
              trackedFiles,
            }),
          { always: true },
        );
      } catch {
        // Build cache write failures must not change build behavior.
      }
      writePreparedProjectToPersistentCheckerCache(
        {
          projectPath: options.projectPath,
          target: options.target,
          workingDirectory: options.workingDirectory,
        },
        preparedProject,
        analysis,
        preparedProjectReuseSnapshots,
      );
      return await emitPackageBuildOutputs(options, packageJson, packageInfo, builtProgram, {
        validateDiagnostics: false,
      });
    } finally {
      disposePreparedAnalysisProject(preparedProject);
    }
  }

  const analysis = measureCheckerTiming(
    'project.build.analysis',
    {
      cache: 'persistent',
      projectPath: options.projectPath,
    },
    () =>
      analyzeProjectWithPersistentCacheForReuse({
        projectPath: options.projectPath,
        target: options.target,
        workingDirectory: options.workingDirectory,
      }),
    { always: true },
  );
  if (hasErrorDiagnostics(analysis.result.diagnostics)) {
    return {
      diagnostics: analysis.result.diagnostics,
      exitCode: 1,
      output: formatDiagnostics(analysis.result.diagnostics, options.workingDirectory),
    };
  }
  const preparedProject = prepareProjectAnalysis(
    {
      projectPath: options.projectPath,
      target: options.target,
      workingDirectory: options.workingDirectory,
    },
    undefined,
    {
      persistentBuildInfoDirectory: createBuildCacheBuildInfoDirectory(options.projectPath),
      persistentReuseSnapshots: buildCacheReadResult.prepareArtifacts ?? analysis.prepareArtifacts,
    },
  );
  try {
    const preparedProjectReuseSnapshots = measureCheckerTiming(
      'project.build.cache.prepareArtifacts',
      {
        projectPath: options.projectPath,
      },
      () => capturePersistentPreparedAnalysisProjectReuseSnapshots(preparedProject),
      { always: true },
    );
    const trackedFiles = measureCheckerTiming(
      'project.build.cache.trackedFiles',
      {
        projectPath: options.projectPath,
      },
      () => createTrackedFileHashes(collectPreparedAnalysisProjectTrackedFilePaths(preparedProject)),
      { always: true },
    );
    try {
      measureCheckerTiming(
        'project.build.cache.write',
        {
          cacheDir: buildCacheProjectDirectory,
          projectPath: options.projectPath,
        },
        () =>
          writeBuildCacheManifest(options.projectPath, {
            cachedAt: new Date().toISOString(),
            header: buildCacheHeader,
            prepareArtifacts: preparedProjectReuseSnapshots,
            schemaVersion: BUILD_CACHE_SCHEMA_VERSION,
            trackedFiles,
          }),
        { always: true },
      );
    } catch {
      // Build cache write failures must not change build behavior.
    }

    const { builtProgram } = createPackageBuildProgram(options, preparedProjectReuseSnapshots);
    try {
      return await emitPackageBuildOutputs(options, packageJson, packageInfo, builtProgram);
    } finally {
      builtProgram.dispose();
    }
  } finally {
    disposePreparedAnalysisProject(preparedProject);
  }
}
