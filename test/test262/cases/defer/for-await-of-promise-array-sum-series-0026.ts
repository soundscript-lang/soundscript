export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(26), Promise.resolve(27)]) total += value;
  return total;
}
