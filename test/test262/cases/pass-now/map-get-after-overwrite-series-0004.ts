export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 4);
  map.set('value', 5);
  return map.get('value') ?? -1;
}
