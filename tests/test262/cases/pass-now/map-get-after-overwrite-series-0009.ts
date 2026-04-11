export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 9);
  map.set('value', 10);
  return map.get('value') ?? -1;
}
