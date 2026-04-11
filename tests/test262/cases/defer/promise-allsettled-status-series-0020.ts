export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(20), Promise.resolve(21)]).then((results) => results.map((result) => result.status).join(';'));
}
