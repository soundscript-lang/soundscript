export function main(): number {
  const map = new Map<number, number>();
  map.set(1, 1);
  map.delete(1);
  return map.size;
}
