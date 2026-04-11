import ts from 'typescript';

import {
  builtinRuntimeImportSpecifier,
  isBuiltinRuntimeModuleSpecifier,
} from '../project/soundscript_runtime_specifiers.ts';
import { dirname, join, normalize, relative } from '../platform/path.ts';
import type { MacroRuntimeImportRequest } from './macro_output.ts';
import type { PreparedProgram } from './project_frontend.ts';

interface PackageRuntimeMetadata {
  readonly name?: string;
  readonly ordinaryExports: ReadonlySet<string>;
  readonly packageJsonPath: string;
  readonly packageRoot: string;
  readonly soundscriptExports: ReadonlyMap<string, string>;
}

function extractSoundscriptSourceTarget(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const source = (value as Record<string, unknown>).source;
  return typeof source === 'string' ? source : null;
}

export interface MacroRuntimeImportResolver {
  resolve(
    request: Pick<MacroRuntimeImportRequest, 'exportName' | 'kind'> & { specifier: string },
  ): MacroRuntimeImportRequest;
}

function normalizePath(fileName: string): string {
  const normalized = normalize(fileName);
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function findNearestPackageJson(
  startFileName: string,
  host: ts.ModuleResolutionHost,
): string | null {
  let currentDirectory = dirname(startFileName);
  const visited = new Set<string>();

  while (!visited.has(normalizePath(currentDirectory))) {
    visited.add(normalizePath(currentDirectory));
    const packageJsonPath = join(currentDirectory, 'package.json');
    if (host.fileExists(packageJsonPath)) {
      return packageJsonPath;
    }
    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }
    currentDirectory = parentDirectory;
  }

  return null;
}

function readPackageRuntimeMetadata(
  startFileName: string,
  host: ts.ModuleResolutionHost,
): PackageRuntimeMetadata | null {
  const packageJsonPath = findNearestPackageJson(startFileName, host);
  if (!packageJsonPath) {
    return null;
  }

  const packageJsonText = host.readFile(packageJsonPath);
  if (!packageJsonText) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const packageRoot = dirname(packageJsonPath);
  const ordinaryExports = collectOrdinaryExportSubpaths(record.exports);
  const soundscriptExports = new Map<string, string>();
  const soundscript = record.soundscript;
  if (soundscript && typeof soundscript === 'object') {
    const exportsRecord = (soundscript as Record<string, unknown>).exports;
    if (exportsRecord && typeof exportsRecord === 'object') {
      for (const [subpath, target] of Object.entries(exportsRecord as Record<string, unknown>)) {
        const sourceTarget = extractSoundscriptSourceTarget(target);
        if (!sourceTarget) {
          continue;
        }
        soundscriptExports.set(
          subpath,
          normalize(
            sourceTarget.startsWith('/') ? sourceTarget : join(packageRoot, sourceTarget),
          ),
        );
      }
    }
  }

  return {
    name: typeof record.name === 'string' && record.name.length > 0 ? record.name : undefined,
    ordinaryExports,
    packageJsonPath,
    packageRoot,
    soundscriptExports,
  };
}

function exportShapeHasStringTarget(value: unknown): boolean {
  if (typeof value === 'string') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => exportShapeHasStringTarget(entry));
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.values(value).some((entry) => exportShapeHasStringTarget(entry));
}

function collectOrdinaryExportSubpaths(exportsField: unknown): ReadonlySet<string> {
  const subpaths = new Set<string>();
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    if (exportShapeHasStringTarget(exportsField)) {
      subpaths.add('.');
    }
    return subpaths;
  }
  if (!exportsField || typeof exportsField !== 'object') {
    return subpaths;
  }

  const entries = Object.entries(exportsField as Record<string, unknown>);
  const hasSubpathKeys = entries.some(([key]) => key.startsWith('.'));
  if (hasSubpathKeys) {
    for (const [key, value] of entries) {
      if (key.startsWith('.') && exportShapeHasStringTarget(value)) {
        subpaths.add(key);
      }
    }
    return subpaths;
  }

  if (exportShapeHasStringTarget(exportsField)) {
    subpaths.add('.');
  }
  return subpaths;
}

function createModuleResolutionHost(preparedProgram: PreparedProgram): ts.ModuleResolutionHost {
  const baseHost = preparedProgram.preparedHost.host;
  return {
    directoryExists: baseHost.directoryExists?.bind(baseHost),
    fileExists: baseHost.fileExists.bind(baseHost),
    getCurrentDirectory: baseHost.getCurrentDirectory?.bind(baseHost) ??
      (() => ts.sys.getCurrentDirectory()),
    getDirectories: baseHost.getDirectories?.bind(baseHost),
    readFile: baseHost.readFile.bind(baseHost),
    realpath: baseHost.realpath?.bind(baseHost),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
}

function sanitizeSpecifierForIdentifier(specifier: string): string {
  return specifier.replace(/[^A-Za-z0-9_$]+/gu, '_').replace(/^_+/u, '');
}

function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function createLocalName(
  kind: MacroRuntimeImportRequest['kind'],
  specifier: string,
  exportName?: string,
): string {
  const hint = exportName ?? (sanitizeSpecifierForIdentifier(specifier) || 'runtime');
  return `__sts_runtime_${kind}_${hint}_${
    fnv1a(`${kind}\u0000${specifier}\u0000${exportName ?? ''}`)
      .toString(16)
  }`;
}

function toRelativeModuleSpecifier(fromFileName: string, toFileName: string): string {
  const raw = relative(dirname(fromFileName), toFileName).replaceAll('\\', '/');
  return raw.startsWith('.') ? raw : `./${raw}`;
}

function resolveRelativeRuntimeFile(
  containingFileName: string,
  specifier: string,
  host: ts.ModuleResolutionHost,
): string | null {
  const basePath = normalize(join(dirname(containingFileName), specifier));
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.sts`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx'),
    join(basePath, 'index.sts'),
    join(basePath, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (host.fileExists(candidate)) {
      return normalize(candidate);
    }
  }
  return null;
}

function publicSpecifierForPackageSubpath(packageName: string, subpath: string): string {
  return subpath === '.' ? packageName : `${packageName}/${subpath.replace(/^\.\/?/u, '')}`;
}

export function createMacroRuntimeImportResolver(
  preparedProgram: PreparedProgram,
  sourceFileName: string,
  macroModuleFileName: string,
): MacroRuntimeImportResolver {
  const resolutionHost = createModuleResolutionHost(preparedProgram);

  return {
    resolve(request) {
      if (!request.specifier.startsWith('.')) {
        if (isBuiltinRuntimeModuleSpecifier(request.specifier)) {
          const specifier = builtinRuntimeImportSpecifier(request.specifier) ?? request.specifier;
          return {
            exportName: request.exportName,
            kind: request.kind,
            localName: createLocalName(request.kind, specifier, request.exportName),
            specifier,
          };
        }
        throw new Error(
          `Runtime macro imports must stay within the defining package. Re-export "${request.specifier}" through the macro package and import that local subpath instead.`,
        );
      }

      const resolvedModule = ts.resolveModuleName(
        request.specifier,
        macroModuleFileName,
        preparedProgram.options,
        resolutionHost,
        preparedProgram.preparedHost.reuseState.moduleResolutionCache,
      ).resolvedModule;
      const runtimeFileName = resolvedModule?.resolvedFileName
        ? normalize(resolvedModule.resolvedFileName)
        : resolveRelativeRuntimeFile(macroModuleFileName, request.specifier, resolutionHost);
      if (!runtimeFileName) {
        throw new Error(
          `Could not resolve runtime import "${request.specifier}" from macro module "${macroModuleFileName}".`,
        );
      }
      const macroPackage = readPackageRuntimeMetadata(macroModuleFileName, resolutionHost);
      const runtimePackage = readPackageRuntimeMetadata(runtimeFileName, resolutionHost);
      if (
        macroPackage &&
        runtimePackage &&
        normalizePath(macroPackage.packageJsonPath) !==
          normalizePath(runtimePackage.packageJsonPath)
      ) {
        throw new Error(
          `Runtime macro imports must stay within the defining package. "${request.specifier}" resolves outside the macro package.`,
        );
      }

      let specifier = toRelativeModuleSpecifier(sourceFileName, runtimeFileName);
      if (macroPackage?.name && macroPackage.soundscriptExports.size > 0) {
        let publishedSubpath: string | null = null;
        for (const [subpath, targetFileName] of macroPackage.soundscriptExports.entries()) {
          if (normalizePath(targetFileName) !== normalizePath(runtimeFileName)) {
            continue;
          }
          publishedSubpath = subpath;
          break;
        }

        if (!publishedSubpath) {
          throw new Error(
            `Runtime macro import "${request.specifier}" must resolve to a subpath published in package.json#soundscript.exports for package "${macroPackage.name}".`,
          );
        }
        if (!macroPackage.ordinaryExports.has(publishedSubpath)) {
          throw new Error(
            `Runtime macro import "${request.specifier}" resolves to "${
              publicSpecifierForPackageSubpath(macroPackage.name, publishedSubpath)
            }", but that subpath is not published through package.json#exports.`,
          );
        }
        specifier = publicSpecifierForPackageSubpath(macroPackage.name, publishedSubpath);
      }

      return {
        exportName: request.exportName,
        kind: request.kind,
        localName: createLocalName(request.kind, specifier, request.exportName),
        specifier,
      };
    },
  };
}
