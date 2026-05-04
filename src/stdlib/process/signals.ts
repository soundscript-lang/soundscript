import { onSignal } from 'sts:process';

export type { SignalName } from 'sts:process';
export { onSignal };

export const Signals = Object.freeze({
  onSignal,
});
