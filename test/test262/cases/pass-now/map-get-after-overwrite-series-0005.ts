export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 5);
  map.set('value', 6);
  return map.get('value') ?? -1;
}
