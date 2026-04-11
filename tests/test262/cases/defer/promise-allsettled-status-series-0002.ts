export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(2), Promise.resolve(3)]).then((results) => results.map((result) => result.status).join(';'));
}
