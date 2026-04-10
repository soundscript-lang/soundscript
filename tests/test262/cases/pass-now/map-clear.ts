export function main(): number {
  const map = new Map<string, number>();
  map.set('left', 1);
  map.set('right', 2);
  map.clear();
  return map.size;
}
