export function main(): number {
  const map = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
  map.delete('b');
  return map.get('c') ?? 0;
}
