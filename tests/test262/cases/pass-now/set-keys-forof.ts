export function main(): number {
  let total = 0;
  for (const value of new Set([2, 3]).keys()) {
    total += value;
  }
  return total;
}
