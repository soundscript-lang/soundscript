export function main(): Promise<number> {
  return globalThis.Promise.allSettled([Promise.resolve(1), Promise.reject(2), Promise.resolve(3)]).then((results) => results.length);
}
