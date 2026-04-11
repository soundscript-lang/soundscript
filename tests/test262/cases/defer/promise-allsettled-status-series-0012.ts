export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(12), Promise.resolve(13)]).then((results) => results.map((result) => result.status).join(';'));
}
