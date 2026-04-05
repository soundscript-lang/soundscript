export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(20), Promise.resolve(21)]);
  return values[0] + values[1];
}
