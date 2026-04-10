export async function main(left: number, right: number): Promise<number> {
  const first = await Promise.resolve(left);
  const second = await Promise.resolve(right);
  return first + second;
}
