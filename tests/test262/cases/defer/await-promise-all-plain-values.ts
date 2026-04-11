export async function main(): Promise<number> {
  const values = await Promise.all([1, 2, 3]);
  return values[0] + values[1] + values[2];
}
