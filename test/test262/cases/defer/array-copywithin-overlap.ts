export function main(left: number, right: number): number {
  const values = [left, right, left + right];
  values.copyWithin(1, 0, 2);
  return values[0] * 100 + values[1] * 10 + values[2];
}
