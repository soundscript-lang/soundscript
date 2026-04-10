export function main(left: number, right: number): number[] {
  const values = [left, right, left + right];
  values.sort((a, b) => b - a);
  return values;
}
