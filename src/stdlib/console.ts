export type ConsoleValue = unknown;

export interface Console {
  assert(condition?: boolean, ...values: readonly ConsoleValue[]): void;
  debug(...values: readonly ConsoleValue[]): void;
  error(...values: readonly ConsoleValue[]): void;
  info(...values: readonly ConsoleValue[]): void;
  log(...values: readonly ConsoleValue[]): void;
  trace(...values: readonly ConsoleValue[]): void;
  warn(...values: readonly ConsoleValue[]): void;
}

const noop = (): void => {};

const fallbackConsole: Console = {
  assert: noop,
  debug: noop,
  error: noop,
  info: noop,
  log: noop,
  trace: noop,
  warn: noop,
};

export const console: Console = globalThis.console ?? fallbackConsole;

export function assert(condition?: boolean, ...values: readonly ConsoleValue[]): void {
  console.assert(condition, ...values);
}

export function debug(...values: readonly ConsoleValue[]): void {
  console.debug(...values);
}

export function error(...values: readonly ConsoleValue[]): void {
  console.error(...values);
}

export function info(...values: readonly ConsoleValue[]): void {
  console.info(...values);
}

export function log(...values: readonly ConsoleValue[]): void {
  console.log(...values);
}

export function trace(...values: readonly ConsoleValue[]): void {
  console.trace(...values);
}

export function warn(...values: readonly ConsoleValue[]): void {
  console.warn(...values);
}
