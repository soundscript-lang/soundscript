import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

interface ProcessLike {
  readonly argv?: readonly string[];
  readonly stdin?: {
    setEncoding?(encoding: string): void;
    on(event: 'data', listener: (chunk: string) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (error: unknown) => void): void;
  };
}

function nodeProcess(): ProcessLike | undefined {
  return (globalThis as typeof globalThis & { process?: ProcessLike }).process;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

export function args(): Result<readonly string[], Failure> {
  try {
    return ok([...(nodeProcess()?.argv?.slice(2) ?? [])]);
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export function readStdinText(): Promise<Result<string, Failure>> {
  return new Promise((resolve) => {
    const stdin = nodeProcess()?.stdin;
    if (!stdin) {
      resolve(err(new Failure('stdin is unavailable.')));
      return;
    }

    let text = '';
    stdin.setEncoding?.('utf8');
    stdin.on('data', (chunk) => {
      text += chunk;
    });
    stdin.on('end', () => resolve(ok(text)));
    stdin.on('error', (error) => resolve(err(failureFromUnknown(error))));
  });
}

export const Cli = Object.freeze({
  args,
  readStdinText,
});
