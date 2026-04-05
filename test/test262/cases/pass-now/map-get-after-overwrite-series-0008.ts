export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 8);
  map.set('value', 9);
  return map.get('value') ?? -1;
}
