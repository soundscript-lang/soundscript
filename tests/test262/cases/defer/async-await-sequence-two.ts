export async function main(): Promise<number> {
  const left = await Promise.resolve(5);
  const right = await Promise.resolve(6);
  return left + right;
}
