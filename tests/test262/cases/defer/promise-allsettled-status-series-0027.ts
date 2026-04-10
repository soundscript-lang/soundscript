export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(27), Promise.resolve(28)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
