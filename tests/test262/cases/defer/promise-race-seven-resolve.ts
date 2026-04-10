export function main(): Promise<number> {
  return Promise.race([Promise.resolve(7)]);
}
