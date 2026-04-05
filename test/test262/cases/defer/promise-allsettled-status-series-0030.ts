export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(30), Promise.resolve(31)]).then((results) => results.map((result) => result.status).join(';'));
}
