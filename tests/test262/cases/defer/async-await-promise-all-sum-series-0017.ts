export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(17), Promise.resolve(18)]);
  return values[0] + values[1];
}
