export function main(): number {
  let count = 0;
  for (const _value of [1, 2, 3].entries()) {
    count += 1;
  }
  return count;
}
