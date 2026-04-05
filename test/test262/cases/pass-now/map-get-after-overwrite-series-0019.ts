export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 19);
  map.set('value', 20);
  return map.get('value') ?? -1;
}
