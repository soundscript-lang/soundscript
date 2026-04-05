export function main(): number {
  const map = new Map<number, number>();
  map.set(1, 1);
  map.set(2, 2);
  map.clear();
  return map.size;
}
