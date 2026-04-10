export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(28), Promise.resolve(29)]) total += value;
  return total;
}
