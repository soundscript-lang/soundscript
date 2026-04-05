export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(7), Promise.resolve(8)]);
  return values[0] + values[1];
}
