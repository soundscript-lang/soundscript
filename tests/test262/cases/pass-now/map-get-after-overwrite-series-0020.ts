export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 20);
  map.set('value', 21);
  return map.get('value') ?? -1;
}
