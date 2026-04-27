import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok } from 'sts:result';
import type { Bytes } from 'sts:bytes';
import type { AsyncResult } from 'sts:concurrency/task';

export interface FileOperationOptions {
  readonly signal?: AbortSignal;
}

export interface WriteFileOptions extends FileOperationOptions {
  readonly createParentDirectories?: boolean;
}

export interface RemoveOptions {
  readonly recursive?: boolean;
}

export interface FileInfo {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly size: number;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

function parentPath(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/');
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? undefined : normalized.slice(0, index);
}

export async function exists(path: string): AsyncResult<boolean, Failure> {
  try {
    await access(path);
    return ok(true);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT') {
      return ok(false);
    }
    return err(failureFromUnknown(error));
  }
}

export async function info(path: string): AsyncResult<FileInfo, Failure> {
  try {
    const fileStat = await stat(path);
    return ok({
      isDirectory: fileStat.isDirectory(),
      isFile: fileStat.isFile(),
      size: fileStat.size,
    });
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function readText(
  path: string,
  options: FileOperationOptions = {},
): AsyncResult<string, Failure> {
  try {
    return ok(await readFile(path, { encoding: 'utf8', signal: options.signal }));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function readBytes(
  path: string,
  options: FileOperationOptions = {},
): AsyncResult<Bytes, Failure> {
  try {
    return ok(new Uint8Array(await readFile(path, { signal: options.signal })));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function writeText(
  path: string,
  text: string,
  options: WriteFileOptions = {},
): AsyncResult<void, Failure> {
  try {
    if (options.createParentDirectories) {
      const parent = parentPath(path);
      if (parent) {
        await mkdir(parent, { recursive: true });
      }
    }
    await writeFile(path, text, { encoding: 'utf8', signal: options.signal });
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function writeBytes(
  path: string,
  bytes: Bytes,
  options: WriteFileOptions = {},
): AsyncResult<void, Failure> {
  try {
    if (options.createParentDirectories) {
      const parent = parentPath(path);
      if (parent) {
        await mkdir(parent, { recursive: true });
      }
    }
    await writeFile(path, bytes, { signal: options.signal });
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function makeDirectory(path: string): AsyncResult<void, Failure> {
  try {
    await mkdir(path, { recursive: true });
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function remove(
  path: string,
  options: RemoveOptions = {},
): AsyncResult<void, Failure> {
  try {
    await rm(path, { force: true, recursive: options.recursive ?? false });
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export const Fs = Object.freeze({
  exists,
  info,
  readText,
  readBytes,
  writeText,
  writeBytes,
  makeDirectory,
  remove,
});
