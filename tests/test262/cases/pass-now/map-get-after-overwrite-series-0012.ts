export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 12);
  map.set('value', 13);
  return map.get('value') ?? -1;
}
