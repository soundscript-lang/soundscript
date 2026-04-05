export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(16), Promise.resolve(17)]);
  return values[0] + values[1];
}
