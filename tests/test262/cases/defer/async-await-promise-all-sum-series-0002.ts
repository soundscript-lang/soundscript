export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(2), Promise.resolve(3)]);
  return values[0] + values[1];
}
