export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(18), Promise.resolve(19)]) total += value;
  return total;
}
