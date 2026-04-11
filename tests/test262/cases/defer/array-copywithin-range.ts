export function main(left: number, right: number): number {
  const values = [left, right, left + right, left - right];
  values.copyWithin(1, 2, 4);
  return values[0] * 1000 + values[1] * 100 + values[2] * 10 + values[3];
}
