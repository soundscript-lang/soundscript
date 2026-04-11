export function main(): number {
  const map = new Map<string, number>();
  map.set('a', 1);
  map.clear();
  map.set('b', 2);
  return map.size;
}
