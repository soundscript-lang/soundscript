export function main(): number {
  let total = 0;
  for (const [, value] of new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ])) total += value;
  return total;
}
