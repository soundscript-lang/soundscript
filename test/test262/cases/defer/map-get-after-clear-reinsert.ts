export function main(): number {
  const map = new Map<string, number>();
  map.set('left', 1);
  map.clear();
  map.set('left', 2);
  return map.get('left') ?? 0;
}
