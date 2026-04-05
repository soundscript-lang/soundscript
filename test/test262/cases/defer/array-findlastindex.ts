export function main(values: number[], value: number): number {
  return values.findLastIndex((item) => item === value);
}
