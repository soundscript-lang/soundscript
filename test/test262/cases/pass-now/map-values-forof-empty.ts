export function main(): number {
  const map = new Map<string, number>();
  let total = 0;

  for (const value of map.values()) {
    total += value;
  }

  return total;
}
