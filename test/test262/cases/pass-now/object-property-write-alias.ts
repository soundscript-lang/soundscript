type Bag = Record<string, number>;

export function main(value: number): number {
  const bag: Bag = { left: 0, right: 7 };
  const alias = bag;
  alias.left = value;
  return bag.left * 100 + alias.right * 10 + bag.left;
}
