export function main(): Promise<number> {
  return globalThis.Promise.race([1, Promise.resolve(2)]);
}
