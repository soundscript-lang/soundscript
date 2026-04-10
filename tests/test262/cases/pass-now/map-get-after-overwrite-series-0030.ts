export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 30);
  map.set('value', 31);
  return map.get('value') ?? -1;
}
