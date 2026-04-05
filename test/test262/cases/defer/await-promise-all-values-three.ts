export async function main(): Promise<number> {
  const values = await Promise.all([1, Promise.resolve(2), 3]);
  return values[1];
}
