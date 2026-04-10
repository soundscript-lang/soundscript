export function main(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 1);
}
