export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 23);
  map.set('value', 24);
  return map.get('value') ?? -1;
}
