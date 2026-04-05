export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 21);
  map.set('value', 22);
  return map.get('value') ?? -1;
}
