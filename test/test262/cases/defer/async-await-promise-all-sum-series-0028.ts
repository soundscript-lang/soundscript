export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(28), Promise.resolve(29)]);
  return values[0] + values[1];
}
