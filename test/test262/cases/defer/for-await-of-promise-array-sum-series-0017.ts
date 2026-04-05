export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(17), Promise.resolve(18)]) total += value;
  return total;
}
