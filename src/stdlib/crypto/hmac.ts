import { hmac } from 'sts:crypto';

export type { HmacAlgorithm } from 'sts:crypto';
export { hmac };

export const Hmac = Object.freeze({
  hmac,
});
