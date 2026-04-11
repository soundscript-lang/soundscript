export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(39), Promise.resolve(40)]) total += value;
  return total;
}
