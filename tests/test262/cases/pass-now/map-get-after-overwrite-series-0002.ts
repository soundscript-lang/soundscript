export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 2);
  map.set('value', 3);
  return map.get('value') ?? -1;
}
