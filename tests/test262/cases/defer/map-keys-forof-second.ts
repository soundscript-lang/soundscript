export function main(): number {
  const map = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
  let index = 0;
  for (const key of map.keys()) {
    if (index++ === 1) {
      return key.length;
    }
  }
  return 0;
}
