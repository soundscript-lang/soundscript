export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(8), Promise.resolve(9)]).then((results) => results.map((result) => result.status).join(';'));
}
