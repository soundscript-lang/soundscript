import type { PublicEffectName } from '../engine/types.ts';

export const INTERNAL_EFFECT_MASKS = {
  failsRejects: 1 << 0,
  failsThrows: 1 << 1,
  hostDom: 1 << 2,
  hostInterop: 1 << 3,
  hostIo: 1 << 4,
  hostRandom: 1 << 5,
  hostTime: 1 << 6,
  mut: 1 << 7,
  suspend: 1 << 8,
} as const;

export const PUBLIC_EFFECT_NAMES = ['fails', 'host', 'mut', 'suspend'] as const satisfies
  readonly PublicEffectName[];

export const PUBLIC_EFFECT_MASKS: Readonly<Record<PublicEffectName, number>> = {
  fails: INTERNAL_EFFECT_MASKS.failsRejects | INTERNAL_EFFECT_MASKS.failsThrows,
  host: INTERNAL_EFFECT_MASKS.hostDom | INTERNAL_EFFECT_MASKS.hostInterop |
    INTERNAL_EFFECT_MASKS.hostIo | INTERNAL_EFFECT_MASKS.hostRandom | INTERNAL_EFFECT_MASKS.hostTime,
  mut: INTERNAL_EFFECT_MASKS.mut,
  suspend: INTERNAL_EFFECT_MASKS.suspend,
};

export function isPublicEffectName(name: string): name is PublicEffectName {
  return PUBLIC_EFFECT_NAMES.includes(name as PublicEffectName);
}

export function effectMaskFromPublicName(name: PublicEffectName): number {
  return PUBLIC_EFFECT_MASKS[name];
}

export function effectMaskToPublicNames(mask: number): readonly PublicEffectName[] {
  return PUBLIC_EFFECT_NAMES.filter((name) => (mask & PUBLIC_EFFECT_MASKS[name]) !== 0);
}
