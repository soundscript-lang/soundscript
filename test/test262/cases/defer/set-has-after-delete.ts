export function main(): boolean {
  const set = new Set<undefined>();
  set.add(undefined);
  set.delete(undefined);
  return set.has(undefined);
}
