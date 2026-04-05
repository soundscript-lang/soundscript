export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(26), Promise.resolve(27)]);
  return values[0] + values[1];
}
