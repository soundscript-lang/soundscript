export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 26);
  map.set('value', 27);
  return map.get('value') ?? -1;
}
