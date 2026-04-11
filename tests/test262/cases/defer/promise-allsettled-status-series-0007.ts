export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(7), Promise.resolve(8)]).then((results) => results.map((result) => result.status).join(';'));
}
