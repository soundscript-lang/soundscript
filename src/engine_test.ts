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

function normalizeForwardedParameters(
  forwardedParameters: readonly {
    failureBoundary: string;
    memberName?: string;
    parameterIndex: number;
  }[],
): readonly {
  failureBoundary: string;
  memberName?: string;
  parameterIndex: number;
}[] {
  return forwardedParameters.map((forwardedParameter) =>
    forwardedParameter.memberName === undefined
      ? {
        failureBoundary: forwardedParameter.failureBoundary,
        parameterIndex: forwardedParameter.parameterIndex,
      }
      : {
        failureBoundary: forwardedParameter.failureBoundary,
        memberName: forwardedParameter.memberName,
        parameterIndex: forwardedParameter.parameterIndex,
      }
  );
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
  assertEquals(normalizeForwardedParameters(mapValueSummary.forwardedParameters), []);

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
  assertEquals(normalizeForwardedParameters(forwardThenSummary.forwardedParameters), [{
    failureBoundary: 'reject',
    parameterIndex: 1,
  }]);
  assertEquals(forwardThenSummary.hasUnknownDirectEffects, false);

  assertEquals(recoverSummary.directMask, INTERNAL_EFFECT_MASKS.suspend);
  assertEquals(normalizeForwardedParameters(recoverSummary.forwardedParameters), [{
    failureBoundary: 'reject',
    parameterIndex: 1,
  }]);
  assertEquals(recoverSummary.hasUnknownDirectEffects, false);

  assertEquals(finishSummary.directMask, INTERNAL_EFFECT_MASKS.suspend);
  assertEquals(normalizeForwardedParameters(finishSummary.forwardedParameters), [{
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
  assertEquals(normalizeForwardedParameters(visitMapSummary.forwardedParameters), [{
    failureBoundary: 'preserve',
    parameterIndex: 1,
  }]);
  assertEquals(visitMapSummary.hasUnknownDirectEffects, false);
  assertEquals(mutateMapSummary.directMask, INTERNAL_EFFECT_MASKS.mut);
  assertEquals(mutateMapSummary.hasUnknownDirectEffects, false);

  assertEquals(createSetSummary.directMask, 0);
  assertEquals(createSetSummary.hasUnknownDirectEffects, false);
  assertEquals(visitSetSummary.directMask, 0);
  assertEquals(normalizeForwardedParameters(visitSetSummary.forwardedParameters), [{
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
        'export function scheduleIdle(callback: IdleRequestCallback): number {',
        '  return requestIdleCallback(callback);',
        '}',
        '',
        'export function cancelTimeout(timerId: number): void {',
        '  clearTimeout(timerId);',
        '}',
        '',
        'export function cancelIdle(handle: number): void {',
        '  cancelIdleCallback(handle);',
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
  const scheduleIdle = declarationsByName.get('scheduleIdle');
  const cancelTimeout = declarationsByName.get('cancelTimeout');
  const cancelIdle = declarationsByName.get('cancelIdle');

  assertExists(scheduleMicrotask);
  assertExists(scheduleTimeout);
  assertExists(scheduleInterval);
  assertExists(scheduleIdle);
  assertExists(cancelTimeout);
  assertExists(cancelIdle);

  const microtaskSummary = getEffectSummaryForDeclaration(context, scheduleMicrotask);
  const timeoutSummary = getEffectSummaryForDeclaration(context, scheduleTimeout);
  const intervalSummary = getEffectSummaryForDeclaration(context, scheduleInterval);
  const idleSummary = getEffectSummaryForDeclaration(context, scheduleIdle);
  const cancelSummary = getEffectSummaryForDeclaration(context, cancelTimeout);
  const cancelIdleSummary = getEffectSummaryForDeclaration(context, cancelIdle);

  assertEquals(microtaskSummary.directMask, INTERNAL_EFFECT_MASKS.hostInterop);
  assertEquals(normalizeForwardedParameters(microtaskSummary.forwardedParameters), []);
  assertEquals(microtaskSummary.hasUnknownDirectEffects, false);

  assertEquals(timeoutSummary.directMask, INTERNAL_EFFECT_MASKS.hostTime);
  assertEquals(normalizeForwardedParameters(timeoutSummary.forwardedParameters), []);
  assertEquals(timeoutSummary.hasUnknownDirectEffects, false);

  assertEquals(intervalSummary.directMask, INTERNAL_EFFECT_MASKS.hostTime);
  assertEquals(normalizeForwardedParameters(intervalSummary.forwardedParameters), []);
  assertEquals(intervalSummary.hasUnknownDirectEffects, false);

  assertEquals(idleSummary.directMask, INTERNAL_EFFECT_MASKS.hostInterop);
  assertEquals(normalizeForwardedParameters(idleSummary.forwardedParameters), []);
  assertEquals(idleSummary.hasUnknownDirectEffects, false);

  assertEquals(cancelSummary.directMask, INTERNAL_EFFECT_MASKS.hostTime);
  assertEquals(normalizeForwardedParameters(cancelSummary.forwardedParameters), []);
  assertEquals(cancelSummary.hasUnknownDirectEffects, false);

  assertEquals(cancelIdleSummary.directMask, INTERNAL_EFFECT_MASKS.hostInterop);
  assertEquals(normalizeForwardedParameters(cancelIdleSummary.forwardedParameters), []);
  assertEquals(cancelIdleSummary.hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes abort and cloning builtins precisely', async () => {
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
        'export function buildController(): AbortController {',
        '  return new AbortController();',
        '}',
        '',
        'export function abortController(controller: AbortController): void {',
        '  controller.abort();',
        '}',
        '',
        'export function makeAbortedSignal(): AbortSignal {',
        '  return AbortSignal.abort("boom");',
        '}',
        '',
        'export function combineSignals(',
        '  left: AbortSignal,',
        '  right: AbortSignal,',
        '): AbortSignal {',
        '  return AbortSignal.any([left, right]);',
        '}',
        '',
        'export function timeoutSignal(): AbortSignal {',
        '  return AbortSignal.timeout(10);',
        '}',
        '',
        'export function ensureNotAborted(signal: AbortSignal): void {',
        '  signal.throwIfAborted();',
        '}',
        '',
        'export function cloneValue<T>(value: T): T {',
        '  return structuredClone(value);',
        '}',
        '',
        'export function parseUrl(value: string): URL | null {',
        '  return URL.parse(value);',
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

  const buildController = declarationsByName.get('buildController');
  const abortController = declarationsByName.get('abortController');
  const makeAbortedSignal = declarationsByName.get('makeAbortedSignal');
  const combineSignals = declarationsByName.get('combineSignals');
  const timeoutSignal = declarationsByName.get('timeoutSignal');
  const ensureNotAborted = declarationsByName.get('ensureNotAborted');
  const cloneValue = declarationsByName.get('cloneValue');
  const parseUrl = declarationsByName.get('parseUrl');

  assertExists(buildController);
  assertExists(abortController);
  assertExists(makeAbortedSignal);
  assertExists(combineSignals);
  assertExists(timeoutSignal);
  assertExists(ensureNotAborted);
  assertExists(cloneValue);
  assertExists(parseUrl);

  assertEquals(
    getEffectSummaryForDeclaration(context, buildController).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, abortController).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeAbortedSignal).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, combineSignals).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, timeoutSignal).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, ensureNotAborted).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, cloneValue).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, parseUrl).directMask,
    0,
  );
  assertEquals(getEffectSummaryForDeclaration(context, buildController).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, abortController).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, makeAbortedSignal).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, combineSignals).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, timeoutSignal).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, ensureNotAborted).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, cloneValue).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, parseUrl).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes DOM listener and object URL builtins precisely', async () => {
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
        'export function buildBlob(): Blob {',
        '  return new Blob(["ok"]);',
        '}',
        '',
        'export function registerAbortListener(',
        '  signal: AbortSignal,',
        '  listener: (event: Event) => void,',
        '): void {',
        '  signal.addEventListener("abort", listener);',
        '}',
        '',
        'export function unregisterAbortListener(',
        '  signal: AbortSignal,',
        '  listener: (event: Event) => void,',
        '): void {',
        '  signal.removeEventListener("abort", listener);',
        '}',
        '',
        'export function registerWindowListener(listener: (event: Event) => void): void {',
        '  addEventListener("message", listener);',
        '}',
        '',
        'export function unregisterWindowListener(listener: (event: Event) => void): void {',
        '  removeEventListener("message", listener);',
        '}',
        '',
        'export function createObjectUrl(blob: Blob): string {',
        '  return URL.createObjectURL(blob);',
        '}',
        '',
        'export function revokeObjectUrl(url: string): void {',
        '  URL.revokeObjectURL(url);',
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

  const buildBlob = declarationsByName.get('buildBlob');
  const registerAbortListener = declarationsByName.get('registerAbortListener');
  const unregisterAbortListener = declarationsByName.get('unregisterAbortListener');
  const registerWindowListener = declarationsByName.get('registerWindowListener');
  const unregisterWindowListener = declarationsByName.get('unregisterWindowListener');
  const createObjectUrl = declarationsByName.get('createObjectUrl');
  const revokeObjectUrl = declarationsByName.get('revokeObjectUrl');

  assertExists(buildBlob);
  assertExists(registerAbortListener);
  assertExists(unregisterAbortListener);
  assertExists(registerWindowListener);
  assertExists(unregisterWindowListener);
  assertExists(createObjectUrl);
  assertExists(revokeObjectUrl);

  assertEquals(
    getEffectSummaryForDeclaration(context, buildBlob).directMask,
    0,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, registerAbortListener).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    normalizeForwardedParameters(
      getEffectSummaryForDeclaration(context, registerAbortListener).forwardedParameters,
    ),
    [],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, unregisterAbortListener).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    normalizeForwardedParameters(
      getEffectSummaryForDeclaration(context, unregisterAbortListener).forwardedParameters,
    ),
    [],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, registerWindowListener).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    normalizeForwardedParameters(
      getEffectSummaryForDeclaration(context, registerWindowListener).forwardedParameters,
    ),
    [],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, unregisterWindowListener).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    normalizeForwardedParameters(
      getEffectSummaryForDeclaration(context, unregisterWindowListener).forwardedParameters,
    ),
    [],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, createObjectUrl).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, revokeObjectUrl).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(getEffectSummaryForDeclaration(context, buildBlob).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, registerAbortListener).hasUnknownDirectEffects, false);
  assertEquals(
    getEffectSummaryForDeclaration(context, unregisterAbortListener).hasUnknownDirectEffects,
    false,
  );
  assertEquals(getEffectSummaryForDeclaration(context, registerWindowListener).hasUnknownDirectEffects, false);
  assertEquals(
    getEffectSummaryForDeclaration(context, unregisterWindowListener).hasUnknownDirectEffects,
    false,
  );
  assertEquals(getEffectSummaryForDeclaration(context, createObjectUrl).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, revokeObjectUrl).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes DOM mutation and dispatch builtins precisely', async () => {
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
        'export function buildEvent(): Event {',
        '  return new Event("ping");',
        '}',
        '',
        'export function buildTarget(): EventTarget {',
        '  return new EventTarget();',
        '}',
        '',
        'export function dispatchOnTarget(target: EventTarget): boolean {',
        '  return target.dispatchEvent(new Event("ping"));',
        '}',
        '',
        'export function createDomElement(): HTMLElement {',
        '  return document.createElement("div");',
        '}',
        '',
        'export function setDomAttribute(element: Element): void {',
        '  element.setAttribute("data-id", "1");',
        '}',
        '',
        'export function appendDomChild(parent: Element, child: Element): Element {',
        '  return parent.appendChild(child);',
        '}',
        '',
        'export function removeDomAttribute(element: Element): void {',
        '  element.removeAttribute("data-id");',
        '}',
        '',
        'export function removeDomAttributeNs(element: Element): void {',
        '  element.removeAttributeNS(null, "data-id");',
        '}',
        '',
        'export function removeDomChild(parent: Element, child: Element): Element {',
        '  return parent.removeChild(child);',
        '}',
        '',
        'export function replaceDomChild(parent: Element, child: Element, nextChild: Element): Element {',
        '  return parent.replaceChild(nextChild, child);',
        '}',
        '',
        'export function insertDomChild(parent: Element, child: Element, nextChild: Element | null): Element {',
        '  return parent.insertBefore(child, nextChild);',
        '}',
        '',
        'export function appendDomNodes(element: Element, child: Element): void {',
        '  element.append("prefix", child);',
        '}',
        '',
        'export function prependDomNodes(element: Element, child: Element): void {',
        '  element.prepend(child, "suffix");',
        '}',
        '',
        'export function placeNodeBefore(child: Element, sibling: Element): void {',
        '  child.before("prefix", sibling);',
        '}',
        '',
        'export function placeNodeAfter(child: Element, sibling: Element): void {',
        '  child.after(sibling, "suffix");',
        '}',
        '',
        'export function removeDomNode(child: Element): void {',
        '  child.remove();',
        '}',
        '',
        'export function replaceDomNode(child: Element, sibling: Element): void {',
        '  child.replaceWith("prefix", sibling);',
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

  const buildEvent = declarationsByName.get('buildEvent');
  const buildTarget = declarationsByName.get('buildTarget');
  const dispatchOnTarget = declarationsByName.get('dispatchOnTarget');
  const createDomElement = declarationsByName.get('createDomElement');
  const setDomAttribute = declarationsByName.get('setDomAttribute');
  const appendDomChild = declarationsByName.get('appendDomChild');
  const removeDomAttribute = declarationsByName.get('removeDomAttribute');
  const removeDomAttributeNs = declarationsByName.get('removeDomAttributeNs');
  const removeDomChild = declarationsByName.get('removeDomChild');
  const replaceDomChild = declarationsByName.get('replaceDomChild');
  const insertDomChild = declarationsByName.get('insertDomChild');
  const appendDomNodes = declarationsByName.get('appendDomNodes');
  const prependDomNodes = declarationsByName.get('prependDomNodes');
  const placeNodeBefore = declarationsByName.get('placeNodeBefore');
  const placeNodeAfter = declarationsByName.get('placeNodeAfter');
  const removeDomNode = declarationsByName.get('removeDomNode');
  const replaceDomNode = declarationsByName.get('replaceDomNode');

  assertExists(buildEvent);
  assertExists(buildTarget);
  assertExists(dispatchOnTarget);
  assertExists(createDomElement);
  assertExists(setDomAttribute);
  assertExists(appendDomChild);
  assertExists(removeDomAttribute);
  assertExists(removeDomAttributeNs);
  assertExists(removeDomChild);
  assertExists(replaceDomChild);
  assertExists(insertDomChild);
  assertExists(appendDomNodes);
  assertExists(prependDomNodes);
  assertExists(placeNodeBefore);
  assertExists(placeNodeAfter);
  assertExists(removeDomNode);
  assertExists(replaceDomNode);

  assertEquals(getEffectSummaryForDeclaration(context, buildEvent).directMask, 0);
  assertEquals(getEffectSummaryForDeclaration(context, buildTarget).directMask, 0);

  const dispatchSummary = getEffectSummaryForDeclaration(context, dispatchOnTarget);
  assertEquals(dispatchSummary.directMask, INTERNAL_EFFECT_MASKS.hostDom);
  assertEquals(dispatchSummary.hasUnknownDirectEffects, true);

  assertEquals(
    getEffectSummaryForDeclaration(context, createDomElement).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, setDomAttribute).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, appendDomChild).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, removeDomAttribute).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, removeDomAttributeNs).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, removeDomChild).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, replaceDomChild).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, insertDomChild).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, appendDomNodes).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, prependDomNodes).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, placeNodeBefore).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, placeNodeAfter).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, removeDomNode).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, replaceDomNode).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );

  assertEquals(getEffectSummaryForDeclaration(context, buildEvent).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, buildTarget).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, createDomElement).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, setDomAttribute).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, appendDomChild).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, removeDomAttribute).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, removeDomAttributeNs).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, removeDomChild).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, replaceDomChild).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, insertDomChild).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, appendDomNodes).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, prependDomNodes).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, placeNodeBefore).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, placeNodeAfter).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, removeDomNode).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, replaceDomNode).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes browser messaging builtins precisely', async () => {
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
        'export function sendWindowMessage(targetOrigin: string): void {',
        '  postMessage({ ok: true }, targetOrigin);',
        '}',
        '',
        'export function openChannel(name: string): BroadcastChannel {',
        '  return new BroadcastChannel(name);',
        '}',
        '',
        'export function sendChannelMessage(channel: BroadcastChannel): void {',
        '  channel.postMessage({ ok: true });',
        '}',
        '',
        'export function closeChannel(channel: BroadcastChannel): void {',
        '  channel.close();',
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

  const sendWindowMessage = declarationsByName.get('sendWindowMessage');
  const openChannel = declarationsByName.get('openChannel');
  const sendChannelMessage = declarationsByName.get('sendChannelMessage');
  const closeChannel = declarationsByName.get('closeChannel');

  assertExists(sendWindowMessage);
  assertExists(openChannel);
  assertExists(sendChannelMessage);
  assertExists(closeChannel);

  assertEquals(
    getEffectSummaryForDeclaration(context, sendWindowMessage).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, openChannel).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, sendChannelMessage).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, closeChannel).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );

  assertEquals(getEffectSummaryForDeclaration(context, sendWindowMessage).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, openChannel).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, sendChannelMessage).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, closeChannel).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes worker and socket builtins precisely', async () => {
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
        'export function openWorker(scriptUrl: string): Worker {',
        '  return new Worker(scriptUrl, { type: "module" });',
        '}',
        '',
        'export function postWorkerMessage(worker: Worker): void {',
        '  worker.postMessage({ ok: true });',
        '}',
        '',
        'export function terminateWorker(worker: Worker): void {',
        '  worker.terminate();',
        '}',
        '',
        'export function openMessageChannel(): MessageChannel {',
        '  return new MessageChannel();',
        '}',
        '',
        'export function postPortMessage(port: MessagePort): void {',
        '  port.postMessage({ ok: true });',
        '}',
        '',
        'export function startPort(port: MessagePort): void {',
        '  port.start();',
        '}',
        '',
        'export function closePort(port: MessagePort): void {',
        '  port.close();',
        '}',
        '',
        'export function openSocket(url: string): WebSocket {',
        '  return new WebSocket(url);',
        '}',
        '',
        'export function sendSocketMessage(socket: WebSocket): void {',
        '  socket.send("ok");',
        '}',
        '',
        'export function closeSocket(socket: WebSocket): void {',
        '  socket.close();',
        '}',
        '',
        'export function openEventStream(url: string): EventSource {',
        '  return new EventSource(url);',
        '}',
        '',
        'export function closeEventStream(stream: EventSource): void {',
        '  stream.close();',
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

  const openWorker = declarationsByName.get('openWorker');
  const postWorkerMessage = declarationsByName.get('postWorkerMessage');
  const terminateWorker = declarationsByName.get('terminateWorker');
  const openMessageChannel = declarationsByName.get('openMessageChannel');
  const postPortMessage = declarationsByName.get('postPortMessage');
  const startPort = declarationsByName.get('startPort');
  const closePort = declarationsByName.get('closePort');
  const openSocket = declarationsByName.get('openSocket');
  const sendSocketMessage = declarationsByName.get('sendSocketMessage');
  const closeSocket = declarationsByName.get('closeSocket');
  const openEventStream = declarationsByName.get('openEventStream');
  const closeEventStream = declarationsByName.get('closeEventStream');

  assertExists(openWorker);
  assertExists(postWorkerMessage);
  assertExists(terminateWorker);
  assertExists(openMessageChannel);
  assertExists(postPortMessage);
  assertExists(startPort);
  assertExists(closePort);
  assertExists(openSocket);
  assertExists(sendSocketMessage);
  assertExists(closeSocket);
  assertExists(openEventStream);
  assertExists(closeEventStream);

  assertEquals(
    getEffectSummaryForDeclaration(context, openWorker).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, postWorkerMessage).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, terminateWorker).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, openMessageChannel).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, postPortMessage).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, startPort).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, closePort).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, openSocket).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, sendSocketMessage).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, closeSocket).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, openEventStream).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, closeEventStream).directMask,
    INTERNAL_EFFECT_MASKS.hostIo,
  );

  assertEquals(getEffectSummaryForDeclaration(context, openWorker).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, postWorkerMessage).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, terminateWorker).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, openMessageChannel).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, postPortMessage).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, startPort).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, closePort).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, openSocket).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, sendSocketMessage).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, closeSocket).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, openEventStream).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, closeEventStream).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes browser storage and navigation builtins precisely', async () => {
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
        'export function readStoredValue(): string | null {',
        '  return localStorage.getItem("key");',
        '}',
        '',
        'export function storeValue(): void {',
        '  localStorage.setItem("key", "value");',
        '}',
        '',
        'export function clearStoredValue(): void {',
        '  sessionStorage.clear();',
        '}',
        '',
        'export function pushHistoryState(url: string): void {',
        '  history.pushState(null, "", url);',
        '}',
        '',
        'export function navigateHistory(): void {',
        '  history.back();',
        '}',
        '',
        'export function assignLocation(url: string): void {',
        '  location.assign(url);',
        '}',
        '',
        'export function reloadLocation(): void {',
        '  location.reload();',
        '}',
        '',
        'export function sendBeaconNow(url: string): boolean {',
        '  return navigator.sendBeacon(url, "ok");',
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

  const readStoredValue = declarationsByName.get('readStoredValue');
  const storeValue = declarationsByName.get('storeValue');
  const clearStoredValue = declarationsByName.get('clearStoredValue');
  const pushHistoryState = declarationsByName.get('pushHistoryState');
  const navigateHistory = declarationsByName.get('navigateHistory');
  const assignLocation = declarationsByName.get('assignLocation');
  const reloadLocation = declarationsByName.get('reloadLocation');
  const sendBeaconNow = declarationsByName.get('sendBeaconNow');

  assertExists(readStoredValue);
  assertExists(storeValue);
  assertExists(clearStoredValue);
  assertExists(pushHistoryState);
  assertExists(navigateHistory);
  assertExists(assignLocation);
  assertExists(reloadLocation);
  assertExists(sendBeaconNow);

  assertEquals(
    getEffectSummaryForDeclaration(context, readStoredValue).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, storeValue).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, clearStoredValue).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, pushHistoryState).directMask,
    INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, navigateHistory).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, assignLocation).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, reloadLocation).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, sendBeaconNow).directMask,
    INTERNAL_EFFECT_MASKS.hostIo,
  );

  assertEquals(getEffectSummaryForDeclaration(context, readStoredValue).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, storeValue).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, clearStoredValue).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, pushHistoryState).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, navigateHistory).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, assignLocation).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, reloadLocation).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, sendBeaconNow).hasUnknownDirectEffects, false);
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
    normalizeForwardedParameters(
      getEffectSummaryForDeclaration(context, parseWithReviver).forwardedParameters,
    ),
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
    normalizeForwardedParameters(
      getEffectSummaryForDeclaration(context, stringifyWithReplacer).forwardedParameters,
    ),
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

Deno.test('createAnalysisContext summarizes result, json, and debug stdlib helpers precisely', async () => {
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
          include: ['src/**/*.ts', 'src/**/*.d.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: 'src/stdlib/result.d.ts',
      contents: [
        'export declare function resultOf<T>(fn: () => Promise<T>): Promise<T | Error>;',
        'export declare function resultOf<T, E>(fn: () => Promise<T>, mapError: (error: Error) => E): Promise<T | E>;',
        'export declare function resultOf<T>(fn: () => T): T | Error;',
        'export declare function resultOf<T, E>(fn: () => T, mapError: (error: Error) => E): T | E;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/stdlib/json.d.ts',
      contents: [
        'import type { Decoder } from "./decode";',
        'import type { Encoder } from "./encode";',
        '',
        'export declare function parseJson(text: string): unknown;',
        'export declare function stringifyJson(value: unknown): unknown;',
        'export declare function parseJsonLike(text: string): unknown;',
        'export declare function stringifyJsonLike(value: unknown): unknown;',
        'export declare function parseAndDecode<T, E>(text: string, decoder: Decoder<T, E>): T | E;',
        'export declare function encodeAndStringify<T, E>(value: T, encoder: Encoder<T, unknown, E>): unknown;',
        'export declare function decodeJson<T, E>(text: string, decoder: Decoder<T, E>): T | E;',
        'export declare function encodeJson<T, E>(value: T, encoder: Encoder<T, unknown, E>): unknown;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/stdlib/decode.d.ts',
      contents: [
        'export type Decoder<T, E> = {',
        '  decode(value: unknown): T | E;',
        '};',
        '',
      ].join('\n'),
    },
    {
      path: 'src/stdlib/encode.d.ts',
      contents: [
        'export type Encoder<T, TEncoded, E> = {',
        '  encode(value: T): TEncoded | E;',
        '};',
        '',
      ].join('\n'),
    },
    {
      path: 'src/stdlib/debug.d.ts',
      contents: [
        'export declare function assert(condition: unknown, message?: string): asserts condition;',
        'export declare function log<T>(value: T): T;',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { resultOf } from "./stdlib/result";',
        'import { parseAndDecode, parseJson, stringifyJson, parseJsonLike, stringifyJsonLike, encodeAndStringify, decodeJson, encodeJson } from "./stdlib/json";',
        'import type { Decoder } from "./stdlib/decode";',
        'import type { Encoder } from "./stdlib/encode";',
        'import { assert, log } from "./stdlib/debug";',
        '',
        'export function captureJsonFailure(text: string) {',
        '  return resultOf(() => JSON.parse(text));',
        '}',
        '',
        'export function captureHost(value: unknown) {',
        '  return resultOf(() => console.log(value));',
        '}',
        '',
        'export function mapErrorThrows(text: string) {',
        '  return resultOf(() => JSON.parse(text), (_error) => {',
        '    throw new Error("boom");',
        '  });',
        '}',
        '',
        'export function captureAsync() {',
        '  return resultOf(async () => 1);',
        '}',
        '',
        'export function parseStdJson(text: string) {',
        '  return parseJson(text);',
        '}',
        '',
        'export function stringifyStdJson(value: unknown) {',
        '  return stringifyJson(value);',
        '}',
        '',
        'export function parseStdJsonLike(text: string) {',
        '  return parseJsonLike(text);',
        '}',
        '',
        'export function stringifyStdJsonLike(value: unknown) {',
        '  return stringifyJsonLike(value);',
        '}',
        '',
        'export function parseAndDecodeHost(text: string) {',
        '  return parseAndDecode(text, {',
        '    decode(value: unknown) {',
        '      console.log(value);',
        '      return 1;',
        '    },',
        '  });',
        '}',
        '',
        'export function forwardParseAndDecode(text: string, decoder: Decoder<number, Error>) {',
        '  return parseAndDecode(text, decoder);',
        '}',
        '',
        'export function encodeAndStringifyHost(value: number) {',
        '  return encodeAndStringify(value, {',
        '    encode(input: number) {',
        '      console.log(input);',
        '      return input;',
        '    },',
        '  });',
        '}',
        '',
        'export function forwardEncodeJson(value: number, encoder: Encoder<number, unknown, Error>) {',
        '  return encodeJson(value, encoder);',
        '}',
        '',
        'export function decodeJsonHost(text: string) {',
        '  return decodeJson(text, {',
        '    decode(value: unknown) {',
        '      console.log(value);',
        '      return 1;',
        '    },',
        '  });',
        '}',
        '',
        'export function debugLogValue(value: unknown) {',
        '  return log(value);',
        '}',
        '',
        'export function debugAssertValue(condition: unknown): void {',
        '  assert(condition);',
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

  const captureJsonFailure = declarationsByName.get('captureJsonFailure');
  const captureHost = declarationsByName.get('captureHost');
  const mapErrorThrows = declarationsByName.get('mapErrorThrows');
  const captureAsync = declarationsByName.get('captureAsync');
  const parseStdJson = declarationsByName.get('parseStdJson');
  const stringifyStdJson = declarationsByName.get('stringifyStdJson');
  const parseStdJsonLike = declarationsByName.get('parseStdJsonLike');
  const stringifyStdJsonLike = declarationsByName.get('stringifyStdJsonLike');
  const parseAndDecodeHost = declarationsByName.get('parseAndDecodeHost');
  const forwardParseAndDecode = declarationsByName.get('forwardParseAndDecode');
  const encodeAndStringifyHost = declarationsByName.get('encodeAndStringifyHost');
  const forwardEncodeJson = declarationsByName.get('forwardEncodeJson');
  const decodeJsonHost = declarationsByName.get('decodeJsonHost');
  const debugLogValue = declarationsByName.get('debugLogValue');
  const debugAssertValue = declarationsByName.get('debugAssertValue');

  assertExists(captureJsonFailure);
  assertExists(captureHost);
  assertExists(mapErrorThrows);
  assertExists(captureAsync);
  assertExists(parseStdJson);
  assertExists(stringifyStdJson);
  assertExists(parseStdJsonLike);
  assertExists(stringifyStdJsonLike);
  assertExists(parseAndDecodeHost);
  assertExists(forwardParseAndDecode);
  assertExists(encodeAndStringifyHost);
  assertExists(forwardEncodeJson);
  assertExists(decodeJsonHost);
  assertExists(debugLogValue);
  assertExists(debugAssertValue);

  assertEquals(getEffectSummaryForDeclaration(context, captureJsonFailure).directMask, 0);
  assertEquals(
    getEffectSummaryForDeclaration(context, captureHost).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, mapErrorThrows).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, captureAsync).directMask,
    INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(getEffectSummaryForDeclaration(context, parseStdJson).directMask, 0);
  assertEquals(getEffectSummaryForDeclaration(context, stringifyStdJson).directMask, 0);
  assertEquals(getEffectSummaryForDeclaration(context, parseStdJsonLike).directMask, 0);
  assertEquals(getEffectSummaryForDeclaration(context, stringifyStdJsonLike).directMask, 0);
  assertEquals(
    getEffectSummaryForDeclaration(context, parseAndDecodeHost).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    normalizeForwardedParameters(
      getEffectSummaryForDeclaration(context, forwardParseAndDecode).forwardedParameters,
    ),
    [{ parameterIndex: 1, failureBoundary: 'preserve', memberName: 'decode' }],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, encodeAndStringifyHost).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    normalizeForwardedParameters(
      getEffectSummaryForDeclaration(context, forwardEncodeJson).forwardedParameters,
    ),
    [{ parameterIndex: 1, failureBoundary: 'preserve', memberName: 'encode' }],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, decodeJsonHost).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, debugLogValue).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, debugAssertValue).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(getEffectSummaryForDeclaration(context, captureJsonFailure).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, captureAsync).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, parseStdJson).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, forwardParseAndDecode).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, forwardEncodeJson).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, debugLogValue).hasUnknownDirectEffects, false);
});
