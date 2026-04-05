export function main(): number {
  const set = new Set<number>();
  set.add(1);
  set.delete(2);
  return set.size;
}
