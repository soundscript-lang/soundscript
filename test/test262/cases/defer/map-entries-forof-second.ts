export function main(): number {
  const map = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
  let index = 0;
  for (const [key, value] of map.entries()) {
    if (index++ === 1) {
      return key.length + value;
    }
  }
  return 0;
}
