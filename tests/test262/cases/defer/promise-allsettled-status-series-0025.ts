export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(25), Promise.resolve(26)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
