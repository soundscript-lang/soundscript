export type PathStyle = 'posix' | 'windows';

export interface PathOptions {
  readonly style?: PathStyle;
}

const POSIX_SEPARATOR = '/';
const WINDOWS_SEPARATOR = '\\';

function separatorFor(style: PathStyle = 'posix'): string {
  return style === 'windows' ? WINDOWS_SEPARATOR : POSIX_SEPARATOR;
}

function splitSegments(path: string, style: PathStyle): string[] {
  const pattern = style === 'windows' ? /[\\/]+/u : /\/+/u;
  return path.split(pattern).filter((segment) => segment.length > 0 && segment !== '.');
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

export const Path = Object.freeze({
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
});
