export function main(): number {
  const set = new Set<number>();
  set.add(1);
  set.clear();
  set.add(2);
  return set.size;
}
