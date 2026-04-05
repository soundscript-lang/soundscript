export function main(): Promise<number> {
  return Promise.race([Promise.resolve(1), Promise.resolve(2)]);
}
