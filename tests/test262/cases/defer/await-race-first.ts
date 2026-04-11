export async function main(): Promise<number> {
  const value = await Promise.race([Promise.resolve(4), Promise.resolve(5)]);
  return value;
}
