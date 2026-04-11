export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(15), Promise.resolve(16)]) total += value;
  return total;
}
