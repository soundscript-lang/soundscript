import ts from 'typescript';

import {
  collectSoundscriptRootNames,
  getConfigFileParsingDiagnostics,
  loadConfig,
} from '../config.ts';

function isDeclarationRootFileName(fileName: string): boolean {
  return fileName.endsWith('.d.ts') || fileName.endsWith('.d.mts') || fileName.endsWith('.d.cts');
}

export interface RuntimeProgramConfig {
  configFileParsingDiagnostics: readonly ts.Diagnostic[];
  loadedConfig: ReturnType<typeof loadConfig>;
  rootNames: readonly string[];
}

export function collectRuntimeProgramRootNames(
  projectPath: string,
  extraRootNames: readonly string[] = [],
): readonly string[] {
  const loadedConfig = loadConfig(projectPath);
  const soundscriptRootNames = collectSoundscriptRootNames(projectPath, loadedConfig);
  const declarationRootNames = loadedConfig.commandLine.fileNames.filter(isDeclarationRootFileName);
  const normalizedExtraRootNames = extraRootNames.map((fileName) => ts.sys.resolvePath(fileName));

  return [
    ...new Set([
      ...soundscriptRootNames,
      ...declarationRootNames,
      ...normalizedExtraRootNames,
    ]),
  ].sort();
}

export function loadRuntimeProgramConfig(
  projectPath: string,
  extraRootNames: readonly string[] = [],
): RuntimeProgramConfig {
  const loadedConfig = loadConfig(projectPath);
  const soundscriptRootNames = collectSoundscriptRootNames(projectPath, loadedConfig);
  const declarationRootNames = loadedConfig.commandLine.fileNames.filter(isDeclarationRootFileName);
  const normalizedExtraRootNames = extraRootNames.map((fileName) => ts.sys.resolvePath(fileName));
  const rootNames = [
    ...new Set([
      ...soundscriptRootNames,
      ...declarationRootNames,
      ...normalizedExtraRootNames,
    ]),
  ].sort();

  return {
    configFileParsingDiagnostics: getConfigFileParsingDiagnostics(
      loadedConfig.diagnostics,
      rootNames,
    ),
    loadedConfig,
    rootNames,
  };
}
