export function main(): number {
  const set = new Set<number>();
  set.add(1);
  set.clear();
  return set.size;
}
