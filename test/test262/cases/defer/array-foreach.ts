export function main(left: number, right: number): number {
  let total = 0;
  [left, right, left + right].forEach((value) => {
    total += value;
  });
  return total;
}
