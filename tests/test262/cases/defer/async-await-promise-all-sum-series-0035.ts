export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(35), Promise.resolve(36)]);
  return values[0] + values[1];
}
