export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(8), Promise.resolve(9)]);
  return values[0] + values[1];
}
