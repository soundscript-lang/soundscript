export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(25), Promise.resolve(26)]);
  return values[0] + values[1];
}
