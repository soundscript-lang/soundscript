export function main(values: number[]): number {
  return values.findLastIndex((value) => value === -1);
}
