export function main(left: number, right: number): number {
  const values = [0, 0, right];
  values.fill(left, 0, 2);
  return values[0] + values[1] + values[2];
}
