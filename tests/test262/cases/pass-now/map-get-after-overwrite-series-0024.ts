export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 24);
  map.set('value', 25);
  return map.get('value') ?? -1;
}
