export function main(values: number[]): number {
  let sum = 0;
  for (const value of values) {
    sum = sum + value;
  }
  return sum;
}
