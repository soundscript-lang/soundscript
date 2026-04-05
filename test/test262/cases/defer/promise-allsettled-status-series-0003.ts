export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(3), Promise.resolve(4)]).then((results) => results.map((result) => result.status).join(';'));
}
