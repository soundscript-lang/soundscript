export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(32), Promise.resolve(33)]);
  return values[0] + values[1];
}
