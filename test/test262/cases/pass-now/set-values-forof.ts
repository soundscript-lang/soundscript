export function main(): number {
  const set = new Set<number>();
  set.add(2);
  set.add(3);

  let total = 0;
  for (const value of set.values()) {
    total += value;
  }

  return total;
}
