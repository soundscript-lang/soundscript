export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(29), Promise.resolve(30)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
