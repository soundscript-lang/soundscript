export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 27);
  map.set('value', 28);
  return map.get('value') ?? -1;
}
