export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(23), Promise.resolve(24)]);
  return values[0] + values[1];
}
