export function main(): number | undefined {
  const map = new Map<string, number>();
  map.set('left', 1);
  map.clear();
  map.delete('left');
  map.set('left', 2);
  return map.get('left');
}
