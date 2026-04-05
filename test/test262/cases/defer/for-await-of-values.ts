export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [1, 2, 3]) {
    total += value;
  }
  return total;
}
