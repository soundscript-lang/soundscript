export function main(): boolean {
  const set = new Set<number>();
  set.add(1);
  const iterator = set.keys();
  iterator.next();
  return iterator.next().done ?? false;
}
