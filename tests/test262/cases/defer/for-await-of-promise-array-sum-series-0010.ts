export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(10), Promise.resolve(11)]) total += value;
  return total;
}
