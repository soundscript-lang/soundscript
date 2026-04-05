export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(1), Promise.resolve(2)]);
  return values[0] + values[1];
}
