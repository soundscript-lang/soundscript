export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 17);
  map.set('value', 18);
  return map.get('value') ?? -1;
}
