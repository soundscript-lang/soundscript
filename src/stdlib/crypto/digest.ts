import { digest } from 'sts:crypto';

export type { DigestAlgorithm } from 'sts:crypto';
export { digest };

export const Digest = Object.freeze({
  digest,
});
