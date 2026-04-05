export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 11);
  map.set('value', 12);
  return map.get('value') ?? -1;
}
