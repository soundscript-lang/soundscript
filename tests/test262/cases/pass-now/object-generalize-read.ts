type Pair = { left: number; right: number };
type Bag = Record<string, number>;

export function main(left: number, right: number): number {
  const pair: Pair = { left, right };
  const bag: Bag = pair;
  return bag.left * 100 + bag.right * 10 + bag.left;
}
