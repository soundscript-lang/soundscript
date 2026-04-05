export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 3);
  map.set('value', 4);
  return map.get('value') ?? -1;
}
