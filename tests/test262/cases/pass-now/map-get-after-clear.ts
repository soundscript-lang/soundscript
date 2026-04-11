export function main(): number | undefined {
  const map = new Map<string, number>();
  map.set('left', 1);
  map.clear();
  return map.get('left');
}
