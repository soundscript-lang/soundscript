export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(10), Promise.resolve(11)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
