export function main(): boolean {
  const set = new Set<number>();
  set.add(1);
  return set.delete(1);
}
