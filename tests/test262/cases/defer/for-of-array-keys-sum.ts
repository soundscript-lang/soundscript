export function main(): number {
  let total = 0;
  for (const value of [10, 20, 30].keys()) {
    total += value;
  }
  return total;
}
