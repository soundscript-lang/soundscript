export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(21), Promise.resolve(22)]);
  return values[0] + values[1];
}
