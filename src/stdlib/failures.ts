export type ErrorFrame = {
  readonly column: number;
  readonly file: string;
  readonly fn?: string;
  readonly line: number;
};

export class Failure {
  readonly cause?: unknown;
  readonly message: string;
  readonly name: string;
  readonly trace: readonly ErrorFrame[];

  constructor(
    message = '',
    options: {
      cause?: unknown;
      trace?: readonly ErrorFrame[];
    } = {},
  ) {
    this.name = new.target.name;
    this.message = message;
    if ('cause' in options) {
      this.cause = options.cause;
    }
    this.trace = options.trace ?? [];
  }

  withFrame(frame: ErrorFrame): this {
    const prototype = Object.getPrototypeOf(this as object);
    const clone = (prototype === null ? Object.create(null) : Object.create(prototype)) as this;
    Object.defineProperties(clone, Object.getOwnPropertyDescriptors(this));
    Object.defineProperty(clone, 'trace', {
      configurable: true,
      enumerable: true,
      writable: false,
      value: [...this.trace, frame],
    });
    return clone;
  }
}

export function normalizeThrown(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  const details = typeof value === 'object' && value !== null
    ? value as { message?: unknown; name?: unknown; stack?: unknown }
    : undefined;
  const message = typeof details?.message === 'string'
    ? details.message
    : 'Non-Error thrown value.';
  const error = new Error(message, { cause: value });

  if (typeof details?.name === 'string') {
    error.name = details.name;
  }
  if (typeof details?.stack === 'string') {
    error.stack = details.stack;
  }

  return error;
}
