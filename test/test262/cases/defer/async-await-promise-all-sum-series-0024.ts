export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(24), Promise.resolve(25)]);
  return values[0] + values[1];
}
