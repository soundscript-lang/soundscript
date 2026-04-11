export function main(): number {
  let total = 0;
  for (const [_key, value] of new Map([
    ['left', 1],
    ['right', 2],
  ])) {
    total += value;
  }
  return total;
}
