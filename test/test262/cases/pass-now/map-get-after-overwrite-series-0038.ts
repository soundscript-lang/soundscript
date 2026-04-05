export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 38);
  map.set('value', 39);
  return map.get('value') ?? -1;
}
