export function main(): number {
  const set = new Set([1, 2, 3]);
  let index = 0;
  for (const [left, right] of set.entries()) {
    if (index++ === 1) {
      return left + right;
    }
  }
  return 0;
}
