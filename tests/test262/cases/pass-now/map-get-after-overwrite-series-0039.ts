export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 39);
  map.set('value', 40);
  return map.get('value') ?? -1;
}
