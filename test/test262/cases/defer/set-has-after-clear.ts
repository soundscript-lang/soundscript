export function main(): boolean {
  const set = new Set<number>();
  set.add(1);
  set.clear();
  return set.has(1);
}
