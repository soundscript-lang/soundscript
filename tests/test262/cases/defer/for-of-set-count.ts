export function main(): number {
  const values = new Set([1, 2, 3]);
  let count = 0;
  for (const _value of values) {
    count += 1;
  }
  return count;
}
