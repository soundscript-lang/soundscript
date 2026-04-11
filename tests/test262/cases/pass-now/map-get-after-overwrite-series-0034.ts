export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 34);
  map.set('value', 35);
  return map.get('value') ?? -1;
}
