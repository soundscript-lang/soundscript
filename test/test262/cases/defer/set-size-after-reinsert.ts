export function main(): number {
  const set = new Set<number>([1, 2]);
  set.clear();
  set.add(3);
  set.add(4);
  return set.size;
}
