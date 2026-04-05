import { assertEquals, assertMatch, assertStringIncludes } from '@std/assert';

import {
  assertWatCallsFallbackObjectGeneralize,
  assertWatCallsFallbackObjectHas,
  assertWatCallsFallbackObjectSet,
  assertWatCallsFallbackOrderedObjectKeysListing,
  assertWatCallsSpecializedObjectKeysListing,
  assertWatDeclaresFallbackObjectType,
  assertWatUsesDistinctSpecializedObjectKeysHelperSymbols,
  compileTempProject,
  createCompilerTestProject,
} from './compiler_object_test_helpers.ts';
import type {
  CompilerRuntimeAdaptObjectValueIR,
  CompilerRuntimeAllocateFallbackObjectIR,
  CompilerRuntimeHasFallbackObjectPropertyIR,
  CompilerRuntimeHasSpecializedObjectOwnPropertyIR,
  CompilerRuntimeListFallbackObjectKeysIR,
  CompilerRuntimeListSpecializedObjectKeysIR,
  CompilerRuntimeRepresentationRefIR,
  CompilerRuntimeSetFallbackObjectPropertyIR,
} from './compiler/runtime_ir.ts';
import {
  compileCheckedInProject,
  createIsolatedTestRegistrar,
  createTempProject,
  getAllRuntimeOperations,
  instantiateCompiledModuleInJs,
  invokeCompiledEntry,
  lowerCheckedInProjectToCompilerIR,
  lowerTempProjectToCompilerIR,
  readWatArtifact,
  readWatArtifactForProject,
  resolveQualifiedExportName,
} from './compiler_test_helpers.ts';

const compilerObjectKeysTest = createIsolatedTestRegistrar(import.meta.url);

compilerObjectKeysTest(
  'compileProject compiles the checked-in compiler smoke example with honest specialized, fallback, and Object.keys evidence',
  async () => {
    const moduleIR = lowerCheckedInProjectToCompilerIR('examples/compiler-smoke');
    const pairToBag = moduleIR.functions.find((func) => func.name === 'pairToBag');
    const observeBagBoundary = moduleIR.functions.find((func) =>
      func.name === 'observeBagBoundary'
    );
    const operations = getAllRuntimeOperations(moduleIR);
    const specializedMemberships = operations.filter((
      operation,
    ): operation is CompilerRuntimeHasSpecializedObjectOwnPropertyIR =>
      operation.kind === 'has_specialized_object_own_property'
    );
    const specializedListings = operations.filter((
      operation,
    ): operation is CompilerRuntimeListSpecializedObjectKeysIR =>
      operation.kind === 'list_specialized_object_keys'
    );
    const fallbackMemberships = operations.filter((
      operation,
    ): operation is CompilerRuntimeHasFallbackObjectPropertyIR =>
      operation.kind === 'has_fallback_object_property'
    );
    const fallbackListings = operations.filter((
      operation,
    ): operation is CompilerRuntimeListFallbackObjectKeysIR =>
      operation.kind === 'list_fallback_object_keys'
    );
    const generalizations = operations.filter((
      operation,
    ): operation is CompilerRuntimeAdaptObjectValueIR =>
      operation.kind === 'adapt_value' && operation.family === 'object'
    );
    const { projectDirectory, result } = compileCheckedInProject('examples/compiler-smoke');

    assertEquals(
      pairToBag?.heapResultRepresentation,
      { family: 'object', kind: 'fallback_object_representation', name: 'object.fallback' },
    );
    assertEquals(
      observeBagBoundary?.heapParamRepresentations,
      [{
        name: 'bag',
        representation: {
          family: 'object',
          kind: 'fallback_object_representation',
          name: 'object.fallback',
        } satisfies CompilerRuntimeRepresentationRefIR<'object'>,
      }],
    );
    assertEquals(specializedMemberships.length, 1);
    assertEquals(specializedListings.length, 0);
    assertEquals(fallbackMemberships.map((operation) => operation.propertyKey), [
      'tens',
      'toString',
      'missing',
    ]);
    assertEquals(fallbackListings.length, 0);
    assertEquals(
      generalizations.some((operation) =>
        JSON.stringify(operation.fallbackMaterialization?.entries.map((entry) => entry.key)) ===
          JSON.stringify(['2', '10', 'tens', 'ones'])
      ),
      true,
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifactForProject(projectDirectory);

    assertMatch(
      watOutput,
      /struct\.new \$object_shape_10_required_f64_2_required_f64_(ones_required_f64_tens_required_f64|tens_required_f64_ones_required_f64)/,
    );
    assertWatDeclaresFallbackObjectType(watOutput);
    assertWatCallsFallbackObjectHas(watOutput);
    assertStringIncludes(watOutput, 'call $get_fallback_object_property');
    assertWatCallsFallbackObjectSet(watOutput);
    assertStringIncludes(watOutput, '(func $observeBagBoundary');
    const instance = await instantiateCompiledModuleInJs(projectDirectory);
    const exportName = await resolveQualifiedExportName(projectDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(4, 2, 7, 8, 0), 1_111_048);
    assertEquals(exported(4, 2, 7, 8, 1), 1_111_047);
  },
);

compilerObjectKeysTest(
  'compileProject scalarizes specialized ordinary-object Object.keys length onto the generic array-length path',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type KeyView = { length: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const keys: KeyView = Object.keys(mixed);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('call $generalize_object_to_fallback'), false);
    assertEquals(watOutput.includes('call $list_specialized_object_keys__'), false);
    assertEquals(
      watOutput.includes('call $list_fallback_object_keys_in_js_own_property_order'),
      false,
    );
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 4);
  },
);

compilerObjectKeysTest(
  'compileProject keeps collision-prone specialized Object.keys shapes executable without helper-name dependence',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Dashed = { "a-b": number; x: number };',
      'type Underscored = { a_b: number; x: number };',
      'type KeyView = { length: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const dashed: Dashed = { "a-b": left, x: right };',
      '  const underscored: Underscored = { a_b: left, x: right };',
      '  const dashedKeys: KeyView = Object.keys(dashed);',
      '  const underscoredKeys: KeyView = Object.keys(underscored);',
      '  return dashedKeys.length + underscoredKeys.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('call $list_specialized_object_keys__'), false);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 4);
  },
);

compilerObjectKeysTest(
  'compileProject scalarizes fallback ordinary-object Object.keys length after bag-like boundaries',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type Bag = Record<string, number>;',
      'type KeyView = { length: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const bag: Bag = mixed;',
      '  const keys: KeyView = Object.keys(bag);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(
      watOutput.includes('call $list_fallback_object_keys_in_js_own_property_order'),
      false,
    );
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 4);
  },
);

compilerObjectKeysTest(
  'compileProject keeps equivalent specialized and fallback ordinary-object Object.keys visibly equivalent on the generalized path',
  async () => {
    const specializedDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; apple: number; 1000: number; 2: number };',
      'type KeyView = { length: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { apple: left, zebra: right, 1e3: left, 2: right };',
      '  const keys: KeyView = Object.keys(mixed);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));
    const fallbackDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; apple: number; 1000: number; 2: number };',
      'type Bag = Record<string, number>;',
      'type KeyView = { length: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { apple: left, zebra: right, 1e3: left, 2: right };',
      '  const bag: Bag = mixed;',
      '  const keys: KeyView = Object.keys(bag);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    const specializedResult = compileTempProject(specializedDirectory);
    const fallbackResult = compileTempProject(fallbackDirectory);

    assertEquals(specializedResult.exitCode, 0);
    assertEquals(fallbackResult.exitCode, 0);
    assertEquals(specializedResult.diagnostics, []);
    assertEquals(fallbackResult.diagnostics, []);
    const specializedWat = await readWatArtifact(specializedDirectory);
    const fallbackWat = await readWatArtifact(fallbackDirectory);
    assertEquals(specializedWat.includes('call $list_specialized_object_keys__'), false);
    assertEquals(
      fallbackWat.includes('call $list_fallback_object_keys_in_js_own_property_order'),
      false,
    );
    assertEquals(await invokeCompiledEntry(specializedDirectory, 'main', [4, 7]), 4);
    assertEquals(await invokeCompiledEntry(fallbackDirectory, 'main', [4, 7]), 4);
  },
);

compilerObjectKeysTest(
  'compileProject keeps ordinary-object Object.keys update cases executable on the generalized path',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Bag = Record<string, number>;',
      'type KeyView = { length: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const bag: Bag = { zebra: left, 2: right, apple: left, 1: right };',
      '  bag["2"] = right;',
      '  bag.apple = left;',
      '  const keys: KeyView = Object.keys(bag);',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(
      watOutput.includes('call $list_fallback_object_keys_in_js_own_property_order'),
      false,
    );
    assertWatCallsFallbackObjectSet(watOutput);
    assertEquals(watOutput.includes('call $generalize_object_to_fallback'), false);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 4);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.hasOwn on specialized and fallback paths',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const bag: Bag = mixed;',
      '  let total = 0;',
      '  if (Object.hasOwn(mixed, "apple")) total = total + 1000;',
      '  if (Object.hasOwn(mixed, 2)) total = total + 100;',
      '  if (Object.hasOwn(mixed, "missing")) total = total + 10;',
      '  if (Object.hasOwn(bag, "zebra")) total = total + 1;',
      '  return total;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectHas(watOutput);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 1_101);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.values on specialized and fallback number-array paths',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type Bag = Record<string, number>;',
      '',
      'function encode(values: number[]): number {',
      '  return values[0] * 1000 + values[1] * 100 + values[2] * 10 + values[3];',
      '}',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: 1, 1: 2 };',
      '  const bag: Bag = mixed;',
      '  const mixedValues = Object.values(mixed);',
      '  const bagValues = Object.values(bag);',
      '  return encode(mixedValues) + encode(bagValues);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('call $list_specialized_object_keys__'), false);
    assertEquals(
      watOutput.includes('call $list_fallback_object_keys_in_js_own_property_order'),
      false,
    );
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 5_482);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.values on direct string-valued locals through the fallback path',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const record = { zebra: "z", alpha: "a", middle: "m" };',
      '  return Object.values(record).join("");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'zam');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.entries length on specialized and fallback paths',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: 1, 1: 2 };',
      '  const bag: Bag = mixed;',
      '  return Object.entries(mixed).length * 10 + Object.entries(bag).length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 44);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.entries through mapped array binding callbacks',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Bag = Record<string, number>;',
      '',
      'function render(entries: Array<[string, number]>): string {',
      '  return entries.map((entry) => entry.length).join(",");',
      '}',
      '',
      'export function main(): string {',
      '  const bag: Bag = { left: 1, right: 2 };',
      '  return render(Object.entries(bag));',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), '2,2');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.entries with observable key-value pairs',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const record = { left: "1", right: "2" };',
      '  return Object.entries(record).map((entry) => entry[0] + ":" + entry[1]).join(",");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'left:1,right:2');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.entries with template-string pair observations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const record = Object.assign({}, "ab");',
      '  return Object.entries(record).map(([key, value]) => `${key}:${value}`).join(";");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), '0:a;1:b');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.entries ordering through for-of destructuring',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const record = { 2: "b", 1: "a", zebra: "z" };',
      '  let summary = "";',
      '  for (const [key, value] of Object.entries(record)) {',
      '    summary += key + ":" + value + ";";',
      '  }',
      '  return summary;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), '1:a;2:b;zebra:z;');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.fromEntries on direct pair arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const record = Object.fromEntries([',
      "    ['left', 1],",
      "    ['right', 2],",
      '  ]);',
      '  return record.left * 10 + record.right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectSet(watOutput);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 12);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.fromEntries with null and empty-string values',
  async () => {
    const nullDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const record = Object.fromEntries([',
      '    ["left", null],',
      '    ["right", 2],',
      '  ]);',
      '  return record.left === null ? 1 : 0;',
      '}',
      '',
    ].join('\n'));
    const emptyStringDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const record = Object.fromEntries([["left", ""]]);',
      '  return Object.keys(record).join(":") + record.left;',
      '}',
      '',
    ].join('\n'));

    const nullResult = compileTempProject(nullDirectory);
    const emptyStringResult = compileTempProject(emptyStringDirectory);

    assertEquals(nullResult.exitCode, 0);
    assertEquals(emptyStringResult.exitCode, 0);
    assertEquals(nullResult.diagnostics, []);
    assertEquals(emptyStringResult.diagnostics, []);
    assertEquals(await invokeCompiledEntry(nullDirectory, 'main', []), 1);
    {
      const instance = await instantiateCompiledModuleInJs(emptyStringDirectory);
      const exportName = await resolveQualifiedExportName(emptyStringDirectory, 'main');
      const exported = instance.exports[exportName];
      if (typeof exported !== 'function') {
        throw new Error(`Expected exported function "${exportName}".`);
      }
      assertEquals(exported(), 'left');
    }
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.fromEntries with boolean keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const record = Object.fromEntries([[true, 1], [false, 2]]);',
      '  return Object.keys(record).join(";") + "|" + Object.values(record).join(";");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'true;false|1;2');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.fromEntries overwrite order',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const record = Object.fromEntries([',
      "    ['left', 1],",
      "    ['left', 2],",
      '  ]);',
      '  return record.left;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 2);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.fromEntries empty results through Object.keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  return Object.keys(Object.fromEntries([])).length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 0);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.fromEntries on ordinary-object Object.entries results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const source = { left: "a", right: "b" };',
      '  const record = Object.fromEntries(Object.entries(source));',
      '  return Object.keys(record).join(";") + "|" + Object.values(record).join(";");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'left;right|a;b');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.entries on direct Object.fromEntries results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const record = Object.fromEntries([["left", 1], ["right", 2]]);',
      '  const entries = Object.entries(record);',
      '  return entries[0][0].length * 100 + entries[0][1] * 10 + entries[1][1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 412);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.entries overwrite order on direct Object.fromEntries results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const record = Object.fromEntries([["left", 1], ["left", 3], ["right", 2]]);',
      '  const entries = Object.entries(record);',
      '  return entries[0][1] * 10 + entries[1][1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 32);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.entries numeric ordering on direct Object.fromEntries results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const record = Object.fromEntries([[2, "b"], [1, "a"], [3, "c"]]);',
      '  return Object.entries(record).map((entry) => entry[0] + ":" + entry[1]).join(";");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), '1:a;2:b;3:c');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.values on direct Object.fromEntries results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const record = Object.fromEntries([["left", 1], ["right", 2]]);',
      '  const values = Object.values(record);',
      '  return values[0] + values[1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerObjectKeysTest(
  'compileProject executes globalThis.Object ordinary-object flows on direct Object.fromEntries results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  return globalThis.Object.keys(globalThis.Object.fromEntries([["left", 1], ["right", 2]])).length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 2);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.values length on provably empty ordinary-object paths',
  async () => {
    const cases = [
      [
        'export function main(): number {',
        '  return Object.values({}).length;',
        '}',
        '',
      ].join('\n'),
      [
        'export function main(): number {',
        '  return Object.values(Object.fromEntries([])).length;',
        '}',
        '',
      ].join('\n'),
      [
        'export function main(): number {',
        '  return Object.values(Object.assign({}, null)).length;',
        '}',
        '',
      ].join('\n'),
      [
        'export function main(): number {',
        '  return Object.values(Object.assign({}, undefined)).length;',
        '}',
        '',
      ].join('\n'),
    ];

    for (const source of cases) {
      const tempDirectory = await createCompilerTestProject(source);
      const result = compileTempProject(tempDirectory);

      assertEquals(result.exitCode, 0);
      assertEquals(result.diagnostics, []);
      assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 0);
    }
  },
);

compilerObjectKeysTest(
  'compileProject executes direct ordinary-object Object.values reduce chains on Object.fromEntries results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const record = Object.fromEntries([["left", 1], ["right", 2]]);',
      '  return Object.values(record).reduce((sum, value) => sum + value, 0);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerObjectKeysTest(
  'compileProject executes direct ordinary-object Object.values reduce chains on spread results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const base: Record<string, number> = { left: 1 };',
      '  const record: Record<string, number> = { ...base, right: 2 };',
      '  return Object.values(record).reduce((sum, value) => sum + value, 0);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerObjectKeysTest(
  'compileProject executes direct ordinary-object Object.values reduce chains on inline spread object literals',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const record = { ...{ left: 1 }, ...{ right: 2 } };',
      '  return Object.values(record).reduce((sum, value) => sum + value, 0);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.assign on fallback ordinary-object targets',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const target: Record<string, string> = Object.assign({}, { left: "a" }, { right: "b", left: "c" });',
      '  return Object.keys(target).join(";") + "|" + Object.values(target).join(";") + "|" + target.left + "|" + target.right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectSet(watOutput);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'left;right|c;b|c|b');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.assign from static computed ordinary-object keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function keys(): string {',
      '  const space = " ";',
      '  const index = 1;',
      '  const target: Record<string, number> = Object.assign({}, { [space]: 4 }, { [index]: 2, zebra: 3 });',
      '  return Object.keys(target).join(";");',
      '}',
      '',
      'export function total(): number {',
      '  const space = " ";',
      '  const index = 1;',
      '  const target: Record<string, number> = Object.assign({}, { [space]: 4 }, { [index]: 2, zebra: 3 });',
      '  return Object.values(target).length * 100 + target[space] * 10 + target[index];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectSet(watOutput);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const keysExportName = await resolveQualifiedExportName(tempDirectory, 'keys');
    const totalExportName = await resolveQualifiedExportName(tempDirectory, 'total');
    const exportedKeys = instance.exports[keysExportName];
    const exportedTotal = instance.exports[totalExportName];
    if (typeof exportedKeys !== 'function') {
      throw new Error(`Expected exported function "${keysExportName}".`);
    }
    if (typeof exportedTotal !== 'function') {
      throw new Error(`Expected exported function "${totalExportName}".`);
    }
    assertEquals(exportedKeys(), '1; ;zebra');
    assertEquals(exportedTotal(), 342);
  },
);

compilerObjectKeysTest(
  'compileProject executes direct reads from ordinary-object Object.assign results',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  return Object.assign({}, { left: 1 }, { right: 2 }).left +',
      '    Object.assign({}, { left: 1 }, { right: 2 }).right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 3);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.fromEntries with compile-time String key aliases',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const key = String(null);',
      '  const record: Record<string, number> = Object.fromEntries([[key, 5], ["zebra", 2]]);',
      '  const keys = Object.keys(record);',
      '  return keys[0].length * 100 + keys.length * 10 + record.null;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 425);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.assign on fixed-layout ordinary-object targets',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function valuesLength(): number {',
      '  const assigned = Object.assign({ left: 1 }, { right: 2 });',
      '  return Object.values(assigned).length;',
      '}',
      '',
      'export function hasRight(): boolean {',
      '  const assigned = Object.assign({ left: 1 }, { right: 2 });',
      '  return Object.hasOwn(assigned, "right");',
      '}',
      '',
      'export function keysLength(): number {',
      '  const assigned = Object.assign({ left: 1 }, { right: 2 });',
      '  return Object.keys(assigned).length;',
      '}',
      '',
      'export function overwrite(): number {',
      '  const target = { left: 1, right: 2 };',
      '  const result = Object.assign(target, { left: 3 }, { right: 4 });',
      '  return result.left * 10 + result.right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectSet(watOutput);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const valuesLengthExportName = await resolveQualifiedExportName(tempDirectory, 'valuesLength');
    const hasRightExportName = await resolveQualifiedExportName(tempDirectory, 'hasRight');
    const keysLengthExportName = await resolveQualifiedExportName(tempDirectory, 'keysLength');
    const overwriteExportName = await resolveQualifiedExportName(tempDirectory, 'overwrite');
    const exportedValuesLength = instance.exports[valuesLengthExportName];
    const exportedHasRight = instance.exports[hasRightExportName];
    const exportedKeysLength = instance.exports[keysLengthExportName];
    const exportedOverwrite = instance.exports[overwriteExportName];
    if (typeof exportedValuesLength !== 'function') {
      throw new Error(`Expected exported function "${valuesLengthExportName}".`);
    }
    if (typeof exportedHasRight !== 'function') {
      throw new Error(`Expected exported function "${hasRightExportName}".`);
    }
    if (typeof exportedKeysLength !== 'function') {
      throw new Error(`Expected exported function "${keysLengthExportName}".`);
    }
    if (typeof exportedOverwrite !== 'function') {
      throw new Error(`Expected exported function "${overwriteExportName}".`);
    }
    assertEquals(exportedValuesLength(), 2);
    assertEquals(exportedHasRight(), 1);
    assertEquals(exportedKeysLength(), 2);
    assertEquals(exportedOverwrite(), 34);
  },
);

compilerObjectKeysTest(
  'compileProject executes chained ordinary-object Object.hasOwn observations',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function fromEntries(): boolean {',
      '  const record: Record<string, number> = Object.fromEntries([["left", 1], ["right", 2]]);',
      '  return Object.hasOwn(record, "left") && Object.hasOwn(record, "right");',
      '}',
      '',
      'export function assign(): boolean {',
      '  const record = Object.assign({ left: 1 }, { right: 2 });',
      '  return Object.hasOwn(record, "left") && Object.hasOwn(record, "right");',
      '}',
      '',
      'export function spread(): boolean {',
      '  const record: Record<string, number> = { ...{ left: 1 }, right: 2 };',
      '  return Object.hasOwn(record, "left") && Object.hasOwn(record, "right");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const fromEntriesExportName = await resolveQualifiedExportName(tempDirectory, 'fromEntries');
    const assignExportName = await resolveQualifiedExportName(tempDirectory, 'assign');
    const spreadExportName = await resolveQualifiedExportName(tempDirectory, 'spread');
    const exportedFromEntries = instance.exports[fromEntriesExportName];
    const exportedAssign = instance.exports[assignExportName];
    const exportedSpread = instance.exports[spreadExportName];
    if (typeof exportedFromEntries !== 'function') {
      throw new Error(`Expected exported function "${fromEntriesExportName}".`);
    }
    if (typeof exportedAssign !== 'function') {
      throw new Error(`Expected exported function "${assignExportName}".`);
    }
    if (typeof exportedSpread !== 'function') {
      throw new Error(`Expected exported function "${spreadExportName}".`);
    }
    assertEquals(exportedFromEntries(), 1);
    assertEquals(exportedAssign(), 1);
    assertEquals(exportedSpread(), 1);
  },
);

compilerObjectKeysTest(
  'compileProject executes string-valued ordinary-object Object.assign overwrites without missing owned-string host adaptation',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const target = Object.assign({ "": "left" }, { "": "right" });',
      '  return target[""];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, '(func $owned_string_to_host');
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'right');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object spread on fallback ordinary-object targets',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const source: Record<string, number> = { left: 1, right: 2 };',
      '  const target: Record<string, number> = { keep: 7, ...source, left: 9, tail: 4 };',
      '  return Object.keys(target).join(";") + "|" + Object.values(target).join(";");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectSet(watOutput);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'keep;left;right;tail|7;9;2;4');
  },
);

compilerObjectKeysTest('compileProject executes empty ordinary-object spread locals', async () => {
  const tempDirectory = await createCompilerTestProject([
    'export function main(): number {',
    '  const record = { ...{} };',
    '  return Object.keys(record).length;',
    '}',
    '',
  ].join('\n'));

  const result = compileTempProject(tempDirectory);

  assertEquals(result.exitCode, 0);
  assertEquals(result.diagnostics, []);
  assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 0);
});

compilerObjectKeysTest(
  'compileProject executes direct nested ordinary-object source reads',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const source = { left: 1, inner: { right: 2 } };',
      '  return source.left + source.inner.right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object spread from nested ordinary-object sources',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const source = { left: 1, inner: { right: 2 } };',
      '  const target = { ...source };',
      '  return target.left + target.inner.right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', []), 3);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object spread from inline array literal sources',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function keys(): string {',
      '  const target = { ...["zero", "one", "two"] };',
      '  return Object.keys(target).join(",");',
      '}',
      '',
      'export function values(): string {',
      '  const target = { ...["x", "y"] };',
      '  return Object.values(target).join("");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const keysExportName = await resolveQualifiedExportName(tempDirectory, 'keys');
    const valuesExportName = await resolveQualifiedExportName(tempDirectory, 'values');
    const exportedKeys = instance.exports[keysExportName];
    const exportedValues = instance.exports[valuesExportName];
    if (typeof exportedKeys !== 'function') {
      throw new Error(`Expected exported function "${keysExportName}".`);
    }
    if (typeof exportedValues !== 'function') {
      throw new Error(`Expected exported function "${valuesExportName}".`);
    }
    assertEquals(exportedKeys(), '0,1,2');
    assertEquals(exportedValues(), 'xy');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.assign from inline string literal sources',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      '  const record = Object.assign({}, "abc");',
      '  return Object.values(record).join("");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'abc');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object spread from static computed ordinary-object keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function keys(): string {',
      '  const space = " ";',
      '  const index = 1;',
      '  const source: Record<string, number> = { [space]: 4, zebra: 3 };',
      '  const target: Record<string, number> = { alpha: 1, ...source, [index]: 2, zebra: 8 };',
      '  return Object.keys(target).join(";");',
      '}',
      '',
      'export function total(): number {',
      '  const space = " ";',
      '  const index = 1;',
      '  const source: Record<string, number> = { [space]: 4, zebra: 3 };',
      '  const target: Record<string, number> = { alpha: 1, ...source, [index]: 2, zebra: 8 };',
      '  return Object.values(target).length * 1000 + target[space] * 100 + target[index] * 10 + target.zebra;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectSet(watOutput);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const keysExportName = await resolveQualifiedExportName(tempDirectory, 'keys');
    const totalExportName = await resolveQualifiedExportName(tempDirectory, 'total');
    const exportedKeys = instance.exports[keysExportName];
    const exportedTotal = instance.exports[totalExportName];
    if (typeof exportedKeys !== 'function') {
      throw new Error(`Expected exported function "${keysExportName}".`);
    }
    if (typeof exportedTotal !== 'function') {
      throw new Error(`Expected exported function "${totalExportName}".`);
    }
    assertEquals(exportedKeys(), '1;alpha; ;zebra');
    assertEquals(exportedTotal(), 4428);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object spread from compile-time String computed keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const source: Record<string, number> = { [String(true)]: 1 };',
      '  const target: Record<string, number> = { ...source, false: 2 };',
      '  const keys = Object.keys(target);',
      '  return keys[0].length * 100 + target.true * 10 + target.false;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectSet(watOutput);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 412);
  },
);

compilerObjectKeysTest(
  'compileProject executes unannotated ordinary-object spread from compile-time String computed keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const source = { [String(true)]: 1 };',
      '  const target = { ...source, false: 2 };',
      '  const keys = Object.keys(target);',
      '  return keys[0].length * 100 + keys[1].length * 10 + keys.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectSet(watOutput);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 452);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.fromEntries with static array-literal keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): number {',
      '  const record = Object.fromEntries([[[], 1], [["x", "y"], 2], ["keep", 3]]);',
      '  const keys = Object.keys(record);',
      '  const values = Object.values(record);',
      '  return keys[0].length * 100 + keys[1].length * 10 + values[0] + values[1] + values[2];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatCallsFallbackObjectSet(watOutput);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 36);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object runtime string computed keys through bag-like reads',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): number {',
      '  const key = flag === 1 ? "left" : "right";',
      '  const record: Record<string, number> = { [key]: 4, tail: 2 };',
      '  return record[key] * 10 + record.tail;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 42);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 42);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object spread composition with runtime string computed keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): number {',
      '  const key = flag === 1 ? "left" : "right";',
      '  const source = { tail: 2 };',
      '  const record: Record<string, number> = { [key]: 4, ...source, keep: 3 };',
      '  return record[key] * 100 + record.tail * 10 + record.keep;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 423);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 423);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.keys on runtime string computed keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): number {',
      '  const key = flag === 1 ? "left" : "right";',
      '  const record: Record<string, number> = { [key]: 4, tail: 2 };',
      '  const keys = Object.keys(record);',
      '  return keys.length * 10000 + keys[0].charCodeAt(0) * 100 + keys[1].length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 30804);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 31404);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.keys on spread-composed runtime string computed keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): number {',
      '  const key = flag === 1 ? "left" : "right";',
      '  const source = { tail: 2 };',
      '  const record: Record<string, number> = { [key]: 4, ...source, keep: 3 };',
      '  const keys = Object.keys(record);',
      '  return keys.length * 10000 + keys[0].charCodeAt(0) * 100 + keys[1].length * 10 + keys[2].length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 40844);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 41444);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.values on runtime string computed keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): number {',
      '  const key = flag === 1 ? "left" : "right";',
      '  const record: Record<string, number> = { [key]: 4, tail: 2 };',
      '  const values = Object.values(record);',
      '  return values.length * 100 + values[0] * 10 + values[1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 242);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 242);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.entries on runtime string computed keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): number {',
      '  const key = flag === 1 ? "left" : "right";',
      '  const record: Record<string, number> = { [key]: 4, tail: 2 };',
      '  const entries = Object.entries(record);',
      '  return entries.length * 100000 + entries[0][0].charCodeAt(0) * 100 + entries[0][1] * 10 + entries[1][1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [1]), 210842);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [0]), 211442);
  },
);

compilerObjectKeysTest(
  'compileProject executes string ordinary-object Object.values on runtime string computed keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): string {',
      '  const key = flag === 1 ? "left" : "right";',
      '  const record: Record<string, string> = { [key]: "a", tail: "z" };',
      '  return Object.values(record).join("");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(1), 'az');
    assertEquals(exported(0), 'az');
  },
);

compilerObjectKeysTest(
  'compileProject executes string ordinary-object Object.entries on runtime string computed keys',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): string {',
      '  const key = flag === 1 ? "left" : "right";',
      '  const record: Record<string, string> = { [key]: "a", tail: "z" };',
      '  return Object.entries(record).map(([entryKey, value]) => `${entryKey}:${value}`).join(";");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(1), 'left:a;tail:z');
    assertEquals(exported(0), 'right:a;tail:z');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object listings on runtime numeric computed keys in JS own-property order',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): string {',
      '  const key = flag === 1 ? "2" : "10";',
      '  const value = flag === 1 ? "b" : "j";',
      '  const record: Record<string, string> = { zebra: "z", [key]: value, apple: "a", 1: "x" };',
      '  return Object.keys(record).join(";") + "|" + Object.values(record).join(";") + "|" +',
      '    Object.entries(record).map(([entryKey, entryValue]) => `${entryKey}:${entryValue}`).join(";");',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, 'call $list_dynamic_object_keys');
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(1), '1;2;zebra;apple|x;b;z;a|1:x;2:b;zebra:z;apple:a');
    assertEquals(exported(0), '1;10;zebra;apple|x;j;z;a|1:x;10:j;zebra:z;apple:a');
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object spread from runtime string computed sources with later overwrites',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(flag: number): number {',
      '  const key = flag === 1 ? "left" : "right";',
      '  const source: Record<string, number> = { [key]: 4, tail: 2 };',
      '  const target = { ...source, tail: 5, keep: 3 };',
      '  const keys = Object.keys(target);',
      '  const values = Object.values(target);',
      '  const entries = Object.entries(target);',
      '  return keys.length * 1000000 + keys[0].charCodeAt(0) * 10000 + values[0] * 1000 +',
      '    values[1] * 100 + values[2] * 10 + entries[1][1];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(1), 4084535);
    assertEquals(exported(0), 4144535);
  },
);

compilerObjectKeysTest(
  'compileProject executes ordinary-object Object.values length on locals that require fallback property materialization',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(left: number, right: number): number {',
      '  const record = { left, right, sum: left + right };',
      '  return Object.values(record).length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [2, 3]), 3);
  },
);

compilerObjectKeysTest(
  'compileProject executes for-of loops over ordinary-object Object.values arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      "  const record = { 2: 'b', 1: 'a', zebra: 'z' };",
      "  let summary = '';",
      '  for (const value of Object.values(record)) {',
      '    summary = summary + value;',
      '  }',
      '  return summary;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'abz');
  },
);

compilerObjectKeysTest(
  'compileProject executes string += inside for-of loops over ordinary-object Object.values arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      "  const record = { 2: 'b', 1: 'a', zebra: 'z' };",
      "  let summary = '';",
      '  for (const value of Object.values(record)) {',
      '    summary += value;',
      '  }',
      '  return summary;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'abz');
  },
);

compilerObjectKeysTest(
  'compileProject executes array binding patterns over ordinary-object Object.values arrays',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'export function main(): string {',
      "  const record = { left: 'a', right: 'b' };",
      "  const [first = '', second = ''] = Object.values(record);",
      '  return first + second;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const exported = instance.exports[exportName];
    if (typeof exported !== 'function') {
      throw new Error(`Expected exported function "${exportName}".`);
    }
    assertEquals(exported(), 'ab');
  },
);

compilerObjectKeysTest(
  'compileProject keeps bag-like param boundaries executable before generalized Object.keys length lowering',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Bag = Record<string, number>;',
      'type KeyView = { length: number };',
      '',
      'function observe(bag: Bag): number {',
      '  return 0;',
      '}',
      '',
      'export function main(left: number, right: number): number {',
      '  const bag: Bag = { apple: left, zebra: right, 1e3: left, 2: right };',
      '  const crossed = observe(bag);',
      '  const keys: KeyView = Object.keys(bag);',
      '  return crossed + keys.length;',
      '}',
      '',
    ].join('\n'));

    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const observe = moduleIR.functions.find((func) => func.name === 'observe');
    const result = compileTempProject(tempDirectory);

    assertEquals(
      observe?.heapParamRepresentations,
      [{
        name: 'bag',
        representation: {
          family: 'object',
          kind: 'fallback_object_representation',
          name: 'object.fallback',
        } satisfies CompilerRuntimeRepresentationRefIR<'object'>,
      }],
    );
    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertWatDeclaresFallbackObjectType(watOutput);
    assertEquals(
      watOutput.includes('call $list_fallback_object_keys_in_js_own_property_order'),
      false,
    );
    assertStringIncludes(watOutput, '(func $observe');
    assertStringIncludes(watOutput, '(param $bag (ref null $object_fallback))');
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 4);
  },
);

compilerObjectKeysTest(
  'compileProject keeps non-ordinary helper-call Object.keys observations unsupported while ordinary-object cases use the generalized array path',
  async () => {
    const cases = [
      {
        source: [
          'type KeyView = { length: number };',
          '',
          'function consume(keys: KeyView): number {',
          '  return 0;',
          '}',
          '',
          'export function main(values: number[]): number {',
          '  return consume(Object.keys(values));',
          '}',
          '',
        ].join('\n'),
        message:
          'This construct is accepted by the checker but not yet supported by the compiler backend.',
      },
      {
        source: [
          'type KeyView = { length: number };',
          '',
          'function consume(keys: KeyView): number {',
          '  return 0;',
          '}',
          '',
          'export function main(text: string): number {',
          '  return consume(Object.keys(text));',
          '}',
          '',
        ].join('\n'),
        message:
          'This construct is accepted by the checker but not yet supported by the compiler backend.',
      },
      {
        source: [
          'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
          'type KeyView = { length: number };',
          '',
          'function consume(keys: KeyView): number {',
          '  return keys.length;',
          '}',
          '',
          'export function main(left: number, right: number): number {',
          '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
          '  return consume(Object.keys(mixed));',
          '}',
          '',
        ].join('\n'),
        message: undefined,
      },
    ] as const;

    for (const testCase of cases) {
      const tempDirectory = await createCompilerTestProject(testCase.source);
      const result = compileTempProject(tempDirectory);

      if (testCase.message) {
        assertEquals(result.exitCode, 1);
        assertMatch(
          result.output,
          new RegExp(testCase.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        );
      } else {
        assertEquals(result.exitCode, 0);
        assertEquals(result.diagnostics, []);
        assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 4);
      }
    }
  },
);

compilerObjectKeysTest(
  'compileProject makes ordinary-object Object.keys length executable without helper-based key listing',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const bag: Bag = { apple: left, zebra: right, 1e3: left, 2: right };',
      '  return Object.keys(mixed).length + Object.keys(bag).length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(
      watOutput.includes('call $list_fallback_object_keys_in_js_own_property_order'),
      false,
    );
    assertEquals(watOutput.includes('call $list_specialized_object_keys__'), false);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 8);
  },
);

compilerObjectKeysTest(
  'compileProject makes ordinary-object Object.keys first-element observation executable through owned array aliases',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type Bag = Record<string, number>;',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const bag: Bag = { apple: left, zebra: right, 1e3: left, 2: right };',
      '  const mixedKeys = Object.keys(mixed);',
      '  const bagKeys = Object.keys(bag);',
      '  return mixedKeys[0].length + bagKeys[0].length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 2);
  },
);

compilerObjectKeysTest(
  'compileProject makes ordinary-object Object.keys runtime indexed observation executable through a numeric local alias',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      '',
      'export function main(left: number, right: number, index: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const keys = Object.keys(mixed);',
      '  const keyIndex = index;',
      '  return keys[keyIndex].length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('array.get $owned_string_array'), true);
    assertEquals(watOutput.includes('(func $owned_string_length'), true);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7, 0]), 1);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7, 1]), 1);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7, 2]), 5);
  },
);

compilerObjectKeysTest(
  'compileProject makes ordinary-object Object.keys runtime indexed string observation executable through a numeric local alias',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      '',
      'export function main(left: number, right: number, index: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const keys = Object.keys(mixed);',
      '  const keyIndex = index;',
      '  if (keys[keyIndex] === "zebra") {',
      '    return 1;',
      '  }',
      '  return 0;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(watOutput.includes('array.set $owned_string_array'), true);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7, 2]), 1);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7, 0]), 0);
  },
);

compilerObjectKeysTest(
  'compileProject makes ordinary-object Object.keys runtime indexed charCodeAt observation executable through a numeric local alias',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      '',
      'export function main(left: number, right: number, index: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const keys = Object.keys(mixed);',
      '  const keyIndex = index;',
      '  return keys[keyIndex].charCodeAt(0);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7, 2]), 122);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7, 0]), 49);
  },
);

compilerObjectKeysTest(
  'compileProject makes ordinary-object Object.keys runtime indexed string return executable through a numeric local alias',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      '',
      'export function main(left: number, right: number, index: number): string {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const keys = Object.keys(mixed);',
      '  const keyIndex = index;',
      '  return keys[keyIndex];',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);
    const watOutput = await readWatArtifact(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const entry = instance.exports[exportName as keyof typeof instance.exports];
    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const main = moduleIR.functions.find((func) => func.name === 'main');

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(
      (main?.body[main.body.length - 1] as {
        value?: { value?: { kind?: string } };
      } | undefined)?.value?.value?.kind,
      'owned_string_array_element',
    );
    assertEquals(watOutput.includes('call $owned_string_to_host'), true);
    assertEquals(
      (entry as (left: number, right: number, index: number) => string)(
        4,
        7,
        2,
      ),
      'zebra',
    );
    assertEquals(
      (entry as (left: number, right: number, index: number) => string)(
        4,
        7,
        0,
      ),
      '1',
    );
  },
);

compilerObjectKeysTest(
  'compileProject passes compiler-produced string arrays through internal helper params and returns',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      '',
      'function keysOf(left: number, right: number): string[] {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  return Object.keys(mixed);',
      '}',
      '',
      'function pick(keys: string[], index: number): string {',
      '  return keys[index];',
      '}',
      '',
      'export function main(left: number, right: number, index: number): string {',
      '  return pick(keysOf(left, right), index);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);
    const moduleIR = lowerTempProjectToCompilerIR(tempDirectory);
    const keysOf = moduleIR.functions.find((func) => func.name === 'keysOf');
    const pick = moduleIR.functions.find((func) => func.name === 'pick');
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const entry = instance.exports[exportName as keyof typeof instance.exports];

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(keysOf?.resultType, 'owned_array_ref');
    assertEquals(pick?.params[0]?.type, 'owned_array_ref');
    assertEquals(
      (entry as (left: number, right: number, index: number) => string)(4, 7, 2),
      'zebra',
    );
    assertEquals((entry as (left: number, right: number, index: number) => string)(4, 7, 0), '1');
  },
);

compilerObjectKeysTest(
  'compileProject exports Object.keys arrays through the generic string-array host boundary',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      '',
      'export function main(left: number, right: number): string[] {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  return Object.keys(mixed);',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const entry = instance.exports[exportName as keyof typeof instance.exports];

    assertStringIncludes(watOutput, 'call $owned_string_to_host');
    assertEquals(
      watOutput.includes('call $list_fallback_object_keys_in_js_own_property_order'),
      false,
    );
    assertEquals(watOutput.includes('call $list_specialized_object_keys__'), false);
    assertEquals((entry as (left: number, right: number) => string[])(4, 7), [
      '1',
      '2',
      'zebra',
      'apple',
    ]);
  },
);

compilerObjectKeysTest(
  'compileProject keeps dead Object.keys locals from paying helper work',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      '',
      'export function main(left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  const keys = Object.keys(mixed);',
      '  return left + right;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    const watOutput = await readWatArtifact(tempDirectory);
    assertEquals(
      watOutput.includes('call $list_fallback_object_keys_in_js_own_property_order'),
      false,
    );
    assertEquals(watOutput.includes('call $list_specialized_object_keys__'), false);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 11);
  },
);

compilerObjectKeysTest(
  'compileProject scalarizes branch-joined Object.keys length views through structural control flow',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type KeyView = { length: number };',
      '',
      'export function main(flag: boolean, left: number, right: number): number {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  let keys: KeyView = Object.keys(mixed);',
      '  if (flag) {',
      '    keys = { length: left };',
      '  }',
      '  return keys.length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (
      flag: boolean,
      left: number,
      right: number,
    ) => number;

    assertEquals(main(false, 4, 7), 4);
    assertEquals(main(true, 4, 7), 4);
  },
);

compilerObjectKeysTest(
  'compileProject scalarizes non-exported Object.keys length-view helper returns',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type KeyView = { length: number };',
      '',
      'function build(left: number, right: number): KeyView {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  return Object.keys(mixed);',
      '}',
      '',
      'export function main(left: number, right: number): number {',
      '  return build(left, right).length;',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);
    assertEquals(await invokeCompiledEntry(tempDirectory, 'main', [4, 7]), 4);
  },
);

compilerObjectKeysTest(
  'compileProject scalarizes non-exported Object.keys length-view helper returns through helper chaining',
  async () => {
    const tempDirectory = await createCompilerTestProject([
      'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
      'type KeyView = { length: number };',
      '',
      'function build(left: number, right: number): KeyView {',
      '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
      '  return Object.keys(mixed);',
      '}',
      '',
      'function consume(keys: KeyView): number {',
      '  return keys.length;',
      '}',
      '',
      'export function main(left: number, right: number): number {',
      '  return consume(build(left, right));',
      '}',
      '',
    ].join('\n'));

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: number, right: number) => number;

    assertEquals(main(4, 7), 4);
  },
);

compilerObjectKeysTest(
  'compileProject scalarizes imported exported Object.keys length-view helpers through .length-only boundaries',
  async () => {
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
        path: 'src/helpers.ts',
        contents: [
          'type Mixed = { zebra: number; 2: number; apple: number; 1: number };',
          'export type KeyView = { length: number };',
          '',
          'export function build(left: number, right: number): KeyView {',
          '  const mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };',
          '  return Object.keys(mixed);',
          '}',
          '',
          'export function consume(keys: KeyView): number {',
          '  return keys.length;',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/index.ts',
        contents: [
          "import { build, consume } from './helpers';",
          '',
          'export function main(left: number, right: number): number {',
          '  return consume(build(left, right));',
          '}',
          '',
        ].join('\n'),
      },
    ]);

    const result = compileTempProject(tempDirectory);

    assertEquals(result.exitCode, 0);
    assertEquals(result.diagnostics, []);

    const watOutput = await readWatArtifact(tempDirectory);
    assertStringIncludes(watOutput, '(import "soundscript_length_view" "length"');
    assertStringIncludes(watOutput, '(import "soundscript_length_view" "from_length"');

    const instance = await instantiateCompiledModuleInJs(tempDirectory);
    const exportName = await resolveQualifiedExportName(tempDirectory, 'main');
    const main = instance.exports[exportName] as (left: number, right: number) => number;

    assertEquals(main(4, 7), 4);
  },
);
