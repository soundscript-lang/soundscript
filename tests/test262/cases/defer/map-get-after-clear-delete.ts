export function main(): number {
  const map = new Map<string, number>([
    ['a', 1],
    ['b', 2],
  ]);
  map.delete('a');
  return map.delete('a') ? 1 : 0;
}
