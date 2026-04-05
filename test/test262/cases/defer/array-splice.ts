export function main(left: number, right: number): number {
  const values = [left, right];
  const removed = values.splice(0, 1);
  return removed.length + values.length;
}
