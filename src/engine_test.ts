import { assertEquals, assertExists, assertStrictEquals } from '@std/assert';
import { dirname, join } from '@std/path';
import ts from 'typescript';

import { createSoundStdlibCompilerHost } from './bundled/sound_stdlib.ts';
import {
  getEffectSummaryForDeclaration,
  INTERNAL_EFFECT_MASKS,
} from './checker/effects.ts';
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
    host: createSoundStdlibCompilerHost(parsedConfig.options, dirname(projectPath)),
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
    projectReferences: parsedConfig.projectReferences,
    configFileParsingDiagnostics: parsedConfig.errors,
  });
}

function normalizeForwardedParameters(
  forwardedParameters: readonly {
    failureBoundary: string;
    handledEffects?: readonly string[];
    memberName?: string;
    parameterIndex: number;
  }[],
): readonly {
  failureBoundary: string;
  handledEffects?: readonly string[];
  memberName?: string;
  parameterIndex: number;
}[] {
  return forwardedParameters.map((forwardedParameter) =>
    ({
      failureBoundary: forwardedParameter.failureBoundary,
      ...(forwardedParameter.handledEffects && forwardedParameter.handledEffects.length > 0
        ? { handledEffects: [...forwardedParameter.handledEffects] }
        : {}),
      ...(forwardedParameter.memberName === undefined ? {} : { memberName: forwardedParameter.memberName }),
      parameterIndex: forwardedParameter.parameterIndex,
    })
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

Deno.test('createAnalysisContext parses dotted effects and forward transforms on declarations', async () => {
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
      path: 'src/runtime.d.ts',
      contents: [
        '// #[effects(add: [suspend.await, host.node.fs, host.io], forward: [{ from: callback, rewrite: [{ from: fails, to: fails.rejects }] }])]',
        'export declare function wrapAsync<T>(callback: () => T): Promise<T>;',
        '',
        '// #[effects(add: [], forward: [{ from: decoder.decode, handle: [fails] }])]',
        'export declare function parseWith<T, E>(',
        '  text: string,',
        '  decoder: { decode(value: unknown): T | E },',
        '): T | E;',
        '',
        '// #[effects(add: [host.browser.dom], unknown: [direct])]',
        'export declare function dispatchNow(event: Event): boolean;',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);
  const context = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const sourceFile = context.getSourceFiles().find((file) => file.fileName.endsWith('/src/runtime.d.ts'));

  assertExists(sourceFile);

  const declarationsByName = new Map(
    sourceFile.statements
      .filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement))
      .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
        declaration.name !== undefined
      )
      .map((declaration) => [declaration.name.text, declaration]),
  );

  const wrapAsync = declarationsByName.get('wrapAsync');
  const parseWith = declarationsByName.get('parseWith');
  const dispatchNow = declarationsByName.get('dispatchNow');

  assertExists(wrapAsync);
  assertExists(parseWith);
  assertExists(dispatchNow);

  const wrapAsyncSummary = getEffectSummaryForDeclaration(context, wrapAsync);
  assertEquals(wrapAsyncSummary.directEffects, ['host.io', 'host.node.fs', 'suspend.await']);
  assertEquals(
    normalizeForwardedParameters(wrapAsyncSummary.forwardedParameters),
    [{
      failureBoundary: 'reject',
      parameterIndex: 0,
    }],
  );

  const parseWithSummary = getEffectSummaryForDeclaration(context, parseWith);
  assertEquals(parseWithSummary.directEffects, []);
  assertEquals(
    normalizeForwardedParameters(parseWithSummary.forwardedParameters),
    [{
      failureBoundary: 'capture',
      handledEffects: ['fails'],
      memberName: 'decode',
      parameterIndex: 1,
    }],
  );

  const dispatchNowSummary = getEffectSummaryForDeclaration(context, dispatchNow);
  assertEquals(dispatchNowSummary.directEffects, ['host.browser.dom']);
  assertEquals(
    dispatchNowSummary.unknownDirectReasons.map((reason) => `${reason.kind}:${reason.detail ?? ''}`),
    ['annotatedUnknownDirectEffect:dispatchNow'],
  );
});

Deno.test('createAnalysisContext unions explicit bodyful add effects with inferred effects', async () => {
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
        '// #[effects(add: [host.db.query])]',
        'export async function taggedQuery(input: RequestInfo | URL): Promise<string> {',
        '  const response = await fetch(input);',
        '  return await response.text();',
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

  const taggedQuery = sourceFile.statements.find(ts.isFunctionDeclaration);
  assertExists(taggedQuery);

  const summary = getEffectSummaryForDeclaration(context, taggedQuery);
  assertEquals(summary.directEffects, ['host.db.query', 'host.io', 'suspend.await']);
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

Deno.test('createAnalysisContext summarizes request and file builtins precisely', async () => {
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
        'export function buildEmptyFormData(): FormData {',
        '  return new FormData();',
        '}',
        '',
        'export function buildFormDataFromForm(form: HTMLFormElement): FormData {',
        '  return new FormData(form);',
        '}',
        '',
        'export function appendFormData(data: FormData, file: Blob): void {',
        '  data.append("file", file);',
        '}',
        '',
        'export function readFormData(data: FormData): FormDataEntryValue | null {',
        '  return data.get("file");',
        '}',
        '',
        'export function buildFileReader(): FileReader {',
        '  return new FileReader();',
        '}',
        '',
        'export function readFileText(reader: FileReader, blob: Blob): void {',
        '  reader.readAsText(blob);',
        '}',
        '',
        'export function abortFileRead(reader: FileReader): void {',
        '  reader.abort();',
        '}',
        '',
        'export function buildXmlHttpRequest(): XMLHttpRequest {',
        '  return new XMLHttpRequest();',
        '}',
        '',
        'export function openXmlHttpRequest(xhr: XMLHttpRequest, url: string): void {',
        '  xhr.open("GET", url);',
        '}',
        '',
        'export function setXmlHttpRequestHeader(xhr: XMLHttpRequest): void {',
        '  xhr.setRequestHeader("x-test", "1");',
        '}',
        '',
        'export function sendXmlHttpRequest(xhr: XMLHttpRequest): void {',
        '  xhr.send();',
        '}',
        '',
        'export function abortXmlHttpRequest(xhr: XMLHttpRequest): void {',
        '  xhr.abort();',
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

  const buildEmptyFormData = declarationsByName.get('buildEmptyFormData');
  const buildFormDataFromForm = declarationsByName.get('buildFormDataFromForm');
  const appendFormData = declarationsByName.get('appendFormData');
  const readFormData = declarationsByName.get('readFormData');
  const buildFileReader = declarationsByName.get('buildFileReader');
  const readFileText = declarationsByName.get('readFileText');
  const abortFileRead = declarationsByName.get('abortFileRead');
  const buildXmlHttpRequest = declarationsByName.get('buildXmlHttpRequest');
  const openXmlHttpRequest = declarationsByName.get('openXmlHttpRequest');
  const setXmlHttpRequestHeader = declarationsByName.get('setXmlHttpRequestHeader');
  const sendXmlHttpRequest = declarationsByName.get('sendXmlHttpRequest');
  const abortXmlHttpRequest = declarationsByName.get('abortXmlHttpRequest');

  assertExists(buildEmptyFormData);
  assertExists(buildFormDataFromForm);
  assertExists(appendFormData);
  assertExists(readFormData);
  assertExists(buildFileReader);
  assertExists(readFileText);
  assertExists(abortFileRead);
  assertExists(buildXmlHttpRequest);
  assertExists(openXmlHttpRequest);
  assertExists(setXmlHttpRequestHeader);
  assertExists(sendXmlHttpRequest);
  assertExists(abortXmlHttpRequest);

  assertEquals(getEffectSummaryForDeclaration(context, buildEmptyFormData).directMask, 0);
  assertEquals(
    getEffectSummaryForDeclaration(context, buildFormDataFromForm).directMask,
    INTERNAL_EFFECT_MASKS.hostDom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, appendFormData).directMask,
    INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(getEffectSummaryForDeclaration(context, readFormData).directMask, 0);
  assertEquals(
    getEffectSummaryForDeclaration(context, buildFileReader).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readFileText).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, abortFileRead).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, buildXmlHttpRequest).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, openXmlHttpRequest).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, setXmlHttpRequestHeader).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, sendXmlHttpRequest).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, abortXmlHttpRequest).directMask,
    INTERNAL_EFFECT_MASKS.hostIo,
  );

  assertEquals(getEffectSummaryForDeclaration(context, buildEmptyFormData).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, buildFormDataFromForm).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, appendFormData).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readFormData).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, buildFileReader).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readFileText).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, abortFileRead).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, buildXmlHttpRequest).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, openXmlHttpRequest).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, setXmlHttpRequestHeader).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, sendXmlHttpRequest).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, abortXmlHttpRequest).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes bundled deno extern builtins precisely', async () => {
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
          include: ['src/**/*.ts', '__soundscript_externs__/**/*.d.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: '__soundscript_externs__/deno.global.d.ts',
      contents: [
        'declare namespace Deno {',
        '  interface Env {',
        '    // #[effects(add: [host.system, host.deno.env, mut])]',
        '    delete(key: string): void;',
        '    // #[effects(add: [host.system, host.deno.env])]',
        '    get(key: string): string | undefined;',
        '    // #[effects(add: [host.system, host.deno.env])]',
        '    has(key: string): boolean;',
        '    // #[effects(add: [host.system, host.deno.env, mut])]',
        '    set(key: string, value: string): void;',
        '    // #[effects(add: [host.system, host.deno.env])]',
        '    toObject(): Record<string, string>;',
        '  }',
        '}',
        '',
        'declare const Deno: {',
        '  readonly args: readonly string[];',
        '  readonly env: Deno.Env;',
        '  // #[effects(add: [host.system, host.deno.fs, mut, fails.throws])]',
        '  chdir(directory: string | URL): void;',
        '  // #[effects(add: [host.system, host.deno.fs])]',
        '  cwd(): string;',
        '  // #[effects(add: [host.io, host.deno.fs, suspend.await])]',
        '  readFile(path: string | URL): Promise<Uint8Array<ArrayBufferLike>>;',
        '  // #[effects(add: [host.io, host.deno.fs, fails.throws])]',
        '  readFileSync(path: string | URL): Uint8Array<ArrayBufferLike>;',
        '  // #[effects(add: [host.io, host.deno.fs, suspend.await])]',
        '  readTextFile(path: string | URL): Promise<string>;',
        '  // #[effects(add: [host.io, host.deno.fs, fails.throws])]',
        '  readTextFileSync(path: string | URL): string;',
        '  // #[effects(add: [host.io, host.deno.fs, mut, suspend.await])]',
        '  mkdir(path: string | URL): Promise<void>;',
        '  // #[effects(add: [host.io, host.deno.fs, mut, fails.throws])]',
        '  mkdirSync(path: string | URL): void;',
        '  // #[effects(add: [host.io, host.deno.fs, mut, suspend.await])]',
        '  remove(path: string | URL): Promise<void>;',
        '  // #[effects(add: [host.io, host.deno.fs, mut, fails.throws])]',
        '  removeSync(path: string | URL): void;',
        '  // #[effects(add: [host.io, host.deno.fs, mut, suspend.await])]',
        '  writeTextFile(path: string | URL, data: string): Promise<void>;',
        '  // #[effects(add: [host.io, host.deno.fs, mut, fails.throws])]',
        '  writeTextFileSync(path: string | URL, data: string): void;',
        '};',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'export function readCurrentDirectory(): string {',
        '  return Deno.cwd();',
        '}',
        '',
        'export function readEnvValue(): string | undefined {',
        '  return Deno.env.get("HOME");',
        '}',
        '',
        'export function hasEnvValue(): boolean {',
        '  return Deno.env.has("HOME");',
        '}',
        '',
        'export function snapshotEnv(): Record<string, string> {',
        '  return Deno.env.toObject();',
        '}',
        '',
        'export function setEnvValue(value: string): void {',
        '  Deno.env.set("HOME", value);',
        '}',
        '',
        'export function deleteEnvValue(): void {',
        '  Deno.env.delete("HOME");',
        '}',
        '',
        'export function readBinary(path: string): Promise<Uint8Array<ArrayBufferLike>> {',
        '  return Deno.readFile(path);',
        '}',
        '',
        'export function readBinarySync(path: string): Uint8Array<ArrayBufferLike> {',
        '  return Deno.readFileSync(path);',
        '}',
        '',
        'export function readText(path: string): Promise<string> {',
        '  return Deno.readTextFile(path);',
        '}',
        '',
        'export function readTextSync(path: string): string {',
        '  return Deno.readTextFileSync(path);',
        '}',
        '',
        'export function makeDirectory(path: string): Promise<void> {',
        '  return Deno.mkdir(path);',
        '}',
        '',
        'export function makeDirectorySync(path: string): void {',
        '  Deno.mkdirSync(path);',
        '}',
        '',
        'export function removePath(path: string): Promise<void> {',
        '  return Deno.remove(path);',
        '}',
        '',
        'export function removePathSync(path: string): void {',
        '  Deno.removeSync(path);',
        '}',
        '',
        'export function writeText(path: string, data: string): Promise<void> {',
        '  return Deno.writeTextFile(path, data);',
        '}',
        '',
        'export function writeTextSync(path: string, data: string): void {',
        '  Deno.writeTextFileSync(path, data);',
        '}',
        '',
        'export function changeDirectory(path: string): void {',
        '  Deno.chdir(path);',
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

  const readCurrentDirectory = declarationsByName.get('readCurrentDirectory');
  const readEnvValue = declarationsByName.get('readEnvValue');
  const hasEnvValue = declarationsByName.get('hasEnvValue');
  const snapshotEnv = declarationsByName.get('snapshotEnv');
  const setEnvValue = declarationsByName.get('setEnvValue');
  const deleteEnvValue = declarationsByName.get('deleteEnvValue');
  const readBinary = declarationsByName.get('readBinary');
  const readBinarySync = declarationsByName.get('readBinarySync');
  const readText = declarationsByName.get('readText');
  const readTextSync = declarationsByName.get('readTextSync');
  const makeDirectory = declarationsByName.get('makeDirectory');
  const makeDirectorySync = declarationsByName.get('makeDirectorySync');
  const removePath = declarationsByName.get('removePath');
  const removePathSync = declarationsByName.get('removePathSync');
  const writeText = declarationsByName.get('writeText');
  const writeTextSync = declarationsByName.get('writeTextSync');
  const changeDirectory = declarationsByName.get('changeDirectory');

  assertExists(readCurrentDirectory);
  assertExists(readEnvValue);
  assertExists(hasEnvValue);
  assertExists(snapshotEnv);
  assertExists(setEnvValue);
  assertExists(deleteEnvValue);
  assertExists(readBinary);
  assertExists(readBinarySync);
  assertExists(readText);
  assertExists(readTextSync);
  assertExists(makeDirectory);
  assertExists(makeDirectorySync);
  assertExists(removePath);
  assertExists(removePathSync);
  assertExists(writeText);
  assertExists(writeTextSync);
  assertExists(changeDirectory);

  assertEquals(
    getEffectSummaryForDeclaration(context, readCurrentDirectory).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readEnvValue).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, hasEnvValue).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, snapshotEnv).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, setEnvValue).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, deleteEnvValue).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readBinary).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readBinarySync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readText).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readTextSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeDirectory).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeDirectorySync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, removePath).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, removePathSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, writeText).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, writeTextSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, changeDirectory).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );

  assertEquals(getEffectSummaryForDeclaration(context, readCurrentDirectory).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readEnvValue).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, hasEnvValue).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, snapshotEnv).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, setEnvValue).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, deleteEnvValue).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readBinary).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readBinarySync).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readText).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, readTextSync).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, makeDirectory).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, makeDirectorySync).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, removePath).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, removePathSync).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, writeText).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, writeTextSync).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, changeDirectory).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext summarizes bundled node builtins precisely', async () => {
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
          include: ['src/**/*.ts', '__soundscript_externs__/**/*.d.ts'],
        },
        null,
        2,
      ),
    },
    {
      path: '__soundscript_externs__/node.global.d.ts',
      contents: [
        'interface ProcessEnv {',
        '  [key: string]: string | undefined;',
        '}',
        '',
        'interface Process {',
        '  readonly argv: readonly string[];',
        '  readonly env: ProcessEnv;',
        '  // #[effects(add: [host.system, host.node.process, mut, fails.throws])]',
        '  chdir(directory: string): void;',
        '  // #[effects(add: [host.system, host.node.process])]',
        '  cwd(): string;',
        '  // #[effects(add: [host.system, host.node.process])]',
        '  exit(code?: number): never;',
        '}',
        '',
        'declare const process: Process;',
        '',
        'interface Immediate {}',
        '',
        '// #[effects(add: [host.time])]',
        'declare function setImmediate(callback: (...args: unknown[]) => void): Immediate;',
        '// #[effects(add: [host.time])]',
        'declare function clearImmediate(handle: Immediate): void;',
        '',
        'interface Buffer extends Uint8Array<ArrayBufferLike> {',
        '  // #[effects(add: [])]',
        '  toString(encoding?: string): string;',
        '}',
        '',
        'declare const Buffer: {',
        '  // #[effects(add: [])]',
        '  alloc(size: number): Buffer;',
        '  // #[effects(add: [])]',
        '  from(',
        '    data: string | ArrayLike<number> | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>,',
        '  ): Buffer;',
        '  // #[effects(add: [])]',
        '  concat(list: readonly ArrayBufferView<ArrayBufferLike>[]): Buffer;',
        '};',
        '',
      ].join('\n'),
    },
    {
      path: '__soundscript_externs__/node.fs.d.ts',
      contents: [
        'declare module "node:fs" {',
        '  export interface Stats {}',
        '  // #[effects(add: [host.io, host.node.fs, fails.throws])]',
        '  export function accessSync(path: string): void;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function appendFileSync(path: string, data: string | Uint8Array<ArrayBufferLike>): void;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function cpSync(source: string, destination: string): void;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function copyFileSync(source: string, destination: string): void;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function mkdtempSync(prefix: string): string;',
        '  // #[effects(add: [host.io, host.node.fs, fails.throws])]',
        '  export function readlinkSync(path: string): string;',
        '  // #[effects(add: [host.io, host.node.fs, fails.throws])]',
        '  export function realpathSync(path: string): string;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function renameSync(oldPath: string, newPath: string): void;',
        '  // #[effects(add: [host.io, host.node.fs, fails.throws])]',
        '  export function readFileSync(path: string): Uint8Array<ArrayBufferLike>;',
        '  // #[effects(add: [host.io, host.node.fs, fails.throws])]',
        '  export function readdirSync(path: string): string[];',
        '  // #[effects(add: [host.io, host.node.fs, fails.throws])]',
        '  export function statSync(path: string): Stats;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function symlinkSync(target: string, path: string): void;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function truncateSync(path: string, len?: number): void;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function unlinkSync(path: string): void;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function writeFileSync(path: string, data: string | Uint8Array<ArrayBufferLike>): void;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function mkdirSync(path: string): void;',
        '  // #[effects(add: [host.io, host.node.fs, mut, fails.throws])]',
        '  export function rmSync(path: string): void;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: '__soundscript_externs__/node.fs.promises.d.ts',
      contents: [
        'declare module "node:fs/promises" {',
        '  export interface Stats {}',
        '  // #[effects(add: [host.io, host.node.fs, suspend.await])]',
        '  export function access(path: string): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function appendFile(path: string, data: string | Uint8Array<ArrayBufferLike>): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function cp(source: string, destination: string): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function copyFile(source: string, destination: string): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function mkdtemp(prefix: string): Promise<string>;',
        '  // #[effects(add: [host.io, host.node.fs, suspend.await])]',
        '  export function readlink(path: string): Promise<string>;',
        '  // #[effects(add: [host.io, host.node.fs, suspend.await])]',
        '  export function realpath(path: string): Promise<string>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function rename(oldPath: string, newPath: string): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, suspend.await])]',
        '  export function readFile(path: string): Promise<Uint8Array<ArrayBufferLike>>;',
        '  // #[effects(add: [host.io, host.node.fs, suspend.await])]',
        '  export function readdir(path: string): Promise<string[]>;',
        '  // #[effects(add: [host.io, host.node.fs, suspend.await])]',
        '  export function stat(path: string): Promise<Stats>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function symlink(target: string, path: string): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function truncate(path: string, len?: number): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function unlink(path: string): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function writeFile(path: string, data: string | Uint8Array<ArrayBufferLike>): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function mkdir(path: string): Promise<void>;',
        '  // #[effects(add: [host.io, host.node.fs, mut, suspend.await])]',
        '  export function rm(path: string): Promise<void>;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: '__soundscript_externs__/node.path.d.ts',
      contents: [
        'declare module "node:path" {',
        '  // #[effects(add: [])]',
        '  export function basename(path: string): string;',
        '  // #[effects(add: [])]',
        '  export function dirname(path: string): string;',
        '  // #[effects(add: [])]',
        '  export function join(...paths: readonly string[]): string;',
        '  // #[effects(add: [])]',
        '  export function resolve(...paths: readonly string[]): string;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: '__soundscript_externs__/node.buffer.d.ts',
      contents: [
        'declare module "node:buffer" {',
        '  export interface Buffer extends Uint8Array<ArrayBufferLike> {',
        '    // #[effects(add: [])]',
        '    toString(encoding?: string): string;',
        '  }',
        '  export const Buffer: {',
        '    // #[effects(add: [])]',
        '    alloc(size: number): Buffer;',
        '    // #[effects(add: [])]',
        '    from(data: string | ArrayLike<number> | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>): Buffer;',
        '    // #[effects(add: [])]',
        '    concat(list: readonly ArrayBufferView<ArrayBufferLike>[]): Buffer;',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: '__soundscript_externs__/node.crypto.d.ts',
      contents: [
        'declare module "node:crypto" {',
        '  export interface Hash {',
        '    // #[effects(add: [fails.throws, mut])]',
        '    update(data: string | Uint8Array<ArrayBufferLike>): Hash;',
        '    // #[effects(add: [fails.throws])]',
        '    digest(): Buffer;',
        '    // #[effects(add: [fails.throws])]',
        '    digest(encoding: string): string;',
        '  }',
        '  export interface Hmac {',
        '    // #[effects(add: [fails.throws, mut])]',
        '    update(data: string | Uint8Array<ArrayBufferLike>): Hmac;',
        '    // #[effects(add: [fails.throws])]',
        '    digest(): Buffer;',
        '    // #[effects(add: [fails.throws])]',
        '    digest(encoding: string): string;',
        '  }',
        '  // #[effects(add: [fails.throws])]',
        '  export function createHash(algorithm: string): Hash;',
        '  // #[effects(add: [fails.throws])]',
        '  export function createHmac(algorithm: string, key: string): Hmac;',
        '  // #[effects(add: [host.random])]',
        '  export function randomInt(max: number): number;',
        '  // #[effects(add: [host.random])]',
        '  export function randomUUID(): string;',
        '  // #[effects(add: [host.random])]',
        '  export function randomBytes(size: number): Buffer;',
        '  // #[effects(add: [host.random, mut])]',
        '  export function randomFillSync<T extends Uint8Array<ArrayBufferLike>>(array: T): T;',
        '  // #[effects(add: [host.random, mut, suspend.await])]',
        '  export function randomFill<T extends Uint8Array<ArrayBufferLike>>(array: T): Promise<T>;',
        '  // #[effects(add: [host.random, mut])]',
        '  export function getRandomValues<T extends DataView<ArrayBufferLike> | Uint8Array<ArrayBufferLike>>(array: T): T;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: '__soundscript_externs__/node.timers.d.ts',
      contents: [
        'declare module "node:timers" {',
        '  export interface Timeout {}',
        '  // #[effects(add: [host.time])]',
        '  export function setImmediate(callback: (...args: unknown[]) => void): Immediate;',
        '  // #[effects(add: [host.time])]',
        '  export function clearImmediate(handle: Immediate): void;',
        '  // #[effects(add: [host.time])]',
        '  export function setTimeout(callback: (...args: unknown[]) => void, delay?: number): Timeout;',
        '  // #[effects(add: [host.time])]',
        '  export function clearTimeout(handle: Timeout): void;',
        '  // #[effects(add: [host.time])]',
        '  export function setInterval(callback: (...args: unknown[]) => void, delay?: number): Timeout;',
        '  // #[effects(add: [host.time])]',
        '  export function clearInterval(handle: Timeout): void;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: '__soundscript_externs__/node.timers.promises.d.ts',
      contents: [
        'declare module "node:timers/promises" {',
        '  // #[effects(add: [host.time, suspend.await])]',
        '  export function setImmediate(): Promise<void>;',
        '  // #[effects(add: [host.time, suspend.await])]',
        '  export function setTimeout(delay?: number): Promise<void>;',
        '  export interface Scheduler {',
        '    // #[effects(add: [host.time, suspend.await])]',
        '    wait(delay?: number): Promise<void>;',
        '    // #[effects(add: [host.time, suspend.await])]',
        '    yield(): Promise<void>;',
        '  }',
        '  export const scheduler: Scheduler;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      contents: [
        'import { createHash, createHmac, getRandomValues, randomBytes, randomFill, randomFillSync, randomInt, randomUUID } from "node:crypto";',
        'import { Buffer as ModuleBuffer } from "node:buffer";',
        'import { access, appendFile, cp, copyFile, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, stat, symlink, truncate, unlink, writeFile } from "node:fs/promises";',
        'import { accessSync, appendFileSync, cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        'import { clearImmediate as clearModuleImmediate, clearInterval, clearTimeout, setImmediate as setModuleImmediate, setInterval, setTimeout } from "node:timers";',
        'import { scheduler, setImmediate as waitImmediate, setTimeout as waitTimeout } from "node:timers/promises";',
        '',
        'export function currentWorkingDirectory(): string {',
        '  return process.cwd();',
        '}',
        '',
        'export function changeDirectory(path: string): void {',
        '  process.chdir(path);',
        '}',
        '',
        'export function exitProcess(code: number): never {',
        '  return process.exit(code);',
        '}',
        '',
        'export function scheduleImmediate(callback: () => void): Immediate {',
        '  return setImmediate(callback);',
        '}',
        '',
        'export function cancelImmediate(handle: Immediate): void {',
        '  clearImmediate(handle);',
        '}',
        '',
        'export function makeBuffer(value: string): Buffer {',
        '  return Buffer.from(value);',
        '}',
        '',
        'export function allocateBuffer(size: number): Buffer {',
        '  return Buffer.alloc(size);',
        '}',
        '',
        'export function concatBuffers(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Buffer {',
        '  return Buffer.concat([a, b]);',
        '}',
        '',
        'export function stringifyBuffer(value: Buffer): string {',
        '  return value.toString();',
        '}',
        '',
        'export function makeModuleBuffer(value: string): Buffer {',
        '  return ModuleBuffer.from(value);',
        '}',
        '',
        'export function joinPath(left: string, right: string): string {',
        '  return join(dirname(left), right);',
        '}',
        '',
        'export function makeUuid(): string {',
        '  return randomUUID();',
        '}',
        '',
        'export function makeHasher() {',
        '  return createHash("sha256");',
        '}',
        '',
        'export function makeHmac() {',
        '  return createHmac("sha256", "key");',
        '}',
        '',
        'export function makeRandomInt(max: number): number {',
        '  return randomInt(max);',
        '}',
        '',
        'export function makeRandomBytes(size: number): Buffer {',
        '  return randomBytes(size);',
        '}',
        '',
        'export function fillRandom(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {',
          '  return getRandomValues(bytes);',
        '}',
        '',
        'export function fillRandomSync(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {',
        '  return randomFillSync(bytes);',
        '}',
        '',
        'export function fillRandomAsync(bytes: Uint8Array<ArrayBufferLike>): Promise<Uint8Array<ArrayBufferLike>> {',
        '  return randomFill(bytes);',
        '}',
        '',
        'export function hashText(value: string): Buffer {',
        '  const hash = createHash("sha256");',
        '  hash.update(value);',
        '  return hash.digest();',
        '}',
        '',
        'export function hashTextHex(value: string): string {',
        '  const hash = createHash("sha256");',
        '  hash.update(value);',
        '  return hash.digest("hex");',
        '}',
        '',
        'export function hmacText(value: string): Buffer {',
        '  const hmac = createHmac("sha256", "key");',
        '  hmac.update(value);',
        '  return hmac.digest();',
        '}',
        '',
        'export function hmacTextHex(value: string): string {',
        '  const hmac = createHmac("sha256", "key");',
        '  hmac.update(value);',
        '  return hmac.digest("hex");',
        '}',
        '',
        'export function scheduleModuleImmediate(callback: () => void): Immediate {',
        '  return setModuleImmediate(callback);',
        '}',
        '',
        'export function cancelModuleImmediate(handle: Immediate): void {',
        '  clearModuleImmediate(handle);',
        '}',
        '',
        'export function scheduleTimeout(callback: () => void): Timeout {',
        '  return setTimeout(callback, 10);',
        '}',
        '',
        'export function cancelTimeout(handle: Timeout): void {',
        '  clearTimeout(handle);',
        '}',
        '',
        'export function scheduleInterval(callback: () => void): Timeout {',
        '  return setInterval(callback, 10);',
        '}',
        '',
        'export function cancelInterval(handle: Timeout): void {',
        '  clearInterval(handle);',
        '}',
        '',
        'export function awaitImmediate(): Promise<void> {',
        '  return waitImmediate();',
        '}',
        '',
        'export function awaitTimeout(): Promise<void> {',
        '  return waitTimeout(10);',
        '}',
        '',
        'export function waitOnScheduler(): Promise<void> {',
        '  return scheduler.wait(10);',
        '}',
        '',
        'export function yieldOnScheduler(): Promise<void> {',
        '  return scheduler.yield();',
        '}',
        '',
        'export function accessPath(path: string): Promise<void> {',
        '  return access(path);',
        '}',
        '',
        'export function accessPathSync(path: string): void {',
        '  accessSync(path);',
        '}',
        '',
        'export function statPath(path: string) {',
        '  return stat(path);',
        '}',
        '',
        'export function statPathSync(path: string) {',
        '  return statSync(path);',
        '}',
        '',
        'export function renamePath(from: string, to: string): Promise<void> {',
        '  return rename(from, to);',
        '}',
        '',
        'export function renamePathSync(from: string, to: string): void {',
        '  renameSync(from, to);',
        '}',
        '',
        'export function copyPath(from: string, to: string): Promise<void> {',
        '  return copyFile(from, to);',
        '}',
        '',
        'export function copyPathSync(from: string, to: string): void {',
        '  copyFileSync(from, to);',
        '}',
        '',
        'export function readLinkTarget(path: string): Promise<string> {',
        '  return readlink(path);',
        '}',
        '',
        'export function readLinkTargetSync(path: string): string {',
        '  return readlinkSync(path);',
        '}',
        '',
        'export function resolveRealPath(path: string): Promise<string> {',
        '  return realpath(path);',
        '}',
        '',
        'export function resolveRealPathSync(path: string): string {',
        '  return realpathSync(path);',
        '}',
        '',
        'export function createSymlink(target: string, path: string): Promise<void> {',
        '  return symlink(target, path);',
        '}',
        '',
        'export function createSymlinkSync(target: string, path: string): void {',
        '  symlinkSync(target, path);',
        '}',
        '',
        'export function unlinkPath(path: string): Promise<void> {',
        '  return unlink(path);',
        '}',
        '',
        'export function unlinkPathSync(path: string): void {',
        '  unlinkSync(path);',
        '}',
        '',
        'export function makeTempDirectory(prefix: string): Promise<string> {',
        '  return mkdtemp(prefix);',
        '}',
        '',
        'export function makeTempDirectorySync(prefix: string): string {',
        '  return mkdtempSync(prefix);',
        '}',
        '',
        'export function copyTree(from: string, to: string): Promise<void> {',
        '  return cp(from, to);',
        '}',
        '',
        'export function copyTreeSync(from: string, to: string): void {',
        '  cpSync(from, to);',
        '}',
        '',
        'export function truncatePath(path: string): Promise<void> {',
        '  return truncate(path, 0);',
        '}',
        '',
        'export function truncatePathSync(path: string): void {',
        '  truncateSync(path, 0);',
        '}',
        '',
        'export function appendBinary(path: string, data: Uint8Array<ArrayBufferLike>): Promise<void> {',
        '  return appendFile(path, data);',
        '}',
        '',
        'export function appendBinarySync(path: string, data: Uint8Array<ArrayBufferLike>): void {',
        '  appendFileSync(path, data);',
        '}',
        '',
        'export function readBinary(path: string): Promise<Uint8Array<ArrayBufferLike>> {',
        '  return readFile(path);',
        '}',
        '',
        'export function readBinarySync(path: string): Uint8Array<ArrayBufferLike> {',
        '  return readFileSync(path);',
        '}',
        '',
        'export function readDirectory(path: string): Promise<string[]> {',
        '  return readdir(path);',
        '}',
        '',
        'export function readDirectorySync(path: string): string[] {',
        '  return readdirSync(path);',
        '}',
        '',
        'export function writeBinary(path: string, data: Uint8Array<ArrayBufferLike>): Promise<void> {',
        '  return writeFile(path, data);',
        '}',
        '',
        'export function writeBinarySync(path: string, data: Uint8Array<ArrayBufferLike>): void {',
        '  writeFileSync(path, data);',
        '}',
        '',
        'export function makeDirectory(path: string): Promise<void> {',
        '  return mkdir(path);',
        '}',
        '',
        'export function makeDirectorySync(path: string): void {',
        '  mkdirSync(path);',
        '}',
        '',
        'export function removePath(path: string): Promise<void> {',
        '  return rm(path);',
        '}',
        '',
        'export function removePathSync(path: string): void {',
        '  rmSync(path);',
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

  const currentWorkingDirectory = declarationsByName.get('currentWorkingDirectory');
  const changeDirectory = declarationsByName.get('changeDirectory');
  const exitProcess = declarationsByName.get('exitProcess');
  const scheduleImmediate = declarationsByName.get('scheduleImmediate');
  const cancelImmediate = declarationsByName.get('cancelImmediate');
  const makeBuffer = declarationsByName.get('makeBuffer');
  const allocateBuffer = declarationsByName.get('allocateBuffer');
  const concatBuffers = declarationsByName.get('concatBuffers');
  const stringifyBuffer = declarationsByName.get('stringifyBuffer');
  const makeModuleBuffer = declarationsByName.get('makeModuleBuffer');
  const joinPath = declarationsByName.get('joinPath');
  const makeUuid = declarationsByName.get('makeUuid');
  const makeHasher = declarationsByName.get('makeHasher');
  const makeHmac = declarationsByName.get('makeHmac');
  const makeRandomInt = declarationsByName.get('makeRandomInt');
  const makeRandomBytes = declarationsByName.get('makeRandomBytes');
  const fillRandom = declarationsByName.get('fillRandom');
  const fillRandomSync = declarationsByName.get('fillRandomSync');
  const fillRandomAsync = declarationsByName.get('fillRandomAsync');
  const hashText = declarationsByName.get('hashText');
  const hashTextHex = declarationsByName.get('hashTextHex');
  const hmacText = declarationsByName.get('hmacText');
  const hmacTextHex = declarationsByName.get('hmacTextHex');
  const scheduleModuleImmediate = declarationsByName.get('scheduleModuleImmediate');
  const cancelModuleImmediate = declarationsByName.get('cancelModuleImmediate');
  const scheduleTimeout = declarationsByName.get('scheduleTimeout');
  const cancelTimeout = declarationsByName.get('cancelTimeout');
  const scheduleInterval = declarationsByName.get('scheduleInterval');
  const cancelInterval = declarationsByName.get('cancelInterval');
  const awaitImmediate = declarationsByName.get('awaitImmediate');
  const awaitTimeout = declarationsByName.get('awaitTimeout');
  const waitOnScheduler = declarationsByName.get('waitOnScheduler');
  const yieldOnScheduler = declarationsByName.get('yieldOnScheduler');
  const accessPath = declarationsByName.get('accessPath');
  const accessPathSync = declarationsByName.get('accessPathSync');
  const statPath = declarationsByName.get('statPath');
  const statPathSync = declarationsByName.get('statPathSync');
  const renamePath = declarationsByName.get('renamePath');
  const renamePathSync = declarationsByName.get('renamePathSync');
  const copyPath = declarationsByName.get('copyPath');
  const copyPathSync = declarationsByName.get('copyPathSync');
  const readLinkTarget = declarationsByName.get('readLinkTarget');
  const readLinkTargetSync = declarationsByName.get('readLinkTargetSync');
  const resolveRealPath = declarationsByName.get('resolveRealPath');
  const resolveRealPathSync = declarationsByName.get('resolveRealPathSync');
  const createSymlink = declarationsByName.get('createSymlink');
  const createSymlinkSync = declarationsByName.get('createSymlinkSync');
  const unlinkPath = declarationsByName.get('unlinkPath');
  const unlinkPathSync = declarationsByName.get('unlinkPathSync');
  const makeTempDirectory = declarationsByName.get('makeTempDirectory');
  const makeTempDirectorySync = declarationsByName.get('makeTempDirectorySync');
  const copyTree = declarationsByName.get('copyTree');
  const copyTreeSync = declarationsByName.get('copyTreeSync');
  const truncatePath = declarationsByName.get('truncatePath');
  const truncatePathSync = declarationsByName.get('truncatePathSync');
  const appendBinary = declarationsByName.get('appendBinary');
  const appendBinarySync = declarationsByName.get('appendBinarySync');
  const readBinary = declarationsByName.get('readBinary');
  const readBinarySync = declarationsByName.get('readBinarySync');
  const readDirectory = declarationsByName.get('readDirectory');
  const readDirectorySync = declarationsByName.get('readDirectorySync');
  const writeBinary = declarationsByName.get('writeBinary');
  const writeBinarySync = declarationsByName.get('writeBinarySync');
  const makeDirectory = declarationsByName.get('makeDirectory');
  const makeDirectorySync = declarationsByName.get('makeDirectorySync');
  const removePath = declarationsByName.get('removePath');
  const removePathSync = declarationsByName.get('removePathSync');

  assertExists(currentWorkingDirectory);
  assertExists(changeDirectory);
  assertExists(exitProcess);
  assertExists(scheduleImmediate);
  assertExists(cancelImmediate);
  assertExists(makeBuffer);
  assertExists(allocateBuffer);
  assertExists(concatBuffers);
  assertExists(stringifyBuffer);
  assertExists(makeModuleBuffer);
  assertExists(joinPath);
  assertExists(makeUuid);
  assertExists(makeHasher);
  assertExists(makeHmac);
  assertExists(makeRandomInt);
  assertExists(makeRandomBytes);
  assertExists(fillRandom);
  assertExists(fillRandomSync);
  assertExists(fillRandomAsync);
  assertExists(hashText);
  assertExists(hashTextHex);
  assertExists(hmacText);
  assertExists(hmacTextHex);
  assertExists(scheduleModuleImmediate);
  assertExists(cancelModuleImmediate);
  assertExists(scheduleTimeout);
  assertExists(cancelTimeout);
  assertExists(scheduleInterval);
  assertExists(cancelInterval);
  assertExists(awaitImmediate);
  assertExists(awaitTimeout);
  assertExists(waitOnScheduler);
  assertExists(yieldOnScheduler);
  assertExists(accessPath);
  assertExists(accessPathSync);
  assertExists(statPath);
  assertExists(statPathSync);
  assertExists(renamePath);
  assertExists(renamePathSync);
  assertExists(copyPath);
  assertExists(copyPathSync);
  assertExists(readLinkTarget);
  assertExists(readLinkTargetSync);
  assertExists(resolveRealPath);
  assertExists(resolveRealPathSync);
  assertExists(createSymlink);
  assertExists(createSymlinkSync);
  assertExists(unlinkPath);
  assertExists(unlinkPathSync);
  assertExists(makeTempDirectory);
  assertExists(makeTempDirectorySync);
  assertExists(copyTree);
  assertExists(copyTreeSync);
  assertExists(truncatePath);
  assertExists(truncatePathSync);
  assertExists(appendBinary);
  assertExists(appendBinarySync);
  assertExists(readBinary);
  assertExists(readBinarySync);
  assertExists(readDirectory);
  assertExists(readDirectorySync);
  assertExists(writeBinary);
  assertExists(writeBinarySync);
  assertExists(makeDirectory);
  assertExists(makeDirectorySync);
  assertExists(removePath);
  assertExists(removePathSync);

  assertEquals(
    getEffectSummaryForDeclaration(context, currentWorkingDirectory).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, changeDirectory).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop | INTERNAL_EFFECT_MASKS.failsThrows |
      INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, exitProcess).directMask,
    INTERNAL_EFFECT_MASKS.hostInterop,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, scheduleImmediate).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, cancelImmediate).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );
  assertEquals(getEffectSummaryForDeclaration(context, makeBuffer).directMask, 0);
  assertEquals(getEffectSummaryForDeclaration(context, allocateBuffer).directMask, 0);
  assertEquals(getEffectSummaryForDeclaration(context, concatBuffers).directMask, 0);
  assertEquals(getEffectSummaryForDeclaration(context, stringifyBuffer).directMask, 0);
  assertEquals(getEffectSummaryForDeclaration(context, makeModuleBuffer).directMask, 0);
  assertEquals(getEffectSummaryForDeclaration(context, joinPath).directMask, 0);
  assertEquals(
    getEffectSummaryForDeclaration(context, makeUuid).directMask,
    INTERNAL_EFFECT_MASKS.hostRandom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeHasher).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeHmac).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeRandomInt).directMask,
    INTERNAL_EFFECT_MASKS.hostRandom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeRandomBytes).directMask,
    INTERNAL_EFFECT_MASKS.hostRandom,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, fillRandom).directMask,
    INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, fillRandomSync).directMask,
    INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, fillRandomAsync).directMask,
    INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.mut |
      INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, hashText).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, hashTextHex).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, hmacText).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, hmacTextHex).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, scheduleModuleImmediate).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, cancelModuleImmediate).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, scheduleTimeout).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, cancelTimeout).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, scheduleInterval).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, cancelInterval).directMask,
    INTERNAL_EFFECT_MASKS.hostTime,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, awaitImmediate).directMask,
    INTERNAL_EFFECT_MASKS.hostTime | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, awaitTimeout).directMask,
    INTERNAL_EFFECT_MASKS.hostTime | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, waitOnScheduler).directMask,
    INTERNAL_EFFECT_MASKS.hostTime | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, yieldOnScheduler).directMask,
    INTERNAL_EFFECT_MASKS.hostTime | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, accessPath).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, accessPathSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, statPath).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, statPathSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, renamePath).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, renamePathSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, copyPath).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, copyPathSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readLinkTarget).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readLinkTargetSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, resolveRealPath).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, resolveRealPathSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, createSymlink).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, createSymlinkSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, unlinkPath).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, unlinkPathSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeTempDirectory).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeTempDirectorySync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, copyTree).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, copyTreeSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, truncatePath).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, truncatePathSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, appendBinary).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, appendBinarySync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readBinary).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readBinarySync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readDirectory).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, readDirectorySync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, writeBinary).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, writeBinarySync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeDirectory).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, makeDirectorySync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, removePath).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.mut,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, removePathSync).directMask,
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.failsThrows | INTERNAL_EFFECT_MASKS.mut,
  );

  for (
    const declaration of [
      currentWorkingDirectory,
      changeDirectory,
      exitProcess,
      scheduleImmediate,
      cancelImmediate,
      makeBuffer,
      allocateBuffer,
      concatBuffers,
      stringifyBuffer,
    makeModuleBuffer,
    joinPath,
    makeUuid,
    makeHasher,
    makeHmac,
    makeRandomInt,
    makeRandomBytes,
    fillRandom,
    fillRandomSync,
    fillRandomAsync,
    hashText,
    hashTextHex,
    hmacText,
    hmacTextHex,
    scheduleModuleImmediate,
    cancelModuleImmediate,
    scheduleTimeout,
    cancelTimeout,
    scheduleInterval,
    cancelInterval,
    awaitImmediate,
    awaitTimeout,
    waitOnScheduler,
    yieldOnScheduler,
    accessPath,
    accessPathSync,
    statPath,
    statPathSync,
    renamePath,
    renamePathSync,
    copyPath,
    copyPathSync,
    readLinkTarget,
    readLinkTargetSync,
    resolveRealPath,
    resolveRealPathSync,
    createSymlink,
    createSymlinkSync,
    unlinkPath,
    unlinkPathSync,
    makeTempDirectory,
    makeTempDirectorySync,
    copyTree,
    copyTreeSync,
    truncatePath,
    truncatePathSync,
    appendBinary,
    appendBinarySync,
    readBinary,
      readBinarySync,
      readDirectory,
      readDirectorySync,
      writeBinary,
      writeBinarySync,
      makeDirectory,
      makeDirectorySync,
      removePath,
      removePathSync,
    ]
  ) {
    assertEquals(getEffectSummaryForDeclaration(context, declaration).hasUnknownDirectEffects, false);
  }
});

Deno.test('createAnalysisContext reaches a fixpoint for recursive effect summaries', async () => {
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
        'declare const failure: Error;',
        '',
        'export function selfRecursive(flag: boolean): void {',
        '  if (!flag) {',
        '    throw failure;',
        '  }',
        '  selfRecursive(false);',
        '}',
        '',
        'export function leftRecursive(flag: boolean): void {',
        '  if (!flag) {',
        '    rightRecursive(false);',
        '    return;',
        '  }',
        '  rightRecursive(false);',
        '}',
        '',
        'export function rightRecursive(flag: boolean): void {',
        '  if (!flag) {',
        '    throw failure;',
        '  }',
        '  leftRecursive(false);',
        '}',
        '',
        'export async function asyncLeft(flag: boolean): Promise<void> {',
        '  if (!flag) {',
        '    await asyncRight(false);',
        '    return;',
        '  }',
        '  await asyncRight(false);',
        '}',
        '',
        'export async function asyncRight(flag: boolean): Promise<void> {',
        '  if (!flag) {',
        '    throw failure;',
        '  }',
        '  await asyncLeft(false);',
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

  const selfRecursive = declarationsByName.get('selfRecursive');
  const leftRecursive = declarationsByName.get('leftRecursive');
  const rightRecursive = declarationsByName.get('rightRecursive');
  const asyncLeft = declarationsByName.get('asyncLeft');
  const asyncRight = declarationsByName.get('asyncRight');

  assertExists(selfRecursive);
  assertExists(leftRecursive);
  assertExists(rightRecursive);
  assertExists(asyncLeft);
  assertExists(asyncRight);

  assertEquals(
    getEffectSummaryForDeclaration(context, selfRecursive).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, leftRecursive).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, rightRecursive).directMask,
    INTERNAL_EFFECT_MASKS.failsThrows,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, asyncLeft).directMask,
    INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.failsRejects,
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, asyncRight).directMask,
    INTERNAL_EFFECT_MASKS.suspend | INTERNAL_EFFECT_MASKS.failsRejects,
  );

  assertEquals(getEffectSummaryForDeclaration(context, selfRecursive).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, leftRecursive).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, rightRecursive).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, asyncLeft).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, asyncRight).hasUnknownDirectEffects, false);
});

Deno.test('createAnalysisContext keeps effect summaries stable across repeated queries and query order', async () => {
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
        'declare const failure: Error;',
        '',
        'export function leftRecursive(flag: boolean): void {',
        '  if (!flag) {',
        '    rightRecursive(false);',
        '    return;',
        '  }',
        '  rightRecursive(false);',
        '}',
        '',
        'export function rightRecursive(flag: boolean): void {',
        '  if (!flag) {',
        '    throw failure;',
        '  }',
        '  leftRecursive(false);',
        '}',
        '',
      ].join('\n'),
    },
  ]);
  const projectPath = join(tempDirectory, 'tsconfig.json');
  const program = loadProgram(projectPath);

  const loadNamedDeclarations = (context: ReturnType<typeof createAnalysisContext>) => {
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
    return {
      leftRecursive: declarationsByName.get('leftRecursive'),
      rightRecursive: declarationsByName.get('rightRecursive'),
    };
  };

  const serializeSummary = (summary: ReturnType<typeof getEffectSummaryForDeclaration>) => ({
    directMask: summary.directMask,
    forbidMask: summary.forbidMask,
    forwardedParameters: normalizeForwardedParameters(summary.forwardedParameters),
    hasUnknownDirectEffects: summary.hasUnknownDirectEffects,
    parameterContracts: [...summary.parameterContracts],
    unknownDirectReasons: summary.unknownDirectReasons.map((reason) => `${reason.kind}:${reason.detail ?? ''}`),
  });

  const leftFirstContext = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const leftFirstDeclarations = loadNamedDeclarations(leftFirstContext);
  assertExists(leftFirstDeclarations.leftRecursive);
  assertExists(leftFirstDeclarations.rightRecursive);
  const leftFirstSummary = getEffectSummaryForDeclaration(
    leftFirstContext,
    leftFirstDeclarations.leftRecursive,
  );
  const leftRepeatSummary = getEffectSummaryForDeclaration(
    leftFirstContext,
    leftFirstDeclarations.leftRecursive,
  );
  const rightAfterLeftSummary = getEffectSummaryForDeclaration(
    leftFirstContext,
    leftFirstDeclarations.rightRecursive,
  );

  assertStrictEquals(leftRepeatSummary, leftFirstSummary);

  const rightFirstContext = createAnalysisContext({ program, workingDirectory: tempDirectory });
  const rightFirstDeclarations = loadNamedDeclarations(rightFirstContext);
  assertExists(rightFirstDeclarations.leftRecursive);
  assertExists(rightFirstDeclarations.rightRecursive);
  const rightFirstSummary = getEffectSummaryForDeclaration(
    rightFirstContext,
    rightFirstDeclarations.rightRecursive,
  );
  const leftAfterRightSummary = getEffectSummaryForDeclaration(
    rightFirstContext,
    rightFirstDeclarations.leftRecursive,
  );

  assertEquals(serializeSummary(leftFirstSummary), serializeSummary(leftAfterRightSummary));
  assertEquals(serializeSummary(rightAfterLeftSummary), serializeSummary(rightFirstSummary));
});

Deno.test('createAnalysisContext records structured effect unknown reasons', async () => {
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
      path: 'src/stdlib/json.d.ts',
      contents: [
        'import type { Decoder } from "./decode";',
        '',
        '// #[effects(add: [], forward: [decoder.decode])]',
        'export declare function parseAndDecode<T, E>(text: string, decoder: Decoder<T, E>): T | E;',
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
      path: 'src/index.ts',
      contents: [
        'import { parseAndDecode } from "./stdlib/json";',
        '',
        'declare function opaqueFrontier(): void;',
        '',
        '// #[effects(add: [], forward: [callback])]',
        'declare function forward<T>(callback: () => T): T;',
        '',
        'export function usesOpaqueFrontier(): void {',
        '  opaqueFrontier();',
        '}',
        '',
        'export function usesOpaqueCallback(): unknown {',
        '  const unknownCallback: any = 0;',
        '  return forward(unknownCallback);',
        '}',
        '',
        'export function unresolvedDecoder(text: string): unknown {',
        '  return parseAndDecode(text, {} as any);',
        '}',
        '',
        'export function usesDispatch(target: EventTarget, event: Event): boolean {',
        '  return target.dispatchEvent(event);',
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

  const usesOpaqueFrontier = declarationsByName.get('usesOpaqueFrontier');
  const usesOpaqueCallback = declarationsByName.get('usesOpaqueCallback');
  const unresolvedDecoder = declarationsByName.get('unresolvedDecoder');
  const usesDispatch = declarationsByName.get('usesDispatch');

  assertExists(usesOpaqueFrontier);
  assertExists(usesOpaqueCallback);
  assertExists(unresolvedDecoder);
  assertExists(usesDispatch);

  assertEquals(
    getEffectSummaryForDeclaration(context, usesOpaqueFrontier).unknownDirectReasons.map((reason) => reason.kind),
    ['unsummarizedDeclarationFrontier'],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, usesOpaqueCallback).unknownDirectReasons.map((reason) => reason.kind),
    ['opaqueCallableExpression'],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, unresolvedDecoder).unknownDirectReasons.map((reason) => reason.kind),
    ['unresolvedForwardedCallback'],
  );
  assertEquals(
    getEffectSummaryForDeclaration(context, usesDispatch).unknownDirectReasons.map((reason) => reason.kind),
    ['annotatedUnknownDirectEffect'],
  );
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
        '// #[effects(add: [suspend.await], forward: [{ from: fn, handle: [fails] }])]',
        'export declare function resultOf<T>(fn: () => Promise<T>): Promise<T | Error>;',
        '// #[effects(add: [suspend.await], forward: [{ from: fn, handle: [fails] }, { from: mapError, rewrite: [{ from: fails, to: fails.rejects }] }])]',
        'export declare function resultOf<T, E>(fn: () => Promise<T>, mapError: (error: Error) => E): Promise<T | E>;',
        '// #[effects(forward: [{ from: fn, handle: [fails] }])]',
        'export declare function resultOf<T>(fn: () => T): T | Error;',
        '// #[effects(forward: [{ from: fn, handle: [fails] }, { from: mapError }])]',
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
        '// #[effects(add: [])]',
        'export declare function parseJson(text: string): unknown;',
        '// #[effects(add: [])]',
        'export declare function stringifyJson(value: unknown): unknown;',
        '// #[effects(add: [])]',
        'export declare function parseJsonLike(text: string): unknown;',
        '// #[effects(add: [])]',
        'export declare function stringifyJsonLike(value: unknown): unknown;',
        '// #[effects(add: [], forward: [decoder.decode])]',
        'export declare function parseAndDecode<T, E>(text: string, decoder: Decoder<T, E>): T | E;',
        '// #[effects(add: [], forward: [encoder.encode])]',
        'export declare function encodeAndStringify<T, E>(value: T, encoder: Encoder<T, unknown, E>): unknown;',
        '// #[effects(add: [], forward: [decoder.decode])]',
        'export declare function decodeJson<T, E>(text: string, decoder: Decoder<T, E>): T | E;',
        '// #[effects(add: [], forward: [encoder.encode])]',
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
        '// #[effects(add: [fails.throws])]',
        'export declare function assert(condition: unknown, message?: string): asserts condition;',
        '// #[effects(add: [host.ffi])]',
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

Deno.test('createAnalysisContext infers forwarding through local callback aliases', async () => {
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
        'export interface Decoder<T> {',
        '  readonly decode: (value: number) => T;',
        '}',
        '',
        'export function aliasCallback<T>(callback: () => T): T {',
        '  const fn = callback;',
        '  return fn();',
        '}',
        '',
        'export function aliasMember<T>(decoder: Decoder<T>, value: number): T {',
        '  const decode = decoder.decode;',
        '  return decode(value);',
        '}',
        '',
        'export function destructuredMember<T>(decoder: Decoder<T>, value: number): T {',
        '  const { decode } = decoder;',
        '  return decode(value);',
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
      .filter((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement))
      .filter((declaration): declaration is ts.FunctionDeclaration & { name: ts.Identifier } =>
        declaration.name !== undefined
      )
      .map((declaration) => [declaration.name.text, declaration]),
  );
  const aliasCallback = declarationsByName.get('aliasCallback');
  const aliasMember = declarationsByName.get('aliasMember');
  const destructuredMember = declarationsByName.get('destructuredMember');

  assertExists(aliasCallback);
  assertExists(aliasMember);
  assertExists(destructuredMember);

  assertEquals(
    normalizeForwardedParameters(getEffectSummaryForDeclaration(context, aliasCallback).forwardedParameters),
    [{ parameterIndex: 0, failureBoundary: 'preserve' }],
  );
  assertEquals(
    normalizeForwardedParameters(getEffectSummaryForDeclaration(context, aliasMember).forwardedParameters),
    [{ parameterIndex: 0, failureBoundary: 'preserve', memberName: 'decode' }],
  );
  assertEquals(
    normalizeForwardedParameters(getEffectSummaryForDeclaration(context, destructuredMember).forwardedParameters),
    [{ parameterIndex: 0, failureBoundary: 'preserve', memberName: 'decode' }],
  );
  assertEquals(getEffectSummaryForDeclaration(context, aliasCallback).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, aliasMember).hasUnknownDirectEffects, false);
  assertEquals(getEffectSummaryForDeclaration(context, destructuredMember).hasUnknownDirectEffects, false);
});
