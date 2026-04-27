# Structured Concurrency And Parallelism Plan

## Goal

Define a portable structured concurrency and parallelism model for Soundscript that:

- preserves JavaScript `async`/`await` and `Promise` semantics
- keeps valid Soundscript source valid TypeScript syntax
- uses the compiler-owned promise runtime on WasmGC and future native/LLVM profiles
- uses host promises on JS targets
- gives normal users a small, grokable API surface
- gives advanced users explicit thread and thread-pool control where the target supports it
- makes target limitations explicit instead of silently changing semantics
- stays pay-for-play for programs that do not use async, task groups, threads, or async context

The core design choice is: ordinary asynchronous functions return `Promise<Result<T, E>>`, exposed
as the stdlib alias `AsyncResult<T, E>`. Structured concurrency and true parallelism are explicit
operations layered on that async substrate.

This plan supersedes a `Task.io` / `Task.cpu`-first model. A cold/lazy task abstraction can remain
useful, especially for stdlib internals and higher-level libraries, but it should not be the primary
programming model for application async functions.

## Non-Goals

This plan does not try to make Soundscript Rust, C++, Go, Swift, or Kotlin.

Out of scope for the first stable version:

- new syntax beyond TypeScript syntax, comment pragmas, and existing macros
- arbitrary captured closure migration to another OS thread or worker
- shared mutable object graphs
- implicit CPU parallelism from plain `await`
- pretending browser main-thread blocking is possible
- making every target support every operation
- replacing JavaScript promise semantics with a different source-level async model

When a feature is available on multiple targets, it should have the same source-level semantics. If
a target cannot implement those semantics honestly, the feature should be unavailable or statically
target-gated on that target.

## Prior Art Distilled

The best prior art points in the same direction:

- Java structured concurrency uses scopes and forks, then joins children before the scope exits.
- Python `asyncio.TaskGroup` makes child task ownership explicit and cancels siblings on failure.
- Swift task groups and task trees make structured lifetimes central, while still allowing lower
  level unstructured tasks for advanced cases.
- Kotlin makes the coroutine scope/context ambient, and uses dispatcher/context overrides for
  advanced scheduling control.
- Go shows the performance bar: cheap concurrent work, mature netpolling, and low overhead
  scheduling, but its primitive `go` statement is intentionally less structured.
- TC39 AsyncContext is converging on ambient async-local variables and snapshots for JavaScript.

Soundscript should take the structured ownership model from Java/Python/Swift/Kotlin, the runtime
performance ambition from Go, and the AsyncContext shape from TC39. It should not copy Go's
unstructured goroutine primitive as the primary abstraction.

Reference material:

- [Java JEP 505: Structured Concurrency](https://openjdk.org/jeps/505)
- [Python `asyncio.TaskGroup`](https://docs.python.org/3/library/asyncio-task.html#task-groups)
- [Swift structured concurrency proposal](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0304-structured-concurrency.md)
- [Kotlin `coroutineScope`](https://kotlinlang.org/api/kotlinx.coroutines/kotlinx-coroutines-core/kotlinx.coroutines/coroutine-scope.html)
- [Kotlin coroutine context and dispatchers](https://kotlinlang.org/docs/coroutine-context-and-dispatchers.html)
- [TC39 AsyncContext proposal](https://github.com/tc39/proposal-async-context)
- [DOM `AbortSignal`](https://dom.spec.whatwg.org/#interface-abortsignal)

## V1 Public Surface

Prefer one primary module:

```ts
import {
  AsyncContext,
  type AsyncResult,
  type Send,
  type Share,
  TaskGroup,
  Thread,
  ThreadPool,
} from 'sts:concurrency';
```

`sts:concurrency` is the normal teaching surface. It should re-export from descriptive submodules
instead of creating unrelated top-level modules:

- `sts:concurrency/task`
- `sts:concurrency/parallel`
- `sts:concurrency/sync`
- `sts:concurrency/atomics`
- `sts:concurrency/runtime`

The first public surface should be small:

- `AsyncResult<T, E = Failure>`: alias for `Promise<Result<T, E>>`
- `TaskGroup`: structured child task scope
- `TaskHandle<T, E>`: handle returned by `TaskGroup.fork`
- `ThreadPool`: managed pool for true parallel execution when supported
- `Thread`: lower-level one-off thread API plus native-profile blocking entrypoint
- `AsyncContext`: TC39-shaped async-local variables and snapshots
- `AbortSignal`: standard cancellation carrier used by task groups and stdlib IO
- `Send<T>`: value may cross a thread/worker boundary
- `Share<T>`: value may be safely shared across threads

Avoid separate top-level namespaces like `Async`, `Parallel`, `Cpu`, and `Runtime` in the normal
teaching path. Those names multiply concepts without adding semantic clarity.

Runtime/provider control may still exist, but should be secondary:

```ts
import { Runtime } from 'sts:concurrency/runtime';
```

`Runtime.with(...)` is a specialized scoped override of the ambient runtime configuration: executor,
deadline root, cancellation root, scheduler policy, tracing hooks, provider capabilities, and async
context behavior. Normal applications should not need to call it.

## Core Type Shape

### `AsyncResult`

Application async functions should usually return `AsyncResult<T, E>`.

```ts
type AsyncResult<T, E = Failure> = Promise<Result<T, E>>;
```

Because this is just a promise alias, it works with ordinary TypeScript-compatible `async`
functions:

```ts
async function loadUser(id: UserId): AsyncResult<User, Failure> {
  const response = Try(await http.get(`/users/${id}`));
  return Try(await response.json(UserCodec));
}
```

This is intentionally hot. Calling `loadUser(id)` starts the async operation according to ordinary
promise semantics. `await` still means suspension, not CPU parallelism.

### Cold Tasks

The existing lazy task concept can remain, but should not be the primary app-level async story.

Recommended terminology:

```ts
type Task<T, E = Failure> = () => AsyncResult<T, E>;
```

Keep the name `Task` for the existing lazy stdlib concept. Renaming it to `Deferred` would reduce
one kind of ambiguity but create migration churn and make the stdlib feel less coherent. The
important distinction is:

- `AsyncResult<T, E>` is hot promise-shaped work
- `Task<T, E>` is a cold/lazy recipe for async result work
- `TaskGroup` is a structured owner for child async work

Cold tasks are useful for:

- delayed work recipes
- stdlib combinators
- userspace schedulers
- retry policies
- lazy pipelines

They are not required for ordinary nested domain helpers. Most helpers can simply be `async`
functions returning `AsyncResult`.

### `TaskGroup`

`TaskGroup` is the structured concurrency primitive.

Sketch:

```ts
type TaskGroupPolicy = {
  failure?: 'cancelRest' | 'supervise';
  deadline?: Instant | Duration;
  name?: string;
};

class TaskGroup<E = Failure> implements AsyncDisposable {
  readonly signal: AbortSignal;

  static open<E = Failure>(policy?: TaskGroupPolicy): TaskGroup<E>;
  static currentSignal(): AbortSignal;

  [Symbol.asyncDispose](): Promise<void>;

  fork<T>(
    body: () => AsyncResult<T, E>,
    options?: { name?: string },
  ): TaskHandle<T, E>;

  all<T extends Record<string, () => AsyncResult<unknown, E>>>(
    tasks: T,
  ): AsyncResult<TaskGroup.AllResult<T>, E>;

  race<T>(
    tasks: Iterable<() => AsyncResult<T, E>>,
  ): AsyncResult<T, E>;

  firstOk<T>(
    tasks: Iterable<() => AsyncResult<T, E>>,
  ): AsyncResult<T, E>;
}

class TaskHandle<T, E = Failure> {
  join(): AsyncResult<T, E>;
  cancel(reason?: Failure): void;
}
```

`TaskGroup.open(...)` should always be synchronous. It allocates structured bookkeeping in the
current runtime context; it should not perform target-specific async setup. If no current runtime
context exists, it should fail immediately with a clear `MissingRuntimeContext` defect. Async setup
belongs in explicit resources such as `ThreadPool.fixed(...)`, server startup, or host adapters.

`TaskHandle` should not be thenable in v1. `await handle` would blur the line between a promise and
a structured child handle. Use `await handle.join()`.

Default scope policy should be fail-fast:

| Event                                  | Default behavior                                                   |
| -------------------------------------- | ------------------------------------------------------------------ |
| Child returns `Ok<T>`                  | Store result and continue.                                         |
| Child returns `Err<E>`                 | Cancel unfinished siblings and return the primary failure.         |
| Child rejects or throws unexpectedly   | Normalize or report as a defect, cancel siblings, then exit scope. |
| Parent returns before child completion | Cancel unfinished children and await cleanup before returning.     |
| Parent throws/rejects                  | Cancel unfinished children, await cleanup, then report failure.    |
| Scope deadline fires                   | Cancel unfinished children and return deadline failure.            |
| Explicit child cancellation            | Mark cancelled; report cancellation if joined.                     |
| Supervised child returns `Err`         | Record failure without cancelling siblings.                        |

Cancellation propagates through compiler-owned task records and the group's `AbortSignal`, not by
manually passing a `ctx` parameter through every function. Stdlib IO should consult the current
ambient signal when it starts host work, and user code can access it with
`TaskGroup.currentSignal()` when needed.

`TaskGroup.all(...)` should be the concise common path over `fork`:

```ts
async function loadDashboard(id: UserId): AsyncResult<Dashboard, Failure> {
  await using group = TaskGroup.open<Failure>({ name: 'load-dashboard' });

  const parts = Try(
    await group.all({
      user: () => loadUser(id),
      projects: () => loadProjects(id),
      notifications: () => loadNotifications(id),
    }),
  );

  return ok(new Dashboard(parts.user, parts.projects, parts.notifications));
}
```

`fork` is for dynamic or named work:

```ts
async function loadProjectSummaries(
  ids: readonly ProjectId[],
): AsyncResult<ProjectSummary[], Failure> {
  await using group = TaskGroup.open<Failure>({ name: 'project-summaries' });
  const handles = ids.map((id) =>
    group.fork(() => loadProjectSummary(id), { name: `project:${id}` })
  );

  const summaries: ProjectSummary[] = [];
  for (const handle of handles) {
    summaries.push(Try(await handle.join()));
  }

  return ok(summaries);
}
```

### `ThreadPool`

`ThreadPool` is the explicit true-parallel execution boundary.

Use `ThreadPool.default` when work should run on the managed runtime's default worker pool. Use
`ThreadPool.fixed(...)` when an application owns a dedicated pool.

Sketch:

```ts
type ThreadPoolOptions = {
  workers: number | 'available';
  name?: string;
  queueLimit?: number;
};

class ThreadPool implements AsyncDisposable {
  static get default(): ThreadPool;
  static fixed(options: ThreadPoolOptions): ThreadPool;

  [Symbol.asyncDispose](): Promise<void>;

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

type ThreadEntry<I, O, E = Failure> = (input: I) => Result<O, E> | Promise<Result<O, E>>;
```

Exported declaration shape:

```ts
export class ThreadPool implements AsyncDisposable {
  static get default(): ThreadPool;
  static fixed(options: ThreadPoolOptions): ThreadPool;
}
```

`ThreadPool.default` is an ambient default-pool handle, not a fixed global singleton. Calling
`ThreadPool.default.run(...)` resolves the default pool from the current runtime context at call
time, so `Runtime.with({ threadPool })` can override it inside a dynamic scope without changing code
that uses the normal default. Storing `ThreadPool.default` for later should preserve this ambient
lookup behavior; a manually created pool from `ThreadPool.fixed(...)` is the stable owned value.
Reading `ThreadPool.default` must not start workers. The target runtime initializes the managed pool
only on first work submission, or earlier only when explicit runtime configuration asks for eager
startup.

The spelling is intentionally explicit: it tells the reader this is not ordinary async IO and not
promise fanout. It is sendable work scheduled onto the managed worker pool for the current runtime.

Example:

```ts
export function renderThumbnail(input: ThumbnailJob): Result<Thumbnail, Failure> {
  return image.renderThumbnail(input);
}

async function buildGallery(albumId: AlbumId): AsyncResult<Gallery, Failure> {
  const photos = Try(await photoRepo.list(albumId));
  const jobs = photos.map((photo) => ThumbnailJob.fromPhoto(photo));

  const thumbnails = Try(
    await ThreadPool.default.map(renderThumbnail, jobs, {
      name: 'thumbnail-render',
    }),
  );

  return ok(new Gallery(photos, thumbnails));
}
```

Manual pool:

```ts
async function rebuildImages(images: readonly ImageJob[]): AsyncResult<ImageStats, Failure> {
  await using pool = ThreadPool.fixed({ workers: 8, name: 'image-pool' });
  const results = Try(await pool.map(renderImage, images));
  return ok(ImageStats.from(results));
}
```

This deliberately replaces a vague `Parallel.run(...)` or `cpu.run(...)` spelling with a concrete
statement: run this entrypoint on the default managed thread pool.

### `Thread`

Expose `Thread.spawn` directly as the lower-level primitive.

```ts
class Thread<I, O, E = Failure> {
  static spawn<I, O, E = Failure>(
    entrypoint: ThreadEntry<Send<I>, Send<O>, E>,
    input: Send<I>,
    options?: { name?: string; stackSize?: Bytes },
  ): Thread<Send<I>, Send<O>, E>;

  join(): AsyncResult<Send<O>, E>;
  cancel(reason?: Failure): void;

  static blockOn<T, E = Failure>(work: () => AsyncResult<T, E>): Result<T, E>;

  // Native-profile only. Target-gated.
  blockingJoin(): Result<Send<O>, E>;
}
```

Guidance:

- prefer `TaskGroup` for async fanout
- use `ThreadPool.default.run(...)` for bounded parallel work
- use `Thread.spawn(...)` for one-off dedicated threads with explicit ownership

Dropping a joinable `Thread` without joining, cancelling, or transferring ownership should be a
runtime defect and a checker warning where possible. A detached thread API may exist later, but must
still attach to a supervisor with shutdown and failure policy.

Example:

```ts
export function compactIndex(job: CompactIndexJob): Result<CompactStats, Failure> {
  return index.compact(job);
}

async function startCompaction(job: CompactIndexJob): AsyncResult<CompactStats, Failure> {
  const thread = Thread.spawn(compactIndex, job, { name: 'compact-index' });
  return await thread.join();
}
```

### `Thread.blockOn`

`Thread.blockOn(...)` pauses the current native OS thread until an async computation completes.

```ts
class Thread {
  static blockOn<T, E = Failure>(work: () => AsyncResult<T, E>): Result<T, E>;
}
```

Native CLI example:

```ts
function main(argv: readonly string[]): Result<void, Failure> {
  return Thread.blockOn(() => runCli(argv));
}

async function runCli(argv: readonly string[]): AsyncResult<void, Failure> {
  const config = Try(await readConfig(argv[0]));
  Try(await migrateDatabase(config.database));
  return ok(undefined);
}
```

Semantics:

- supported on native/LLVM standalone profiles
- may be supported on non-main threads in some hosted profiles when the host allows blocking
- unavailable on JS targets and browser main-thread Wasm
- target-gated in the checker, not emulated with a busy wait
- enters or creates the native root runtime before invoking the thunk
- drives or joins that runtime until the returned promise settles
- must not violate promise job ordering within the blocked runtime context

Detection:

- checker rejects `Thread.blockOn(...)` on `js-*`, browser Wasm, and async-only profiles
- effect checker marks it `thread.block`
- checker rejects it inside `async` functions and functions carrying `suspend.await`
- runtime still guards against misuse with a `BlockOnInsideRuntime` defect if it is called from an
  active async task/event-loop context

`Thread.blockOn(...)` is a sync boundary tool. It should not be used inside normal async request
handlers.

### `AsyncContext`

`AsyncContext` should semantically match the TC39 proposal where possible and extend it across
Soundscript-owned thread boundaries.

The purpose is async-local context propagation: request IDs, trace spans, tenant IDs, auth
principals, locale, and similar metadata that should follow logically connected work across `await`,
task-group forks, timers, host callbacks, and worker scheduling. It is not the scheduling model, not
the cancellation model, and not an error propagation mechanism.

Sketch:

```ts
class AsyncContextVariable<T> {
  constructor(options?: { name?: string; defaultValue?: T });
  get(): T | undefined;
  run<R>(value: T, body: () => R): R;
}

class AsyncContextSnapshot {
  constructor();
  run<R>(body: () => R): R;
  static wrap<F extends (...args: any[]) => any>(fn: F): F;
}

const AsyncContext: {
  readonly Variable: typeof AsyncContextVariable;
  readonly Snapshot: typeof AsyncContextSnapshot;
};
```

Rules:

- async functions inherit the current context across `await`
- `TaskGroup.fork` captures context at fork time unless explicitly overridden
- `ThreadPool.run` and `Thread.spawn` capture a snapshot at scheduling time
- context values crossing a real thread/worker boundary must be `Send`
- variables may opt out of cross-thread propagation if they hold target-local resources
- restoration must be dynamic-scope based, not mutable global state

Example:

```ts
const requestId = new AsyncContext.Variable<RequestId>({ name: 'request-id' });

async function handle(req: Request): AsyncResult<Response, Failure> {
  return await requestId.run(req.id, async () => {
    await using group = TaskGroup.open<Failure>({ name: 'request' });

    const parts = Try(
      await group.all({
        account: () => loadAccount(req.accountId),
        limits: () => loadLimits(req.accountId),
      }),
    );

    return ok(render(parts));
  });
}

function logQuery(sql: string): void {
  log.info({ requestId: requestId.get(), sql });
}
```

### AbortSignal Cancellation

Cancellation should use the ecosystem-standard `AbortSignal` / `AbortController` shape rather than a
separate public token type.

The portable stdlib should provide `AbortSignal` / `AbortController` declarations for profiles that
do not include DOM or Node ambient types, but the API shape should remain compatible with the DOM
standard so values can be passed directly to `fetch`, database clients, timers, and other ecosystem
APIs that already understand abort signals.

Sketch:

```ts
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

class TaskGroup<E = Failure> implements AsyncDisposable {
  readonly signal: AbortSignal;
  static currentSignal(): AbortSignal;
}
```

Rules:

- every compiler-owned task record carries an internal abort controller/signal
- `TaskGroup.fork` inherits parent abort state and deadline state
- fail-fast scopes abort unfinished children by aborting their task signal
- stdlib IO reads the ambient abort signal when issuing host operations
- user code can pass `TaskGroup.currentSignal()` into ecosystem APIs that accept `AbortSignal`
- host cancellation is best-effort and cooperative; uncancellable host operations may delay scope
  exit
- CPU work observes cancellation with `TaskGroup.currentSignal().throwIfAborted()` or runtime
  polling points
- thread cancellation is cooperative in v1; forcibly killing threads is not part of the portable
  model
- abort reasons are normalized at Soundscript boundaries into `CancellationFailure` or
  `DeadlineFailure` for `Result`-returning APIs

Example:

```ts
async function getBillingSummary(id: AccountId): AsyncResult<BillingSummary, Failure> {
  const response = Try(
    await fetch(`/accounts/${id}/summary`, {
      signal: TaskGroup.currentSignal(),
    }),
  );

  return Try(await response.json(BillingSummaryCodec));
}
```

This gives the runtime a propagation mechanism without requiring every function signature to carry a
scope or context parameter, while still interoperating with existing JS and Web APIs.

## Runtime Setup

Normal programs should not manually construct an async runtime at every call site.

The host adapter, CLI launcher, test harness, or server adapter should create a managed runtime once
and make it ambient for the program:

```sh
soundscript run server.sts --threads=available --io-concurrency=4096
```

Project config:

```json
{
  "soundscript": {
    "runtime": {
      "threads": "available",
      "ioConcurrency": 4096,
      "defaultTaskDeadlineMs": 30000,
      "taskDebug": true
    }
  }
}
```

The code remains ordinary:

```ts
export async function main(): AsyncResult<void, Failure> {
  const server = Try(await createServer());
  return await server.serve();
}
```

Runtime override:

```ts
import { Runtime } from 'sts:concurrency/runtime';

async function rebuildIndex(): AsyncResult<IndexStats, Failure> {
  return await Runtime.with(
    { threadPool: ThreadPool.fixed({ workers: 16, name: 'index-pool' }) },
    async () => {
      const docs = Try(await loadDocs());
      return await ThreadPool.default.run(indexDocs, docs);
    },
  );
}
```

`Runtime.with(...)` is basically "override the ambient runtime/executor for this dynamic scope." It
is analogous to Kotlin `withContext(...)` or Swift executor preference APIs. It should be documented
as specialized because most applications should configure the runtime at the boundary and then use
`TaskGroup` / `ThreadPool.default` inside the program.

Runtime context rule:

- Soundscript-owned entrypoints install the managed runtime before user code runs.
- `Thread.blockOn(...)` creates or enters a native root runtime while it waits.
- `TaskGroup.open`, `ThreadPool.default`, `Thread.spawn`, and `AsyncContext` require a current
  runtime context.
- If a host calls directly into a library function without entering the Soundscript runtime, runtime
  APIs should fail with a clear `MissingRuntimeContext` defect rather than creating target-specific
  behavior.
- JS wrappers generated for exported async functions should enter the runtime before calling user
  code, so normal JS interop does not require manual runtime construction.

Terminology:

- The runtime substrate is the scheduler, compiler-owned promise records, async frames, host
  completion bridge, and worker completion queue that resume suspended work.
- The runtime provider is the target-specific facade that installs capabilities, default executor
  policy, `TaskGroup`, `AsyncContext`, and worker-pool handles on top of that substrate.
- The thread runtime is a pay-for-play provider component. It is loaded and initialized only when
  code uses `ThreadPool`, `Thread`, shared synchronization, or explicit runtime configuration.

## Full Example: HTTP Server

This example shows nested helpers, structured fanout, normal async IO, and an explicit CPU parallel
boundary.

```ts
import { type AsyncResult, TaskGroup, ThreadPool } from 'sts:concurrency';
import http from 'sts:http';
import db from 'sts:db';

export async function main(): AsyncResult<void, Failure> {
  const pool = Try(
    await db.connect({
      url: env.required('DATABASE_URL'),
      maxConnections: 64,
    }),
  );

  const server = http.server({
    port: 8080,
    handle: (req) => handleRequest(pool, req),
  });

  return await server.serve();
}

async function handleRequest(pool: DbPool, req: Request): AsyncResult<Response, Failure> {
  const accountId = Try(parseAccountId(req.path));

  await using group = TaskGroup.open<Failure>({
    name: 'account-page',
    failure: 'cancelRest',
  });

  const parts = Try(
    await group.all({
      account: () => getAccount(pool, accountId),
      usage: () => getUsage(pool, accountId),
      billing: () => getBillingSummary(accountId),
    }),
  );

  const model = Try(
    await ThreadPool.default.run(buildAccountModel, {
      account: parts.account,
      usage: parts.usage,
      billing: parts.billing,
    }),
  );

  return ok(Response.json(model));
}

async function getAccount(pool: DbPool, id: AccountId): AsyncResult<Account, Failure> {
  const row = Try(await pool.queryOne(AccountRow, 'select * from accounts where id = ?', [id]));
  return Account.fromRow(row);
}

async function getUsage(pool: DbPool, id: AccountId): AsyncResult<Usage, Failure> {
  await using group = TaskGroup.open<Failure>({ name: 'usage' });

  const parts = Try(
    await group.all({
      seats: () => getSeatUsage(pool, id),
      storage: () => getStorageUsage(pool, id),
      api: () => getApiUsage(pool, id),
    }),
  );

  return ok(new Usage(parts.seats, parts.storage, parts.api));
}

async function getBillingSummary(id: AccountId): AsyncResult<BillingSummary, Failure> {
  const response = Try(await billingClient.get(`/accounts/${id}/summary`));
  return Try(await response.json(BillingSummaryCodec));
}

export function buildAccountModel(input: AccountModelInput): Result<AccountModel, Failure> {
  return AccountModel.build(input.account, input.usage, input.billing);
}
```

By default, the HTTP server should use async IO and not move each handler to a worker thread. Moving
every IO-heavy handler to a worker can reduce throughput by adding serialization and thread
scheduling overhead.

If an application really wants handlers to run on a worker pool, the server API can make that
explicit:

```ts
const server = http.server({
  port: 8080,
  handlerPool: ThreadPool.default,
  handle: handleRequestOnWorker,
});

export async function handleRequestOnWorker(
  input: RequestSnapshot,
): AsyncResult<ResponseSnapshot, Failure> {
  return await handleSnapshot(input);
}
```

The worker-handler form requires sendable request/response snapshots. It cannot move arbitrary host
request objects across threads.

## Ergonomic Macros

Macros and comment pragmas can improve ergonomics, but they should validate or generate ordinary
TypeScript-compatible shapes rather than introduce a second async model.

Useful candidates:

```ts
// #[main]
export async function main(): AsyncResult<void, Failure> {
  return await serve();
}
```

`#[main]` tells the launcher to install the managed runtime around this entrypoint. It should not be
needed in library code.

```ts
// #[send]
export function buildAccountModel(input: AccountModelInput): Result<AccountModel, Failure> {
  return AccountModel.build(input.account, input.usage, input.billing);
}
```

`#[send]` validates that an entrypoint and its input/output types are portable across thread/worker
boundaries. The function remains a normal exported function.

```ts
// #[context(crossThread: false)]
const activeTransaction = new AsyncContext.Variable<Transaction>({
  name: 'active-transaction',
});
```

Context pragmas can keep non-sendable context values local to the current runtime thread.

Do not add a new `Do` macro. The existing `Do` / `bind` macro remains the sequencing abstraction. Do
not use a macro to hide every `TaskGroup`; a visible group is often the point of structured
concurrency. Prefer helper methods like `group.all(...)` for common fanout.

## Userspace Goroutine-Style Layer

A Go-like library can be layered on top without making unstructured tasks the core language model.

Sketch:

```ts
import { type AsyncResult, TaskGroup } from 'sts:concurrency';

class Supervisor implements AsyncDisposable {
  #group = TaskGroup.open<Failure>({
    name: 'supervisor',
    failure: 'supervise',
  });

  go<T>(body: () => AsyncResult<T, Failure>, options?: { name?: string }): void {
    this.#group.fork(body, options);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#group[Symbol.asyncDispose]();
  }
}
```

Use:

```ts
await using supervisor = new Supervisor();

supervisor.go(async () => {
  while (true) {
    Try(await refreshCache());
    Try(await sleep(Duration.seconds(30)));
  }
}, { name: 'cache-refresh' });
```

This gives ergonomic "start background work" behavior, but it still has:

- an owning supervisor
- shutdown cancellation
- failure policy
- tracing identity
- a testable lifetime

A future stdlib helper can expose this pattern once the lower-level semantics are stable.

## `Send` And `Share`

True parallelism requires explicit data rules.

`Send<T>` means a value may move, copy, transfer, or serialize from one thread/worker to another.
After transfer, the sending side may lose access if the value is move-only or transferable.

In `.d.ts`-style declarations, `Send<T>` and `Share<T>` can be identity marker aliases so the code
remains valid TypeScript. The Soundscript checker enforces the actual proof obligations.

Initial sendable values:

- primitives
- strings
- immutable value types
- `#[value(deep: true)]` classes
- readonly arrays and tuples of `Send`
- simple readonly records when the checker can prove deep sendability
- explicit transfer buffers
- explicit shared-buffer handles
- resource handles only when the provider declares a sendable representation

Not sendable by default:

- arbitrary class instances
- mutable object graphs
- closures
- functions with captured environment
- host objects
- DOM objects
- JS promises
- raw database connections, sockets, or file handles unless wrapped in a target-supported handle

`Share<T>` means a value may be simultaneously observed or accessed from multiple threads.

Initial shareable values:

- shared typed buffers
- atomics
- mutex-protected cells
- channels
- explicitly shareable resource handles
- deeply immutable references only on profiles with a shared immutable heap or an explicit shared
  handle

Not shareable by default:

- ordinary mutable arrays
- ordinary mutable class instances
- ordinary object maps
- unsynchronized interior mutation
- deeply immutable values that are merely copied or serialized between workers; those are `Send`,
  not `Share`

Value example:

```ts
// #[value(deep: true)]
class ThumbnailJob {
  readonly imageId: ImageId;
  readonly bytes: Bytes;
  readonly width: i32;
  readonly height: i32;

  constructor(imageId: ImageId, bytes: Bytes, width: i32, height: i32) {
    this.imageId = imageId;
    this.bytes = bytes;
    this.width = width;
    this.height = height;
  }
}
```

Shared mutation must be explicit:

```ts
const counters = SharedArray.u64(128);

export function countBucket(job: CountJob): Result<void, Failure> {
  counters.atomicAdd(job.bucket, 1n);
  return ok(undefined);
}
```

No ordinary field write should silently become cross-thread shared mutation.

### Captures And Thread Entrypoints

For portability, thread-pool and thread entrypoints should be named functions or otherwise
compiler-liftable functions with no non-sendable captured state.

Accepted:

```ts
export function parseFile(input: ParseFileInput): Result<ParsedFile, Failure> {
  return parseBytes(input.path, input.bytes);
}

const parsed = Try(await ThreadPool.default.run(parseFile, input));
```

Rejected or target-gated:

```ts
const parsed = Try(await ThreadPool.default.run(() => parseFromSocket(openSocket, bytes), input));
```

This restriction is what keeps JS workers, Wasm workers, and native threads aligned instead of
having each target invent incompatible closure shipping behavior.

## Effect System Integration

The effect system should describe suspension, host IO, thread creation, shared mutation, and
blocking honestly without making ordinary async code noisy.

Proposed effect mapping:

| Operation                           | Effects                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `await promise`                     | `suspend.await`                                          |
| `TaskGroup.open`                    | no host effect by itself                                 |
| `group.fork(...)`                   | `concurrency.fork`; child body carries its own effects   |
| `group.all(...)`                    | `suspend.await`, `concurrency.fork`, `concurrency.join`  |
| `handle.join()`                     | `suspend.await`, `concurrency.join`                      |
| `ThreadPool.default.run(...)`       | `concurrency.parallel.thread`                            |
| `await ThreadPool.default.run(...)` | `suspend.await`, `concurrency.parallel.thread`           |
| `Thread.spawn(...)`                 | `concurrency.parallel.thread`, possible `host.thread`    |
| `Thread.blockingJoin()`             | `thread.block`                                           |
| `Thread.blockOn(...)`               | `thread.block`, target-gated                             |
| `AsyncContext.Variable.get()`       | likely no effect                                         |
| `AsyncContext.Variable.run(...)`    | `context.local` if tracked                               |
| shared atomic write                 | `mut.shared`, possible `atomic`                          |
| mutex/channel operations            | `suspend.await` or `thread.block` depending on operation |
| host network/file/database IO       | existing `host.io` / narrower provider-specific effects  |

Open questions:

- Whether `concurrency.fork` and `concurrency.join` should be explicit first-class effects or folded
  into `suspend.await`.
- Whether `concurrency.parallel.thread` should be allowed in all native profiles by default or
  require a profile capability.
- Whether any native profile should allow a narrow expert-mode escape hatch for blocking inside
  already-suspended runtime contexts. V1 should reject it.

The important rule is that `async` remains normal TypeScript-compatible async. The effect system
adds compile-time honesty; it should not force users into a second syntax.

## Integration With `Do` And `bind`

`Do` remains the existing Soundscript macro and `bind`-style helper. Do not add a new
generator-based do notation.

`Do` is for sequential composition of effectful values. `TaskGroup` is for concurrency.

Example:

```ts
import { Do } from 'sts:prelude';
import { asyncResultMonad } from 'sts:concurrency';

async function loadProfile(id: UserId): AsyncResult<Profile, Failure> {
  return await Do(asyncResultMonad<Failure>(), async (bind) => {
    const account = bind(getAccount(id));
    const preferences = bind(getPreferences(id));
    const permissions = bind(getPermissions(id));

    return new Profile(account, preferences, permissions);
  });
}
```

Parallel work inside `Do` should still use `TaskGroup`:

```ts
async function loadProfile(id: UserId): AsyncResult<Profile, Failure> {
  return await Do(asyncResultMonad<Failure>(), async (bind) => {
    await using group = TaskGroup.open<Failure>({ name: 'profile' });

    const parts = bind(group.all({
      account: () => getAccount(id),
      preferences: () => getPreferences(id),
      permissions: () => getPermissions(id),
    }));

    return new Profile(parts.account, parts.preferences, parts.permissions);
  });
}
```

This keeps the mental model clean:

- `Do` / `bind`: unwrap and sequence `Result` / `AsyncResult`
- `TaskGroup`: own concurrent children
- `ThreadPool`: run sendable work in true parallel
- `Thread`: one-off low-level thread

## Promise Interop

Conversion helpers should make the promise boundary explicit:

```ts
function fromPromise<T>(
  body: () => Promise<T>,
  mapFailure?: (error: unknown) => Failure,
): AsyncResult<T, Failure>;

function toPromise<T, E>(
  result: AsyncResult<T, E>,
): Promise<T>;

function fromResult<T, E>(result: Result<T, E>): AsyncResult<T, E>;
```

Recommended behavior:

- `fromPromise` converts fulfillment to `ok(value)`
- `fromPromise` converts rejection to `err(Failure.from(error))` or a caller-provided failure mapper
- `toPromise` resolves `Ok<T>` to `T`
- `toPromise` rejects `Err<E>` using a stable JS error wrapper
- cancellation maps to a first-class cancellation failure, not an arbitrary thrown value

Do not make every `Promise<T>` automatically equivalent to `AsyncResult<T, Failure>`. A raw promise
does not specify expected failure shape.

## Runtime Semantics

### Promise Semantics

`Promise` remains the async carrier.

On JS targets:

- `Promise` is the host JavaScript promise.
- `await` follows host JS semantics.
- Promise job ordering follows the host.

On WasmGC and native/LLVM profiles:

- `Promise` is compiler-owned.
- `await` lowers to compiler/runtime suspension.
- Host promise interop is explicit at the boundary.
- The runtime preserves JavaScript-visible promise semantics where the program crosses into JS.

This design does not create a second async system next to the promise runtime. `TaskGroup`,
`ThreadPool`, `Thread`, `AsyncContext`, and `Thread.blockOn` integrate with the same
promise/job/task substrate.

### Scope And Cancellation

Every structured child has an owner.

`TaskGroup` exit must:

1. prevent new child forks
2. wait for completed child results already being joined
3. cancel unfinished children when policy requires it
4. wait for cancellation cleanup
5. return the primary failure or success

Primary failure selection:

- first observed child `Err<E>` wins
- deadline failure wins if it fires before any child failure is observed
- parent failure wins if the parent fails before child failures are observed
- sibling cancellation failures are suppressed unless cancellation itself is primary
- cleanup defects should be attached as trace/suppressed metadata when the failure representation
  supports it

Supervised scopes should be explicit:

```ts
await using group = TaskGroup.open<Failure>({
  failure: 'supervise',
});
```

Supervision means child failures are recorded and joined, but do not automatically cancel siblings.

### Debuggability

The runtime should expose a task tree:

```text
root
  http-server
    request:7f03
      account-page
        getAccount
        getUsage
          getSeatUsage
          getStorageUsage
          getApiUsage
        getBillingSummary
      buildAccountModel
```

This should feed tracing, debugger views, leak detection, and test diagnostics.

## Target Implementations

### JS Target

Implementation:

- `AsyncResult` is `Promise<Result<T, E>>`.
- `TaskGroup` uses host promises plus structured bookkeeping.
- Task-group cancellation uses `AbortSignal` / `AbortController`-compatible signals where host APIs
  support cancellation.
- `AsyncContext` maps to TC39 `AsyncContext` if available, or a polyfill/zone-like runtime when
  supported by the host profile.
- `ThreadPool` can use Node `worker_threads` or browser Workers where configured and available.
- `Thread.spawn` can use one worker per thread where available.
- Sendability maps to structured clone / transfer / SharedArrayBuffer capability rules.
- `ThreadPool.default` is a lazy provider handle. Node and browser targets must not start a worker
  pool until the first `run` / `map` call or explicit eager runtime configuration.
- Worker entrypoints must be top-level/importable functions at first. Arbitrary captured closures
  are deferred until the compiler has a real lifting and sendability story.

Limitations:

- `Thread.blockOn` is unavailable.
- Browser main thread cannot block.
- Worker startup and serialization overhead can dominate short CPU work.
- Browser SharedArrayBuffer requires cross-origin isolation.
- Host promises cannot be optimized as aggressively as compiler-owned promises.
- Raw JS closures and host objects are not portable thread entrypoints.
- Cancellation of host operations is cooperative. A task using an uncancellable host API may delay
  scope exit until the host operation settles.

Semantics:

- If `ThreadPool.default.run(...)` is supported, it must truly run on a worker and respect `Send`.
- If the target profile lacks workers, `ThreadPool.default.run(...)` should be statically
  target-gated rather than silently running CPU work on the event loop.
- Explicitly dynamic APIs may still return an unsupported-capability failure when the source is
  compiled for a family of host profiles and support depends on deployment configuration.
- `TaskGroup` semantics should match other targets: fail-fast, cancellation propagation, and no
  child leaks.

### WasmGC Browser Profile

Implementation:

- Keep the compiler-owned promise runtime as the async substrate.
- Host IO completions resolve compiler-owned promises through existing host bridge mechanisms.
- `TaskGroup` adds group records and child records to the promise runtime.
- `AsyncContext` is stored in runtime async frames/snapshots and restored around resumptions.
- `ThreadPool` uses Web Workers when enabled.
- Worker execution uses separate Wasm instances or a shared runtime configuration with explicit
  message passing.
- Values crossing workers use `Send` lowering: serialization, transfer, or shared buffers.
- Shared memory uses WebAssembly shared memory only in profiles that support it.
- `ThreadPool.default` remains lazy. Wrapper generation should include worker bootstrap assets only
  when the program references worker-backed APIs or explicit runtime config requests them.
- Worker entrypoints initially must be imported/exported functions whose boundary types satisfy
  `Send`; closure lifting is a later optimization.

Limitations:

- Browser main-thread `Thread.blockOn` is unavailable.
- Browser and JS-hosted Wasm cannot block the main event-loop thread while waiting for promises,
  because the same event loop usually has to deliver the timer, fetch, worker-message, or host
  promise completion that would make the wait finish.
- WasmGC heap objects are not freely shared between worker instances.
- Host DOM objects are not sendable.
- Worker setup requires bundling/module-loader support.
- SharedArrayBuffer and Wasm shared memory depend on browser security headers.

Semantics:

- Async/await behavior remains compiler-owned and JS-compatible at host boundaries.
- Task groups must not depend on JS promise combinators internally except at interop edges.
- Thread APIs should be statically unavailable unless the profile enables worker support.

### WasmGC Node Profile

Implementation:

- Same compiler-owned promise/task runtime as WasmGC browser.
- Host IO can map to Node async APIs through the host bridge.
- `ThreadPool` can use Node worker threads with Wasm worker instances.
- `Thread.blockOn` remains unavailable by default on the JS event-loop thread, but may become
  available only in explicitly native-like worker contexts if the host integration can prove it is
  safe.

Limitations:

- Worker serialization and instance startup overhead remain real.
- Node host promise integration still constrains external ordering.
- File/network IO is host-driven rather than a fully native netpoller.

### Wasm Standalone / WASI Profile

Implementation direction:

- Use compiler-owned promise records and async frames.
- Use WASI pollable resources for timers/files/network as WASI support matures.
- Use Wasm threads where available.
- Use target capability declarations for thread support and blocking support.

Limitations:

- WASI async and threading standards are still uneven.
- Network support differs by runtime.
- `Thread.blockOn` support depends on the embedding runtime.

This profile should not promise Go-class IO performance until the runtime substrate and host
capabilities are stable.

### Native / LLVM Standalone Profile

Implementation:

- Compiler-owned promise records.
- Compiler-lowered async frames/fibers.
- Work-stealing scheduler for async tasks and CPU work.
- Netpoller for sockets/files/timers where the OS supports it.
- Timer wheel or heap for deadlines.
- Bounded default thread pool.
- `Thread.spawn` maps to OS threads.
- `ThreadPool.fixed` creates dedicated worker pools.
- `Thread.blockOn` parks the current OS thread and drives/joins the runtime.
- `AsyncContext` snapshots live in task records and cross thread boundaries through `Send`.
- `Send` / `Share` are enforced by checker rules and runtime debug assertions where useful.

Performance targets:

- no generic `.then` chain allocation for compiler-known `await`
- async frames allocated lazily and only spill locals live across `await`
- task records are fixed-layout runtime records
- `TaskGroup.all` uses intrusive child lists/result slots, not generic promise combinator graphs
- IO parks tasks on a netpoller, not one OS thread per request
- short-lived HTTP concurrency should approach Go in shape: cheap task records, cheap wakeups,
  batched readiness, and bounded scheduler overhead
- CPU parallelism uses bounded worker pools and work stealing

Limitations:

- The runtime will take time to mature to Go-level performance.
- JS-compatible promise semantics impose some ordering and interop constraints that Go does not
  have.
- Send/Share restrictions mean porting arbitrary JS-style mutable object code to native threads will
  require refactoring.

## Integration With Existing WasmGC Runtime

The current WasmGC compiler-owned promise runtime should become the substrate for this model. It
should not be bypassed by a separate task runtime.

In other words, `sts:concurrency/runtime` is not a competing scheduler for WasmGC. It is the public
provider facade over the existing compiler-owned async substrate. On JS targets the facade delegates
to host promises and host async-context support; on WasmGC it extends the compiler-owned promise
runtime with task-group, cancellation, deadline, context, and worker-completion records.

Required runtime concepts:

- `PromiseRecord`: existing compiler-owned promise state
- `AsyncFrame`: suspended function continuation and live locals
- `RuntimeTask`: scheduled unit of async execution
- `TaskGroupRecord`: parent scope, policy, child list, cancellation state, deadline
- `ChildTaskRecord`: child promise/task, result slot, cancellation state, name/debug metadata
- `JoinHandleRecord`: handle identity and join waiter list
- `AbortSignalRecord`: abort reason and propagation links
- `DeadlineRecord`: timer linkage and deadline failure construction
- `AsyncContextSnapshot`: captured variable map
- `ExecutorRecord`: current executor/thread-pool binding
- `HostCompletionRecord`: host IO completion bridge into runtime scheduling

Likely refactor:

- If the existing runtime is promise-combinator-specific, refactor or rebuild its internals around
  generic task records and async frames.
- Preserve the external compiler-owned `Promise` behavior.
- Preserve current host IO integration points, but route completions through the unified scheduler.
- Add task-group bookkeeping as a layer over promise records.
- Add async-context snapshot capture/restore at task creation and continuation resume.
- Add thread-pool completion as another host/runtime completion source.

Conceptual flow:

```text
host IO completion / timer / worker completion
  -> HostCompletionRecord
  -> scheduler queue
  -> RuntimeTask
  -> resume AsyncFrame
  -> settle PromiseRecord
  -> notify TaskGroupRecord / JoinHandleRecord
```

This preserves the existing promise investment while giving task groups, thread completions, and
context propagation one coherent runtime path.

## Pay-For-Play Plan

The runtime should be linked and initialized incrementally:

| Program feature used                      | Runtime needed                                     |
| ----------------------------------------- | -------------------------------------------------- |
| sync-only code                            | none beyond normal program startup                 |
| `Result` / `Do` over sync values          | no async scheduler                                 |
| `async` / `await` / `Promise`             | promise records, async frames, microtask scheduler |
| host async IO                             | promise runtime plus host completion bridge        |
| `TaskGroup`                               | task-group records and cancellation/deadline hooks |
| `AsyncContext`                            | snapshot storage and restoration                   |
| `ThreadPool.default.run` / `Thread.spawn` | worker pool/thread runtime and Send/Share lowering |
| shared atomics/channels/mutexes           | shared-memory synchronization runtime              |
| `Thread.blockOn`                          | native blocking bridge into scheduler              |

Compiler and linker behavior:

- Do not include thread runtime unless thread APIs are referenced.
- Do not initialize the default pool until first use or explicit config requires it.
- Do not generate JS/Wasm worker bootstrap assets unless thread APIs or explicit runtime config need
  them.
- Do not include async context storage unless `AsyncContext` variables or snapshots are used.
- Do not include task-group policy machinery unless `TaskGroup` is used.
- Keep Send/Share checker metadata compile-time when no thread boundary exists.
- Lower compiler-known awaits directly rather than through public promise helper calls.

## Performance Concerns

### Thousands Of Short-Lived HTTP Requests

The Go comparison matters most here.

Go shape:

- goroutine per request
- netpoller parks goroutines
- cheap stacks
- scheduler resumes on readiness
- little allocation per await-like boundary

Soundscript native target should aim for:

- runtime task per request
- async frame allocated only when the handler suspends
- netpoll registration per socket
- completion resumes the frame directly
- `TaskGroup` child records for fanout, not `Promise.all` object graphs
- batched scheduler wakeups
- `Result` represented as optimized tagged values where possible

Expected differences:

- Soundscript must preserve JS promise semantics at language and interop boundaries.
- Initial native runtime will likely lag Go until the scheduler/netpoller is mature.
- With compiler-owned promises, Soundscript should avoid the biggest JS-target overheads.
- With host JS promises, the JS target cannot approach Go for this workload.

### Many Short CPU Jobs

Thread-pool overhead can dominate tiny work items.

Guidance:

- batch small jobs before sending to `ThreadPool`
- use `ThreadPool.map` to let the runtime chunk work
- keep entrypoint input/output compact and sendable
- avoid shipping large copied object graphs
- use transferable/shared buffers for bulk data

Runtime optimizations:

- chunking for `map`
- work stealing
- per-worker arenas
- transfer buffers instead of copies where target allows
- inline current-thread execution only when an explicit policy allows fallback

### Wasm And JS Worker Overhead

JS and Wasm worker startup is expensive compared with native worker scheduling.

Mitigations:

- lazy persistent default pool
- warm workers for configured server profiles
- module preloading
- batch work
- transfer buffers
- capability errors instead of silent event-loop fallback

## Addressing Async Critiques

The Hacker News thread and linked article raised issues that matter, even if Soundscript is not
targeting the same use cases as Rust or C++.

### Function Coloring

Soundscript should accept that `async` marks real suspension. The effect system should make that
honest with `suspend.await` and host/parallel effects. Trying to erase all function coloring would
fight TypeScript compatibility and JavaScript promise semantics.

The ergonomic goal is not "no async color." The goal is "async color is ordinary, explicit, and
portable."

### Hidden Sequential Execution

Plain `await` is sequential:

```ts
const account = Try(await getAccount(id));
const usage = Try(await getUsage(id));
```

Independent work uses `TaskGroup`:

```ts
await using group = TaskGroup.open<Failure>();
const parts = Try(
  await group.all({
    account: () => getAccount(id),
    usage: () => getUsage(id),
  }),
);
```

### Lost Errors And Leaked Work

`new Promise(...)` or a dropped promise can lose ownership. `TaskGroup` should be the idiomatic way
to start child work so every child is joined, cancelled, or supervised before scope exit.

### Resource Cleanup

`await using` plus `TaskGroup` gives cleanup a real lifetime. Parent scope exit waits for child
cleanup before returning.

### Debuggability

The runtime has a task tree instead of a flat bag of promises. This enables better traces, tests,
and leak reports.

## Comparison With Go

Ergonomics:

```go
go refresh()
```

```ts
supervisor.go(() => refresh());
```

```go
userCh := make(chan User)
prefsCh := make(chan Prefs)
go loadUser(userCh)
go loadPrefs(prefsCh)
```

```ts
await using group = TaskGroup.open<Failure>();
const parts = Try(
  await group.all({
    user: () => loadUser(id),
    prefs: () => loadPrefs(id),
  }),
);
```

Soundscript will be a little more explicit in the structured path. That is acceptable if the payoff
is fewer leaks, clearer cancellation, and better error handling.

Performance:

- Native Soundscript can approach Go only with a serious runtime: compiler-owned promises, cheap
  async frames, netpolling, work-stealing pools, and optimized task groups.
- JS-target Soundscript cannot approach Go for CPU or high-throughput IO because it is constrained
  by host promises and host event loops.
- WasmGC can approach wasm-compiled Go only if its compiler-owned async runtime avoids generic JS
  promise graphs and uses workers/shared memory where available.
- Go will retain advantages from a mature runtime and simpler language-level async semantics.

Where Soundscript can be nicer than Go:

- typed `Result` expected failures
- scoped child ownership by default
- effect visibility
- TypeScript-compatible async syntax
- portable source across JS, Wasm, and native profiles

## Implementation Slices

### Slice 1: Semantic Surface And Checker

- Add `AsyncResult<T, E>` alias.
- Add `TaskGroup` type surface and fail-fast semantics in stdlib types.
- Add checker rules for `await using TaskGroup`.
- Add `TaskHandle.join()` typing.
- Add initial `Send` / `Share` marker semantics.
- Add target-gated `Thread.blockOn` declaration.
- Add `AsyncContext` type surface aligned with TC39 naming.

Tests:

- async functions returning `AsyncResult` are valid TypeScript-compatible source
- `async function foo(): Task<T>` is rejected or discouraged by lint/spec guidance
- `TaskHandle` is not thenable
- non-sendable values rejected at `ThreadPool.run` / `Thread.spawn`
- `Thread.blockOn` rejected in JS/browser profiles

### Slice 2: JS Runtime Prototype

- Implement `TaskGroup` over host promises.
- Implement fail-fast cancellation bookkeeping.
- Implement `AsyncContext` polyfill or bridge.
- Implement `ThreadPool.default` for Node workers first if practical.
- Browser workers can follow once bundling constraints are clear.

Tests:

- child failure cancels siblings
- parent exit cancels unfinished children
- `group.all` preserves keyed result typing
- AsyncContext propagates through `await` and `TaskGroup.fork`
- JS target rejects or fails explicitly when thread support is unavailable

### Slice 3: WasmGC Runtime Integration

- Add task-group records to compiler-owned promise runtime.
- Add cancellation/deadline propagation.
- Add async-context snapshot capture/restore.
- Route host IO completions, timers, and worker completions through one scheduler path.
- Add worker-backed `ThreadPool` under a target capability flag.

Tests:

- existing async/await promise tests continue passing
- host IO bridge completions still resolve compiler-owned promises
- task-group cancellation does not leak promise records
- AsyncContext survives host IO suspension/resume
- worker completion resumes awaiting Wasm task

### Slice 4: Native Runtime Prototype

- Implement compiler-owned promise records and async frame lowering.
- Implement scheduler, timer queue, and basic netpoller.
- Implement default thread pool.
- Implement `Thread.spawn`.
- Implement `Thread.blockOn`.
- Implement debug task tree.

Benchmarks:

- async function with no suspension
- async function with one suspension
- `TaskGroup.all` with N children
- thousands of timer waits
- thousands of socket waits
- CPU `ThreadPool.map`
- request fanout handler benchmark against Go baseline where comparable

### Slice 5: Runtime Overrides And Libraries

- Add `Runtime.with(...)`.
- Add supervisor/userspace goroutine helper if still desired.
- Add channels, mutexes, shared arrays, and atomics.
- Add richer deadline and cancellation APIs.
- Add tracing integration.

## Open Questions

- What is the minimal initial `Send` proof the checker can enforce without making value types too
  hard to use?
- Should `AsyncContext` variables default to cross-thread propagation if `T: Send`, or require an
  explicit option?
- How much of the native runtime should be built before exposing thread APIs as stable?

Resolved initial decisions:

- `ThreadPool.default.run` should require top-level/importable entrypoints on JS and Wasm targets in
  the first implementation. Compiler lifting of local pure functions can be added later as an
  optimization once closure capture, bundle identity, and `Send` proof rules are mature.
