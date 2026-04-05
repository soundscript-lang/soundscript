export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 25);
  map.set('value', 26);
  return map.get('value') ?? -1;
}
