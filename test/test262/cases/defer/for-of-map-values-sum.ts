export function main(): number {
  let total = 0;
  for (const value of new Map([
    ['left', 1],
    ['right', 2],
  ]).values()) {
    total += value;
  }
  return total;
}
