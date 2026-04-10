export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 16);
  map.set('value', 17);
  return map.get('value') ?? -1;
}
