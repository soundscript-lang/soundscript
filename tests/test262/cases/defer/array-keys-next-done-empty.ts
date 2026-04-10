export function main(): boolean {
  const iterator = [].keys();
  iterator.next();
  return iterator.next().done ?? false;
}
