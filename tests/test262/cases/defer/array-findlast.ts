export function main(values: number[], value: number): number | undefined {
  return values.findLast((item) => item === value);
}
