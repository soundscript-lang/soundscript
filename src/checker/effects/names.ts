import type { EffectNameFact, EffectRewriteFact } from '../engine/types.ts';
import { INTERNAL_EFFECT_MASKS, PUBLIC_EFFECT_MASKS } from './masks.ts';

function effectNameSegmentCount(name: string): number {
  return name === '' ? 0 : name.split('.').length;
}

export function effectNamesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

export function normalizeEffectNames(effectNames: readonly string[]): readonly EffectNameFact[] {
  const unique = [...new Set(effectNames.filter((name) => name.length > 0))].sort((left, right) =>
    effectNameSegmentCount(left) - effectNameSegmentCount(right) || left.localeCompare(right)
  );
  const normalized: EffectNameFact[] = [];
  for (const effectName of unique) {
    if (
      normalized.some((existing) =>
        effectNamesOverlap(existing, effectName) && existing !== effectName
      )
    ) {
      continue;
    }
    normalized.push(effectName);
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

export function effectSetsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some((leftName) =>
    right.some((rightName) => effectNamesOverlap(leftName, rightName))
  );
}

export function subtractEffectSet(
  source: readonly string[],
  removed: readonly string[],
): readonly EffectNameFact[] {
  return normalizeEffectNames(
    source.filter((effectName) =>
      !removed.some((removedEffect) => effectNamesOverlap(effectName, removedEffect))
    ),
  );
}

export function applyEffectRewrites(
  effectNames: readonly string[],
  rewrites: readonly EffectRewriteFact[],
  handledEffects: readonly string[],
): readonly EffectNameFact[] {
  const rewritten = effectNames.map((effectName) => {
    let current = effectName;
    for (const rewrite of rewrites) {
      if (effectNamesOverlap(current, rewrite.from)) {
        current = rewrite.to;
      }
    }
    return current;
  });
  return normalizeEffectNames(
    rewritten.filter((effectName) =>
      !handledEffects.some((handledEffect) => effectNamesOverlap(effectName, handledEffect))
    ),
  );
}

export function effectNamesToMask(effectNames: readonly string[]): number {
  let mask = 0;
  for (const effectName of effectNames) {
    if (effectName === 'fails') {
      mask |= PUBLIC_EFFECT_MASKS.fails;
      continue;
    }
    if (effectNamesOverlap(effectName, 'fails.throws')) {
      mask |= INTERNAL_EFFECT_MASKS.failsThrows;
      continue;
    }
    if (effectNamesOverlap(effectName, 'fails.rejects')) {
      mask |= INTERNAL_EFFECT_MASKS.failsRejects;
      continue;
    }
    if (effectNamesOverlap(effectName, 'fails')) {
      mask |= PUBLIC_EFFECT_MASKS.fails;
      continue;
    }
    if (
      effectNamesOverlap(effectName, 'suspend.await') ||
      effectNamesOverlap(effectName, 'suspend.yield') ||
      effectNamesOverlap(effectName, 'suspend')
    ) {
      mask |= INTERNAL_EFFECT_MASKS.suspend;
      continue;
    }
    if (effectNamesOverlap(effectName, 'mut')) {
      mask |= INTERNAL_EFFECT_MASKS.mut;
      continue;
    }
    if (effectName === 'host') {
      mask |= PUBLIC_EFFECT_MASKS.host;
      continue;
    }
    if (effectNamesOverlap(effectName, 'host.browser.dom')) {
      mask |= INTERNAL_EFFECT_MASKS.hostDom;
      continue;
    }
    if (effectNamesOverlap(effectName, 'host.io')) {
      mask |= INTERNAL_EFFECT_MASKS.hostIo;
      continue;
    }
    if (effectNamesOverlap(effectName, 'host.random')) {
      mask |= INTERNAL_EFFECT_MASKS.hostRandom;
      continue;
    }
    if (effectNamesOverlap(effectName, 'host.time')) {
      mask |= INTERNAL_EFFECT_MASKS.hostTime;
      continue;
    }
    if (
      effectNamesOverlap(effectName, 'host.system') || effectNamesOverlap(effectName, 'host.ffi') ||
      effectNamesOverlap(effectName, 'host.browser.message')
    ) {
      mask |= INTERNAL_EFFECT_MASKS.hostInterop;
    }
  }
  return mask;
}

export function maskToStandardEffectNames(mask: number): readonly EffectNameFact[] {
  const effectNames: string[] = [];
  if ((mask & INTERNAL_EFFECT_MASKS.failsThrows) !== 0) {
    effectNames.push('fails.throws');
  }
  if ((mask & INTERNAL_EFFECT_MASKS.failsRejects) !== 0) {
    effectNames.push('fails.rejects');
  }
  if ((mask & INTERNAL_EFFECT_MASKS.hostDom) !== 0) {
    effectNames.push('host.browser.dom');
  }
  if ((mask & INTERNAL_EFFECT_MASKS.hostIo) !== 0) {
    effectNames.push('host.io');
  }
  if ((mask & INTERNAL_EFFECT_MASKS.hostRandom) !== 0) {
    effectNames.push('host.random');
  }
  if ((mask & INTERNAL_EFFECT_MASKS.hostTime) !== 0) {
    effectNames.push('host.time');
  }
  if ((mask & INTERNAL_EFFECT_MASKS.hostInterop) !== 0) {
    effectNames.push('host.ffi');
  }
  if ((mask & INTERNAL_EFFECT_MASKS.mut) !== 0) {
    effectNames.push('mut');
  }
  if ((mask & INTERNAL_EFFECT_MASKS.suspend) !== 0) {
    effectNames.push('suspend.await');
  }
  return normalizeEffectNames(effectNames);
}
