import { assertEquals, assertExists, assertStrictEquals } from '@std/assert';
import { dirname, join } from '@std/path';
import ts from 'typescript';

import { getEffectSummaryForDeclaration, INTERNAL_EFFECT_MASKS } from './checker/effects.ts';
import { createAnalysisContext } from './checker/engine/context.ts';

interface TempProjectFile {
  path: string;
  contents: string;
}

async function createTempProject(files: TempProjectFile[]): Promise<string> {
  const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-tsc-engine-' });

  for (const file of files) {
    const absolutePath = join(tempDirectory, file.path);
    await Deno.mkdir(dirname(absolutePath), { recursive: true });
    await Deno.writeTextFile(absolutePath, file.contents);
  }

  return tempDirectory;
}

function loadProgram(projectPath: string): ts.Program {
  const configFile = ts.readConfigFile(projectPath, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(projectPath),
    undefined,
    projectPath,
  );

  return ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
    projectReferences: parsedConfig.projectReferences,
    configFileParsingDiagnostics: parsedConfig.errors,
  });
}

Deno.test('createAnalysisContext exposes stable identities and cached fact queries', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export interface Box {',
        '  value?: string;',
        '}',
        '',
        'export function readBox(box: Box): number {',
        '  return box.value ? box.value.length : 0;',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));
  const visitedSourceFiles: string[] = [];
  const visitedDeclarations: string[] = [];

  assertExists(sourceFile);

  context.forEachSourceFile((currentSourceFile) => {
    visitedSourceFiles.push(currentSourceFile.fileName);
  });
  context.traverse(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isFunctionDeclaration(node)) {
      visitedDeclarations.push(node.name?.text ?? '<anonymous>');
    }
  });

  const functionDeclaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  assertExists(functionDeclaration);
  assertExists(functionDeclaration.name);

  assertEquals(visitedSourceFiles.length, 1);
  assertEquals(visitedDeclarations, ['Box', 'readBox']);

  const symbol = context.checker.getSymbolAtLocation(functionDeclaration.name);
  assertExists(symbol);

  const nodeId = context.getNodeId(functionDeclaration);
  assertEquals(context.getNodeId(functionDeclaration), nodeId);

  const symbolId = context.getSymbolId(symbol);
  assertEquals(context.getSymbolId(symbol), symbolId);

  let computeCount = 0;
  const provenance = context.facts.getSymbolProvenance(
    symbol,
    () => {
      computeCount += 1;
      return {
        symbolId,
        trusted: false,
        importedFrom: undefined,
        reason: 'inferred',
      };
    },
  );
  const cachedProvenance = context.facts.getSymbolProvenance(
    symbol,
    () => {
      computeCount += 1;
      return {
        symbolId,
        trusted: true,
        importedFrom: 'unexpected',
        reason: 'annotated',
      };
    },
  );

  assertStrictEquals(cachedProvenance, provenance);
  assertEquals(computeCount, 1);
});

Deno.test('createAnalysisContext indexes attached annotations and parses annotation lists', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/lib.ts',
      contents: 'export const value = 1;\n',
    },
    {
      path: 'src/index.ts',
      contents: [
        '// #[unsafe, layout.value(mode: unboxed, flags: [strict], options: { boxed: false })] explanation',
        "export const singleLine = JSON.parse('1') as number;",
        '',
        '// #[interop]',
        'import { value } from "./lib";',
        'export const imported = value;',
        '',
        '// #[extern]',
        'declare const externalValue: string;',
        '',
        '// #[variance(T: out, E: in)]',
        'export interface Result<T, E> {',
        '  readonly ok: boolean;',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const annotations = context.getAnnotationLookup(sourceFile);
  const singleLine = sourceFile.statements.find(ts.isVariableStatement);
  const importDeclaration = sourceFile.statements.find(ts.isImportDeclaration);
  const externDeclaration = sourceFile.statements.find((statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === 'externalValue'
    )
  );
  const interfaceDeclaration = sourceFile.statements.find(ts.isInterfaceDeclaration);

  assertExists(singleLine);
  assertExists(importDeclaration);
  assertExists(externDeclaration);
  assertExists(interfaceDeclaration);
  assertEquals(
    annotations.getEntriesForLine(1).map((entry: { kind: string }) => entry.kind),
    ['annotation'],
  );
  const [annotationEntry] = annotations.getEntriesForLine(1);
  if (!annotationEntry || annotationEntry.kind !== 'annotation') {
    throw new Error('Expected parsed annotation entry.');
  }
  assertEquals(
    annotationEntry.annotations.map((annotation) => ({
      arguments: annotation.arguments?.map((argument) =>
        argument.kind === 'named'
          ? {
            kind: argument.kind,
            name: argument.name,
            valueText: argument.value.text,
            valueKind: argument.value.kind,
          }
          : {
            kind: argument.kind,
            valueText: argument.value.text,
            valueKind: argument.value.kind,
          }
      ),
      argumentsText: annotation.argumentsText,
      name: annotation.name,
    })),
    [
      {
        arguments: undefined,
        argumentsText: undefined,
        name: 'unsafe',
      },
      {
        arguments: [
          {
            kind: 'named',
            name: 'mode',
            valueKind: 'identifier',
            valueText: 'unboxed',
          },
          {
            kind: 'named',
            name: 'flags',
            valueKind: 'array',
            valueText: '[strict]',
          },
          {
            kind: 'named',
            name: 'options',
            valueKind: 'object',
            valueText: '{ boxed: false }',
          },
        ],
        argumentsText: 'mode: unboxed, flags: [strict], options: { boxed: false }',
        name: 'layout.value',
      },
    ],
  );
  assertEquals(
    annotations.getAttachedAnnotations(singleLine).map((annotation) => annotation.name),
    ['unsafe', 'layout.value'],
  );
  assertEquals(
    annotations.getAttachedAnnotations(importDeclaration).map((annotation) => annotation.name),
    ['interop'],
  );
  assertEquals(
    annotations.getAttachedAnnotations(externDeclaration).map((annotation) => annotation.name),
    ['extern'],
  );
  assertEquals(
    annotations.getAttachedAnnotations(interfaceDeclaration).map((annotation) => ({
      arguments: annotation.arguments?.map((argument) =>
        argument.kind === 'named'
          ? `${argument.name}:${argument.value.text}`
          : argument.value.text
      ),
      name: annotation.name,
    })),
    [{ arguments: ['T:out', 'E:in'], name: 'variance' }],
  );
  assertEquals(annotations.hasAttachedAnnotation(singleLine, 'unsafe'), true);
  assertEquals(annotations.hasAttachedAnnotation(importDeclaration, 'interop'), true);
  assertEquals(annotations.hasAttachedAnnotation(externDeclaration, 'extern'), true);
  assertEquals(annotations.hasAttachedAnnotation(interfaceDeclaration, 'variance'), true);
});

Deno.test('createAnalysisContext only parses annotations from real comments and does not attach across gaps', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export const embedded = `',
        '// #[unsafe]',
        'not a real annotation',
        '`;',
        '',
        'export const embeddedExtern = `',
        '// #[extern]',
        'not a real annotation either',
        '`;',
        '',
        '// #[unsafe]',
        '',
        "export const detached = JSON.parse('1') as number;",
        '',
        '// #[interop]',
        '// regular comment',
        'import "./lib";',
        '',
        '// #[unsafe]',
        "export const actual = JSON.parse('2') as number;",
        '',
      ].join('\n'),
    },
    {
      path: 'src/lib.ts',
      contents: 'export {};\n',
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const annotations = context.getAnnotationLookup(sourceFile);
  const detached = sourceFile.statements.find((statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === 'detached'
    )
  );
  const actual = sourceFile.statements.find((statement) =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === 'actual'
    )
  );
  const importDeclaration = sourceFile.statements.find(ts.isImportDeclaration);

  assertExists(detached);
  assertExists(actual);
  assertExists(importDeclaration);
  assertEquals(annotations.getEntriesForLine(2), []);
  assertEquals(annotations.getEntriesForLine(7), []);
  assertEquals(annotations.hasAttachedAnnotation(detached, 'unsafe'), false);
  assertEquals(annotations.hasAttachedAnnotation(importDeclaration, 'interop'), false);
  assertEquals(annotations.hasAttachedAnnotation(actual, 'unsafe'), true);
});

Deno.test('createAnalysisContext attaches effects annotations to function-valued parameters', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function each(',
        '  values: number[],',
        '  // #[effects(forbid: [fails])]',
        '  callback: (value: number) => void,',
        '): void {',
        '  for (const value of values) {',
        '    callback(value);',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const functionDeclaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  assertExists(functionDeclaration);
  const callbackParameter = functionDeclaration.parameters[1];
  assertExists(callbackParameter);

  const annotations = context.getAnnotationLookup(sourceFile);
  assertEquals(
    annotations.getAttachedAnnotations(callbackParameter).map((annotation) => ({
      argumentsText: annotation.argumentsText,
      name: annotation.name,
    })),
    [
      {
        argumentsText: 'forbid: [fails]',
        name: 'effects',
      },
    ],
  );
});

Deno.test('createAnalysisContext summarizes Promise continuation builtins with precise forwarded effects', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function mapValue(source: Promise<number>): Promise<number> {',
        '  return source.then((value) => value + 1);',
        '}',
        '',
        'export function explodeLater(source: Promise<number>): Promise<number> {',
        '  return source.then(() => {',
        '    throw "boom";',
        '  });',
        '}',
        '',
        'export function forwardThen(',
        '  source: Promise<number>,',
        '  project: (value: number) => number,',
        '): Promise<number> {',
        '  return source.then(project);',
        '}',
        '',
        'export function recover(',
        '  source: Promise<number>,',
        '  recoverer: (error: unknown) => number,',
        '): Promise<number> {',
        '  return source.catch(recoverer);',
        '}',
        '',
        'export function finish(',
        '  source: Promise<number>,',
        '  callback: () => void,',
        '): Promise<number> {',
        '  return source.finally(callback);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const functionDeclarations = sourceFile.statements.filter(ts.isFunctionDeclaration);
  const declarationsByName = new Map(
    functionDeclarations
      .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
        declaration.name !== undefined
      )
      .map((declaration) => [declaration.name.text, declaration]),
  );

  const mapValue = declarationsByName.get('mapValue');
  const explodeLater = declarationsByName.get('explodeLater');
  const forwardThen = declarationsByName.get('forwardThen');
  const recover = declarationsByName.get('recover');
  const finish = declarationsByName.get('finish');

  assertExists(mapValue);
  assertExists(explodeLater);
  assertExists(forwardThen);
  assertExists(recover);
  assertExists(finish);

  const mapValueSummary = getEffectSummaryForDeclaration(context, mapValue);
  const explodeLaterSummary = getEffectSummaryForDeclaration(context, explodeLater);
  const forwardThenSummary = getEffectSummaryForDeclaration(context, forwardThen);
  const recoverSummary = getEffectSummaryForDeclaration(context, recover);
  const finishSummary = getEffectSummaryForDeclaration(context, finish);

  assertEquals(mapValueSummary.directMask, INTERNAL_EFFECT_MASKS.suspend);
  assertEquals(mapValueSummary.hasUnknownDirectEffects, false);
  assertEquals(mapValueSummary.forwardedParameters, []);

  assertEquals(
    explodeLaterSummary.directMask,
    INTERNAL_EFFECT_MASKS.failsRejects | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    explodeLaterSummary.directMask & INTERNAL_EFFECT_MASKS.failsThrows,
    0,
  );
  assertEquals(explodeLaterSummary.hasUnknownDirectEffects, false);

  assertEquals(forwardThenSummary.directMask, INTERNAL_EFFECT_MASKS.suspend);
  assertEquals(forwardThenSummary.forwardedParameters, [{
    failureBoundary: 'reject',
    parameterIndex: 1,
  }]);
  assertEquals(forwardThenSummary.hasUnknownDirectEffects, false);

  assertEquals(recoverSummary.directMask, INTERNAL_EFFECT_MASKS.suspend);
  assertEquals(recoverSummary.forwardedParameters, [{
    failureBoundary: 'reject',
    parameterIndex: 1,
  }]);
  assertEquals(recoverSummary.hasUnknownDirectEffects, false);

  assertEquals(finishSummary.directMask, INTERNAL_EFFECT_MASKS.suspend);
  assertEquals(finishSummary.forwardedParameters, [{
    failureBoundary: 'reject',
    parameterIndex: 1,
  }]);
  assertEquals(finishSummary.hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes portable globals and collection builtins precisely', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function sampleRandom(): number {',
        '  return Math.random();',
        '}',
        '',
        'export function sampleTime(): number {',
        '  return Date.now();',
        '}',
        '',
        'export function createMap(): Map<string, number> {',
        '  return new Map<string, number>();',
        '}',
        '',
        'export function readMap(map: ReadonlyMap<string, number>): boolean {',
        '  return map.has("count");',
        '}',
        '',
        'export function visitMap(',
        '  map: ReadonlyMap<string, number>,',
        '  callback: (value: number, key: string) => void,',
        '): void {',
        '  map.forEach(callback);',
        '}',
        '',
        'export function mutateMap(map: Map<string, number>): void {',
        '  map.set("count", 1);',
        '}',
        '',
        'export function createSet(): Set<number> {',
        '  return new Set<number>();',
        '}',
        '',
        'export function visitSet(',
        '  set: ReadonlySet<number>,',
        '  callback: (value: number) => void,',
        '): void {',
        '  set.forEach(callback);',
        '}',
        '',
        'export function mutateSet(set: Set<number>): void {',
        '  set.add(1);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const declarationsByName = new Map(
    sourceFile.statements
      .filter(ts.isFunctionDeclaration)
      .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
        declaration.name !== undefined
      )
      .map((declaration) => [declaration.name.text, declaration]),
  );

  const sampleRandom = declarationsByName.get('sampleRandom');
  const sampleTime = declarationsByName.get('sampleTime');
  const createMap = declarationsByName.get('createMap');
  const readMap = declarationsByName.get('readMap');
  const visitMap = declarationsByName.get('visitMap');
  const mutateMap = declarationsByName.get('mutateMap');
  const createSet = declarationsByName.get('createSet');
  const visitSet = declarationsByName.get('visitSet');
  const mutateSet = declarationsByName.get('mutateSet');

  assertExists(sampleRandom);
  assertExists(sampleTime);
  assertExists(createMap);
  assertExists(readMap);
  assertExists(visitMap);
  assertExists(mutateMap);
  assertExists(createSet);
  assertExists(visitSet);
  assertExists(mutateSet);

  assertEquals(
    getEffectSummaryForDeclaration(context, sampleRandom).directMask,
    INTERNAL_EFFECT_MASKS.hostRandom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, sampleTime).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );

  const createMapSummary = getEffectSummaryForDeclaration(context, createMap);
  const readMapSummary = getEffectSummaryForDeclaration(context, readMap);
  const visitMapSummary = getEffectSummaryForDeclaration(context, visitMap);
  const mutateMapSummary = getEffectSummaryForDeclaration(context, mutateMap);
  const createSetSummary = getEffectSummaryForDeclaration(context, createSet);
  const visitSetSummary = getEffectSummaryForDeclaration(context, visitSet);
  const mutateSetSummary = getEffectSummaryForDeclaration(context, mutateSet);

  assertEquals(createMapSummary.directMask, 0);
  assertEquals(createMapSummary.hasUnknownDirectEffects, false);
  assertEquals(readMapSummary.directMask, 0);
  assertEquals(readMapSummary.hasUnknownDirectEffects, false);
  assertEquals(visitMapSummary.directMask, 0);
  assertEquals(visitMapSummary.forwardedParameters, [{
    failureBoundary: 'preserve',
    parameterIndex: 1,
  }]);
  assertEquals(visitMapSummary.hasUnknownDirectEffects, false);
  assertEquals(mutateMapSummary.directMask, INTERNAL_EFFECT_MASKS.mut);
  assertEquals(mutateMapSummary.hasUnknownDirectEffects, false);

  assertEquals(createSetSummary.directMask, 0);
  assertEquals(createSetSummary.hasUnknownDirectEffects, false);
  assertEquals(visitSetSummary.directMask, 0);
  assertEquals(visitSetSummary.forwardedParameters, [{
    failureBoundary: 'preserve',
    parameterIndex: 1,
  }]);
  assertEquals(visitSetSummary.hasUnknownDirectEffects, false);
  assertEquals(mutateSetSummary.directMask, INTERNAL_EFFECT_MASKS.mut);
  assertEquals(mutateSetSummary.hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes host-backed globals precisely', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function load(): Promise<Response> {',
        '  return fetch("https://example.com");',
        '}',
        '',
        'export function uuid(): string {',
        '  return crypto.randomUUID();',
        '}',
        '',
        'export function fill(bytes: Uint8Array): Uint8Array {',
        '  return crypto.getRandomValues(bytes);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const declarationsByName = new Map(
    sourceFile.statements
      .filter(ts.isFunctionDeclaration)
      .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
        declaration.name !== undefined
      )
      .map((declaration) => [declaration.name.text, declaration]),
  );

  const load = declarationsByName.get('load');
  const uuid = declarationsByName.get('uuid');
  const fill = declarationsByName.get('fill');

  assertExists(load);
  assertExists(uuid);
  assertExists(fill);

  const loadSummary = getEffectSummaryForDeclaration(context, load);
  const uuidSummary = getEffectSummaryForDeclaration(context, uuid);
  const fillSummary = getEffectSummaryForDeclaration(context, fill);

  assertEquals(
    loadSummary.directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(loadSummary.hasUnknownDirectEffects, false);

  assertEquals(uuidSummary.directMask, INTERNAL_EFFECT_MASKS.hostRandom);
  assertEquals(uuidSummary.hasUnknownDirectEffects, false);

  assertEquals(
    fillSummary.directMask,
    INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(fillSummary.hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes deferred host schedulers without immediate callback forwarding', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function scheduleMicrotask(callback: () => void): void {',
        '  queueMicrotask(callback);',
        '}',
        '',
        'export function scheduleTimeout(callback: () => void): number {',
        '  return setTimeout(callback, 0);',
        '}',
        '',
        'export function scheduleInterval(callback: () => void): number {',
        '  return setInterval(callback, 10);',
        '}',
        '',
        'export function cancelTimeout(timerId: number): void {',
        '  clearTimeout(timerId);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const declarationsByName = new Map(
    sourceFile.statements
      .filter(ts.isFunctionDeclaration)
      .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
        declaration.name !== undefined
      )
      .map((declaration) => [declaration.name.text, declaration]),
  );

  const scheduleMicrotask = declarationsByName.get('scheduleMicrotask');
  const scheduleTimeout = declarationsByName.get('scheduleTimeout');
  const scheduleInterval = declarationsByName.get('scheduleInterval');
  const cancelTimeout = declarationsByName.get('cancelTimeout');

  assertExists(scheduleMicrotask);
  assertExists(scheduleTimeout);
  assertExists(scheduleInterval);
  assertExists(cancelTimeout);

  const microtaskSummary = getEffectSummaryForDeclaration(context, scheduleMicrotask);
  const timeoutSummary = getEffectSummaryForDeclaration(context, scheduleTimeout);
  const intervalSummary = getEffectSummaryForDeclaration(context, scheduleInterval);
  const cancelSummary = getEffectSummaryForDeclaration(context, cancelTimeout);

  assertEquals(microtaskSummary.directMask, INTERNAL_EFFECT_MASKS.hostInterop);
  assertEquals(microtaskSummary.forwardedParameters, []);
  assertEquals(microtaskSummary.hasUnknownDirectEffects, false);

  assertEquals(timeoutSummary.directMask, INTERNAL_EFFECT_MASKS.hostTime);
  assertEquals(timeoutSummary.forwardedParameters, []);
  assertEquals(timeoutSummary.hasUnknownDirectEffects, false);

  assertEquals(intervalSummary.directMask, INTERNAL_EFFECT_MASKS.hostTime);
  assertEquals(intervalSummary.forwardedParameters, []);
  assertEquals(intervalSummary.hasUnknownDirectEffects, false);

  assertEquals(cancelSummary.directMask, INTERNAL_EFFECT_MASKS.hostTime);
  assertEquals(cancelSummary.forwardedParameters, []);
  assertEquals(cancelSummary.hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes fetch host-object families precisely', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function buildHeaders(): Headers {',
        '  return new Headers({ accept: "application/json" });',
        '}',
        '',
        'export function mutateHeaders(headers: Headers): void {',
        '  headers.set("x-id", "123");',
        '}',
        '',
        'export function readHeaders(headers: Headers): boolean {',
        '  return headers.has("x-id");',
        '}',
        '',
        'export function buildRequest(url: string): Request {',
        '  return new Request(url, { headers: new Headers() });',
        '}',
        '',
        'export function buildResponse(): Response {',
        '  return new Response("ok");',
        '}',
        '',
        'export function readRequest(request: Request): Promise<string> {',
        '  return request.text();',
        '}',
        '',
        'export function readResponse(response: Response): Promise<string> {',
        '  return response.text();',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const declarationsByName = new Map(
    sourceFile.statements
      .filter(ts.isFunctionDeclaration)
      .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
        declaration.name !== undefined
      )
      .map((declaration) => [declaration.name.text, declaration]),
  );

  const buildHeaders = declarationsByName.get('buildHeaders');
  const mutateHeaders = declarationsByName.get('mutateHeaders');
  const readHeaders = declarationsByName.get('readHeaders');
  const buildRequest = declarationsByName.get('buildRequest');
  const buildResponse = declarationsByName.get('buildResponse');
  const readRequest = declarationsByName.get('readRequest');
  const readResponse = declarationsByName.get('readResponse');

  assertExists(buildHeaders);
  assertExists(mutateHeaders);
  assertExists(readHeaders);
  assertExists(buildRequest);
  assertExists(buildResponse);
  assertExists(readRequest);
  assertExists(readResponse);

  assertEquals(
    getEffectSummaryForDeclaration(context, buildHeaders).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, mutateHeaders).directMask,
    INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readHeaders).directMask,
    0,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, buildRequest).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, buildResponse).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readRequest).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readResponse).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(getEffectSummaryForDeclaration(context, readHeaders).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readRequest).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readResponse).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes URL and text builtins precisely', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function buildUrl(base: string): URL {',
        '  return new URL("/x", base);',
        '}',
        '',
        'export function canParseUrl(base: string): boolean {',
        '  return URL.canParse("/x", base);',
        '}',
        '',
        'export function mutateParams(params: URLSearchParams): void {',
        '  params.set("q", "music");',
        '}',
        '',
        'export function readParams(params: URLSearchParams): boolean {',
        '  return params.has("q");',
        '}',
        '',
        'export function buildEncoder(): TextEncoder {',
        '  return new TextEncoder();',
        '}',
        '',
        'export function encodeText(encoder: TextEncoder, input: string): Uint8Array {',
        '  return encoder.encode(input);',
        '}',
        '',
        'export function buildDecoder(): TextDecoder {',
        '  return new TextDecoder("utf-8");',
        '}',
        '',
        'export function decodeText(decoder: TextDecoder, bytes: Uint8Array): string {',
        '  return decoder.decode(bytes);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const declarationsByName = new Map(
    sourceFile.statements
      .filter(ts.isFunctionDeclaration)
      .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
        declaration.name !== undefined
      )
      .map((declaration) => [declaration.name.text, declaration]),
  );

  const buildUrl = declarationsByName.get('buildUrl');
  const canParseUrl = declarationsByName.get('canParseUrl');
  const mutateParams = declarationsByName.get('mutateParams');
  const readParams = declarationsByName.get('readParams');
  const buildEncoder = declarationsByName.get('buildEncoder');
  const encodeText = declarationsByName.get('encodeText');
  const buildDecoder = declarationsByName.get('buildDecoder');
  const decodeText = declarationsByName.get('decodeText');

  assertExists(buildUrl);
  assertExists(canParseUrl);
  assertExists(mutateParams);
  assertExists(readParams);
  assertExists(buildEncoder);
  assertExists(encodeText);
  assertExists(buildDecoder);
  assertExists(decodeText);

  assertEquals(
    getEffectSummaryForDeclaration(context, buildUrl).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, canParseUrl).directMask,
    0,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, mutateParams).directMask,
    INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readParams).directMask,
    0,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, buildEncoder).directMask,
    0,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, encodeText).directMask,
    0,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, buildDecoder).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, decodeText).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(getEffectSummaryForDeclaration(context, canParseUrl).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readParams).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, encodeText).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, decodeText).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes JSON and console builtins precisely', async () => {
  const tempDirectory = await createTempProject([
    {
      path: 'tsconfig.json',
      contents: JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'ESNext',
          },
          include: ['src/**/*.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function parseValue(text: string): unknown {',
        '  return JSON.parse(text);',
        '}',
        '',
        'export function parseWithReviver(',
        '  text: string,',
        '  reviver: (this: unknown, key: string, value: unknown) => unknown,',
        '): unknown {',
        '  return JSON.parse(text, reviver);',
        '}',
        '',
        'export function stringifyValue(value: unknown): string | undefined {',
        '  return JSON.stringify(value);',
        '}',
        '',
        'export function stringifyWithReplacer(',
        '  value: unknown,',
        '  replacer: (this: unknown, key: string, value: unknown) => unknown,',
        '): string | undefined {',
        '  return JSON.stringify(value, replacer);',
        '}',
        '',
        'export function logValue(value: unknown): void {',
        '  console.log(value);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/index.ts'));

  assertExists(sourceFile);

  const declarationsByName = new Map(
    sourceFile.statements
      .filter(ts.isFunctionDeclaration)
      .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
        declaration.name !== undefined
      )
      .map((declaration) => [declaration.name.text, declaration]),
  );

  const parseValue = declarationsByName.get('parseValue');
  const parseWithReviver = declarationsByName.get('parseWithReviver');
  const stringifyValue = declarationsByName.get('stringifyValue');
  const stringifyWithReplacer = declarationsByName.get('stringifyWithReplacer');
  const logValue = declarationsByName.get('logValue');

  assertExists(parseValue);
  assertExists(parseWithReviver);
  assertExists(stringifyValue);
  assertExists(stringifyWithReplacer);
  assertExists(logValue);

  assertEquals(
    getEffectSummaryForDeclaration(context, parseValue).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, parseWithReviver).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, parseWithReviver).forwardedParameters,
    [{ parameterIndex: 1, failureBoundary: 'preserve' }],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, stringifyValue).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, stringifyWithReplacer).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, stringifyWithReplacer).forwardedParameters,
    [{ parameterIndex: 1, failureBoundary: 'preserve' }],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, logValue).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(getEffectSummaryForDeclaration(context, parseWithReviver).hasUnknownDirectEffects, false);
  assertEquals(
    getEffectSummaryForDeclaration(context, stringifyWithReplacer).hasUnknownDirectEffects,
    false,
  );
  assertEquals(getEffectSummaryForDeclaration(context, logValue).hasUnknownDirectEffects, false);
});
