import { spawn } from 'node:child_process';
import {
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch as watchPath,
  writeFileSync,
} from 'node:fs';
import {
  copyFile as copyFileAsync,
  mkdir as mkdirAsync,
  mkdtemp as createTempDirectoryAsync,
  readdir as readDirectoryAsync,
  readFile as readFileAsync,
  readlink as readLinkAsync,
  rm as removePathAsync,
  symlink as createSymlinkAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';

export interface HostDirectoryEntry {
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  name: string;
}

export interface HostFileSystemWatchEvent {
  kind: 'create' | 'modify' | 'other' | 'remove';
  path?: string;
}

class AsyncHostEventQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((item: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }

    this.#items.push(item);
  }

  shift(): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }

    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

function collectDirectoriesRecursive(rootPath: string): readonly string[] {
  if (!directoryExistsSync(rootPath)) {
    return [];
  }

  const directories = [rootPath];
  for (const entry of readDirectorySync(rootPath)) {
    if (!entry.isDirectory) {
      continue;
    }

    directories.push(...collectDirectoriesRecursive(join(rootPath, entry.name)));
  }

  return directories;
}

export function directoryExistsSync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function fileExistsSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function pathExistsSync(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readBytesSync(path: string): Uint8Array {
  return readFileSync(path);
}

export function readDirectorySync(path: string): readonly HostDirectoryEntry[] {
  return readdirSync(path, { withFileTypes: true }).map((entry) => ({
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    isSymlink: entry.isSymbolicLink(),
    name: entry.name,
  }));
}

export async function copyFile(sourcePath: string, destinationPath: string): Promise<void> {
  await copyFileAsync(sourcePath, destinationPath);
}

export async function createSymlink(
  targetPath: string,
  path: string,
  type?: 'dir' | 'file' | 'junction',
): Promise<void> {
  await createSymlinkAsync(targetPath, path, type);
}

export async function createTempDirectory(prefix: string): Promise<string> {
  return await createTempDirectoryAsync(join(tmpdir(), prefix));
}

export async function makeDirectory(path: string): Promise<void> {
  await mkdirAsync(path, { recursive: true });
}

export function makeDirectorySync(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readTextFileSync(path: string): string {
  return readFileSync(path, 'utf8');
}

export async function readDirectory(path: string): Promise<readonly HostDirectoryEntry[]> {
  const entries = await readDirectoryAsync(path, { withFileTypes: true });
  return entries.map((entry) => ({
    isDirectory: entry.isDirectory(),
    isFile: entry.isFile(),
    isSymlink: entry.isSymbolicLink(),
    name: entry.name,
  }));
}

export async function readLink(path: string): Promise<string> {
  return await readLinkAsync(path);
}

export async function readTextFile(path: string): Promise<string> {
  return await readFileAsync(path, 'utf8');
}

export async function removePath(path: string): Promise<void> {
  await removePathAsync(path, { recursive: true, force: true });
}

export function removePathSync(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export async function readStdinText(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

export function runtimeExecPath(): string {
  return process.execPath;
}

export function runtimeArgs(): readonly string[] {
  return process.argv.slice(2);
}

export function runtimeCwd(): string {
  return process.cwd();
}

export function runtimeEnv(name: string): string | undefined {
  return process.env[name];
}

export function runtimeEnvObject(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string';
    }),
  );
}

export function runtimeExit(code: number): never {
  process.exit(code);
}

export function runtimeStdinReadable(): ReadableStream<Uint8Array> {
  return Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
}

export function runtimeStdoutWritable(): WritableStream<Uint8Array> {
  return Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
}

export async function* watchFileSystem(
  rootPath: string,
): AsyncIterable<HostFileSystemWatchEvent> {
  const events = new AsyncHostEventQueue<HostFileSystemWatchEvent>();
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let pendingPath: string | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleModifyEvent = (path: string): void => {
    pendingPath = path;
    if (debounceTimer) {
      return;
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      events.push({
        kind: 'modify',
        path: pendingPath,
      });
      pendingPath = undefined;
      syncWatchers();
    }, 50);
  };

  const syncWatchers = (): void => {
    if (closed) {
      return;
    }

    const expectedPaths = new Set(collectDirectoriesRecursive(rootPath));
    for (const [watchedPath, watcher] of watchers) {
      if (expectedPaths.has(watchedPath)) {
        continue;
      }

      watcher.close();
      watchers.delete(watchedPath);
    }

    for (const watchedPath of expectedPaths) {
      if (watchers.has(watchedPath)) {
        continue;
      }

      const watcher = watchPath(watchedPath, (eventType, fileName) => {
        const candidatePath = typeof fileName === 'string' && fileName.length > 0
          ? join(watchedPath, fileName)
          : watchedPath;
        if (eventType === 'rename') {
          syncWatchers();
        }
        scheduleModifyEvent(candidatePath);
      });
      watcher.on('error', () => {
        events.push({
          kind: 'other',
          path: watchedPath,
        });
        syncWatchers();
      });
      watchers.set(watchedPath, watcher);
    }
  };

  syncWatchers();

  try {
    while (true) {
      yield await events.shift();
    }
  } finally {
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    for (const watcher of watchers.values()) {
      watcher.close();
    }
  }
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        output,
      });
    });
  });
}

export function writeStdout(text: string): void {
  process.stdout.write(text);
}

export async function writeTextFile(path: string, text: string): Promise<void> {
  await writeFileAsync(path, text, 'utf8');
}

export function writeTextFileSync(path: string, text: string): void {
  writeFileSync(path, text, 'utf8');
}
