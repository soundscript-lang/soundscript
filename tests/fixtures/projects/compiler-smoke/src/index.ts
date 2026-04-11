import {
  makePair,
  observeBagBoundary,
  pairToBag,
  readBag,
  scoreBagMembership,
  scorePairMembership,
  setBagTens,
  sum,
  swapPair,
} from './mod';

type KeyView = { length: number };
type KeyPreview = { 10: number; 2: number; tens: number; ones: number };
type KeyBag = Record<string, number>;

export function main(
  startTens: number,
  startOnes: number,
  nextTens: number,
  nextOnes: number,
  takeDirectBranch: boolean,
): number {
  const preview: KeyPreview = { tens: startTens, ones: startOnes, 10: startTens, 2: startOnes };
  const specializedKeys: KeyView = Object.keys(preview);
  const fallbackPreview: KeyBag = preview;
  const crossedPreviewBoundary = observeBagBoundary(fallbackPreview);
  const fallbackKeys: KeyView = Object.keys(fallbackPreview);
  const start = makePair(startTens, startOnes);
  const specializedMembership = scorePairMembership(start);
  const computedTens = sum(nextTens, 0);
  let current = makePair(nextOnes, nextTens);
  if (takeDirectBranch) {
    current = makePair(computedTens, nextOnes);
  }
  const mirrored = swapPair(current);
  const bag = pairToBag(mirrored);
  const adjusted = setBagTens(bag, startTens);
  const fallbackMembership = scoreBagMembership(adjusted);

  return specializedMembership * 10000 +
    crossedPreviewBoundary * 10 +
    fallbackMembership * 100 +
    readBag(adjusted);
}
