export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(24), Promise.resolve(25)]).then((results) => results.map((result) => result.status).join(';'));
}
