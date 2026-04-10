export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(5), Promise.resolve(6)]) total += value;
  return total;
}
