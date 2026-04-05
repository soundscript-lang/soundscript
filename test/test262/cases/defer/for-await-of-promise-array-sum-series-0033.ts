export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(33), Promise.resolve(34)]) total += value;
  return total;
}
