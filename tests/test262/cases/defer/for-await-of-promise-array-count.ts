export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(1), Promise.resolve(2), 3]) {
    total += value;
  }
  return total;
}
