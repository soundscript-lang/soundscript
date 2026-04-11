export function main(): number {
  return [1, 2, 3, 4].findLast((value) => value === 2) ?? -1;
}
