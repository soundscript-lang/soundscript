export function main(): number {
  const map = new Map<string, number>([
    ['left', 1],
    ['right', 2],
  ]);
  map.clear();
  map.set('again', 3);
  return map.size;
}
