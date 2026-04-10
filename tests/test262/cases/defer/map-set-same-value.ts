export function main(): number {
  const map = new Map<string, number>([
    ['item', 1],
  ]);
  map.set('item', 42);
  map.set('item', 42);
  return map.get('item') ?? -1;
}
