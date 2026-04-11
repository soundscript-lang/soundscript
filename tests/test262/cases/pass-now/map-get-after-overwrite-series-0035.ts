export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 35);
  map.set('value', 36);
  return map.get('value') ?? -1;
}
