export async function main(): Promise<number> {
  let total = 0;
  for await (const value of [Promise.resolve(22), Promise.resolve(23)]) total += value;
  return total;
}
