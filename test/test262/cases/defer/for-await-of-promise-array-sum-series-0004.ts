export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(4), Promise.resolve(5)]) total += value;
  return total;
}
