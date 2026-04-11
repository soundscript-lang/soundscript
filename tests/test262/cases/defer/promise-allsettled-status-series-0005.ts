export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(5), Promise.resolve(6)]).then((results) => results.map((result) => result.status).join(';'));
}
