export function main(): Promise<number> {
  return globalThis.Promise.any([Promise.reject(1), 2]);
}
