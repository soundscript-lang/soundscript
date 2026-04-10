type Pair = { left: number; right: number };
type Bag = Record<string, number>;

export function main(left: number, right: number): number {
  const pair: Pair = { left, right };
  const bag: Bag = pair;
  let score = 0;
  if ('left' in bag) {
    score = score + 100;
  }
  if ('right' in bag) {
    score = score + 10;
  }
  if ('missing' in bag) {
    score = score + 1;
  }
  return score;
}
