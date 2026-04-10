export function main(): number {
  let total = 0;
  for (const value of [1, 2, 3].values()) {
    total += value;
  }
  return total;
}
