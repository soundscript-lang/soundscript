export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(37), Promise.resolve(38)]).then((results) => results.map((result) => result.status).join(';'));
}
