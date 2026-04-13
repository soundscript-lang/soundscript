const CHECKER_TIMING_ENV_VAR = 'SOUNDSCRIPT_CHECKER_TIMING';
const DEFAULT_CHECKER_TIMING_THRESHOLD_MS = 25;

export interface CheckerTimingMetadata {
  [key: string]: boolean | number | string | undefined;
}

interface CheckerTimingOptions {
  always?: boolean;
  enabled?: boolean;
  thresholdMs?: number;
}

function getTimingEnvValue(): string | undefined {
  if (typeof process !== 'undefined' && typeof process.env === 'object') {
    const processValue = process.env[CHECKER_TIMING_ENV_VAR];
    if (typeof processValue === 'string') {
      return processValue;
    }
  }

  const maybeDeno = globalThis as {
    Deno?: {
      env?: {
        get(name: string): string | undefined;
      };
    };
  };
  return maybeDeno.Deno?.env?.get(CHECKER_TIMING_ENV_VAR);
}

export function getCheckerTimingEnvValue(name: string): string | undefined {
  if (typeof process !== 'undefined' && typeof process.env === 'object') {
    const processValue = process.env[name];
    if (typeof processValue === 'string') {
      return processValue;
    }
  }

  const maybeDeno = globalThis as {
    Deno?: {
      env?: {
        get(name: string): string | undefined;
      };
    };
  };
  return maybeDeno.Deno?.env?.get(name);
}

export function isCheckerTimingEnabled(
  rawValue = getTimingEnvValue(),
): boolean {
  return rawValue === '1' || rawValue === 'true';
}

export function isCheckerTimingFlagEnabled(name: string): boolean {
  const rawValue = getCheckerTimingEnvValue(name);
  return rawValue === '1' || rawValue === 'true';
}

function formatMetadata(metadata: CheckerTimingMetadata): string {
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

export function logCheckerTiming(
  operation: string,
  durationMs: number,
  metadata: CheckerTimingMetadata = {},
  options: CheckerTimingOptions = {},
): void {
  const enabled = options.enabled ?? isCheckerTimingEnabled();
  if (!enabled) {
    return;
  }

  const thresholdMs = options.thresholdMs ?? DEFAULT_CHECKER_TIMING_THRESHOLD_MS;
  if (!options.always && durationMs < thresholdMs) {
    return;
  }

  const metadataText = formatMetadata(metadata);
  const prefix = `[soundscript:checker] ${operation} ${durationMs.toFixed(1)}ms`;
  console.error(metadataText.length > 0 ? `${prefix} ${metadataText}` : prefix);
}

export function measureCheckerTiming<T>(
  operation: string,
  metadata: CheckerTimingMetadata,
  fn: () => T,
  options: CheckerTimingOptions = {},
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    logCheckerTiming(operation, performance.now() - start, metadata, options);
  }
}
