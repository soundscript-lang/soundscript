export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 31);
  map.set('value', 32);
  return map.get('value') ?? -1;
}
