export function main(left: number, right: number): number {
  let total = 0;
  for (const [key, value] of Object.entries({ left, right })) {
    total += key.length + value;
  }
  return total;
}
