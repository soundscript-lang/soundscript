export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(17), Promise.resolve(18)]).then((results) => results.map((result) => result.status).join(';'));
}
