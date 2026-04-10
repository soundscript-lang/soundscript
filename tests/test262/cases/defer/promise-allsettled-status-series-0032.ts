export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(32), Promise.resolve(33)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
