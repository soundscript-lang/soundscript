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

function available(name: string): CapabilityInfo {
  return { name, status: 'available' };
}

function unavailable(name: string, reason: string): CapabilityInfo {
  return { name, status: 'unavailable', reason };
}

function capability(name: string, condition: boolean, reason: string): CapabilityInfo {
  return condition ? available(name) : unavailable(name, reason);
}

function defaultManifest(): readonly CapabilityInfo[] {
  const hasUrl = typeof globalThis.URL === 'function';
  const hasFetch = typeof globalThis.fetch === 'function';
  const hasCrypto = globalThis.crypto !== undefined;
  const hasSubtleCrypto = globalThis.crypto?.subtle !== undefined;
  const hasTextCodec = typeof globalThis.TextEncoder === 'function' &&
    typeof globalThis.TextDecoder === 'function';
  const hasStreams = typeof globalThis.ReadableStream === 'function' &&
    typeof globalThis.WritableStream === 'function';
  const hasTimer = typeof setTimeout === 'function' && typeof clearTimeout === 'function';
  const hasSharedMemory = typeof SharedArrayBuffer === 'function' &&
    typeof Atomics === 'object';
  const node = isNodeRuntime();
  const nodeReason = 'requires a node-family provider';

  return [
    capability('platform.url', hasUrl, 'URL globals are not available'),
    available('platform.console'),
    capability('platform.fetch', hasFetch, 'global fetch is not available'),
    capability('platform.streams', hasStreams, 'Web Streams globals are not available'),
    capability('platform.text', hasTextCodec, 'TextEncoder or TextDecoder is not available'),
    capability('platform.crypto.random', hasCrypto, 'global crypto is not available'),
    capability('platform.crypto.subtle', hasSubtleCrypto, 'global crypto.subtle is not available'),
    available('console'),
    available('time'),
    available('time.clock.wall'),
    available('time.clock.monotonic'),
    capability('time.timer', hasTimer, 'timer globals are not available'),
    available('path'),
    available('bytes'),
    capability('bytes.shared', hasSharedMemory, 'SharedArrayBuffer or Atomics is not available'),
    available('concurrency.task'),
    capability(
      'concurrency.runtime',
      node,
      'requires a JavaScript host with async context support',
    ),
    capability('fetch', hasFetch, 'global fetch is not available'),
    capability('streams', hasStreams, 'Web Streams globals are not available'),
    capability('text', hasTextCodec, 'TextEncoder or TextDecoder is not available'),
    capability('random', hasCrypto, 'global crypto is not available'),
    capability('crypto', hasCrypto && hasSubtleCrypto, 'global crypto.subtle is not available'),
    capability('crypto.random', hasCrypto, 'global crypto is not available'),
    capability('crypto.digest', hasSubtleCrypto, 'global crypto.subtle is not available'),
    capability('crypto.hmac', hasSubtleCrypto, 'global crypto.subtle is not available'),
    capability('fs', node, nodeReason),
    capability('fs.read', node, nodeReason),
    capability('fs.write', node, nodeReason),
    capability('fs.metadata', node, nodeReason),
    capability('env', node, nodeReason),
    capability('env.read', node, nodeReason),
    capability('env.write', node, nodeReason),
    capability('cli', node, nodeReason),
    capability('cli.args', node, nodeReason),
    capability('cli.stdio', node, nodeReason),
    capability('process', node, nodeReason),
    capability('process.info', node, nodeReason),
    capability('process.cwd', node, nodeReason),
    capability('process.child', node, nodeReason),
    capability('process.spawn', node, nodeReason),
    capability('process.command', node, nodeReason),
    capability('process.signal', node, nodeReason),
    capability('net', node, nodeReason),
    capability('net.dns', node, nodeReason),
    capability('net.tcp', node, nodeReason),
    capability('net.tls', node, nodeReason),
    capability('http.server', node, nodeReason),
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
