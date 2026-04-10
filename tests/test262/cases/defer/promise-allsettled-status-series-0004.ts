export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(4), Promise.resolve(5)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
