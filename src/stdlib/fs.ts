import {
  access,
  copyFile as nodeCopyFile,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  readdir as nodeReadDir,
  readFile as nodeReadFile,
  realpath as nodeRealPath,
  rename as nodeRename,
  rm as nodeRm,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';

import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok } from 'sts:result';
import { type Bytes, Bytes as BytesApi } from 'sts:bytes';
import type { ByteView } from 'sts:streams';
import { WallDateTime } from 'sts:time';
import type { AsyncResult } from 'sts:concurrency/task';

export type PathLike = string | URL;

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface ReadFileOptions extends OperationOptions {}

export interface WriteFileOptions extends OperationOptions {
  readonly create?: boolean;
  readonly append?: boolean;
  readonly truncate?: boolean;
  readonly mode?: number;
  readonly createParentDirectories?: boolean;
}

export interface RemoveOptions extends OperationOptions {
  readonly recursive?: boolean;
}

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

interface StatsLike {
  readonly size: number | bigint;
  readonly mtime?: Date;
  readonly atime?: Date;
  readonly ctime?: Date;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface DirentLike {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

function parentPath(path: PathLike): string | undefined {
  if (typeof path !== 'string') {
    return undefined;
  }
  const normalized = path.replaceAll('\\', '/');
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? undefined : normalized.slice(0, index);
}

function fileTypeFromStats(stats: StatsLike): FileInfo['type'] {
  if (stats.isFile()) {
    return 'file';
  }
  if (stats.isDirectory()) {
    return 'directory';
  }
  if (stats.isSymbolicLink()) {
    return 'symlink';
  }
  return 'other';
}

function fileTypeFromDirent(dirent: DirentLike): FileInfo['type'] {
  if (dirent.isFile()) {
    return 'file';
  }
  if (dirent.isDirectory()) {
    return 'directory';
  }
  if (dirent.isSymbolicLink()) {
    return 'symlink';
  }
  return 'other';
}

function fileInfoFromStats(stats: StatsLike): FileInfo {
  return {
    type: fileTypeFromStats(stats),
    size: typeof stats.size === 'bigint' ? stats.size : BigInt(stats.size),
    modifiedAt: stats.mtime ? new WallDateTime(stats.mtime) : undefined,
    accessedAt: stats.atime ? new WallDateTime(stats.atime) : undefined,
    createdAt: stats.ctime ? new WallDateTime(stats.ctime) : undefined,
  };
}

function directoryEntryFromDirent(dirent: DirentLike): DirectoryEntry {
  return {
    name: dirent.name,
    type: fileTypeFromDirent(dirent),
  };
}

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer;
}

function bytesFromView(bytes: ByteView): Uint8Array {
  if (bytes instanceof ArrayBuffer || isSharedArrayBuffer(bytes)) {
    return BytesApi.view(bytes);
  }
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  return BytesApi.view(bytes.buffer, {
    byteOffset: bytes.byteOffset,
    byteLength: bytes.byteLength,
  });
}

async function pathExistsForWrite(path: PathLike): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function writeFlag(path: PathLike, options: WriteFileOptions): Promise<string | undefined> {
  if (options.append) {
    if (options.create === false) {
      await access(path);
    }
    return 'a';
  }

  if (options.truncate === false) {
    const exists = await pathExistsForWrite(path);
    if (exists) {
      return 'r+';
    }
    if (options.create === false) {
      await access(path);
    }
    return 'w';
  }

  if (options.create === false) {
    await access(path);
    return 'w';
  }

  return undefined;
}

async function createParentDirectoryIfRequested(
  path: PathLike,
  options: WriteFileOptions,
): Promise<void> {
  if (!options.createParentDirectories) {
    return;
  }
  const parent = parentPath(path);
  if (parent) {
    await nodeMkdir(parent, { recursive: true });
  }
}

export async function exists(path: PathLike): AsyncResult<boolean, Failure> {
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

export async function readFile(
  path: PathLike,
  options: ReadFileOptions = {},
): AsyncResult<Bytes, Failure> {
  try {
    return ok(new Uint8Array(await nodeReadFile(path, { signal: options.signal })));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function readTextFile(
  path: PathLike,
  options: ReadFileOptions & { readonly encoding?: string } = {},
): AsyncResult<string, Failure> {
  try {
    return ok(
      await nodeReadFile(path, {
        encoding: (options.encoding ?? 'utf8') as NodeJS.BufferEncoding,
        signal: options.signal,
      }),
    );
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function writeFile(
  path: PathLike,
  bytes: ByteView,
  options: WriteFileOptions = {},
): AsyncResult<void, Failure> {
  try {
    await createParentDirectoryIfRequested(path, options);
    await nodeWriteFile(path, bytesFromView(bytes), {
      flag: await writeFlag(path, options),
      mode: options.mode,
      signal: options.signal,
    });
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function writeTextFile(
  path: PathLike,
  text: string,
  options: WriteFileOptions & { readonly encoding?: string } = {},
): AsyncResult<void, Failure> {
  try {
    await createParentDirectoryIfRequested(path, options);
    await nodeWriteFile(path, text, {
      encoding: (options.encoding ?? 'utf8') as NodeJS.BufferEncoding,
      flag: await writeFlag(path, options),
      mode: options.mode,
      signal: options.signal,
    });
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function stat(
  path: PathLike,
  _options: OperationOptions = {},
): AsyncResult<FileInfo, Failure> {
  try {
    return ok(fileInfoFromStats(await nodeStat(path)));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function lstat(
  path: PathLike,
  _options: OperationOptions = {},
): AsyncResult<FileInfo, Failure> {
  try {
    return ok(fileInfoFromStats(await nodeLstat(path)));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function readDir(
  path: PathLike,
  _options: OperationOptions = {},
): AsyncResult<readonly DirectoryEntry[], Failure> {
  try {
    const entries = await nodeReadDir(path, { withFileTypes: true });
    return ok(entries.map(directoryEntryFromDirent));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function mkdir(
  path: PathLike,
  options: OperationOptions & { readonly recursive?: boolean; readonly mode?: number } = {},
): AsyncResult<void, Failure> {
  try {
    await nodeMkdir(path, {
      mode: options.mode,
      recursive: options.recursive ?? false,
    });
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function remove(
  path: PathLike,
  options: RemoveOptions = {},
): AsyncResult<void, Failure> {
  try {
    await nodeRm(path, {
      force: true,
      recursive: options.recursive ?? false,
    });
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function rename(
  oldPath: PathLike,
  newPath: PathLike,
  _options: OperationOptions = {},
): AsyncResult<void, Failure> {
  try {
    await nodeRename(oldPath, newPath);
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function copyFile(
  from: PathLike,
  to: PathLike,
  _options: OperationOptions = {},
): AsyncResult<void, Failure> {
  try {
    await nodeCopyFile(from, to);
    return ok(undefined);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export async function realPath(
  path: PathLike,
  _options: OperationOptions = {},
): AsyncResult<string, Failure> {
  try {
    return ok(await nodeRealPath(path));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export const Fs = Object.freeze({
  exists,
  readFile,
  readTextFile,
  writeFile,
  writeTextFile,
  stat,
  lstat,
  readDir,
  mkdir,
  remove,
  rename,
  copyFile,
  realPath,
});
