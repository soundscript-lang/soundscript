import { UnsupportedCapabilityFailure } from 'sts:capabilities';
import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

export interface URLSearchParams {
  // #[effects(add: [mut])]
  append(name: string, value: string): void;
  // #[effects(add: [mut])]
  delete(name: string): void;
  // #[effects(add: [])]
  entries(): IterableIterator<[string, string]>;
  // #[effects(add: [])]
  get(name: string): string | null;
  // #[effects(add: [])]
  has(name: string): boolean;
  // #[effects(add: [])]
  keys(): IterableIterator<string>;
  // #[effects(add: [mut])]
  set(name: string, value: string): void;
  // #[effects(add: [])]
  toString(): string;
  // #[effects(add: [])]
  values(): IterableIterator<string>;
  // #[effects(add: [])]
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

export const URLSearchParams: {
  // #[effects(add: [])]
  new (
    init?:
      | Iterable<readonly [string, string]>
      | Record<string, string>
      | string
      | URLSearchParams,
  ): URLSearchParams;
} = globalThis.URLSearchParams as unknown as {
  new (
    init?:
      | Iterable<readonly [string, string]>
      | Record<string, string>
      | string
      | URLSearchParams,
  ): URLSearchParams;
};

export interface URL {
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  // #[effects(add: [])]
  toJSON(): string;
  // #[effects(add: [])]
  toString(): string;
}

export const URL: {
  // #[effects(add: [fails.throws])]
  new (url: string, base?: string | URL): URL;
} = globalThis.URL as unknown as {
  new (url: string, base?: string | URL): URL;
};

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

function unsupportedFilePathConversion(): UnsupportedCapabilityFailure {
  return new UnsupportedCapabilityFailure(
    'url.filePath',
    'file URL path conversion requires a target path provider',
  );
}

export function parseUrl(input: string, base?: string | URL): Result<URL, Failure> {
  try {
    return ok(new URL(input, base));
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function canParseUrl(input: string, base?: string | URL): boolean {
  const maybeCanParse = (
    URL as typeof URL & { readonly canParse?: (input: string, base?: string | URL) => boolean }
  ).canParse;
  if (maybeCanParse) {
    return maybeCanParse(input, base);
  }
  return parseUrl(input, base).tag === 'ok';
}

export function fileUrlToPath(url: URL): Result<string, Failure> {
  if (url.protocol !== 'file:') {
    return err(new Failure('Expected a file: URL.'));
  }
  return err(unsupportedFilePathConversion());
}

export function pathToFileUrl(path: string): Result<URL, Failure> {
  if (path.length === 0) {
    return err(new Failure('Path must not be empty.'));
  }
  return err(unsupportedFilePathConversion());
}

export const Url = Object.freeze({
  URL,
  URLSearchParams,
  parseUrl,
  canParseUrl,
  fileUrlToPath,
  pathToFileUrl,
});
