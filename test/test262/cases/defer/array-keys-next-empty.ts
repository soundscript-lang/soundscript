export function main(): boolean {
  const iterator = [].keys();
  return iterator.next().done ?? false;
}
