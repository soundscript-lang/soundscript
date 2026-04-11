export function main(): number {
  const set = new Set<number>();
  set.add(32);
  set.add(33);
  return set.size;
}
