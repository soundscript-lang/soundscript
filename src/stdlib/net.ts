import { lookup as nodeLookup } from 'node:dns/promises';

import { Failure, normalizeThrown } from 'sts:failures';
import { err, ok } from 'sts:result';
import type { AsyncResult } from 'sts:concurrency/task';

export interface DnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

function failureFromUnknown(value: unknown): Failure {
  if (value instanceof Failure) {
    return value;
  }
  const normalized = normalizeThrown(value);
  return new Failure(normalized.message, { cause: normalized });
}

export async function lookup(hostname: string): AsyncResult<DnsAddress, Failure> {
  try {
    const result = await nodeLookup(hostname);
    return ok({ address: result.address, family: result.family as 4 | 6 });
  } catch (error) {
    return err(failureFromUnknown(error));
  }
}

export const Net = Object.freeze({
  lookup,
});
