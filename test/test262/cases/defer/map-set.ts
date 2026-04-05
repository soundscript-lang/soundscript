export function main(): boolean {
  const map = new Map<string, number>([['item', 0]]);
  return map.set('item', 42) === map;
}
