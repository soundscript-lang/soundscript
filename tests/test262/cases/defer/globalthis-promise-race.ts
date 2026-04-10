export function main(): Promise<number> {
  return globalThis.Promise.race([Promise.resolve(1), Promise.resolve(2)]);
}
