export function main(): number {
  const set = new Set<number>();
  set.add(0);
  set.delete(0);
  return set.size;
}
