export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(18), Promise.resolve(19)]);
  return values[0] + values[1];
}
