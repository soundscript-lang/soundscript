export function main(): number {
  const map = new Map<string, number>();
  let total = 0;

  for (const [key, value] of map.entries()) {
    total += key.length + value;
  }

  return total;
}
