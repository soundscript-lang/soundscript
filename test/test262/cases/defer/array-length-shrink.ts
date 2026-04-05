export function main(left: number): number {
  const values = [left, left + 1, left + 2];
  values.length = 1;
  return values.length;
}
