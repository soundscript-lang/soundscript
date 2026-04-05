import ts from 'typescript';

import {
  ASYNC_STDLIB_DECLARATION_FILE,
  ASYNC_STDLIB_DECLARATION_TEXT,
  CODEC_STDLIB_DECLARATION_FILE,
  CODEC_STDLIB_DECLARATION_TEXT,
  COMPARE_STDLIB_DECLARATION_FILE,
  COMPARE_STDLIB_DECLARATION_TEXT,
  DECODE_STDLIB_DECLARATION_FILE,
  DECODE_STDLIB_DECLARATION_TEXT,
  DERIVE_STDLIB_DECLARATION_FILE,
  DERIVE_STDLIB_DECLARATION_TEXT,
  HASH_STDLIB_DECLARATION_FILE,
  HASH_STDLIB_DECLARATION_TEXT,
  HKT_STDLIB_DECLARATION_FILE,
  HKT_STDLIB_DECLARATION_TEXT,
  JSON_STDLIB_DECLARATION_FILE,
  JSON_STDLIB_DECLARATION_TEXT,
  MATCH_STDLIB_DECLARATION_FILE,
  MATCH_STDLIB_DECLARATION_TEXT,
  RESULT_STDLIB_DECLARATION_FILE,
  RESULT_STDLIB_DECLARATION_TEXT,
  STDLIB_DECLARATION_FILE,
  STDLIB_DECLARATION_TEXT,
  withStdPackageModuleResolution,
} from './std_package_support.ts';
import {
  ERROR_STDLIB_DECLARATION_FILE,
  ERROR_STDLIB_DECLARATION_TEXT,
  withErrorStdlibModuleResolution,
} from './error_stdlib_support.ts';
import {
  SQL_STDLIB_DECLARATION_FILE,
  SQL_STDLIB_DECLARATION_TEXT,
  withSqlStdlibModuleResolution,
} from './sql_stdlib_support.ts';
import {
  getAlwaysAvailableBuiltinMacroSiteKinds,
  getBuiltinMacroSiteKindsBySpecifier,
} from './builtin_macro_support.ts';
import { createPreparedProgram } from './project_frontend.ts';

interface CreatePreparedProgramForMacroTestOptions {
  readonly importedMacroSiteKindsBySpecifier?: ReadonlyMap<
    string,
    ReadonlyMap<string, import('./project_frontend.ts').ImportedMacroSiteKind>
  >;
}

function createBaseHost(files: ReadonlyMap<string, string>): ts.CompilerHost {
  const baseHost = ts.createCompilerHost({
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
  });

  return withSqlStdlibModuleResolution(
    withErrorStdlibModuleResolution(
      withStdPackageModuleResolution({
        ...baseHost,
        fileExists(fileName: string): boolean {
          return files.has(fileName) || baseHost.fileExists(fileName);
        },
        readFile(fileName: string): string | undefined {
          return files.get(fileName) ?? baseHost.readFile(fileName);
        },
      }),
    ),
  );
}

export function createPreparedProgramForMacroTest(
  files: Readonly<Record<string, string>>,
  options: CreatePreparedProgramForMacroTestOptions = {},
) {
  const fileMap = new Map(Object.entries(files));
  if (!fileMap.has(STDLIB_DECLARATION_FILE)) {
    fileMap.set(STDLIB_DECLARATION_FILE, STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(HKT_STDLIB_DECLARATION_FILE)) {
    fileMap.set(HKT_STDLIB_DECLARATION_FILE, HKT_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(RESULT_STDLIB_DECLARATION_FILE)) {
    fileMap.set(RESULT_STDLIB_DECLARATION_FILE, RESULT_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(MATCH_STDLIB_DECLARATION_FILE)) {
    fileMap.set(MATCH_STDLIB_DECLARATION_FILE, MATCH_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(JSON_STDLIB_DECLARATION_FILE)) {
    fileMap.set(JSON_STDLIB_DECLARATION_FILE, JSON_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(COMPARE_STDLIB_DECLARATION_FILE)) {
    fileMap.set(COMPARE_STDLIB_DECLARATION_FILE, COMPARE_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(HASH_STDLIB_DECLARATION_FILE)) {
    fileMap.set(HASH_STDLIB_DECLARATION_FILE, HASH_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(DERIVE_STDLIB_DECLARATION_FILE)) {
    fileMap.set(DERIVE_STDLIB_DECLARATION_FILE, DERIVE_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(DECODE_STDLIB_DECLARATION_FILE)) {
    fileMap.set(DECODE_STDLIB_DECLARATION_FILE, DECODE_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(CODEC_STDLIB_DECLARATION_FILE)) {
    fileMap.set(CODEC_STDLIB_DECLARATION_FILE, CODEC_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(ASYNC_STDLIB_DECLARATION_FILE)) {
    fileMap.set(ASYNC_STDLIB_DECLARATION_FILE, ASYNC_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(ERROR_STDLIB_DECLARATION_FILE)) {
    fileMap.set(ERROR_STDLIB_DECLARATION_FILE, ERROR_STDLIB_DECLARATION_TEXT);
  }
  if (!fileMap.has(SQL_STDLIB_DECLARATION_FILE)) {
    fileMap.set(SQL_STDLIB_DECLARATION_FILE, SQL_STDLIB_DECLARATION_TEXT);
  }
  return createPreparedProgram({
    alwaysAvailableMacroSiteKinds: getAlwaysAvailableBuiltinMacroSiteKinds(),
    baseHost: createBaseHost(fileMap),
    importedMacroSiteKindsBySpecifier: new Map([
      ...getBuiltinMacroSiteKindsBySpecifier().entries(),
      ...(options.importedMacroSiteKindsBySpecifier ?? new Map()).entries(),
    ]),
    options: {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
    rootNames: [...fileMap.keys()],
  });
}

export function printSourceFileForMacroTest(sourceFile: ts.SourceFile): string {
  return ts.createPrinter().printFile(sourceFile);
}
