export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(29), Promise.resolve(30)]);
  return values[0] + values[1];
}
