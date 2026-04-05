export function main(): number {
  const map = new Map<string, number>();
  map.set('a', 1);
  map.clear();
  return map.size;
}
