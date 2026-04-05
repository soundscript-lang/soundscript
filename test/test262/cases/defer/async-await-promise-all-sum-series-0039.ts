export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(39), Promise.resolve(40)]);
  return values[0] + values[1];
}
