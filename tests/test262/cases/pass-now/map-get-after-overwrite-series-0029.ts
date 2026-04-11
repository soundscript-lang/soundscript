export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 29);
  map.set('value', 30);
  return map.get('value') ?? -1;
}
