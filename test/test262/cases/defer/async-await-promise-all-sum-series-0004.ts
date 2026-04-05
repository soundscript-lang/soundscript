export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(4), Promise.resolve(5)]);
  return values[0] + values[1];
}
