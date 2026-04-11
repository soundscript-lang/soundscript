export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 13);
  map.set('value', 14);
  return map.get('value') ?? -1;
}
