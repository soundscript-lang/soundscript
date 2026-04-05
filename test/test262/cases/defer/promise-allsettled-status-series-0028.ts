export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(28), Promise.resolve(29)]).then((results) => results.map((result) => result.status).join(';'));
}
