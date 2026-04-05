export function main(): number {
  let total = 0;
  for (const value of new Map([
    ['left', 1],
    ['right', 2],
    ['third', 3],
  ]).values()) {
    if (value === 2) {
      continue;
    }
    total += value;
  }
  return total;
}
