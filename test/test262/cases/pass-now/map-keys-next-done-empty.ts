export function main(): boolean {
  const iterator = new Map<string, number>().keys();
  return iterator.next().done ?? false;
}
