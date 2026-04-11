export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(16), Promise.resolve(17)]) total += value;
  return total;
}
