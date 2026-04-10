import { assert, assertEquals, assertStringIncludes } from '@std/assert';
import { dirname } from '@std/path';
import ts from 'typescript';

import { createSoundStdlibCompilerHost } from '../bundled/sound_stdlib.ts';
import { createBuiltinExpandedProgram as createBuiltinExpandedProgramRaw } from './builtin_macro_support.ts';
import { installTestDisposableCleanup } from './builtin_expanded_program_test_cleanup.ts';
import { withStdPackageModuleResolution } from './std_package_support.ts';
import {
  createPreparedCompilerHost as createPreparedCompilerHostRaw,
  createPreparedCompilerHostReuseState,
  createPreparedProgram as createPreparedProgramRaw,
  emitProjectedDeclarations,
  toProgramFileName,
} from './project_frontend.ts';

const trackDisposable = installTestDisposableCleanup();
const createBuiltinExpandedProgram = (
  ...args: Parameters<typeof createBuiltinExpandedProgramRaw>
) => trackDisposable(createBuiltinExpandedProgramRaw(...args));
const createPreparedCompilerHost = (...args: Parameters<typeof createPreparedCompilerHostRaw>) =>
  trackDisposable(createPreparedCompilerHostRaw(...args));
const createPreparedProgram = (...args: Parameters<typeof createPreparedProgramRaw>) =>
  trackDisposable(createPreparedProgramRaw(...args));

function createBaseHost(
  files: ReadonlyMap<string, string>,
  {
    soundStdlib = false,
  }: {
    soundStdlib?: boolean;
  } = {},
): ts.CompilerHost {
  const compilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
  };
  const rawHost = soundStdlib
    ? createSoundStdlibCompilerHost(compilerOptions)
    : ts.createCompilerHost(
      compilerOptions,
    );
  const baseHost = withStdPackageModuleResolution(rawHost);
  const knownDirectories = new Set<string>();
  for (const fileName of files.keys()) {
    let current = dirname(fileName);
    while (current !== dirname(current)) {
      knownDirectories.add(current);
      current = dirname(current);
    }
    knownDirectories.add(current);
  }

  return {
    ...baseHost,
    directoryExists(directoryName: string): boolean {
      return knownDirectories.has(directoryName) ||
        baseHost.directoryExists?.(directoryName) === true;
    },
    fileExists(fileName: string): boolean {
      return files.has(fileName) || baseHost.fileExists(fileName);
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const text = files.get(fileName);
      if (text !== undefined) {
        return ts.createSourceFile(fileName, text, languageVersion, true);
      }
      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    getCurrentDirectory(): string {
      return '/virtual';
    },
    getDirectories(path: string): string[] {
      const entries = new Set<string>(baseHost.getDirectories?.(path) ?? []);
      for (const directory of knownDirectories) {
        if (dirname(directory) === path) {
          entries.add(directory.slice(path.endsWith('/') ? path.length : path.length + 1));
        }
      }
      return [...entries];
    },
    readFile(fileName: string): string | undefined {
      return files.get(fileName) ?? baseHost.readFile(fileName);
    },
    resolveModuleNames: baseHost.resolveModuleNames?.bind(baseHost),
  };
}

Deno.test('sound stdlib keeps native typed storage APIs host-typed', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };
  const program = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'const bytes = new Uint8Array(new ArrayBuffer(1));',
            'const first: number = bytes[0];',
            'bytes[0] = 1;',
            'const view = new DataView(new ArrayBuffer(1));',
            'const second: number = view.getUint8(0);',
            'view.setUint8(0, 2);',
            'const rounded: number = Math.round(1);',
            'void first;',
            'void second;',
            'void rounded;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  }).program;

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('sts:numerics DataView helpers expose explicit machine-typed storage operations', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import { readF32, readI64, readU8, writeF32, writeI64, writeU8 } from 'sts:numerics';",
          "import type { f32, i64, u8 } from 'sts:numerics';",
          'const view = new DataView(new ArrayBuffer(16));',
          'const byte: u8 = readU8(view, 0);',
          'const wide: i64 = readI64(view, 8, true);',
          'const float32: f32 = readF32(view, 4, true);',
          'writeU8(view, 0, byte);',
          'writeU8(view, 1, 10);',
          'writeI64(view, 8, wide, true);',
          'writeI64(view, 8, 1n, true);',
          'writeF32(view, 4, float32, true);',
          'writeF32(view, 4, 0.5, true);',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('sts:numerics machine array views expose machine-typed indexed storage', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import { F32Array, I64Array, U8Array, U8 } from 'sts:numerics';",
          "import type { f32, i64, u8 } from 'sts:numerics';",
          'const buffer = new ArrayBuffer(16);',
          'const bytes = new U8Array(buffer);',
          'const words = new I64Array(buffer, 8, 1);',
          'const floats = new F32Array(buffer, 4, 1);',
          'const first: u8 = bytes[0];',
          'const maybeByte: u8 | undefined = bytes.at(1);',
          'const wide: i64 = words[0];',
          'const sample: f32 = floats[0];',
          'bytes[0] = U8(1);',
          'bytes.setAt(1, 10);',
          'words.setAt(0, 1n);',
          'floats.setAt(0, 0.5);',
          'const tail: U8Array = bytes.subarray(0, 2);',
          'void first;',
          'void maybeByte;',
          'void wide;',
          'void sample;',
          'void tail;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('sts:numerics machine array views bridge to native typed-array views', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import { F32Array, I64Array, U8Array } from 'sts:numerics';",
          'const bytes = new U8Array(new ArrayBuffer(4));',
          'const nativeBytes: Uint8Array = bytes.toHostView();',
          'const wrappedBytes: U8Array = U8Array.fromHostView(nativeBytes);',
          'const words = new I64Array(new ArrayBuffer(8), 0, 1);',
          'const nativeWords: BigInt64Array = words.toHostView();',
          'const wrappedWords: I64Array = I64Array.fromHostView(nativeWords);',
          'const floats = new F32Array(new ArrayBuffer(4), 0, 1);',
          'const nativeFloats: Float32Array = floats.toHostView();',
          'const wrappedFloats: F32Array = F32Array.fromHostView(nativeFloats);',
          'void wrappedBytes;',
          'void wrappedWords;',
          'void wrappedFloats;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('sts:numerics machine array views support bulk set from host and machine sources', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import { F32Array, I64Array, U8Array } from 'sts:numerics';",
          'const bytes = new U8Array(new ArrayBuffer(6));',
          'const nativeBytes = new Uint8Array([1, 2]);',
          'bytes.set([3, 4]);',
          'bytes.set(nativeBytes, 2);',
          'bytes.set(bytes.subarray(0, 2), 4);',
          'const words = new I64Array(new ArrayBuffer(16));',
          'words.set([1n, -1n]);',
          'const floats = new F32Array(new ArrayBuffer(8));',
          'floats.set([0.5, -0]);',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('sts:numerics machine array views support fill and slice', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import { F32Array, I64Array, U8Array } from 'sts:numerics';",
          'const bytes = new U8Array(new ArrayBuffer(6));',
          'bytes.fill(7);',
          'bytes.fill(9, 1, 3);',
          'const copy: U8Array = bytes.slice(1, 4);',
          'const words = new I64Array(new ArrayBuffer(24));',
          'words.fill(-1n, 1, 3);',
          'const floats = new F32Array(new ArrayBuffer(8));',
          'floats.fill(-0);',
          'void copy;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('sts:numerics expanded machine array views bridge host views and support copyWithin', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import { F64Array, I16Array, I32Array, I8Array, U16Array, U32Array, U64Array } from 'sts:numerics';",
          "import type { f64, i16, i32, i8, u16, u32, u64 } from 'sts:numerics';",
          'const i8s = I8Array.fromHostView(new Int8Array(new ArrayBuffer(2)));',
          'const firstI8: i8 = i8s[0];',
          'const i16s = I16Array.fromHostView(new Int16Array(new ArrayBuffer(4)));',
          'const firstI16: i16 = i16s[0];',
          'const i32s = I32Array.fromHostView(new Int32Array(new ArrayBuffer(8)));',
          'const movedI32s: I32Array = i32s.copyWithin(0, 1);',
          'const firstI32: i32 = movedI32s[0];',
          'const u16s = U16Array.fromHostView(new Uint16Array(new ArrayBuffer(4)));',
          'const firstU16: u16 = u16s[0];',
          'const u32s = U32Array.fromHostView(new Uint32Array(new ArrayBuffer(8)));',
          'const firstU32: u32 = u32s[0];',
          'const u64s = U64Array.fromHostView(new BigUint64Array(new ArrayBuffer(16)));',
          'const firstU64: u64 = u64s[0];',
          'const f64s = F64Array.fromHostView(new Float64Array(new ArrayBuffer(16)));',
          'const firstF64: f64 = f64s[0];',
          'void firstI8;',
          'void firstI16;',
          'void firstI32;',
          'void firstU16;',
          'void firstU32;',
          'void firstU64;',
          'void firstF64;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('sts:numerics machine array views expose iteration and search helpers', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import { F64Array, U8Array } from 'sts:numerics';",
          "import type { f64, u8 } from 'sts:numerics';",
          'const bytes = new U8Array(new ArrayBuffer(4));',
          'const entries: IterableIterator<[number, u8]> = bytes.entries();',
          'const keys: IterableIterator<number> = bytes.keys();',
          'const values: IterableIterator<u8> = bytes.values();',
          'const hasTwo: boolean = bytes.includes(2);',
          'const firstTwo: number = bytes.indexOf(2);',
          'const lastTwo: number = bytes.lastIndexOf(2);',
          'const floats = new F64Array(new ArrayBuffer(24));',
          'const hasNan: boolean = floats.includes(NaN);',
          'const firstFloat: f64 | undefined = floats.values().next().value;',
          'void entries;',
          'void keys;',
          'void values;',
          'void hasTwo;',
          'void firstTwo;',
          'void lastTwo;',
          'void hasNan;',
          'void firstFloat;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('emitProjectedDeclarations preserves bundled plain numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export const round = Math.round;',
            'export const parseFloatRef = Number.parseFloat;',
            'export const maxValue: number = Number.MAX_VALUE;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const round: (x: number) => number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const parseFloatRef: (string: string) => number;',
  );
  assertStringIncludes(projectedDeclarationText, 'export declare const maxValue: number;');
  assertEquals(projectedDeclarationText.includes('__soundscript_numerics.'), false);
});

Deno.test('emitProjectedDeclarations preserves bundled Date numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export const now = Date.now;',
            'export const parse = Date.parse;',
            'export const getTime = Date.prototype.getTime;',
            'export const setTime = Date.prototype.setTime;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(projectedDeclarationText, 'export declare const now: () => number;');
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const parse: (s: string) => number;',
  );
  assertStringIncludes(projectedDeclarationText, 'export declare const getTime: () => number;');
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const setTime: (time: number) => number;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled String Array and RegExp numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export const charCodeAt = String.prototype.charCodeAt;',
            'export const stringIndexOf = String.prototype.indexOf;',
            "export function arrayIndex(values: string[]) { return values.indexOf('x'); }",
            'export function regexLastIndex(re: RegExp) { return re.lastIndex; }',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const charCodeAt: (index: number) => number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const stringIndexOf: (searchString: string, position?: number) => number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function arrayIndex(values: string[]): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function regexLastIndex(re: RegExp): number;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled ArrayBuffer and DataView numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export const bufferSlice = ArrayBuffer.prototype.slice;',
            'export function viewByteOffset(view: DataView) { return view.byteOffset; }',
            'export const getUint8 = DataView.prototype.getUint8;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const bufferSlice: (begin?: number, end?: number) => ArrayBuffer;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function viewByteOffset(view: DataView): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const getUint8: (byteOffset: number) => number;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled typed array plain numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export const uint8CopyWithin = Uint8Array.prototype.copyWithin;',
            'export function uint8ByteLength(array: Uint8Array) { return array.byteLength; }',
            'export const uint8FindIndex = Uint8Array.prototype.findIndex;',
            'export const uint8From = Uint8Array.from;',
            'export const bigIntFindIndex = BigInt64Array.prototype.findIndex;',
            'export const bigIntFrom = BigInt64Array.from;',
            'export const getBigInt64 = DataView.prototype.getBigInt64;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const uint8CopyWithin: (target: number, start: number, end?: number) => Uint8Array<ArrayBufferLike>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function uint8ByteLength(array: Uint8Array): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const uint8FindIndex: (predicate: (value: number, index: number, obj: Uint8Array<ArrayBufferLike>) => boolean, thisArg?: unknown) => number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const uint8From: {',
  );
  assertStringIncludes(
    projectedDeclarationText,
    '<T>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => number, thisArg?: unknown): Uint8Array<ArrayBuffer>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const bigIntFindIndex: (predicate: (value: bigint, index: number, array: BigInt64Array<ArrayBufferLike>) => boolean, thisArg?: unknown) => number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const bigIntFrom: {',
  );
  assertStringIncludes(
    projectedDeclarationText,
    '<U>(arrayLike: ArrayLike<U>, mapfn: (v: U, k: number) => bigint, thisArg?: unknown): BigInt64Array<ArrayBuffer>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    '<T>(elements: Iterable<T>, mapfn?: (v: T, k: number) => bigint, thisArg?: unknown): BigInt64Array<ArrayBuffer>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const getBigInt64: (byteOffset: number, littleEndian?: boolean) => bigint;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled typed array helper numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export const uint8Entries = Uint8Array.prototype.entries;',
            'export const uint8Keys = Uint8Array.prototype.keys;',
            'export const uint8Includes = Uint8Array.prototype.includes;',
            'export const uint8At = Uint8Array.prototype.at;',
            'export const uint8FromIterable = Uint8Array.from;',
            'export const bigIntAt = BigInt64Array.prototype.at;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    ['export declare const uint8Entries: () => ArrayIterator<[number, number]>;'].join('\n'),
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const uint8Keys: () => ArrayIterator<number>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const uint8Includes: (searchElement: number, fromIndex?: number) => boolean;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const uint8At: (index: number) => number | undefined;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const uint8FromIterable: {',
  );
  assertStringIncludes(
    projectedDeclarationText,
    '<T>(elements: Iterable<T>, mapfn?: (v: T, k: number) => number, thisArg?: unknown): Uint8Array<ArrayBuffer>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const bigIntAt: (index: number) => bigint | undefined;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled modern array and arraybuffer numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export function lastEvenIndex(values: number[]) { return values.findLastIndex((value) => value % 2 === 0); }',
            'export function sorted(values: number[]) { return values.toSorted((a, b) => a - b); }',
            'export function spliced(values: number[]) { return values.toSpliced(1, 2); }',
            'export const uint8With = Uint8Array.prototype.with;',
            'export const bigIntWith = BigInt64Array.prototype.with;',
            'export const bigIntToSorted = BigInt64Array.prototype.toSorted;',
            'export const arrayBufferTransfer = ArrayBuffer.prototype.transfer;',
            'export const arrayBufferResize = ArrayBuffer.prototype.resize;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function lastEvenIndex(values: number[]): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function sorted(values: number[]): number[];',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function spliced(values: number[]): number[];',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const uint8With: (index: number, value: number) => Uint8Array<ArrayBuffer>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const bigIntWith: (index: number, value: bigint) => BigInt64Array<ArrayBuffer>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const bigIntToSorted: (compareFn?: (a: bigint, b: bigint) => number) => BigInt64Array<ArrayBuffer>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const arrayBufferTransfer: (newByteLength?: number) => ArrayBuffer;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const arrayBufferResize: (newByteLength?: number) => void;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled DOM binary and media numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export function audioDuration(buffer: AudioBuffer) { return buffer.duration; }',
            'export const copyFromChannel = AudioBuffer.prototype.copyFromChannel;',
            'export const getChannelData = AudioBuffer.prototype.getChannelData;',
            'export function blobSize(blob: Blob) { return blob.size; }',
            'export const blobSlice = Blob.prototype.slice;',
            'export function fileLastModified(file: File) { return file.lastModified; }',
            'export function encoderWritten(result: TextEncoderEncodeIntoResult) { return result.written; }',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function audioDuration(buffer: AudioBuffer): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const copyFromChannel: (destination: Float32Array<ArrayBuffer>, channelNumber: number, bufferOffset?: number) => void;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const getChannelData: (channel: number) => Float32Array<ArrayBuffer>;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function blobSize(blob: Blob): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const blobSlice: (start?: number, end?: number, contentType?: string) => Blob;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function fileLastModified(file: File): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function encoderWritten(result: TextEncoderEncodeIntoResult): number;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled DOM timestamp numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export function now(performance: Performance) { return performance.now(); }',
            'export function eventTimeStamp(event: Event) { return event.timeStamp; }',
            'export function entryStartTime(entry: PerformanceEntry) { return entry.startTime; }',
            'export function positionTimestamp(position: GeolocationPosition) { return position.timestamp; }',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function now(performance: Performance): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function eventTimeStamp(event: Event): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function entryStartTime(entry: PerformanceEntry): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function positionTimestamp(position: GeolocationPosition): number;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled WebGL numeric API references through WebGL alias types', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export const glClear = WebGLRenderingContext.prototype.clear;',
            'export const glClearColor = WebGLRenderingContext.prototype.clearColor;',
            'export const glDrawArrays = WebGLRenderingContext.prototype.drawArrays;',
            'export const glUniform1f = WebGLRenderingContext.prototype.uniform1f;',
            'export const glVertexAttribPointer = WebGLRenderingContext.prototype.vertexAttribPointer;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const glClear: (mask: GLbitfield) => void;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const glClearColor: (red: GLclampf, green: GLclampf, blue: GLclampf, alpha: GLclampf) => void;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const glDrawArrays: (mode: GLenum, first: GLint, count: GLsizei) => void;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const glUniform1f: (location: WebGLUniformLocation | null, x: GLfloat) => void;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const glVertexAttribPointer: (index: GLuint, size: GLint, type: GLenum, normalized: GLboolean, stride: GLsizei, offset: GLintptr) => void;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled DOM numeric alias unions on public API references', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export function animationCurrentTime(animation: Animation) { return animation.currentTime; }',
            'export function frameRate(constraints: MediaTrackConstraints) { return constraints.frameRate; }',
            'export const vibrate = Navigator.prototype.vibrate;',
            'export function cueLine(cue: VTTCue) { return cue.line; }',
            'export function publicKeyAlgorithm(response: AuthenticatorAttestationResponse) { return response.getPublicKeyAlgorithm(); }',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function animationCurrentTime(animation: Animation): CSSNumberish;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function frameRate(constraints: MediaTrackConstraints): ConstrainDouble;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    `export declare const vibrate: {
    (pattern: VibratePattern): boolean;
    (pattern: Iterable<number>): boolean;
};`,
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function cueLine(cue: VTTCue): LineAndPositionSetting;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function publicKeyAlgorithm(response: AuthenticatorAttestationResponse): number;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled viewport and stream sizing numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export function viewportScale(viewport: VisualViewport) { return viewport.scale; }',
            'export function viewportWidth(viewport: VisualViewport) { return viewport.width; }',
            'export function byteLengthHighWaterMark(strategy: ByteLengthQueuingStrategy) { return strategy.highWaterMark; }',
            'export function countHighWaterMark(strategy: CountQueuingStrategy) { return strategy.highWaterMark; }',
            'export function byteSourceChunkSize(source: UnderlyingByteSource) { return source.autoAllocateChunkSize; }',
            'export const readableStreamCtor = ReadableStream;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function viewportScale(viewport: VisualViewport): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function viewportWidth(viewport: VisualViewport): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function byteLengthHighWaterMark(strategy: ByteLengthQueuingStrategy): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function countHighWaterMark(strategy: CountQueuingStrategy): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function byteSourceChunkSize(source: UnderlyingByteSource): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const readableStreamCtor: {',
  );
  assertStringIncludes(
    projectedDeclarationText,
    `new (underlyingSource: UnderlyingByteSource, strategy?: {
        highWaterMark?: number;
    }): ReadableStream<Uint8Array<ArrayBuffer>>;`,
  );
});

Deno.test('emitProjectedDeclarations preserves bundled geometry and text measurement numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export function pointX(point: DOMPointReadOnly) { return point.x; }',
            'export function rectWidth(rect: DOMRectReadOnly) { return rect.width; }',
            'export function resizeInlineSize(size: ResizeObserverSize) { return size.inlineSize; }',
            'export function textWidth(metrics: TextMetrics) { return metrics.width; }',
            'export const domPointCtor = DOMPoint;',
            'export const domRectCtor = DOMRect;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function pointX(point: DOMPointReadOnly): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function rectWidth(rect: DOMRectReadOnly): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function resizeInlineSize(size: ResizeObserverSize): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function textWidth(metrics: TextMetrics): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const domPointCtor: {',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'new (x?: number, y?: number, z?: number, w?: number): DOMPoint;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const domRectCtor: {',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'new (x?: number, y?: number, width?: number, height?: number): DOMRect;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled canvas image and video sizing numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export function bitmapWidth(bitmap: ImageBitmap) { return bitmap.width; }',
            'export function imageDataWidth(imageData: ImageData) { return imageData.width; }',
            'export function canvasHeight(canvas: OffscreenCanvas) { return canvas.height; }',
            'export function frameDuration(frame: VideoFrame) { return frame.duration; }',
            'export function frameWidth(metadata: VideoFrameCallbackMetadata) { return metadata.width; }',
            'export const createImageBitmapFn = createImageBitmap;',
            'export const imageDataCtor = ImageData;',
            'export const offscreenCanvasCtor = OffscreenCanvas;',
            'export const videoFrameCtor = VideoFrame;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function bitmapWidth(bitmap: ImageBitmap): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function imageDataWidth(imageData: ImageData): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function canvasHeight(canvas: OffscreenCanvas): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function frameDuration(frame: VideoFrame): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function frameWidth(metadata: VideoFrameCallbackMetadata): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const createImageBitmapFn: typeof createImageBitmap;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const imageDataCtor: {',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'new (sw: number, sh: number, settings?: ImageDataSettings): ImageData;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const offscreenCanvasCtor: {',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'new (width: number, height: number): OffscreenCanvas;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const videoFrameCtor: {',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'new (image: CanvasImageSource, init?: VideoFrameInit): VideoFrame;',
  );
});

Deno.test('emitProjectedDeclarations preserves bundled audio timing and canvas image-data numeric API references as number', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'export function contextCurrentTime(context: BaseAudioContext) { return context.currentTime; }',
            'export function audioBaseLatency(context: AudioContext) { return context.baseLatency; }',
            'export function videoDroppedFrames(quality: VideoPlaybackQuality) { return quality.droppedVideoFrames; }',
            'export const bufferSourceStart = AudioBufferSourceNode.prototype.start;',
            'export const createBuffer = BaseAudioContext.prototype.createBuffer;',
            'export const createDelay = BaseAudioContext.prototype.createDelay;',
            'export const createImageData = CanvasRenderingContext2D.prototype.createImageData;',
            'export const getImageData = CanvasRenderingContext2D.prototype.getImageData;',
            'export const putImageData = CanvasRenderingContext2D.prototype.putImageData;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  ).get(entryFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function contextCurrentTime(context: BaseAudioContext): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function audioBaseLatency(context: AudioContext): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function videoDroppedFrames(quality: VideoPlaybackQuality): number;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const bufferSourceStart: (when?: number, offset?: number, duration?: number) => void;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const createDelay: (maxDelayTime?: number) => DelayNode;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    `export declare const createImageData: {
    (sw: number, sh: number, settings?: ImageDataSettings): ImageData;
    (imageData: ImageData): ImageData;
};`,
  );
  assertStringIncludes(
    projectedDeclarationText,
    'export declare const getImageData: (sx: number, sy: number, sw: number, sh: number, settings?: ImageDataSettings) => ImageData;',
  );
  assertStringIncludes(
    projectedDeclarationText,
    `export declare const putImageData: {
    (imageData: ImageData, dx: number, dy: number): void;
    (imageData: ImageData, dx: number, dy: number, dirtyX: number, dirtyY: number, dirtyWidth: number, dirtyHeight: number): void;
};`,
  );
});

Deno.test('machine numerics only apply JS coercer lowering for JS-target expansion', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const sourceText = [
    'const inferred = 1 + 2;',
    'void (U8(1) + U8(2));',
    '',
  ].join('\n');
  const jsProgram = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([[entryFile, sourceText]]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  }).program;
  const wasmProgram = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([[entryFile, sourceText]]),
      { soundStdlib: true },
    ),
    numericLoweringTarget: 'wasm',
    options,
    rootNames: [entryFile],
  }).program;

  const jsSourceFile = jsProgram.getSourceFile(toProgramFileName(entryFile));
  const wasmSourceFile = wasmProgram.getSourceFile(toProgramFileName(entryFile));

  assert(jsSourceFile);
  assert(wasmSourceFile);
  assertStringIncludes(jsSourceFile.text, 'const inferred = 1 + 2;');
  assertStringIncludes(wasmSourceFile.text, 'const inferred = 1 + 2;');
  assertStringIncludes(jsSourceFile.text, 'void (__numericBinary("+", U8(1), U8(2)));');
  assertStringIncludes(
    wasmSourceFile.text,
    '__numericWasmLeaf<u8>(__numericBinary("+", U8(1), U8(2)))',
  );
  assertEquals(jsSourceFile.text.includes('void (U8(1) + U8(2));'), false);
  assertEquals(wasmSourceFile.text.includes('void (U8(1) + U8(2));'), false);
});

Deno.test('sts:numerics namespace guards narrow imported machine numeric refinements', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import * as Num from 'sts:numerics';",
          "import type { Numeric, Int } from 'sts:numerics';",
          'declare const value: Numeric;',
          'if (Num.isInt(value)) {',
          '  const narrowed: Int = value;',
          '  void narrowed;',
          '}',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('sts:numerics exact leaf guards narrow numeric inputs to machine leaves', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import * as Num from 'sts:numerics';",
          "import type { Numeric, f32, u8 } from 'sts:numerics';",
          'declare const value: Numeric;',
          'if (Num.isU8(value)) {',
          '  const narrowed: u8 = value;',
          '  void narrowed;',
          '}',
          'if (Num.isF32(value)) {',
          '  const narrowed: f32 = value;',
          '  void narrowed;',
          '}',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('sts:numerics Float guards narrow numeric inputs to Float refinements', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import * as Num from 'sts:numerics';",
          "import type { Numeric, Float } from 'sts:numerics';",
          'declare const value: Numeric;',
          'if (Num.isFloat(value)) {',
          '  const narrowed: Float = value;',
          '  void narrowed;',
          '}',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('plain numbers do not satisfy Float refinements without a guard', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import type { Float } from 'sts:numerics';",
          'declare const value: number;',
          'const narrowed: Float = value;',
          'void narrowed;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), [2322]);
});

Deno.test('integral machine leaves remain assignable to Int refinements', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import type { Int, u8 } from 'sts:numerics';",
          'declare const value: u8;',
          'const narrowed: Int = value;',
          'void narrowed;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('machine numerics reject arithmetic on abstract numeric families until narrowed', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            "import * as Num from 'sts:numerics';",
            'declare const a: Numeric;',
            'declare const b: Numeric;',
            'const direct = a + b;',
            'if (Num.isInt(a) && Num.isInt(b)) {',
            '  const guarded = a + b;',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(
    builtinExpanded.frontendDiagnostics().map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 4, 16],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 6, 21],
    ],
  );
});

Deno.test('host number and bigint arithmetic stays legal in .sts', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'const numberA: number = 1;',
            'const numberB: number = 2;',
            'const bigintA: bigint = 1n;',
            'const bigintB: bigint = 2n;',
            'const directNumber = numberA + numberB;',
            'const directBigint = bigintA + bigintB;',
            "if (typeof numberA === 'number' && typeof numberB === 'number') {",
            '  const narrowedNumber = numberA + numberB;',
            '  void narrowedNumber;',
            '}',
            "if (typeof bigintA === 'bigint' && typeof bigintB === 'bigint') {",
            '  const narrowedBigint = bigintA + bigintB;',
            '  void narrowedBigint;',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(builtinExpanded.frontendDiagnostics(), []);
});

Deno.test('host number and bigint compound assignment stays legal in .sts', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'let numberValue: number = 1;',
            'let bigintValue: bigint = 1n;',
            'numberValue += 1;',
            'bigintValue += 1n;',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(builtinExpanded.frontendDiagnostics(), []);
});

Deno.test('host number and bigint unary and update operators stay legal in .sts', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'let numberValue: number = 1;',
            'let bigintValue: bigint = 1n;',
            'const negatedNumber = -numberValue;',
            'const invertedNumber = ~numberValue;',
            '++numberValue;',
            'numberValue--;',
            'const negatedBigint = -bigintValue;',
            'const invertedBigint = ~bigintValue;',
            '++bigintValue;',
            'bigintValue--;',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(builtinExpanded.frontendDiagnostics(), []);
});

Deno.test('machine numerics reject unary plus on abstract numeric families until narrowed', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            "import * as Num from 'sts:numerics';",
            'declare let value: Numeric;',
            'const direct = +value;',
            'if (Num.isInt(value)) {',
            '  const guarded = +value;',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(
    builtinExpanded.frontendDiagnostics().map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 3, 16],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 5, 21],
    ],
  );
});

Deno.test('machine numerics reject remaining unary and update operators on abstract numeric families until narrowed', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            "import * as Num from 'sts:numerics';",
            'declare let value: Numeric;',
            'const negated = -value;',
            'const inverted = ~value;',
            '++value;',
            'value--;',
            'if (Num.isInt(value)) {',
            '  const guardedNegated = -value;',
            '  const guardedInverted = ~value;',
            '  ++value;',
            '  value--;',
            '}',
            "if (typeof value === 'number') {",
            '  const hostNarrowed = value;',
            '  void hostNarrowed;',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(
    builtinExpanded.frontendDiagnostics().map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 3, 17],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 4, 18],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 5, 1],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 6, 1],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 8, 28],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 9, 29],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 10, 5],
      ['SOUNDSCRIPT_NUMERIC_ABSTRACT_FAMILY', 11, 5],
    ],
  );
});

Deno.test('sts:numerics Float guards still require explicit conversion for binary arithmetic', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import * as Num from 'sts:numerics';",
          "import type { Numeric } from 'sts:numerics';",
          'declare const a: Numeric;',
          'declare const b: Numeric;',
          'if (Num.isFloat(a) && Num.isFloat(b)) {',
          '  const sum = a + b;',
          '  const widened: number = sum;',
          '  void widened;',
          '}',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), [2365]);
});

Deno.test('plain TypeScript does not receive a global Numeric helper without sts:numerics imports', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          'declare const value: number | bigint;',
          'if (Numeric.isInt(value)) {',
          '  const narrowed = value;',
          '  void narrowed;',
          '}',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);
  const diagnosticCodes = ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code);

  assertEquals(diagnosticCodes.includes(2304), true);
});

Deno.test('plain TypeScript does not receive global machine numeric types or coercers without sts:numerics imports', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          'const value: u8 = U8(1);',
          'void value;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);
  const diagnosticCodes = ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code);

  assertEquals(diagnosticCodes, [2304, 2304]);
});

Deno.test('sound stdlib plain TypeScript does not receive global machine numeric types or coercers without sts:numerics imports', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          'const value: u8 = U8(1);',
          'void value;',
          '',
        ].join('\n'),
      ],
    ]),
    { soundStdlib: true },
  );
  const program = ts.createProgram([entryFile], options, host);
  const diagnosticCodes = ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code);

  assertEquals(diagnosticCodes, [2304, 2304]);
});

Deno.test('emitProjectedDeclarations imports canonical sts:numerics types and blocks raw numbers for plain TS consumers', () => {
  const sourceFile = '/virtual/src/lib.sts';
  const consumerFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
  };
  const preparedProgram = createPreparedProgram({
    baseHost: createBaseHost(
      new Map([
        [sourceFile, 'export function identity(value: u8): u8 { return value; }\n'],
      ]),
    ),
    options,
    rootNames: [sourceFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(preparedProgram).get(sourceFile);

  assertEquals(typeof projectedDeclarationText, 'string');
  assert(projectedDeclarationText);
  assertStringIncludes(projectedDeclarationText, "import type { u8 } from 'sts:numerics';");
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function identity(value: u8): u8;',
  );
  assertEquals(projectedDeclarationText.includes('type numeric = number | bigint;'), false);
  assertEquals(projectedDeclarationText.includes('type u8 = number & {'), false);
  assertEquals(projectedDeclarationText.includes('declare function U8(value: number): u8;'), false);

  const preparedHost = createPreparedCompilerHost(
    createBaseHost(
      new Map([
        [
          consumerFile,
          'import { identity } from "./lib";\nconst value = identity(1);\nvoid value;\n',
        ],
        [sourceFile, 'export function identity(value: u8): u8 { return value; }\n'],
      ]),
    ),
    new Map(),
    emitProjectedDeclarations(preparedProgram),
    createPreparedCompilerHostReuseState(),
    options,
  );
  const consumerProgram = ts.createProgram([consumerFile], options, preparedHost.host);

  assertEquals(ts.getPreEmitDiagnostics(consumerProgram).map((diagnostic) => diagnostic.code), [
    2345,
  ]);
});

Deno.test('emitProjectedDeclarations preserves exported plain numeric consts as number', () => {
  const sourceFile = '/virtual/src/lib.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [sourceFile, 'export const value = 1 + 2;\n'],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [sourceFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  )
    .get(sourceFile);

  assert(projectedDeclarationText);
  assertEquals(projectedDeclarationText.includes("from 'sts:numerics';"), false);
  assertStringIncludes(projectedDeclarationText, 'export declare const value: number;');
});

Deno.test('emitProjectedDeclarations preserves authored bigint surfaces without leaking internal aliases', () => {
  const sourceFile = '/virtual/src/lib.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          sourceFile,
          'export function add(left: bigint, right: bigint): bigint { return left + right; }\n',
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [sourceFile],
  });

  const projectedDeclarationText = emitProjectedDeclarations(
    builtinExpanded.analysisPreparedProgram,
  )
    .get(sourceFile);

  assert(projectedDeclarationText);
  assertStringIncludes(
    projectedDeclarationText,
    'export declare function add(left: bigint, right: bigint): bigint;',
  );
  assertEquals(projectedDeclarationText.includes('__sts_builtin_bigint'), false);
  assertEquals(projectedDeclarationText.includes('__soundscript_builtin_bigint'), false);
  assertEquals(projectedDeclarationText.includes("from 'sts:numerics'"), false);
});

Deno.test('machine numerics preserve same-leaf arithmetic for number-backed and bigint-backed leaves', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const program = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'const byteSum: u8 = U8(1) + U8(2);',
            'const byteTriple: u8 = U8(1) + U8(2) + U8(3);',
            'const negByte: u8 = -U8(1);',
            'const notByte: u8 = ~U8(1);',
            'const wideSum: i64 = I64(1n) + I64(2n);',
            'const wideTriple: i64 = I64(1n) + I64(2n) + I64(3n);',
            'const negWide: i64 = -I64(1n);',
            'const notWide: i64 = ~I64(1n);',
            'void byteSum;',
            'void byteTriple;',
            'void negByte;',
            'void notByte;',
            'void wideSum;',
            'void wideTriple;',
            'void negWide;',
            'void notWide;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  }).program;

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('machine numerics preserve same-leaf compound assignment and updates across lowering targets', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const sourceText = [
    'let byte: u8 = U8(1);',
    'byte += U8(2);',
    'byte |= U8(4);',
    '++byte;',
    'byte--;',
    'let wide: i64 = I64(1n);',
    'wide += I64(2n);',
    'wide |= I64(4n);',
    '++wide;',
    'wide--;',
    'void byte;',
    'void wide;',
    '',
  ].join('\n');

  for (const numericLoweringTarget of [undefined, 'wasm'] as const) {
    const program = createBuiltinExpandedProgram({
      baseHost: createBaseHost(
        new Map([[entryFile, sourceText]]),
        { soundStdlib: true },
      ),
      numericLoweringTarget,
      options,
      rootNames: [entryFile],
    }).program;

    assertEquals(
      ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code),
      [],
    );
  }
});

Deno.test('machine numerics reject mixed-leaf arithmetic until explicitly coerced', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'const mixedByte = U8(1) + I8(2);',
            'const mixedLiteral = U8(1) + 2;',
            'void mixedByte;',
            'void mixedLiteral;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(
    builtinExpanded.frontendDiagnostics().map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', 1, 19],
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', 2, 22],
    ],
  );
});

Deno.test('machine numerics reject mixed-leaf compound assignment until explicitly coerced', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'let byte: u8 = U8(1);',
            'byte += I8(2);',
            'byte += 2;',
            'let wide: i64 = I64(1n);',
            'wide += U64(2n);',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(
    builtinExpanded.frontendDiagnostics().map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', 2, 1],
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', 3, 1],
      ['SOUNDSCRIPT_NUMERIC_MIXED_LEAF', 5, 1],
    ],
  );
});

Deno.test('sts:numerics checked integer helpers expose typed Result failures', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import { I16, NumericDivisionByZeroFailure, NumericOverflowFailure, U8 } from 'sts:numerics';",
          "import type { i16, u8 } from 'sts:numerics';",
          "import type { Result } from 'sts:result';",
          'const added: Result<u8, NumericOverflowFailure> = U8.checkedAdd(U8(10), U8(20));',
          'const divided: Result<i16, NumericOverflowFailure | NumericDivisionByZeroFailure> = I16.checkedDiv(I16(10), I16(2));',
          'const negated: Result<i16, NumericOverflowFailure> = I16.checkedNeg(I16(1));',
          'if (added.tag === "err") {',
          '  const overflow: NumericOverflowFailure = added.error;',
          '  const leaf: string = overflow.leaf;',
          '  const operation: "add" | "sub" | "mul" | "div" | "rem" | "neg" = overflow.operation;',
          '  void leaf;',
          '  void operation;',
          '}',
          'if (divided.tag === "err" && divided.error instanceof NumericDivisionByZeroFailure) {',
          '  const operation: "div" | "rem" = divided.error.operation;',
          '  void operation;',
          '}',
          'void negated;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('checked integer helper Results participate in Try macro flows', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const program = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'function unwrapByte(): u8 {',
            '  return Try(U8.checkedAdd(U8(1), U8(2)));',
            '}',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  }).program;

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('machine numerics admit contextual typed literals in .sts source', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const program = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            "import type { f32, i64, u8 } from 'sts:numerics';",
            'const byte: u8 = 10;',
            'const signed: i8 = -1;',
            'const wide: i64 = 10;',
            'const float32: f32 = 0.1;',
            'const float64: f64 = 0.1;',
            'declare function takesByte(value: u8): void;',
            'declare function takesWide(value: i64): void;',
            'function makeByte(): u8 { return 10; }',
            'function withDefault(value: u8 = 1): u8 { return value; }',
            'const point: { x: u8; nested: { y: i64 }; sample: f32 } = { x: 1, nested: { y: 10 }, sample: 0.5 };',
            'const bytes: u8[] = [1, 2, 3];',
            'const tuple: [u8, i64, f32] = [1, 10, 0.5];',
            'const { value = 7 }: { value?: u8 } = {};',
            'takesByte(10);',
            'takesWide(10);',
            'void byte;',
            'void signed;',
            'void wide;',
            'void float32;',
            'void float64;',
            'void makeByte;',
            'void withDefault;',
            'void point;',
            'void bytes;',
            'void tuple;',
            'void value;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  }).program;

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});

Deno.test('machine numeric Match patterns support host and exact machine leaves', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            "import type { Numeric, Int, Float, u8 } from 'sts:numerics';",
            'declare const value: Numeric | number | bigint;',
            'const result = Match(value, [',
            "  (n: number) => 'host-number',",
            "  (b: bigint) => 'host-bigint',",
            "  (v: u8) => 'u8',",
            "  (v: Float) => 'float',",
            "  (v: Int) => 'int',",
            "  (v: Numeric) => 'numeric',",
            "  (_) => 'fallback',",
            ']);',
            'void result;',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(builtinExpanded.frontendDiagnostics(), []);
  assertEquals(
    ts.getPreEmitDiagnostics(builtinExpanded.program).map((diagnostic) => diagnostic.code),
    [],
  );
});

Deno.test('sts sort and toSorted require explicit comparators', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'const hostValues = [3, 1, 2];',
            'hostValues.sort();',
            'const machineValues: u8[] = [U8(3), U8(1), U8(2)];',
            'machineValues.toSorted();',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(
    builtinExpanded.frontendDiagnostics().map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 2, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 4, 1],
    ],
  );
});

Deno.test('sts sort comparator rule covers element-access and prototype-call sites', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'const hostValues = [3, 1, 2];',
            'hostValues["sort"]();',
            'const machineValues: u8[] = [U8(3), U8(1), U8(2)];',
            'machineValues["toSorted"]();',
            'Array.prototype.sort.call(hostValues);',
            'Array.prototype.toSorted.call(machineValues);',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(
    builtinExpanded.frontendDiagnostics().map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 2, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 4, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 5, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 6, 1],
    ],
  );
});

Deno.test('sts sort comparator rule covers apply and bound alias sites', () => {
  const entryFile = '/virtual/src/index.sts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const builtinExpanded = createBuiltinExpandedProgram({
    baseHost: createBaseHost(
      new Map([
        [
          entryFile,
          [
            'const hostValues = [3, 1, 2];',
            'Array.prototype.sort.apply(hostValues);',
            'const machineValues: u8[] = [U8(3), U8(1), U8(2)];',
            'Array.prototype.toSorted.apply(machineValues);',
            'const boundSort = hostValues.sort.bind(hostValues);',
            'boundSort();',
            'const boundToSorted = machineValues.toSorted.bind(machineValues);',
            'boundToSorted();',
            '',
          ].join('\n'),
        ],
      ]),
      { soundStdlib: true },
    ),
    options,
    rootNames: [entryFile],
  });

  assertEquals(
    builtinExpanded.frontendDiagnostics().map((diagnostic) => [
      diagnostic.code,
      diagnostic.line,
      diagnostic.column,
    ]),
    [
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 2, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 4, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 6, 1],
      ['SOUNDSCRIPT_SORT_COMPARE_REQUIRED', 8, 1],
    ],
  );
});

Deno.test('sts:numerics and sts:json expose explicit machine helper surfaces', () => {
  const entryFile = '/virtual/src/index.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    strict: true,
  };
  const host = createBaseHost(
    new Map([
      [
        entryFile,
        [
          "import { F64, U8, binarySearchAs, clampAs, eqAs, hashEqAs, maxAs, minAs, orderAs } from 'sts:numerics';",
          "import { parseJson, stringifyJson, type MachineJsonLikeValue } from 'sts:json';",
          "import { isOk } from 'sts:result';",
          "import type { u8 } from 'sts:numerics';",
          'const smallest: u8 | undefined = minAs(U8, [1, 2, 3]);',
          'const largest = maxAs(F64, [1, F64(NaN)]);',
          'const clamped: u8 = clampAs(U8, 7, 1, 5);',
          'const index: number = binarySearchAs(U8, [1, 2, 3], 2);',
          'const eq = eqAs(U8);',
          'const order = orderAs(F64);',
          'const hashEq = hashEqAs(U8);',
          'const same: boolean = eq.equals(U8(1), 1);',
          'const ordering: number = order.compare(F64(1), 2);',
          'const hash: number = hashEq.hash(1);',
          'const payload: MachineJsonLikeValue = { byte: U8(1), nan: F64(NaN) };',
          'const encoded = stringifyJson(payload, { numerics: "tagged" });',
          'if (isOk(encoded)) {',
          '  const decoded = parseJson(encoded.value, { numerics: "tagged" });',
          '  void decoded;',
          '}',
          'void smallest;',
          'void largest;',
          'void clamped;',
          'void index;',
          'void same;',
          'void ordering;',
          'void hash;',
          '',
        ].join('\n'),
      ],
    ]),
  );
  const program = ts.createProgram([entryFile], options, host);

  assertEquals(ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code), []);
});
