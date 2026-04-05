export function main(): boolean {
  const iterator = [].values();
  iterator.next();
  return iterator.next().done ?? false;
}
