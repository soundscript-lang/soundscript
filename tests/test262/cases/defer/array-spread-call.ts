function sum(left: number, right: number): number {
  return left + right;
}

export function main(left: number, right: number): number {
  const values = [left, right];
  return sum(...values);
}
