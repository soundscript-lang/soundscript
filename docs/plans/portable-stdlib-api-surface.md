# Portable Stdlib API Surface Plan

## Goal

Define the first implementable portable standard-library surface for Soundscript across:

- `js-browser`
- `js-node`
- `wasm-browser`
- `wasm-node`
- `wasm-wasi`
- future native/LLVM standalone

This plan is the API catalog companion to:

- `docs/plans/runtime-target-platform-and-interop.md` for targets, providers, and host boundaries
- `docs/plans/structured-concurrency-and-parallelism.md` for structured concurrency, parallelism,
  cancellation, runtime setup, `Send`, and `Share`

The goal is not to copy Node, Deno, WASI, or the Web platform wholesale. The goal is a small,
consistent, provider-backed API surface that preserves Web-style familiarity where honest, exposes
target limitations explicitly, and still gives performance-oriented code low-level tools.

## Design Rules

- `sts:*` modules are Soundscript-owned and do not require `// #[interop]`.
- Raw host/app imports remain explicit `// #[interop]` boundaries: `web:*`, `node:*`, `native:*`,
  `extern:*`, and ordinary foreign package imports.
- Web-standard APIs keep Web semantics when they are exposed directly as globals.
- Soundscript-owned async APIs return `AsyncResult<T, E>`, which is `Promise<Result<T, E>>`.
- `Task<T, E>` remains a cold/lazy recipe type, not the default shape for hot IO.
- `Task` should also be a value helper object so users write `Task.succeed(...)`,
  `Task.fromPromise(...)`, `Task.all(...)`, and similar helpers instead of importing a flat bag of
  task functions.
- Expected host errors normalize to `Failure` subclasses or structured `Failure` data at `sts:*`
  boundaries.
- Cancellation uses `AbortSignal` / `AbortController`.
- Stdlib IO should consult `TaskGroup.currentSignal()` when an explicit signal is not passed.
- Resources with lifetimes should implement `Disposable` or `AsyncDisposable`.
- True parallelism crosses `ThreadPool` / `Thread` and requires `Send`.
- Shared mutable state requires explicit `Share`, atomics, channels, mutexes, or provider-declared
  synchronized handles.
- Capability absence should be a checker diagnostic when statically known, or an
  `UnsupportedCapabilityFailure` when a single build can run under multiple provider configurations.

## Capability Names

Capabilities should be named narrowly enough for audits and target diagnostics:

- `platform.url`
- `platform.fetch`
- `platform.streams`
- `platform.text`
- `platform.crypto.random`
- `platform.crypto.subtle`
- `platform.console`
- `time.clock.wall`
- `time.clock.monotonic`
- `time.timer`
- `concurrency.task`
- `concurrency.asyncContext`
- `concurrency.parallel.thread`
- `concurrency.parallel.sharedMemory`
- `concurrency.sync.atomic`
- `concurrency.sync.channel`
- `concurrency.sync.mutex`
- `fs.read`
- `fs.write`
- `fs.metadata`
- `fs.watch`
- `env.read`
- `env.write`
- `cli.args`
- `cli.stdio`
- `process.info`
- `process.cwd`
- `process.signal`
- `process.spawn`
- `net.dns`
- `net.tcp`
- `net.udp`
- `net.tls`
- `net.unix`
- `http.client`
- `http.server`
- `transport.websocket`
- `transport.webtransport`
- `native.system`

The checker and generated wrappers should report these names in diagnostics and provider manifests.

## Common Types

These types are shared across capability modules.

```ts
import type { AsyncResult } from 'sts:concurrency';
import { Failure } from 'sts:failures';

type ResourceId = string;

interface CapabilityInfo {
  readonly name: string;
  readonly available: boolean;
  readonly provider?: string;
  readonly reason?: string;
}

class UnsupportedCapabilityFailure extends Failure {
  readonly capability: string;
}

class PermissionDeniedFailure extends Failure {
  readonly capability?: string;
}

class CancellationFailure extends Failure {}
class DeadlineFailure extends Failure {}
class TimeoutFailure extends Failure {}

interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly deadline?: Instant;
  readonly timeout?: Duration;
}
```

`OperationOptions` is a shape convention, not a required base type for every API. APIs should accept
only the options they actually support.

## Prelude And Globals

Keep the checked `.sts` prelude small. It should remain focused on core language ergonomics:

- `Result`, `Option`, `Ok`, `Err`, `Some`, `None`
- `ok`, `err`, `some`, `none`
- `isOk`, `isErr`, `isSome`, `isNone`
- `Try`, `Match`, `where`
- `Failure`
- `Defer`, `todo`, `unreachable`

Web-style platform values are target-provided globals rather than prelude re-exports. They are
available when the active target/provider supports them:

- `URL`
- `URLSearchParams`
- `fetch`
- `Request`
- `Response`
- `Headers`
- `ReadableStream`
- `WritableStream`
- `TransformStream`
- `TextEncoder`
- `TextDecoder`
- `AbortSignal`
- `AbortController`
- `Blob`
- `File`
- `FormData`
- `Event`
- `EventTarget`
- `crypto`
- `structuredClone`
- `console`

`setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `queueMicrotask`, `performance`,
`WebSocket`, and `WebTransport` are also Web-style platform values where available, but portable
Soundscript code should prefer `sts:time`, `sts:concurrency`, and focused transport modules for
owned semantics.

## Pure Language Modules

These modules are already in the stable core shape and should stay portable with no provider:

- `sts:prelude`
- `sts:result`
- `sts:match`
- `sts:failures`
- `sts:json`
- `sts:decode`
- `sts:encode`
- `sts:codec`
- `sts:compare`
- `sts:hash`
- `sts:derive`
- `sts:hkt`
- `sts:typeclasses`

Additional foundational modules that belong in this plan:

- `sts:path`
- `sts:bytes`

## Submodule Policy

Use root modules as the normal teaching path and submodules for lower-level, capability-gated,
provider-heavy, or large optional surfaces.

The preferred pattern is:

- root module: common re-export and beginner-facing imports
- submodule: focused ownership for a coherent optional slice
- no `advanced` submodule names; name the thing being controlled

Apply this first to concurrency:

- `sts:concurrency`
- `sts:concurrency/task`
- `sts:concurrency/parallel`
- `sts:concurrency/sync`
- `sts:concurrency/atomics`
- `sts:concurrency/runtime`

Apply it selectively elsewhere:

- `sts:net/tcp`
- `sts:net/udp`
- `sts:net/dns`
- `sts:net/tls`
- `sts:net/unix`
- `sts:crypto/digest`
- `sts:crypto/hmac`
- `sts:crypto/keys`
- `sts:process/command`
- `sts:process/signals`
- `sts:bytes/transfer`
- `sts:bytes/shared`

Do not create submodules only for symmetry. `sts:console`, `sts:time`, `sts:path`, `sts:fetch`,
`sts:streams`, and `sts:fs` should stay simple at the root until their surfaces become large enough
to justify a split.

## `sts:capabilities`

Capability queries are useful for diagnostics, optional features, and test skips. They should not be
used to hide semantically different behavior behind the same API call.

```ts
export type CapabilityName = string;

export interface CapabilityInfo {
  readonly name: CapabilityName;
  readonly available: boolean;
  readonly provider?: string;
  readonly reason?: string;
}

export function list(): readonly CapabilityInfo[];
export function get(name: CapabilityName): Option<CapabilityInfo>;
export function has(name: CapabilityName): boolean;
export function require(name: CapabilityName): Result<void, UnsupportedCapabilityFailure>;
```

The checker should still reject statically unavailable APIs when the target profile proves they
cannot exist. Runtime capability queries are for provider-dependent profiles and libraries that can
honestly offer optional behavior.

## `sts:url`

`URL` and `URLSearchParams` are Web-standard globals where available. `sts:url` is the explicit
portable import surface and the place for small result-oriented helpers.

```ts
export { URL, URLSearchParams };

export function parseUrl(input: string, base?: string | URL): Result<URL, Failure>;
export function canParseUrl(input: string, base?: string | URL): boolean;
export function fileUrlToPath(url: URL): Result<string, Failure>;
export function pathToFileUrl(path: string): Result<URL, Failure>;
```

`fileUrlToPath` and `pathToFileUrl` are target-aware because path interpretation is provider
specific. Pure path manipulation belongs in `sts:path`.

## `sts:fetch`

The global `fetch` keeps ordinary Web semantics. `sts:fetch` should expose the same Web classes and
also provide result-oriented helpers for Soundscript-owned code.

```ts
export { fetch, Headers, Request, Response };

export type FetchFailure = Failure;

export function request(
  input: RequestInfo,
  init?: RequestInit,
): AsyncResult<Response, FetchFailure>;

export function readJson<T>(
  response: Response,
  decoder: Decoder<T>,
  options?: OperationOptions,
): AsyncResult<T, Failure>;

export function readText(
  response: Response,
  options?: OperationOptions,
): AsyncResult<string, Failure>;

export function readBytes(
  response: Response,
  options?: OperationOptions,
): AsyncResult<Bytes, Failure>;
```

`request(...)` normalizes thrown/rejected host errors to `Failure`. The global `fetch(...)` remains
available for code that wants exact Web behavior.

## `sts:concurrency/task`

`sts:concurrency/task` replaces the current `sts:async` plan. This is an intentional breaking pre-v1
cleanup: the async/concurrency surface should have one conceptual home, and task helpers should live
under a `Task.*` value object rather than as bare module-level functions.

```ts
import type { Result } from 'sts:result';

export type Task<T, E = Failure> = () => AsyncResult<T, E>;

export namespace Task {
  export type AllResult<T> = {
    readonly [K in keyof T]: T[K] extends Task<infer V, unknown> ? V : never;
  };

  export function succeed<T>(value: T): Task<T, never>;
  export function fail<E>(error: E): Task<never, E>;
  export function fromResult<T, E>(result: Result<T, E>): Task<T, E>;
  export function fromAsyncResult<T, E>(work: () => AsyncResult<T, E>): Task<T, E>;
  export function fromPromise<T>(
    body: () => Promise<T>,
    mapFailure?: (error: unknown) => Failure,
  ): Task<T, Failure>;

  export function map<A, B, E>(task: Task<A, E>, fn: (value: A) => B): Task<B, E>;
  export function flatMap<A, B, E1, E2>(
    task: Task<A, E1>,
    fn: (value: A) => Task<B, E2>,
  ): Task<B, E1 | E2>;
  export function recover<A, B, E>(
    task: Task<A, E>,
    fn: (error: E) => B | AsyncResult<B, Failure>,
  ): Task<A | B, Failure>;

  export function all<T extends Record<string, Task<unknown, E>>, E>(
    tasks: T,
  ): Task<AllResult<T>, E>;
  export function race<T, E>(tasks: readonly [Task<T, E>, ...Task<T, E>[]]): Task<T, E>;
  export function timeout<T, E>(
    task: Task<T, E>,
    duration: Duration,
  ): Task<T, E | TimeoutFailure>;
}
```

Migration note: remove the current top-level `sts:async.parallel(...)` helper before this surface
stabilizes. Promise fanout is `Task.all(...)`; true parallelism is `ThreadPool`.

## `sts:concurrency`

The detailed API lives in `docs/plans/structured-concurrency-and-parallelism.md`. This module is
included here so the full stdlib catalog has one entry point. It should re-export the normal
teaching surface from the submodules.

```ts
export { Task } from 'sts:concurrency/task';
export { Runtime } from 'sts:concurrency/runtime';

export type AsyncResult<T, E = Failure> = Promise<Result<T, E>>;

export class TaskGroup<E = Failure> implements AsyncDisposable {
  readonly signal: AbortSignal;
  static open<E = Failure>(policy?: TaskGroupPolicy): TaskGroup<E>;
  static currentSignal(): AbortSignal;
  fork<T>(body: () => AsyncResult<T, E>, options?: { name?: string }): TaskHandle<T, E>;
  all<T extends Record<string, () => AsyncResult<unknown, E>>>(
    tasks: T,
  ): AsyncResult<TaskGroup.AllResult<T>, E>;
  race<T>(tasks: Iterable<() => AsyncResult<T, E>>): AsyncResult<T, E>;
  firstOk<T>(tasks: Iterable<() => AsyncResult<T, E>>): AsyncResult<T, E>;
}

export class TaskHandle<T, E = Failure> {
  join(): AsyncResult<T, E>;
  cancel(reason?: Failure): void;
}

export class ThreadPool implements AsyncDisposable {
  static get default(): ThreadPool;
  static fixed(options: ThreadPoolOptions): ThreadPool;
  run<I, O, E = Failure>(
    entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    input: Send<I>,
    options?: { name?: string },
  ): AsyncResult<Send<O>, E>;
  map<I, O, E = Failure>(
    entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    inputs: readonly Send<I>[],
    options?: { name?: string },
  ): AsyncResult<Send<O>[], E>;
}

export class Thread<I, O, E = Failure> {
  static spawn<I, O, E = Failure>(
    entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    input: Send<I>,
    options?: ThreadOptions,
  ): Thread<Send<I>, Send<O>, E>;
  join(): AsyncResult<Send<O>, E>;
  cancel(reason?: Failure): void;
  static blockOn<T, E = Failure>(work: () => AsyncResult<T, E>): Result<T, E>;
}

export namespace AsyncContext {
  export class Variable<T> {
    constructor(options?: { name?: string; defaultValue?: T });
    get(): T | undefined;
    run<R>(value: T, body: () => R): R;
  }

  export class Snapshot {
    constructor();
    run<R>(body: () => R): R;
    static wrap<F extends (...args: unknown[]) => unknown>(fn: F): F;
  }
}

export type Send<T> = T;
export type Share<T> = T;
```

`TaskGroup` stays on the root module because it is the structured-concurrency primitive users should
reach for first. `ThreadPool`, `Thread`, `Send`, and `Share` are re-exported from the root for
discoverability, but runtime support is capability-gated.

## `sts:concurrency/parallel`

`sts:concurrency/parallel` owns true parallel execution and sendability rules.

```ts
export type Send<T> = T;
export type Share<T> = T;

export type ThreadEntry<I, O, E = Failure> = (input: I) => Result<O, E> | AsyncResult<O, E>;

export class ThreadPool implements AsyncDisposable {
  static get default(): ThreadPool;
  static fixed(options: ThreadPoolOptions): ThreadPool;
  run<I, O, E = Failure>(
    entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    input: Send<I>,
    options?: { name?: string },
  ): AsyncResult<Send<O>, E>;
  map<I, O, E = Failure>(
    entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    inputs: readonly Send<I>[],
    options?: { name?: string },
  ): AsyncResult<Send<O>[], E>;
}

export class Thread<I, O, E = Failure> {
  static spawn<I, O, E = Failure>(
    entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    input: Send<I>,
    options?: ThreadOptions,
  ): Thread<Send<I>, Send<O>, E>;
  join(): AsyncResult<Send<O>, E>;
  cancel(reason?: Failure): void;
  static blockOn<T, E = Failure>(work: () => AsyncResult<T, E>): Result<T, E>;
}
```

## `sts:concurrency/runtime`

Runtime/provider override surface:

```ts
export interface RuntimeOptions {
  readonly threadPool?: ThreadPool;
  readonly deadline?: Instant | Duration;
  readonly signal?: AbortSignal;
  readonly scheduler?: SchedulerPolicy;
  readonly tracing?: TracingHooks;
  readonly providers?: ProviderOverrides;
}

export namespace Runtime {
  export function with<T, E = Failure>(
    options: RuntimeOptions,
    body: () => AsyncResult<T, E>,
  ): AsyncResult<T, E>;

  export function capabilities(): readonly CapabilityInfo[];
  export function hasCapability(name: string): boolean;
  export function requireCapability(name: string): Result<void, UnsupportedCapabilityFailure>;
}
```

Normal applications should configure providers at the launcher/adapter boundary instead of calling
`Runtime.with(...)` at every use site.

## `sts:time`

Portable time should distinguish wall clock, monotonic clock, and timers.

```ts
export class Duration {
  static milliseconds(value: number): Duration;
  static seconds(value: number): Duration;
  static minutes(value: number): Duration;
  static nanoseconds(value: bigint): Duration;
  readonly milliseconds: number;
  readonly nanoseconds: bigint;
}

export class Instant {
  durationSince(other: Instant): Duration;
  add(duration: Duration): Instant;
  subtract(duration: Duration): Instant;
}

export class WallDateTime {
  static now(): Result<WallDateTime, Failure>;
  toIsoString(): string;
}

export namespace monotonic {
  export function now(): Result<Instant, Failure>;
}

export namespace wall {
  export function now(): Result<WallDateTime, Failure>;
}

export function sleep(duration: Duration, options?: OperationOptions): AsyncResult<void, Failure>;
export function deadline(
  at: Instant,
  options?: { signal?: AbortSignal },
): AsyncResult<void, DeadlineFailure | CancellationFailure>;
export function timeoutSignal(duration: Duration): AbortSignal;
```

`Date` may remain available as a JS/Web global where supported, but portable runtime scheduling
should use `Instant`/`Duration`.

## `sts:console`

`console` is a Web-style global. `sts:console` is the explicit importable portable surface and the
hook point for runtimes that do not expose a real host console.

```ts
export type ConsoleValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | JsonValue
  | Error
  | Failure;

export interface Console {
  debug(...values: readonly ConsoleValue[]): void;
  info(...values: readonly ConsoleValue[]): void;
  log(...values: readonly ConsoleValue[]): void;
  warn(...values: readonly ConsoleValue[]): void;
  error(...values: readonly ConsoleValue[]): void;
  trace(...values: readonly ConsoleValue[]): void;
  group(label?: string): void;
  groupEnd(): void;
  time(label?: string): void;
  timeEnd(label?: string): void;
}

export const console: Console;
export const debug: Console['debug'];
export const info: Console['info'];
export const log: Console['log'];
export const warn: Console['warn'];
export const error: Console['error'];
```

This is diagnostic output, not structured application logging. A future `sts:log` can provide
records, sinks, levels, redaction, and trace-context integration.

## `sts:streams`

The global stream classes should follow Web Streams where available. `sts:streams` owns helpers and
portable failure/cancellation behavior.

```ts
export type ByteStream = ReadableStream<Uint8Array<ArrayBufferLike>>;

export interface PipeOptions extends OperationOptions {
  readonly preventClose?: boolean;
  readonly preventAbort?: boolean;
  readonly preventCancel?: boolean;
}

export function readAllBytes(
  stream: ByteStream,
  options?: OperationOptions,
): AsyncResult<Bytes, Failure>;
export function readAllText(
  stream: ByteStream,
  options?: OperationOptions & { encoding?: string },
): AsyncResult<string, Failure>;
export function writeAllBytes(
  stream: WritableStream<Uint8Array<ArrayBufferLike>>,
  bytes: Bytes | ByteView,
  options?: OperationOptions,
): AsyncResult<void, Failure>;
export function pipe(
  source: ReadableStream<unknown>,
  sink: WritableStream<unknown>,
  options?: PipeOptions,
): AsyncResult<void, Failure>;
export function fromBytes(bytes: Bytes | ByteView): ByteStream;
export function fromIterable<T>(values: Iterable<T>): ReadableStream<T>;
```

Async iteration helpers should wait for the async-iteration runtime slice before becoming stable.

## `sts:bytes`

The bytes module is the common low-level data API for IO, crypto, networking, workers, and Wasm.

```ts
export interface ByteView {
  readonly byteLength: number;
  slice(start?: number, end?: number): Bytes;
  copyTo(target: MutableBytes, targetOffset?: number): Result<void, Failure>;
}

export interface Bytes extends ByteView {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
}

export interface MutableBytes extends ByteView {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  set(index: number, value: number): Result<void, Failure>;
  fill(value: number, start?: number, end?: number): Result<void, Failure>;
  freeze(): Bytes;
}

export interface TransferBuffer {
  readonly byteLength: number;
  transfer(): Send<Bytes>;
}

export interface SharedBytes extends Share<ByteView> {
  readonly byteLength: number;
}

export function alloc(length: number): Result<MutableBytes, Failure>;
export function copy(bytes: ByteView): Result<MutableBytes, Failure>;
export function fromUint8Array(bytes: Uint8Array<ArrayBufferLike>): Bytes;
export function toUint8Array(bytes: ByteView): Uint8Array<ArrayBufferLike>;
export function concat(chunks: readonly ByteView[]): Result<Bytes, Failure>;
```

The checker should treat ordinary `Uint8Array` as mutable and not deeply immutable. Sendability of
buffers depends on copy, transfer, or shared-buffer rules.

## `sts:text`

Text encoding remains Web-compatible but should expose explicit result helpers.

```ts
export function encodeUtf8(text: string): Result<Bytes, Failure>;
export function decodeUtf8(bytes: ByteView, options?: { fatal?: boolean }): Result<string, Failure>;

export { TextDecoder, TextEncoder };
```

## `sts:random`

`sts:random` is cryptographic random by default. Deterministic PRNGs should live in a separate
testing or simulation module later.

```ts
export function randomBytes(length: number): Result<Bytes, Failure>;
export function fillRandom(bytes: MutableBytes): Result<void, Failure>;
export function uuidV4(): Result<string, Failure>;
```

## `sts:crypto`

`crypto.getRandomValues` is already covered by `sts:random`. A broader crypto module should follow
Web Crypto shapes where possible, but it can be phased after IO/concurrency:

```ts
export namespace digest {
  export function sha256(bytes: ByteView): AsyncResult<Bytes, Failure>;
  export function sha384(bytes: ByteView): AsyncResult<Bytes, Failure>;
  export function sha512(bytes: ByteView): AsyncResult<Bytes, Failure>;
}
```

Subtle crypto should stay compatible with Web Crypto where supported. Provider-backed native/WASI
implementations must match semantics before exposing the same names.

## `sts:path`

Path manipulation is pure. Filesystem access is not.

```ts
export type PathStyle = 'posix' | 'windows';

export interface ParsedPath {
  readonly root: string;
  readonly dir: string;
  readonly base: string;
  readonly ext: string;
  readonly name: string;
}

export interface PathApi {
  join(...segments: readonly string[]): string;
  normalize(path: string): string;
  dirname(path: string): string;
  basename(path: string, suffix?: string): string;
  extname(path: string): string;
  parse(path: string): ParsedPath;
  format(path: ParsedPath): string;
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
}

export const posix: PathApi;
export const windows: PathApi;
```

Avoid a magical `native` path namespace in portable code. APIs that need provider-native paths
should accept strings and define whether they are interpreted by the active provider.

## `sts:fs`

Filesystem APIs are provider-backed and unavailable in browser-family targets unless a provider can
honestly implement the semantics.

```ts
export type PathLike = string | URL;

export interface FileInfo {
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: bigint;
  readonly modifiedAt?: WallDateTime;
  readonly accessedAt?: WallDateTime;
  readonly createdAt?: WallDateTime;
  readonly readonly?: boolean;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly type: FileInfo['type'];
}

export interface ReadFileOptions extends OperationOptions {}
export interface WriteFileOptions extends OperationOptions {
  readonly create?: boolean;
  readonly append?: boolean;
  readonly truncate?: boolean;
  readonly mode?: number;
}

export function readFile(path: PathLike, options?: ReadFileOptions): AsyncResult<Bytes, Failure>;
export function readTextFile(
  path: PathLike,
  options?: ReadFileOptions & { encoding?: string },
): AsyncResult<string, Failure>;
export function writeFile(
  path: PathLike,
  bytes: ByteView,
  options?: WriteFileOptions,
): AsyncResult<void, Failure>;
export function writeTextFile(
  path: PathLike,
  text: string,
  options?: WriteFileOptions & { encoding?: string },
): AsyncResult<void, Failure>;

export function stat(path: PathLike, options?: OperationOptions): AsyncResult<FileInfo, Failure>;
export function lstat(path: PathLike, options?: OperationOptions): AsyncResult<FileInfo, Failure>;
export function readDir(
  path: PathLike,
  options?: OperationOptions,
): AsyncResult<readonly DirectoryEntry[], Failure>;
export function mkdir(
  path: PathLike,
  options?: OperationOptions & { recursive?: boolean; mode?: number },
): AsyncResult<void, Failure>;
export function remove(
  path: PathLike,
  options?: OperationOptions & { recursive?: boolean },
): AsyncResult<void, Failure>;
export function rename(
  oldPath: PathLike,
  newPath: PathLike,
  options?: OperationOptions,
): AsyncResult<void, Failure>;
export function copyFile(
  from: PathLike,
  to: PathLike,
  options?: OperationOptions,
): AsyncResult<void, Failure>;
export function realPath(path: PathLike, options?: OperationOptions): AsyncResult<string, Failure>;
```

Lower-level streaming file handles should be the second slice:

```ts
export class File implements AsyncDisposable {
  readonly readable: ReadableStream<Uint8Array<ArrayBufferLike>>;
  readonly writable: WritableStream<Uint8Array<ArrayBufferLike>>;
  stat(options?: OperationOptions): AsyncResult<FileInfo, Failure>;
  sync(options?: OperationOptions): AsyncResult<void, Failure>;
}

export function open(path: PathLike, options?: OpenOptions): AsyncResult<File, Failure>;
```

File watching is useful but should be deferred until provider semantics are clearer:

```ts
export function watch(path: PathLike, options?: WatchOptions): AsyncResult<WatchHandle, Failure>;
```

## `sts:env`

Environment access is separate from process and CLI.

```ts
export function get(name: string): Result<Option<string>, Failure>;
export function required(name: string): Result<string, Failure>;
export function has(name: string): Result<boolean, Failure>;
export function toRecord(): Result<Readonly<Record<string, string>>, Failure>;

export function set(name: string, value: string): Result<void, Failure>;
export function remove(name: string): Result<void, Failure>;
```

`set` and `remove` require `env.write`; most browser-family targets should reject them.

## `sts:cli`

CLI APIs are for command-line entrypoints and terminal IO. They should not own child-process
creation; that belongs to `sts:process`.

```ts
export function args(): Result<readonly string[], Failure>;

export interface Stdio {
  readonly stdin: ReadableStream<Uint8Array<ArrayBufferLike>>;
  readonly stdout: WritableStream<Uint8Array<ArrayBufferLike>>;
  readonly stderr: WritableStream<Uint8Array<ArrayBufferLike>>;
}

export function stdio(): Result<Stdio, Failure>;
export function isTerminal(stream: 'stdin' | 'stdout' | 'stderr'): Result<boolean, Failure>;
export function terminalSize(): Result<Option<{ columns: number; rows: number }>, Failure>;

export function readLine(
  options?: OperationOptions & { prompt?: string },
): AsyncResult<string, Failure>;
export function write(
  text: string,
  options?: { stream?: 'stdout' | 'stderr' },
): AsyncResult<void, Failure>;
export function writeLine(
  text: string,
  options?: { stream?: 'stdout' | 'stderr' },
): AsyncResult<void, Failure>;
```

## `sts:process`

Process APIs are provider-backed and usually server/native only.

```ts
export interface ProcessInfo {
  readonly pid?: number;
  readonly ppid?: number;
  readonly executable?: string;
  readonly platform?: string;
  readonly arch?: string;
}

export function info(): Result<ProcessInfo, Failure>;
export function cwd(): Result<string, Failure>;
export function chdir(path: string): Result<void, Failure>;
export function exit(code?: number): never;

export type SignalName =
  | 'SIGINT'
  | 'SIGTERM'
  | 'SIGHUP'
  | 'SIGQUIT'
  | 'SIGKILL';

export function onSignal(
  signal: SignalName,
  handler: () => void,
): Result<Disposable, Failure>;
```

Child processes:

```ts
export interface CommandOptions {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: 'inherit' | 'null' | 'piped';
  readonly stdout?: 'inherit' | 'null' | 'piped';
  readonly stderr?: 'inherit' | 'null' | 'piped';
  readonly signal?: AbortSignal;
}

export interface CommandOutput {
  readonly code: number;
  readonly success: boolean;
  readonly stdout: Bytes;
  readonly stderr: Bytes;
}

export class Child implements AsyncDisposable {
  readonly pid?: number;
  readonly stdin?: WritableStream<Uint8Array<ArrayBufferLike>>;
  readonly stdout?: ReadableStream<Uint8Array<ArrayBufferLike>>;
  readonly stderr?: ReadableStream<Uint8Array<ArrayBufferLike>>;
  status(): AsyncResult<{ code: number; success: boolean }, Failure>;
  kill(signal?: SignalName): Result<void, Failure>;
}

export function spawn(command: string, options?: CommandOptions): AsyncResult<Child, Failure>;
export function output(
  command: string,
  options?: CommandOptions,
): AsyncResult<CommandOutput, Failure>;
```

## `sts:net`

Raw networking is not a browser capability. Browser networking should use `fetch`, `WebSocket`, and
`WebTransport` where available.

```ts
export type IpAddress = string;

export interface SocketAddress {
  readonly hostname: string;
  readonly port: number;
}

export interface TcpConnectOptions extends OperationOptions {
  readonly hostname: string;
  readonly port: number;
  readonly nodelay?: boolean;
  readonly keepAlive?: boolean;
}

export class TcpStream implements AsyncDisposable {
  readonly readable: ReadableStream<Uint8Array<ArrayBufferLike>>;
  readonly writable: WritableStream<Uint8Array<ArrayBufferLike>>;
  readonly localAddress: SocketAddress;
  readonly remoteAddress: SocketAddress;
  close(): AsyncResult<void, Failure>;
}

export function connectTcp(options: TcpConnectOptions): AsyncResult<TcpStream, Failure>;

export interface TcpListenOptions {
  readonly hostname?: string;
  readonly port: number;
  readonly backlog?: number;
  readonly signal?: AbortSignal;
}

export class TcpListener implements AsyncDisposable {
  readonly address: SocketAddress;
  accept(options?: OperationOptions): AsyncResult<TcpStream, Failure>;
  close(): AsyncResult<void, Failure>;
}

export function listenTcp(options: TcpListenOptions): AsyncResult<TcpListener, Failure>;
```

UDP and DNS:

```ts
export class UdpSocket implements AsyncDisposable {
  readonly address: SocketAddress;
  receive(options?: OperationOptions): AsyncResult<{ data: Bytes; from: SocketAddress }, Failure>;
  send(data: ByteView, to: SocketAddress, options?: OperationOptions): AsyncResult<number, Failure>;
  close(): AsyncResult<void, Failure>;
}

export function bindUdp(
  options: { hostname?: string; port: number },
): AsyncResult<UdpSocket, Failure>;
export function lookupHost(
  hostname: string,
  options?: OperationOptions,
): AsyncResult<readonly IpAddress[], Failure>;
```

TLS should either be a submodule or a separate module once certificate and trust-store semantics are
clear:

```ts
export function connectTls(options: TlsConnectOptions): AsyncResult<TcpStream, Failure>;
export function startTls(stream: TcpStream, options: TlsOptions): AsyncResult<TcpStream, Failure>;
```

Unix domain sockets are `net.unix` and target-gated.

## `sts:http`

`fetch` is the portable HTTP client baseline. `sts:http` owns server APIs and advanced provider
integration. It should use Web `Request` / `Response` objects where practical.

```ts
export type Handler = (request: Request) => Response | AsyncResult<Response, Failure>;

export interface ServeOptions {
  readonly hostname?: string;
  readonly port: number;
  readonly signal?: AbortSignal;
  readonly name?: string;
}

export class Server implements AsyncDisposable {
  readonly address: SocketAddress;
  serve(): AsyncResult<void, Failure>;
  close(): AsyncResult<void, Failure>;
}

export function server(options: ServeOptions & { handle: Handler }): Result<Server, Failure>;
export function serve(options: ServeOptions & { handle: Handler }): AsyncResult<void, Failure>;
```

Advanced server options can be added after the first slice:

- TLS
- HTTP/2
- WebSocket upgrade
- handler execution through `ThreadPool`
- connection limits
- request body size limits
- graceful shutdown deadlines

## `sts:transport`

This module should be deferred until `fetch`, streams, networking, and concurrency settle.

The intended role is a portable message/datagram transport abstraction over providers such as:

- WebSocket
- WebTransport
- Node sockets
- WASI sockets
- native sockets

Sketch:

```ts
export class MessageTransport implements AsyncDisposable {
  readonly incoming: ReadableStream<Bytes>;
  readonly outgoing: WritableStream<ByteView>;
  close(): AsyncResult<void, Failure>;
}

export class DatagramTransport implements AsyncDisposable {
  receive(options?: OperationOptions): AsyncResult<Bytes, Failure>;
  send(bytes: ByteView, options?: OperationOptions): AsyncResult<void, Failure>;
}
```

Do not model WebTransport as generic TCP or UDP. It can be a provider for transport shapes that
match its actual stream/datagram semantics.

## `sts:concurrency/sync`

Synchronization APIs are for true parallelism and resource coordination. They should be pay-for-play
and capability-gated.

```ts
export class Mutex<T> implements Share<Mutex<T>> {
  static create<T>(value: Send<T>): Result<Mutex<T>, Failure>;
  withLock<R, E = Failure>(
    body: (value: T) => Result<R, E> | AsyncResult<R, E>,
    options?: OperationOptions,
  ): AsyncResult<R, E | Failure>;
}

export class Semaphore implements Share<Semaphore> {
  static create(permits: number): Result<Semaphore, Failure>;
  acquire(options?: OperationOptions): AsyncResult<Permit, Failure>;
}

export class Permit implements AsyncDisposable {
  release(): void;
}

export class Channel<T> implements Share<Channel<T>> {
  static bounded<T>(capacity: number): Result<Channel<T>, Failure>;
  static unbounded<T>(): Result<Channel<T>, Failure>;
  send(value: Send<T>, options?: OperationOptions): AsyncResult<void, Failure>;
  receive(options?: OperationOptions): AsyncResult<Option<Send<T>>, Failure>;
  close(): void;
}
```

Channels are both a concurrency primitive and a low-level runtime feature. They should not be
required for ordinary request fanout; use `TaskGroup` first.

## `sts:concurrency/atomics`

Atomic and shared-memory APIs should be explicit and low-level.

```ts
export class SharedArray<T extends AtomicElement> implements Share<SharedArray<T>> {
  readonly length: number;
  load(index: number): T;
  store(index: number, value: T): void;
  add(index: number, value: T): T;
  compareExchange(index: number, expected: T, replacement: T): T;
}

export namespace SharedArray {
  export function i32(length: number): Result<SharedArray<i32>, Failure>;
  export function u32(length: number): Result<SharedArray<u32>, Failure>;
  export function i64(length: number): Result<SharedArray<i64>, Failure>;
  export function u64(length: number): Result<SharedArray<u64>, Failure>;
}
```

Blocking atomic waits are target-gated. Browser main-thread waits must be unavailable.

## `native:*`

Native OS APIs are not part of `sts:*` by default. They are raw interop:

```ts
// #[interop]
import { mmap } from 'native:posix/memory';
```

Use `native:*` when:

- the API is inherently OS-specific
- the type surface cannot be made portable without lying
- the caller accepts platform-specific build constraints
- the operation needs lower-level access than an `sts:*` provider exposes

If a native API proves broadly useful and portable enough, wrap it later behind an `sts:*` provider
module.

## Target Support Matrix

Legend:

- `yes`: expected portable support
- `provider`: support depends on configured host/provider capability
- `partial`: useful subset only
- `no`: not part of that target profile
- `later`: intentionally deferred

| Surface               | js-browser | js-node  | wasm-browser | wasm-node | wasm-wasi | native |
| --------------------- | ---------- | -------- | ------------ | --------- | --------- | ------ |
| core pure modules     | yes        | yes      | yes          | yes       | yes       | yes    |
| capabilities query    | yes        | yes      | yes          | yes       | yes       | yes    |
| path/bytes            | yes        | yes      | yes          | yes       | yes       | yes    |
| Web URL/text          | yes        | yes      | yes          | yes       | provider  | yes    |
| fetch/client HTTP     | yes        | yes      | provider     | provider  | provider  | yes    |
| streams               | yes        | yes      | provider     | provider  | provider  | yes    |
| console               | yes        | yes      | provider     | provider  | provider  | yes    |
| crypto random/hash    | yes        | yes      | provider     | provider  | provider  | yes    |
| time clocks/timers    | yes        | yes      | provider     | provider  | provider  | yes    |
| TaskGroup/AsyncResult | yes        | yes      | yes          | yes       | yes       | yes    |
| ThreadPool/Thread     | provider   | provider | provider     | provider  | provider  | yes    |
| shared memory/atomics | provider   | yes      | provider     | yes       | provider  | yes    |
| fs                    | no         | yes      | provider     | yes       | provider  | yes    |
| env read              | no         | yes      | provider     | yes       | provider  | yes    |
| env write             | no         | provider | no           | provider  | provider  | yes    |
| cli stdio/args        | no         | yes      | no           | yes       | provider  | yes    |
| process info/cwd      | no         | yes      | no           | yes       | provider  | yes    |
| child process         | no         | yes      | no           | yes       | no        | yes    |
| raw TCP/UDP           | no         | yes      | no           | yes       | provider  | yes    |
| HTTP server           | no         | yes      | no           | yes       | provider  | yes    |
| WebSocket             | yes        | provider | provider     | provider  | no        | later  |
| WebTransport          | provider   | no       | provider     | no        | no        | later  |
| raw `web:*`           | yes        | no       | yes          | no        | no        | no     |
| raw `node:*`          | no         | yes      | no           | yes       | no        | no     |
| raw `native:*`        | no         | no       | no           | no        | no        | yes    |
| raw `extern:*`        | yes        | yes      | yes          | yes       | no        | later  |

## Implementation Slices

### Slice 1: Docs And Type Shape

- Add this plan and link it from the plans index.
- Update `docs/reference/builtin-modules.md` with planned modules.
- Replace `sts:async` with `sts:concurrency/task`.
- Remove ambiguous `sts:async.parallel`.
- Replace bare task helpers with the `Task.*` value helper surface.
- Add `AsyncResult` and shared `AbortSignal` declarations.
- Add provider capability metadata names.

### Slice 2: Web-Style Portable Baseline

- Harden `sts:url`, `sts:fetch`, `sts:streams`, `sts:text`, `sts:random`, and `sts:console`.
- Make target global injection explicit by profile.
- Normalize `AbortSignal` across modules.
- Add `sts:time` timers and monotonic clock facade.

### Slice 3: Provider Runtime

- Define provider manifest shape.
- Teach checker/package recheck to read target provider capabilities.
- Route provider-backed APIs through JS and Wasm wrappers.
- Add `UnsupportedCapabilityFailure`.

### Slice 4: System Capabilities

- Implement `sts:fs`, `sts:env`, `sts:cli`, and `sts:process` for Node-family targets first.
- Add Wasm-hosted provider shims where semantics are honest.
- Keep browser unsupported diagnostics precise.

### Slice 5: Networking

- Stabilize `sts:http` server shape.
- Add `sts:net` TCP/DNS first.
- Add UDP and TLS after stream/resource semantics settle.
- Keep WebSocket/WebTransport as Web-platform/provider surfaces until `sts:transport` is justified.

### Slice 6: Low-Level Parallelism

- Add `Send`/`Share` checker rules.
- Add transfer/shared byte buffers.
- Add `sts:concurrency/sync` and `sts:concurrency/atomics`.
- Add worker/thread-backed providers and target-gated diagnostics.

## Settled Defaults

- `AbortSignal` / `AbortController` should be Web-compatible globals and re-exported from
  `sts:concurrency`. Do not add `sts:abort` yet.
- `sts:path` should expose explicit `posix` and `windows` APIs. Do not add a magical provider-native
  namespace.
- `fetch` is the v1 portable HTTP client. `sts:http` should own servers, upgrades, and later
  provider-heavy HTTP features.
- `sts:console` should accept `unknown` like JavaScript console and document best-effort diagnostic
  formatting. Structured application logging belongs in a future `sts:log`.
- `sts:crypto` should start with random bytes, digest helpers, and timing-safe equality. Defer broad
  WebCrypto key/subtle APIs.
- `sts:transport` should be deferred. Keep WebSocket/WebTransport as Web platform APIs and raw
  sockets in `sts:net` until a common transport abstraction is justified.
- `Task` helpers should be exposed as `Task.*`. Declaration files can use a type/namespace merge;
  runtime modules can implement that surface with an equivalent value object.
- Keep `sts:capabilities` as the simple public capability-query module. `Runtime.capabilities()` may
  exist as a scoped runtime-context view, but normal code should prefer `sts:capabilities`.
- The first `Send` proof should be conservative: primitives, strings, readonly arrays/tuples/records
  of `Send`, deep `#[value]` classes, frozen `Bytes`, transfer buffers, explicit shared buffers, and
  provider-declared handles only.

## Remaining Questions

- Which `sts:concurrency/*` submodules should ship first versus existing only as re-export paths?
- What is the minimal provider manifest shape needed by the checker without overfitting the first JS
  providers?
