export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(37), Promise.resolve(38)]) total += value;
  return total;
}
