export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(33), Promise.resolve(34)]).then((results) => results.map((result) => result.status).join(';'));
}
