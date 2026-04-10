export function main(): number {
  const map = new Map<string, number>();
  map.set('answer', 1);
  map.set('answer', 2);
  return map.get('answer') ?? 0;
}
