export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(15), Promise.resolve(16)]).then((results) => results.map((result) => result.status).join(';'));
}
