export async function main(): Promise<number> {
  const one = await Promise.resolve(1);
  const two = await Promise.resolve(2);
  return one + two;
}
