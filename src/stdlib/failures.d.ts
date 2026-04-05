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
    message?: string,
    options?: {
      cause?: unknown;
      trace?: readonly ErrorFrame[];
    },
  );
  withFrame(frame: ErrorFrame): this;
}

export function normalizeThrown(value: unknown): Error;
