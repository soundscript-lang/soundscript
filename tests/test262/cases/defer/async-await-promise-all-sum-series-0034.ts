export async function main(): Promise<number> {
  const values = await Promise.all([Promise.resolve(34), Promise.resolve(35)]);
  return values[0] + values[1];
}
