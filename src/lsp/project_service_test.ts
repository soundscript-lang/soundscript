import { assert, assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert';
import { dirname, join, toFileUrl } from '@std/path';

import type { MergedDiagnostic } from '../checker/diagnostics.ts';
import {
  analyzeOpenDocument,
  codeActionsOpenDocument,
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

function openSessionDocument(uri: string, text: string): SessionState {
  const session = new SessionState();
  session.open({
    uri,
    languageId: 'soundscript',
    version: 1,
    text,
  });
  return session;
}

function toCodeActionDiagnostics(
  diagnostics: readonly MergedDiagnostic[],
): Array<{
  code: string;
  data?: {
    hint?: string;
    metadata?: MergedDiagnostic['metadata'];
    notes?: string[];
  };
  message: string;
  range: {
    end: { character: number; line: number };
    start: { character: number; line: number };
  };
}> {
  return diagnostics.map((diagnostic) => {
    const startLine = Math.max((diagnostic.line ?? 1) - 1, 0);
    const startCharacter = Math.max((diagnostic.column ?? 1) - 1, 0);
    const endLine = Math.max((diagnostic.endLine ?? diagnostic.line ?? 1) - 1, startLine);
    const rawEndCharacter = diagnostic.endColumn !== undefined
      ? Math.max(diagnostic.endColumn - 1, 0)
      : endLine === startLine
      ? startCharacter + 1
      : 0;
    const details: string[] = [];
    for (const note of diagnostic.notes ?? []) {
      details.push(`Note: ${note}`);
    }
    if (diagnostic.hint) {
      details.push(`Hint: ${diagnostic.hint}`);
    }

    return {
      code: diagnostic.code,
      data: diagnostic.notes || diagnostic.hint
        ? {
          notes: diagnostic.notes,
          hint: diagnostic.hint,
          metadata: diagnostic.metadata,
        }
        : diagnostic.metadata
        ? { metadata: diagnostic.metadata }
        : undefined,
      message: [diagnostic.message, ...details].join('\n\n'),
      range: {
        start: { line: startLine, character: startCharacter },
        end: {
          line: endLine,
          character: endLine === startLine
            ? Math.max(rawEndCharacter, startCharacter + 1)
            : rawEndCharacter,
        },
      },
    };
  });
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

Deno.test('project service analyzes configured TypeScript files from soundscript.include as soundscript', async () => {
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.ts'],
        soundscript: {
          include: ['src/**/*.ts'],
        },
      },
      null,
      2,
    ),
    'src/demo.ts': 'console.log(42);\n',
  });

  const session = new SessionState();
  const uri = toFileUrl(join(tempDirectory, 'src/demo.ts')).href;
  session.open({
    uri,
    languageId: 'typescript',
    version: 1,
    text: 'console.log(42);\n',
  });

  const analyzed = await analyzeOpenDocument(uri, session);
  assert(analyzed !== null);
  assertEquals(analyzed.diagnostics.some((diagnostic) => diagnostic.code === 'SOUND1039'), true);

  const preparedProject = getPreparedProjectForTest(uri, session, 'sts-local');
  assert(preparedProject !== null);
  assertEquals(preparedProject.isSoundscriptSourceFile(join(tempDirectory, 'src/demo.ts')), true);
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

Deno.test('project service offers a SOUND1020 quick fix to capture narrowed members before call boundaries', async () => {
  const text = [
    '// #[extern]',
    'declare function mutate(box: { value: string | null }): void;',
    '',
    'function use(box: { value: string | null }) {',
    '  if (box.value !== null) {',
    '    mutate(box);',
    '    const value: string = box.value;',
    '    return value;',
    '  }',
    '  return "";',
    '}',
    '',
  ].join('\n');
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': text,
  });

  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const session = openSessionDocument(uri, text);
  const analyzed = analyzeOpenDocument(uri, session);

  assertEquals(analyzed.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1020']);
  assertEquals(analyzed.diagnostics[0]?.metadata?.primarySymbol, 'box.value');
  assertEquals(analyzed.diagnostics[0]?.metadata?.secondarySymbol, 'call');

  const actions = codeActionsOpenDocument(uri, toCodeActionDiagnostics(analyzed.diagnostics), session);
  const action = actions?.find((entry) =>
    entry.title === 'Capture `box.value` into `boxValue` before the call boundary'
  );
  assert(action);
  assertEquals(action.edit?.changes?.[uri], [
    {
      newText: '  const boxValue = box.value;\n',
      range: {
        start: { line: 4, character: 0 },
        end: { line: 4, character: 0 },
      },
    },
    {
      newText: 'boxValue',
      range: {
        start: { line: 4, character: 6 },
        end: { line: 4, character: 15 },
      },
    },
    {
      newText: 'boxValue',
      range: {
        start: { line: 6, character: 26 },
        end: { line: 6, character: 35 },
      },
    },
  ]);
});

Deno.test('project service offers a SOUND1020 quick fix to capture narrowed members before await boundaries', async () => {
  const text = [
    '// #[extern]',
    'declare function refresh(): Promise<void>;',
    '',
    'async function use(box: { value: string | null }) {',
    '  if (box.value !== null) {',
    '    await refresh();',
    '    return box.value.length;',
    '  }',
    '  return 0;',
    '}',
    '',
  ].join('\n');
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': text,
  });

  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const session = openSessionDocument(uri, text);
  const analyzed = analyzeOpenDocument(uri, session);

  assertEquals(analyzed.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1020']);
  assertEquals(analyzed.diagnostics[0]?.metadata?.secondarySymbol, 'suspension');

  const actions = codeActionsOpenDocument(uri, toCodeActionDiagnostics(analyzed.diagnostics), session);
  const action = actions?.find((entry) =>
    entry.title === 'Capture `box.value` into `boxValue` before the await boundary'
  );
  assert(action);
  assertEquals(action.edit?.changes?.[uri], [
    {
      newText: '  const boxValue = box.value;\n',
      range: {
        start: { line: 4, character: 0 },
        end: { line: 4, character: 0 },
      },
    },
    {
      newText: 'boxValue',
      range: {
        start: { line: 4, character: 6 },
        end: { line: 4, character: 15 },
      },
    },
    {
      newText: 'boxValue',
      range: {
        start: { line: 6, character: 11 },
        end: { line: 6, character: 20 },
      },
    },
  ]);
});

Deno.test('project service offers a SOUND1020 quick fix to capture narrowed members before callback boundaries', async () => {
  const text = [
    'function use(box: { value: string | null }, items: readonly number[]) {',
    '  if (box.value !== null) {',
    '    items.forEach(() => {',
    '      const value: string = box.value;',
    '      void value;',
    '    });',
    '  }',
    '}',
    '',
  ].join('\n');
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': text,
  });

  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const session = openSessionDocument(uri, text);
  const actions = codeActionsOpenDocument(
    uri,
    [{
      code: 'SOUND1020',
      data: {
        metadata: {
          primarySymbol: 'box.value',
          secondarySymbol: 'callback',
        },
      },
      message: 'Narrowing was invalidated',
      range: {
        start: { line: 2, character: 4 },
        end: { line: 2, character: 24 },
      },
    }],
    session,
  );
  const action = actions?.find((entry) =>
    entry.title === 'Capture `box.value` into `boxValue` before the callback boundary'
  );
  assert(action);
  assertEquals(action.edit?.changes?.[uri], [
    {
      newText: '  const boxValue = box.value;\n',
      range: {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 },
      },
    },
    {
      newText: 'boxValue',
      range: {
        start: { line: 1, character: 6 },
        end: { line: 1, character: 15 },
      },
    },
    {
      newText: 'boxValue',
      range: {
        start: { line: 3, character: 28 },
        end: { line: 3, character: 37 },
      },
    },
  ]);
});

Deno.test('project service skips SOUND1020 capture quick fixes for non-literal computed paths', async () => {
  const text = [
    '// #[extern]',
    'declare function mutate(box: Record<string, string | null>): void;',
    '',
    'function use(box: Record<string, string | null>, key: string) {',
    '  if (box[key] !== null) {',
    '    mutate(box);',
    '    const value: string = box[key];',
    '    return value;',
    '  }',
    '  return "";',
    '}',
    '',
  ].join('\n');
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': text,
  });

  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const session = openSessionDocument(uri, text);
  const actions = codeActionsOpenDocument(
    uri,
    [{
      code: 'SOUND1020',
      data: {
        metadata: {
          primarySymbol: 'box[key]',
          secondarySymbol: 'call',
        },
      },
      message: 'Narrowing was invalidated',
      range: {
        start: { line: 5, character: 4 },
        end: { line: 5, character: 15 },
      },
    }],
    session,
  );
  const captureAction = actions?.find((entry) => entry.title.includes('Capture `box[key]`'));
  assertEquals(captureAction, undefined);
});

Deno.test('project service suffixes captured SOUND1020 locals when the preferred name is already taken', async () => {
  const text = [
    '// #[extern]',
    'declare function mutate(box: { value: string | null }): void;',
    '',
    'function use(box: { value: string | null }) {',
    '  const boxValue = "taken";',
    '  if (box.value !== null) {',
    '    mutate(box);',
    '    const value: string = box.value;',
    '    return value + boxValue;',
    '  }',
    '  return boxValue;',
    '}',
    '',
  ].join('\n');
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': text,
  });

  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const session = openSessionDocument(uri, text);
  const analyzed = analyzeOpenDocument(uri, session);

  const actions = codeActionsOpenDocument(uri, toCodeActionDiagnostics(analyzed.diagnostics), session);
  const action = actions?.find((entry) =>
    entry.title === 'Capture `box.value` into `boxValue2` before the call boundary'
  );
  assert(action);
  assertEquals(action.edit?.changes?.[uri]?.[0], {
    newText: '  const boxValue2 = box.value;\n',
    range: {
      start: { line: 5, character: 0 },
      end: { line: 5, character: 0 },
    },
  });
});

Deno.test('project service offers a SOUND1019 quick fix to make widened array types readonly', async () => {
  const text = [
    'interface Animal {',
    '  name: string;',
    '}',
    '',
    'interface Dog extends Animal {',
    '  breed: string;',
    '}',
    '',
    'const dogs: Dog[] = [{ name: "Rex", breed: "Lab" }];',
    'const animals: Animal[] = dogs;',
    '',
  ].join('\n');
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': text,
  });

  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const session = openSessionDocument(uri, text);
  const analyzed = analyzeOpenDocument(uri, session);

  assertEquals(analyzed.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
  const actions = codeActionsOpenDocument(uri, toCodeActionDiagnostics(analyzed.diagnostics), session);
  const action = actions?.find((entry) => entry.title === 'Make array type readonly');
  assert(action);
  assertEquals(action.edit?.changes?.[uri]?.[0], {
    newText: 'readonly Animal[]',
    range: {
      start: { line: 9, character: 15 },
      end: { line: 9, character: 23 },
    },
  });
});

Deno.test('project service offers a SOUND1019 quick fix to rewrite Array<T> as ReadonlyArray<T>', async () => {
  const text = [
    'interface Animal {',
    '  name: string;',
    '}',
    '',
    'interface Dog extends Animal {',
    '  breed: string;',
    '}',
    '',
    'const dogs: Array<Dog> = [{ name: "Rex", breed: "Lab" }];',
    'const animals: Array<Animal> = dogs;',
    '',
  ].join('\n');
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': text,
  });

  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const session = openSessionDocument(uri, text);
  const analyzed = analyzeOpenDocument(uri, session);

  const actions = codeActionsOpenDocument(uri, toCodeActionDiagnostics(analyzed.diagnostics), session);
  const action = actions?.find((entry) => entry.title === 'Make array type readonly');
  assert(action);
  assertEquals(action.edit?.changes?.[uri]?.[0], {
    newText: 'ReadonlyArray<Animal>',
    range: {
      start: { line: 9, character: 15 },
      end: { line: 9, character: 28 },
    },
  });
});

Deno.test('project service offers a SOUND1019 quick fix to make writable target properties readonly', async () => {
  const text = [
    'interface Animal { name: string; }',
    'interface Dog extends Animal { breed: string; }',
    'interface Kennel {',
    '  animals: Animal[];',
    '}',
    'const dogs: Dog[] = [];',
    'const kennel: Kennel = { animals: dogs };',
    '',
  ].join('\n');
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/demo.sts': text,
  });

  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const session = openSessionDocument(uri, text);
  const analyzed = analyzeOpenDocument(uri, session);

  assertEquals(analyzed.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
  assertEquals(analyzed.diagnostics[0]?.message, "Writable property 'animals' is invariant in soundscript.");
  const actions = codeActionsOpenDocument(uri, toCodeActionDiagnostics(analyzed.diagnostics), session);
  const action = actions?.find((entry) => entry.title === "Make 'animals' readonly");
  assert(action);
  assertEquals(action.edit?.changes?.[uri]?.[0], {
    newText: 'readonly ',
    range: {
      start: { line: 3, character: 2 },
      end: { line: 3, character: 2 },
    },
  });
});

Deno.test('project service offers a SOUND1019 quick fix to make writable class fields readonly', async () => {
  const text = [
    'interface KennelLike {',
    '  animals: Animal[];',
    '}',
    'class DogKennel implements KennelLike {',
    '  animals: Dog[] = [];',
    '}',
    '',
  ].join('\n');
  const uri = 'file:///virtual/demo.sts';
  const session = openSessionDocument(uri, text);
  const actions = codeActionsOpenDocument(
    uri,
    [{
      code: 'SOUND1019',
      message: "Writable property 'animals' is invariant in soundscript.",
      range: {
        start: { line: 4, character: 2 },
        end: { line: 4, character: 19 },
      },
    }],
    session,
  );
  const action = actions?.find((entry) => entry.title === "Make 'animals' readonly");
  assert(action);
  assertEquals(action.edit?.changes?.[uri]?.[0], {
    newText: 'readonly ',
    range: {
      start: { line: 4, character: 2 },
      end: { line: 4, character: 2 },
    },
  });
});

Deno.test('project service skips SOUND1019 readonly quick fixes when the mutable edge lives in another file', async () => {
  const text = [
    'import type { Dog, Kennel } from "./types";',
    '',
    'const dogs: Dog[] = [];',
    'const kennel: Kennel = { animals: dogs };',
    'void kennel;',
    '',
  ].join('\n');
  const tempDirectory = await createTempProject({
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'ESNext',
        },
        include: ['src/**/*.sts'],
      },
      null,
      2,
    ),
    'src/types.sts': [
      'export interface Animal { name: string; }',
      'export interface Dog extends Animal { breed: string; }',
      'export interface Kennel {',
      '  animals: Animal[];',
      '}',
      '',
    ].join('\n'),
    'src/demo.sts': text,
  });

  const uri = toFileUrl(join(tempDirectory, 'src/demo.sts')).href;
  const session = openSessionDocument(uri, text);
  const analyzed = analyzeOpenDocument(uri, session);

  assertEquals(analyzed.diagnostics.map((diagnostic) => diagnostic.code), ['SOUND1019']);
  const actions = codeActionsOpenDocument(uri, toCodeActionDiagnostics(analyzed.diagnostics), session);
  const action = actions?.find((entry) => entry.title === "Make 'animals' readonly");
  assertEquals(action, undefined);
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
