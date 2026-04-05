export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(27), Promise.resolve(28)]) total += value;
  return total;
}
