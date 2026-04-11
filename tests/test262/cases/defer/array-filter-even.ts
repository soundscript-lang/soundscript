export function main(values: number[]): number {
  return values.filter((value) => value % 2 === 0).length;
}
