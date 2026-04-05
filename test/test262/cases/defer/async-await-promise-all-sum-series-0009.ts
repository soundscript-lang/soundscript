export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(9), Promise.resolve(10)]);
  return values[0] + values[1];
}
