export function main(): string {
  const map = new Map<string, number>();
  map.set('a', 1);
  map.set('b', 2);
  map.set('a', 3);

  let order = '';
  for (const [key] of map) {
    order += key;
  }

  return order;
}
