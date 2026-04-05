export async function main(): Promise<number> {
  for await (const value of [Promise.resolve(1), Promise.resolve(2)]) {
    return value;
  }
  return 0;
}
