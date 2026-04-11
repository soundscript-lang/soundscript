export function main(): number {
  let total = 0;
  for (const value of new Set([1, 2, 3])) {
    total += value;
    break;
  }
  return total;
}
