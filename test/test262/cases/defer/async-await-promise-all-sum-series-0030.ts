export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(30), Promise.resolve(31)]);
  return values[0] + values[1];
}
