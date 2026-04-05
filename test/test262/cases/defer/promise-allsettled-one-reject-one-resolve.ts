export function main(): Promise<string> {
  return Promise.allSettled([Promise.reject(1), Promise.resolve(2)]).then((results) => results[0].status);
}
