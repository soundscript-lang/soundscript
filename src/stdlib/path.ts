export type PathStyle = 'posix' | 'windows';

export interface PathOptions {
  readonly style?: PathStyle;
}

export interface ParsedPath {
  readonly root: string;
  readonly dir: string;
  readonly base: string;
  readonly ext: string;
  readonly name: string;
}

export interface PathApi {
  basename(path: string, extension?: string): string;
  dirname(path: string): string;
  extname(path: string): string;
  format(path: ParsedPath): string;
  isAbsolute(path: string): boolean;
  join(...parts: readonly string[]): string;
  normalize(path: string): string;
  parse(path: string): ParsedPath;
  relative(from: string, to: string): string;
}

const POSIX_SEPARATOR = '/';
const WINDOWS_SEPARATOR = '\\';

function separatorFor(style: PathStyle = 'posix'): string {
  return style === 'windows' ? WINDOWS_SEPARATOR : POSIX_SEPARATOR;
}

function splitSegments(path: string, style: PathStyle): string[] {
  const pattern = style === 'windows' ? /[\\/]+/u : /\/+/u;
  const prefix = rootPrefix(path, style);
  const withoutRoot = prefix ? path.slice(prefix.length) : path;
  return withoutRoot.split(pattern).filter((segment) => segment.length > 0 && segment !== '.');
}

function rootPrefix(path: string, style: PathStyle): string {
  if (style === 'windows') {
    const drive = /^[A-Za-z]:[\\/]/u.exec(path)?.[0];
    if (drive) {
      return drive.slice(0, 2) + WINDOWS_SEPARATOR;
    }
    return path.startsWith('\\\\') ? '\\\\' : '';
  }
  return path.startsWith(POSIX_SEPARATOR) ? POSIX_SEPARATOR : '';
}

export function isAbsolute(path: string, options: PathOptions = {}): boolean {
  const style = options.style ?? 'posix';
  if (style === 'windows') {
    return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\');
  }
  return path.startsWith(POSIX_SEPARATOR);
}

export function normalize(path: string, options: PathOptions = {}): string {
  const style = options.style ?? 'posix';
  const separator = separatorFor(style);
  const prefix = rootPrefix(path, style);
  const output: string[] = [];

  for (const segment of splitSegments(path, style)) {
    if (segment === '..') {
      if (output.length > 0 && output[output.length - 1] !== '..') {
        output.pop();
      } else if (!prefix) {
        output.push(segment);
      }
      continue;
    }
    output.push(segment);
  }

  const normalized = `${prefix}${output.join(separator)}`;
  return normalized || '.';
}

export function join(...parts: readonly string[]): string {
  return normalize(parts.filter((part) => part.length > 0).join(POSIX_SEPARATOR));
}

function joinWithStyle(style: PathStyle, ...parts: readonly string[]): string {
  const separator = separatorFor(style);
  return normalize(parts.filter((part) => part.length > 0).join(separator), { style });
}

export function dirname(path: string, options: PathOptions = {}): string {
  const normalized = normalize(path, options);
  const style = options.style ?? 'posix';
  const separator = separatorFor(style);
  const prefix = rootPrefix(normalized, style);
  const withoutTrailing = normalized.endsWith(separator) && normalized !== prefix
    ? normalized.slice(0, -1)
    : normalized;
  const index = withoutTrailing.lastIndexOf(separator);
  if (index < 0) {
    return '.';
  }
  if (index === 0 && prefix === separator) {
    return separator;
  }
  return withoutTrailing.slice(0, index) || '.';
}

export function basename(path: string, extension = '', options: PathOptions = {}): string {
  const style = options.style ?? 'posix';
  const segments = splitSegments(path, style);
  const base = segments[segments.length - 1] ?? '';
  return extension && base.endsWith(extension) ? base.slice(0, -extension.length) : base;
}

export function extname(path: string, options: PathOptions = {}): string {
  const base = basename(path, '', options);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index);
}

export function parse(path: string, options: PathOptions = {}): ParsedPath {
  const style = options.style ?? 'posix';
  const normalized = normalize(path, { style });
  const base = basename(normalized, '', { style });
  const ext = extname(base, { style });
  const dir = dirname(normalized, { style });

  return {
    root: rootPrefix(normalized, style),
    dir,
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
}

export function format(path: ParsedPath, options: PathOptions = {}): string {
  const style = options.style ?? 'posix';
  const separator = separatorFor(style);
  const base = path.base || `${path.name}${path.ext}`;
  if (path.dir) {
    return normalize(`${path.dir}${path.dir.endsWith(separator) ? '' : separator}${base}`, {
      style,
    });
  }
  return normalize(`${path.root}${base}`, { style });
}

export function relative(from: string, to: string, options: PathOptions = {}): string {
  const style = options.style ?? 'posix';
  const separator = separatorFor(style);
  const fromNormalized = normalize(from, { style });
  const toNormalized = normalize(to, { style });
  const fromRoot = rootPrefix(fromNormalized, style);
  const toRoot = rootPrefix(toNormalized, style);

  if (fromRoot.toLowerCase() !== toRoot.toLowerCase()) {
    return toNormalized;
  }

  const fromSegments = splitSegments(fromNormalized, style);
  const toSegments = splitSegments(toNormalized, style);
  let shared = 0;
  while (
    shared < fromSegments.length &&
    shared < toSegments.length &&
    fromSegments[shared] === toSegments[shared]
  ) {
    shared += 1;
  }

  const up = fromSegments.slice(shared).map(() => '..');
  const down = toSegments.slice(shared);
  const output = [...up, ...down].join(separator);
  return output || '.';
}

function createPathApi(style: PathStyle): PathApi {
  return Object.freeze({
    basename(path: string, extension = ''): string {
      return basename(path, extension, { style });
    },
    dirname(path: string): string {
      return dirname(path, { style });
    },
    extname(path: string): string {
      return extname(path, { style });
    },
    format(path: ParsedPath): string {
      return format(path, { style });
    },
    isAbsolute(path: string): boolean {
      return isAbsolute(path, { style });
    },
    join(...parts: readonly string[]): string {
      return joinWithStyle(style, ...parts);
    },
    normalize(path: string): string {
      return normalize(path, { style });
    },
    parse(path: string): ParsedPath {
      return parse(path, { style });
    },
    relative(from: string, to: string): string {
      return relative(from, to, { style });
    },
  });
}

export const posix = createPathApi('posix');
export const windows = createPathApi('windows');

export const Path = Object.freeze({
  basename,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  posix,
  windows,
});
