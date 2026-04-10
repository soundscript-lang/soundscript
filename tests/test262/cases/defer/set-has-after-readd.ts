export function main(): boolean {
  const set = new Set<number>();
  set.add(1);
  set.delete(1);
  set.add(1);
  return set.has(1);
}
