export function main(): number | undefined {
  const values = [10, 20];
  const iterator = values.values();
  iterator.next();
  return iterator.next().value;
}
