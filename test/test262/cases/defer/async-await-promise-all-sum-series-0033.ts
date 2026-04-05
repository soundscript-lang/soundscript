export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(33), Promise.resolve(34)]);
  return values[0] + values[1];
}
