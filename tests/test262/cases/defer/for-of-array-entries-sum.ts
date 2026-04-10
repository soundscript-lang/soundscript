export function main(): number {
  let total = 0;
  for (const [index, value] of [1, 2, 3].entries()) {
    total += index + value;
  }
  return total;
}
