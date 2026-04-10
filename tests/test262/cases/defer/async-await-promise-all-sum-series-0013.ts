export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(13), Promise.resolve(14)]);
  return values[0] + values[1];
}
