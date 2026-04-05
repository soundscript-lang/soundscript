export function main(): boolean {
  const iterator = new Map<string, number>().entries();
  return iterator.next().done ?? false;
}
