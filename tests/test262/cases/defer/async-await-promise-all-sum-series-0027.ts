export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(27), Promise.resolve(28)]);
  return values[0] + values[1];
}
