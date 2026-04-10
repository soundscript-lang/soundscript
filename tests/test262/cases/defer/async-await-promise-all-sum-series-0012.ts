export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(12), Promise.resolve(13)]);
  return values[0] + values[1];
}
