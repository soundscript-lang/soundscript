import ts from 'typescript';

import { resolveHostDeclarationFile } from '../frontend/host_declaration_resolution.ts';
import {
  isSoundscriptProtocolSpecifier,
  SOUNDSCRIPT_RUNTIME_PACKAGE_NAME,
} from './soundscript_runtime_specifiers.ts';
import { dirname, isAbsolute, join, normalize } from '../platform/path.ts';

export interface SoundScriptPackageExportInfo {
  exportKey: string;
  packageInfo: SoundScriptPackageInfo;
  sourceEntryPath: string;
}

export interface SoundScriptPackageInfo {
  exports: ReadonlyMap<string, string>;
  legacySourceEntryPath?: string;
  name: string;
  packageJsonPath: string;
  packageRoot: string;
  toolchain?: string;
  version?: number;
}

interface ModuleResolutionHostLike {
  directoryExists?(directoryName: string): boolean;
  fileExists(fileName: string): boolean;
  getCurrentDirectory?(): string;
  getDirectories?(path: string): string[];
  readFile(fileName: string): string | undefined;
  realpath?(path: string): string;
  useCaseSensitiveFileNames?: boolean | (() => boolean);
}

interface ParsedPackageSpecifier {
  exportKey: string;
  packageName: string;
}

const SOUNDSCRIPT_PROGRAM_SUFFIX = '.sts.ts';
const SOUNDSCRIPT_DECLARATION_SUFFIX = '.sts.d.ts';

function normalizePath(fileName: string): string {
  const resolved = normalize(fileName);
  return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
}

function toOriginalPackageSourceLookupFileName(fileName: string): string {
  if (fileName.endsWith(SOUNDSCRIPT_DECLARATION_SUFFIX)) {
    return fileName.slice(0, -5);
  }

  if (fileName.endsWith(SOUNDSCRIPT_PROGRAM_SUFFIX)) {
    return fileName.slice(0, -3);
  }

  return fileName;
}

function isNodeModulesPath(fileName: string): boolean {
  return fileName.includes('/node_modules/') || fileName.includes('\\node_modules\\');
}

function isBarePackageSpecifier(moduleSpecifier: string): boolean {
  return !isSoundscriptProtocolSpecifier(moduleSpecifier) &&
    !moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/') &&
    !/^[A-Za-z]:[/\\]/u.test(moduleSpecifier);
}

function parsePackageSpecifier(moduleSpecifier: string): ParsedPackageSpecifier | undefined {
  if (!isBarePackageSpecifier(moduleSpecifier)) {
    return undefined;
  }

  if (moduleSpecifier.startsWith('@')) {
    const [scope, packageName, ...subpathParts] = moduleSpecifier.split('/');
    if (!scope || !packageName) {
      return undefined;
    }

    return {
      packageName: `${scope}/${packageName}`,
      exportKey: subpathParts.length > 0 ? `./${subpathParts.join('/')}` : '.',
    };
  }

  const [packageName, ...subpathParts] = moduleSpecifier.split('/');
  if (!packageName) {
    return undefined;
  }

  return {
    packageName,
    exportKey: subpathParts.length > 0 ? `./${subpathParts.join('/')}` : '.',
  };
}

function resolvePreferredRelativeSoundScriptModule(
  moduleSpecifier: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
  host: ModuleResolutionHostLike,
): ts.ResolvedModuleFull | undefined {
  if (!moduleSpecifier.startsWith('.')) {
    return undefined;
  }

  const explicitNonSoundscriptExtensionPattern = /\.(?:[cm]?[jt]sx?|[cm]?js)$/u;
  if (explicitNonSoundscriptExtensionPattern.test(moduleSpecifier)) {
    return undefined;
  }

  const candidates = moduleSpecifier.endsWith('.sts')
    ? [moduleSpecifier]
    : [`${moduleSpecifier}.sts`, `${moduleSpecifier}/index.sts`];

  for (const candidate of candidates) {
    const resolvedCandidate = normalize(
      isAbsolute(candidate) ? candidate : join(dirname(containingFile), candidate),
    );
    if (host.fileExists(resolvedCandidate)) {
      return {
        extension: ts.Extension.Ts,
        isExternalLibraryImport: false,
        resolvedFileName: resolvedCandidate,
      };
    }

    const resolved = ts.resolveModuleName(
      candidate,
      containingFile,
      compilerOptions,
      host,
    ).resolvedModule;
    if (resolved && resolved.resolvedFileName.endsWith('.sts')) {
      return resolved;
    }
  }

  return undefined;
}

function packageNameToPathParts(packageName: string): string[] {
  return packageName.startsWith('@') ? packageName.split('/') : [packageName];
}

function inferExtension(fileName: string): ts.Extension | undefined {
  if (fileName.endsWith('.d.ts')) {
    return ts.Extension.Dts;
  }
  if (fileName.endsWith('.sts')) {
    return ts.Extension.Ts;
  }
  if (fileName.endsWith('.cts')) {
    return ts.Extension.Cts;
  }
  if (fileName.endsWith('.mts')) {
    return ts.Extension.Mts;
  }
  if (fileName.endsWith('.tsx')) {
    return ts.Extension.Tsx;
  }
  if (fileName.endsWith('.ts')) {
    return ts.Extension.Ts;
  }
  if (fileName.endsWith('.jsx')) {
    return ts.Extension.Jsx;
  }
  if (fileName.endsWith('.js')) {
    return ts.Extension.Js;
  }

  return undefined;
}

function isMacroAuthoringSourcePath(fileName: string): boolean {
  return fileName.endsWith('.macro.sts');
}

export function isPublishedSoundScriptSourcePath(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.sts');
}

const PACKAGE_LOCAL_IMPORT_EXTENSION_CANDIDATES = [
  '.sts',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.d.ts',
  '.d.mts',
  '.d.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
] as const;

function isTrustedRuntimePackageSourcePath(
  packageName: string,
  fileName: string,
): boolean {
  const lowered = fileName.toLowerCase();
  return packageName === SOUNDSCRIPT_RUNTIME_PACKAGE_NAME &&
    lowered.endsWith('.ts') &&
    !lowered.endsWith('.d.ts');
}

function isJavaScriptLikeResolvedModule(resolvedModule: ts.ResolvedModuleFull): boolean {
  const extension = resolvedModule.extension ?? inferExtension(resolvedModule.resolvedFileName);
  return extension === ts.Extension.Js ||
    extension === ts.Extension.Jsx ||
    resolvedModule.resolvedFileName.endsWith('.mjs') ||
    resolvedModule.resolvedFileName.endsWith('.cjs');
}

function isRelativeOrAbsoluteSpecifier(moduleSpecifier: string): boolean {
  return moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../') ||
    moduleSpecifier.startsWith('/');
}

function findNearestPackageJson(
  startFileName: string,
  host: ModuleResolutionHostLike,
): string | undefined {
  let currentDirectory = dirname(startFileName);
  const visited = new Set<string>();

  while (!visited.has(normalizePath(currentDirectory))) {
    visited.add(normalizePath(currentDirectory));

    const candidate = join(currentDirectory, 'package.json');
    if (host.fileExists(candidate)) {
      return candidate;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  return undefined;
}

export function findNearestPackageJsonPath(
  startFileName: string,
  host: ModuleResolutionHostLike,
): string | undefined {
  return findNearestPackageJson(startFileName, host);
}

function normalizeSoundscriptExportKey(key: string): string | undefined {
  if (key === '.') {
    return '.';
  }
  if (key.startsWith('./') && key.length > 2) {
    return key;
  }
  return undefined;
}

function resolvePackageLocalPath(
  packageRoot: string,
  candidatePath: string,
  host: ModuleResolutionHostLike,
): string | undefined {
  const resolved = normalize(
    isAbsolute(candidatePath) ? candidatePath : join(packageRoot, candidatePath),
  );
  if (!host.fileExists(resolved)) {
    return undefined;
  }
  return resolved;
}

function resolvePackageLocalDependency(
  containingFileName: string,
  moduleSpecifier: string,
  host: ModuleResolutionHostLike,
): string | undefined {
  if (!isRelativeOrAbsoluteSpecifier(moduleSpecifier)) {
    return undefined;
  }

  const candidateBase = normalize(
    moduleSpecifier.startsWith('/')
      ? moduleSpecifier
      : join(dirname(containingFileName), moduleSpecifier),
  );

  if (host.fileExists(candidateBase)) {
    return candidateBase;
  }

  for (const extension of PACKAGE_LOCAL_IMPORT_EXTENSION_CANDIDATES) {
    const candidate = `${candidateBase}${extension}`;
    if (host.fileExists(candidate)) {
      return candidate;
    }
  }

  for (const extension of PACKAGE_LOCAL_IMPORT_EXTENSION_CANDIDATES) {
    const candidate = join(candidateBase, `index${extension}`);
    if (host.fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function resolvePackageLocalSoundScriptSourcePath(
  packageName: string,
  packageRoot: string,
  candidatePath: string,
  host: ModuleResolutionHostLike,
): string | undefined {
  const resolved = resolvePackageLocalPath(packageRoot, candidatePath, host);
  return resolved &&
      (isPublishedSoundScriptSourcePath(resolved) ||
        isTrustedRuntimePackageSourcePath(packageName, resolved))
    ? resolved
    : undefined;
}

function isTrustedPublishedPackageSourceArtifact(
  packageInfo: SoundScriptPackageInfo,
  fileName: string,
): boolean {
  return isPublishedSoundScriptSourcePath(fileName) ||
    isTrustedRuntimePackageSourcePath(packageInfo.name, fileName);
}

function collectPackageLocalImportSpecifiers(
  fileName: string,
  host: ModuleResolutionHostLike,
): readonly string[] {
  const sourceText = host.readFile(fileName);
  if (!sourceText) {
    return [];
  }

  const moduleSpecifiers = new Set(
    ts.preProcessFile(sourceText, true, true).importedFiles.map((entry) => entry.fileName),
  );
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
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

function resolvePackageInternalDependency(
  packageInfo: SoundScriptPackageInfo,
  containingFileName: string,
  moduleSpecifier: string,
  host: ModuleResolutionHostLike,
): string | undefined {
  const relativeResolved = resolvePackageLocalDependency(containingFileName, moduleSpecifier, host);
  if (relativeResolved) {
    return relativeResolved;
  }

  const parsedSpecifier = parsePackageSpecifier(moduleSpecifier);
  if (!parsedSpecifier || parsedSpecifier.packageName !== packageInfo.name) {
    return undefined;
  }

  return packageInfo.exports.get(parsedSpecifier.exportKey) ??
    (parsedSpecifier.exportKey === '.' ? packageInfo.legacySourceEntryPath : undefined);
}

function isTrustedPublishedPackageSourceClosure(
  fileName: string,
  packageInfo: SoundScriptPackageInfo,
  host: ModuleResolutionHostLike,
  trustedByFileName = new Map<string, boolean>(),
  visiting = new Set<string>(),
): boolean {
  const normalizedFileName = normalizePath(fileName);
  const cached = trustedByFileName.get(normalizedFileName);
  if (cached !== undefined) {
    return cached;
  }

  if (!isTrustedPublishedPackageSourceArtifact(packageInfo, fileName)) {
    trustedByFileName.set(normalizedFileName, false);
    return false;
  }

  if (visiting.has(normalizedFileName)) {
    return true;
  }

  visiting.add(normalizedFileName);
  try {
    for (const moduleSpecifier of collectPackageLocalImportSpecifiers(fileName, host)) {
      const resolvedDependency = resolvePackageInternalDependency(
        packageInfo,
        fileName,
        moduleSpecifier,
        host,
      );
      if (!resolvedDependency) {
        continue;
      }

      if (
        !isTrustedPublishedPackageSourceClosure(
          resolvedDependency,
          packageInfo,
          host,
          trustedByFileName,
          visiting,
        )
      ) {
        trustedByFileName.set(normalizedFileName, false);
        return false;
      }
    }
  } finally {
    visiting.delete(normalizedFileName);
  }

  trustedByFileName.set(normalizedFileName, true);
  return true;
}

function parsePackageJson(
  packageJsonPath: string,
  host: ModuleResolutionHostLike,
): SoundScriptPackageInfo | undefined {
  const packageJsonText = host.readFile(packageJsonPath);
  if (!packageJsonText) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

  const packageRecord = parsed as Record<string, unknown>;
  const packageName = typeof packageRecord.name === 'string' ? packageRecord.name : undefined;
  const soundscript = packageRecord.soundscript;
  if (!packageName || !soundscript || typeof soundscript !== 'object') {
    return undefined;
  }

  const soundscriptRecord = soundscript as Record<string, unknown>;
  const packageRoot = dirname(packageJsonPath);
  const rawExportsMap = new Map<string, string>();
  const rawExports = soundscriptRecord.exports;

  if (rawExports && typeof rawExports === 'object') {
    for (const [rawKey, rawValue] of Object.entries(rawExports as Record<string, unknown>)) {
      const exportKey = normalizeSoundscriptExportKey(rawKey);
      if (!exportKey || !rawValue || typeof rawValue !== 'object') {
        continue;
      }

      const source = (rawValue as Record<string, unknown>).source;
      if (typeof source !== 'string' || source.length === 0) {
        continue;
      }

      const resolved = resolvePackageLocalSoundScriptSourcePath(
        packageName,
        packageRoot,
        source,
        host,
      );
      if (resolved) {
        rawExportsMap.set(exportKey, resolved);
      }
    }
  }

  const legacySource = soundscriptRecord.source;
  const rawLegacySourceEntryPath = typeof legacySource === 'string' && legacySource.length > 0
    ? resolvePackageLocalSoundScriptSourcePath(packageName, packageRoot, legacySource, host)
    : undefined;

  const draftPackageInfo: SoundScriptPackageInfo = {
    exports: rawExportsMap,
    legacySourceEntryPath: rawLegacySourceEntryPath,
    name: packageName,
    packageJsonPath,
    packageRoot,
    toolchain: typeof soundscriptRecord.toolchain === 'string'
      ? soundscriptRecord.toolchain
      : undefined,
    version: typeof soundscriptRecord.version === 'number' ? soundscriptRecord.version : undefined,
  };
  const exportsMap = new Map<string, string>();
  for (const [exportKey, sourceEntryPath] of rawExportsMap) {
    if (isTrustedPublishedPackageSourceClosure(sourceEntryPath, draftPackageInfo, host)) {
      exportsMap.set(exportKey, sourceEntryPath);
    }
  }
  const legacySourceEntryPath = rawLegacySourceEntryPath &&
      isTrustedPublishedPackageSourceClosure(rawLegacySourceEntryPath, draftPackageInfo, host)
    ? rawLegacySourceEntryPath
    : undefined;

  if (exportsMap.size === 0 && !legacySourceEntryPath) {
    return undefined;
  }

  return {
    exports: exportsMap,
    legacySourceEntryPath,
    name: packageName,
    packageJsonPath,
    packageRoot,
    toolchain: typeof soundscriptRecord.toolchain === 'string'
      ? soundscriptRecord.toolchain
      : undefined,
    version: typeof soundscriptRecord.version === 'number' ? soundscriptRecord.version : undefined,
  };
}

export function loadSoundScriptPackageInfo(
  packageJsonPath: string,
  host: ModuleResolutionHostLike,
): SoundScriptPackageInfo | undefined {
  return parsePackageJson(packageJsonPath, host);
}

export function getSoundScriptPackageInfoForResolvedModule(
  resolvedFileName: string,
  host: ModuleResolutionHostLike,
): SoundScriptPackageInfo | undefined {
  const packageJsonPath = findNearestPackageJson(resolvedFileName, host);
  if (!packageJsonPath) {
    return undefined;
  }

  return parsePackageJson(packageJsonPath, host);
}

export function getSoundScriptPackageExportInfoForResolvedModule(
  moduleSpecifier: string,
  resolvedFileName: string,
  host: ModuleResolutionHostLike,
): SoundScriptPackageExportInfo | undefined {
  const parsedSpecifier = parsePackageSpecifier(moduleSpecifier);
  if (!parsedSpecifier) {
    return undefined;
  }

  const packageInfo = getSoundScriptPackageInfoForResolvedModule(resolvedFileName, host);
  if (!packageInfo || packageInfo.name !== parsedSpecifier.packageName) {
    return undefined;
  }

  const sourceEntryPath = packageInfo.exports.get(parsedSpecifier.exportKey) ??
    (parsedSpecifier.exportKey === '.' ? packageInfo.legacySourceEntryPath : undefined);
  if (!sourceEntryPath) {
    return undefined;
  }

  return {
    exportKey: parsedSpecifier.exportKey,
    packageInfo,
    sourceEntryPath,
  };
}

export function resolveSoundScriptAwareModule(
  moduleSpecifier: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
  host: ModuleResolutionHostLike,
): ts.ResolvedModuleFull | undefined {
  const hostDeclarationFile = resolveHostDeclarationFile(moduleSpecifier, compilerOptions);
  if (hostDeclarationFile) {
    return {
      extension: ts.Extension.Dts,
      isExternalLibraryImport: true,
      resolvedFileName: hostDeclarationFile,
    };
  }

  if (isSoundscriptProtocolSpecifier(moduleSpecifier)) {
    return undefined;
  }

  const preferredRelativeModule = resolvePreferredRelativeSoundScriptModule(
    moduleSpecifier,
    containingFile,
    compilerOptions,
    host,
  );
  if (preferredRelativeModule) {
    return preferredRelativeModule;
  }

  const resolvedModule = ts.resolveModuleName(
    moduleSpecifier,
    containingFile,
    compilerOptions,
    host,
  ).resolvedModule;

  if (resolvedModule) {
    const packageExport = getSoundScriptPackageExportInfoForResolvedModule(
      moduleSpecifier,
      resolvedModule.resolvedFileName,
      host,
    );
    if (packageExport && isMacroAuthoringSourcePath(packageExport.sourceEntryPath)) {
      return resolvedModule;
    }
    return remapResolvedModuleToSoundScriptSource(moduleSpecifier, resolvedModule, host);
  }

  const parsedSpecifier = parsePackageSpecifier(moduleSpecifier);
  if (!parsedSpecifier) {
    return undefined;
  }

  let currentDirectory = dirname(containingFile);
  const visited = new Set<string>();
  while (!visited.has(normalizePath(currentDirectory))) {
    visited.add(normalizePath(currentDirectory));

    const packageJsonPath = join(
      currentDirectory,
      'node_modules',
      ...packageNameToPathParts(parsedSpecifier.packageName),
      'package.json',
    );
    if (host.fileExists(packageJsonPath)) {
      const packageInfo = parsePackageJson(packageJsonPath, host);
      const sourceEntryPath = packageInfo?.exports.get(parsedSpecifier.exportKey) ??
        (parsedSpecifier.exportKey === '.' ? packageInfo?.legacySourceEntryPath : undefined);
      const sourceExtension = sourceEntryPath ? inferExtension(sourceEntryPath) : undefined;
      if (sourceEntryPath && isMacroAuthoringSourcePath(sourceEntryPath)) {
        return undefined;
      }
      if (sourceEntryPath && sourceExtension) {
        return {
          extension: sourceExtension,
          isExternalLibraryImport: false,
          resolvedFileName: sourceEntryPath,
        };
      }
      return undefined;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  return undefined;
}

export function remapResolvedModuleToSoundScriptSource(
  moduleSpecifier: string,
  resolvedModule: ts.ResolvedModuleFull,
  host: ModuleResolutionHostLike,
): ts.ResolvedModuleFull;
export function remapResolvedModuleToSoundScriptSource(
  moduleSpecifier: string,
  resolvedModule: ts.ResolvedModule,
  host: ModuleResolutionHostLike,
): ts.ResolvedModule;
export function remapResolvedModuleToSoundScriptSource(
  moduleSpecifier: string,
  resolvedModule: ts.ResolvedModuleFull | ts.ResolvedModule,
  host: ModuleResolutionHostLike,
): ts.ResolvedModuleFull | ts.ResolvedModule {
  const packageExport = getSoundScriptPackageExportInfoForResolvedModule(
    moduleSpecifier,
    resolvedModule.resolvedFileName,
    host,
  );
  if (!packageExport) {
    return resolvedModule;
  }

  if (isMacroAuthoringSourcePath(packageExport.sourceEntryPath)) {
    return resolvedModule;
  }

  const sourceExtension = inferExtension(packageExport.sourceEntryPath);
  if (!sourceExtension) {
    return resolvedModule;
  }

  return {
    ...resolvedModule,
    extension: sourceExtension,
    isExternalLibraryImport: false,
    resolvedFileName: packageExport.sourceEntryPath,
  };
}

export function isForeignPackageImport(
  moduleSpecifier: string,
  resolvedModule: ts.ResolvedModuleFull | undefined,
  host: ModuleResolutionHostLike,
): boolean {
  if (!resolvedModule || !isBarePackageSpecifier(moduleSpecifier)) {
    return false;
  }

  const packageExport = getSoundScriptPackageExportInfoForResolvedModule(
    moduleSpecifier,
    resolvedModule.resolvedFileName,
    host,
  );
  if (packageExport) {
    return false;
  }

  return resolvedModule.isExternalLibraryImport === true ||
    isNodeModulesPath(normalizePath(resolvedModule.resolvedFileName));
}

export function isForeignResolvedModule(
  moduleSpecifier: string,
  resolvedModule: ts.ResolvedModuleFull | undefined,
  host: ModuleResolutionHostLike,
): boolean {
  if (!resolvedModule) {
    return false;
  }

  if (resolvedModule.resolvedFileName.endsWith('.d.ts')) {
    return getSoundScriptPackageExportInfoForResolvedModule(
      moduleSpecifier,
      resolvedModule.resolvedFileName,
      host,
    ) === undefined;
  }

  if (isJavaScriptLikeResolvedModule(resolvedModule)) {
    return true;
  }

  return isForeignPackageImport(moduleSpecifier, resolvedModule, host);
}

export function isForeignPackageSourceFile(
  fileName: string,
  host: ModuleResolutionHostLike,
): boolean {
  const originalFileName = toOriginalPackageSourceLookupFileName(fileName);
  if (!isNodeModulesPath(originalFileName)) {
    return true;
  }

  const packageInfo = getSoundScriptPackageInfoForResolvedModule(originalFileName, host);
  if (!packageInfo) {
    return true;
  }

  return !isTrustedPublishedPackageSourceClosure(originalFileName, packageInfo, host);
}

export function isForeignSourceFile(
  fileName: string,
  host: ModuleResolutionHostLike,
): boolean {
  const originalFileName = toOriginalPackageSourceLookupFileName(fileName);
  return isNodeModulesPath(originalFileName) && isForeignPackageSourceFile(originalFileName, host);
}
