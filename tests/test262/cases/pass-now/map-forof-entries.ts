export function main(): number {
  const map = new Map([
    ['left', 1],
    ['right', 2],
  ]);
  let total = 0;
  for (const [key, value] of map) {
    total += key.length + value;
  }
  return total;
}
