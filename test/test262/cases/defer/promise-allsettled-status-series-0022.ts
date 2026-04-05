export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(22), Promise.resolve(23)]).then((results) => results.map((result) => result.status).join(';'));
}
