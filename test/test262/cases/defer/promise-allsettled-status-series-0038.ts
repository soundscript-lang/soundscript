export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(38), Promise.resolve(39)]).then((results) => results.map((result) => result.status).join(';'));
}
