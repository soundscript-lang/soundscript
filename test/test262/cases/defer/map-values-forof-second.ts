export function main(): number {
  const map = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
  let index = 0;
  for (const value of map.values()) {
    if (index++ === 1) {
      return value;
    }
  }
  return 0;
}
