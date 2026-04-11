import ts from 'typescript';

import { fromFileUrl } from '../platform/path.ts';

export const MACRO_API_MODULE_SPECIFIER = 'sts:macros';
export const MACRO_API_MODULE_FILE = fromFileUrl(new URL('../macros.d.ts', import.meta.url));

function createModuleResolutionHost(baseHost: ts.CompilerHost): ts.ModuleResolutionHost {
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

export function withMacroApiModuleResolution(baseHost: ts.CompilerHost): ts.CompilerHost {
  return {
    ...baseHost,
    resolveModuleNames(
      moduleNames: string[],
      containingFile: string,
      reusedNames?: string[],
      redirectedReference?: ts.ResolvedProjectReference,
      options?: ts.CompilerOptions,
    ): (ts.ResolvedModule | undefined)[] {
      const fallbackHost = createModuleResolutionHost(baseHost);
      const delegated = baseHost.resolveModuleNames?.(
        moduleNames,
        containingFile,
        reusedNames,
        redirectedReference,
        options ?? {},
      );

      return moduleNames.map((moduleName, index) => {
        if (moduleName === MACRO_API_MODULE_SPECIFIER) {
          return {
            resolvedFileName: MACRO_API_MODULE_FILE,
            extension: ts.Extension.Dts,
            isExternalLibraryImport: true,
          };
        }

        if (delegated?.[index]) {
          return delegated[index];
        }

        const resolved = ts.resolveModuleName(
          moduleName,
          containingFile,
          options ?? {},
          fallbackHost,
          undefined,
          redirectedReference,
        );
        return resolved.resolvedModule;
      });
    },
    resolveModuleNameLiterals(
      moduleLiterals,
      containingFile,
      redirectedReference,
      options,
      containingSourceFile,
      reusedNames,
    ) {
      const fallbackHost = createModuleResolutionHost(baseHost);
      const delegated = baseHost.resolveModuleNameLiterals?.(
        moduleLiterals,
        containingFile,
        redirectedReference,
        options,
        containingSourceFile,
        reusedNames,
      );

      return moduleLiterals.map((moduleLiteral, index) => {
        if (moduleLiteral.text === MACRO_API_MODULE_SPECIFIER) {
          return {
            resolvedModule: {
              resolvedFileName: MACRO_API_MODULE_FILE,
              extension: ts.Extension.Dts,
              isExternalLibraryImport: true,
            },
          };
        }

        if (delegated?.[index]) {
          return delegated[index]!;
        }

        return {
          resolvedModule: ts.resolveModuleName(
            moduleLiteral.text,
            containingFile,
            options ?? {},
            fallbackHost,
            undefined,
            redirectedReference,
          ).resolvedModule,
        };
      });
    },
  };
}
