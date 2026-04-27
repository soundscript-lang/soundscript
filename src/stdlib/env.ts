import { Failure, normalizeThrown } from 'sts:failures';
import { err, none, ok, type Option, type Result, some } from 'sts:result';

function nodeProcess():
  | { env?: Record<string, string | undefined> }
  | undefined {
  return (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

export function get(name: string): Result<Option<string>, Failure> {
  try {
    const value = nodeProcess()?.env?.[name];
    return ok(value === undefined ? none() : some(value));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function require(name: string): Result<string, Failure> {
  const value = get(name);
  if (value.tag === 'err') {
    return value;
  }
  if (value.value.tag === 'none') {
    return err(new Failure(`Missing required environment variable ${name}.`));
  }
  return ok(value.value.value);
}

export function set(name: string, value: string): Result<void, Failure> {
  try {
    const process = nodeProcess();
    if (!process?.env) {
      return err(new Failure('Environment variables are not available.'));
    }
    process.env[name] = value;
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function remove(name: string): Result<void, Failure> {
  try {
    const process = nodeProcess();
    if (!process?.env) {
      return err(new Failure('Environment variables are not available.'));
    }
    delete process.env[name];
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function entries(): Result<Readonly<Record<string, string>>, Failure> {
  try {
    return ok({ ...(nodeProcess()?.env ?? {}) } as Readonly<Record<string, string>>);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export const Env = Object.freeze({
  get,
  require,
  set,
  remove,
  entries,
});
