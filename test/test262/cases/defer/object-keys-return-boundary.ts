type Bag = Record<string, number>;
type KeyView = { length: number };

function expose(bag: Bag): Bag {
  return bag;
}

export function main(left: number, right: number): number {
  const bag: Bag = { apple: left, zebra: right, 1e3: left, 2: right };
  const keys: KeyView = Object.keys(expose(bag));
  return keys.length;
}
