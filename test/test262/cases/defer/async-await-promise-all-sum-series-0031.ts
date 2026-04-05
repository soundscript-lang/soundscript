export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(31), Promise.resolve(32)]);
  return values[0] + values[1];
}
