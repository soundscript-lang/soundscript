export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(38), Promise.resolve(39)]);
  return values[0] + values[1];
}
