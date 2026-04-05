export function main(): boolean {
  const iterator = new Set<string>().entries();
  return iterator.next().done ?? false;
}
