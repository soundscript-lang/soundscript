export function main(values: number[]): number {
  let total = 0;
  values.forEach((value, index) => {
    total += value + index;
  });
  return total;
}
