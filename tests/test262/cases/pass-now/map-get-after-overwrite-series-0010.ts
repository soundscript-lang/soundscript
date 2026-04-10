export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 10);
  map.set('value', 11);
  return map.get('value') ?? -1;
}
