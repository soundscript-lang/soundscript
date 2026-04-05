export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 37);
  map.set('value', 38);
  return map.get('value') ?? -1;
}
