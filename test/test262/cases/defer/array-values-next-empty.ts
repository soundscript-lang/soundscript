export function main(): boolean {
  const iterator = [].values();
  return iterator.next().done ?? false;
}
