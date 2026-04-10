export function main(): Promise<string> {
  return Promise.allSettled([Promise.resolve(23), Promise.resolve(24)]).then((results) =>
    results.map((result) => result.status).join(';')
  );
}
