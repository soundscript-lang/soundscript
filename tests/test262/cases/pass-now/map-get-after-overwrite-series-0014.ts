export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 14);
  map.set('value', 15);
  return map.get('value') ?? -1;
}
