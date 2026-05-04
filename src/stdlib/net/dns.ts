import { lookup, lookupHost } from 'sts:net';

export type { DnsAddress, IpAddress, OperationOptions } from 'sts:net';
export { lookup, lookupHost };

export const Dns = Object.freeze({
  lookup,
  lookupHost,
});
