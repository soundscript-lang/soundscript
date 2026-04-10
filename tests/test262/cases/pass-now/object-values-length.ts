export function main(left: number, right: number): number {
  const record = { left, right, sum: left + right };
  return Object.values(record).length;
}
