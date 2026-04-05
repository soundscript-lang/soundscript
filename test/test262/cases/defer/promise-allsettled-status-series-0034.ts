export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(34), Promise.resolve(35)]).then((results) => results.map((result) => result.status).join(';'));
}
