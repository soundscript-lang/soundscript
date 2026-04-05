export async function main(): Promise<number> {
  const nested = await Promise.resolve(Promise.resolve(5));
  return nested + 1;
}
