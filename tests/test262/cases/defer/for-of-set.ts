export function main(): number {
  let count = 0;
  for (const _value of new Set([1, 2, 3])) {
    count += 1;
  }
  return count;
}
