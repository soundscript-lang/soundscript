export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 1);
  map.set('value', 2);
  return map.get('value') ?? -1;
}
