export function main(): Promise<number> {
  return Promise.allSettled([Promise.resolve(1), Promise.reject(2)]).then((results) => results.length);
}
