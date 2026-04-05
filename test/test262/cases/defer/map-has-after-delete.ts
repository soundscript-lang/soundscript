export function main(): boolean {
  const map = new Map<number, number>([[1, 1]]);
  map.delete(1);
  return map.has(1);
}
