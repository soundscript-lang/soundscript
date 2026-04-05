export async function main(): Promise<number> {
  const left = await Promise.resolve(2);
  const right = await Promise.resolve(3);
  return left * right;
}
