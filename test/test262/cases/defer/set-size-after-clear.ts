export function main(): number {
  const set = new Set<number>();
  set.add(1);
  set.add(2);
  set.clear();
  set.add(3);
  return set.size;
}
