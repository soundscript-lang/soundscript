export function main(): number {
  const map = new Map([
    ['left', 1],
    ['left', 2],
    ['right', 3],
  ]);
  return map.size;
}
