export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(38), Promise.resolve(39)]) total += value;
  return total;
}
