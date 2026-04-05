export function main(): string {
  const set = new Set<string>();
  set.add('a');
  set.clear();
  set.add('b');
  return [...set.values()].join(';');
}
