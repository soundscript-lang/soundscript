export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(22), Promise.resolve(23)]);
  return values[0] + values[1];
}
