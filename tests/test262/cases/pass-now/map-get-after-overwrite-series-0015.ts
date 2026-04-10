export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 15);
  map.set('value', 16);
  return map.get('value') ?? -1;
}
