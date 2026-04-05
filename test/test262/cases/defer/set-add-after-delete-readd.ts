export function main(): number {
  const set = new Set<number>();
  set.add(1);
  set.delete(1);
  set.add(1);
  return set.size;
}
