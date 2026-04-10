export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 18);
  map.set('value', 19);
  return map.get('value') ?? -1;
}
