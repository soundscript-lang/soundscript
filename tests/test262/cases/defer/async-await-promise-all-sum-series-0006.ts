export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(6), Promise.resolve(7)]);
  return values[0] + values[1];
}
