export function main(): boolean {
  const iterator = new Map<string, number>().values();
  return iterator.next().done ?? false;
}
