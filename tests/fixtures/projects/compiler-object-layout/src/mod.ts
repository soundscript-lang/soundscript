export function sum(a: number, b: number): number {
  return a + b;
}

type Bag = Record<string, number>;

type Pair = {
  10: number;
  2: number;
  tens: number;
  ones: number;
};

export function makePair(tens: number, ones: number): Pair {
  const pair: Pair = { tens, ones, 10: tens, 2: ones };
  return pair;
}

export function swapPair(pair: Pair): Pair {
  const swapped: Pair = { tens: pair.ones, ones: pair.tens, 10: pair.ones, 2: pair.tens };
  return swapped;
}

export function readPair(pair: Pair): number {
  return pair.tens * 10 + pair.ones;
}

export function scorePairMembership(pair: Pair): number {
  let score = 0;
  if ('tens' in pair) {
    score = score + 100;
  }
  if ('toString' in pair) {
    score = score + 10;
  }
  if ('missing' in pair) {
    score = score + 1;
  }
  return score;
}

export function pairToBag(pair: Pair): Bag {
  const bag: Bag = pair;
  return bag;
}

export function observeBagBoundary(bag: Bag): number {
  return 0;
}

export function setBagTens(bag: Bag, tens: number): Bag {
  const alias = bag;
  alias['tens'] = tens;
  alias[10] = tens;
  return alias;
}

export function readBag(bag: Bag): number {
  return (bag['tens'] ?? 0) * 10 + (bag['ones'] ?? 0);
}

export function scoreBagMembership(bag: Bag): number {
  let score = 0;
  if ('tens' in bag) {
    score = score + 100;
  }
  if ('toString' in bag) {
    score = score + 10;
  }
  if ('missing' in bag) {
    score = score + 1;
  }
  return score;
}

function tryMacro() {

}

export { tryMacro as try };
