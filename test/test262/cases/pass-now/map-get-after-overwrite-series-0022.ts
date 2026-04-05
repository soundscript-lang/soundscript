export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 22);
  map.set('value', 23);
  return map.get('value') ?? -1;
}
