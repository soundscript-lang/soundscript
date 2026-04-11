export function main(left: number, right: number): number {
  return Array.from({ 0: left, 1: right, length: 2 }).length;
}
