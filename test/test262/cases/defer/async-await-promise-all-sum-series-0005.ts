export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(5), Promise.resolve(6)]);
  return values[0] + values[1];
}
