import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions,
  type StdioOptions,
} from 'node:child_process';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';

import type { Bytes } from 'sts:bytes';
import type { AsyncResult } from 'sts:concurrency/task';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';
import { readAllBytes } from 'sts:streams';

export interface ProcessInfo {
  readonly pid?: number;
  readonly ppid?: number;
  readonly executable?: string;
  readonly platform?: string;
  readonly arch?: string;
}

export type SignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL';

export interface CommandOptions {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: 'inherit' | 'null' | 'piped';
  readonly stdout?: 'inherit' | 'null' | 'piped';
  readonly stderr?: 'inherit' | 'null' | 'piped';
  readonly signal?: AbortSignal;
}

export interface CommandStatus {
  readonly code: number;
  readonly success: boolean;
}

export interface CommandOutput extends CommandStatus {
  readonly stdout: Bytes;
  readonly stderr: Bytes;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

type NodeStdio = 'inherit' | 'ignore' | 'pipe';

function stdioOption(option: CommandOptions['stdin'] | CommandOptions['stdout']): NodeStdio {
  if (option === 'inherit') {
    return 'inherit';
  }
  if (option === 'piped') {
    return 'pipe';
  }
  return 'ignore';
}

function commandEnvironment(
  env: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv | undefined {
  return env ? { ...process.env, ...env } : undefined;
}

function emptyBytes(): Bytes {
  return new Uint8Array();
}

function readableToWeb(
  stream: Readable | null,
): ReadableStream<Uint8Array<ArrayBufferLike>> | undefined {
  return stream
    ? Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array<ArrayBufferLike>>
    : undefined;
}

function writableToWeb(
  stream: Writable | null,
): WritableStream<Uint8Array<ArrayBufferLike>> | undefined {
  return stream
    ? Writable.toWeb(stream) as unknown as WritableStream<Uint8Array<ArrayBufferLike>>
    : undefined;
}

function statusFromExit(code: number | null): CommandStatus {
  const exitCode = code ?? 1;
  return {
    code: exitCode,
    success: exitCode === 0,
  };
}

export function info(): Result<ProcessInfo, Failure> {
  try {
    return ok({
      pid: process.pid,
      ppid: process.ppid,
      executable: process.execPath,
      platform: process.platform,
      arch: process.arch,
    });
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function cwd(): Result<string, Failure> {
  try {
    return ok(process.cwd());
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function chdir(path: string): Result<void, Failure> {
  try {
    process.chdir(path);
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function pid(): Result<number, Failure> {
  return ok(process.pid);
}

export function platform(): Result<string, Failure> {
  return ok(process.platform);
}

export function uptime(): Result<number, Failure> {
  try {
    return ok(process.uptime());
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function setExitCode(code: number): Result<void, Failure> {
  process.exitCode = code;
  return ok(undefined);
}

export function onSignal(signal: SignalName, handler: () => void): Result<Disposable, Failure> {
  try {
    process.on(signal, handler);
    const dispose = (): void => {
      process.off(signal, handler);
    };
    return ok({
      dispose,
      [Symbol.dispose]: dispose,
    });
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export class Child implements AsyncDisposable {
  readonly pid?: number;
  readonly stdin?: WritableStream<Uint8Array<ArrayBufferLike>>;
  readonly stdout?: ReadableStream<Uint8Array<ArrayBufferLike>>;
  readonly stderr?: ReadableStream<Uint8Array<ArrayBufferLike>>;
  readonly #child: ChildProcess;
  #status?: AsyncResult<CommandStatus, Failure>;

  constructor(child: ChildProcess) {
    this.#child = child;
    this.pid = child.pid;
    this.stdin = writableToWeb(child.stdin);
    this.stdout = readableToWeb(child.stdout);
    this.stderr = readableToWeb(child.stderr);
  }

  status(): AsyncResult<CommandStatus, Failure> {
    if (this.#status) {
      return this.#status;
    }
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return Promise.resolve(ok(statusFromExit(this.#child.exitCode)));
    }

    this.#status = new Promise((resolve) => {
      const cleanup = (): void => {
        this.#child.off('error', onError);
        this.#child.off('exit', onExit);
      };
      const onError = (error: Error): void => {
        cleanup();
        resolve(err(failureFromUnknown(error)));
      };
      const onExit = (code: number | null): void => {
        cleanup();
        resolve(ok(statusFromExit(code)));
      };

      this.#child.once('error', onError);
      this.#child.once('exit', onExit);
    });

    return this.#status;
  }

  kill(signal: SignalName = 'SIGTERM'): Result<void, Failure> {
    try {
      return this.#child.kill(signal)
        ? ok(undefined)
        : err(new Failure(`Failed to send ${signal} to child process.`));
    } catch (error) {
      return err(failureFromUnknown(error));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill('SIGTERM');
    }
    const status = await this.status();
    if (status.tag === 'err') {
      throw status.error;
    }
  }
}

export function spawn(command: string, options: CommandOptions = {}): AsyncResult<Child, Failure> {
  try {
    const stdio = [
      stdioOption(options.stdin),
      stdioOption(options.stdout ?? 'piped'),
      stdioOption(options.stderr ?? 'piped'),
    ] satisfies StdioOptions;
    const child = nodeSpawn(
      command,
      [...(options.args ?? [])],
      {
        cwd: options.cwd,
        env: commandEnvironment(options.env),
        signal: options.signal,
        stdio,
      } satisfies SpawnOptions,
    );
    return new Promise((resolve) => {
      const cleanup = (): void => {
        child.off('error', onError);
        child.off('spawn', onSpawn);
      };
      const onError = (error: Error): void => {
        cleanup();
        resolve(err(failureFromUnknown(error)));
      };
      const onSpawn = (): void => {
        cleanup();
        resolve(ok(new Child(child)));
      };

      child.once('error', onError);
      child.once('spawn', onSpawn);
    });
  } catch (error) {
    return Promise.resolve(err(failureFromUnknown(error)));
  }
}

export async function output(
  command: string,
  options: CommandOptions = {},
): AsyncResult<CommandOutput, Failure> {
  const childResult = await spawn(command, {
    ...options,
    stdin: options.stdin ?? 'null',
    stdout: 'piped',
    stderr: 'piped',
  });
  if (childResult.tag === 'err') {
    return childResult;
  }

  const child = childResult.value;
  const stdout = child.stdout ? readAllBytes(child.stdout) : Promise.resolve(ok(emptyBytes()));
  const stderr = child.stderr ? readAllBytes(child.stderr) : Promise.resolve(ok(emptyBytes()));
  const [statusResult, stdoutResult, stderrResult] = await Promise.all([
    child.status(),
    stdout,
    stderr,
  ]);

  if (statusResult.tag === 'err') {
    return statusResult;
  }
  if (stdoutResult.tag === 'err') {
    return stdoutResult;
  }
  if (stderrResult.tag === 'err') {
    return stderrResult;
  }

  return ok({
    ...statusResult.value,
    stdout: stdoutResult.value,
    stderr: stderrResult.value,
  });
}

export function exit(code = 0): never {
  process.exit(code);
  throw new Failure('Process exit returned unexpectedly.');
}

export const Process = Object.freeze({
  info,
  cwd,
  chdir,
  pid,
  platform,
  uptime,
  setExitCode,
  onSignal,
  spawn,
  output,
  exit,
});
