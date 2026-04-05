export function main(): number {
  let total = 0;
  for (const value of new Set([1, 2, 3, 4])) {
    if (value % 2 === 0) {
      continue;
    }
    total += value;
  }
  return total;
}
