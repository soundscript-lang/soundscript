export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(29), Promise.resolve(30)]) total += value;
  return total;
}
