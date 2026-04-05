export function main(): number {
  let total = 0;
  for (const index of [10, 20, 30].keys()) {
    total += index;
  }
  return total;
}
