export function main(): number {
  const values = new Set<number>([1, 2, 3]);
  let total = 0;
  values.forEach((value) => {
    total += value;
  });
  return total;
}
