export function main(): number {
  const map = new Map<string, number>();
  map.set('a', 1);
  map.set('b', 2);
  return map.size;
}
