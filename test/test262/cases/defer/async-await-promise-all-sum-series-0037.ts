export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(37), Promise.resolve(38)]);
  return values[0] + values[1];
}
