export function main(): number {
  let total = 0;
  for (const index of [10, 20, 30, 40].keys()) {
    if (index % 2 === 0) {
      continue;
    }
    total += index;
  }
  return total;
}
