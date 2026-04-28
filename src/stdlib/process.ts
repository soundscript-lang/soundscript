import process from 'node:process';

import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

export interface ProcessInfo {
  readonly pid?: number;
  readonly ppid?: number;
  readonly executable?: string;
  readonly platform?: string;
  readonly arch?: string;
}

export type SignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL';

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
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
  exit,
});
