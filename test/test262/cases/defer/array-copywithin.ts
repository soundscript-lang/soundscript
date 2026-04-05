export function main(left: number, right: number): number {
  const values = [left, right, left + right];
  values.copyWithin(1, 0, 1);
  return values[1];
}
