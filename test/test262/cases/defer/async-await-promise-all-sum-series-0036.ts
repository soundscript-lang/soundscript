export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(36), Promise.resolve(37)]);
  return values[0] + values[1];
}
