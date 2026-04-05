export function main(): number {
  const map = new Map<string, number>();
  map.set('a', 1);
  map.delete('a');
  map.set('a', 2);
  return map.size;
}
