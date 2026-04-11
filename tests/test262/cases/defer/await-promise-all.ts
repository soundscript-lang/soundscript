export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(3), Promise.resolve(4)]);
  return values[0] + values[1];
}
