export function main(): Promise<number> {
  return Promise.race([Promise.resolve(4), Promise.resolve(5)]);
}
