import { runtimeEnv } from '../platform/host.ts';

const LSP_TIMING_ENV_VAR = 'SOUNDSCRIPT_LSP_TIMING';
const DEFAULT_LSP_TIMING_THRESHOLD_MS = 25;

export interface LspTimingMetadata {
  [key: string]: boolean | number | string | undefined;
}

interface LspTimingOptions {
  always?: boolean;
  enabled?: boolean;
  thresholdMs?: number;
}

export function isLspTimingEnabled(
  rawValue = runtimeEnv(LSP_TIMING_ENV_VAR),
): boolean {
  return rawValue === '1' || rawValue === 'true';
}

function formatMetadata(metadata: LspTimingMetadata): string {
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

export function logLspTiming(
  operation: string,
  durationMs: number,
  metadata: LspTimingMetadata = {},
  options: LspTimingOptions = {},
): void {
  const enabled = options.enabled ?? isLspTimingEnabled();
  if (!enabled) {
    return;
  }

  const thresholdMs = options.thresholdMs ?? DEFAULT_LSP_TIMING_THRESHOLD_MS;
  if (!options.always && durationMs < thresholdMs) {
    return;
  }

  const metadataText = formatMetadata(metadata);
  const prefix = `[soundscript:lsp] ${operation} ${durationMs.toFixed(1)}ms`;
  console.error(metadataText.length > 0 ? `${prefix} ${metadataText}` : prefix);
}

export function measureLspTiming<T>(
  operation: string,
  metadata: LspTimingMetadata,
  fn: () => T,
  options: LspTimingOptions = {},
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    logLspTiming(operation, performance.now() - start, metadata, options);
  }
}

export async function measureLspTimingAsync<T>(
  operation: string,
  metadata: LspTimingMetadata,
  fn: () => Promise<T>,
  options: LspTimingOptions = {},
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    logLspTiming(operation, performance.now() - start, metadata, options);
  }
}
