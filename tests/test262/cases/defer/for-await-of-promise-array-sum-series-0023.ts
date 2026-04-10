export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(23), Promise.resolve(24)]) total += value;
  return total;
}
