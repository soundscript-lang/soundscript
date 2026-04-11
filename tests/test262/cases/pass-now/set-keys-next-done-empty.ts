export function main(): boolean {
  const iterator = new Set<string>().keys();
  return iterator.next().done ?? false;
}
