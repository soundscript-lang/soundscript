export function main(): number {
  let total = 0;
  for (const key of new Map([
    ['a', 1],
    ['bb', 2],
  ]).keys()) {
    total += key.length;
  }
  return total;
}
