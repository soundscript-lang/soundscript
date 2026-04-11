export function main(): number {
  const set = new Set([1, 2, 3]);
  let index = 0;
  for (const value of set.values()) {
    if (index++ === 1) {
      return value;
    }
  }
  return 0;
}
