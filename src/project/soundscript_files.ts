import ts from 'typescript';

export const SOUNDSCRIPT_PROGRAM_SUFFIX = '.sts.ts';
export const SOUNDSCRIPT_DECLARATION_SUFFIX = '.sts.d.ts';

export function isSoundscriptSourceFile(fileName: string): boolean {
  return fileName.endsWith('.sts');
}

export function isSoundscriptMacroSourceFile(fileName: string): boolean {
  return fileName.endsWith('.macro.sts');
}

export function toProgramFileName(fileName: string): string {
  return isSoundscriptSourceFile(fileName) ? `${fileName}.ts` : fileName;
}

export function toProjectedDeclarationFileName(fileName: string): string {
  return isSoundscriptSourceFile(fileName) ? `${fileName}.d.ts` : fileName;
}

export function isProjectedSoundscriptDeclarationFile(fileName: string): boolean {
  return fileName.endsWith(SOUNDSCRIPT_DECLARATION_SUFFIX);
}

export function toSourceFileName(fileName: string): string {
  return fileName.endsWith(SOUNDSCRIPT_PROGRAM_SUFFIX) ? fileName.slice(0, -3) : fileName;
}

export function toProjectedDeclarationSourceFileName(fileName: string): string {
  return isProjectedSoundscriptDeclarationFile(fileName) ? fileName.slice(0, -5) : fileName;
}

export function isTypeScriptFamilySoundscriptAliasFile(fileName: string): boolean {
  const lowered = fileName.toLowerCase();
  return (
    lowered.endsWith('.ts') ||
    lowered.endsWith('.tsx') ||
    lowered.endsWith('.mts') ||
    lowered.endsWith('.cts')
  ) && !(
    lowered.endsWith('.d.ts') ||
    lowered.endsWith('.d.mts') ||
    lowered.endsWith('.d.cts')
  );
}

export function normalizeConfiguredSoundscriptFileNames(
  fileNames: Iterable<string>,
): ReadonlySet<string> {
  return new Set([...fileNames].map((fileName) => ts.sys.resolvePath(fileName)));
}

export function isConfiguredSoundscriptSourceFile(
  fileName: string,
  configuredSoundscriptFileNames: ReadonlySet<string>,
): boolean {
  return configuredSoundscriptFileNames.has(ts.sys.resolvePath(fileName));
}

export function isLocalSoundscriptSourceFile(
  fileName: string,
  configuredSoundscriptFileNames: ReadonlySet<string>,
): boolean {
  return isSoundscriptSourceFile(fileName) ||
    isConfiguredSoundscriptSourceFile(fileName, configuredSoundscriptFileNames);
}
