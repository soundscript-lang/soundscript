export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(19), Promise.resolve(20)]).then((results) => results.map((result) => result.status).join(';'));
}
