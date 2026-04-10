export function main(): boolean {
  const iterator = new Set<string>().values();
  return iterator.next().done ?? false;
}
