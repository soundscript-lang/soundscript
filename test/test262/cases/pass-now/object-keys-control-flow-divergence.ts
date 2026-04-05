type Mixed = { zebra: number; 2: number; apple: number; 1: number };
type KeyView = { length: number };

export function main(flag: boolean, left: number, right: number): number {
  let mixed: Mixed = { zebra: left, 2: right, apple: left, 1: right };
  if (flag) {
    mixed = { apple: right, zebra: left, 1: left, 2: right };
  }
  const keys: KeyView = Object.keys(mixed);
  return keys.length;
}
