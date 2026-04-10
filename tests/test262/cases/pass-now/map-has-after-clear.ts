export function main(): boolean {
  const map = new Map<string, number>();
  map.set('left', 1);
  map.clear();
  return map.has('left');
}
