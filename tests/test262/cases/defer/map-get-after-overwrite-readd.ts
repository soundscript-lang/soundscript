export function main(): number {
  const map = new Map<string, number>();
  map.set('a', 1);
  map.set('a', 2);
  map.delete('a');
  map.set('a', 3);
  return map.get('a') ?? 0;
}
