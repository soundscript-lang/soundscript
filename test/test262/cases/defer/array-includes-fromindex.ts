export function main(left: number, right: number): boolean {
  const values = [left, right, left + right];
  return values.includes(left, 1);
}
