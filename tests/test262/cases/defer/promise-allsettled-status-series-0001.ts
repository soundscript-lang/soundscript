export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(1), Promise.resolve(2)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
