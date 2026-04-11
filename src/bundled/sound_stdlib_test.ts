import { assertEquals, assertMatch } from '@std/assert';
import { dirname, fromFileUrl, join } from '@std/path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

import { resolveBundledTypesDirectory, resolveOverrideDirectory } from './sound_stdlib.ts';

const LOCAL_BUNDLED_TYPESCRIPT_DIRECTORY = join(
  dirname(fromFileUrl(import.meta.url)),
  'typescript',
);

function getLocalBundledLibDirectory(): string {
  return join(LOCAL_BUNDLED_TYPESCRIPT_DIRECTORY, 'lib');
}

function getLocalBundledTypesDirectory(): string {
  return join(LOCAL_BUNDLED_TYPESCRIPT_DIRECTORY, 'types');
}

type AnyTokenOccurrence = {
  fileName: string;
  line: number;
  character: number;
  context: string;
};

function collectAnyKeywordOccurrencesInFile(filePath: string): AnyTokenOccurrence[] {
  const sourceText = Deno.readTextFileSync(filePath);
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const occurrences: AnyTokenOccurrence[] = [];

  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const position = node.getStart(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
      const lineText = sourceFile.text
        .slice(sourceFile.getPositionOfLineAndCharacter(line, 0))
        .split('\n', 1)[0]
        .trim();

      occurrences.push({
        fileName: filePath,
        line: line + 1,
        character: character + 1,
        context: lineText,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return occurrences;
}

function collectDeclarationFilePaths(directoryPath: string): string[] {
  const filePaths: string[] = [];

  for (const entry of Deno.readDirSync(directoryPath)) {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory) {
      filePaths.push(...collectDeclarationFilePaths(entryPath));
      continue;
    }
    if (entry.isFile && entry.name.endsWith('.d.ts')) {
      filePaths.push(entryPath);
    }
  }

  return filePaths;
}

function collectDeclaredModulesInDirectory(directoryPath: string): string[] {
  const modules = new Set<string>();

  for (const filePath of collectDeclarationFilePaths(directoryPath)) {
    const sourceText = Deno.readTextFileSync(filePath);
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
        modules.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return [...modules].sort();
}

Deno.test('vendored sound stdlib declarations contain no any keywords', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const bundledTypesDirectory = getLocalBundledTypesDirectory();
  const occurrences: AnyTokenOccurrence[] = [];

  for (
    const filePath of [
      ...collectDeclarationFilePaths(bundledLibDirectory),
      ...collectDeclarationFilePaths(bundledTypesDirectory),
    ]
  ) {
    occurrences.push(...collectAnyKeywordOccurrencesInFile(filePath));
  }

  assertEquals(occurrences, []);
});

Deno.test('vendored sound node package records pinned upstream metadata', () => {
  const bundledTypesDirectory = getLocalBundledTypesDirectory();
  const vendorMetadata = JSON.parse(
    Deno.readTextFileSync(join(bundledTypesDirectory, 'node', 'vendor.json')),
  ) as {
    excludedModules?: string[];
    nodeMajor?: number;
    nodeTypesVersion?: string;
    undiciTypesVersion?: string;
  };

  assertEquals(vendorMetadata.nodeMajor, 24);
  assertEquals(vendorMetadata.nodeTypesVersion, '24.12.2');
  assertEquals(vendorMetadata.undiciTypesVersion, '7.16.0');
  assertEquals(vendorMetadata.excludedModules?.includes('node:sys'), true);
});

Deno.test('vendored sound node package covers the public node 24 builtin module surface', () => {
  const bundledTypesDirectory = getLocalBundledTypesDirectory();
  const declaredModules = collectDeclaredModulesInDirectory(join(bundledTypesDirectory, 'node'));
  const declaredNodeModules = declaredModules.filter((moduleName) =>
    moduleName.startsWith('node:')
  );
  const normalizedBuiltinModules = [
    ...new Set(
      builtinModules
        .map((moduleName) => moduleName.startsWith('node:') ? moduleName : `node:${moduleName}`)
        .map((moduleName) => moduleName === 'node:traceEvents' ? 'node:trace_events' : moduleName),
    ),
  ].sort();
  const expectedPublicModules = normalizedBuiltinModules.filter((moduleName) =>
    !moduleName.startsWith('node:_') &&
    !moduleName.startsWith('node:internal/') &&
    moduleName !== 'node:sys'
  );

  assertEquals(
    expectedPublicModules.every((moduleName) => declaredNodeModules.includes(moduleName)),
    true,
  );
  assertEquals(declaredNodeModules.includes('node:sys'), false);
  assertEquals(declaredNodeModules.some((moduleName) => moduleName.startsWith('node:_')), false);
});

Deno.test('vendored sound stdlib Date declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const es5Text = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.es5.d.ts'));
  const es2015CoreText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.es2015.core.d.ts'));

  assertEquals(es5Text.includes('getTime(): number;'), true);
  assertEquals(es5Text.includes('setTime(time: number): number;'), true);
  assertEquals(es5Text.includes('parse(s: string): number;'), true);
  assertEquals(es5Text.includes('now(): number;'), true);
  assertEquals(
    es2015CoreText.includes('new (value: number | string | Date): Date;'),
    true,
  );
});

Deno.test('vendored sound stdlib String Array and RegExp declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const es5Text = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.es5.d.ts'));
  const es2015CoreText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.es2015.core.d.ts'));

  assertEquals(
    es5Text.includes('charCodeAt(index: number): number;'),
    true,
  );
  assertMatch(
    es5Text,
    /indexOf\(\s+searchString: string,\s+position\?: number,\s+\): number;/u,
  );
  assertEquals(es5Text.includes('lastIndex: number;'), true);
  assertMatch(
    es5Text,
    /indexOf\(\s+searchElement: T,\s+fromIndex\?: number,\s+\): number;/u,
  );
  assertMatch(
    es5Text,
    /splice\(\s+start: number,\s+deleteCount\?: number,\s+\): T\[\];/u,
  );
  assertEquals(
    es2015CoreText.includes(
      'codePointAt(pos: number): number | undefined;',
    ),
    true,
  );
  assertEquals(
    es2015CoreText.includes('repeat(count: number): string;'),
    true,
  );
});

Deno.test('vendored sound stdlib ArrayBuffer and DataView declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const es5Text = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.es5.d.ts'));

  assertEquals(es5Text.includes('readonly byteLength: number;'), true);
  assertEquals(
    es5Text.includes(
      'slice(begin?: number, end?: number): ArrayBuffer;',
    ),
    true,
  );
  assertEquals(es5Text.includes('new (byteLength: number): ArrayBuffer;'), true);
  assertEquals(es5Text.includes('readonly byteOffset: number;'), true);
  assertEquals(
    es5Text.includes(
      'getUint8(byteOffset: number): number;',
    ),
    true,
  );
  assertEquals(
    es5Text.includes(
      'setUint8(byteOffset: number, value: number): void;',
    ),
    true,
  );
});

Deno.test('vendored sound stdlib typed array declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const es5Text = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.es5.d.ts'));
  const es2020BigIntText = Deno.readTextFileSync(
    join(bundledLibDirectory, 'lib.es2020.bigint.d.ts'),
  );

  assertEquals(es5Text.includes('readonly BYTES_PER_ELEMENT: number;'), true);
  assertEquals(
    es5Text.includes(
      'copyWithin(target: number, start: number, end?: number): this;',
    ),
    true,
  );
  assertEquals(
    es5Text.includes(
      'findIndex(predicate: (value: number, index: number, obj: this) => boolean, thisArg?: unknown): number;',
    ),
    true,
  );
  assertEquals(es5Text.includes('readonly length: number;'), true);
  assertEquals(es5Text.includes('new (length: number): Uint8Array<ArrayBuffer>;'), true);
  assertEquals(
    es5Text.includes(
      'from<T>(arrayLike: ArrayLike<T>, mapfn: (v: T, k: number) => number, thisArg?: unknown): Uint8Array<ArrayBuffer>;',
    ),
    true,
  );

  assertEquals(
    es2020BigIntText.includes(
      'entries(): ArrayIterator<[number, bigint]>;',
    ),
    true,
  );
  assertEquals(
    es2020BigIntText.includes(
      'findIndex(predicate: (value: bigint, index: number, array: BigInt64Array<TArrayBuffer>) => boolean, thisArg?: unknown): number;',
    ),
    true,
  );
  assertEquals(
    es2020BigIntText.includes('keys(): ArrayIterator<number>;'),
    true,
  );
  assertEquals(
    es2020BigIntText.includes('new (length?: number): BigInt64Array<ArrayBuffer>;'),
    true,
  );
  assertEquals(
    es2020BigIntText.includes(
      'from<U>(arrayLike: ArrayLike<U>, mapfn: (v: U, k: number) => bigint, thisArg?: unknown): BigInt64Array<ArrayBuffer>;',
    ),
    true,
  );
  assertEquals(
    es2020BigIntText.includes(
      'getBigInt64(byteOffset: number, littleEndian?: boolean): bigint;',
    ),
    true,
  );
});

Deno.test('vendored sound stdlib typed array iterable and helper declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const es2015IterableText = Deno.readTextFileSync(
    join(bundledLibDirectory, 'lib.es2015.iterable.d.ts'),
  );
  const es2016ArrayIncludeText = Deno.readTextFileSync(
    join(bundledLibDirectory, 'lib.es2016.array.include.d.ts'),
  );
  const es2022ArrayText = Deno.readTextFileSync(
    join(bundledLibDirectory, 'lib.es2022.array.d.ts'),
  );

  assertEquals(
    es2015IterableText.includes(
      'entries(): ArrayIterator<[number, number]>;',
    ),
    true,
  );
  assertEquals(
    es2015IterableText.includes('keys(): ArrayIterator<number>;'),
    true,
  );
  assertEquals(
    es2015IterableText.includes(
      'from<T>(elements: Iterable<T>, mapfn?: (v: T, k: number) => number, thisArg?: unknown): Uint8Array<ArrayBuffer>;',
    ),
    true,
  );
  assertEquals(
    es2016ArrayIncludeText.includes(
      'includes(searchElement: number, fromIndex?: number): boolean;',
    ),
    true,
  );
  assertEquals(
    es2022ArrayText.includes(
      'at(index: number): number | undefined;',
    ),
    true,
  );
  assertEquals(
    es2022ArrayText.includes(
      'at(index: number): bigint | undefined;',
    ),
    true,
  );
});

Deno.test('vendored sound stdlib modern array and arraybuffer declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const es2023ArrayText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.es2023.array.d.ts'));
  const es2024ArrayBufferText = Deno.readTextFileSync(
    join(bundledLibDirectory, 'lib.es2024.arraybuffer.d.ts'),
  );

  assertEquals(
    es2023ArrayText.includes(
      'findLastIndex(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): number;',
    ),
    true,
  );
  assertEquals(
    es2023ArrayText.includes(
      'toSorted(compareFn?: (a: number, b: number) => number): Uint8Array<ArrayBuffer>;',
    ),
    true,
  );
  assertEquals(
    es2023ArrayText.includes(
      'toSorted(compareFn?: (a: bigint, b: bigint) => number): BigInt64Array<ArrayBuffer>;',
    ),
    true,
  );
  assertEquals(
    es2023ArrayText.includes(
      'with(index: number, value: bigint): BigInt64Array<ArrayBuffer>;',
    ),
    true,
  );
  assertEquals(
    es2023ArrayText.includes(
      'toSpliced(start: number, deleteCount: number, ...items: T[]): T[];',
    ),
    true,
  );

  assertEquals(
    es2024ArrayBufferText.includes('get maxByteLength(): number;'),
    true,
  );
  assertEquals(
    es2024ArrayBufferText.includes('resize(newByteLength?: number): void;'),
    true,
  );
  assertEquals(
    es2024ArrayBufferText.includes('transfer(newByteLength?: number): ArrayBuffer;'),
    true,
  );
  assertEquals(
    es2024ArrayBufferText.includes(
      'new (byteLength: number, options?: { maxByteLength?: number; }): ArrayBuffer;',
    ),
    true,
  );
});

Deno.test('vendored sound stdlib DOM binary and media declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(domText.includes('readonly duration: number;'), true);
  assertEquals(domText.includes('readonly sampleRate: number;'), true);
  assertEquals(
    domText.includes(
      'copyFromChannel(destination: Float32Array<ArrayBuffer>, channelNumber: number, bufferOffset?: number): void;',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'getChannelData(channel: number): Float32Array<ArrayBuffer>;',
    ),
    true,
  );
  assertEquals(domText.includes('readonly size: number;'), true);
  assertEquals(
    domText.includes(
      'slice(start?: number, end?: number, contentType?: string): Blob;',
    ),
    true,
  );
  assertEquals(domText.includes('readonly lastModified: number;'), true);
  assertEquals(domText.includes('read: number;'), true);
  assertEquals(domText.includes('written: number;'), true);
});

Deno.test('vendored sound stdlib DOM dynamic boundary declarations use unknown instead of any', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));
  const domAsyncIterableText = Deno.readTextFileSync(
    join(bundledLibDirectory, 'lib.dom.asynciterable.d.ts'),
  );

  assertEquals(domText.includes('processorOptions?: unknown;'), true);
  assertEquals(
    domText.includes('interface ReadableWritablePair<R = unknown, W = unknown> {'),
    true,
  );
  assertEquals(domText.includes('interface Transformer<I = unknown, O = unknown> {'), true);
  assertEquals(domText.includes('interface TransformStream<I = unknown, O = unknown> {'), true);
  assertEquals(
    domText.includes('interface ReportBody {\n') &&
      domText.includes('    toJSON(): unknown;\n}\n\ndeclare var ReportBody: {'),
    true,
  );
  assertEquals(
    domText.includes(
      'new(worker: Worker, options?: unknown, transfer?: unknown[]): RTCRtpScriptTransform;',
    ),
    true,
  );
  assertEquals(
    domText.includes('postMessage(message: unknown, options?: StructuredSerializeOptions): void;'),
    true,
  );
  assertEquals(domText.includes('reportError(e: unknown): void;'), true);
  assertEquals(
    domText.includes(
      'structuredClone<T = unknown>(value: T, options?: StructuredSerializeOptions): T;',
    ),
    true,
  );
  assertEquals(domText.includes('onbeforeunload: OnBeforeUnloadEventHandler;'), true);
  assertEquals(
    domText.includes(
      'interface TransformerStartCallback<O> {\n    (controller: TransformStreamDefaultController<O>): void | PromiseLike<void>;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface UnderlyingSinkStartCallback {\n    (controller: WritableStreamDefaultController): void | PromiseLike<void>;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface UnderlyingSourceStartCallback<R> {\n    (controller: ReadableStreamController<R>): void | PromiseLike<void>;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface ViewTransitionUpdateCallback {\n    (): void | PromiseLike<void>;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'setInterval(handler: TimerHandler, timeout?: number, ...arguments: unknown[]): number;',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'addEventListener(type: string, listener: (this: EventSource, event: MessageEvent) => void, options?: boolean | AddEventListenerOptions): void;',
    ),
    true,
  );
  assertEquals(domAsyncIterableText.includes('interface ReadableStream<R = unknown> {'), true);
});

Deno.test('vendored sound stdlib DOM stream and event generics carry variance annotations', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(
    domText.includes(
      '// #[variance(T: in)]\ninterface QueuingStrategy<T = unknown> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(R: out, W: in)]\ninterface ReadableWritablePair<R = unknown, W = unknown> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(R: in)]\ninterface ReadableStreamDefaultController<R = unknown> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(I: in, O: out)]\ninterface TransformStream<I = unknown, O = unknown> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(I: in, O: out)]\ninterface Transformer<I = unknown, O = unknown> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(O: in)]\ninterface TransformStreamDefaultController<O = unknown> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(O: out)]\ninterface TransformerFlushCallback<O> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(I: in, O: out)]\ninterface TransformerTransformCallback<I, O> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(R: out)]\ninterface UnderlyingDefaultSource<R = unknown> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(W: in)]\ninterface UnderlyingSink<W = unknown> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(R: out)]\ninterface UnderlyingSource<R = unknown> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(W: in)]\ninterface UnderlyingSinkWriteCallback<W> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(R: out)]\ninterface UnderlyingSourcePullCallback<R> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(T: out)]\ninterface MessageEvent<T = unknown> extends Event {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(T: out)]\ninterface ProgressEvent<T extends EventTarget = EventTarget> extends Event {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(T: out)]\ninterface LockGrantedCallback<T> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(T: out)]\ninterface HTMLCollectionOf<T extends Element> extends HTMLCollectionBase {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(T: in)]\ninterface MessageEventTarget<T> {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(TNode: out)]\ninterface NodeListOf<TNode extends Node> extends NodeList {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(T: in)]\ntype ReadableStreamController<T> = ReadableStreamDefaultController<T> | ReadableByteStreamController;',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(T: inout)]\ninterface CustomEventInit<T = unknown> extends EventInit {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '// #[variance(T: inout)]\ninterface MessageEventInit<T = unknown> extends EventInit {',
    ),
    true,
  );
});

Deno.test('vendored sound stdlib DOM serializer declarations use exact object shapes when obvious', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(
    domText.includes(
      '    toJSON(): DOMMatrixInit;\n' +
        '    /**\n' +
        '     * The **`transformPoint`** method',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface DOMPointReadOnly {\n' +
        '    /**\n' +
        "     * The **`DOMPointReadOnly`** interface's **`w`** property",
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): DOMPointInit;\n' +
        '}\n\n' +
        'declare var DOMPointReadOnly: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface DOMQuad {\n' +
        '    /**\n' +
        "     * The **`DOMQuad`** interface's **`p1`** property",
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): DOMQuadInit;\n' +
        '}\n\n' +
        'declare var DOMQuad: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface DOMRectReadOnly {\n' +
        '    /**\n' +
        '     * The **`bottom`** read-only property',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): DOMRectInit;\n' +
        '}\n\n' +
        'declare var DOMRectReadOnly: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): GeolocationCoordinatesJSON;\n' +
        '}\n\n' +
        'declare var GeolocationCoordinates: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): GeolocationPositionJSON;\n' +
        '}\n\n' +
        'declare var GeolocationPosition: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): MediaDeviceInfoJSON;\n' +
        '}\n\n' +
        'declare var MediaDeviceInfo: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface GeolocationCoordinatesJSON {\n    accuracy: number;\n    altitude: number | null;\n    altitudeAccuracy: number | null;\n    heading: number | null;\n    latitude: number;\n    longitude: number;\n    speed: number | null;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface GeolocationPositionJSON {\n    coords: GeolocationCoordinatesJSON;\n    timestamp: EpochTimeStamp;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface MediaDeviceInfoJSON {\n    deviceId: string;\n    groupId: string;\n    kind: MediaDeviceKind;\n    label: string;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface CSPViolationReportBodyJSON {\n    blockedURL: string | null;\n    columnNumber: number | null;\n    disposition: SecurityPolicyViolationEventDisposition;\n    documentURL: string;\n    effectiveDirective: string;\n    lineNumber: number | null;\n    originalPolicy: string;\n    referrer: string | null;\n    sample: string | null;\n    sourceFile: string | null;\n    statusCode: number;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): CSPViolationReportBodyJSON;\n}\n\ndeclare var CSPViolationReportBody: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface LargestContentfulPaintJSON extends PerformanceEntryJSON {\n    id: string;\n    loadTime: DOMHighResTimeStamp;\n    renderTime: DOMHighResTimeStamp;\n    size: number;\n    url: string;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): LargestContentfulPaintJSON;\n}\n\ndeclare var LargestContentfulPaint: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PaymentAddressJSON {\n    addressLine: ReadonlyArray<string>;\n    city: string;\n    country: string;\n    dependentLocality: string;\n    organization: string;\n    phone: string;\n    postalCode: string;\n    recipient: string;\n    region: string;\n    sortingCode: string;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): PaymentAddressJSON;\n}\n\ndeclare var PaymentAddress: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PaymentResponseJSON {\n    details: unknown;\n    methodName: string;\n    payerEmail: string | null;\n    payerName: string | null;\n    payerPhone: string | null;\n    requestId: string;\n    shippingAddress: PaymentAddressJSON | null;\n    shippingOption: string | null;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): PaymentResponseJSON;\n    addEventListener<K extends keyof PaymentResponseEventMap>(',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PerformanceJSON {\n    navigation: PerformanceNavigationJSON;\n    timeOrigin: DOMHighResTimeStamp;\n    timing: PerformanceTimingJSON;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PerformanceEntryJSON {\n    duration: DOMHighResTimeStamp;\n    entryType: string;\n    name: string;\n    startTime: DOMHighResTimeStamp;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PerformanceEventTimingJSON extends PerformanceEntryJSON {\n    cancelable: boolean;\n    processingEnd: DOMHighResTimeStamp;\n    processingStart: DOMHighResTimeStamp;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PerformanceNavigationJSON {\n    redirectCount: number;\n    type: number;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PerformanceNavigationTimingJSON extends PerformanceResourceTimingJSON {\n    domComplete: DOMHighResTimeStamp;\n    domContentLoadedEventEnd: DOMHighResTimeStamp;\n    domContentLoadedEventStart: DOMHighResTimeStamp;\n    domInteractive: DOMHighResTimeStamp;\n    loadEventEnd: DOMHighResTimeStamp;\n    loadEventStart: DOMHighResTimeStamp;\n    redirectCount: number;\n    type: NavigationTimingType;\n    unloadEventEnd: DOMHighResTimeStamp;\n    unloadEventStart: DOMHighResTimeStamp;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PerformanceResourceTimingJSON extends PerformanceEntryJSON {\n    connectEnd: DOMHighResTimeStamp;\n    connectStart: DOMHighResTimeStamp;\n    decodedBodySize: number;\n    domainLookupEnd: DOMHighResTimeStamp;\n    domainLookupStart: DOMHighResTimeStamp;\n    encodedBodySize: number;\n    fetchStart: DOMHighResTimeStamp;\n    initiatorType: string;\n    nextHopProtocol: string;\n    redirectEnd: DOMHighResTimeStamp;\n    redirectStart: DOMHighResTimeStamp;\n    requestStart: DOMHighResTimeStamp;\n    responseEnd: DOMHighResTimeStamp;\n    responseStart: DOMHighResTimeStamp;\n    responseStatus: number;\n    secureConnectionStart: DOMHighResTimeStamp;\n    serverTiming: ReadonlyArray<PerformanceServerTimingJSON>;\n    transferSize: number;\n    workerStart: DOMHighResTimeStamp;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PerformanceServerTimingJSON {\n    description: string;\n    duration: DOMHighResTimeStamp;\n    name: string;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface PerformanceTimingJSON {\n    connectEnd: number;\n    connectStart: number;\n    domComplete: number;\n    domContentLoadedEventEnd: number;\n    domContentLoadedEventStart: number;\n    domInteractive: number;\n    domLoading: number;\n    domainLookupEnd: number;\n    domainLookupStart: number;\n    fetchStart: number;\n    loadEventEnd: number;\n    loadEventStart: number;\n    navigationStart: number;\n    redirectEnd: number;\n    redirectStart: number;\n    requestStart: number;\n    responseEnd: number;\n    responseStart: number;\n    secureConnectionStart: number;\n    unloadEventEnd: number;\n    unloadEventStart: number;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): PerformanceJSON;\n    addEventListener<K extends keyof PerformanceEventMap>(',
    ),
    true,
  );
  assertEquals(
    domText.includes('    toJSON(): PerformanceEntryJSON;\n}\n\ndeclare var PerformanceEntry: {'),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): PerformanceEventTimingJSON;\n}\n\ndeclare var PerformanceEventTiming: {',
    ),
    true,
  );
  assertEquals(
    domText.includes('    toJSON(): PerformanceNavigationJSON;\n    readonly TYPE_NAVIGATE: 0;'),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): PerformanceNavigationTimingJSON;\n}\n\ndeclare var PerformanceNavigationTiming: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): PerformanceResourceTimingJSON;\n}\n\ndeclare var PerformanceResourceTiming: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): PerformanceServerTimingJSON;\n}\n\ndeclare var PerformanceServerTiming: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): PerformanceTimingJSON;\n}\n\n/** @deprecated */\ndeclare var PerformanceTiming: {',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'interface ReportJSON {\n    body: unknown | null;\n    type: string;\n    url: string;\n}',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      '    toJSON(): ReportJSON;\n}\n\ndeclare var Report: {',
    ),
    true,
  );
});

Deno.test('vendored sound stdlib DOM timestamp declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(
    domText.includes('type DOMHighResTimeStamp = number;'),
    true,
  );
  assertEquals(
    domText.includes('type EpochTimeStamp = number;'),
    true,
  );
  assertEquals(domText.includes('now(): DOMHighResTimeStamp;'), true);
  assertEquals(domText.includes('readonly timeStamp: DOMHighResTimeStamp;'), true);
  assertEquals(domText.includes('readonly startTime: DOMHighResTimeStamp;'), true);
  assertEquals(domText.includes('readonly timestamp: EpochTimeStamp;'), true);
});

Deno.test('vendored sound stdlib WebGL declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(domText.includes('type GLbitfield = number;'), true);
  assertEquals(domText.includes('type GLclampf = number;'), true);
  assertEquals(domText.includes('type GLenum = number;'), true);
  assertEquals(domText.includes('type GLfloat = number;'), true);
  assertEquals(domText.includes('type GLint = number;'), true);
  assertEquals(domText.includes('type GLint64 = number;'), true);
  assertEquals(domText.includes('type GLintptr = number;'), true);
  assertEquals(domText.includes('type GLsizei = number;'), true);
  assertEquals(domText.includes('type GLsizeiptr = number;'), true);
  assertEquals(domText.includes('type GLuint = number;'), true);
  assertEquals(domText.includes('type GLuint64 = number;'), true);
  assertEquals(domText.includes('clear(mask: GLbitfield): void;'), true);
  assertEquals(
    domText.includes(
      'clearColor(red: GLclampf, green: GLclampf, blue: GLclampf, alpha: GLclampf): void;',
    ),
    true,
  );
  assertEquals(
    domText.includes('drawArrays(mode: GLenum, first: GLint, count: GLsizei): void;'),
    true,
  );
  assertEquals(
    domText.includes('uniform1f(location: WebGLUniformLocation | null, x: GLfloat): void;'),
    true,
  );
  assertEquals(
    domText.includes(
      'vertexAttribPointer(index: GLuint, size: GLint, type: GLenum, normalized: GLboolean, stride: GLsizei, offset: GLintptr): void;',
    ),
    true,
  );
});

Deno.test('vendored sound stdlib DOM numeric alias unions use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(
    domText.includes('type COSEAlgorithmIdentifier = number;'),
    true,
  );
  assertEquals(
    domText.includes('type CSSNumberish = number | CSSNumericValue;'),
    true,
  );
  assertEquals(
    domText.includes('type ConstrainDouble = number | ConstrainDoubleRange;'),
    true,
  );
  assertEquals(
    domText.includes('type ConstrainULong = number | ConstrainULongRange;'),
    true,
  );
  assertEquals(
    domText.includes('type LineAndPositionSetting = number | AutoKeyword;'),
    true,
  );
  assertEquals(
    domText.includes('type VibratePattern = number | number[];'),
    true,
  );
  assertEquals(domText.includes('max?: number;'), true);
  assertEquals(domText.includes('min?: number;'), true);
  assertEquals(domText.includes('exact?: number;'), true);
  assertEquals(domText.includes('ideal?: number;'), true);
  assertEquals(domText.includes('currentTime: CSSNumberish | null;'), true);
  assertEquals(domText.includes('frameRate?: ConstrainDouble;'), true);
  assertEquals(domText.includes('vibrate(pattern: VibratePattern): boolean;'), true);
  assertEquals(domText.includes('line: LineAndPositionSetting;'), true);
  assertEquals(domText.includes('getPublicKeyAlgorithm(): COSEAlgorithmIdentifier;'), true);
});

Deno.test('vendored sound stdlib viewport and stream sizing declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(domText.includes('highWaterMark?: number;'), true);
  assertEquals(domText.includes('highWaterMark: number;'), true);
  assertEquals(
    domText.includes('readonly highWaterMark: number;'),
    true,
  );
  assertEquals(
    domText.includes('autoAllocateChunkSize?: number;'),
    true,
  );
  assertEquals(
    domText.includes(
      'new(underlyingSource: UnderlyingByteSource, strategy?: { highWaterMark?: number }): ReadableStream<Uint8Array<ArrayBuffer>>;',
    ),
    true,
  );
  assertEquals(domText.includes('readonly height: number;'), true);
  assertEquals(domText.includes('readonly offsetLeft: number;'), true);
  assertEquals(domText.includes('readonly offsetTop: number;'), true);
  assertEquals(domText.includes('readonly pageLeft: number;'), true);
  assertEquals(domText.includes('readonly pageTop: number;'), true);
  assertEquals(domText.includes('readonly scale: number;'), true);
  assertEquals(domText.includes('readonly width: number;'), true);
});

Deno.test('vendored sound stdlib geometry and text measurement declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(domText.includes('w?: number;'), true);
  assertEquals(domText.includes('x?: number;'), true);
  assertEquals(domText.includes('y?: number;'), true);
  assertEquals(domText.includes('z?: number;'), true);
  assertEquals(domText.includes('height?: number;'), true);
  assertEquals(domText.includes('width?: number;'), true);
  assertEquals(domText.includes('w: number;'), true);
  assertEquals(domText.includes('x: number;'), true);
  assertEquals(domText.includes('y: number;'), true);
  assertEquals(domText.includes('z: number;'), true);
  assertEquals(domText.includes('readonly w: number;'), true);
  assertEquals(domText.includes('readonly x: number;'), true);
  assertEquals(domText.includes('readonly y: number;'), true);
  assertEquals(domText.includes('readonly z: number;'), true);
  assertEquals(
    domText.includes('new(x?: number, y?: number, z?: number, w?: number): DOMPoint;'),
    true,
  );
  assertEquals(domText.includes('readonly bottom: number;'), true);
  assertEquals(domText.includes('readonly left: number;'), true);
  assertEquals(domText.includes('readonly right: number;'), true);
  assertEquals(domText.includes('readonly top: number;'), true);
  assertEquals(
    domText.includes('new(x?: number, y?: number, width?: number, height?: number): DOMRect;'),
    true,
  );
  assertEquals(domText.includes('readonly blockSize: number;'), true);
  assertEquals(domText.includes('readonly inlineSize: number;'), true);
  assertEquals(
    domText.includes('readonly actualBoundingBoxAscent: number;'),
    true,
  );
  assertEquals(
    domText.includes('readonly actualBoundingBoxDescent: number;'),
    true,
  );
  assertEquals(
    domText.includes('readonly fontBoundingBoxAscent: number;'),
    true,
  );
  assertEquals(
    domText.includes('readonly fontBoundingBoxDescent: number;'),
    true,
  );
  assertEquals(domText.includes('readonly hangingBaseline: number;'), true);
  assertEquals(
    domText.includes('readonly ideographicBaseline: number;'),
    true,
  );
  assertEquals(domText.includes('readonly width: number;'), true);
});

Deno.test('vendored sound stdlib canvas image and video sizing declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(domText.includes('resizeHeight?: number;'), true);
  assertEquals(domText.includes('resizeWidth?: number;'), true);
  assertEquals(
    domText.includes('readonly height: number;'),
    true,
  );
  assertEquals(
    domText.includes('readonly width: number;'),
    true,
  );
  assertEquals(
    domText.includes(
      'new(sw: number, sh: number, settings?: ImageDataSettings): ImageData;',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'new(data: ImageDataArray, sw: number, sh?: number, settings?: ImageDataSettings): ImageData;',
    ),
    true,
  );
  assertEquals(domText.includes('height: number;'), true);
  assertEquals(domText.includes('width: number;'), true);
  assertEquals(
    domText.includes(
      'new(width: number, height: number): OffscreenCanvas;',
    ),
    true,
  );
  assertEquals(domText.includes('codedHeight: number;'), true);
  assertEquals(domText.includes('codedWidth: number;'), true);
  assertEquals(domText.includes('displayHeight?: number;'), true);
  assertEquals(domText.includes('displayWidth?: number;'), true);
  assertEquals(domText.includes('duration?: number;'), true);
  assertEquals(domText.includes('timestamp: number;'), true);
  assertEquals(domText.includes('mediaTime: number;'), true);
  assertEquals(
    domText.includes('processingDuration?: number;'),
    true,
  );
  assertEquals(domText.includes('presentedFrames: number;'), true);
  assertEquals(domText.includes('rtpTimestamp?: number;'), true);
  assertEquals(domText.includes('readonly codedHeight: number;'), true);
  assertEquals(domText.includes('readonly codedWidth: number;'), true);
  assertEquals(domText.includes('readonly displayHeight: number;'), true);
  assertEquals(domText.includes('readonly displayWidth: number;'), true);
  assertEquals(domText.includes('readonly duration: number | null;'), true);
  assertEquals(domText.includes('readonly timestamp: number;'), true);
  assertEquals(
    domText.includes(
      'allocationSize(options?: VideoFrameCopyToOptions): number;',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'createImageBitmap(image: ImageBitmapSource, sx: number, sy: number, sw: number, sh: number, options?: ImageBitmapOptions): Promise<ImageBitmap>;',
    ),
    true,
  );
});

Deno.test('vendored sound stdlib audio timing and canvas image-data declarations use plain number numerics', () => {
  const bundledLibDirectory = getLocalBundledLibDirectory();
  const domText = Deno.readTextFileSync(join(bundledLibDirectory, 'lib.dom.d.ts'));

  assertEquals(domText.includes('length: number;'), true);
  assertEquals(domText.includes('numberOfChannels?: number;'), true);
  assertEquals(domText.includes('sampleRate: number;'), true);
  assertEquals(domText.includes('detune?: number;'), true);
  assertEquals(domText.includes('loopEnd?: number;'), true);
  assertEquals(domText.includes('loopStart?: number;'), true);
  assertEquals(domText.includes('playbackRate?: number;'), true);
  assertEquals(
    domText.includes('latencyHint?: AudioContextLatencyCategory | number;'),
    true,
  );
  assertEquals(domText.includes('sampleRate?: number;'), true);
  assertEquals(domText.includes('offset?: number;'), true);
  assertEquals(domText.includes('delayTime?: number;'), true);
  assertEquals(domText.includes('maxDelayTime?: number;'), true);
  assertEquals(domText.includes('loopEnd: number;'), true);
  assertEquals(domText.includes('loopStart: number;'), true);
  assertEquals(
    domText.includes('start(when?: number, offset?: number, duration?: number): void;'),
    true,
  );
  assertEquals(domText.includes('readonly baseLatency: number;'), true);
  assertEquals(domText.includes('readonly outputLatency: number;'), true);
  assertEquals(domText.includes('readonly currentTime: number;'), true);
  assertEquals(domText.includes('readonly sampleRate: number;'), true);
  assertEquals(
    domText.includes(
      'createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;',
    ),
    true,
  );
  assertEquals(
    domText.includes('createDelay(maxDelayTime?: number): DelayNode;'),
    true,
  );
  assertEquals(
    domText.includes(
      'createImageData(sw: number, sh: number, settings?: ImageDataSettings): ImageData;',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'getImageData(sx: number, sy: number, sw: number, sh: number, settings?: ImageDataSettings): ImageData;',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'putImageData(imageData: ImageData, dx: number, dy: number): void;',
    ),
    true,
  );
  assertEquals(
    domText.includes(
      'putImageData(imageData: ImageData, dx: number, dy: number, dirtyX: number, dirtyY: number, dirtyWidth: number, dirtyHeight: number): void;',
    ),
    true,
  );
  assertEquals(
    domText.includes('readonly corruptedVideoFrames: number;'),
    true,
  );
  assertEquals(
    domText.includes('readonly droppedVideoFrames: number;'),
    true,
  );
  assertEquals(
    domText.includes('readonly totalVideoFrames: number;'),
    true,
  );
});

Deno.test(
  'resolveOverrideDirectory falls back to the repository bundled lib directory next to the compiled binary',
  async () => {
    const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-stdlib-dir-' });
    const runtimeDirectory = join(tempDirectory, 'runtime', 'src', 'bundled');
    const binaryDirectory = join(tempDirectory, 'repo', 'bin');
    const bundledLibDirectory = join(tempDirectory, 'repo', 'src', 'bundled', 'typescript', 'lib');

    Deno.mkdirSync(runtimeDirectory, { recursive: true });
    Deno.mkdirSync(binaryDirectory, { recursive: true });
    Deno.mkdirSync(bundledLibDirectory, { recursive: true });

    const resolved = resolveOverrideDirectory({
      importMetaUrl: `file://${join(runtimeDirectory, 'sound_stdlib.ts')}`,
      execPath: join(binaryDirectory, 'soundscript'),
    });

    assertEquals(resolved, bundledLibDirectory);
  },
);

Deno.test(
  'resolveBundledTypesDirectory falls back to the repository bundled types directory next to the compiled binary',
  async () => {
    const tempDirectory = await Deno.makeTempDir({ prefix: 'sound-bundled-types-dir-' });
    const runtimeDirectory = join(tempDirectory, 'runtime', 'src', 'bundled');
    const binaryDirectory = join(tempDirectory, 'repo', 'bin');
    const bundledTypesDirectory = join(
      tempDirectory,
      'repo',
      'src',
      'bundled',
      'typescript',
      'types',
    );

    Deno.mkdirSync(runtimeDirectory, { recursive: true });
    Deno.mkdirSync(binaryDirectory, { recursive: true });
    Deno.mkdirSync(bundledTypesDirectory, { recursive: true });

    const resolved = resolveBundledTypesDirectory({
      importMetaUrl: `file://${join(runtimeDirectory, 'sound_stdlib.ts')}`,
      execPath: join(binaryDirectory, 'soundscript'),
    });

    assertEquals(resolved, bundledTypesDirectory);
  },
);
