import { assertExists, assertStringIncludes } from '@std/assert';
import ts from 'typescript';

import { dirname, join } from '../platform/path.ts';
import { captureTypeScriptDeclarationOutputs } from './typescript_effect_declarations.ts';

async function withTempProgram(
  files: Readonly<Record<string, string>>,
  run: (program: ts.Program, tempDirectory: string) => void | Promise<void>,
): Promise<void> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'soundscript-effect-decls-' });
  try {
    for (const [relativePath, text] of Object.entries(files)) {
      const filePath = join(tempDirectory, relativePath);
      await Deno.mkdir(dirname(filePath), { recursive: true }).catch(() => undefined);
      await Deno.writeTextFile(filePath, text);
    }

    const options: ts.CompilerOptions = {
      declaration: true,
      emitDeclarationOnly: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      outDir: '/__effect_decl_test__',
      strict: true,
      target: ts.ScriptTarget.ES2022,
    };
    const host = ts.createCompilerHost(options, true);
    const program = ts.createProgram(
      Object.keys(files).map((relativePath) => join(tempDirectory, relativePath)),
      options,
      host,
    );
    await run(program, tempDirectory);
  } finally {
    await Deno.remove(tempDirectory, { recursive: true }).catch(() => undefined);
  }
}

Deno.test('captureTypeScriptDeclarationOutputs projects inferred bodyful effects into declarations', async () => {
  await withTempProgram(
    {
      'src/index.ts': [
        'export function logValue<T>(value: T): T {',
        '  throw new Error(String(value));',
        '}',
        '',
      ].join('\n'),
    },
    (program, tempDirectory) => {
      const outputs = captureTypeScriptDeclarationOutputs(program, { workingDirectory: tempDirectory });
      const declarationText = outputs.get('/__effect_decl_test__/index.d.ts');
      assertExists(declarationText);
      assertStringIncludes(declarationText, '// #[effects(add: [fails.throws], unknown: [direct])]');
      assertStringIncludes(declarationText, 'export declare function logValue<T>(value: T): T;');
    },
  );
});

Deno.test('captureTypeScriptDeclarationOutputs projects implementation summaries onto overload declarations', async () => {
  await withTempProgram(
    {
      'src/index.ts': [
        'export function wrap(callback: () => string): string;',
        'export function wrap(callback: () => number): number;',
        'export function wrap(',
        '  // #[effects(forbid: [fails])]',
        '  callback: () => string | number,',
        '): string | number {',
        '  return callback();',
        '}',
        '',
      ].join('\n'),
    },
    (program, tempDirectory) => {
      const outputs = captureTypeScriptDeclarationOutputs(program, { workingDirectory: tempDirectory });
      const declarationText = outputs.get('/__effect_decl_test__/index.d.ts');
      assertExists(declarationText);
      assertStringIncludes(declarationText, '// #[effects(add: [], forward: [callback])]');
      assertStringIncludes(declarationText, '// #[effects(forbid: [fails])]');
      assertStringIncludes(declarationText, 'export declare function wrap(');
    },
  );
});
