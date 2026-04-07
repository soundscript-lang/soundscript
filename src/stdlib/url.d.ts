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
  new(
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
  new(url: string, base?: string | URL): URL;
};
