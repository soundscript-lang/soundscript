export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 7);
  map.set('value', 8);
  return map.get('value') ?? -1;
}
