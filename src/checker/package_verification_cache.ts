import { createHash } from 'node:crypto';
import ts from 'typescript';

import { getSoundscriptToolFingerprint } from '../version.ts';
import type { RuntimeTarget } from '../project/config.ts';
import {
  findNearestPackageJsonPath,
  getSoundScriptPackageInfoForResolvedModule,
  resolveSoundScriptAwareModule,
  type SoundScriptPackageInfo,
} from '../project/soundscript_packages.ts';
import { isSoundscriptSourceFile } from '../project/soundscript_files.ts';
import { dirname, isAbsolute, join, relative } from '../platform/path.ts';
import {
  makeDirectorySync,
  pathExistsSync,
  readTextFileSync,
  removePathSync,
  renamePathSync,
  writeTextFileSync,
} from '../platform/host.ts';
import { type MergedDiagnostic, remapDiagnosticFilePaths } from './diagnostics.ts';
import { measureCheckerTiming } from './timing.ts';
import type { PreparedAnalysisProjectFileMetadata } from './analyze_project.ts';
import type { AnalyzeProjectResult } from '../service/types.ts';
import type { FileDiagnosticRuleCacheEntry } from './rules/index.ts';
import type { FlowFileRuleCache } from './rules/flow.ts';

const PACKAGE_VERIFICATION_CACHE_SCHEMA_VERSION = 3;
const PACKAGE_VERIFICATION_CACHE_SUBDIRECTORY = 'package-verification';
const UNDEFINED_JSON_SENTINEL_KEY = '__soundscriptUndefined';
const undefinedJsonSentinel = { [UNDEFINED_JSON_SENTINEL_KEY]: true } as const;

export interface CachedPackageSourceFileAnalysis extends PreparedAnalysisProjectFileMetadata {
  effectCache?: FileDiagnosticRuleCacheEntry;
  flowCache?: FlowFileRuleCache;
  relationCache?: FileDiagnosticRuleCacheEntry;
  result: AnalyzeProjectResult;
  valueTypeCache?: FileDiagnosticRuleCacheEntry;
}

export interface VerifiedPackageBoundarySummary {
  cacheId: string;
  dependencyDependents: Readonly<Record<string, readonly string[]>>;
  dependencySignatures: Readonly<Record<string, string>>;
  files: readonly CachedPackageSourceFileAnalysis[];
  projectedDeclarations: ReadonlyMap<string, string>;
  sourceSurfaceSignatures: Readonly<Record<string, string>>;
  trackedFilePaths: readonly string[];
  unownedDiagnostics: readonly MergedDiagnostic[];
}

export interface PackageVerificationUnit {
  cacheId: string;
  cachePath: string;
  compilerOptionsSignature: string;
  packageJsonPath: string;
  packageName: string;
  packageRoot: string;
  rootNames: readonly string[];
  sourceFilePaths: readonly string[];
  sourceSignatures: Readonly<Record<string, string>>;
  supportFilePaths: readonly string[];
  supportSignatures: Readonly<Record<string, string>>;
  target: RuntimeTarget;
}

export interface PackageVerificationCacheProbeResult {
  hits: readonly VerifiedPackageBoundarySummary[];
  misses: readonly PackageVerificationUnit[];
  projectedDeclarationOverrides: ReadonlyMap<string, string>;
  units: readonly PackageVerificationUnit[];
}

interface PackageVerificationCacheManifest {
  cachedAt: string;
  cacheId: string;
  compilerOptionsSignature: string;
  dependencyDependents: Readonly<Record<string, readonly string[]>>;
  dependencyPackages: readonly PackageVerificationDependencySummary[];
  dependencySignatures: Readonly<Record<string, string>>;
  files: readonly SerializedCachedPackageSourceFileAnalysis[];
  packageJsonHash: string;
  packageName: string;
  projectedDeclarations: Readonly<Record<string, string>>;
  rootNames: readonly string[];
  schemaVersion: number;
  sourceFilePaths: readonly string[];
  sourceSignatures: Readonly<Record<string, string>>;
  sourceSurfaceSignatures: Readonly<Record<string, string>>;
  supportFilePaths: readonly string[];
  supportSignatures: Readonly<Record<string, string>>;
  target: RuntimeTarget;
  toolFingerprint: string;
  trackedFilePaths: readonly string[];
  trackedFileSignatures: Readonly<Record<string, string>>;
  unownedDiagnostics: readonly MergedDiagnostic[];
}

interface PackageVerificationDependencySummary {
  cacheId: string;
  packageName: string;
}

interface SerializedCachedPackageSourceFileAnalysis extends
  Omit<
    CachedPackageSourceFileAnalysis,
    'cacheDependencyPaths' | 'diagnosticPaths' | 'directDependencyPaths' | 'filePath'
  > {
  cacheDependencyPaths: readonly string[];
  diagnosticPaths: readonly string[];
  directDependencyPaths: readonly string[];
  filePath: string;
}

interface CollectPackageVerificationUnitsOptions {
  compilerOptions: ts.CompilerOptions;
  configuredSoundscriptFileNames: ReadonlySet<string>;
  localFrontierRootNames: readonly string[];
  projectPackageJsonPath: string | undefined;
  projectPath: string;
  target: RuntimeTarget;
}

function hashText(text: string): string {
  return ts.sys.createHash?.(text) ?? createHash('sha256').update(text).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }

  const recordValue = value as Record<string, unknown>;
  return `{${
    Object.keys(recordValue).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(recordValue[key])}`
    ).join(',')
  }}`;
}

function normalizePath(fileName: string): string {
  const resolved = ts.sys.resolvePath(fileName);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

function isPathWithin(root: string, fileName: string): boolean {
  const normalizedRoot = normalizePath(root).replaceAll('\\', '/');
  const normalizedFileName = normalizePath(fileName).replaceAll('\\', '/');
  return normalizedFileName === normalizedRoot ||
    normalizedFileName.startsWith(`${normalizedRoot}/`);
}

function isInstalledSoundscriptStdlibSource(fileName: string): boolean {
  const normalized = ts.sys.resolvePath(fileName).replaceAll('\\', '/');
  return normalized.includes('/node_modules/@soundscript/soundscript/soundscript/') &&
    normalized.endsWith('.sts');
}

function isMacroAuthoringSourcePath(fileName: string): boolean {
  return fileName.endsWith('.macro.sts');
}

function isSourcePublishedPackageFile(
  fileName: string,
  projectPackageJsonPath: string | undefined,
): { packageInfo: SoundScriptPackageInfo; sourceFilePath: string } | null {
  const sourceFilePath = ts.sys.resolvePath(fileName);
  if (
    !isSoundscriptSourceFile(sourceFilePath) || isInstalledSoundscriptStdlibSource(sourceFilePath)
  ) {
    return null;
  }

  const packageInfo = getSoundScriptPackageInfoForResolvedModule(sourceFilePath, ts.sys);
  if (!packageInfo) {
    return null;
  }

  const packageJsonPath = ts.sys.resolvePath(packageInfo.packageJsonPath);
  if (
    projectPackageJsonPath !== undefined &&
    normalizePath(packageJsonPath) === normalizePath(projectPackageJsonPath)
  ) {
    return null;
  }

  return {
    packageInfo,
    sourceFilePath,
  };
}

function collectStaticModuleSpecifiers(fileName: string): readonly string[] {
  const text = ts.sys.readFile(fileName);
  if (!text) {
    return [];
  }

  const moduleSpecifiers = new Set(
    ts.preProcessFile(text, true, true).importedFiles.map((entry) => entry.fileName),
  );
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      moduleSpecifiers.add(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      moduleSpecifiers.add(node.moduleReference.expression.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      moduleSpecifiers.add(node.argument.literal.text);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return [...moduleSpecifiers].sort();
}

function createCompilerOptionsSignature(compilerOptions: ts.CompilerOptions): string {
  return hashText(stableStringify(compilerOptions));
}

function createSourceSignatures(
  packageRoot: string,
  sourceFilePaths: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    sourceFilePaths.map((filePath) => {
      const relativePath = relative(packageRoot, filePath).replaceAll('\\', '/');
      return [relativePath, hashText(ts.sys.readFile(filePath) ?? '')] as const;
    }).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function createTrackedFileSignatures(
  packageRoot: string,
  trackedFilePaths: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    trackedFilePaths.filter((filePath) => isPathWithin(packageRoot, filePath)).map((filePath) => {
      const key = toPackageRelativePath(packageRoot, filePath);
      return [key, hashText(ts.sys.readFile(filePath) ?? '')] as const;
    }).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function createPackageVerificationCacheId(unit: {
  compilerOptionsSignature: string;
  packageJsonHash: string;
  packageName: string;
  rootNames: readonly string[];
  sourceSignatures: Readonly<Record<string, string>>;
  supportSignatures: Readonly<Record<string, string>>;
  target: RuntimeTarget;
}): string {
  return hashText(stableStringify({
    compilerOptionsSignature: unit.compilerOptionsSignature,
    packageJsonHash: unit.packageJsonHash,
    packageName: unit.packageName,
    rootNames: unit.rootNames,
    schemaVersion: PACKAGE_VERIFICATION_CACHE_SCHEMA_VERSION,
    sourceSignatures: unit.sourceSignatures,
    supportSignatures: unit.supportSignatures,
    target: unit.target,
    toolFingerprint: getSoundscriptToolFingerprint(),
  }));
}

function defaultPackageVerificationCacheRoot(projectPath: string): string {
  const xdgCacheHome = Deno.env.get('XDG_CACHE_HOME');
  if (xdgCacheHome) {
    return join(xdgCacheHome, 'soundscript', PACKAGE_VERIFICATION_CACHE_SUBDIRECTORY);
  }

  const home = Deno.env.get('HOME') ?? Deno.env.get('USERPROFILE');
  if (home) {
    return join(home, '.cache', 'soundscript', PACKAGE_VERIFICATION_CACHE_SUBDIRECTORY);
  }

  return join(dirname(projectPath), '.soundscript-cache', PACKAGE_VERIFICATION_CACHE_SUBDIRECTORY);
}

export function resolvePackageVerificationCacheDirectory(
  projectPath: string,
  cacheDir?: string,
): string {
  return cacheDir
    ? join(cacheDir, PACKAGE_VERIFICATION_CACHE_SUBDIRECTORY)
    : defaultPackageVerificationCacheRoot(projectPath);
}

function toManifestPath(cacheRoot: string, cacheId: string): string {
  return join(cacheRoot, cacheId, 'manifest.json');
}

function toPackageRelativePath(packageRoot: string, fileName: string): string {
  return relative(packageRoot, fileName).replaceAll('\\', '/');
}

function toPackageAbsolutePath(packageRoot: string, fileName: string): string {
  return join(packageRoot, fileName);
}

function remapPackageFilePaths(
  diagnostic: MergedDiagnostic,
  packageRoot: string,
  mode: 'absolute-to-relative' | 'relative-to-absolute',
): MergedDiagnostic {
  return remapDiagnosticFilePaths(diagnostic, (filePath) => {
    if (mode === 'absolute-to-relative') {
      return isPathWithin(packageRoot, filePath)
        ? toPackageRelativePath(packageRoot, filePath)
        : filePath;
    }

    return !isAbsolute(filePath) ? toPackageAbsolutePath(packageRoot, filePath) : filePath;
  });
}

function relativizePaths(packageRoot: string, paths: readonly string[]): readonly string[] {
  return paths.map((filePath) =>
    isPathWithin(packageRoot, filePath) ? toPackageRelativePath(packageRoot, filePath) : filePath
  );
}

function absolutizePaths(packageRoot: string, paths: readonly string[]): readonly string[] {
  return paths.map((filePath) =>
    !isAbsolute(filePath) ? toPackageAbsolutePath(packageRoot, filePath) : filePath
  );
}

function relativizeRecordKeys<T>(
  packageRoot: string,
  record: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
  return Object.fromEntries(
    Object.entries(record).map(([filePath, value]) =>
      [
        isPathWithin(packageRoot, filePath)
          ? toPackageRelativePath(packageRoot, filePath)
          : filePath,
        value,
      ] as const
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function absolutizeRecordKeys<T>(
  packageRoot: string,
  record: Readonly<Record<string, T>>,
): Readonly<Record<string, T>> {
  return Object.fromEntries(
    Object.entries(record).map(([filePath, value]) =>
      [
        !isAbsolute(filePath) ? toPackageAbsolutePath(packageRoot, filePath) : filePath,
        value,
      ] as const
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function relativizeStringArrayRecord(
  packageRoot: string,
  record: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    Object.entries(record).map(([filePath, values]) =>
      [
        isPathWithin(packageRoot, filePath)
          ? toPackageRelativePath(packageRoot, filePath)
          : filePath,
        relativizePaths(packageRoot, values),
      ] as const
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function absolutizeStringArrayRecord(
  packageRoot: string,
  record: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(
    Object.entries(record).map(([filePath, values]) =>
      [
        !isAbsolute(filePath) ? toPackageAbsolutePath(packageRoot, filePath) : filePath,
        absolutizePaths(packageRoot, values),
      ] as const
    ).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function collectPackageVerificationUnits(
  cacheRoot: string,
  options: CollectPackageVerificationUnitsOptions,
): readonly PackageVerificationUnit[] {
  const packageProjectJsonPath = options.projectPackageJsonPath
    ? ts.sys.resolvePath(options.projectPackageJsonPath)
    : undefined;
  const packageSourceFilesByRoot = new Map<string, Set<string>>();
  const packageSupportFilesByRoot = new Map<string, Set<string>>();
  const packageInfoByRoot = new Map<string, SoundScriptPackageInfo>();
  const visitedFiles = new Set<string>();

  const visitFile = (fileName: string, includeAsPackageSource: boolean): void => {
    const normalizedFileName = ts.sys.resolvePath(fileName);
    const visitKey = `${includeAsPackageSource ? 'pkg' : 'local'}:${
      normalizePath(normalizedFileName)
    }`;
    if (visitedFiles.has(visitKey)) {
      return;
    }
    visitedFiles.add(visitKey);

    const packageSource = isSourcePublishedPackageFile(
      normalizedFileName,
      packageProjectJsonPath,
    );
    if (includeAsPackageSource && packageSource) {
      const packageRoot = ts.sys.resolvePath(packageSource.packageInfo.packageRoot);
      const files = packageSourceFilesByRoot.get(packageRoot) ?? new Set<string>();
      files.add(packageSource.sourceFilePath);
      packageSourceFilesByRoot.set(packageRoot, files);
      packageInfoByRoot.set(packageRoot, packageSource.packageInfo);
    }

    for (const moduleSpecifier of collectStaticModuleSpecifiers(normalizedFileName)) {
      const resolvedModule = resolveSoundScriptAwareModule(
        moduleSpecifier,
        normalizedFileName,
        options.compilerOptions,
        ts.sys,
      );
      if (!resolvedModule) {
        continue;
      }

      const resolvedSourcePath = ts.sys.resolvePath(resolvedModule.resolvedFileName);
      const resolvedPackageSource = isSourcePublishedPackageFile(
        resolvedSourcePath,
        packageProjectJsonPath,
      );
      if (!resolvedPackageSource) {
        if (includeAsPackageSource && packageSource) {
          const packageRoot = ts.sys.resolvePath(packageSource.packageInfo.packageRoot);
          if (
            isPathWithin(packageRoot, resolvedSourcePath) && ts.sys.fileExists(resolvedSourcePath)
          ) {
            const supportFiles = packageSupportFilesByRoot.get(packageRoot) ?? new Set<string>();
            supportFiles.add(resolvedSourcePath);
            packageSupportFilesByRoot.set(packageRoot, supportFiles);
          }
        }
        continue;
      }

      visitFile(resolvedPackageSource.sourceFilePath, true);
    }
  };

  for (const rootName of options.localFrontierRootNames) {
    if (!ts.sys.fileExists(rootName)) {
      continue;
    }
    if (
      !options.configuredSoundscriptFileNames.has(rootName) && !isSoundscriptSourceFile(rootName)
    ) {
      continue;
    }
    visitFile(rootName, false);
  }

  const compilerOptionsSignature = createCompilerOptionsSignature(options.compilerOptions);
  const units: PackageVerificationUnit[] = [];
  for (const [packageRoot, sourceFiles] of packageSourceFilesByRoot) {
    const packageInfo = packageInfoByRoot.get(packageRoot);
    if (!packageInfo) {
      continue;
    }
    const sourceFilePaths = [...sourceFiles].sort();
    const supportFilePaths = [...(packageSupportFilesByRoot.get(packageRoot) ?? [])].sort();
    const sourceSignatures = createSourceSignatures(packageRoot, sourceFilePaths);
    const supportSignatures = createSourceSignatures(packageRoot, supportFilePaths);
    const packageJsonHash = hashText(ts.sys.readFile(packageInfo.packageJsonPath) ?? '');
    const rootNames = sourceFilePaths
      .filter((filePath) => {
        const relativePath = toPackageRelativePath(packageRoot, filePath);
        return [...packageInfo.exports.values(), packageInfo.legacySourceEntryPath]
          .filter((value): value is string => value !== undefined)
          .some((entryPath) => toPackageRelativePath(packageRoot, entryPath) === relativePath);
      })
      .map((filePath) => toPackageRelativePath(packageRoot, filePath))
      .sort();
    const cacheId = createPackageVerificationCacheId({
      compilerOptionsSignature,
      packageJsonHash,
      packageName: packageInfo.name,
      rootNames,
      sourceSignatures,
      supportSignatures,
      target: options.target,
    });
    units.push({
      cacheId,
      cachePath: toManifestPath(cacheRoot, cacheId),
      compilerOptionsSignature,
      packageJsonPath: ts.sys.resolvePath(packageInfo.packageJsonPath),
      packageName: packageInfo.name,
      packageRoot,
      rootNames: rootNames.map((filePath) => toPackageAbsolutePath(packageRoot, filePath)),
      sourceFilePaths,
      sourceSignatures,
      supportFilePaths,
      supportSignatures,
      target: options.target,
    });
  }

  return units.sort((left, right) => left.cacheId.localeCompare(right.cacheId));
}

function findPackageVerificationUnitForFilePath(
  units: readonly PackageVerificationUnit[],
  filePath: string,
): PackageVerificationUnit | undefined {
  return units.find((unit) => isPathWithin(unit.packageRoot, filePath));
}

function toPackageDependencySummary(
  unit: PackageVerificationUnit,
): PackageVerificationDependencySummary {
  return {
    cacheId: unit.cacheId,
    packageName: unit.packageName,
  };
}

function sortDependencySummaries(
  summaries: Iterable<PackageVerificationDependencySummary>,
): readonly PackageVerificationDependencySummary[] {
  return [...summaries].sort((left, right) =>
    left.packageName.localeCompare(right.packageName) || left.cacheId.localeCompare(right.cacheId)
  );
}

function mergeDependencySummaries(
  ...summaryGroups: readonly (readonly PackageVerificationDependencySummary[])[]
): readonly PackageVerificationDependencySummary[] {
  const summaries = new Map<string, PackageVerificationDependencySummary>();
  for (const summary of summaryGroups.flat()) {
    summaries.set(`${summary.packageName}\0${summary.cacheId}`, summary);
  }
  return sortDependencySummaries(summaries.values());
}

function collectStaticDependencyPackageSummaries(
  unit: PackageVerificationUnit,
  allUnits: readonly PackageVerificationUnit[],
  compilerOptions: ts.CompilerOptions,
): readonly PackageVerificationDependencySummary[] {
  const dependencySummaries = new Map<string, PackageVerificationDependencySummary>();
  for (const sourceFilePath of unit.sourceFilePaths) {
    for (const moduleSpecifier of collectStaticModuleSpecifiers(sourceFilePath)) {
      const resolvedModule = resolveSoundScriptAwareModule(
        moduleSpecifier,
        sourceFilePath,
        compilerOptions,
        ts.sys,
      );
      if (!resolvedModule) {
        continue;
      }

      const resolvedPath = ts.sys.resolvePath(resolvedModule.resolvedFileName);
      if (isPathWithin(unit.packageRoot, resolvedPath)) {
        continue;
      }

      const dependencyUnit = findPackageVerificationUnitForFilePath(allUnits, resolvedPath);
      if (!dependencyUnit) {
        continue;
      }
      const summary = toPackageDependencySummary(dependencyUnit);
      dependencySummaries.set(`${summary.packageName}\0${summary.cacheId}`, summary);
    }
  }

  return sortDependencySummaries(dependencySummaries.values());
}

function collectTrackedDependencyPackageSummaries(
  unit: PackageVerificationUnit,
  allUnits: readonly PackageVerificationUnit[],
  trackedFilePaths: readonly string[],
): {
  dependencyPackages: readonly PackageVerificationDependencySummary[];
  unsupportedExternalTrackedFilePaths: readonly string[];
} {
  const dependencySummaries = new Map<string, PackageVerificationDependencySummary>();
  const unsupportedExternalTrackedFilePaths = new Set<string>();
  for (const trackedFilePath of trackedFilePaths) {
    if (isPathWithin(unit.packageRoot, trackedFilePath)) {
      continue;
    }

    const dependencyUnit = findPackageVerificationUnitForFilePath(allUnits, trackedFilePath);
    if (!dependencyUnit) {
      unsupportedExternalTrackedFilePaths.add(trackedFilePath);
      continue;
    }

    const summary = toPackageDependencySummary(dependencyUnit);
    dependencySummaries.set(`${summary.packageName}\0${summary.cacheId}`, summary);
  }

  return {
    dependencyPackages: sortDependencySummaries(dependencySummaries.values()),
    unsupportedExternalTrackedFilePaths: [...unsupportedExternalTrackedFilePaths].sort(),
  };
}

function readPackageVerificationManifest(
  unit: PackageVerificationUnit,
  allUnits: readonly PackageVerificationUnit[],
  compilerOptions: ts.CompilerOptions,
): PackageVerificationCacheManifest | null {
  if (!pathExistsSync(unit.cachePath)) {
    return null;
  }

  try {
    const manifest = restoreUndefinedJsonValues(
      JSON.parse(readTextFileSync(unit.cachePath)),
    ) as PackageVerificationCacheManifest;
    if (
      manifest.schemaVersion !== PACKAGE_VERIFICATION_CACHE_SCHEMA_VERSION ||
      manifest.cacheId !== unit.cacheId ||
      manifest.compilerOptionsSignature !== unit.compilerOptionsSignature ||
      manifest.packageName !== unit.packageName ||
      manifest.target !== unit.target ||
      manifest.toolFingerprint !== getSoundscriptToolFingerprint() ||
      stableStringify(manifest.dependencyPackages) !==
        stableStringify(collectStaticDependencyPackageSummaries(unit, allUnits, compilerOptions)) ||
      stableStringify(manifest.sourceSignatures) !== stableStringify(unit.sourceSignatures) ||
      stableStringify(manifest.supportSignatures ?? {}) !==
        stableStringify(unit.supportSignatures) ||
      stableStringify(manifest.trackedFileSignatures ?? {}) !==
        stableStringify(createTrackedFileSignatures(
          unit.packageRoot,
          absolutizePaths(unit.packageRoot, manifest.trackedFilePaths),
        ))
    ) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

function replaceUndefinedJsonValues(value: unknown): unknown {
  if (value === undefined) {
    return undefinedJsonSentinel;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceUndefinedJsonValues(entry));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      replaceUndefinedJsonValues(entryValue),
    ]),
  );
}

function restoreUndefinedJsonValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => restoreUndefinedJsonValues(entry));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const recordValue = value as Record<string, unknown>;
  if (
    Object.keys(recordValue).length === 1 &&
    recordValue[UNDEFINED_JSON_SENTINEL_KEY] === true
  ) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(recordValue).map(([key, entryValue]) => [
      key,
      restoreUndefinedJsonValues(entryValue),
    ]),
  );
}

function hydratePackageVerificationManifest(
  unit: PackageVerificationUnit,
  manifest: PackageVerificationCacheManifest,
): VerifiedPackageBoundarySummary {
  const projectedDeclarations = new Map(
    Object.entries(manifest.projectedDeclarations).map(([filePath, text]) => [
      toPackageAbsolutePath(unit.packageRoot, filePath),
      text,
    ]),
  );
  return {
    cacheId: manifest.cacheId,
    dependencyDependents: absolutizeStringArrayRecord(
      unit.packageRoot,
      manifest.dependencyDependents,
    ),
    dependencySignatures: absolutizeRecordKeys(unit.packageRoot, manifest.dependencySignatures),
    files: manifest.files.map((file) => ({
      ...file,
      cacheDependencyPaths: absolutizePaths(unit.packageRoot, file.cacheDependencyPaths),
      diagnosticPaths: absolutizePaths(unit.packageRoot, file.diagnosticPaths),
      directDependencyPaths: absolutizePaths(unit.packageRoot, file.directDependencyPaths),
      filePath: toPackageAbsolutePath(unit.packageRoot, file.filePath),
      result: {
        ...file.result,
        diagnostics: file.result.diagnostics.map((diagnostic) =>
          remapPackageFilePaths(diagnostic, unit.packageRoot, 'relative-to-absolute')
        ),
      },
    })),
    projectedDeclarations,
    sourceSurfaceSignatures: absolutizeRecordKeys(
      unit.packageRoot,
      manifest.sourceSurfaceSignatures,
    ),
    trackedFilePaths: absolutizePaths(unit.packageRoot, manifest.trackedFilePaths),
    unownedDiagnostics: manifest.unownedDiagnostics.map((diagnostic) =>
      remapPackageFilePaths(diagnostic, unit.packageRoot, 'relative-to-absolute')
    ),
  };
}

export function probePackageVerificationCache(options: {
  cacheDir?: string;
  compilerOptions: ts.CompilerOptions;
  configuredSoundscriptFileNames: ReadonlySet<string>;
  localFrontierRootNames: readonly string[];
  projectPackageJsonPath: string | undefined;
  projectPath: string;
  target: RuntimeTarget;
  useCache: boolean;
}): PackageVerificationCacheProbeResult {
  const cacheRoot = resolvePackageVerificationCacheDirectory(options.projectPath, options.cacheDir);
  const units = measureCheckerTiming(
    'project.packageVerificationCache.discovery',
    {
      cacheDir: cacheRoot,
      projectPath: options.projectPath,
    },
    () =>
      collectPackageVerificationUnits(cacheRoot, {
        compilerOptions: options.compilerOptions,
        configuredSoundscriptFileNames: options.configuredSoundscriptFileNames,
        localFrontierRootNames: options.localFrontierRootNames,
        projectPackageJsonPath: options.projectPackageJsonPath,
        projectPath: options.projectPath,
        target: options.target,
      }),
    { always: true },
  );
  const hits: VerifiedPackageBoundarySummary[] = [];
  const misses: PackageVerificationUnit[] = [];

  measureCheckerTiming(
    'project.packageVerificationCache.read',
    {
      cacheDir: cacheRoot,
      projectPath: options.projectPath,
      units: units.length,
    },
    () => {
      for (const unit of units) {
        const manifest = options.useCache
          ? readPackageVerificationManifest(unit, units, options.compilerOptions)
          : null;
        if (!manifest) {
          misses.push(unit);
          continue;
        }
        hits.push(hydratePackageVerificationManifest(unit, manifest));
      }
    },
    { always: true },
  );

  const projectedDeclarationOverrides = new Map<string, string>();
  for (const hit of hits) {
    for (const [filePath, text] of hit.projectedDeclarations) {
      projectedDeclarationOverrides.set(filePath, text);
    }
  }

  measureCheckerTiming(
    'project.packageVerificationCache.result',
    {
      hits: hits.length,
      misses: misses.length,
      projectPath: options.projectPath,
      units: units.length,
    },
    () => undefined,
    { always: true },
  );

  return {
    hits,
    misses,
    projectedDeclarationOverrides,
    units,
  };
}

export function writePackageVerificationCacheEntries(options: {
  cacheDir?: string;
  compilerOptions: ts.CompilerOptions;
  dependencyDependents: Readonly<Record<string, readonly string[]>>;
  dependencySignatures: Readonly<Record<string, string>>;
  files: readonly CachedPackageSourceFileAnalysis[];
  projectPath: string;
  projectedDeclarations: ReadonlyMap<string, string>;
  sourceSurfaceSignatures: Readonly<Record<string, string>>;
  units: readonly PackageVerificationUnit[];
  useCache: boolean;
}): void {
  if (!options.useCache || options.units.length === 0) {
    return;
  }

  const cacheRoot = resolvePackageVerificationCacheDirectory(options.projectPath, options.cacheDir);
  measureCheckerTiming(
    'project.packageVerificationCache.write',
    {
      cacheDir: cacheRoot,
      projectPath: options.projectPath,
      units: options.units.length,
    },
    () => {
      for (const unit of options.units) {
        if (
          unit.sourceFilePaths.some(isMacroAuthoringSourcePath) ||
          unit.supportFilePaths.some(isMacroAuthoringSourcePath)
        ) {
          continue;
        }
        const unitFilePathSet = new Set(
          unit.sourceFilePaths.map((filePath) => normalizePath(filePath)),
        );
        const files = options.files.filter((file) =>
          unitFilePathSet.has(normalizePath(file.filePath))
        );
        if (files.length === 0) {
          continue;
        }
        const isUnitFilePath = (filePath: string): boolean =>
          unitFilePathSet.has(normalizePath(filePath));
        const unitDependencyDependents = Object.fromEntries(
          Object.entries(options.dependencyDependents)
            .filter(([filePath]) => isUnitFilePath(filePath))
            .map(([filePath, dependents]) =>
              [
                filePath,
                dependents.filter(isUnitFilePath),
              ] as const
            ),
        );
        const unitDependencySignatures = Object.fromEntries(
          Object.entries(options.dependencySignatures).filter(([filePath]) =>
            isUnitFilePath(filePath)
          ),
        );
        const unitSourceSurfaceSignatures = Object.fromEntries(
          Object.entries(options.sourceSurfaceSignatures).filter(([filePath]) =>
            isUnitFilePath(filePath)
          ),
        );

        const projectedDeclarations = Object.fromEntries(
          [...options.projectedDeclarations.entries()]
            .filter(([filePath]) => unitFilePathSet.has(normalizePath(filePath)))
            .map(([filePath, text]) => [toPackageRelativePath(unit.packageRoot, filePath), text])
            .sort(([left], [right]) => left.localeCompare(right)),
        );
        const trackedFilePaths = [
          unit.packageJsonPath,
          ...unit.sourceFilePaths,
          ...unit.supportFilePaths,
          ...files.flatMap((file) => file.cacheDependencyPaths),
        ].sort();
        const normalizedTrackedFilePaths = [
          ...new Set(trackedFilePaths.map((filePath) => ts.sys.resolvePath(filePath))),
        ].filter((filePath) => ts.sys.fileExists(filePath)).sort();
        const trackedDependencySummary = collectTrackedDependencyPackageSummaries(
          unit,
          options.units,
          normalizedTrackedFilePaths,
        );
        const dependencyPackages = mergeDependencySummaries(
          trackedDependencySummary.dependencyPackages,
          collectStaticDependencyPackageSummaries(unit, options.units, options.compilerOptions),
        );
        if (trackedDependencySummary.unsupportedExternalTrackedFilePaths.length > 0) {
          continue;
        }
        const packageJsonHash = hashText(ts.sys.readFile(unit.packageJsonPath) ?? '');
        const manifest: PackageVerificationCacheManifest = {
          cachedAt: new Date().toISOString(),
          cacheId: unit.cacheId,
          compilerOptionsSignature: unit.compilerOptionsSignature,
          dependencyDependents: relativizeStringArrayRecord(
            unit.packageRoot,
            unitDependencyDependents,
          ),
          dependencyPackages,
          dependencySignatures: relativizeRecordKeys(unit.packageRoot, unitDependencySignatures),
          files: files.map((file) => ({
            ...file,
            cacheDependencyPaths: relativizePaths(unit.packageRoot, file.cacheDependencyPaths),
            diagnosticPaths: relativizePaths(unit.packageRoot, file.diagnosticPaths),
            directDependencyPaths: relativizePaths(unit.packageRoot, file.directDependencyPaths),
            filePath: toPackageRelativePath(unit.packageRoot, file.filePath),
            result: {
              ...file.result,
              diagnostics: file.result.diagnostics.map((diagnostic) =>
                remapPackageFilePaths(diagnostic, unit.packageRoot, 'absolute-to-relative')
              ),
            },
          })),
          packageJsonHash,
          packageName: unit.packageName,
          projectedDeclarations,
          rootNames: unit.rootNames.map((filePath) =>
            toPackageRelativePath(unit.packageRoot, filePath)
          ),
          schemaVersion: PACKAGE_VERIFICATION_CACHE_SCHEMA_VERSION,
          sourceFilePaths: unit.sourceFilePaths.map((filePath) =>
            toPackageRelativePath(unit.packageRoot, filePath)
          ),
          sourceSignatures: unit.sourceSignatures,
          sourceSurfaceSignatures: relativizeRecordKeys(
            unit.packageRoot,
            unitSourceSurfaceSignatures,
          ),
          supportFilePaths: unit.supportFilePaths.map((filePath) =>
            toPackageRelativePath(unit.packageRoot, filePath)
          ),
          supportSignatures: unit.supportSignatures,
          target: unit.target,
          toolFingerprint: getSoundscriptToolFingerprint(),
          trackedFilePaths: relativizePaths(unit.packageRoot, normalizedTrackedFilePaths),
          trackedFileSignatures: createTrackedFileSignatures(
            unit.packageRoot,
            normalizedTrackedFilePaths,
          ),
          unownedDiagnostics: [],
        };

        const manifestDirectory = dirname(unit.cachePath);
        makeDirectorySync(manifestDirectory);
        const temporaryPath = join(
          manifestDirectory,
          `manifest.json.tmp-${Deno.pid}-${Date.now()}`,
        );
        writeTextFileSync(
          temporaryPath,
          `${JSON.stringify(replaceUndefinedJsonValues(manifest), null, 2)}\n`,
        );
        try {
          renamePathSync(temporaryPath, unit.cachePath);
        } catch (error) {
          removePathSync(temporaryPath);
          throw error;
        }
      }
    },
    { always: true },
  );
}

export function findProjectPackageJsonPath(projectPath: string): string | undefined {
  return findNearestPackageJsonPath(projectPath, ts.sys);
}
