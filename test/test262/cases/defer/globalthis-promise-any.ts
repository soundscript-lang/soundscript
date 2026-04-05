export function main(): Promise<number> {
  return globalThis.Promise.any([Promise.resolve(4), Promise.resolve(5)]);
}
