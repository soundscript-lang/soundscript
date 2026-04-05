export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(13), Promise.resolve(14)]).then((results) => results.map((result) => result.status).join(';'));
}
