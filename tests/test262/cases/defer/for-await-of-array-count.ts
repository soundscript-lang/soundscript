export async function main(): Promise<number> {
  let count = 0;
  for await (const _ of [1, 2, 3]) count += 1;
  return count;
}
