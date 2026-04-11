export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 6);
  map.set('value', 7);
  return map.get('value') ?? -1;
}
