export function main(left: number, right: number): number {
  const values = [left, right];
  const removed = values.shift();
  return (removed ?? 0) + values.length;
}
