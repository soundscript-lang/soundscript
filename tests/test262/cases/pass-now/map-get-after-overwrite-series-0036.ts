export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 36);
  map.set('value', 37);
  return map.get('value') ?? -1;
}
