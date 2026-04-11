export async function main(): Promise<number> {
  return Promise.resolve(1).then((value) => value + 2);
}
