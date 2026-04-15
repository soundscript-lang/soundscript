import ts from 'typescript';

import { loadConfig } from '../project/config.ts';
import {
  collectRuntimeSemanticClosure,
  createRuntimeSemanticProgram,
} from './semantic_closure.ts';
import {
  detectRuntimeTypeScriptSupport,
  emitTypeScriptModuleDirect,
  runtimeRequiresJavaScriptFallback,
  transpileTypeScriptModuleToEsm,
} from './transform.ts';

export function transformWithLegacySemanticRuntimeProgram(
  projectPath: string,
  fileName: string,
): { code: string; mapText: string } {
  const loadedConfig = loadConfig(projectPath);
  const closure = collectRuntimeSemanticClosure(
    {
      loadedConfig,
      projectPath,
    },
    [fileName],
  );
  const expandedProgram = createRuntimeSemanticProgram(
    {
      loadedConfig,
      projectPath,
    },
    closure.rootNames,
  );
  try {
    const programFileName = expandedProgram.preparedProgram.toProgramFileName(fileName);
    const expandedSourceFile = expandedProgram.program.getSourceFile(programFileName);
    if (!expandedSourceFile) {
      throw new Error(`Missing expanded source file for ${fileName}.`);
    }
    const sourceText = ts.createPrinter().printFile(expandedSourceFile);
    const runtimeTypeScriptSupport = detectRuntimeTypeScriptSupport();
    return runtimeTypeScriptSupport !== false &&
        !runtimeRequiresJavaScriptFallback(sourceText, fileName)
      ? emitTypeScriptModuleDirect(
        fileName,
        sourceText,
        {
          moduleSpecifierMode: 'preserve',
          target: ts.ScriptTarget.ES2022,
        },
      )
      : transpileTypeScriptModuleToEsm(
        fileName,
        `${fileName}.js`,
        sourceText,
        {
          module: ts.ModuleKind.ES2022,
          moduleSpecifierMode: 'preserve',
          target: ts.ScriptTarget.ES2022,
        },
      );
  } finally {
    expandedProgram.dispose();
  }
}

export function materializeWithLegacySemanticRuntimeProgram(
  projectPath: string,
  fileName: string,
  outputFileName: string,
): { code: string; mapText: string } {
  const loadedConfig = loadConfig(projectPath);
  const closure = collectRuntimeSemanticClosure(
    {
      loadedConfig,
      projectPath,
    },
    [fileName],
  );
  const expandedProgram = createRuntimeSemanticProgram(
    {
      loadedConfig,
      projectPath,
    },
    closure.rootNames,
  );
  try {
    const programFileName = expandedProgram.preparedProgram.toProgramFileName(fileName);
    const expandedSourceFile = expandedProgram.program.getSourceFile(programFileName);
    if (!expandedSourceFile) {
      throw new Error(`Missing expanded source file for ${fileName}.`);
    }
    return transpileTypeScriptModuleToEsm(
      fileName,
      outputFileName,
      ts.createPrinter().printFile(expandedSourceFile),
      {
        module: ts.ModuleKind.ES2022,
        moduleSpecifierMode: 'emit-js',
        target: ts.ScriptTarget.ES2022,
      },
    );
  } finally {
    expandedProgram.dispose();
  }
}
