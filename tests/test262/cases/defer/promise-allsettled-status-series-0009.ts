export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(9), Promise.resolve(10)]).then((results) => results.map((result) => result.status).join(';'));
}
