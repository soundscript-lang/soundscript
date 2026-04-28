import { Failure } from 'sts:failures';
import { err, ok, type Result } from 'sts:result';

export type CapabilityStatus = 'available' | 'unavailable';

export interface CapabilityInfo {
  readonly name: string;
  readonly status: CapabilityStatus;
  readonly reason?: string;
}

interface CapabilityManifestGlobal {
  __soundscriptCapabilities__?: readonly CapabilityInfo[];
}

export class UnsupportedCapabilityFailure extends Failure {
  readonly capability: string;

  constructor(capability: string, reason?: string) {
    super(
      reason
        ? `Unsupported capability ${capability}: ${reason}`
        : `Unsupported capability ${capability}.`,
    );
    this.capability = capability;
  }
}

function isNodeRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & {
    process?: { versions?: { node?: string } };
  };
  return typeof runtime.process?.versions?.node === 'string';
}

function defaultManifest(): readonly CapabilityInfo[] {
  const hasFetch = typeof globalThis.fetch === 'function';
  const hasCrypto = globalThis.crypto !== undefined;
  const hasTextCodec = typeof globalThis.TextEncoder === 'function' &&
    typeof globalThis.TextDecoder === 'function';
  const node = isNodeRuntime();

  return [
    { name: 'platform.console', status: 'available' },
    {
      name: 'platform.fetch',
      status: hasFetch ? 'available' : 'unavailable',
      reason: hasFetch ? undefined : 'global fetch is not available',
    },
    {
      name: 'platform.streams',
      status: typeof globalThis.ReadableStream === 'function' &&
          typeof globalThis.WritableStream === 'function'
        ? 'available'
        : 'unavailable',
      reason: typeof globalThis.ReadableStream === 'function' &&
          typeof globalThis.WritableStream === 'function'
        ? undefined
        : 'Web Streams globals are not available',
    },
    {
      name: 'platform.text',
      status: hasTextCodec ? 'available' : 'unavailable',
      reason: hasTextCodec ? undefined : 'TextEncoder or TextDecoder is not available',
    },
    {
      name: 'platform.crypto.random',
      status: hasCrypto ? 'available' : 'unavailable',
      reason: hasCrypto ? undefined : 'global crypto is not available',
    },
    { name: 'console', status: 'available' },
    { name: 'time', status: 'available' },
    { name: 'path', status: 'available' },
    {
      name: 'streams',
      status: typeof globalThis.ReadableStream === 'function' &&
          typeof globalThis.WritableStream === 'function'
        ? 'available'
        : 'unavailable',
      reason: typeof globalThis.ReadableStream === 'function' &&
          typeof globalThis.WritableStream === 'function'
        ? undefined
        : 'Web Streams globals are not available',
    },
    { name: 'bytes', status: hasTextCodec ? 'available' : 'unavailable' },
    { name: 'concurrency.task', status: 'available' },
    {
      name: 'concurrency.runtime',
      status: node ? 'available' : 'unavailable',
      reason: node ? undefined : 'requires a JavaScript host with async context support',
    },
    {
      name: 'fetch',
      status: hasFetch ? 'available' : 'unavailable',
      reason: hasFetch ? undefined : 'global fetch is not available',
    },
    {
      name: 'random',
      status: hasCrypto ? 'available' : 'unavailable',
      reason: hasCrypto ? undefined : 'global crypto is not available',
    },
    {
      name: 'fs',
      status: node ? 'available' : 'unavailable',
      reason: node ? undefined : 'requires a node-family provider',
    },
    {
      name: 'env',
      status: node ? 'available' : 'unavailable',
      reason: node ? undefined : 'requires a node-family provider',
    },
    {
      name: 'cli',
      status: node ? 'available' : 'unavailable',
      reason: node ? undefined : 'requires a node-family provider',
    },
    {
      name: 'process',
      status: node ? 'available' : 'unavailable',
      reason: node ? undefined : 'requires a node-family provider',
    },
    {
      name: 'net.dns',
      status: node ? 'available' : 'unavailable',
      reason: node ? undefined : 'requires a node-family provider',
    },
    {
      name: 'net.tcp',
      status: node ? 'available' : 'unavailable',
      reason: node ? undefined : 'requires a node-family provider',
    },
    {
      name: 'http.server',
      status: node ? 'available' : 'unavailable',
      reason: node ? undefined : 'requires a node-family provider',
    },
  ];
}

function manifest(): readonly CapabilityInfo[] {
  return (globalThis as typeof globalThis & CapabilityManifestGlobal).__soundscriptCapabilities__ ??
    defaultManifest();
}

export function list(): readonly CapabilityInfo[] {
  return manifest();
}

export function get(name: string): CapabilityInfo | undefined {
  return manifest().find((capability) => capability.name === name);
}

export function hasCapability(name: string): boolean {
  return get(name)?.status === 'available';
}

export function requireCapability(name: string): Result<void, UnsupportedCapabilityFailure> {
  const capability = get(name);
  if (capability?.status === 'available') {
    return ok(undefined);
  }

  return err(new UnsupportedCapabilityFailure(name, capability?.reason));
}

export const Capabilities = Object.freeze({
  list,
  get,
  has: hasCapability,
  require: requireCapability,
});
