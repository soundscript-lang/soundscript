export function main(): boolean {
  const values = [10];
  const iterator = values.keys();
  iterator.next();
  return iterator.next().done ?? false;
}
