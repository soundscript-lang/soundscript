export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(10), Promise.resolve(11)]);
  return values[0] + values[1];
}
