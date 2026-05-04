import process from 'node:process';

import { Failure, normalizeThrown } from 'sts:failures';
import { err, none, ok, type Option, type Result, some } from 'sts:result';

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

export function get(name: string): Result<Option<string>, Failure> {
  try {
    const value = process.env[name];
    return ok(value === undefined ? none() : some(value));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function required(name: string): Result<string, Failure> {
  const value = get(name);
  if (value.tag === 'err') {
    return value;
  }
  if (value.value.tag === 'none') {
    return err(new Failure(`Missing required environment variable ${name}.`));
  }
  return ok(value.value.value);
}

export function has(name: string): Result<boolean, Failure> {
  const value = get(name);
  if (value.tag === 'err') {
    return value;
  }
  return ok(value.value.tag === 'some');
}

export function set(name: string, value: string): Result<void, Failure> {
  try {
    process.env[name] = value;
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function remove(name: string): Result<void, Failure> {
  try {
    delete process.env[name];
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function toRecord(): Result<Readonly<Record<string, string>>, Failure> {
  try {
    return ok(Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        entry[1] !== undefined
      ),
    ));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export const Env = Object.freeze({
  get,
  required,
  has,
  set,
  remove,
  toRecord,
});
