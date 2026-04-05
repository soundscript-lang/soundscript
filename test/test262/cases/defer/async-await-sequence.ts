export async function main(): Promise<number> {
  const left = await Promise.resolve(11);
  const right = await Promise.resolve(12);
  return left + right;
}
