export function main(): number {
  let total = 0;
  for (const value of [1, , 3]) {
    if (value !== undefined) {
      total += value;
    }
  }
  return total;
}
