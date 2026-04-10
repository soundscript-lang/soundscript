export function main(): boolean {
  const iterator = [1, 2][Symbol.iterator]();
  iterator.next();
  iterator.next();
  return iterator.next().done ?? false;
}
