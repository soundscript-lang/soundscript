export function main(): number | undefined {
  const map = new Map([
    ['left', 1],
    ['right', 2],
    ['tail', 3],
  ]);
  const iterator = map.values();
  iterator.next();
  return iterator.next().value;
}
