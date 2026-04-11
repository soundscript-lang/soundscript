export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(15), Promise.resolve(16)]);
  return values[0] + values[1];
}
