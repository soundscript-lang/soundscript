export function main(): number {
  const map = new Map<string, number>();
  map.set('left', 1).set('right', 2);
  return map.size;
}
