export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 28);
  map.set('value', 29);
  return map.get('value') ?? -1;
}
