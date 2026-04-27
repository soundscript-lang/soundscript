import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

interface ProcessLike {
  readonly argv?: readonly string[];
  readonly pid?: number;
  readonly platform?: string;
  readonly versions?: { readonly node?: string };
  cwd?(): string;
  exit?(code?: number): never;
  exitCode?: number;
  uptime?(): number;
}

function nodeProcess(): ProcessLike | undefined {
  return (globalThis as typeof globalThis & { process?: ProcessLike }).process;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

export function cwd(): Result<string, Failure> {
  try {
    const value = nodeProcess()?.cwd?.();
    return value === undefined
      ? err(new Failure('Current working directory is unavailable.'))
      : ok(value);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function pid(): Result<number, Failure> {
  const value = nodeProcess()?.pid;
  return value === undefined ? err(new Failure('Process pid is unavailable.')) : ok(value);
}

export function platform(): Result<string, Failure> {
  const value = nodeProcess()?.platform;
  return value === undefined ? err(new Failure('Process platform is unavailable.')) : ok(value);
}

export function uptime(): Result<number, Failure> {
  try {
    const value = nodeProcess()?.uptime?.();
    return value === undefined ? err(new Failure('Process uptime is unavailable.')) : ok(value);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function setExitCode(code: number): Result<void, Failure> {
  const process = nodeProcess();
  if (!process) {
    return err(new Failure('Process exit code is unavailable.'));
  }
  process.exitCode = code;
  return ok(undefined);
}

export function exit(code = 0): never {
  const process = nodeProcess();
  if (!process?.exit) {
    throw new Failure('Process exit is unavailable.');
  }
  process.exit(code);
  throw new Failure('Process exit returned unexpectedly.');
}

export const Process = Object.freeze({
  cwd,
  pid,
  platform,
  uptime,
  setExitCode,
  exit,
});
