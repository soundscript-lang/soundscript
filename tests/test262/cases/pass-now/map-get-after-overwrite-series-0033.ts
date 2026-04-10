export function main(): number {
  const map = new Map<string, number>();
  map.set('value', 33);
  map.set('value', 34);
  return map.get('value') ?? -1;
}
