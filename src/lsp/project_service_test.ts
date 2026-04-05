import { assert, assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert';
import { dirname, join, toFileUrl } from '@std/path';

import {
  analyzeOpenDocument,
  getPreparedProjectForTest,
  referencesOpenDocument,
} from './project_service.ts';
import { SessionState } from './session.ts';

async function createTempProject(files: Record<string, string>): Promise<string> {
  const tempDirectory = await Deno.makeTempDir();
  for (const [relativePath, text] of Object.entries(files)) {
    const filePath = join(tempDirectory, relativePath);
    await Deno.mkdir(dirname(filePath), { recursive: true });
    await Deno.writeTextFile(filePath, text);
  }

  return tempDirectory;
}

Deno.test('project service reuses prepared sts-local analysis state across open-document version changes', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helper.ts': 'export const helper = 1;\n',
    'src/other.sts': 'export const other = 1;\n',
    'src/demo.sts': 'export const value = 1;\n',
  });

  const session = new SessionState();
  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  session.open({
    uri,
    languageId: 'soundscript',
    version: 1,
    text: 'export const value = 1;\n',
  });

  const initialPreparedProject = getPreparedProjectForTest(uri, session, 'sts-local');
  assert(initialPreparedProject !== null);
  assert(initialPreparedProject.stsView !== null);
  const otherSourcePath = join(tempDirectory, 'src/other.sts');
  assert(
    initialPreparedProject.stsView.preparedProgram.preparedHost.getPreparedSourceFile(otherSourcePath) !==
      undefined,
  );

  session.update(uri, 2, 'export const value = 2;\n');

  const updatedPreparedProject = getPreparedProjectForTest(uri, session, 'sts-local');
  assert(updatedPreparedProject !== null);
  assert(updatedPreparedProject.stsView !== null);

  assertNotEquals(updatedPreparedProject, initialPreparedProject);
  assertEquals(
    updatedPreparedProject.stsCompilerHostReuseState,
    initialPreparedProject.stsCompilerHostReuseState,
  );
  assertEquals(
    updatedPreparedProject.stsView.preparedProgram.preparedHost.getPreparedSourceFile(otherSourcePath),
    initialPreparedProject.stsView.preparedProgram.preparedHost.getPreparedSourceFile(otherSourcePath),
  );
});

Deno.test('project service keeps full and sts-local prepared state cached independently', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/helper.ts': 'export const helper = 1;\n',
    'src/demo.sts': 'export const value = helper;\n',
  });

  const session = new SessionState();
  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  session.open({
    uri,
    languageId: 'soundscript',
    version: 1,
    text: "import { helper } from './helper';\nexport const value = helper;\n",
  });

  const initialLocalPreparedProject = getPreparedProjectForTest(uri, session, 'sts-local');
  assert(initialLocalPreparedProject !== null);
  assert(initialLocalPreparedProject.stsView !== null);
  assert(initialLocalPreparedProject.tsView === null);

  const fullPreparedProject = getPreparedProjectForTest(uri, session, 'full');
  assert(fullPreparedProject !== null);
  assert(fullPreparedProject.tsView !== null);

  const localPreparedProjectAfterFull = getPreparedProjectForTest(uri, session, 'sts-local');
  assert(localPreparedProjectAfterFull !== null);
  assert(Object.is(localPreparedProjectAfterFull, initialLocalPreparedProject));
});

Deno.test('project service allows pure type-only .sts imports from local .ts modules', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/types.ts': 'export type Environment = "dev" | "prd";\n',
    'src/demo.sts':
      "import type { Environment } from './types.ts';\nexport type Current = Environment;\n",
  });

  const session = new SessionState();
  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  session.open({
    uri,
    languageId: 'soundscript',
    version: 1,
    text: "import type { Environment } from './types.ts';\nexport type Current = Environment;\n",
  });

  const analyzed = analyzeOpenDocument(uri, session);
  assertEquals(analyzed.diagnostics, []);
});

Deno.test('project service diagnostics ignore commented-out macro code', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': [
      'export const value = 1;',
      '',
      "// import { Match, Try } from 'sts:prelude';",
      '// function commented() {',
      '//   return Match(value, [',
      '//     (_value: number) => true,',
      '//   ]);',
      '// }',
      '',
    ].join('\n'),
  });

  const session = new SessionState();
  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  session.open({
    uri,
    languageId: 'soundscript',
    version: 1,
    text: [
      'export const value = 1;',
      '',
      "// import { Match, Try } from 'sts:prelude';",
      '// function commented() {',
      '//   return Match(value, [',
      '//     (_value: number) => true,',
      '//   ]);',
      '// }',
      '',
    ].join('\n'),
  });

  const analyzed = analyzeOpenDocument(uri, session);
  assertEquals(analyzed.diagnostics, []);
});

Deno.test('project service logs macro cache reuse for incremental macro-backed rebuilds', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/macros.ts': [
      "import 'sts:macros';",
      '',
      '// #[macro(call)]',
      'export function Foo() {',
      '  return {',
      '    expand(ctx) {',
      '      return ctx.output.expr(ctx.quote.expr`1`);',
      '    },',
      '  };',
      '}',
      '',
    ].join('\n'),
    'src/demo.sts': "import { Foo } from './macros';\nexport const value = Foo();\n",
  });

  const session = new SessionState();
  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  session.open({
    uri,
    languageId: 'soundscript',
    version: 1,
    text: "import { Foo } from './macros';\nexport const value = Foo();\n",
  });

  const originalTimingEnv = Deno.env.get('SOUNDSCRIPT_LSP_TIMING');
  const originalError = console.error;
  const logs: string[] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    Deno.env.set('SOUNDSCRIPT_LSP_TIMING', '1');

    const initialPreparedProject = getPreparedProjectForTest(uri, session, 'sts-local');
    assert(initialPreparedProject !== null);
    assert(initialPreparedProject.stsView !== null);
    assertEquals(initialPreparedProject.stsView.macroCacheStats.moduleCacheHits >= 0, true);
    assertEquals(initialPreparedProject.stsView.macroCacheStats.moduleCacheMisses >= 0, true);

    session.update(uri, 2, "import { Foo } from './macros';\nexport const value = Foo( );\n");

    const rebuiltPreparedProject = getPreparedProjectForTest(uri, session, 'sts-local');
    assert(rebuiltPreparedProject !== null);
    assert(rebuiltPreparedProject.stsView !== null);
    assertEquals(rebuiltPreparedProject.stsView.macroCacheStats.moduleCacheHits >= 0, true);
    assertEquals(rebuiltPreparedProject.stsView.macroCacheStats.moduleCacheMisses, 0);

    const prepareLogs = logs.filter((line) => line.includes('[soundscript:lsp] project.prepare '));
    assertEquals(prepareLogs.length >= 2, true);
    assertStringIncludes(prepareLogs[0]!, 'macroCacheHits=');
    assertStringIncludes(prepareLogs[0]!, 'macroCacheMisses=');
    assertStringIncludes(prepareLogs[1]!, 'macroCacheHits=');
    assertStringIncludes(prepareLogs[1]!, 'macroCacheMisses=');
  } finally {
    if (originalTimingEnv === undefined) {
      Deno.env.delete('SOUNDSCRIPT_LSP_TIMING');
    } else {
      Deno.env.set('SOUNDSCRIPT_LSP_TIMING', originalTimingEnv);
    }
    console.error = originalError;
  }
});

Deno.test('project service finds local references inside .sts block scopes', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: ['src/**/*.ts', 'src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': [
      'declare function run(body: () => void): void;',
      'function wrap(): void {',
      '  run(() => {',
      '    const value = 1;',
      '    void value;',
      '    value;',
      '  });',
      '}',
      '',
    ].join('\n'),
  });

  const session = new SessionState();
  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const text = Deno.readTextFileSync(join(tempDirectory, 'src/demo.sts'));
  session.open({
    uri,
    languageId: 'soundscript',
    version: 1,
    text,
  });

  const references = referencesOpenDocument(
    uri,
    4,
    text.split('\n')[4]!.indexOf('value'),
    session,
    true,
  );

  assertEquals(references?.length, 3);
  assertEquals(references?.map((reference) => reference.range.start.line), [3, 4, 5]);
});
