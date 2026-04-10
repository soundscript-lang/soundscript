type Bag = Record<string, number>;
type KeyView = { length: number };

export function main(left: number, right: number): number {
  const bag: Bag = { apple: left, zebra: right, 1e3: left, 2: right };
  const keys: KeyView = Object.keys(bag);
  return keys.length;
}
