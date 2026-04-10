export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(6), Promise.resolve(7)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
