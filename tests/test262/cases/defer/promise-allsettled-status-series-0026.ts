export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(26), Promise.resolve(27)]).then((results) => results.map((result) => result.status).join(';'));
}
