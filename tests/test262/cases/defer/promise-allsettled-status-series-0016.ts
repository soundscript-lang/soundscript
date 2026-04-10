export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(16), Promise.resolve(17)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
