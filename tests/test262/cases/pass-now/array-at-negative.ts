export function main(left: number, right: number): number | undefined {
  const values = [left, right, left + right];
  return values.at(-1);
}
