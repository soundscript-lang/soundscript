export function main(): number {
  let total = 0;
  let index = 0;
  for (const value of [1, 2, 3]) {
    total += value * index;
    index += 1;
  }
  return total;
}
