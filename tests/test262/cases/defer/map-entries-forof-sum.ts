export function main(): number {
  let total = 0;
  for (
    const [key, value] of new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]).entries()
  ) {
    total += key.length + value;
  }
  return total;
}
