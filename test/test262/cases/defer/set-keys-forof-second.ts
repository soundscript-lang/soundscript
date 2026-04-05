export function main(): number {
  const set = new Set([1, 2, 3]);
  let index = 0;
  for (const key of set.keys()) {
    if (index++ === 1) {
      return key;
    }
  }
  return 0;
}
