export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 32);
  map.set('value', 33);
  return map.get('value') ?? -1;
}
